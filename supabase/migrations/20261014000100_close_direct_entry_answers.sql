-- Apply AFTER the site that reads entries through event_entries_light() and
-- event_entry_full() has deployed (the 20261014000000 migration adds them).
--
-- Entry answers then come only through those two metered functions, so the
-- egress budgets in egress_budgets hold for everyone, not just the site: a
-- script can no longer download every entry's full artwork straight from the
-- table. The small thumbnail stays readable directly.

revoke select (answers) on public.event_entries from anon, authenticated;
