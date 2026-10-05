-- Three event additions:
--   * allow_self_vote: the organizer can let people vote on their own entries
--     (off by default, as before).
--   * remove_event_entry: the team removes an entry with an optional reason,
--     which reaches the entrant as a notification.
--   * link_preview for events, so a pasted event link shows its name, pitch
--     and cover (worker/index.js).

alter table public.events add column if not exists allow_self_vote boolean not null default false;

create or replace function public.cast_event_vote(p_entry uuid, p_score integer, p_scores jsonb default null, p_remarks text default '', p_answers jsonb default null)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare
    uid uuid := auth.uid();
    ev public.events;
    en public.event_entries;
    total integer;
    clean jsonb := '{}'::jsonb;
begin
    if uid is null then raise exception 'Sign in to vote.'; end if;
    -- flipping a vote back and forth in a loop is a write each time
    if not public.rate_limit_hit('event-vote:' || uid, 600, interval '1 hour') then
        raise exception 'You are voting too quickly. Try again in a while.';
    end if;
    select * into en from public.event_entries where id = p_entry;
    if not found then raise exception 'That entry no longer exists.'; end if;
    select * into ev from public.events where id = en.event_id;
    if public.event_phase(ev) <> 'voting' then raise exception 'Voting is not open.'; end if;
    if ev.voting = 'ballot' then raise exception 'This event takes a full ballot. Rate every entry, then submit.'; end if;
    if p_score is null and p_scores is null then
        delete from public.event_votes where entry_id = p_entry and voter_id = uid;
        return;
    end if;
    if ev.voting = 'none' then raise exception 'This event has no voting.'; end if;
    if en.user_id = uid and not ev.allow_self_vote then raise exception 'You cannot vote for your own entry.'; end if;
    if ev.voting = 'judges' then
        if not public.event_can(ev.id, 'judge') then raise exception 'Only this event''s judges can score entries.'; end if;
        total := public.event_criteria_total(ev, p_scores);
        if total is null then raise exception 'Score every criterion.'; end if;
        if not public.event_remarks_ok(ev, p_remarks) then raise exception 'Remarks are required for this event.'; end if;
        clean := public.event_clean_answers(ev.vote_form, p_answers);
    else
        if exists (select 1 from public.profiles p where p.id = uid
                   and p.banned_until is not null and p.banned_until > now()) then
            raise exception 'Your account cannot vote right now.';
        end if;
        if p_score is distinct from 1 then raise exception 'Invalid vote.'; end if;
        if not public.event_voter_seasoned(uid) then raise exception 'New accounts can vote once they are a day old.'; end if;
        total := 1;
        p_scores := null;
        p_remarks := '';
        perform pg_advisory_xact_lock(hashtext(uid::text || ev.id::text));
        if not exists (select 1 from public.event_votes where entry_id = p_entry and voter_id = uid)
           and (select count(*) from public.event_votes where event_id = ev.id and voter_id = uid) >= ev.votes_per_user then
            raise exception 'You have used all % of your votes.', ev.votes_per_user;
        end if;
    end if;
    insert into public.event_votes(entry_id, voter_id, event_id, score, scores, remarks, answers)
        values (p_entry, uid, ev.id, total, p_scores, coalesce(p_remarks, ''), clean)
        on conflict (entry_id, voter_id) do update set score = excluded.score, scores = excluded.scores, remarks = excluded.remarks,
            answers = excluded.answers, created_at = now();
end;
$$;

create or replace function public.submit_event_ballot(p_event uuid, p_votes jsonb)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare
    uid uuid := auth.uid();
    ev public.events;
    eligible integer;
    x jsonb;
begin
    if uid is null then raise exception 'Sign in to vote.'; end if;
    if exists (select 1 from public.profiles p where p.id = uid and p.banned_until is not null and p.banned_until > now()) then
        raise exception 'Your account cannot vote right now.';
    end if;
    if not public.event_voter_seasoned(uid) then raise exception 'New accounts can vote once they are a day old.'; end if;
    select * into ev from public.events where id = p_event;
    if not found or ev.voting <> 'ballot' then raise exception 'This event does not take ballots.'; end if;
    if public.event_phase(ev) <> 'voting' then raise exception 'Voting is not open.'; end if;
    if exists (select 1 from public.event_ballots b where b.event_id = p_event and b.voter_id = uid) then
        raise exception 'You have already submitted your ballot.';
    end if;
    if jsonb_typeof(p_votes) <> 'array' then raise exception 'A ballot is a list of responses.'; end if;
    select count(*) into eligible from public.event_entries e where e.event_id = p_event and (ev.allow_self_vote or e.user_id is distinct from uid);
    if eligible = 0 then raise exception 'There is nothing to vote on.'; end if;
    if jsonb_array_length(p_votes) <> eligible
       or (select count(distinct x->>'entry_id') from jsonb_array_elements(p_votes) x) <> eligible then
        raise exception 'Rate every entry before submitting your ballot.';
    end if;
    for x in select * from jsonb_array_elements(p_votes) loop
        if not exists (select 1 from public.event_entries e where e.id::text = x->>'entry_id' and e.event_id = p_event and (ev.allow_self_vote or e.user_id is distinct from uid))
           or public.event_criteria_total(ev, x->'scores') is null then
            raise exception 'Every response needs a score for each criterion.';
        end if;
        if not public.event_remarks_ok(ev, x->>'remarks') then
            raise exception 'Every response needs remarks for this event.';
        end if;
        perform public.event_clean_answers(ev.vote_form, x->'answers');
    end loop;
    insert into public.event_ballots(event_id, voter_id) values (p_event, uid);
    insert into public.event_votes(entry_id, voter_id, event_id, score, scores, remarks, answers)
        select (x->>'entry_id')::uuid, uid, p_event, public.event_criteria_total(ev, x->'scores'), x->'scores', coalesce(x->>'remarks', ''),
               public.event_clean_answers(ev.vote_form, x->'answers')
        from jsonb_array_elements(p_votes) x;
