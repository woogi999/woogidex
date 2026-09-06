-- ============================================================================
-- Performance pass, part 3 of 3: RLS init plans.
--
-- `auth.uid() = user_id` re-executes auth.uid() (parses the JWT) once per row;
-- `(select auth.uid()) = user_id` becomes an InitPlan Postgres evaluates once
-- per statement. Same permissions, same rows, cost stops scaling with table
-- size. Flagged by Supabase's `auth_rls_initplan` linter. Helper calls like
-- is_staff(auth.uid()) get the same treatment.
--
-- ALTER POLICY, not DROP + CREATE, so each policy keeps its name/roles/command
-- and no table is ever left unguarded.
--
-- Every expression below is generated from pg_policies -- the same expression
-- already in place, with auth.uid() and staff helpers hoisted into scalar
-- subqueries. Nothing here grants or revokes access; a mismatch would be a bug
-- in this file, not an intended policy change.
--
-- Rollback: perf_backup.rls_before_20260901 holds all policies as they stood before this ran.
-- ============================================================================

alter policy "Signed-in users can read badge definitions" on public.badges
    using (((select auth.uid()) IS NOT NULL));
alter policy "staff read banned terms" on public.banned_terms
    using ((select is_moderator((select auth.uid()))));
alter policy battle_challenges_involved_read on public.battle_challenges
    using ((((select auth.uid()) = from_id) OR ((select auth.uid()) = to_id)));
alter policy battle_challenges_involved_update on public.battle_challenges
    using ((((select auth.uid()) = from_id) OR ((select auth.uid()) = to_id)))
    with check ((((select auth.uid()) = from_id) OR ((select auth.uid()) = to_id)));
alter policy battle_challenges_send on public.battle_challenges
    with check (((select auth.uid()) = from_id));
alter policy battle_presence_read on public.battle_presence
    using (((select auth.uid()) IS NOT NULL));
alter policy battle_presence_self_write on public.battle_presence
    using (((select auth.uid()) = user_id))
    with check (((select auth.uid()) = user_id));
alter policy battle_signals_participants on public.battle_signals
    using ((EXISTS ( SELECT 1
   FROM battles b
  WHERE ((b.id = battle_signals.battle_id) AND (((select auth.uid()) = b.p1_id) OR ((select auth.uid()) = b.p2_id))))));
alter policy battle_signals_send on public.battle_signals
    with check (((sender_id = (select auth.uid())) AND (EXISTS ( SELECT 1
   FROM battles b
  WHERE ((b.id = battle_signals.battle_id) AND (((select auth.uid()) = b.p1_id) OR ((select auth.uid()) = b.p2_id)))))));
alter policy battles_participant_update on public.battles
    using ((((select auth.uid()) = p1_id) OR ((select auth.uid()) = p2_id)))
    with check ((((select auth.uid()) = p1_id) OR ((select auth.uid()) = p2_id)));
alter policy battles_read on public.battles
    using (((status = 'finished'::text) OR (((select auth.uid()) = p1_id) OR ((select auth.uid()) = p2_id))));
alter policy "Users can insert own collection" on public.collections
    with check (((select auth.uid()) = user_id));
alter policy "Users can read own collection" on public.collections
    using (((select auth.uid()) = user_id));
alter policy "Users can update own collection" on public.collections
    using (((select auth.uid()) = user_id));
alter policy contest_events_staff_delete on public.contest_events
    using ((select is_staff()));
alter policy contest_events_staff_insert on public.contest_events
    with check (((select is_staff()) AND (created_by = (select auth.uid()))));
alter policy contest_events_staff_update on public.contest_events
    using ((select is_staff()))
    with check ((select is_staff()));
alter policy "Signed-in users can read contest submissions" on public.contest_submissions
    using (((select auth.uid()) IS NOT NULL));
alter policy contest_submissions_delete on public.contest_submissions
    using (((select is_staff()) OR (((select auth.uid()) = user_id) AND (EXISTS ( SELECT 1
   FROM contests c
  WHERE ((c.id = contest_submissions.contest_id) AND (c.phase = 'submission'::text)))))));
alter policy contest_submissions_insert on public.contest_submissions
    with check ((((select auth.uid()) = user_id) AND (EXISTS ( SELECT 1
   FROM contests c
  WHERE ((c.id = contest_submissions.contest_id) AND (c.phase = 'submission'::text) AND ((c.submission_deadline IS NULL) OR (now() <= c.submission_deadline)) AND (( SELECT count(*) AS count
           FROM contest_submissions s2
          WHERE ((s2.contest_id = c.id) AND (s2.user_id = (select auth.uid())))) < c.max_submissions_per_user))))));
alter policy contest_submissions_update on public.contest_submissions
    using (((select is_staff()) OR (((select auth.uid()) = user_id) AND (EXISTS ( SELECT 1
   FROM contests c
  WHERE ((c.id = contest_submissions.contest_id) AND (c.phase = 'submission'::text)))))))
    with check (((select is_staff()) OR (((select auth.uid()) = user_id) AND (EXISTS ( SELECT 1
   FROM contests c
  WHERE ((c.id = contest_submissions.contest_id) AND (c.phase = 'submission'::text)))))));
