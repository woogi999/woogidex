-- Events, round two.
--
-- Privacy (what "private" promises, enforced here rather than by the page):
--   * entries_private: the entries are the team's. The public sees them only
--     while it is the one voting (community vote, full ballot); never during a
--     judges' vote, never after, and not even how many there are.
--   * Who sent an entry is no longer readable from event_entries directly:
--     during blind voting (vote_display.author off) anyone could look up the
--     entrant's user_id. event_entry_authors() hands authors out only where the
--     event shows them (or to the team, or the entrant themselves).
--   * Results and entry counts follow the same visibility.
--   * Turning a question private after entries came in used to leave the old
--     answers public. They now move between the public and private tables
--     whenever the form changes.
-- Team:
--   * can_add: may add people, with no more than they hold themselves.
--   * is_organizer: everything the owner can do except deleting the event.
-- Running it:
--   * hold_results: the results stay "coming soon" until the team publishes
--     its results post (publish_event_results), whatever the dates say.
--   * Edit requests: the team asks an entrant to change their entry, with a
--     reason; they can then edit it even after entries close.
--   * Announcements, which the event's followers get as notifications (and by
--     email, if they ask: supabase/functions/send-event-announcement). Entering
--     an event follows it.
--   * A private link the team can pull into Google Sheets (=IMPORTDATA), served
--     as CSV by worker/index.js from event_sheet_data().

-- ==================== columns ====================

alter table public.events add column if not exists entries_private boolean not null default false;
alter table public.events add column if not exists hold_results boolean not null default false;
alter table public.events add column if not exists results_released_at timestamptz;

alter table public.event_helpers add column if not exists can_add boolean not null default false;
alter table public.event_helpers add column if not exists is_organizer boolean not null default false;

-- the request lives with the private answers: the entrant and the Entries team read it
alter table public.event_entry_private add column if not exists edit_request text check (char_length(edit_request) <= 500);
alter table public.event_entry_private add column if not exists edit_requested_at timestamptz;

-- ==================== where an event is ====================

-- as before, except that with hold_results it waits on the results post
create or replace function public.event_phase(e events)
 returns text language sql stable set search_path to 'public'
as $$
    select case when s.base = 'ended' and e.hold_results and e.results_released_at is null then 'tallying' else s.base end
    from (select case
        when e.phase in ('draft', 'ended') then e.phase
        when e.phase = 'announced' and (e.submissions_open_at is null or now() < e.submissions_open_at) then 'upcoming'
        when e.voting <> 'none' and e.voting_close_at is not null and now() > e.voting_close_at then
            case when e.results_at is not null and now() < e.results_at then 'tallying' else 'ended' end
        when e.voting <> 'none' and (e.phase = 'voting' or (e.voting_open_at is not null and now() >= e.voting_open_at)) then
            case when e.voting_open_at is not null and now() < e.voting_open_at then 'closed' else 'voting' end
        when e.submissions_open_at is not null and now() < e.submissions_open_at then 'upcoming'
        when e.phase = 'voting' then 'closed'
        when e.submissions_close_at is not null and now() > e.submissions_close_at then
            case when e.voting <> 'none' then (case when e.voting_open_at is null then 'voting' else 'closed' end)
                 when e.results_at is not null and now() >= e.results_at then 'ended'
                 else 'closed' end
        else 'open'
    end as base) s;
$$;

-- ==================== who may do what ====================

-- 'owner' (deleting the event) stays the owner's alone; 'team' (managing the
-- team) is the owner and organizers; organizers hold every other permission
create or replace function public.event_can(p_event uuid, p_perm text)
 returns boolean language sql stable security definer set search_path to 'public'
as $$
    select auth.uid() is not null and (
        exists (select 1 from public.events e where e.id = p_event and e.owner_id = auth.uid())
        or public.has_perm(auth.uid(), 'manage_events')
        or (p_perm <> 'owner' and exists (
            select 1 from public.event_helpers h
            where h.event_id = p_event and h.user_id = auth.uid()
              and case p_perm
                    when 'view'    then true
                    when 'team'    then h.is_organizer
                    when 'add'     then h.can_add or h.is_organizer
                    when 'edit'    then h.can_edit or h.is_organizer
                    when 'entries' then h.can_entries or h.is_organizer
                    when 'judge'   then h.can_judge or h.is_organizer
                    when 'results' then h.can_results or h.is_organizer
                    else false
                  end)));
$$;

