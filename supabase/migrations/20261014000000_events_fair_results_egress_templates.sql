-- Events, round three.
--
-- Fair results (nobody can rig them, the organizer and site staff included):
--   * Placements can't be set by hand on an event that votes; the standings
--     are the votes. (Events without voting still pick winners by placement,
--     until the event ends.)
--   * Once voting has started, how entries are scored and who wins is frozen:
--     the voting kind, criteria, winner rules, votes per person, self-voting
--     and the tie rule.
--   * Once the results are out, the event can't be moved back to reopen voting.
--   * Judges can't be added (or made organizers) once a judges' vote has started.
-- Ties: tie_rule says what happens when entries score the same: share the
--   place, or settle it by one criterion, by the number of votes, or by who
--   entered first. The ranking itself is computed by the page (ranked() in
--   js/features/events.ts) from get_event_results.
-- Voter feedback: the team compiles what voters wrote about an entry and sends
--   it to its creator (send_event_feedback); the entrant reads it with their entry.
-- Egress: entries are big (artwork as data URIs, whole Fakemon), and every
--   event page used to download all of them in full. Now:
--   * event_entries.thumb / events.cover_thumb: small pictures for galleries,
--     tickets and the feed;
--   * event_entries_light(): every entry with its pictures left out, for lists;
--     event_entry_full(): one entry in full, when it's opened;
--   * both are metered in egress_usage (per day, per kind) and stop at
--     egress_budgets' daily cap, with a per-person hourly limit. Staff see the
--     numbers and set the caps in the staff panel (Limits).
--   Direct reads of event_entries.answers are closed by the follow-up
--   migration 20261014000100, once the site that uses these has deployed.
-- Templates: saved to your account (event_templates), not just one device.

-- ==================== columns ====================

