-- Polls in posts and comments, @mentions, and two privacy settings.
--
--   * polls: one per post or comment (feed posts, post comments, Fakemon
--     comments, wall posts). Readable by whoever can read what it's attached
--     to (that table's own policy decides). Votes are private; the totals live
--     on the poll, kept current by a trigger.
--   * mentions: "@username" in a post or comment notifies that person, unless
--     they've blocked you (or you them), or turned mentions off (profiles.
--     privacy.mentions: 'following' = only people they follow, 'nobody').
--   * profiles.privacy.discover = 'hidden': left out of people search, the
--     mention picker and suggestions, unless someone types their exact username.

-- ==================== polls ====================

create table if not exists public.polls (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    post_id uuid unique references public.community_posts(id) on delete cascade,
    post_comment_id uuid unique references public.post_comments(id) on delete cascade,
    mon_comment_id uuid unique references public.mon_comments(id) on delete cascade,
    profile_comment_id uuid unique references public.profile_comments(id) on delete cascade,
    question text not null default '' check (char_length(question) <= 200),
    options jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 6),
    multi boolean not null default false,
    closes_at timestamptz,
    -- votes per option, in order, and how many people voted (poll_votes_tally)
    counts jsonb not null default '[]'::jsonb,
    voters integer not null default 0,
    created_at timestamptz not null default now(),
    check (num_nonnulls(post_id, post_comment_id, mon_comment_id, profile_comment_id) = 1)
);
create index if not exists polls_user_idx on public.polls(user_id);