create or replace function public.event_helpers_guard()
 returns trigger language plpgsql set search_path to 'public'
as $$
begin
    if exists (select 1 from public.events e where e.id = new.event_id and e.owner_id = new.user_id) then
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
    return new;
end;
$$;

drop policy if exists event_helpers_insert on public.event_helpers;
drop policy if exists event_helpers_update on public.event_helpers;
drop policy if exists event_helpers_delete on public.event_helpers;
create policy event_helpers_insert on public.event_helpers for insert to authenticated
    with check ((select public.event_can(event_id, 'add')));
create policy event_helpers_update on public.event_helpers for update to authenticated
    using ((select public.event_can(event_id, 'team'))) with check ((select public.event_can(event_id, 'team')));
-- the team's managers, yourself (leaving), or whoever added you
create policy event_helpers_delete on public.event_helpers for delete to authenticated
    using ((select public.event_can(event_id, 'team')) or user_id = (select auth.uid())
           or (added_by = (select auth.uid()) and (select public.event_can(event_id, 'add'))));

-- ==================== which entries the public sees ====================

create or replace function public.event_entries_visible(p_event uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $$
    select exists (select 1 from public.events e where e.id = p_event and public.event_readable(e) and (
        case when e.entries_private
             -- private: only to the public that votes on them, while it votes
             then e.voting in ('community', 'ballot') and public.event_phase(e) = 'voting'
             else e.show_entries or public.event_phase(e) in ('closed', 'voting', 'tallying', 'ended') end));
$$;

-- who sent an entry, only through event_entry_authors()
revoke select on public.event_entries from anon, authenticated;
grant select (id, event_id, answers, placement, created_at) on public.event_entries to anon, authenticated;

create or replace function public.event_entry_authors(p_event uuid)
 returns table(entry_id uuid, user_id uuid) language sql stable security definer set search_path to 'public'
as $$
    select en.id, en.user_id
    from public.event_entries en join public.events e on e.id = en.event_id
    where en.event_id = p_event and en.user_id is not null and auth.uid() is not null and (
        en.user_id = auth.uid()
        -- the team that runs it; a judge alone doesn't, so blind judging stays blind
        or public.event_can(p_event, 'entries') or public.event_can(p_event, 'edit') or public.event_can(p_event, 'results')
        or (public.event_entries_visible(p_event)
            and (coalesce((e.vote_display->>'author')::boolean, true) or public.event_phase(e) = 'ended')));
$$;
revoke execute on function public.event_entry_authors(uuid) from public, anon;
grant execute on function public.event_entry_authors(uuid) to authenticated;

-- tallies: as before, and only where the entries themselves are visible
create or replace function public.get_event_results(p_event uuid)
 returns table(entry_id uuid, votes bigint, score_total bigint, score_avg numeric, criteria_avg jsonb, total_voters bigint, points_percent numeric)
 language plpgsql stable security definer set search_path to 'public'
as $$
declare
    ev public.events;
    voters bigint;
    per_voter integer;
begin
    select * into ev from public.events where id = p_event;
    if not found or not (public.event_can(p_event, 'results')
        or (public.event_readable(ev) and public.event_entries_visible(p_event)
            and (public.event_phase(ev) = 'ended' or (public.event_phase(ev) = 'voting' and ev.live_results)))) then
        raise exception 'Results are not public yet.';
    end if;
    voters := case when ev.voting = 'ballot'
        then (select count(*) from public.event_ballots b where b.event_id = p_event)
        else (select count(distinct v.voter_id) from public.event_votes v where v.event_id = p_event) end;
    per_voter := case when ev.voting = 'community' then 1
        else (select coalesce(sum((c->>'max')::integer), 0) from jsonb_array_elements(ev.criteria) c) end;
    return query
        select en.id, count(v.voter_id), coalesce(sum(v.score), 0)::bigint, round(coalesce(avg(v.score), 0), 2),
               coalesce((select jsonb_object_agg(c->>'name', (select round(avg((v2.scores->>(c->>'name'))::numeric), 2)
                                                    from public.event_votes v2 where v2.entry_id = en.id and v2.scores ? (c->>'name')))
                         from jsonb_array_elements(ev.criteria) c), '{}'::jsonb),
               voters,
               case when voters * per_voter > 0 then round(coalesce(sum(v.score), 0) * 100.0 / (voters * per_voter), 2) else 0 end
        from public.event_entries en
        left join public.event_votes v on v.entry_id = en.id
        where en.event_id = p_event
        group by en.id;
end;
$$;

-- an event in the feed: its entry count only where the entries are visible
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
                'title', e.title, 'tagline', e.tagline, 'category', e.category, 'cover_image', e.cover_image,
                'stage', public.event_phase(e), 'submissions_close_at', e.submissions_close_at, 'voting_close_at', e.voting_close_at,
                'entry_count', case when public.event_entries_visible(e.id) or public.event_can(e.id, 'view')
                                    then (select count(*) from public.event_entries en where en.event_id = e.id) end,
                'repost_count', (select count(*) from public.community_posts rp where rp.repost_kind = 'event' and rp.repost_id = e.id),
                'reposted_by_me', exists (select 1 from public.community_posts rp where rp.repost_kind = 'event' and rp.repost_id = e.id
                                            and rp.user_id = auth.uid() and rp.body = '' and rp.mon_ids = '{}'))
            from public.events e where e.id = p_id and e.phase <> 'draft')
    end;
