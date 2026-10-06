-- Events, the social side and staff tools, together:
--   1. Entry codes: a wrong or used-up code no longer rolls back the try that
--      counted it, so the rate limit on guessing actually holds.
--   2. One reaction per person on everything (posts, Fakémon, comments,
--      events): reacting again replaces yours. Existing doubles keep one,
--      a non-heart reaction over a heart, the newest of those.
--   3. Replies on every comment thread (parent_id), and a notification for
--      the comment replied to.
--   4. Comments and reactions on events.
--   5. Posts can show events, the way they show Fakémon (event_ids).
--   6. Announcements can be posted as the event rather than as yourself.
--   7. An audit log of what the team does on an event.
--   8. Names (Fakémon, moves, abilities, items, types) are up to 30 characters.
--   9. Staff moderation for post comments, event comments, posts and events,
--      and for profiles (reset a display name, clear a bio).
--  10. Notifications only the database may send.
--  11. Event names, display names and group chat names are up to 30 characters too.

-- ==================== 1. entry codes ====================
-- Returns the entries you may now send, or: -1 no such code, -2 used up,
-- -3 too many tries. Raising rolled back the rate limit's own count.

create or replace function public.redeem_event_code(p_event uuid, p_code text)
 returns integer language plpgsql security definer set search_path to 'public'
as $$
declare
    uid uuid := auth.uid();
    c public.event_codes;
begin
    if uid is null then raise exception 'Sign in to use a code.'; end if;
    if not public.rate_limit_hit('event-code:' || uid, 10, interval '1 hour') then return -3; end if;
    select * into c from public.event_codes where event_id = p_event and lower(code) = lower(btrim(coalesce(p_code, ''))) for update;
    if not found then return -1; end if;
    if not exists (select 1 from public.event_code_redemptions r where r.code_id = c.id and r.user_id = uid) then
        if c.max_uses is not null and c.uses >= c.max_uses then return -2; end if;
        insert into public.event_code_redemptions(code_id, user_id) values (c.id, uid);
        update public.event_codes set uses = uses + 1 where id = c.id;
    end if;
    -- a code raises your limit, never lowers one you already have
    insert into public.event_entry_limits(event_id, user_id, max_entries) values (p_event, uid, c.max_entries)
        on conflict (event_id, user_id) do update set max_entries = greatest(public.event_entry_limits.max_entries, excluded.max_entries);
    return (select max_entries from public.event_entry_limits where event_id = p_event and user_id = uid);
end;
$$;

-- ==================== 4a. event comments and reactions (tables) ====================

