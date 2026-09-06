-- ============================================================================
-- The same treatment for avatars that masked_artwork_transport gave artwork.
--
-- Avatars were a different shape of problem: a file in a public storage bucket,
-- referenced by a plain public URL. The URL in a profile row IS the exposure --
-- every avatar was a real image request in the network panel, and the URL works
-- for anyone who has it whether they got it from the app or not.
--
-- So the bytes move into the row, small, and come out masked like artwork does.
-- avatar_url stays exactly where it is: anyone who has not re-saved their
-- profile since this shipped still has only the bucket copy, and the client
-- falls back to it. Once everyone has an avatar_data, the bucket can be made
-- private -- that part is a decision to take separately, because it breaks the
-- fallback for anyone who never came back.
-- ============================================================================

-- A downscaled 256px copy as a data: URI, written by the client on upload.
-- Capped well under what the bucket allows: this one is inline in every profile
-- read, so it has to stay small.
alter table public.profiles
    add column if not exists avatar_data text;

comment on column public.profiles.avatar_data is
    'Downscaled avatar as a data:image/ URI, served masked through profile_avatars(). Small on purpose - it is read inline. avatar_url is the pre-existing public-bucket fallback.';

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'profiles_avatar_data_small'
    ) then
        alter table public.profiles
            add constraint profiles_avatar_data_small
            check (avatar_data is null or (
                left(avatar_data, 11) = 'data:image/' and length(avatar_data) <= 262144));
    end if;
end $$;


-- ----------------------------------------------------------------------------
-- Masked avatars for a batch of people.
--
-- SECURITY INVOKER, so the existing profiles policies decide whose avatar the
-- caller may see -- same as reading the column directly would.
--
-- Deliberately does NOT return avatar_url: a caller that wants the fallback
-- already has it from the profile row it is rendering.
-- ----------------------------------------------------------------------------
create or replace function public.profile_avatars(p_ids uuid[])
returns table (user_id uuid, image jsonb)
language sql
volatile
security invoker
set search_path = public
as $$
    select pr.id, public.mask_image_uri(nullif(pr.avatar_data, ''))
    from unnest(p_ids) as wanted(id)
    join public.profiles pr on pr.id = wanted.id
    where coalesce(pr.avatar_data, '') <> '';
$$;

comment on function public.profile_avatars(uuid[]) is
    'Masked avatars for a batch of users. Rows are omitted for anyone with no avatar_data, so the caller falls back to avatar_url.';

revoke all on function public.profile_avatars(uuid[]) from public;
grant execute on function public.profile_avatars(uuid[]) to anon, authenticated;
