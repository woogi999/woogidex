-- ==================== cloud backup ceiling: 100 -> 60 ====================
-- Only the number changes; function body restated because CREATE OR REPLACE
-- has no way to patch one constant.
--
-- Existing backups over the new ceiling are left alone: BEFORE INSERT OR
-- UPDATE means a stored row over the limit keeps working and stays
-- restorable, and the limit only bites on the next write.
create or replace function public.enforce_collection_quota()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
    max_items constant integer := 60;
    max_bytes constant bigint  := 5 * 1024 * 1024;
    n_items integer;
    n_bytes bigint;
begin
    new.updated_at := now();

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

    select coalesce(jsonb_agg(jsonb_build_object('id', entry->>'id', 'u', coalesce(entry->>'updatedAt', ''))), '[]'::jsonb)
      into new.manifest
      from jsonb_array_elements(new.fakemon_db) as entry
     where entry->>'id' is not null;

    return new;
end;
$fn$;

comment on table public.collections is
    'One optional cloud backup slot per user, separate from the community hub. Bounded by enforce_collection_quota(): 60 items across fakemon_db/custom_moves/custom_abilities/custom_items, and 5 MB of jsonb.';
