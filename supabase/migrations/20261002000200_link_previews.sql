-- ==================== link previews ====================
-- When a link to the site is pasted into Discord, iMessage, X and so on, their
-- bots fetch the page without signing in. worker/index.js answers those
-- fetches for /community/<id>, /post/<id> and /profile/<name> with the
-- page's own title, description and picture, read through this function.
--
-- It is callable without signing in (that's the point), so it returns only
-- what a preview card shows: names, a short description, counts. Nothing
-- private, and never a full-size image.

create or replace function public.link_preview(p_kind text, p_key text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
    out jsonb;
    target uuid;
begin
    if p_kind = 'mon' then
        begin target := p_key::uuid; exception when others then return null; end;
        select jsonb_build_object(
            'title', coalesce(nullif(pm.fakemon_data->>'name', ''), 'A Fakemon'),
            'species', coalesce(pm.fakemon_data->>'species', ''),
            'types', array_remove(array[nullif(pm.fakemon_data->>'type1', ''), nullif(pm.fakemon_data->>'type2', '')], null),
            'description', left(coalesce(nullif(pm.fakemon_data->>'dexEntry1', ''), ''), 220),
            'author', coalesce(nullif(pr.display_name, ''), pr.username, pm.author_name, 'someone'),
            'username', pr.username,
            'family', jsonb_array_length(coalesce(pm.family_snapshots, '[]'::jsonb)),
            'has_image', coalesce(pm.fakemon_data->>'thumbnail', '') <> '')
          into out
          from public.published_mons pm left join public.profiles pr on pr.id = pm.user_id
         where pm.id = target;
    elsif p_kind = 'post' then
        begin target := p_key::uuid; exception when others then return null; end;
        select jsonb_build_object(
            'title', 'Post by ' || coalesce(nullif(pr.display_name, ''), pr.username, 'someone'),
            'description', left(regexp_replace(cp.body, '\s+', ' ', 'g'), 220),
            'author', coalesce(nullif(pr.display_name, ''), pr.username, 'someone'),
            'username', pr.username,
            'mons', (select coalesce(jsonb_agg(pm.fakemon_data->>'name'), '[]'::jsonb)
                       from public.published_mons pm where pm.id = any(cp.mon_ids)),
            'first_mon', (select pm.id from public.published_mons pm
                           where pm.id = any(cp.mon_ids) and coalesce(pm.fakemon_data->>'thumbnail', '') <> ''
                           order by array_position(cp.mon_ids, pm.id) limit 1))
          into out
          from public.community_posts cp join public.profiles pr on pr.id = cp.user_id
         where cp.id = target;
    elsif p_kind = 'profile' then
        select jsonb_build_object(
            'title', coalesce(nullif(pr.display_name, ''), pr.username),
            'username', pr.username,
            'description', left(coalesce(pr.bio, ''), 220),
            'avatar_url', nullif(pr.avatar_url, ''),
            'banner_url', nullif(pr.banner_url, ''),
            'followers', (select count(*) from public.follows f where f.followee_id = pr.id),
            'mons', (select count(*) from public.published_mons pm where pm.user_id = pr.id))
          into out
          from public.profiles pr
         where lower(pr.username) = lower(p_key)
           and (pr.banned_until is null or pr.banned_until < now());
    end if;
    return out;
end $$;

-- The small card picture (the ~160px thumbnail every published Fakemon
-- already has for the hub's cards). The full artwork is never served here.
create or replace function public.link_preview_thumb(p_id uuid)
returns text language sql stable security definer set search_path = public as $$
    select nullif(fakemon_data->>'thumbnail', '') from public.published_mons where id = p_id;
$$;

grant execute on function public.link_preview(text, text) to anon, authenticated;
grant execute on function public.link_preview_thumb(uuid) to anon, authenticated;