create table if not exists public.event_comments (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    user_id uuid not null references public.profiles(id) on delete cascade,
    parent_id uuid references public.event_comments(id) on delete cascade,
    body text not null check (char_length(btrim(body)) between 1 and 1000),
    created_at timestamptz not null default now(),
    edited_at timestamptz
);
create index if not exists event_comments_event_idx on public.event_comments(event_id, created_at);
create index if not exists event_comments_user_idx on public.event_comments(user_id);
create index if not exists event_comments_parent_idx on public.event_comments(parent_id);
alter table public.event_comments enable row level security;
-- whoever can see the event (events' own RLS hides drafts) reads its comments
create policy event_comments_read on public.event_comments for select to authenticated
    using (exists (select 1 from public.events e where e.id = event_id));
create policy event_comments_insert on public.event_comments for insert to authenticated
    with check (user_id = (select auth.uid()) and exists (select 1 from public.events e where e.id = event_id));
create policy event_comments_update on public.event_comments for update to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy event_comments_delete on public.event_comments for delete to authenticated
    using (user_id = (select auth.uid()) or (select public.event_can(event_id, 'edit')) or (select public.has_perm((select auth.uid()), 'delete_content')));
revoke all on public.event_comments from anon, authenticated;
grant select, insert, update, delete on public.event_comments to authenticated;

create table if not exists public.event_reactions (
    event_id uuid not null references public.events(id) on delete cascade,
    user_id uuid not null references public.profiles(id) on delete cascade,
    emoji text not null check (emoji ~ '^[a-z0-9_]{1,48}$'),
    created_at timestamptz not null default now(),
    primary key (event_id, user_id)
);
create index if not exists event_reactions_user_idx on public.event_reactions(user_id);
alter table public.event_reactions enable row level security;
create policy event_reactions_read on public.event_reactions for select to authenticated
    using (exists (select 1 from public.events e where e.id = event_id));
create policy event_reactions_insert on public.event_reactions for insert to authenticated
    with check (user_id = (select auth.uid()) and exists (select 1 from public.events e where e.id = event_id and e.phase <> 'draft'));
create policy event_reactions_delete on public.event_reactions for delete to authenticated
    using (user_id = (select auth.uid()));
revoke all on public.event_reactions from anon, authenticated;
grant select, insert, delete on public.event_reactions to authenticated;

create or replace function public.guard_event_reaction()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
    if public.is_banned(new.user_id) then raise exception 'Your account is suspended.' using errcode = 'P0001'; end if;
    if not public.rate_limit_hit('react:' || new.user_id::text, 60, interval '1 minute') then
        raise exception 'Slow down a little!' using errcode = 'P0001';
    end if;
    return new;
end $$;
create trigger event_reactions_guard before insert on public.event_reactions
    for each row execute function public.guard_event_reaction();

-- ==================== 2. one reaction each ====================

-- keep one per person: any non-heart over a heart, then the newest
delete from public.post_reactions r using (
    select ctid, row_number() over (partition by post_id, user_id order by (emoji = 'heart'), created_at desc) rn from public.post_reactions
) d where r.ctid = d.ctid and d.rn > 1;
delete from public.mon_reactions r using (
    select ctid, row_number() over (partition by mon_id, user_id order by (emoji = 'heart'), created_at desc) rn from public.mon_reactions
) d where r.ctid = d.ctid and d.rn > 1;
delete from public.comment_reactions r using (
    select ctid, row_number() over (partition by comment_kind, comment_id, user_id order by (emoji = 'heart'), created_at desc) rn from public.comment_reactions
) d where r.ctid = d.ctid and d.rn > 1;

create unique index if not exists post_reactions_one_each on public.post_reactions(post_id, user_id);
create unique index if not exists mon_reactions_one_each on public.mon_reactions(mon_id, user_id);
create unique index if not exists comment_reactions_one_each on public.comment_reactions(comment_kind, comment_id, user_id);

-- reacting again swaps your reaction for the new one (named to run after the guards)
create or replace function public.replace_my_reaction()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
    if tg_table_name = 'post_reactions' then
        delete from public.post_reactions where post_id = new.post_id and user_id = new.user_id;
    elsif tg_table_name = 'mon_reactions' then
        delete from public.mon_reactions where mon_id = new.mon_id and user_id = new.user_id;
    elsif tg_table_name = 'comment_reactions' then
        delete from public.comment_reactions where comment_kind = new.comment_kind and comment_id = new.comment_id and user_id = new.user_id;
    elsif tg_table_name = 'event_reactions' then
        delete from public.event_reactions where event_id = new.event_id and user_id = new.user_id;
    end if;
    return new;
end $$;
revoke execute on function public.replace_my_reaction() from public, anon, authenticated;
create trigger post_reactions_replace before insert on public.post_reactions for each row execute function public.replace_my_reaction();
create trigger mon_reactions_replace before insert on public.mon_reactions for each row execute function public.replace_my_reaction();
create trigger comment_reactions_replace before insert on public.comment_reactions for each row execute function public.replace_my_reaction();
create trigger event_reactions_replace before insert on public.event_reactions for each row execute function public.replace_my_reaction();

-- comment reactions take event comments too
alter table public.comment_reactions drop constraint if exists comment_reactions_comment_kind_check;
alter table public.comment_reactions add constraint comment_reactions_comment_kind_check check (comment_kind in ('mon', 'post', 'profile', 'event'));

create or replace function public.guard_comment_reaction()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare
    found_it boolean;
begin
    if public.is_banned(new.user_id) then
        raise exception 'Your account is suspended.' using errcode = 'P0001';
    end if;
    if not public.rate_limit_hit('react:' || new.user_id::text, 60, interval '1 minute') then
        raise exception 'Slow down a little!' using errcode = 'P0001';
    end if;
    found_it := case new.comment_kind
        when 'mon'     then exists (select 1 from public.mon_comments     where id = new.comment_id)
        when 'post'    then exists (select 1 from public.post_comments    where id = new.comment_id)
        when 'profile' then exists (select 1 from public.profile_comments where id = new.comment_id)
        when 'event'   then exists (select 1 from public.event_comments   where id = new.comment_id)
        else false
    end;
    if not found_it then
        raise exception 'That comment is gone.' using errcode = 'P0001';
    end if;
    return new;
end $$;

-- ==================== 3. replies ====================

alter table public.mon_comments add column if not exists parent_id uuid references public.mon_comments(id) on delete cascade;
alter table public.post_comments add column if not exists parent_id uuid references public.post_comments(id) on delete cascade;
alter table public.profile_comments add column if not exists parent_id uuid references public.profile_comments(id) on delete cascade;
create index if not exists mon_comments_parent_idx on public.mon_comments(parent_id);
create index if not exists post_comments_parent_idx on public.post_comments(parent_id);
create index if not exists profile_comments_parent_idx on public.profile_comments(parent_id);

-- a reply belongs to the same thread as the comment it answers
create or replace function public.guard_comment_parent()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare ok boolean;
begin
    if new.parent_id is null then return new; end if;
    if tg_table_name = 'mon_comments' then
        ok := exists (select 1 from public.mon_comments c where c.id = new.parent_id and c.mon_id = new.mon_id);
    elsif tg_table_name = 'post_comments' then
        ok := exists (select 1 from public.post_comments c where c.id = new.parent_id and c.post_id = new.post_id);
    elsif tg_table_name = 'profile_comments' then
        ok := exists (select 1 from public.profile_comments c where c.id = new.parent_id and c.profile_id = new.profile_id);
    else
        ok := exists (select 1 from public.event_comments c where c.id = new.parent_id and c.event_id = new.event_id);
    end if;
    if not ok then raise exception 'The comment you replied to is gone.' using errcode = 'P0001'; end if;
    return new;
end $$;
revoke execute on function public.guard_comment_parent() from public, anon, authenticated;
create trigger comment_parent_guard before insert on public.mon_comments for each row execute function public.guard_comment_parent();
create trigger comment_parent_guard before insert on public.post_comments for each row execute function public.guard_comment_parent();
create trigger comment_parent_guard before insert on public.profile_comments for each row execute function public.guard_comment_parent();
create trigger comment_parent_guard before insert on public.event_comments for each row execute function public.guard_comment_parent();

-- the one replied to hears about it (unless it's their own, or either blocked the other)
create or replace function public.notify_comment_reply()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare
    parent_author uuid;
    tgt text;
    actor public.profiles;
begin
    if new.parent_id is null then return null; end if;
    if tg_table_name = 'mon_comments' then
        select user_id into parent_author from public.mon_comments where id = new.parent_id; tgt := 'mon:' || new.mon_id;
    elsif tg_table_name = 'post_comments' then
        select user_id into parent_author from public.post_comments where id = new.parent_id; tgt := 'post:' || new.post_id;
    elsif tg_table_name = 'profile_comments' then
        select user_id into parent_author from public.profile_comments where id = new.parent_id; tgt := 'profile:' || new.profile_id;
    else
        select user_id into parent_author from public.event_comments where id = new.parent_id;
        tgt := 'event:' || coalesce((select coalesce(e.slug, e.id::text) from public.events e where e.id = new.event_id), new.event_id::text);
    end if;
    if parent_author is null or parent_author = new.user_id or public.is_blocked_between(new.user_id, parent_author) then return null; end if;
    select * into actor from public.profiles where id = new.user_id;
    insert into public.notifications(user_id, actor_id, actor_name, actor_avatar_url, type, target_id, target_name, preview)
    values (parent_author, new.user_id, coalesce(nullif(actor.display_name, ''), actor.username, 'Someone'), nullif(actor.avatar_url, ''),
            'comment_reply', tgt, 'your comment', left(new.body, 140));
    return null;
end $$;
revoke execute on function public.notify_comment_reply() from public, anon, authenticated;
create trigger notify_comment_reply after insert on public.mon_comments for each row execute function public.notify_comment_reply();
create trigger notify_comment_reply after insert on public.post_comments for each row execute function public.notify_comment_reply();
create trigger notify_comment_reply after insert on public.profile_comments for each row execute function public.notify_comment_reply();
create trigger notify_comment_reply after insert on public.event_comments for each row execute function public.notify_comment_reply();

-- ==================== 4b. event comments (the rest of their wiring) ====================

-- mentions: event comments name the event
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
    if tg_table_name = 'community_posts' then tgt := 'post:' || new.id; what := 'a post';
    elsif tg_table_name = 'post_comments' then tgt := 'post:' || new.post_id; what := 'a comment';
    elsif tg_table_name = 'mon_comments' then tgt := 'mon:' || new.mon_id; what := 'a comment';
    elsif tg_table_name = 'event_comments' then
        tgt := 'event:' || coalesce((select coalesce(e.slug, e.id::text) from public.events e where e.id = new.event_id), new.event_id::text);
        what := 'a comment';
    else tgt := 'profile:' || new.profile_id; what := 'a wall post';
    end if;
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
end $$;

create trigger enforce_content_policy before insert or update of body on public.event_comments for each row execute function public.enforce_content_policy();
create trigger comment_edit_guard before update on public.event_comments for each row execute function public.guard_comment_edit();
create trigger comment_reactions_cleanup after delete on public.event_comments for each row execute function public.drop_comment_reactions('event');
create trigger notify_mentions after insert on public.event_comments for each row execute function public.notify_mentions();

-- ==================== 5. events in posts ====================

alter table public.community_posts add column if not exists event_ids uuid[] not null default '{}';
alter table public.community_posts drop constraint if exists community_posts_event_ids_check;
alter table public.community_posts add constraint community_posts_event_ids_check check (cardinality(event_ids) <= 4);
alter table public.community_posts drop constraint if exists community_posts_check;
alter table public.community_posts add constraint community_posts_check
    check (char_length(btrim(body)) > 0 or cardinality(mon_ids) > 0 or cardinality(event_ids) > 0 or repost_id is not null);

create or replace function public.guard_community_post()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare bad_tag text;
begin
    if tg_op = 'UPDATE' then
        new.id := old.id;
        new.user_id := old.user_id;
        new.created_at := old.created_at;
        new.activity_at := least(coalesce(new.activity_at, old.activity_at), now());
        if (new.body, new.mon_ids, new.event_ids, new.tags) is distinct from (old.body, old.mon_ids, old.event_ids, old.tags) then new.edited_at := now(); else new.edited_at := old.edited_at; end if;
    else
        new.created_at := now();
        new.activity_at := now();
        new.edited_at := null;
        if not public.rate_limit_hit('post-hour:' || new.user_id::text, 20, interval '1 hour') then
            raise exception 'That''s a lot of posts! Try again in a little while.' using errcode = 'P0001';
        end if;
    end if;
    -- only your own published Fakemon can go in a collection post
    if exists (select 1 from unnest(new.mon_ids) m(id)
               where not exists (select 1 from public.published_mons pm where pm.id = m.id and pm.user_id = new.user_id)) then
        raise exception 'You can only show off your own published Fakemon in a post.' using errcode = 'P0001';
    end if;
    -- any event that's live (not a draft) can be shown; checked only when the list
    -- is set, so a post whose event later went back to a draft can still be
    -- commented on, reacted to (both bump activity_at) and edited
    if (tg_op = 'INSERT' or new.event_ids is distinct from old.event_ids)
       and exists (select 1 from unnest(new.event_ids) x(id)
               where not exists (select 1 from public.events e where e.id = x.id and e.phase <> 'draft')) then
        raise exception 'Only published events can go in a post.' using errcode = 'P0001';
    end if;
    select t into bad_tag from unnest(new.tags) t where t !~ '^[a-z0-9_]{1,24}$' limit 1;
    if found then
        raise exception 'Tags are letters, numbers and underscores (up to 24).' using errcode = 'P0001';
    end if;
    return new;
end $$;

-- ==================== 6. announcements as the event ====================
-- show_author false: readers see the event as the poster. author_id is then
-- empty; posted_by (not readable by the public) keeps who it was, for the
-- audit log and so the poster isn't emailed their own announcement.

alter table public.event_announcements add column if not exists show_author boolean not null default true;
alter table public.event_announcements add column if not exists posted_by uuid references auth.users(id) on delete set null;
update public.event_announcements set posted_by = author_id where posted_by is null;
grant select (show_author) on public.event_announcements to anon, authenticated;

drop function if exists public.post_event_announcement(uuid, text, text);
create or replace function public.post_event_announcement(p_event uuid, p_title text, p_body text, p_show_author boolean default true)
 returns uuid language plpgsql security definer set search_path to 'public'
as $$
declare
    uid uuid := auth.uid();
    ev public.events;
    me public.profiles;
    new_id uuid;
    t text := btrim(coalesce(p_title, ''));
    shown boolean := coalesce(p_show_author, true);
begin
    if uid is null then raise exception 'Sign in first.'; end if;
    if not public.event_can(p_event, 'edit') then raise exception 'Only the team members who can edit this event can post announcements.'; end if;
    if t = '' then raise exception 'Give the announcement a title.'; end if;
    if not public.rate_limit_hit('event-announce:' || p_event, 20, interval '1 day') then
        raise exception 'This event has posted a lot of announcements today. Try again tomorrow.';
    end if;
    select * into ev from public.events where id = p_event;
    insert into public.event_announcements(event_id, author_id, posted_by, show_author, title, body)
        values (p_event, case when shown then uid end, uid, shown, left(t, 120), left(btrim(coalesce(p_body, '')), 8000)) returning id into new_id;
    -- followers hear about it (respect_notification_prefs drops it for anyone who
    -- turned these off); not while the event is a draft nobody can open
    if ev.phase <> 'draft' then
        select * into me from public.profiles where id = uid;
        insert into public.notifications(user_id, actor_id, actor_name, actor_avatar_url, type, target_id, target_name, preview)
        select f.user_id, case when shown then uid end,
               case when shown then coalesce(nullif(me.display_name, ''), me.username, 'An organizer') else left(ev.title, 120) end,
               case when shown then nullif(me.avatar_url, '') end,
               'event_announcement', 'event:' || coalesce(ev.slug, ev.id::text), left(ev.title, 120), left(t, 140)
          from public.event_follows f
         where f.event_id = p_event and f.user_id <> uid
           and not public.is_blocked_between(uid, f.user_id);
    end if;
    return new_id;
end;
$$;
revoke execute on function public.post_event_announcement(uuid, text, text, boolean) from public, anon;
grant execute on function public.post_event_announcement(uuid, text, text, boolean) to authenticated;

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
       and f.user_id is distinct from coalesce(a.posted_by, a.author_id)
       and (np.prefs->>'email_event_announcements') = 'true'
       and coalesce(np.prefs->>'all', 'true') <> 'false'
       and coalesce(np.prefs->>'event_announcement', 'true') <> 'false'
       and u.email is not null
       and u.email not like '%@users.woogidex.invalid' and u.email not like '%@no-email.woogidex.com'
       and (pr.banned_until is null or pr.banned_until < now());
$$;

-- ==================== 7. the event audit log ====================
-- Written by triggers only; the team (anyone with dashboard access) reads it.

create table if not exists public.event_audit_log (
    id bigint generated always as identity primary key,
    event_id uuid not null,
    actor_id uuid,
    action text not null,
    detail jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);
create index if not exists event_audit_log_event_idx on public.event_audit_log(event_id, created_at desc);
alter table public.event_audit_log enable row level security;
create policy event_audit_log_read on public.event_audit_log for select to authenticated
    using ((select public.event_can(event_id, 'view')));
revoke all on public.event_audit_log from anon, authenticated;
grant select on public.event_audit_log to authenticated;

create or replace function public.event_audit(p_event uuid, p_action text, p_detail jsonb default '{}'::jsonb)
 returns void language plpgsql security definer set search_path to 'public'
as $$
begin
    -- an event being deleted takes its log with it; nothing to add then
    if p_event is null or not exists (select 1 from public.events where id = p_event) then return; end if;
    insert into public.event_audit_log(event_id, actor_id, action, detail) values (p_event, auth.uid(), p_action, coalesce(p_detail, '{}'::jsonb));
end $$;
revoke execute on function public.event_audit(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.audit_events()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare
    changed text[];
begin
    if tg_op = 'INSERT' then
        perform public.event_audit(new.id, 'event_created', jsonb_build_object('title', new.title));
        return null;
    end if;
    if tg_op = 'DELETE' then
        delete from public.event_audit_log where event_id = old.id;
        return null;
    end if;
    select array_agg(k order by k) into changed
      from jsonb_each(to_jsonb(new)) n(k, v)
     where k not in ('updated_at', 'cover_thumb') and n.v is distinct from (to_jsonb(old)->k);
    if changed is null then return null; end if;
    if new.phase is distinct from old.phase then
        perform public.event_audit(new.id, 'phase_changed', jsonb_build_object('from', old.phase, 'to', new.phase));
        changed := array_remove(changed, 'phase');
    end if;
    if new.results_released_at is distinct from old.results_released_at and new.results_released_at is not null then
        perform public.event_audit(new.id, 'results_published', '{}'::jsonb);
        changed := array_remove(changed, 'results_released_at');
    end if;
    if cardinality(changed) > 0 then
        perform public.event_audit(new.id, 'event_edited', jsonb_build_object('fields', to_jsonb(changed)));
    end if;
    return null;
end $$;
create trigger audit_events after insert or update or delete on public.events for each row execute function public.audit_events();

create or replace function public.audit_event_children()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare
    r record;
    ev uuid;
    uid uuid := auth.uid();
begin
    if tg_op = 'DELETE' then r := old; else r := new; end if;
    if tg_table_name = 'event_entries' then
        if tg_op = 'INSERT' then
            perform public.event_audit(r.event_id, 'entry_submitted', jsonb_build_object('entry_id', r.id, 'user_id', r.user_id));
        elsif tg_op = 'DELETE' then
            perform public.event_audit(r.event_id, case when uid is not null and uid = old.user_id then 'entry_withdrawn' else 'entry_removed' end,
                jsonb_build_object('entry_id', old.id, 'user_id', old.user_id));
        else
            if new.answers is distinct from old.answers then
                perform public.event_audit(new.event_id, 'entry_edited', jsonb_build_object('entry_id', new.id, 'user_id', new.user_id));
            end if;
            if new.placement is distinct from old.placement then
                perform public.event_audit(new.event_id, 'placement_set', jsonb_build_object('entry_id', new.id, 'user_id', new.user_id, 'placement', new.placement));
            end if;
        end if;
    elsif tg_table_name = 'event_helpers' then
        perform public.event_audit(r.event_id, case tg_op when 'INSERT' then 'team_added' when 'DELETE' then 'team_removed' else 'team_changed' end,
            jsonb_build_object('user_id', r.user_id, 'organizer', r.is_organizer, 'edit', r.can_edit, 'entries', r.can_entries,
                               'judge', r.can_judge, 'results', r.can_results, 'add', r.can_add));
    elsif tg_table_name = 'event_codes' then
        if tg_op = 'UPDATE' then return null; end if;
        perform public.event_audit(r.event_id, case when tg_op = 'INSERT' then 'code_created' else 'code_deleted' end,
            jsonb_build_object('code', r.code, 'max_entries', r.max_entries, 'max_uses', r.max_uses));
    elsif tg_table_name = 'event_code_redemptions' then
        select c.event_id into ev from public.event_codes c where c.id = new.code_id;
        perform public.event_audit(ev, 'code_redeemed', jsonb_build_object('user_id', new.user_id, 'code', (select code from public.event_codes where id = new.code_id)));
    elsif tg_table_name = 'event_entry_limits' then
        perform public.event_audit(r.event_id, case when tg_op = 'DELETE' then 'limit_removed' else 'limit_set' end,
            jsonb_build_object('user_id', r.user_id, 'max_entries', r.max_entries));
    elsif tg_table_name = 'event_announcements' then
        perform public.event_audit(r.event_id, case when tg_op = 'INSERT' then 'announcement_posted' else 'announcement_deleted' end,
            jsonb_build_object('title', r.title, 'as_event', not r.show_author, 'posted_by', r.posted_by));
    elsif tg_table_name = 'event_results_posts' then
        perform public.event_audit(r.event_id, 'results_post_saved', '{}'::jsonb);
    elsif tg_table_name = 'event_entry_private' then
        if new.edit_requested_at is distinct from old.edit_requested_at then
            perform public.event_audit(new.event_id, case when new.edit_requested_at is null then 'edit_request_withdrawn' else 'edit_requested' end,
                jsonb_build_object('entry_id', new.entry_id, 'user_id', new.user_id, 'reason', left(coalesce(new.edit_request, ''), 300)));
        end if;
        if to_jsonb(new)->'feedback' is distinct from to_jsonb(old)->'feedback' then
            perform public.event_audit(new.event_id, 'feedback_sent', jsonb_build_object('entry_id', new.entry_id, 'user_id', new.user_id));
        end if;
    elsif tg_table_name = 'event_ballots' then
        perform public.event_audit(new.event_id, 'ballot_submitted', jsonb_build_object('user_id', new.voter_id));
    elsif tg_table_name = 'event_votes' then
        -- a full ballot is one line (ballot_submitted), not one per entry
        if (select e.voting from public.events e where e.id = r.event_id) = 'ballot' then return null; end if;
        perform public.event_audit(r.event_id, case when tg_op = 'DELETE' then 'vote_removed' when tg_op = 'UPDATE' then 'vote_changed' else 'vote_cast' end,
            jsonb_build_object('user_id', r.voter_id, 'entry_id', r.entry_id));
    elsif tg_table_name = 'event_comments' then
        -- only the team or staff taking someone else's comment down; a reply that
        -- went with its comment (on delete cascade) isn't a removal of its own
        if uid is distinct from old.user_id
           and (old.parent_id is null or exists (select 1 from public.event_comments p where p.id = old.parent_id)) then
            perform public.event_audit(old.event_id, 'comment_removed', jsonb_build_object('user_id', old.user_id, 'excerpt', left(old.body, 140)));
        end if;
    end if;
    return null;
end $$;
revoke execute on function public.audit_events() from public, anon, authenticated;
revoke execute on function public.audit_event_children() from public, anon, authenticated;

create trigger audit_event_children after insert or update or delete on public.event_entries for each row execute function public.audit_event_children();
create trigger audit_event_children after insert or update or delete on public.event_helpers for each row execute function public.audit_event_children();
create trigger audit_event_children after insert or delete on public.event_codes for each row execute function public.audit_event_children();
create trigger audit_event_children after insert on public.event_code_redemptions for each row execute function public.audit_event_children();
create trigger audit_event_children after insert or update or delete on public.event_entry_limits for each row execute function public.audit_event_children();
create trigger audit_event_children after insert or delete on public.event_announcements for each row execute function public.audit_event_children();
create trigger audit_event_children after insert or update on public.event_results_posts for each row execute function public.audit_event_children();
create trigger audit_event_children after update on public.event_entry_private for each row execute function public.audit_event_children();
create trigger audit_event_children after insert on public.event_ballots for each row execute function public.audit_event_children();
create trigger audit_event_children after insert or update or delete on public.event_votes for each row execute function public.audit_event_children();
create trigger audit_event_children after delete on public.event_comments for each row execute function public.audit_event_children();

-- ==================== 8. names up to 30 characters ====================

create or replace function public.guard_mon_name()
 returns trigger language plpgsql set search_path to 'public'
as $$
begin
    if char_length(coalesce(new.fakemon_data->>'name', '')) > 30
       and (tg_op = 'INSERT' or new.fakemon_data->>'name' is distinct from old.fakemon_data->>'name') then
        raise exception 'Fakémon names can be up to 30 characters.' using errcode = 'P0001';
    end if;
    return new;
end $$;
create trigger guard_mon_name before insert or update on public.published_mons for each row execute function public.guard_mon_name();

-- event answers: a Fakémon (and each one in its line), a move, ability, item or type
create or replace function public.event_store_entry(ev events, p_user uuid, p_answers jsonb, p_entry uuid default null::uuid)
 returns uuid language plpgsql set search_path to 'public'
as $$
declare
    clean jsonb;
    f jsonb;
    v jsonb;
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
        v := clean->(f->>'id');
        if f->>'type' in ('fakemon', 'library') and jsonb_typeof(v) = 'object' then
            if char_length(coalesce(v->>'name', '')) > 30
               or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v->'family') = 'array' then v->'family' else '[]'::jsonb end) m
                          where char_length(coalesce(m->'mon'->>'name', '')) > 30) then
                raise exception 'Names can be up to 30 characters ("%").', f->>'label' using errcode = 'P0001';
            end if;
        end if;
        -- same rule as isPrivateField in js/features/events.ts
        if f->>'type' = 'email' or coalesce((f->>'private')::boolean, f->>'type' = 'discord') then
            priv := priv || jsonb_build_object(f->>'id', v);
        else
            pub := pub || jsonb_build_object(f->>'id', v);
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