alter table public.events add column if not exists cover_thumb text
    check (cover_thumb is null or (char_length(cover_thumb) <= 80000 and cover_thumb ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$'));
alter table public.events add column if not exists tie_rule text not null default 'share'
    check (tie_rule in ('share', 'criterion', 'votes', 'earliest'));
alter table public.events add column if not exists tie_criterion text check (char_length(tie_criterion) <= 40);

alter table public.event_entries add column if not exists thumb text
    check (thumb is null or (char_length(thumb) <= 80000 and thumb ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$'));
grant select (thumb) on public.event_entries to anon, authenticated;

alter table public.event_entry_private add column if not exists feedback text check (char_length(feedback) <= 8000);
alter table public.event_entry_private add column if not exists feedback_at timestamptz;

-- ==================== fair results ====================

create or replace function public.events_guard()
 returns trigger language plpgsql set search_path to 'public'
as $$
declare
    f jsonb;
    names text[] := '{}';
    k text;
begin
    if tg_op = 'UPDATE' then
        new.owner_id := old.owner_id;
        new.created_at := old.created_at;
    end if;
    new.updated_at := now();
    new.slug := nullif(lower(btrim(new.slug)), '');
    perform public.event_form_check(new.form, array['short', 'long', 'url', 'email', 'discord', 'choice', 'dropdown',
        'checkboxes', 'number', 'date', 'scale', 'image', 'fakemon', 'library', 'agree', 'section'], 'entry form');
    -- voters answer about someone else's entry: no uploads, nothing personal
    perform public.event_form_check(new.vote_form, array['short', 'long', 'choice', 'dropdown', 'checkboxes', 'number', 'scale', 'section'], 'voter questions');
    if jsonb_typeof(new.vote_display) <> 'object'
       or jsonb_typeof(coalesce(new.vote_display->'author', 'true'::jsonb)) <> 'boolean'
       or jsonb_typeof(coalesce(new.vote_display->'fields', 'null'::jsonb)) not in ('null', 'array') then
        raise exception 'Invalid voting form display settings.';
    end if;
    if jsonb_typeof(new.criteria) <> 'array' or jsonb_array_length(new.criteria) not between 1 and 8 then
        raise exception 'The voting form needs 1 to 8 criteria.';
    end if;
    for f in select * from jsonb_array_elements(new.criteria) loop
        if jsonb_typeof(f) <> 'object'
           or char_length(coalesce(f->>'name', '')) not between 1 and 40
           or (f->>'name') = any(names)
           or char_length(coalesce(f->>'help', '')) > 200
           or jsonb_typeof(f->'max') <> 'number' or (f->>'max')::numeric not in (2, 3, 4, 5, 6, 7, 8, 9, 10) then
            raise exception 'One of the voting criteria is not valid: %', coalesce(f->>'name', '(untitled)');
        end if;
        names := names || (f->>'name');
    end loop;
    if jsonb_typeof(new.winner_criteria) <> 'object' then raise exception 'Invalid winner rules.'; end if;
    for k in select jsonb_object_keys(new.winner_criteria) loop
        if k not in ('top_n', 'top_percent', 'min_score_percent')
           or jsonb_typeof(new.winner_criteria->k) <> 'number'
           or (new.winner_criteria->>k)::numeric not between 1 and (case when k = 'top_n' then 1000 else 100 end) then
            raise exception 'Invalid winner rules.';
        end if;
    end loop;
    if new.tie_rule = 'criterion' and not (new.tie_criterion = any(names)) then
        raise exception 'Pick which voting criterion settles ties.';
    end if;
    if new.tie_rule <> 'criterion' then new.tie_criterion := null; end if;
    if new.submissions_open_at >= new.submissions_close_at then raise exception 'Entries must open before they close.'; end if;
    if new.voting_open_at >= new.voting_close_at then raise exception 'Voting must open before it closes.'; end if;
    if new.results_at < coalesce(new.voting_close_at, new.submissions_close_at) then
        raise exception 'Results can''t come out before % closes.', case when new.voting_close_at is null then 'entry' else 'voting' end;
    end if;

    -- nobody rigs the outcome, the organizer included: once voting has started
    -- the scoring is frozen, and once the results are out the event stays ended
    if tg_op = 'UPDATE' and current_user <> 'postgres' then
        if old.voting <> 'none' and public.event_phase(old) in ('voting', 'tallying', 'ended') and (
               new.voting is distinct from old.voting or new.criteria is distinct from old.criteria
            or new.winner_criteria is distinct from old.winner_criteria or new.votes_per_user is distinct from old.votes_per_user
            or new.allow_self_vote is distinct from old.allow_self_vote or new.tie_rule is distinct from old.tie_rule
            or new.tie_criterion is distinct from old.tie_criterion) then
            raise exception 'Voting has started, so how entries are scored and who wins can''t change any more.';
        end if;
        if public.event_phase(old) = 'ended' and public.event_phase(new) <> 'ended' then
            raise exception 'The results are out, so this event can''t be reopened.';
        end if;
    end if;
    return new;
end;
$$;

-- placements: only on events that don't vote, and only until they end
create or replace function public.event_entries_guard()
 returns trigger language plpgsql set search_path to 'public'
as $$
declare
    ev public.events;
begin
    new.id := old.id;
    new.event_id := old.event_id;
    new.user_id := old.user_id;
    if current_user <> 'postgres' then
        new.answers := old.answers;
        new.thumb := old.thumb;
    end if;
    new.created_at := old.created_at;
    if new.placement is distinct from old.placement and current_user <> 'postgres' then
        select * into ev from public.events where id = old.event_id;
        if ev.voting <> 'none' then
            raise exception 'This event''s standings come from the votes, so nobody can set placements by hand.';
        end if;
        if public.event_phase(ev) = 'ended' then
            raise exception 'The results are out, so placements can''t change.';
        end if;
    end if;
    return new;
end;
$$;

create or replace function public.event_helpers_guard()
 returns trigger language plpgsql set search_path to 'public'
as $$
declare
    ev public.events;
begin
    select * into ev from public.events where id = new.event_id;
    if ev.owner_id = new.user_id then
        raise exception 'The organizer already has every permission.';
    end if;
    if tg_op = 'UPDATE' then
        new.event_id := old.event_id;
        new.user_id := old.user_id;
        new.added_by := old.added_by;
        new.created_at := old.created_at;
    else
        new.added_by := auth.uid();
        -- someone who may only add people hands out no more than they hold
        if auth.uid() is not null and not public.event_can(new.event_id, 'team') then
            if new.is_organizer
               or (new.can_edit and not public.event_can(new.event_id, 'edit'))
               or (new.can_entries and not public.event_can(new.event_id, 'entries'))
               or (new.can_judge and not public.event_can(new.event_id, 'judge'))
               or (new.can_results and not public.event_can(new.event_id, 'results')) then
                raise exception 'You can only give people permissions you have yourself.';
            end if;
        end if;
    end if;
    -- a judges' vote under way: no new judges (an organizer can judge too)
    if current_user <> 'postgres' and ev.voting = 'judges' and public.event_phase(ev) in ('voting', 'tallying', 'ended')
       and ((new.can_judge or new.is_organizer)
            and (tg_op = 'INSERT' or not (old.can_judge or old.is_organizer))) then
        raise exception 'Judging has started, so no one new can become a judge.';
    end if;
    return new;
end;
$$;

-- ==================== thumbnails ====================

-- the entry's picture, small (made by the page: answers._thumb), for galleries
create or replace function public.event_store_entry(ev events, p_user uuid, p_answers jsonb, p_entry uuid default null)
 returns uuid language plpgsql set search_path to 'public'
as $$
declare
    clean jsonb;
    f jsonb;
    pub jsonb := '{}'::jsonb;
    priv jsonb := '{}'::jsonb;
    new_id uuid;
    th text := p_answers->>'_thumb';
begin
    if pg_column_size(p_answers) > 6000000 then raise exception 'That entry is too large. Use smaller images.'; end if;
    if th is not null and (char_length(th) > 80000 or th !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$') then th := null; end if;
    clean := public.event_clean_answers(ev.form, p_answers);
    for f in select * from jsonb_array_elements(ev.form) loop
        continue when not clean ? (f->>'id');
        -- same rule as isPrivateField in js/features/events.ts
        if f->>'type' = 'email' or coalesce((f->>'private')::boolean, f->>'type' = 'discord') then
            priv := priv || jsonb_build_object(f->>'id', clean->(f->>'id'));
        else
            pub := pub || jsonb_build_object(f->>'id', clean->(f->>'id'));
        end if;
    end loop;
    if p_entry is not null then
        update public.event_entries set answers = pub, thumb = th where id = p_entry;
        update public.event_entry_private set answers = priv where entry_id = p_entry;
        return p_entry;
    end if;
    insert into public.event_entries(event_id, user_id, answers, thumb) values (ev.id, p_user, pub, th) returning id into new_id;
    insert into public.event_entry_private(entry_id, event_id, user_id, answers) values (new_id, ev.id, p_user, priv);
    if p_user is not null then
        insert into public.event_follows(event_id, user_id) values (ev.id, p_user) on conflict do nothing;
    end if;
    return new_id;
end;
$$;

-- an event in the feed: its small cover, not the full one
create or replace function public.repost_embed(p_kind text, p_id uuid)
 returns jsonb language sql stable security definer set search_path to 'public'
as $$
    select case p_kind
        when 'mon' then (
            select jsonb_build_object(
                'kind', 'mon', 'id', m.id, 'user_id', m.user_id, 'created_at', m.published_at,
                'author_name', m.author_name, 'author_avatar_url', m.author_avatar_url, 'author_badges', m.author_badges,
                'name', m.fakemon_data->>'name', 'species', m.fakemon_data->>'species', 'number', m.fakemon_data->>'number',
                'type1', m.fakemon_data->>'type1', 'type2', m.fakemon_data->>'type2',
                'customTypes', coalesce(m.fakemon_data->'customTypes', '[]'::jsonb),
                'caption', left(coalesce(m.fakemon_data->>'dexEntry1', ''), 280),
                'like_count', (select count(*) from public.mon_reactions r where r.mon_id = m.id),
                'liked_by_me', exists (select 1 from public.mon_reactions r where r.mon_id = m.id and r.emoji = 'heart' and r.user_id = auth.uid()),
                'reactions', coalesce((select jsonb_object_agg(emoji, n) from (
                        select emoji, count(*) n from public.mon_reactions r where r.mon_id = m.id group by emoji) x), '{}'::jsonb),
                'my_reactions', coalesce((select jsonb_agg(emoji) from public.mon_reactions r where r.mon_id = m.id and r.user_id = auth.uid()), '[]'::jsonb),
                'comment_count', (select count(*) from public.mon_comments c where c.mon_id = m.id),
                'repost_count', (select count(*) from public.community_posts rp where rp.repost_kind = 'mon' and rp.repost_id = m.id),
                'reposted_by_me', exists (select 1 from public.community_posts rp where rp.repost_kind = 'mon' and rp.repost_id = m.id
                                            and rp.user_id = auth.uid() and rp.body = '' and rp.mon_ids = '{}'))
            from public.published_mons m where m.id = p_id)
        when 'post' then (
            select jsonb_build_object(
                'kind', 'post', 'id', p.id, 'user_id', p.user_id, 'created_at', p.created_at,
                'body', left(p.body, 600), 'truncated', char_length(p.body) > 600, 'mon_ids', p.mon_ids,
                'mons', coalesce((select jsonb_agg(jsonb_build_object(
                            'id', pm.id, 'name', pm.fakemon_data->>'name', 'type1', pm.fakemon_data->>'type1', 'type2', pm.fakemon_data->>'type2')
                            order by array_position(p.mon_ids, pm.id))
                          from public.published_mons pm where pm.id = any(p.mon_ids)), '[]'::jsonb),
                'tags', p.tags, 'edited_at', p.edited_at,
                'reactions', coalesce((select jsonb_object_agg(emoji, n) from (
                        select emoji, count(*) n from public.post_reactions r where r.post_id = p.id group by emoji) x), '{}'::jsonb),
                'my_reactions', coalesce((select jsonb_agg(emoji) from public.post_reactions r where r.post_id = p.id and r.user_id = auth.uid()), '[]'::jsonb),
                'comment_count', (select count(*) from public.post_comments c where c.post_id = p.id),
                'repost_count', (select count(*) from public.community_posts rp where rp.repost_kind = 'post' and rp.repost_id = p.id),
                'reposted_by_me', exists (select 1 from public.community_posts rp where rp.repost_kind = 'post' and rp.repost_id = p.id
                                            and rp.user_id = auth.uid() and rp.body = '' and rp.mon_ids = '{}'))
            from public.community_posts p where p.id = p_id)
        when 'event' then (
            select jsonb_build_object(
                'kind', 'event', 'id', e.id, 'slug', e.slug, 'user_id', e.owner_id, 'created_at', e.created_at,
                'title', e.title, 'tagline', e.tagline, 'category', e.category, 'cover_image', e.cover_thumb,
                'stage', public.event_phase(e), 'submissions_close_at', e.submissions_close_at, 'voting_close_at', e.voting_close_at,
                'entry_count', case when public.event_entries_visible(e.id) or public.event_can(e.id, 'view')
                                    then (select count(*) from public.event_entries en where en.event_id = e.id) end,
                'repost_count', (select count(*) from public.community_posts rp where rp.repost_kind = 'event' and rp.repost_id = e.id),
                'reposted_by_me', exists (select 1 from public.community_posts rp where rp.repost_kind = 'event' and rp.repost_id = e.id
                                            and rp.user_id = auth.uid() and rp.body = '' and rp.mon_ids = '{}'))
            from public.events e where e.id = p_id and e.phase <> 'draft')
    end;
$$;

-- ==================== egress: metered entry reads ====================

create table if not exists public.egress_budgets (
    kind text primary key,
    daily_bytes bigint not null check (daily_bytes > 0),
    hourly_calls_per_person integer not null check (hourly_calls_per_person > 0),
    note text not null default ''
);
insert into public.egress_budgets(kind, daily_bytes, hourly_calls_per_person, note) values
    ('event_entries_list', 2000000000, 300, 'Every entry of an event, pictures left out (lists, responses, voting).'),
    ('event_entry', 3000000000, 900, 'One entry in full, when someone opens it.')
on conflict (kind) do nothing;

create table if not exists public.egress_usage (
    day date not null default current_date,
    kind text not null,
    calls bigint not null default 0,
    bytes bigint not null default 0,
    refused bigint not null default 0,
    primary key (day, kind)
);
alter table public.egress_budgets enable row level security;
alter table public.egress_usage enable row level security;
revoke all on public.egress_budgets, public.egress_usage from anon, authenticated;

-- counts a read against today's budget, or refuses it
create or replace function public.egress_take(p_kind text, p_bytes bigint)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare
    b public.egress_budgets;
    used bigint;
begin
    select * into b from public.egress_budgets where kind = p_kind;
    if not found then return; end if;
    select coalesce(bytes, 0) into used from public.egress_usage where day = current_date and kind = p_kind;
    -- signed-out visitors (public events) share no per-person bucket; the daily cap covers them
    if coalesce(used, 0) + p_bytes > b.daily_bytes
       or (auth.uid() is not null and not public.rate_limit_hit('egress:' || p_kind || ':' || auth.uid(), b.hourly_calls_per_person, interval '1 hour')) then
        insert into public.egress_usage(day, kind, refused) values (current_date, p_kind, 1)
            on conflict (day, kind) do update set refused = public.egress_usage.refused + 1;
        raise exception 'Event pages are getting a lot of traffic right now, so this was paused to keep the site up. Try again in a little while.';
    end if;
    insert into public.egress_usage(day, kind, calls, bytes) values (current_date, p_kind, 1, p_bytes)
        on conflict (day, kind) do update set calls = public.egress_usage.calls + 1, bytes = public.egress_usage.bytes + excluded.bytes;
end;
$$;
revoke execute on function public.egress_take(text, bigint) from public, anon, authenticated;

-- who may read an entry: the same rule as event_entries' read policy
create or replace function public.event_entry_readable(p_event uuid, p_user uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $$
    select (auth.uid() is not null and p_user = auth.uid())
        or public.event_entries_visible(p_event)
        or public.event_can(p_event, 'entries') or public.event_can(p_event, 'judge') or public.event_can(p_event, 'results');
$$;
revoke execute on function public.event_entry_readable(uuid, uuid) from public, anon, authenticated;

-- an answer without its pictures: a data URI becomes "[image]", a Fakemon or
-- move keeps what lists and summaries show
create or replace function public.event_light_answer(v jsonb)
 returns jsonb language sql immutable set search_path to 'public'
as $$
    select case jsonb_typeof(v)
        when 'string' then case when v #>> '{}' like 'data:%' then '"[image]"'::jsonb else v end
        when 'object' then jsonb_strip_nulls(jsonb_build_object(
            'name', v->'name', 'species', v->'species', 'type1', v->'type1', 'type2', v->'type2', 'kind', v->'kind',
            'type', v->'type', 'category', v->'category', 'stats', v->'stats', 'abilities', v->'abilities',
            'dexEntry1', v->'dexEntry1', 'desc', v->'desc'))
        else v end;
$$;

-- every entry of an event you may read, pictures left out (thumb is the small picture)
create or replace function public.event_entries_light(p_event uuid)
 returns jsonb language plpgsql volatile security definer set search_path to 'public'
as $$
declare
    out jsonb;
begin
    select coalesce(jsonb_agg(jsonb_build_object(
               'id', en.id, 'event_id', en.event_id, 'placement', en.placement, 'created_at', en.created_at, 'thumb', en.thumb,
               'answers', (select coalesce(jsonb_object_agg(x.k, public.event_light_answer(x.v)), '{}'::jsonb) from jsonb_each(en.answers) x(k, v)))
             order by en.created_at), '[]'::jsonb)
      into out
      from public.event_entries en
     where en.event_id = p_event and public.event_entry_readable(p_event, en.user_id);
    perform public.egress_take('event_entries_list', pg_column_size(out));
    return out;
end;
$$;
revoke execute on function public.event_entries_light(uuid) from public;
grant execute on function public.event_entries_light(uuid) to anon, authenticated;

-- one entry in full, when it's opened
create or replace function public.event_entry_full(p_entry uuid)
 returns jsonb language plpgsql volatile security definer set search_path to 'public'
as $$
declare
    en public.event_entries;
    out jsonb;
begin
    select * into en from public.event_entries where id = p_entry;
    if not found or not public.event_entry_readable(en.event_id, en.user_id) then return null; end if;
    out := jsonb_build_object('id', en.id, 'answers', en.answers);
    perform public.egress_take('event_entry', pg_column_size(out));
    return out;
end;
$$;
revoke execute on function public.event_entry_full(uuid) from public;
grant execute on function public.event_entry_full(uuid) to anon, authenticated;

-- the staff panel: what was read, and the caps
create or replace function public.admin_egress_usage(p_days integer default 14)
 returns table(day date, kind text, calls bigint, bytes bigint, refused bigint)
 language sql stable security definer set search_path to 'public'
as $$
    select u.day, u.kind, u.calls, u.bytes, u.refused from public.egress_usage u
     where public.has_perm(auth.uid(), 'manage_limits') and u.day > current_date - greatest(1, least(coalesce(p_days, 14), 90))
     order by u.day desc, u.kind;
$$;
create or replace function public.admin_egress_budgets()
 returns setof public.egress_budgets language sql stable security definer set search_path to 'public'
as $$
    select * from public.egress_budgets where public.has_perm(auth.uid(), 'manage_limits') order by kind;
$$;
create or replace function public.admin_set_egress_budget(p_kind text, p_daily_bytes bigint, p_hourly_calls integer)
 returns void language plpgsql security definer set search_path to 'public'
as $$
begin
    if not public.has_perm(auth.uid(), 'manage_limits') then raise exception 'You do not have the manage limits permission.'; end if;
    update public.egress_budgets set daily_bytes = p_daily_bytes, hourly_calls_per_person = p_hourly_calls where kind = p_kind;
    if not found then raise exception 'No such budget.'; end if;
    perform public.mod_log(null, 'egress_budget', p_kind, jsonb_build_object('daily_bytes', p_daily_bytes, 'hourly_calls', p_hourly_calls));
end;
$$;
revoke execute on function public.admin_egress_usage(integer), public.admin_egress_budgets(), public.admin_set_egress_budget(text, bigint, integer) from public, anon;
grant execute on function public.admin_egress_usage(integer), public.admin_egress_budgets(), public.admin_set_egress_budget(text, bigint, integer) to authenticated;

-- ==================== voter feedback, sent to the creator ====================

create or replace function public.send_event_feedback(p_entry uuid, p_text text)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare
    uid uuid := auth.uid();
    en public.event_entries;
    ev public.events;
    me public.profiles;
    body text := btrim(coalesce(p_text, ''));
begin
    if uid is null then raise exception 'Sign in first.'; end if;
    select * into en from public.event_entries where id = p_entry;
    if not found then raise exception 'That entry no longer exists.'; end if;
    if not public.event_can(en.event_id, 'entries') then raise exception 'You do not have permission to manage entries.'; end if;
    if en.user_id is null then raise exception 'A guest''s entry has no account to send feedback to.'; end if;
    if body = '' then raise exception 'Write the feedback first.'; end if;
    if char_length(body) > 8000 then raise exception 'Feedback can be up to 8000 characters.'; end if;
    if not public.rate_limit_hit('event-feedback:' || uid, 200, interval '1 hour') then
        raise exception 'Too many at once. Try again in a while.';
    end if;
    select * into ev from public.events where id = en.event_id;
    update public.event_entry_private set feedback = body, feedback_at = now() where entry_id = p_entry;
    select * into me from public.profiles where id = uid;
    insert into public.notifications(user_id, actor_id, actor_name, actor_avatar_url, type, target_id, target_name, preview)
    values (en.user_id, uid, coalesce(nullif(me.display_name, ''), me.username, 'An organizer'), nullif(me.avatar_url, ''),
            'event_feedback', 'event:' || coalesce(ev.slug, ev.id::text), left(ev.title, 120), left(body, 140));
end;
$$;
revoke execute on function public.send_event_feedback(uuid, text) from public, anon;
grant execute on function public.send_event_feedback(uuid, text) to authenticated;

create or replace function public.guard_notification_insert()
 returns trigger language plpgsql set search_path to 'public'
as $$
declare
    staff_types constant text[] := array[
        'mod_warning','mod_muted','mod_banned','mod_comment_deleted',
        'mon_deleted','contest_submission_deleted','event_entry_removed',
        'mention','event_announcement','event_edit_request','event_feedback'];
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
    new.actor_avatar_url := (select nullif(avatar_url, '') from public.profiles where id = auth.uid());
    new.preview := left(new.preview, 300);
    new.target_name := left(new.target_name, 120);
    if auth.uid() is not null and public.is_blocked_between(auth.uid(), new.user_id) then
        return null;
    end if;
    return new;
end;
$$;

create or replace function public.respect_notification_prefs()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    p jsonb;
begin
    if new.type like 'mod\_%' or new.type in ('mon_deleted', 'contest_submission_deleted', 'event_entry_removed', 'event_edit_request', 'event_feedback') then
        return new;
    end if;
    select prefs into p from public.notification_prefs where user_id = new.user_id;
    if p is null then return new; end if;
    if (p->>'all') = 'false' or (p->>new.type) = 'false' then
        return null;
    end if;
    return new;
end $$;
revoke execute on function public.respect_notification_prefs() from public, anon, authenticated;

-- ==================== templates on your account ====================

create table if not exists public.event_templates (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    name text not null check (char_length(btrim(name)) between 1 and 60),
    "values" jsonb not null check (jsonb_typeof("values") = 'object' and pg_column_size("values") <= 1500000),
    updated_at timestamptz not null default now(),
    unique (owner_id, name)
);
alter table public.event_templates enable row level security;
drop policy if exists event_templates_own on public.event_templates;
create policy event_templates_own on public.event_templates for all to authenticated
    using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
revoke all on public.event_templates from anon, authenticated;
grant select, insert, update, delete on public.event_templates to authenticated;

create or replace function public.event_templates_guard()
 returns trigger language plpgsql set search_path to 'public'
as $$
begin
    new.owner_id := coalesce(old.owner_id, auth.uid());
    new.updated_at := now();
    if tg_op = 'INSERT' and (select count(*) from public.event_templates t where t.owner_id = new.owner_id) >= 50 then
        raise exception 'You can keep up to 50 templates. Delete one to save another.';
    end if;
    return new;
end;
$$;
drop trigger if exists event_templates_guard on public.event_templates;
create trigger event_templates_guard before insert or update on public.event_templates
    for each row execute function public.event_templates_guard();
revoke execute on function public.event_templates_guard() from public, anon, authenticated;