$$;

-- ==================== private answers stay private ====================

-- whenever the form changes, answers move to match their question's privacy
-- (same rule as isPrivateField in js/features/events.ts). Answers to questions
-- that were deleted stay where they are, so nothing is lost.
create or replace function public.event_resplit_answers()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare
    priv_ids text[];
    pub_ids text[];
begin
    if new.form is not distinct from old.form then return null; end if;
    select coalesce(array_agg(f->>'id') filter (where f->>'type' = 'email' or coalesce((f->>'private')::boolean, f->>'type' = 'discord')), '{}'),
           coalesce(array_agg(f->>'id') filter (where not (f->>'type' = 'email' or coalesce((f->>'private')::boolean, f->>'type' = 'discord'))), '{}')
      into priv_ids, pub_ids
      from jsonb_array_elements(new.form) f where f->>'type' <> 'section';

    -- now private: copy into the private row, then drop from the public one
    -- (only where a private row exists, so nothing is dropped without a copy)
    if cardinality(priv_ids) > 0 then
        update public.event_entry_private p
           set answers = p.answers || (select coalesce(jsonb_object_agg(x.k, x.v), '{}'::jsonb) from jsonb_each(en.answers) x(k, v) where x.k = any(priv_ids))
          from public.event_entries en
         where en.id = p.entry_id and en.event_id = new.id and en.answers ?| priv_ids;
        update public.event_entries en set answers = en.answers - priv_ids
         where en.event_id = new.id and en.answers ?| priv_ids
           and exists (select 1 from public.event_entry_private p where p.entry_id = en.id);
    end if;
    -- now public: the other way
    if cardinality(pub_ids) > 0 then
        update public.event_entries en
           set answers = en.answers || (select coalesce(jsonb_object_agg(x.k, x.v), '{}'::jsonb) from jsonb_each(p.answers) x(k, v) where x.k = any(pub_ids))
          from public.event_entry_private p
         where p.entry_id = en.id and en.event_id = new.id and p.answers ?| pub_ids;
        update public.event_entry_private p set answers = p.answers - pub_ids
         where p.event_id = new.id and p.answers ?| pub_ids;
    end if;
    return null;
end;
$$;
drop trigger if exists event_resplit_answers on public.events;
create trigger event_resplit_answers after update of form on public.events
    for each row execute function public.event_resplit_answers();
revoke execute on function public.event_resplit_answers() from public, anon, authenticated;

-- ==================== following an event ====================

