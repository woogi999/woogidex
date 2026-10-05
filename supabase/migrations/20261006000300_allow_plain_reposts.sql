-- A plain repost has no words and no Fakémon of its own, only what it points
-- at. The original "a post says something" check predates reposts and refused
-- every one ("violates check constraint community_posts_check").
alter table public.community_posts drop constraint if exists community_posts_check;
alter table public.community_posts add constraint community_posts_check
    check (char_length(btrim(body)) > 0 or cardinality(mon_ids) > 0 or repost_id is not null);
