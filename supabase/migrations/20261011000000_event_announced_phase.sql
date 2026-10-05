-- 'announced': out of draft and visible to everyone, but not taking entries
-- yet. Entries open on submissions_open_at, or when the organizer opens them
-- by hand; with no date it waits for them.

alter table public.events drop constraint if exists events_phase_check;
alter table public.events add constraint events_phase_check check (phase in ('draft', 'announced', 'open', 'voting', 'ended'));

create or replace function public.event_phase(e public.events)
 returns text language sql stable set search_path to 'public'
as $$
    select case
        when e.phase in ('draft', 'ended') then e.phase
        when e.phase = 'announced' and (e.submissions_open_at is null or now() < e.submissions_open_at) then 'upcoming'
        when e.voting <> 'none' and e.voting_close_at is not null and now() > e.voting_close_at then
            case when e.results_at is not null and now() < e.results_at then 'tallying' else 'ended' end
        when e.voting <> 'none' and (e.phase = 'voting' or (e.voting_open_at is not null and now() >= e.voting_open_at)) then
            case when e.voting_open_at is not null and now() < e.voting_open_at then 'closed' else 'voting' end
        when e.submissions_open_at is not null and now() < e.submissions_open_at then 'upcoming'
        when e.phase = 'voting' then 'closed'
        when e.submissions_close_at is not null and now() > e.submissions_close_at then
            case when e.voting <> 'none' then (case when e.voting_open_at is null then 'voting' else 'closed' end)
                 when e.results_at is not null and now() >= e.results_at then 'ended'
                 else 'closed' end
        else 'open'
    end;
$$;
