-- Three things:
--   1. event_list_stats: reactions and comment counts for the events list's tickets
--   2. "open" Fakemon: a published Fakemon its author chose to share freely
--      (no art shield, anyone can export it, readable signed out)
--   3. what search engines and the sitemap read (worker/index.js)

-- ==================== 1. the events list's tickets ====================
-- Run as the caller (not security definer), so event_comments' and
-- event_reactions' own RLS decide what counts: nothing for an event the
-- caller can't see.
create or replace function public.event_list_stats(p_ids uuid[])
 returns table(event_id uuid, reactions jsonb, comments integer)
 language sql stable set search_path to 'public'
as $$
    select ids.id,
        coalesce((select jsonb_object_agg(r.emoji, r.n) from (
                    select emoji, count(*)::int as n from public.event_reactions where event_reactions.event_id = ids.id group by emoji) r), '{}'::jsonb),
        (select count(*)::int from public.event_comments c where c.event_id = ids.id)
    from unnest((coalesce(p_ids, '{}'::uuid[]))[1:200]) as ids(id);
$$;
revoke execute on function public.event_list_stats(uuid[]) from public, anon;
grant execute on function public.event_list_stats(uuid[]) to authenticated;

-- ==================== 2. open Fakemon ====================
-- Off by default: a published Fakemon is for signed-in members, its artwork
-- shielded and masked, and only its author can export it. Turning it on is
-- the author's choice, made when publishing or later from the post.
--
-- Signed out, nothing about published_mons opens up: there is still no anon
-- policy on the table. The only way in is open_mon_detail(), which hands out
-- exactly one row, by id, and only when that row is open. There is no way to
-- list open Fakemon signed out except the sitemap, which carries ids and
-- dates, nothing else.
alter table public.published_mons add column if not exists is_open boolean not null default false;
create index if not exists published_mons_open_idx on public.published_mons(id) where is_open;
-- published_mons is granted column by column: without these the new column
-- couldn't be set, and community_mon_detail's to_jsonb(pm) (a whole-row read)
-- would be refused for everyone
grant select (is_open) on public.published_mons to anon, authenticated;
grant insert (is_open), update (is_open) on public.published_mons to authenticated;

-- Only the author opens or closes their Fakemon. Staff may edit any row (to
-- moderate), but sharing someone's artwork freely is not theirs to decide.
create or replace function public.guard_published_mon_update()
 returns trigger language plpgsql set search_path to 'public'
as $$
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'UPDATE' then
        -- ownership and feed position are not editable by the author
        new.id           := old.id;
        new.user_id      := old.user_id;
        new.published_at := old.published_at;
        new.view_count   := old.view_count;
        new.family_id    := old.family_id;
        new.activity_at  := least(coalesce(new.activity_at, old.activity_at), now());
        if old.user_id is distinct from auth.uid() then
            new.is_open := old.is_open;
        end if;
    else
        new.view_count  := 0;
        new.activity_at := now();
    end if;

    -- who posted it comes from their profile, never from the row they sent
    select coalesce(p.role, 'user'),
           coalesce(p.display_badges, '{}'),
           coalesce(nullif(p.display_name, ''), p.username, 'Someone'),
           nullif(p.avatar_url, '')
      into new.author_role, new.author_badges, new.author_name, new.author_avatar_url
      from public.profiles p
     where p.id = new.user_id;

    return new;
end;
$$;

-- an open Fakemon, whole: its data, its family, its artwork as ordinary images
-- (open means no shield). The author shows by public profile fields only.
create or replace function public.open_mon_detail(p_id uuid)
 returns jsonb language sql stable security definer set search_path to 'public'
as $$
    select jsonb_build_object(
        'id', pm.id,
        'user_id', pm.user_id,
        'author_name', coalesce(nullif(pr.display_name, ''), pr.username, pm.author_name),
        'author_username', pr.username,
        'author_avatar_url', pr.avatar_url,
        'author_role', pm.author_role,
        'author_badges', pm.author_badges,
        'source_fakemon_id', pm.source_fakemon_id,
        'fakemon_data', pm.fakemon_data,
        'family_id', pm.family_id,
        'family_members', pm.family_members,
        'family_snapshots', pm.family_snapshots,
        'family_full', pm.family_full,
        'evolution_stage', pm.evolution_stage,
        'published_at', pm.published_at,
        'activity_at', pm.activity_at,
        'view_count', pm.view_count,
        'is_open', true)
    from public.published_mons pm
    left join public.profiles pr on pr.id = pm.user_id
    where pm.id = p_id and pm.is_open
      and (pr.banned_until is null or pr.banned_until < now());