-- ==================== 9. staff tools ====================

-- every comment thread, newest first
drop function if exists public.admin_recent_comments(integer, text);
create or replace function public.admin_recent_comments(p_limit integer default 100, p_search text default '')
 returns table(id uuid, kind text, user_id uuid, author_name text, body text, created_at timestamptz, context_id text, context_name text)
 language plpgsql stable security definer set search_path to 'public'
as $$
declare q text := coalesce(p_search, '');
begin
    perform public.mod_assert(null, 'staff');
    return query
    with c as (
        select c.id, 'mon'::text kind, c.user_id, c.body, c.created_at, c.mon_id::text ctx,
               coalesce((select m.fakemon_data->>'name' from public.published_mons m where m.id = c.mon_id), 'deleted Fakemon') ctx_name
          from public.mon_comments c
        union all
        select c.id, 'profile', c.user_id, c.body, c.created_at, c.profile_id::text,
               coalesce((select coalesce(nullif(pr.display_name,''), pr.username) from public.profiles pr where pr.id = c.profile_id), 'deleted profile')
          from public.profile_comments c
        union all
        select c.id, 'post', c.user_id, c.body, c.created_at, c.post_id::text,
               coalesce((select 'post by ' || coalesce(nullif(pr.display_name,''), pr.username) from public.community_posts p join public.profiles pr on pr.id = p.user_id where p.id = c.post_id), 'deleted post')
          from public.post_comments c
        union all
        select c.id, 'event', c.user_id, c.body, c.created_at, coalesce(e.slug, e.id::text), coalesce(e.title, 'deleted event')
          from public.event_comments c left join public.events e on e.id = c.event_id
    )
    select c.id, c.kind, c.user_id,
           coalesce((select coalesce(nullif(pr.display_name,''), pr.username) from public.profiles pr where pr.id = c.user_id), 'user'),
           c.body, c.created_at, c.ctx, c.ctx_name
      from c
     where q = '' or c.body ilike '%' || q || '%'
        or exists (select 1 from public.profiles pr where pr.id = c.user_id and (pr.username ilike '%' || q || '%' or pr.display_name ilike '%' || q || '%'))
     order by c.created_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 300));
