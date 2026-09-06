-- ==================== server-side collection storage + publish caps ====================
-- Three ceilings the server is now responsible for: (1) public.collections
-- becomes a real, bounded cloud save slot -- it existed but had no DELETE
-- policy or size limit; (2) the publish cooldown was enforceable but
-- forgeable (see note below); (3) no lifetime cap on how much one account
-- could publish.

-- ==================== 1. cloud save quota ====================
-- 100 items total across the four collections a user authors; folders are
-- excluded since they're names, not content.
--
-- Byte cap is what actually protects the server: artwork/cries are base64
-- data URLs, so item count alone doesn't bound row size. Count is checked
-- first since it's the more common, more explicable case.
create or replace function public.enforce_collection_quota()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
    max_items constant integer := 100;
    max_bytes constant bigint  := 5 * 1024 * 1024;
    n_items integer;
    n_bytes bigint;
begin
    new.updated_at := now();

    -- jsonb_array_length errors on a non-array, which is correct: reject rather than silently count as zero
    n_items := jsonb_array_length(new.fakemon_db)
             + jsonb_array_length(new.custom_moves)
             + jsonb_array_length(new.custom_abilities)
             + jsonb_array_length(new.custom_items);

    if n_items > max_items then
        raise exception 'Cloud backup holds at most % items (Fakemon, moves, abilities and items combined). This backup has %.',
            max_items, n_items using errcode = 'P0001';
    end if;

    n_bytes := octet_length(new.fakemon_db::text)
             + octet_length(new.folders::text)
             + octet_length(new.custom_moves::text)
             + octet_length(new.custom_abilities::text)
             + octet_length(new.custom_items::text);

    if n_bytes > max_bytes then
        raise exception 'Cloud backup is % MB, over the % MB limit. Artwork and cries are most of that size.',
            round(n_bytes / 1048576.0, 1), max_bytes / 1048576 using errcode = 'P0001';
    end if;

    return new;
end;
$fn$;

drop trigger if exists trg_enforce_collection_quota on public.collections;
create trigger trg_enforce_collection_quota
    before insert or update on public.collections
    for each row execute function public.enforce_collection_quota();

-- Without a DELETE policy RLS denied it, so "remove my cloud backup" had no server-side answer.
drop policy if exists "Users can delete own collection" on public.collections;
create policy "Users can delete own collection" on public.collections
    for delete using ((select auth.uid()) = user_id);

comment on table public.collections is
    'One optional cloud backup slot per user, separate from the community hub. Bounded by enforce_collection_quota(): 100 items across fakemon_db/custom_moves/custom_abilities/custom_items, and 5 MB of jsonb.';

-- ==================== 2 + 3. publish cooldown and lifetime cap ====================
-- The cooldown trigger only checked published_at on rows already stored, never
-- the one being inserted -- and that column is client-insertable via
-- PostgREST, so a forged past timestamp bypassed the cooldown entirely.
-- Pinning published_at to now() here closes it. (UPDATE path was already safe
-- via guard_published_mon_update().)
--
-- Lifetime cap is new: counts current rows, so deleting a listing frees the
-- slot back up. No staff exemption.
create or replace function public.published_mons_enforce_cooldown()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
    max_published constant integer := 20;
    n integer;
begin
    new.published_at := now();

    if exists (
        select 1
        from public.published_mons
        where user_id = new.user_id
          and published_at > now() - interval '1 hour'
          and (new.family_id is null or family_id is distinct from new.family_id)
    ) then
        raise exception 'You can only publish once per hour.' using errcode = '42501';
    end if;

    select count(*) into n from public.published_mons where user_id = new.user_id;
    if n >= max_published then
        raise exception 'You have reached the limit of % community uploads. Delete one of your listings to publish something new.',
            max_published using errcode = '42501';
    end if;

    return new;
end;
$fn$;
