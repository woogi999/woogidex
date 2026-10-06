-- A post that is only a poll. The poll goes in right after its post
-- (js/features/social.ts createPost, then polls.ts createPoll), so when the
-- post row is written there's no poll yet for community_posts_check to see,
-- and a post with no text, Fakemon, events or repost was refused ("new row for
-- relation community_posts violates check constraint community_posts_check").
-- has_poll says one is on its way; the app sets it only for poll-only posts,
-- and takes the post back down if its poll can't be added.

alter table public.community_posts add column if not exists has_poll boolean not null default false;

alter table public.community_posts drop constraint if exists community_posts_check;
alter table public.community_posts add constraint community_posts_check
    check (char_length(btrim(body)) > 0 or cardinality(mon_ids) > 0 or cardinality(event_ids) > 0
           or repost_id is not null or has_poll);
