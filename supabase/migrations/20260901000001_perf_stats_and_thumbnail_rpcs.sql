-- ============================================================================
-- Performance pass, part 2 of 3: two helper functions.
--
-- Both SECURITY INVOKER, so neither grants any authority the caller did not
-- already have through RLS.
-- ============================================================================

-- 3. Counting without downloading
--
-- Previously the hub counted likes/comments by fetching every row for the
-- posts on screen and counting client-side, so transfer scaled with total
-- engagement rather than post count. This returns three integers and a
-- boolean per post, including "did I like this" (why it's a function, not a
-- view -- that part is caller-dependent).
--
-- SECURITY INVOKER deliberately: counts must respect the same RLS the client
-- already sees.
-- ============================================================================

create or replace function public.community_mon_stats(p_ids uuid[])
returns table (mon_id uuid, like_count bigint, comment_count bigint, liked_by_me boolean)
language sql
stable
security invoker
set search_path = public
as $$
    select
        m.id as mon_id,
        (select count(*) from public.mon_likes l where l.mon_id = m.id) as like_count,
        (select count(*) from public.mon_comments c where c.mon_id = m.id) as comment_count,
        exists (
            select 1 from public.mon_likes l
            where l.mon_id = m.id and l.user_id = (select auth.uid())
        ) as liked_by_me
    from unnest(p_ids) as m(id);
$$;

comment on function public.community_mon_stats(uuid[]) is
    'Like/comment counts plus the caller''s own like state for a batch of published mons. Replaces downloading every like and comment row to count them client-side.';

revoke all on function public.community_mon_stats(uuid[]) from public;
grant execute on function public.community_mon_stats(uuid[]) to anon, authenticated;


-- ============================================================================
-- 4. Thumbnail backfill
--
-- Cards render from fakemon_data->>'thumbnail' (~2 kB), falling back to the
-- full artwork (~280 kB) when missing. Thumbnails were added after launch, so
-- older posts lack one and pay full artwork cost for a 160px card.
--
-- Postgres can't resize images, so the thumbnail is generated client-side;
-- this lets the client write back just that key without a full read-modify-
-- write of the artwork field.
--
-- SECURITY INVOKER: caller must already be allowed to UPDATE this row via the
-- existing published_mons policy; adds no new authority.
-- ============================================================================

create or replace function public.set_mon_thumbnail(p_id uuid, p_thumb text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
    updated int;
begin
    if p_thumb is null or p_thumb = '' or left(p_thumb, 11) <> 'data:image/' then
        raise exception 'A thumbnail must be a data:image/ URI';
    end if;
    -- small enough to block smuggling full artwork back in under this key
    if length(p_thumb) > 65536 then
        raise exception 'Thumbnail too large (% bytes)', length(p_thumb);
    end if;

    -- only fills a gap; never overwrites an existing thumbnail
    update public.published_mons
       set fakemon_data = jsonb_set(fakemon_data, '{thumbnail}', to_jsonb(p_thumb), true)
     where id = p_id
       and coalesce(fakemon_data->>'thumbnail', '') = '';
    get diagnostics updated = row_count;
    return updated > 0;
end $$;

comment on function public.set_mon_thumbnail(uuid, text) is
    'Fills in a missing card thumbnail for one published mon. Security invoker, so the existing update policy decides who may call it; refuses to overwrite an existing thumbnail.';

revoke all on function public.set_mon_thumbnail(uuid, text) from public;
grant execute on function public.set_mon_thumbnail(uuid, text) to authenticated;