end $$;

create or replace function public.admin_delete_comment(p_comment_id uuid, p_kind text, p_reason text default '')
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare owner uuid; snippet text;
begin
    if p_kind = 'profile' then select user_id, left(body, 300) into owner, snippet from public.profile_comments where id = p_comment_id;
    elsif p_kind = 'post' then select user_id, left(body, 300) into owner, snippet from public.post_comments where id = p_comment_id;
    elsif p_kind = 'event' then select user_id, left(body, 300) into owner, snippet from public.event_comments where id = p_comment_id;
    else select user_id, left(body, 300) into owner, snippet from public.mon_comments where id = p_comment_id;
    end if;
    if owner is null then raise exception 'Comment not found'; end if;
    perform public.mod_assert(owner, 'delete_content');

    if p_kind = 'profile' then delete from public.profile_comments where id = p_comment_id;
    elsif p_kind = 'post' then delete from public.post_comments where id = p_comment_id;
    elsif p_kind = 'event' then delete from public.event_comments where id = p_comment_id;
    else delete from public.mon_comments where id = p_comment_id;
    end if;

    perform public.mod_log(owner, 'delete_comment', p_reason, jsonb_build_object('kind', p_kind, 'excerpt', snippet));
    insert into public.notifications(user_id, actor_id, actor_name, type, target_name, preview)
    select owner, auth.uid(), coalesce(nullif(display_name,''), username, 'A staff member'),
           'mod_comment_deleted', 'your comment', left(coalesce(p_reason, ''), 300)
      from public.profiles where id = auth.uid();
