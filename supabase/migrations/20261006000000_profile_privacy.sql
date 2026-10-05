-- Profile privacy: the whole profile, or parts of it, for everyone, followers
-- only, or only you. Stored as {"profile": .., "details": .., "posts": ..,
-- "fakemon": .., "follows": ..}, each 'everyone' | 'followers' | 'only_me';
-- a missing key is 'everyone'. "profile" caps every part.
--
-- Enforced here for what travels through RPCs (the timeline, follower lists).
-- ponytail: bio/pronouns/location/website are still plain profiles columns any
-- signed-in user can select; the page hides them, but locking them down needs
-- column-level grants on profiles (and a select('*') in auth.ts reworked).

alter table public.profiles add column if not exists privacy jsonb not null default '{}'::jsonb;

create or replace function public.profile_part_visible(p_owner uuid, p_part text)
returns boolean language sql stable security definer set search_path = public as $$
    with lv as (
        select array[coalesce(pr.privacy->>'profile', 'everyone'), coalesce(pr.privacy->>p_part, 'everyone')] as l
        from public.profiles pr where pr.id = p_owner
    )
    select auth.uid() = p_owner
        or public.is_staff(auth.uid())
        or coalesce((select case
                when 'only_me' = any(l) then false
                when 'followers' = any(l) then exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.followee_id = p_owner)
                else true end from lv), true);
$$;
grant execute on function public.profile_part_visible(uuid, text) to authenticated;

create or replace function public.profile_follow_list(p_user uuid, p_which text, p_limit integer default 100)
returns table(id uuid, username text, display_name text, avatar_url text, display_badges text[], bio text, followed_at timestamp with time zone)
language sql stable set search_path = public as $$
    select pr.id, pr.username, pr.display_name, pr.avatar_url, pr.display_badges, left(pr.bio, 140), f.created_at
    from public.follows f
    join public.profiles pr on pr.id = case when p_which = 'following' then f.followee_id else f.follower_id end
    where (case when p_which = 'following' then f.follower_id else f.followee_id end) = p_user
      and auth.uid() is not null
      and public.profile_part_visible(p_user, 'follows')
    order by f.created_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

do $$
declare def text;
begin
    -- profile_timeline is long; add the check to its final filter rather than restating it
    select pg_get_functiondef('public.profile_timeline(uuid, timestamptz, integer)'::regprocedure) into def;
    if position('profile_part_visible' in def) = 0 then
        def := replace(def, E'where auth.uid() is not null\n    order by at desc',
                            E'where auth.uid() is not null and public.profile_part_visible(p_user, ''posts'')\n    order by at desc');
        if position('profile_part_visible' in def) = 0 then raise exception 'profile_timeline: filter not found'; end if;
        execute def;
    end if;
end $$;
