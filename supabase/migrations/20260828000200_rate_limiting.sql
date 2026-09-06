-- ==================== one atomic rate limiter ====================
-- Replaces login_attempts, which was not atomic (count-then-insert races),
-- counted successes (locking out a whole NAT after correct logins), never
-- swept most of its rows, and only limited per full IP (useless against an
-- IPv6 /64 or multi-IP credential stuffing). This is a counter keyed by
-- whatever the caller wants to limit, one row per key; the upsert takes a row
-- lock so concurrent hits serialise instead of racing.
create table if not exists public.rate_limits (
    key          text primary key,
    window_start timestamptz not null default now(),
    hits         integer     not null default 0
);

alter table public.rate_limits enable row level security;
-- No policies or grants: touched only via the SECURITY DEFINER functions below and service_role.
revoke all on public.rate_limits from anon, authenticated;

-- Returns true if allowed, false if over limit. Counting and deciding happen
-- in one statement so there's no gap to race.
create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window interval)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
    n integer;
begin
    insert into public.rate_limits as r (key, window_start, hits)
    values (p_key, now(), 1)
    on conflict (key) do update
       set hits = case when r.window_start > now() - p_window then r.hits + 1 else 1 end,
           window_start = case when r.window_start > now() - p_window then r.window_start else now() end
    returning r.hits into n;

    -- opportunistic sweep, rare and cheap enough for the hot path
    if random() < 0.001 then
        delete from public.rate_limits where window_start < now() - interval '1 day';
    end if;

    return n <= p_limit;
end;
$fn$;

-- Cleared on successful sign-in so a legitimate user never spends someone else's budget.
create or replace function public.rate_limit_clear(p_key text)
returns void
language sql
security definer
set search_path = public
as $fn$
    delete from public.rate_limits where key = p_key;
$fn$;

revoke all on function public.rate_limit_hit(text, integer, interval) from public, anon, authenticated;
revoke all on function public.rate_limit_clear(text)                  from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, interval) to service_role;
grant execute on function public.rate_limit_clear(text)                  to service_role;

-- ==================== content flood limit ====================
-- Added to the existing enforce_content_policy trigger (runs on mon_comments,
-- profile_comments, published_mons, contest_submissions) rather than as a new
-- trigger, so every current and future content table gets it automatically.
-- Previously a signed-in account could insert content in a loop with no limit.
create or replace function public.enforce_content_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
    row_json jsonb := to_jsonb(new);
    body_text text;
    hit record;
    author uuid := (row_json->>'user_id')::uuid;
begin
    if public.is_banned(author) then
        raise exception 'Your account is suspended.' using errcode = 'P0001';
    end if;
    if public.is_muted(author) then
        raise exception 'You are muted and cannot post right now.' using errcode = 'P0001';
    end if;

    -- keyed per user per table so a comment burst doesn't consume the publishing budget
    if author is not null and not public.rate_limit_hit(
            'content:' || tg_table_name || ':' || author::text, 10, interval '1 minute') then
        raise exception 'You are posting too quickly. Please wait a moment and try again.'
            using errcode = 'P0001';
    end if;

    if tg_table_name in ('published_mons', 'contest_submissions') then
        body_text := public.mon_text_for_scan(row_json->'fakemon_data');
    else
        body_text := row_json->>'body';
    end if;

    select * into hit from public.scan_text(body_text)
        where action = 'block' limit 1;
    if found then
        raise exception 'Blocked by the content filter: %', hit.label using errcode = 'P0001';
    end if;
    return new;
end;
$fn$;

-- ==================== notification flood limit ====================
-- notifications' INSERT policy checks identity but not volume, so any
-- signed-in account could push unlimited notifications at another account.
--
-- guard_notification_insert must stay SECURITY INVOKER: it gates on
-- `current_user = 'postgres'` to let staff tooling (automod_escalate(), a
-- SECURITY DEFINER function owned by postgres) write mod_* notification types.
-- Making this trigger SECURITY DEFINER would make that check true for every
-- caller, silently disabling the staff-type guard.
--
-- rate_limits isn't granted to authenticated, so the elevated access the rate
-- check needs lives in this SECURITY DEFINER helper instead. It derives the
-- actor from auth.uid() rather than taking it as an argument, so a caller can
-- only spend their own budget.
create or replace function public.notify_rate_ok(p_recipient uuid)
returns boolean
language sql
security definer
set search_path = public
as $fn$
    -- overall ceiling plus a tighter per-recipient one, so one person can't be
    -- singled out by an actor still under their overall budget
    select public.rate_limit_hit('notify:' || auth.uid()::text, 30, interval '1 minute')
       and public.rate_limit_hit('notify:' || auth.uid()::text || ':' || p_recipient::text,
                                 10, interval '1 hour');
$fn$;

revoke all on function public.notify_rate_ok(uuid) from public, anon;
grant execute on function public.notify_rate_ok(uuid) to authenticated, service_role;

create or replace function public.guard_notification_insert()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
    staff_types constant text[] := array[
        'mod_warning','mod_muted','mod_banned','mod_comment_deleted',
        'mon_deleted','contest_submission_deleted'];
begin
    if current_user = 'postgres' then return new; end if;

    if new.type = any(staff_types) then
        raise exception 'That notification type can only be sent by staff tools';
    end if;

    if auth.uid() is not null and not public.notify_rate_ok(new.user_id) then
        raise exception 'You are sending notifications too quickly. Please slow down.';
    end if;

    select coalesce(nullif(display_name, ''), username, 'Someone')
      into new.actor_name from public.profiles where id = auth.uid();
    return new;
end;
$fn$;

-- ==================== cleanup ====================
-- profiles had two identical BEFORE UPDATE triggers on the same function,
-- running the check twice per update for nothing.
drop trigger if exists trg_username_rate_limit on public.profiles;