end $$;

drop function if exists public.admin_user_comments(uuid, integer);
create or replace function public.admin_user_comments(p_user_id uuid, p_limit integer default 200)
 returns table(id uuid, kind text, body text, created_at timestamptz, context_id text, context_name text)
 language plpgsql stable security definer set search_path to 'public'
as $$
begin
    perform public.mod_assert(null, 'staff');
    return query
    select c.id, 'mon'::text, c.body, c.created_at, c.mon_id::text,
           coalesce((select m.fakemon_data->>'name' from public.published_mons m where m.id = c.mon_id), 'deleted Fakemon')
      from public.mon_comments c where c.user_id = p_user_id
    union all
    select c.id, 'profile', c.body, c.created_at, c.profile_id::text,
           coalesce((select coalesce(nullif(pr.display_name,''), pr.username) from public.profiles pr where pr.id = c.profile_id), 'deleted profile')
      from public.profile_comments c where c.user_id = p_user_id
    union all
    select c.id, 'post', c.body, c.created_at, c.post_id::text, 'a post'
      from public.post_comments c where c.user_id = p_user_id
    union all
    select c.id, 'event', c.body, c.created_at, coalesce(e.slug, e.id::text), coalesce(e.title, 'deleted event')
      from public.event_comments c left join public.events e on e.id = c.event_id where c.user_id = p_user_id
    order by 4 desc
    limit greatest(1, least(coalesce(p_limit, 200), 500));