end;
$$;

-- The team removes an entry; its entrant hears why (when there's a reason).
create or replace function public.remove_event_entry(p_entry uuid, p_reason text default '')
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare
    uid uuid := auth.uid();
    en public.event_entries;
    ev public.events;
    me public.profiles;
    reason text := left(btrim(coalesce(p_reason, '')), 300);
begin
    if uid is null then raise exception 'Sign in first.'; end if;
    select * into en from public.event_entries where id = p_entry;
    if not found then raise exception 'That entry no longer exists.'; end if;
    if not public.event_can(en.event_id, 'entries') then raise exception 'You do not have permission to remove entries.'; end if;
    select * into ev from public.events where id = en.event_id;
    delete from public.event_entries where id = p_entry;
    -- guests have no account to tell, and removing your own needs no notice
    if en.user_id is not null and en.user_id <> uid then
        select * into me from public.profiles where id = uid;
        insert into public.notifications(user_id, actor_id, actor_name, actor_avatar_url, type, target_id, target_name, preview)
        values (en.user_id, uid, coalesce(nullif(me.display_name, ''), me.username, 'An organizer'), nullif(me.avatar_url, ''),
                'event_entry_removed', 'event:' || coalesce(ev.slug, ev.id::text), left(ev.title, 120), nullif(reason, ''));
    end if;
end;
$$;
revoke execute on function public.remove_event_entry(uuid, text) from public, anon;
grant execute on function public.remove_event_entry(uuid, text) to authenticated;

-- only staff tools (and functions like the one above) may send it
create or replace function public.guard_notification_insert()
 returns trigger language plpgsql set search_path to 'public'
as $function$
declare
    staff_types constant text[] := array[
        'mod_warning','mod_muted','mod_banned','mod_comment_deleted',
        'mon_deleted','contest_submission_deleted','event_entry_removed'];
begin
    if current_user = 'postgres' then return new; end if;

    if new.type = any(staff_types) then
        raise exception 'That notification type can only be sent by staff tools';
    end if;

    if auth.uid() is not null and not public.notify_rate_ok(new.user_id) then
        raise exception 'You are sending notifications too quickly. Please slow down.';
    end if;

    select coalesce(nullif(display_name, ''), username, 'Someone')
      into new.actor_name from public.profiles where id = auth.uid();
    new.actor_avatar_url := (select nullif(avatar_url, '') from public.profiles where id = auth.uid());
    new.preview := left(new.preview, 300);
    new.target_name := left(new.target_name, 120);
    if auth.uid() is not null and public.is_blocked_between(auth.uid(), new.user_id) then
        return null;
    end if;
    return new;
end;
$function$;

-- link previews: an event (by id or link) that's out of draft
create or replace function public.link_preview_event(p_key text)
 returns jsonb language sql stable security definer set search_path = public
as $$
    select jsonb_build_object(
        'title', e.title,
        'tagline', e.tagline,
        'description', left(regexp_replace(regexp_replace(e.description, '[#*_~`>|\[\]()]+', ' ', 'g'), '\s+', ' ', 'g'), 220),
        'category', e.category,
        'stage', public.event_phase(e),
        'organizer', coalesce(nullif(pr.display_name, ''), pr.username, 'someone'),
        'has_cover', coalesce(e.cover_image, '') <> '',
        'id', e.id)
    from public.events e left join public.profiles pr on pr.id = e.owner_id
    where e.phase <> 'draft' and (e.slug = lower(p_key) or e.id::text = lower(p_key))
    limit 1;
$$;
create or replace function public.link_preview_event_cover(p_id uuid)
 returns text language sql stable security definer set search_path = public
as $$
    select nullif(cover_image, '') from public.events where id = p_id and phase <> 'draft';
$$;
grant execute on function public.link_preview_event(text), public.link_preview_event_cover(uuid) to anon, authenticated;
