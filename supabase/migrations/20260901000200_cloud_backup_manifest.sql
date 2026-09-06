-- ==================== cloud backup manifest ====================
-- Lets the collection grid show a "backed up" badge per card without reading
-- collections.* (up to 5 MB of base64 artwork) just to draw a 14px icon.
-- PostgREST can't project a field out of each jsonb array element, so the
-- projection needs to be a real column.
--
-- Maintained by the same trigger that enforces the quota, not client-writable,
-- so it can't drift or be forged.
alter table public.collections
    add column if not exists manifest jsonb not null default '[]'::jsonb;

comment on column public.collections.manifest is
    'Derived, server-maintained: [{id, u}] for each Fakemon in fakemon_db, where u is its updatedAt. Lets the collection grid show backup badges without downloading the backup. Never write this from a client -- enforce_collection_quota() overwrites it.';

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

    -- derived here only, discarding whatever the client sent; coalesce guards against a null manifest for older clients lacking updatedAt
    select coalesce(jsonb_agg(jsonb_build_object('id', entry->>'id', 'u', coalesce(entry->>'updatedAt', ''))), '[]'::jsonb)
      into new.manifest
      from jsonb_array_elements(new.fakemon_db) as entry
     where entry->>'id' is not null;

    return new;
end;
$fn$;

-- backfill pre-existing rows by re-running the trigger; the self-assignment is a no-op write that just fires it
update public.collections set user_id = user_id;