end $$;

create or replace function public.admin_count_user_comments(p_user_id uuid, p_hours integer default null, p_kind text default 'all')
 returns integer language plpgsql stable security definer set search_path to 'public'
as $$
declare cutoff timestamptz; n int := 0;
begin
    perform public.mod_assert(null, 'staff');
    cutoff := case when coalesce(p_hours, 0) <= 0 then '-infinity'::timestamptz else now() - make_interval(hours => p_hours) end;
    if p_kind in ('all', 'mon') then n := n + (select count(*) from public.mon_comments where user_id = p_user_id and created_at >= cutoff); end if;
    if p_kind in ('all', 'profile') then n := n + (select count(*) from public.profile_comments where user_id = p_user_id and created_at >= cutoff); end if;
    if p_kind in ('all', 'post') then n := n + (select count(*) from public.post_comments where user_id = p_user_id and created_at >= cutoff); end if;
    if p_kind in ('all', 'event') then n := n + (select count(*) from public.event_comments where user_id = p_user_id and created_at >= cutoff); end if;
    return n;
end $$;

create or replace function public.admin_purge_user_comments(p_user_id uuid, p_hours integer default null, p_kind text default 'all', p_reason text default '')
 returns integer language plpgsql security definer set search_path to 'public'
as $$
declare cutoff timestamptz; removed int := 0; n int;
begin
    perform public.mod_assert(p_user_id, 'purge_content');
    cutoff := case when coalesce(p_hours, 0) <= 0 then '-infinity'::timestamptz else now() - make_interval(hours => p_hours) end;
    if p_kind in ('all', 'mon') then
        with gone as (delete from public.mon_comments where user_id = p_user_id and created_at >= cutoff returning 1) select count(*) into n from gone;
        removed := removed + n;
    end if;
    if p_kind in ('all', 'profile') then
        with gone as (delete from public.profile_comments where user_id = p_user_id and created_at >= cutoff returning 1) select count(*) into n from gone;
        removed := removed + n;
    end if;
    if p_kind in ('all', 'post') then
        with gone as (delete from public.post_comments where user_id = p_user_id and created_at >= cutoff returning 1) select count(*) into n from gone;
        removed := removed + n;
    end if;
    if p_kind in ('all', 'event') then
        with gone as (delete from public.event_comments where user_id = p_user_id and created_at >= cutoff returning 1) select count(*) into n from gone;
        removed := removed + n;
    end if;
    perform public.mod_log(p_user_id, 'purge_comments', p_reason, jsonb_build_object('hours', p_hours, 'kind', p_kind, 'removed', removed));
    if removed > 0 then
        insert into public.notifications(user_id, actor_id, actor_name, type, target_name, preview)
        select p_user_id, auth.uid(), coalesce(nullif(display_name,''), username, 'A staff member'),
               'mod_comment_deleted', removed || ' of your comments', left(coalesce(p_reason, ''), 300)
          from public.profiles where id = auth.uid();
    end if;
    return removed;
end $$;

create or replace function public.admin_user_overview(p_user_id uuid)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare out jsonb;
begin
    perform public.mod_assert(null, 'staff');
    select jsonb_build_object(
        'id', p.id, 'username', p.username, 'display_name', p.display_name,
        'avatar_url', p.avatar_url, 'bio', p.bio, 'role', p.role,
        'created_at', p.created_at, 'rank', public.my_badge_rank(p.id),
        'email', u.email, 'last_sign_in_at', u.last_sign_in_at,
        'banned_until', p.banned_until, 'ban_reason', p.ban_reason,
        'muted_until', p.muted_until, 'mute_reason', p.mute_reason,
        'mon_count', (select count(*) from public.published_mons m where m.user_id = p.id),
        'post_count', (select count(*) from public.community_posts cp where cp.user_id = p.id),
        'event_count', (select count(*) from public.events e where e.owner_id = p.id),
        'comment_count', (select count(*) from public.mon_comments c where c.user_id = p.id)
                       + (select count(*) from public.profile_comments c where c.user_id = p.id)
                       + (select count(*) from public.post_comments c where c.user_id = p.id)
                       + (select count(*) from public.event_comments c where c.user_id = p.id),
        'warnings', public.strike_count(p.id),
        'flags', (select count(*) from public.moderation_actions a where a.target_user_id = p.id and a.action = 'automod_flag')
    ) into out
    from public.profiles p left join auth.users u on u.id = p.id
    where p.id = p_user_id;
    return out;
