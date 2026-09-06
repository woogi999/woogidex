-- ============================================================================
-- Artwork stops travelling as a readable image.
--
-- Published artwork is a base64 data: URI inside fakemon_data, and every query
-- that wanted a picture selected that column as text. js/core/art-shield.js
-- then painted it into a <canvas> so the element panel and the right-click
-- menu had nothing to offer -- but the JSON the image arrived in was still
-- sitting in the network panel, where "data:image/png;base64,..." can be
-- copied straight into an address bar. That was the last casual route in.
--
-- These functions hand out the same bytes AES-encrypted, so a response body is
-- opaque where anyone looks at it. The key travels with the payload, because
-- it has to: the browser is the thing that must decrypt it. So this is
-- obfuscation of exactly the kind the canvas already was -- it closes the
-- network panel the way the canvas closed "save image as", and it is not a
-- claim that a determined scraper cannot get the pixels. Nothing client-side
-- can make that claim.
--
-- All SECURITY INVOKER: RLS on published_mons still decides who sees what, and
-- none of these grant any authority the caller did not already have.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- One image in, one masked envelope out.
--
-- VOLATILE, not STABLE: gen_random_bytes() means every call answers
-- differently, and a cached plan reusing one key/IV pair across rows is
-- exactly what we do not want.
-- ----------------------------------------------------------------------------
create or replace function public.mask_image_uri(p_uri text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
    comma int;
    k bytea;
    v bytea;
begin
    if p_uri is null or left(p_uri, 11) <> 'data:image/' then
        return null;
    end if;
    comma := position(',' in p_uri);
    if comma = 0 then
        return null;
    end if;

    k := extensions.gen_random_bytes(32);   -- AES-256
    v := extensions.gen_random_bytes(16);

    return jsonb_build_object(
        -- 'data:' is 5 characters, so the media type runs from 6 to the comma
        'mime', split_part(substring(p_uri from 6 for comma - 6), ';', 1),
        'key',  encode(k, 'base64'),
        'iv',   encode(v, 'base64'),
        -- aes-cbc with PKCS padding, which is what SubtleCrypto's AES-CBC
        -- expects on the other end
        -- encode() wraps base64 at 76 columns; the client joins these fields
        -- into one string, so the newlines would just be bytes on the wire
        'body', replace(encode(
            extensions.encrypt_iv(
                decode(substring(p_uri from comma + 1), 'base64'), k, v, 'aes-cbc/pad:pkcs'),
            'base64'), E'
', '')
    );
end $$;

comment on function public.mask_image_uri(text) is
    'Turns a data:image/ URI into an AES-CBC envelope {mime,key,iv,body} so it is not a readable image in a network response. Obfuscation, not secrecy: the key is in the envelope because the browser has to decrypt it.';

revoke all on function public.mask_image_uri(text) from public;
grant execute on function public.mask_image_uri(text) to anon, authenticated;


-- ----------------------------------------------------------------------------
-- Card artwork, masked, for a batch of posts.
--
-- Replaces `select id, fakemon_data->>artwork`. Defaults to the stored 160px
-- thumbnail and falls back to the full image, which is the same choice the
-- cards already made client-side -- it just gets made before anything is sent
-- now, so the feed query no longer carries a thumbnail of its own.
-- ----------------------------------------------------------------------------
create or replace function public.community_mon_artwork(p_ids uuid[], p_full boolean default false)
returns table (mon_id uuid, image jsonb, is_thumb boolean)
language sql
volatile
security invoker
set search_path = public
as $$
    select
        pm.id,
        public.mask_image_uri(
            case
                when p_full then nullif(pm.fakemon_data->>'artwork', '')
                else coalesce(
                    nullif(pm.fakemon_data->>'thumbnail', ''),
                    nullif(pm.fakemon_data->>'artwork', ''))
            end),
        -- lets the client tell "this post already has a small version" from
        -- "this is the full image because there was nothing smaller", without
        -- shipping the thumbnail itself in the feed just to find out
        not p_full and coalesce(pm.fakemon_data->>'thumbnail', '') <> ''
    from unnest(p_ids) as wanted(id)
    join public.published_mons pm on pm.id = wanted.id;
$$;

comment on function public.community_mon_artwork(uuid[], boolean) is
    'Masked card artwork for a batch of published mons. Prefers the stored thumbnail unless p_full; is_thumb says which one you got.';

revoke all on function public.community_mon_artwork(uuid[], boolean) from public;
grant execute on function public.community_mon_artwork(uuid[], boolean) to anon, authenticated;


-- ----------------------------------------------------------------------------
-- Every image on one post, masked: the mon itself and each family member,
-- normal and shiny. The detail view needs all of them because the stage/mega
-- chips swap the preview without another round trip, which is what
-- `select('*')` used to cover.
-- ----------------------------------------------------------------------------
create or replace function public.community_mon_images(p_id uuid)
returns table (source_id text, kind text, image jsonb)
language sql
volatile
security invoker
set search_path = public
as $$
    select img.source_id, img.kind, public.mask_image_uri(img.uri)
    from public.published_mons pm
    cross join lateral (
        -- '' as the source id means "the post's own mon", matching how
        -- family_full entries are keyed
        select ''::text as source_id, 'artwork'::text as kind, pm.fakemon_data->>'artwork' as uri
        union all
        select '', 'shinyArtwork', pm.fakemon_data->>'shinyArtwork'
        union all
        select e->>'sourceId', 'artwork', e->'mon'->>'artwork'
          from jsonb_array_elements(coalesce(pm.family_full, '[]'::jsonb)) e
        union all
        select e->>'sourceId', 'shinyArtwork', e->'mon'->>'shinyArtwork'
          from jsonb_array_elements(coalesce(pm.family_full, '[]'::jsonb)) e
    ) img
    where pm.id = p_id
      and img.uri is not null
      and img.uri <> '';
$$;

comment on function public.community_mon_images(uuid) is
    'Masked artwork for every mon on one post -- the face and each family member, normal and shiny.';

revoke all on function public.community_mon_images(uuid) from public;
grant execute on function public.community_mon_images(uuid) to anon, authenticated;


-- ----------------------------------------------------------------------------
-- The post itself, with every image key removed.
--
-- The detail view used `select('*')`, which is the single largest readable
-- image payload on the site: full artwork plus shinies for a whole evolution
-- family. This returns the same row shape with those keys stripped, so the
-- client can render everything except the pictures and then ask
-- community_mon_images() for those separately.
-- ----------------------------------------------------------------------------
create or replace function public.strip_image_keys(p jsonb)
returns jsonb
language sql
immutable
-- pure jsonb operators, so it needs nothing resolved by name
set search_path = ''
as $$
    select coalesce(p, '{}'::jsonb) - 'artwork' - 'shinyArtwork' - 'thumbnail';
$$;

comment on function public.strip_image_keys(jsonb) is
    'Drops the image keys from a fakemon_data blob. Used by community_mon_detail().';

create or replace function public.community_mon_detail(p_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
    select to_jsonb(pm) || jsonb_build_object(
        'fakemon_data', public.strip_image_keys(pm.fakemon_data),
        'family_full', (
            select coalesce(
                jsonb_agg(e || jsonb_build_object('mon', public.strip_image_keys(e->'mon'))),
                '[]'::jsonb)
            from jsonb_array_elements(coalesce(pm.family_full, '[]'::jsonb)) e)
    )
    from public.published_mons pm
    where pm.id = p_id;
$$;

comment on function public.community_mon_detail(uuid) is
    'One published mon in full, with every artwork/thumbnail key stripped out. Pair with community_mon_images() for the pictures.';

revoke all on function public.community_mon_detail(uuid) from public;
grant execute on function public.community_mon_detail(uuid) to anon, authenticated;
