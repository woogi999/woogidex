-- ==================== deleting your own account ====================
-- Self-service account deletion with a 7-day grace period: signing back in
-- during the window undoes it, which guards against both a misclick and
-- someone else using an unlocked session.
--
--   request_account_deletion()   stamps profiles.deletion_requested_at
--   cancel_account_deletion()    clears it, any time in the following 7 days
--   purge_expired_account_deletions()  destroys whatever is past due
--
-- Deletion is a single `delete from auth.users`; every user-data table already
-- cascades from there (verified against pg_constraint). Two constraints did
-- NOT cascade and are dealt with below.

-- ---- 1. the column ---------------------------------------------------------

alter table public.profiles
    add column if not exists deletion_requested_at timestamptz;

comment on column public.profiles.deletion_requested_at is
    'When the owner asked for this account to be deleted. The account is purged 7 days later, and clearing this column cancels it. Only writable through request_account_deletion() / cancel_account_deletion().';

-- Partial index keeps the sweep (runs on ordinary page loads) an index probe
-- instead of a sequential scan; the column is null for nearly all rows.
create index if not exists profiles_pending_deletion_idx
    on public.profiles (deletion_requested_at)
    where deletion_requested_at is not null;

-- ---- 2. the two constraints that would have blocked the delete -------------

-- profile_badges.granted_by had no ON DELETE action, so a moderator who ever
-- granted a badge couldn't be deleted (FK violation). Match the ON DELETE SET
-- NULL used by the schema's other "who did this" references.
alter table public.profile_badges
    drop constraint if exists profile_badges_granted_by_fkey;
alter table public.profile_badges
    add constraint profile_badges_granted_by_fkey
    foreign key (granted_by) references auth.users(id) on delete set null;

-- moderation_actions already SET NULLs actor_id/target_user_id (history
-- survives, anonymized); nothing to change here.

-- ---- 3. the column is not client-writable ----------------------------------

-- profiles' own-profile update policy would otherwise let a user write this
-- timestamp themselves, backdating it to bypass the grace period entirely.
--
-- Extends the same guard trigger and `current_user = 'postgres'` check already
-- used for banned_until / muted_until (20260828000100), rewritten whole rather
-- than added alongside since two BEFORE UPDATE triggers on one table have no
-- defined order.
--
-- SECURITY INVOKER is load-bearing: a definer function owned by postgres would
-- make `current_user = 'postgres'` true for every caller, silently disabling
-- this and the moderation guard.
create or replace function public.guard_profile_moderation_columns()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
    privileged boolean := current_user = 'postgres'
                       or current_setting('woogidex.moderation_ctx', true) = 'on';
    held text[];
    top_role text;
begin
    if not privileged then
        if new.banned_until is distinct from old.banned_until
           or new.ban_reason  is distinct from old.ban_reason
           or new.muted_until is distinct from old.muted_until
           or new.mute_reason is distinct from old.mute_reason then
            raise exception 'Moderation status can only be changed by staff tools';
        end if;
        if new.deletion_requested_at is distinct from old.deletion_requested_at then
            raise exception 'Account deletion can only be scheduled or cancelled through request_account_deletion() / cancel_account_deletion()';
        end if;
    end if;

    -- role is derived, never declared: highest-ranked badge actually held
    select b.key into top_role
      from public.profile_badges pb
      join public.badges b on b.key = pb.badge_key
     where pb.user_id = new.id
     order by b.rank desc
     limit 1;
    new.role := coalesce(top_role, 'user');

    -- display_badges may only contain badges this account really holds
    select coalesce(array_agg(pb.badge_key), '{}') into held
      from public.profile_badges pb where pb.user_id = new.id;
    new.display_badges := coalesce(
        array(select unnest(coalesce(new.display_badges, '{}')) intersect select unnest(held)),
        '{}');

    return new;
end;
$fn$;

-- ---- 4. the calls the client makes -----------------------------------------

-- Single source of truth for the grace period, read by both scheduler and sweep.
create or replace function public.account_deletion_grace()
returns interval
language sql
immutable
as $$ select interval '7 days' $$;

-- Idempotent: asking twice doesn't push the date back or shorten it.
create or replace function public.request_account_deletion()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
    uid uuid := auth.uid();
    scheduled timestamptz;
begin
    if uid is null then
        raise exception 'You must be signed in to delete your account.';
    end if;
    update public.profiles
       set deletion_requested_at = coalesce(deletion_requested_at, now())
     where id = uid
    returning deletion_requested_at + public.account_deletion_grace()
      into scheduled;
    if scheduled is null then
        raise exception 'No profile found for this account.';
    end if;
    return scheduled;
end;
$$;

-- Returns true if there was something to cancel, so the UI can tell
-- "cancelled" apart from "nothing pending".
create or replace function public.cancel_account_deletion()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    uid uuid := auth.uid();
    was timestamptz;
begin
    if uid is null then
        raise exception 'You must be signed in.';
    end if;
    -- read old value first since RETURNING would give the new (null) one; FOR UPDATE avoids a double-report race
    select deletion_requested_at into was
      from public.profiles where id = uid for update;
    update public.profiles set deletion_requested_at = null where id = uid;
    return was is not null;
end;
$$;

-- No read function needed: the client already fetches its own profiles row on
-- boot, and profiles is SELECTable by any signed-in user anyway.

-- ---- 5. the sweep ----------------------------------------------------------

-- No pg_cron on this project, so this is called from the client on boot
-- instead (js/features/auth.js), by whoever loads the site next. Callable by
-- anyone and takes no arguments: it can only destroy accounts already past
-- their own grace period, with no way to target someone else.
--
-- Avatars are removed first: they live in a public bucket keyed by user id and
-- nothing cascades storage, so deleting auth.users alone would orphan a
-- publicly readable image.
create or replace function public.purge_expired_account_deletions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    doomed uuid[];
begin
    select coalesce(array_agg(id), '{}') into doomed
      from public.profiles
     where deletion_requested_at is not null
       and deletion_requested_at + public.account_deletion_grace() <= now();

    if array_length(doomed, 1) is null then
        return 0;
    end if;

    delete from storage.objects
     where bucket_id = 'avatars'
       and owner = any(doomed);

    delete from auth.users where id = any(doomed);

    return array_length(doomed, 1);
end;
$$;

-- ---- 6. grants -------------------------------------------------------------

revoke execute on function public.request_account_deletion()       from public, anon;
revoke execute on function public.cancel_account_deletion()        from public, anon;
revoke execute on function public.account_deletion_grace()         from public, anon;

grant execute on function public.request_account_deletion()  to authenticated;
grant execute on function public.cancel_account_deletion()   to authenticated;
grant execute on function public.account_deletion_grace()    to authenticated;

-- Sweep stays open to signed-out visitors deliberately: an expired account
-- shouldn't have to wait for a signed-in person to trigger the purge.
grant execute on function public.purge_expired_account_deletions() to anon, authenticated;