end $$;

-- posts
create or replace function public.admin_recent_posts(p_limit integer default 100, p_search text default '', p_user uuid default null)
 returns table(id uuid, user_id uuid, author_name text, body text, created_at timestamptz, edited_at timestamptz,
               mon_count integer, event_count integer, repost_kind text, comment_count bigint, reaction_count bigint)
 language plpgsql stable security definer set search_path to 'public'
as $$
declare q text := coalesce(p_search, '');
begin
    perform public.mod_assert(null, 'staff');
    return query
    select p.id, p.user_id, coalesce(nullif(pr.display_name,''), pr.username, 'user'), p.body, p.created_at, p.edited_at,
           cardinality(p.mon_ids), cardinality(p.event_ids), p.repost_kind,
           (select count(*) from public.post_comments c where c.post_id = p.id),
           (select count(*) from public.post_reactions r where r.post_id = p.id)
      from public.community_posts p left join public.profiles pr on pr.id = p.user_id
     where (p_user is null or p.user_id = p_user)
       and (q = '' or p.body ilike '%' || q || '%' or pr.username ilike '%' || q || '%' or pr.display_name ilike '%' || q || '%')
     order by p.created_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 300));
end $$;

create or replace function public.admin_delete_post(p_post uuid, p_reason text default '')
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare owner uuid; snippet text;
begin
    select user_id, left(body, 300) into owner, snippet from public.community_posts where id = p_post;
    if owner is null then raise exception 'Post not found'; end if;
    perform public.mod_assert(owner, 'delete_content');
    delete from public.community_posts where id = p_post;
    perform public.mod_log(owner, 'delete_post', p_reason, jsonb_build_object('post_id', p_post, 'excerpt', snippet));
    insert into public.notifications(user_id, actor_id, actor_name, type, target_name, preview)
    select owner, auth.uid(), coalesce(nullif(display_name,''), username, 'A staff member'),
           'mod_post_deleted', 'your post', left(coalesce(p_reason, ''), 300)
      from public.profiles where id = auth.uid();
end $$;

-- events
create or replace function public.admin_list_events(p_search text default '', p_limit integer default 100)
 returns table(id uuid, slug text, title text, owner_id uuid, owner_name text, phase text, stage text, created_at timestamptz,
               entry_count bigint, comment_count bigint, announcement_count bigint)
 language plpgsql stable security definer set search_path to 'public'
as $$
declare q text := coalesce(p_search, '');
begin
    perform public.mod_assert(null, 'staff');
    return query
    select e.id, e.slug, e.title, e.owner_id, coalesce(nullif(pr.display_name,''), pr.username, 'user'), e.phase, public.event_phase(e), e.created_at,
           (select count(*) from public.event_entries x where x.event_id = e.id),
           (select count(*) from public.event_comments x where x.event_id = e.id),
           (select count(*) from public.event_announcements x where x.event_id = e.id)
      from public.events e left join public.profiles pr on pr.id = e.owner_id
     where q = '' or e.title ilike '%' || q || '%' or e.slug ilike '%' || q || '%' or pr.username ilike '%' || q || '%'
     order by e.created_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 300));
end $$;