$$;
revoke execute on function public.open_mon_detail(uuid) from public;
grant execute on function public.open_mon_detail(uuid) to anon, authenticated;

-- the detail the signed-in hub reads carries the flag too (it's a column of
-- the row, so to_jsonb(pm) already includes it once this migration is in)

-- ==================== 3. search engines ====================
-- What a page about a Fakemon says to a search engine or a pasted link:
-- link_preview() plus the fields worth a snippet (stats, abilities, the
-- second dex entry) and whether it's open. Never artwork.
create or replace function public.seo_mon(p_id uuid)
 returns jsonb language sql stable security definer set search_path to 'public'
as $$
    select jsonb_build_object(
        'id', pm.id,
        'name', coalesce(nullif(pm.fakemon_data->>'name', ''), 'A Fakemon'),
        'species', coalesce(pm.fakemon_data->>'species', ''),
        'types', array_remove(array[nullif(pm.fakemon_data->>'type1', ''), nullif(pm.fakemon_data->>'type2', '')], null),
        'dex1', left(coalesce(pm.fakemon_data->>'dexEntry1', ''), 400),
        'dex2', left(coalesce(pm.fakemon_data->>'dexEntry2', ''), 400),
        'abilities', (select coalesce(jsonb_agg(a->>'name'), '[]'::jsonb)
                        from jsonb_array_elements(case when jsonb_typeof(pm.fakemon_data->'abilities') = 'array' then pm.fakemon_data->'abilities' else '[]'::jsonb end) a
                       where coalesce(a->>'name', '') <> ''),
        'stats', case when jsonb_typeof(pm.fakemon_data->'stats') = 'object' then pm.fakemon_data->'stats' else null end,
        'author', coalesce(nullif(pr.display_name, ''), pr.username, pm.author_name, 'someone'),
        'username', pr.username,
        'family', jsonb_array_length(coalesce(pm.family_snapshots, '[]'::jsonb)),
        'has_image', coalesce(pm.fakemon_data->>'thumbnail', '') <> '',
        'is_open', pm.is_open,
        'published_at', pm.published_at,
        'updated_at', greatest(pm.published_at, pm.activity_at))
    from public.published_mons pm
    left join public.profiles pr on pr.id = pm.user_id
    where pm.id = p_id
      and (pr.banned_until is null or pr.banned_until < now());
$$;
revoke execute on function public.seo_mon(uuid) from public;
grant execute on function public.seo_mon(uuid) to anon, authenticated;

-- The sitemap: addresses and dates only. Fakemon and published events.
-- (Not profiles: they read only signed in, so they're marked noindex.)
create or replace function public.sitemap_entries()
 returns table(kind text, key text, updated_at timestamptz)
 language sql stable security definer set search_path to 'public'
as $$
    (select 'mon', pm.id::text, greatest(pm.published_at, pm.activity_at)
       from public.published_mons pm
       left join public.profiles pr on pr.id = pm.user_id
      where pr.banned_until is null or pr.banned_until < now()
      order by greatest(pm.published_at, pm.activity_at) desc limit 20000)
    union all
    (select 'event', coalesce(e.slug, e.id::text), coalesce(e.updated_at, e.created_at)
       from public.events e
      where e.phase <> 'draft' and coalesce(e.public_access, true)
      limit 5000);
$$;
revoke execute on function public.sitemap_entries() from public;
grant execute on function public.sitemap_entries() to anon, authenticated;

-- An event's link preview, plus its address and dates (search engines read
-- them as an Event: when it starts, when it ends, where: online, here)
create or replace function public.link_preview_event(p_key text)
 returns jsonb language sql stable security definer set search_path to 'public'
as $$
    select jsonb_build_object(
        'title', e.title,
        'tagline', e.tagline,
        'description', left(regexp_replace(regexp_replace(e.description, '[#*_~`>|\[\]()]+', ' ', 'g'), '\s+', ' ', 'g'), 220),
        'category', e.category,
        'stage', public.event_phase(e),
        'organizer', coalesce(nullif(pr.display_name, ''), pr.username, 'someone'),
        'has_cover', coalesce(e.cover_image, '') <> '',
        'id', e.id,
        'slug', e.slug,
        'starts_at', coalesce(e.submissions_open_at, e.created_at),
        'ends_at', coalesce(e.results_at, e.voting_close_at, e.submissions_close_at),
        'updated_at', coalesce(e.updated_at, e.created_at))
    from public.events e left join public.profiles pr on pr.id = e.owner_id
    where e.phase <> 'draft' and (e.slug = lower(p_key) or e.id::text = lower(p_key))
    limit 1;
$$;
