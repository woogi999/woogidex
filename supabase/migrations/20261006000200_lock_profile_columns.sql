-- Apply AFTER the client from the same commit is live: older clients read
-- these columns directly (select('*'), bio in the profile query) and break.
--
-- bio/pronouns/location/website follow the privacy setting; moderation reasons
-- are for the person and staff only. Column grants are the only way to hide a
-- column from a row everyone may read, so `profiles` is readable column by
-- column now. The hidden ones come through profile_details() (privacy-checked),
-- my_standing() and the staff RPCs, all security definer.
-- NB: column grants break INSERT .. ON CONFLICT DO UPDATE on those columns;
-- the client saves them with a plain UPDATE (saveProfileDetails).
revoke select on public.profiles from anon, authenticated;
grant select (id, username, username_history, created_at, updated_at, role, display_name, avatar_url,
              display_badges, banned_until, muted_until, deletion_requested_at, avatar_data,
              banner_url, banner_color, accent_color, dm_privacy, privacy)
    on public.profiles to authenticated;