create table if not exists public.poll_votes (
    poll_id uuid not null references public.polls(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    choices smallint[] not null,
    created_at timestamptz not null default now(),
    primary key (poll_id, user_id)
);
create index if not exists poll_votes_user_idx on public.poll_votes(user_id);

alter table public.polls enable row level security;
alter table public.poll_votes enable row level security;

drop policy if exists polls_read on public.polls;
drop policy if exists polls_insert on public.polls;
drop policy if exists polls_delete on public.polls;
-- the parent's own read policy applies inside these subqueries
create policy polls_read on public.polls for select to authenticated using (
    (post_id is not null and exists (select 1 from public.community_posts p where p.id = post_id))
    or (post_comment_id is not null and exists (select 1 from public.post_comments c where c.id = post_comment_id))
    or (mon_comment_id is not null and exists (select 1 from public.mon_comments c where c.id = mon_comment_id))
    or (profile_comment_id is not null and exists (select 1 from public.profile_comments c where c.id = profile_comment_id)));
-- only on something you wrote
create policy polls_insert on public.polls for insert to authenticated with check (
    user_id = (select auth.uid()) and (
        exists (select 1 from public.community_posts p where p.id = post_id and p.user_id = (select auth.uid()))
        or exists (select 1 from public.post_comments c where c.id = post_comment_id and c.user_id = (select auth.uid()))
        or exists (select 1 from public.mon_comments c where c.id = mon_comment_id and c.user_id = (select auth.uid()))
        or exists (select 1 from public.profile_comments c where c.id = profile_comment_id and c.user_id = (select auth.uid()))));
create policy polls_delete on public.polls for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists poll_votes_read on public.poll_votes;
drop policy if exists poll_votes_insert on public.poll_votes;
drop policy if exists poll_votes_update on public.poll_votes;
drop policy if exists poll_votes_delete on public.poll_votes;
create policy poll_votes_read on public.poll_votes for select to authenticated using (user_id = (select auth.uid()));
create policy poll_votes_insert on public.poll_votes for insert to authenticated
    with check (user_id = (select auth.uid()) and exists (select 1 from public.polls p where p.id = poll_id));
create policy poll_votes_update on public.poll_votes for update to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy poll_votes_delete on public.poll_votes for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.polls, public.poll_votes from anon, authenticated;
grant select, insert, delete on public.polls to authenticated;
grant select, insert, update, delete on public.poll_votes to authenticated;

create or replace function public.polls_guard()
 returns trigger language plpgsql set search_path to 'public'
as $$
declare
    o jsonb;
    seen text[] := '{}';
begin
    new.question := btrim(new.question);
    for o in select * from jsonb_array_elements(new.options) loop
        if jsonb_typeof(o) <> 'string' or char_length(btrim(o #>> '{}')) not between 1 and 80 or lower(btrim(o #>> '{}')) = any(seen) then
            raise exception 'Each poll option needs 1 to 80 characters, and no two can be the same.';
        end if;
        seen := seen || lower(btrim(o #>> '{}'));
    end loop;
    if new.closes_at is not null and (new.closes_at < now() + interval '5 minutes' or new.closes_at > now() + interval '31 days') then
        raise exception 'A poll runs for 5 minutes to 31 days.';
    end if;
    new.counts := (select jsonb_agg(0) from jsonb_array_elements(new.options));
    new.voters := 0;
    new.created_at := now();
    return new;
end;
$$;
drop trigger if exists polls_guard on public.polls;
create trigger polls_guard before insert on public.polls for each row execute function public.polls_guard();

create or replace function public.poll_votes_guard()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare
    p public.polls;
    n integer;
begin
    select * into p from public.polls where id = new.poll_id;
    if not found then raise exception 'That poll no longer exists.'; end if;
    if p.closes_at is not null and now() > p.closes_at then raise exception 'This poll has closed.'; end if;
    n := jsonb_array_length(p.options);
    new.choices := array(select distinct c from unnest(new.choices) c order by c);
    if cardinality(new.choices) = 0 or exists (select 1 from unnest(new.choices) c where c < 0 or c >= n)
       or (not p.multi and cardinality(new.choices) > 1) then
        raise exception 'That isn''t a valid choice.';
    end if;
    if tg_op = 'UPDATE' then new.poll_id := old.poll_id; new.user_id := old.user_id; end if;
    new.created_at := now();
    return new;
end;
$$;
drop trigger if exists poll_votes_guard on public.poll_votes;
create trigger poll_votes_guard before insert or update on public.poll_votes for each row execute function public.poll_votes_guard();

create or replace function public.poll_votes_tally()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare
    pid uuid := coalesce(new.poll_id, old.poll_id);
begin
    update public.polls p set
        counts = (select coalesce(jsonb_agg((select count(*) from public.poll_votes v where v.poll_id = pid and (i - 1)::smallint = any(v.choices)) order by i), '[]'::jsonb)
                    from generate_series(1, jsonb_array_length(p.options)) i),
        voters = (select count(*) from public.poll_votes v where v.poll_id = pid)
     where p.id = pid;
    return null;
end;
$$;
drop trigger if exists poll_votes_tally on public.poll_votes;
create trigger poll_votes_tally after insert or update or delete on public.poll_votes for each row execute function public.poll_votes_tally();

revoke execute on function public.polls_guard(), public.poll_votes_guard(), public.poll_votes_tally() from public, anon, authenticated;

-- ==================== mentions ====================

create or replace function public.notify_mentions()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare
    names text[];
    actor public.profiles;
    tgt text;
    what text;
begin
    names := array(select distinct lower(m[1])
                     from regexp_matches(coalesce(new.body, ''), '(?:^|[^A-Za-z0-9_@/])@([A-Za-z0-9_]{3,20})', 'g') m limit 10);
    if cardinality(names) = 0 then return null; end if;
    case tg_table_name
        when 'community_posts' then tgt := 'post:' || new.id; what := 'a post';
        when 'post_comments' then tgt := 'post:' || new.post_id; what := 'a comment';
        when 'mon_comments' then tgt := 'mon:' || new.mon_id; what := 'a comment';
        else tgt := 'profile:' || new.profile_id; what := 'a wall post';
    end case;
    select * into actor from public.profiles where id = new.user_id;
    insert into public.notifications(user_id, actor_id, actor_name, actor_avatar_url, type, target_id, target_name, preview)
    select p.id, new.user_id, coalesce(nullif(actor.display_name, ''), actor.username, 'Someone'), nullif(actor.avatar_url, ''),
           'mention', tgt, what, left(new.body, 140)
      from public.profiles p
     where lower(p.username) = any(names)
       and p.id <> new.user_id
       and coalesce(p.privacy->>'mentions', 'everyone') <> 'nobody'
       and (coalesce(p.privacy->>'mentions', 'everyone') <> 'following'
            or exists (select 1 from public.follows f where f.follower_id = p.id and f.followee_id = new.user_id))
       and not exists (select 1 from public.user_blocks b
                        where (b.blocker_id = p.id and b.blocked_id = new.user_id) or (b.blocker_id = new.user_id and b.blocked_id = p.id));
    return null;
end;
$$;
revoke execute on function public.notify_mentions() from public, anon, authenticated;

drop trigger if exists notify_mentions on public.community_posts;
drop trigger if exists notify_mentions on public.post_comments;
drop trigger if exists notify_mentions on public.mon_comments;
drop trigger if exists notify_mentions on public.profile_comments;
create trigger notify_mentions after insert on public.community_posts for each row execute function public.notify_mentions();
create trigger notify_mentions after insert on public.post_comments for each row execute function public.notify_mentions();
create trigger notify_mentions after insert on public.mon_comments for each row execute function public.notify_mentions();
create trigger notify_mentions after insert on public.profile_comments for each row execute function public.notify_mentions();

-- ==================== finding people ====================

-- p_for: 'search' (the search box, team pickers) or 'mention' (the @ picker,
-- which also leaves out people who can't be mentioned by you)
create or replace function public.search_profiles(p_query text, p_limit integer default 8, p_for text default 'search')
 returns table(id uuid, username text, display_name text, avatar_url text)
 language sql stable security definer set search_path to 'public'
as $$
    with q as (select ltrim(btrim(coalesce(p_query, '')), '@') as raw),
         pat as (select raw, '%' || replace(replace(replace(raw, '\', '\\'), '%', '\%'), '_', '\_') || '%' as like_any from q)
    select p.id, p.username, p.display_name, p.avatar_url
      from public.profiles p, pat
     where auth.uid() is not null
       and char_length(pat.raw) >= 1
       and p.username is not null
       and (p.username ilike pat.like_any or p.display_name ilike pat.like_any)
       and (p.banned_until is null or p.banned_until < now())
       and (coalesce(p.privacy->>'discover', '') <> 'hidden' or lower(p.username) = lower(pat.raw) or p.id = auth.uid())
       and (p_for <> 'mention' or (
            p.id <> auth.uid()
            and coalesce(p.privacy->>'mentions', 'everyone') <> 'nobody'
            and (coalesce(p.privacy->>'mentions', 'everyone') <> 'following'
                 or exists (select 1 from public.follows f where f.follower_id = p.id and f.followee_id = auth.uid()))))
       and not exists (select 1 from public.user_blocks b
                        where (b.blocker_id = p.id and b.blocked_id = auth.uid()) or (b.blocker_id = auth.uid() and b.blocked_id = p.id))
     order by (lower(p.username) = lower(pat.raw)) desc, (p.username ilike pat.raw || '%') desc, p.username
     limit least(greatest(coalesce(p_limit, 8), 1), 20);
$$;
revoke execute on function public.search_profiles(text, integer, text) from public, anon;
grant execute on function public.search_profiles(text, integer, text) to authenticated;

-- which of these people are hidden from suggestions (for the feed's "Creators to follow")
create or replace function public.undiscoverable(p_ids uuid[])
 returns setof uuid language sql stable security definer set search_path to 'public'
as $$
    select p.id from public.profiles p
     where auth.uid() is not null and p.id = any(p_ids) and coalesce(p.privacy->>'discover', '') = 'hidden';
$$;
revoke execute on function public.undiscoverable(uuid[]) from public, anon;
grant execute on function public.undiscoverable(uuid[]) to authenticated;
