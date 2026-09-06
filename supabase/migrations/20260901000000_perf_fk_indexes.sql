-- ============================================================================
-- Performance pass, part 1 of 3: foreign key indexes.
--
-- Fifteen foreign keys had no covering index. mon_comments.mon_id is the hot
-- one (community hub filters by it on every load); the rest guard against
-- unindexed-FK scans on account deletion (DELETE on the parent table scans
-- the child). Row counts are small today, so these pay off as the tables grow
-- rather than right away.
--
-- Parts 2 and 3: 20260901000001_perf_stats_and_thumbnail_rpcs.sql
--                20260901000002_perf_rls_initplan.sql
-- ============================================================================

-- 1. Foreign key indexes
-- ============================================================================

create index if not exists mon_comments_mon_id_idx on public.mon_comments (mon_id);
create index if not exists mon_comments_user_id_idx on public.mon_comments (user_id);

create index if not exists published_mons_user_id_idx on public.published_mons (user_id);
create index if not exists profile_comments_user_id_idx on public.profile_comments (user_id);
create index if not exists profile_badges_badge_key_idx on public.profile_badges (badge_key);
create index if not exists profile_badges_granted_by_idx on public.profile_badges (granted_by);
create index if not exists notifications_actor_id_idx on public.notifications (actor_id);
create index if not exists moderation_actions_actor_id_idx on public.moderation_actions (actor_id);
create index if not exists banned_terms_created_by_idx on public.banned_terms (created_by);
create index if not exists battle_challenges_battle_id_idx on public.battle_challenges (battle_id);
create index if not exists battle_signals_sender_id_idx on public.battle_signals (sender_id);
create index if not exists battles_winner_id_idx on public.battles (winner_id);
create index if not exists contest_events_created_by_idx on public.contest_events (created_by);
create index if not exists contests_created_by_idx on public.contests (created_by);
create index if not exists contest_vote_sessions_voter_id_idx on public.contest_vote_sessions (voter_id);

-- feed's ORDER BY: without this, every hub load sorts the whole table
create index if not exists published_mons_activity_at_idx
    on public.published_mons (activity_at desc);

-- publish cooldown check (newest row for one author)
create index if not exists published_mons_user_published_idx
    on public.published_mons (user_id, published_at desc);

-- unused, and every insert into published_mons paid to maintain it
drop index if exists public.idx_published_mons_family_id;
