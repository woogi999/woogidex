-- Security pass, October 2026. Each fix closes something a signed-in user
-- could do straight through the API, around what the site's own UI allows.
--
--   1. Account age was forgeable. profiles.created_at is writable by its owner,
--      and "accounts must be a day old to vote" (event_voter_seasoned) read
--      it, so a fresh sock-puppet account could back-date itself and vote at
--      once. The age now comes from auth.users, and a profile's id, created_at
--      and username_history can't be rewritten by their owner (the last one
--      also reset the twice-a-week username limit).
--   2. Wall posts ignored "Posts & wall: followers / only me": anyone signed in
--      could read profile_comments directly. They now follow the profile's
--      privacy (the author and the profile's owner always see them).
--   3. Notifications the server sends on someone's behalf (mentions, event
--      announcements, edit requests) can't be forged by inserting them
--      directly, and operational ones (entry removed, edit requested) get
--      through a pause, like moderation notices.
--   4. is_blocked_between(a, b) and is_conversation_member(chat, user) are
--      callable over the API, so anyone could ask whether two strangers had
--      blocked each other, or whether someone was in a chat. Called directly,
--      they now only answer about yourself or a chat you're in; the policies
--      and functions that use them are unaffected.

-- ==================== 1. account age ====================

create or replace function public.event_voter_seasoned(p_user uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $$
    -- auth.users: profiles.created_at is the owner's to write
    select exists (select 1 from auth.users u where u.id = p_user and u.created_at < now() - interval '24 hours');
$$;
revoke execute on function public.event_voter_seasoned(uuid) from public, anon, authenticated;

-- runs before trg_enforce_username_rate_limit (triggers fire in name order),
-- so that one always appends to the real history
create or replace function public.guard_profile_identity()
 returns trigger language plpgsql set search_path to 'public'
as $$
begin
    if current_user = 'postgres' or current_setting('woogidex.moderation_ctx', true) = 'on' then return new; end if;
    if tg_op = 'UPDATE' then
        new.id := old.id;
        new.created_at := old.created_at;
        new.username_history := old.username_history;
    else
        new.created_at := now();
        new.username_history := '{}';
    end if;
    return new;
end;
$$;
drop trigger if exists guard_profile_identity on public.profiles;
create trigger guard_profile_identity before insert or update on public.profiles
    for each row execute function public.guard_profile_identity();
revoke execute on function public.guard_profile_identity() from public, anon, authenticated;

-- ==================== 2. wall posts follow the profile's privacy ====================

drop policy if exists "Signed-in users can read profile comments" on public.profile_comments;
drop policy if exists "Wall posts follow the profile's privacy" on public.profile_comments;
create policy "Wall posts follow the profile's privacy" on public.profile_comments for select to authenticated
    using (user_id = (select auth.uid()) or profile_id = (select auth.uid()) or public.profile_part_visible(profile_id, 'posts'));

-- ==================== 3. notifications only the server sends ====================

create or replace function public.guard_notification_insert()
 returns trigger language plpgsql set search_path to 'public'
as $$
declare
    staff_types constant text[] := array[
        'mod_warning','mod_muted','mod_banned','mod_comment_deleted',
        'mon_deleted','contest_submission_deleted','event_entry_removed',
        -- sent by the database itself (mentions, event announcements, edit requests)
        'mention','event_announcement','event_edit_request'];
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
    -- what happened to your own account or entry always gets through
    if new.type like 'mod\_%' or new.type in ('mon_deleted', 'contest_submission_deleted', 'event_entry_removed', 'event_edit_request') then
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

-- ==================== 4. relationship lookups ====================

create or replace function public.is_blocked_between(a uuid, b uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $$
    select exists (select 1 from public.user_blocks
                   where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a))
       -- only about yourself: every caller (follows, messages, group chats,
       -- notifications, mentions) passes the signed-in person as a or b;
       -- no session at all is the server's own jobs
       and (auth.uid() is null or auth.uid() in (a, b));
$$;

create or replace function public.is_conversation_member(p_conversation uuid, p_user uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $$
    select exists (select 1 from public.conversation_members where conversation_id = p_conversation and user_id = p_user)
       -- someone else's membership: only for people in that chat themselves
       and (p_user = auth.uid() or auth.uid() is null
            or exists (select 1 from public.conversation_members where conversation_id = p_conversation and user_id = auth.uid()));
$$;