-- an event's announcements and entries, for staff who aren't on its team
create or replace function public.admin_event_content(p_event uuid)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
begin
    perform public.mod_assert(null, 'staff');
    return jsonb_build_object(
        'announcements', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'body', left(a.body, 600), 'created_at', a.created_at,
                'posted_by', coalesce(a.posted_by, a.author_id), 'poster', (select coalesce(nullif(pr.display_name,''), pr.username) from public.profiles pr where pr.id = coalesce(a.posted_by, a.author_id)))
                order by a.created_at desc) from public.event_announcements a where a.event_id = p_event), '[]'::jsonb),
        'entries', coalesce((select jsonb_agg(jsonb_build_object('id', en.id, 'user_id', en.user_id, 'created_at', en.created_at, 'thumb', en.thumb,
                'author', (select coalesce(nullif(pr.display_name,''), pr.username) from public.profiles pr where pr.id = en.user_id),
                'title', coalesce((select v->>'name' from jsonb_each(en.answers) a(k, v) where jsonb_typeof(v) = 'object' and v ? 'name' limit 1),
                                  (select v #>> '{}' from jsonb_each(en.answers) a(k, v) where jsonb_typeof(v) = 'string' and v #>> '{}' !~ '^data:' limit 1), 'Entry'))
                order by en.created_at) from public.event_entries en where en.event_id = p_event), '[]'::jsonb));
end $$;

create or replace function public.admin_delete_event(p_event uuid, p_reason text default '')
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare ev public.events;
begin
    select * into ev from public.events where id = p_event;
    if not found then raise exception 'Event not found'; end if;
    perform public.mod_assert(ev.owner_id, 'delete_content');
    delete from public.events where id = p_event;
    perform public.mod_log(ev.owner_id, 'delete_event', p_reason, jsonb_build_object('event_id', p_event, 'title', ev.title));
    insert into public.notifications(user_id, actor_id, actor_name, type, target_name, preview)
    select ev.owner_id, auth.uid(), coalesce(nullif(display_name,''), username, 'A staff member'),
           'mod_event_deleted', left(ev.title, 120), left(coalesce(p_reason, ''), 300)
      from public.profiles where id = auth.uid();
end $$;

-- back to a draft: off the site for everyone but its team, nothing deleted
create or replace function public.admin_unpublish_event(p_event uuid, p_reason text default '')
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare ev public.events;
begin
    select * into ev from public.events where id = p_event;
    if not found then raise exception 'Event not found'; end if;
    perform public.mod_assert(ev.owner_id, 'delete_content');
    update public.events set phase = 'draft' where id = p_event;
    perform public.mod_log(ev.owner_id, 'unpublish_event', p_reason, jsonb_build_object('event_id', p_event, 'title', ev.title));
    insert into public.notifications(user_id, actor_id, actor_name, type, target_id, target_name, preview)
    select ev.owner_id, auth.uid(), coalesce(nullif(display_name,''), username, 'A staff member'),
           'mod_event_unpublished', 'event:' || coalesce(ev.slug, ev.id::text), left(ev.title, 120), left(coalesce(p_reason, ''), 300)
      from public.profiles where id = auth.uid();
end $$;

create or replace function public.admin_delete_event_announcement(p_id uuid, p_reason text default '')
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare a public.event_announcements; ev public.events;
begin
    select * into a from public.event_announcements where id = p_id;
    if not found then raise exception 'Announcement not found'; end if;
    select * into ev from public.events where id = a.event_id;
    perform public.mod_assert(coalesce(a.posted_by, a.author_id, ev.owner_id), 'delete_content');
    delete from public.event_announcements where id = p_id;
    perform public.mod_log(coalesce(a.posted_by, a.author_id, ev.owner_id), 'delete_announcement', p_reason,
        jsonb_build_object('event_id', a.event_id, 'event', ev.title, 'title', a.title));
end $$;

create or replace function public.admin_delete_event_entry(p_entry uuid, p_reason text default '')
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare en public.event_entries; ev public.events;
begin
    select * into en from public.event_entries where id = p_entry;
    if not found then raise exception 'Entry not found'; end if;
    select * into ev from public.events where id = en.event_id;
    if en.user_id is not null then perform public.mod_assert(en.user_id, 'delete_content');
    else perform public.mod_assert(null, 'delete_content');
    end if;
    delete from public.event_entries where id = p_entry;
    perform public.mod_log(en.user_id, 'delete_event_entry', p_reason, jsonb_build_object('event_id', en.event_id, 'event', ev.title, 'entry_id', p_entry));
    if en.user_id is not null then
        insert into public.notifications(user_id, actor_id, actor_name, type, target_id, target_name, preview)
        select en.user_id, auth.uid(), coalesce(nullif(display_name,''), username, 'A staff member'),
               'event_entry_removed', 'event:' || coalesce(ev.slug, ev.id::text), left(ev.title, 120), left(coalesce(p_reason, ''), 300)
          from public.profiles where id = auth.uid();
    end if;
end $$;

revoke execute on function public.admin_recent_comments(integer, text) from public, anon;
revoke execute on function public.admin_delete_comment(uuid, text, text) from public, anon;
revoke execute on function public.admin_user_comments(uuid, integer) from public, anon;
revoke execute on function public.admin_count_user_comments(uuid, integer, text) from public, anon;
revoke execute on function public.admin_purge_user_comments(uuid, integer, text, text) from public, anon;
revoke execute on function public.admin_user_overview(uuid) from public, anon;
revoke execute on function public.admin_recent_posts(integer, text, uuid) from public, anon;
revoke execute on function public.admin_delete_post(uuid, text) from public, anon;
revoke execute on function public.admin_list_events(text, integer) from public, anon;
revoke execute on function public.admin_event_content(uuid) from public, anon;
revoke execute on function public.admin_delete_event(uuid, text) from public, anon;
revoke execute on function public.admin_unpublish_event(uuid, text) from public, anon;
revoke execute on function public.admin_delete_event_announcement(uuid, text) from public, anon;
revoke execute on function public.admin_delete_event_entry(uuid, text) from public, anon;
grant execute on function public.admin_recent_comments(integer, text), public.admin_delete_comment(uuid, text, text),
    public.admin_user_comments(uuid, integer), public.admin_count_user_comments(uuid, integer, text),
    public.admin_purge_user_comments(uuid, integer, text, text), public.admin_user_overview(uuid),
    public.admin_recent_posts(integer, text, uuid), public.admin_delete_post(uuid, text),
    public.admin_list_events(text, integer), public.admin_event_content(uuid), public.admin_delete_event(uuid, text),
    public.admin_unpublish_event(uuid, text), public.admin_delete_event_announcement(uuid, text),
    public.admin_delete_event_entry(uuid, text) to authenticated;

-- ==================== 10. notifications only the database sends ====================
-- The client may insert some notification types itself (comments, follows,
-- reposts); the rest come from these functions alone. Every moderation notice
-- (mod_*) and the new reply notice are added to that list.

create or replace function public.guard_notification_insert()
 returns trigger language plpgsql set search_path to 'public'
as $$
declare
    staff_types constant text[] := array[
        'mon_deleted','contest_submission_deleted','event_entry_removed',
        'mention','event_announcement','event_edit_request','event_feedback','comment_reply'];
begin
    if current_user = 'postgres' then return new; end if;
    if new.type = any(staff_types) or new.type like 'mod\_%' then
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

-- ==================== 11. more names up to 30 characters ====================
-- Checked when a name is set or changed, so names already longer stay until
-- their owner edits them.

create or replace function public.guard_name_length()
 returns trigger language plpgsql set search_path to 'public'
as $$
declare
    col text := tg_argv[0];
    v text := to_jsonb(new)->>col;
begin
    if char_length(coalesce(v, '')) > 30
       and (tg_op = 'INSERT' or v is distinct from (to_jsonb(old)->>col)) then
        raise exception 'Names can be up to 30 characters.' using errcode = 'P0001';
    end if;
    return new;
end $$;
revoke execute on function public.guard_name_length() from public, anon, authenticated;
create trigger guard_name_length before insert or update of title on public.events
    for each row execute function public.guard_name_length('title');
create trigger guard_name_length before insert or update of display_name on public.profiles
    for each row execute function public.guard_name_length('display_name');
create trigger guard_name_length before insert or update of title on public.conversations
    for each row execute function public.guard_name_length('title');

-- ==================== 12. staff: profile text ====================
-- Reset a display name (they show as @username) or clear a bio, with a
-- notification and a line in the mod log.

create or replace function public.admin_reset_profile_text(p_user_id uuid, p_field text, p_reason text default '')
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare before text;
begin
    if p_field not in ('display_name', 'bio') then raise exception 'Unknown profile field'; end if;
    perform public.mod_assert(p_user_id, 'delete_content');
    if p_field = 'bio' then
        select bio into before from public.profiles where id = p_user_id;
        update public.profiles set bio = '' where id = p_user_id;
    else
        select display_name into before from public.profiles where id = p_user_id;
        update public.profiles set display_name = null where id = p_user_id;
    end if;
    if not found then raise exception 'User not found'; end if;
    perform public.mod_log(p_user_id, case when p_field = 'bio' then 'clear_bio' else 'reset_display_name' end, p_reason,
        jsonb_build_object('excerpt', left(coalesce(before, ''), 300)));
    insert into public.notifications(user_id, actor_id, actor_name, type, target_name, preview)
    select p_user_id, auth.uid(), coalesce(nullif(display_name,''), username, 'A staff member'),
           'mod_profile_edited', p_field, left(coalesce(p_reason, ''), 300)
      from public.profiles where id = auth.uid();
end $$;
revoke execute on function public.admin_reset_profile_text(uuid, text, text) from public, anon;
grant execute on function public.admin_reset_profile_text(uuid, text, text) to authenticated;