alter policy contest_vote_sessions_insert on public.contest_vote_sessions
    with check ((voter_id = (select auth.uid())));
alter policy contest_vote_sessions_staff_read on public.contest_vote_sessions
    using (((select is_staff()) OR (voter_id = (select auth.uid()))));
alter policy contest_votes_delete on public.contest_votes
    using (((voter_id = (select auth.uid())) OR (select is_staff())));
alter policy contest_votes_insert on public.contest_votes
    with check (((voter_id = (select auth.uid())) AND (EXISTS ( SELECT 1
   FROM contests c
  WHERE ((c.id = contest_votes.contest_id) AND (c.phase = 'voting'::text) AND ((c.voting_start IS NULL) OR (now() >= c.voting_start)) AND ((c.voting_deadline IS NULL) OR (now() <= c.voting_deadline))))) AND (EXISTS ( SELECT 1
   FROM contest_submissions s
  WHERE ((s.id = contest_votes.submission_id) AND (s.contest_id = contest_votes.contest_id) AND (s.user_id <> (select auth.uid())))))));
alter policy contest_votes_staff_read on public.contest_votes
    using (((select is_staff()) OR (voter_id = (select auth.uid()))));
alter policy contest_votes_update on public.contest_votes
    using (((voter_id = (select auth.uid())) AND (EXISTS ( SELECT 1
   FROM contests c
  WHERE ((c.id = contest_votes.contest_id) AND (c.phase = 'voting'::text))))))
    with check ((voter_id = (select auth.uid())));
alter policy contests_staff_delete on public.contests
    using ((select is_staff()));
alter policy contests_staff_insert on public.contests
    with check (((select is_staff()) AND (created_by = (select auth.uid()))));
alter policy contests_staff_update on public.contests
    using ((select is_staff()))
    with check ((select is_staff()));
alter policy "staff read moderation log" on public.moderation_actions
    using ((select has_perm((select auth.uid()), 'view_log'::text)));
alter policy "Owners and staff can delete comments" on public.mon_comments
    using ((((select auth.uid()) = user_id) OR (select is_staff((select auth.uid())))));
alter policy "Signed-in users can read comments" on public.mon_comments
    using (((select auth.uid()) IS NOT NULL));
alter policy "Users can post their own comments" on public.mon_comments
    with check (((select auth.uid()) = user_id));
alter policy "Signed-in users can read likes" on public.mon_likes
    using (((select auth.uid()) IS NOT NULL));
alter policy "Users can like community mons" on public.mon_likes
    with check (((select auth.uid()) = user_id));
alter policy "Users can unlike community mons" on public.mon_likes
    using (((select auth.uid()) = user_id));
alter policy "Insert notifications for others" on public.notifications
    with check ((((select auth.uid()) = actor_id) AND (actor_id <> user_id)));
alter policy "Read own notifications" on public.notifications
    using (((select auth.uid()) = user_id));
alter policy "Update own notifications" on public.notifications
    using (((select auth.uid()) = user_id));
alter policy "Badge managers can grant badges" on public.profile_badges
    with check ((select has_perm((select auth.uid()), 'manage_badges'::text)));
alter policy "Badge managers can revoke badges" on public.profile_badges
    using ((select has_perm((select auth.uid()), 'manage_badges'::text)));
alter policy "Signed-in users can read profile badges" on public.profile_badges
    using (((select auth.uid()) IS NOT NULL));
alter policy "Owners and staff can delete profile comments" on public.profile_comments
    using ((((select auth.uid()) = user_id) OR (select has_perm((select auth.uid()), 'delete_content'::text))));
alter policy "Signed-in users can read profile comments" on public.profile_comments
    using (((select auth.uid()) IS NOT NULL));
alter policy "Users can create profile comments" on public.profile_comments
    with check (((select auth.uid()) = user_id));
alter policy "signed in users can comment on profiles" on public.profile_comments
    with check (((select auth.uid()) = user_id));
alter policy "Signed-in users can read profiles" on public.profiles
    using (((select auth.uid()) IS NOT NULL));
alter policy "Users can insert their own profile" on public.profiles
    with check (((select auth.uid()) = id));
alter policy "Users can update their own profile" on public.profiles
    using (((select auth.uid()) = id))
    with check (((select auth.uid()) = id));
alter policy "Owners and staff can delete published mons" on public.published_mons
    using ((((select auth.uid()) = user_id) OR (select is_staff((select auth.uid())))));
alter policy "Owners and staff can update published mons" on public.published_mons
    using ((((select auth.uid()) = user_id) OR (select is_staff((select auth.uid())))))
    with check ((((select auth.uid()) = user_id) OR (select is_staff((select auth.uid())))));
alter policy "Signed-in users can read published mons" on public.published_mons
    using (((select auth.uid()) IS NOT NULL));
alter policy "Users can publish their own mons" on public.published_mons
    with check (((select auth.uid()) = user_id));