create table if not exists public.event_follows (
    event_id uuid not null references public.events(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (event_id, user_id)
);
create index if not exists event_follows_user_idx on public.event_follows(user_id);
alter table public.event_follows enable row level security;
drop policy if exists event_follows_read on public.event_follows;
drop policy if exists event_follows_insert on public.event_follows;
drop policy if exists event_follows_delete on public.event_follows;
create policy event_follows_read on public.event_follows for select to authenticated
    using (user_id = (select auth.uid()) or (select public.event_can(event_id, 'view')));
-- events' own policy decides which events you can follow
create policy event_follows_insert on public.event_follows for insert to authenticated
    with check (user_id = (select auth.uid()) and exists (select 1 from public.events e where e.id = event_id and e.phase <> 'draft'));
create policy event_follows_delete on public.event_follows for delete to authenticated
    using (user_id = (select auth.uid()));
revoke all on public.event_follows from anon, authenticated;
grant select, insert, delete on public.event_follows to authenticated;

-- entering an event follows it
create or replace function public.event_store_entry(ev events, p_user uuid, p_answers jsonb, p_entry uuid default null)
 returns uuid language plpgsql set search_path to 'public'
as $$
declare
    clean jsonb;
    f jsonb;
    pub jsonb := '{}'::jsonb;
    priv jsonb := '{}'::jsonb;
    new_id uuid;
begin
    if pg_column_size(p_answers) > 6000000 then raise exception 'That entry is too large. Use smaller images.'; end if;
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
        update public.event_entries set answers = pub where id = p_entry;
        update public.event_entry_private set answers = priv where entry_id = p_entry;
        return p_entry;
    end if;
    insert into public.event_entries(event_id, user_id, answers) values (ev.id, p_user, pub) returning id into new_id;
    insert into public.event_entry_private(entry_id, event_id, user_id, answers) values (new_id, ev.id, p_user, priv);
    if p_user is not null then
        insert into public.event_follows(event_id, user_id) values (ev.id, p_user) on conflict do nothing;
    end if;
    return new_id;
end;
$$;

-- ==================== edit requests ====================

-- p_reason empty: take the request back
create or replace function public.request_event_entry_edit(p_entry uuid, p_reason text)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare
    uid uuid := auth.uid();
    en public.event_entries;
    ev public.events;
    me public.profiles;
    reason text := left(btrim(coalesce(p_reason, '')), 500);
begin
    if uid is null then raise exception 'Sign in first.'; end if;
    select * into en from public.event_entries where id = p_entry;
    if not found then raise exception 'That entry no longer exists.'; end if;
    if not public.event_can(en.event_id, 'entries') then raise exception 'You do not have permission to manage entries.'; end if;
    if en.user_id is null then raise exception 'A guest''s entry has no account to ask.'; end if;
    select * into ev from public.events where id = en.event_id;
    if public.event_phase(ev) = 'ended' then raise exception 'This event has ended, so entries can''t change any more.'; end if;
    if not public.rate_limit_hit('event-edit-request:' || uid, 60, interval '1 hour') then
        raise exception 'Too many requests. Try again in a while.';
    end if;
    update public.event_entry_private
       set edit_request = nullif(reason, ''), edit_requested_at = case when reason = '' then null else now() end
     where entry_id = p_entry;
    if reason <> '' and en.user_id <> uid then
        select * into me from public.profiles where id = uid;
        insert into public.notifications(user_id, actor_id, actor_name, actor_avatar_url, type, target_id, target_name, preview)
        values (en.user_id, uid, coalesce(nullif(me.display_name, ''), me.username, 'An organizer'), nullif(me.avatar_url, ''),
                'event_edit_request', 'event:' || coalesce(ev.slug, ev.id::text), left(ev.title, 120), reason);
    end if;
end;
$$;
revoke execute on function public.request_event_entry_edit(uuid, text) from public, anon;
grant execute on function public.request_event_entry_edit(uuid, text) to authenticated;

-- your own entry: while entries are open, or after, when the team asked you to change it
create or replace function public.update_event_entry(p_entry uuid, p_answers jsonb)
 returns uuid language plpgsql security definer set search_path to 'public'
as $$
declare
    uid uuid := auth.uid();
    ev public.events;
    asked boolean;
    out_id uuid;
begin
    if uid is null then raise exception 'Sign in to edit your entry.'; end if;
    if not public.rate_limit_hit('event-entry-edit:' || uid, 60, interval '1 hour') then
        raise exception 'You''re editing too quickly. Try again in a bit.';
    end if;
    select e.* into ev from public.events e join public.event_entries en on en.event_id = e.id
        where en.id = p_entry and en.user_id = uid for update of e;
    if not found then raise exception 'That entry isn''t yours.'; end if;
    select p.edit_requested_at is not null into asked from public.event_entry_private p where p.entry_id = p_entry;
    if public.event_phase(ev) <> 'open' and not (coalesce(asked, false) and public.event_phase(ev) <> 'ended') then
        raise exception 'Entries are closed, so it can''t be changed now.';
    end if;
    out_id := public.event_store_entry(ev, uid, p_answers, p_entry);
    update public.event_entry_private set edit_request = null, edit_requested_at = null where entry_id = p_entry;
    return out_id;
end;
$$;

-- ==================== announcements ====================

create table if not exists public.event_announcements (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    author_id uuid references auth.users(id) on delete set null,
    title text not null check (char_length(title) between 1 and 120),
    body text not null default '' check (char_length(body) <= 8000),
    created_at timestamptz not null default now(),
    -- set once the email went out (send-event-announcement), so it goes once
    emailed_at timestamptz
);
create index if not exists event_announcements_event_idx on public.event_announcements(event_id, created_at desc);
alter table public.event_announcements enable row level security;
drop policy if exists event_announcements_read on public.event_announcements;
drop policy if exists event_announcements_delete on public.event_announcements;
-- whoever can see the event (its own policy decides)
create policy event_announcements_read on public.event_announcements for select to anon, authenticated
    using (exists (select 1 from public.events e where e.id = event_id));
create policy event_announcements_delete on public.event_announcements for delete to authenticated
    using ((select public.event_can(event_id, 'edit')));
revoke all on public.event_announcements from anon, authenticated;
grant select (id, event_id, author_id, title, body, created_at) on public.event_announcements to anon, authenticated;
grant delete on public.event_announcements to authenticated;

create or replace function public.post_event_announcement(p_event uuid, p_title text, p_body text)
 returns uuid language plpgsql security definer set search_path to 'public'
as $$
declare
    uid uuid := auth.uid();
    ev public.events;
    me public.profiles;
    new_id uuid;
    t text := btrim(coalesce(p_title, ''));
begin
    if uid is null then raise exception 'Sign in first.'; end if;
    if not public.event_can(p_event, 'edit') then raise exception 'Only the team members who can edit this event can post announcements.'; end if;
    if t = '' then raise exception 'Give the announcement a title.'; end if;
    if not public.rate_limit_hit('event-announce:' || p_event, 20, interval '1 day') then
        raise exception 'This event has posted a lot of announcements today. Try again tomorrow.';
    end if;
    select * into ev from public.events where id = p_event;
    insert into public.event_announcements(event_id, author_id, title, body)
        values (p_event, uid, left(t, 120), left(btrim(coalesce(p_body, '')), 8000)) returning id into new_id;
    -- followers hear about it (respect_notification_prefs drops it for anyone who
    -- turned these off); not while the event is a draft nobody can open
    if ev.phase <> 'draft' then
        select * into me from public.profiles where id = uid;
        insert into public.notifications(user_id, actor_id, actor_name, actor_avatar_url, type, target_id, target_name, preview)
        select f.user_id, uid, coalesce(nullif(me.display_name, ''), me.username, 'An organizer'), nullif(me.avatar_url, ''),
               'event_announcement', 'event:' || coalesce(ev.slug, ev.id::text), left(ev.title, 120), left(t, 140)
          from public.event_follows f
         where f.event_id = p_event and f.user_id <> uid
           and not public.is_blocked_between(uid, f.user_id);
    end if;
    return new_id;
end;
$$;
revoke execute on function public.post_event_announcement(uuid, text, text) from public, anon;
grant execute on function public.post_event_announcement(uuid, text, text) to authenticated;

-- who gets an announcement by email: followers who asked for it, with a real
-- address. Only the send-event-announcement function (service role) calls it.
create or replace function public.event_announcement_recipients(p_announcement uuid)
 returns table(user_id uuid, email text, name text) language sql stable security definer set search_path to 'public'
as $$
    select u.id, u.email::text, coalesce(nullif(pr.display_name, ''), pr.username, 'there')
      from public.event_announcements a
      join public.event_follows f on f.event_id = a.event_id
      join auth.users u on u.id = f.user_id
      join public.notification_prefs np on np.user_id = f.user_id
      left join public.profiles pr on pr.id = f.user_id
     where a.id = p_announcement
       and f.user_id is distinct from a.author_id
       and (np.prefs->>'email_event_announcements') = 'true'
       and coalesce(np.prefs->>'all', 'true') <> 'false'
       and coalesce(np.prefs->>'event_announcement', 'true') <> 'false'
       and u.email is not null
       and u.email not like '%@users.woogidex.invalid' and u.email not like '%@no-email.woogidex.com'
       and (pr.banned_until is null or pr.banned_until < now());
$$;
revoke execute on function public.event_announcement_recipients(uuid) from public, anon, authenticated;
grant execute on function public.event_announcement_recipients(uuid) to service_role;

-- ==================== holding the results for the results post ====================

-- saves the post and releases the results (with hold_results on, they wait for this)
create or replace function public.publish_event_results(p_event uuid, p_body text)
 returns void language plpgsql security definer set search_path to 'public'
as $$
begin
    if not public.event_can(p_event, 'edit') then raise exception 'You do not have permission to publish the results.'; end if;
    if btrim(coalesce(p_body, '')) = '' then raise exception 'Write the results post first.'; end if;
    insert into public.event_results_posts(event_id, body) values (p_event, btrim(p_body))
        on conflict (event_id) do update set body = excluded.body;
    update public.events set results_released_at = coalesce(results_released_at, now()) where id = p_event;
end;
$$;
revoke execute on function public.publish_event_results(uuid, text) from public, anon;
grant execute on function public.publish_event_results(uuid, text) to authenticated;

-- ==================== the Google Sheets link ====================

create table if not exists public.event_sheet_links (
    event_id uuid primary key references public.events(id) on delete cascade,
    token text not null unique,
    include_private boolean not null default false,
    created_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now()
);
alter table public.event_sheet_links enable row level security;
drop policy if exists event_sheet_links_read on public.event_sheet_links;
drop policy if exists event_sheet_links_delete on public.event_sheet_links;
create policy event_sheet_links_read on public.event_sheet_links for select to authenticated
    using ((select public.event_can(event_id, 'entries')));
create policy event_sheet_links_delete on public.event_sheet_links for delete to authenticated
    using ((select public.event_can(event_id, 'entries')));
revoke all on public.event_sheet_links from anon, authenticated;
grant select, delete on public.event_sheet_links to authenticated;

-- makes (or replaces, which retires the old link) the event's sheet link
create or replace function public.create_event_sheet_link(p_event uuid, p_private boolean)
 returns text language plpgsql security definer set search_path to 'public'
as $$
declare
    t text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
    if not public.event_can(p_event, 'entries') then raise exception 'Only the team members who see entries can link a sheet.'; end if;
    insert into public.event_sheet_links(event_id, token, include_private, created_by)
        values (p_event, t, coalesce(p_private, false), auth.uid())
        on conflict (event_id) do update set token = excluded.token, include_private = excluded.include_private,
            created_by = excluded.created_by, created_at = now();
    return t;
end;
$$;
revoke execute on function public.create_event_sheet_link(uuid, boolean) from public, anon;
grant execute on function public.create_event_sheet_link(uuid, boolean) to authenticated;

-- an answer as a sheet cell: pictures as [image], a Fakemon (or move...) by name
create or replace function public.event_sheet_cell(v jsonb)
 returns jsonb language sql immutable set search_path to 'public'
as $$
    select case jsonb_typeof(v)
        when 'string' then case when v #>> '{}' like 'data:%' then '"[image]"'::jsonb else v end
        when 'object' then to_jsonb(coalesce(v->>'name', ''))
        else v end;
$$;

-- what the sheet link serves (worker/index.js turns it into CSV); the token is the key
create or replace function public.event_sheet_data(p_token text)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare
    l public.event_sheet_links;
    ev public.events;
begin
    select * into l from public.event_sheet_links where token = p_token and char_length(p_token) = 64;
    if not found then return null; end if;
    select * into ev from public.events where id = l.event_id;
    return jsonb_build_object(
        'title', ev.title,
        'questions', (select coalesce(jsonb_agg(jsonb_build_object('id', f->>'id', 'label', f->>'label')), '[]'::jsonb)
                        from jsonb_array_elements(ev.form) f
                       where f->>'type' <> 'section'
                         and (l.include_private or not (f->>'type' = 'email' or coalesce((f->>'private')::boolean, f->>'type' = 'discord')))),
        'entries', (select coalesce(jsonb_agg(jsonb_build_object(
                        'id', en.id, 'created_at', en.created_at, 'placement', en.placement,
                        'entrant', case when en.user_id is null then 'Guest' else coalesce('@' || pr.username, 'Member') end,
                        'answers', (select coalesce(jsonb_object_agg(x.k, public.event_sheet_cell(x.v)), '{}'::jsonb)
                                      from jsonb_each(en.answers || case when l.include_private then coalesce(p.answers, '{}'::jsonb) else '{}'::jsonb end) x(k, v)))
                        order by en.created_at), '[]'::jsonb)
                      from public.event_entries en
                      left join public.event_entry_private p on p.entry_id = en.id
                      left join public.profiles pr on pr.id = en.user_id
                     where en.event_id = l.event_id));
end;
$$;
revoke execute on function public.event_sheet_data(text) from public;
grant execute on function public.event_sheet_data(text) to anon, authenticated;
revoke execute on function public.event_sheet_cell(jsonb) from public, anon, authenticated;
