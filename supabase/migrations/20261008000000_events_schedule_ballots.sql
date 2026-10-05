-- Events, round two:
--   * a schedule: entries open/close, voting opens/closes, results come out,
--     and the event moves through its stages on its own (event_phase());
--   * the Fakemon-contest scoring is back as an option: a full ballot where
--     every voter rates every entry on the organizer's criteria, with the
--     winner rules (top N, top %, at least X% of possible points). Judges
--     score on the same criteria. Organizers shape the voting form: the
--     criteria, each one's scale and description, and whether remarks are
--     off, optional or required;
--   * organizers can give specific people more entries than the default;
--   * a Fakemon answer keeps the whole Fakemon (stats, abilities, moves), so
--     it can be judged competitively. It lives only in the entry: it is not a
--     community upload and not a cloud save, so neither limit applies;
--   * public events: anyone with the link can see the event and enter it
--     without a Woogidex account, like a form. Guests can't vote, and their
--     entries only come in through the submit-event-guest edge function,
--     which checks a Turnstile challenge and rate limits by the client's
--     real (proxy-signed) address before calling submit_event_entry_guest;
--   * forms work like Google Forms: page breaks, checkboxes, dropdowns,
--     numbers, dates and linear scales, for entrants and (with their own
--     questions) for voters;
--   * a custom link: /events/<slug> instead of the generated id;
--   * a results post the team writes in markdown, published with the results;
--   * events can be reposted and shared in the feed like posts and Fakemon.

-- ==================== columns and tables ====================

alter table public.events
    add column submissions_open_at timestamptz,
    add column voting_open_at timestamptz,
    add column results_at timestamptz,
    add column criteria jsonb not null default '[{"name": "Competitive", "max": 10}, {"name": "Design", "max": 10}]'::jsonb,
    add column voter_remarks text not null default 'optional' check (voter_remarks in ('off', 'optional', 'required')),
    add column winner_criteria jsonb not null default '{"top_n": 3}'::jsonb,
    add column public_access boolean not null default false,
    -- extra questions voters answer about each entry, besides the scores
    add column vote_form jsonb not null default '[]'::jsonb,
    -- what of an entry the voting form shows: which answers (null: all), and who sent it.
    -- Display only: public answers stay readable through the API either way.
    add column vote_display jsonb not null default '{"fields": null, "author": true}'::jsonb,
    -- /events/<slug>: lowercase words and dashes; never id-shaped, never a route word
    add column slug text unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'
        and slug !~ '^[0-9a-f]{8}-[0-9a-f]{4}-' and slug not in ('new', 'dashboard'));
alter table public.events drop constraint events_voting_check;
alter table public.events add constraint events_voting_check check (voting in ('none', 'community', 'judges', 'ballot'));

-- guests (public events) enter without an account
alter table public.event_entries alter column user_id drop not null;
alter table public.event_entry_private alter column user_id drop not null;

alter table public.event_votes
    add column scores jsonb,
    add column answers jsonb not null default '{}'::jsonb,
    add column remarks text not null default '' check (char_length(remarks) <= 2000);
-- a criteria score is the sum of up to 8 criteria, up to 10 each
alter table public.event_votes drop constraint event_votes_score_check;
alter table public.event_votes add constraint event_votes_score_check check (score between 1 and 80);

-- one per voter per event, written with their whole ballot
create table public.event_ballots (
    event_id uuid not null references public.events(id) on delete cascade,
    voter_id uuid not null references auth.users(id) on delete cascade,
    submitted_at timestamptz not null default now(),
    primary key (event_id, voter_id)
);
create index event_ballots_voter_idx on public.event_ballots(voter_id);

create table public.event_entry_limits (
    event_id uuid not null references public.events(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    max_entries smallint not null check (max_entries between 1 and 100),
    primary key (event_id, user_id)
);
create index event_entry_limits_user_idx on public.event_entry_limits(user_id);

-- kept apart from events so the announcement can't be read before the results are out
create table public.event_results_posts (
    event_id uuid primary key references public.events(id) on delete cascade,
    body text not null default '' check (char_length(body) <= 10000),
    updated_by uuid references auth.users(id) on delete set null,
    updated_at timestamptz not null default now()
);

-- ==================== where an event is right now ====================
-- draft and ended are only ever set by the organizer. Otherwise the dates
-- decide, moving forward only:
--   upcoming  entries haven't opened yet
--   open      taking entries
--   closed    entries are closed, voting hasn't opened (or there is none)
--   voting    voting is open
--   tallying  voting is over, results come out at results_at
--   ended     results are out
-- The organizer's phase is a floor: setting 'voting' by hand skips the entry
-- window. js/features/events.ts effectivePhase() mirrors this.
create or replace function public.event_phase(e public.events)
 returns text language sql stable set search_path to 'public'
as $$
    select case
        when e.phase in ('draft', 'ended') then e.phase
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
grant execute on function public.event_phase(public.events) to anon, authenticated;

-- an event a signed-out visitor may see: a public one that isn't a draft
create or replace function public.event_readable(e public.events)
 returns boolean language sql stable set search_path to 'public'
as $$
    select e.phase <> 'draft' and (auth.uid() is not null or e.public_access);
$$;
grant execute on function public.event_readable(public.events) to anon, authenticated;

create or replace function public.event_entries_visible(p_event uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $$
    select exists (select 1 from public.events e where e.id = p_event and public.event_readable(e)
                   and (e.show_entries or public.event_phase(e) in ('closed', 'voting', 'tallying', 'ended')));
$$;

-- A form's shape: what the editor saves is checked here, never trusted.
-- p_types: the question types this form may use.
create or replace function public.event_form_check(p_form jsonb, p_types text[], p_what text)
 returns void language plpgsql immutable set search_path to 'public'
as $$
declare
    f jsonb;
    ids text[] := '{}';
begin
    if jsonb_typeof(p_form) <> 'array' or jsonb_array_length(p_form) > 50 then
        raise exception 'The % has at most 50 questions.', p_what;
    end if;
    for f in select * from jsonb_array_elements(p_form) loop
        if jsonb_typeof(f) <> 'object'
           or coalesce(f->>'id', '') !~ '^[a-z0-9_-]{1,24}$'
           or (f->>'id') = any(ids)
           or not (coalesce(f->>'type', '') = any(p_types))
           or char_length(coalesce(f->>'label', '')) not between 1 and 120
           or char_length(coalesce(f->>'help', '')) > 300
           or (f ? 'options' and (jsonb_typeof(f->'options') <> 'array' or jsonb_array_length(f->'options') > 20
                or exists (select 1 from jsonb_array_elements(f->'options') o where jsonb_typeof(o) <> 'string' or char_length(o #>> '{}') > 120)))
           or (f->>'type' in ('choice', 'dropdown', 'checkboxes') and jsonb_array_length(coalesce(f->'options', '[]'::jsonb)) < 2)
           or (f->>'type' = 'scale' and (jsonb_typeof(f->'max') <> 'number' or (f->>'max')::numeric not in (2, 3, 4, 5, 6, 7, 8, 9, 10)))
           or (f ? 'min' and jsonb_typeof(f->'min') not in ('number', 'null'))
           or (f->>'type' = 'number' and f ? 'max' and jsonb_typeof(f->'max') not in ('number', 'null')) then
            raise exception 'One of the % questions is not valid: %', p_what, coalesce(f->>'label', '(untitled)');
        end if;
        ids := ids || (f->>'id');
    end loop;
end;
$$;

-- Answers checked against their form: every answer the right shape for its
-- question, required ones present, anything the form doesn't ask dropped.
-- Returns the cleaned answers; raises with the question's label otherwise.
create or replace function public.event_clean_answers(p_form jsonb, p_answers jsonb)
 returns jsonb language plpgsql immutable set search_path to 'public'
as $$
declare
    f jsonb;
    v jsonb;
    s text;
    n numeric;
    out jsonb := '{}'::jsonb;
    required boolean;
begin
    if p_answers is null then p_answers := '{}'::jsonb; end if;
    if jsonb_typeof(p_answers) <> 'object' then raise exception 'Answers must be an object.'; end if;
    for f in select * from jsonb_array_elements(p_form) loop
        continue when f->>'type' = 'section';
        required := coalesce((f->>'required')::boolean, false);
        v := p_answers -> (f->>'id');
        if v is null or v in ('null'::jsonb, '""'::jsonb, 'false'::jsonb, '[]'::jsonb) then
            if required then raise exception 'Please answer: %', f->>'label'; end if;
            continue;
        end if;
        case f->>'type'
            when 'agree' then
                if v <> 'true'::jsonb then raise exception 'Please answer: %', f->>'label'; end if;
            when 'fakemon' then
                v := public.clean_event_fakemon(v);
                if v is null then raise exception 'That Fakémon could not be used for: % (it may be too large).', f->>'label'; end if;
            when 'checkboxes' then
                if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 20
                   or exists (select 1 from jsonb_array_elements(v) o where jsonb_typeof(o) <> 'string' or not (f->'options' ? (o #>> '{}')))
                   or (select count(distinct o) from jsonb_array_elements(v) o) <> jsonb_array_length(v) then
                    raise exception 'Invalid answer for: %', f->>'label';
                end if;
            when 'number' then
                begin
                    n := (v #>> '{}')::numeric;
                exception when others then
                    raise exception 'Please enter a number for: %', f->>'label';
                end;
                if abs(n) > 1e12 or (jsonb_typeof(f->'min') = 'number' and n < (f->>'min')::numeric)
                   or (jsonb_typeof(f->'max') = 'number' and n > (f->>'max')::numeric) then
                    raise exception 'That number is out of range for: %', f->>'label';
                end if;
                v := to_jsonb(n);
            when 'scale' then
                if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric)
                   or (v #>> '{}')::numeric not between 1 and (f->>'max')::numeric then
                    raise exception 'Invalid answer for: %', f->>'label';
                end if;
            when 'date' then
                s := v #>> '{}';
                if jsonb_typeof(v) <> 'string' or s !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid date for: %', f->>'label'; end if;
                begin
                    perform s::date;
                exception when others then
                    raise exception 'Invalid date for: %', f->>'label';
                end;
            else
                if jsonb_typeof(v) <> 'string' then raise exception 'Invalid answer for: %', f->>'label'; end if;
                s := btrim(v #>> '{}');
                if s = '' then
                    if required then raise exception 'Please answer: %', f->>'label'; end if;
                    continue;
                end if;
                if (f->>'type' = 'short' and char_length(s) > 200)
                   or (f->>'type' = 'long' and char_length(s) > 4000)
                   or (f->>'type' = 'url' and (char_length(s) > 500 or s !~* '^https?://[^\s]+$'))
                   or (f->>'type' = 'email' and (char_length(s) > 254 or s !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'))
                   or (f->>'type' = 'discord' and (char_length(s) > 40 or s !~ '^[A-Za-z0-9_.#]{2,40}$'))
                   or (f->>'type' in ('choice', 'dropdown') and not (coalesce(f->'options', '[]'::jsonb) ? s))
                   or (f->>'type' = 'image' and (char_length(s) > 1500000
                        or s !~ '^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$')) then
                    raise exception 'Invalid answer for: %', f->>'label';
                end if;
                v := to_jsonb(s);
        end case;
        out := out || jsonb_build_object(f->>'id', v);
    end loop;
    return out;
end;
$$;

-- the forms, voting form, winner rules and schedule join the shape check.
-- Not security definer: it runs as whoever saves, so everything it calls
-- (event_form_check) stays executable by signed-in users. It reads no data.
create or replace function public.events_guard()
 returns trigger language plpgsql set search_path to 'public'
as $$
declare
    f jsonb;
    names text[] := '{}';
    k text;
begin
    if tg_op = 'UPDATE' then
        new.owner_id := old.owner_id;
        new.created_at := old.created_at;
    end if;
    new.updated_at := now();
    new.slug := nullif(lower(btrim(new.slug)), '');
    perform public.event_form_check(new.form, array['short', 'long', 'url', 'email', 'discord', 'choice', 'dropdown',
        'checkboxes', 'number', 'date', 'scale', 'image', 'fakemon', 'agree', 'section'], 'entry form');
    -- voters answer about someone else's entry: no uploads, nothing personal
    perform public.event_form_check(new.vote_form, array['short', 'long', 'choice', 'dropdown', 'checkboxes', 'number', 'scale', 'section'], 'voter questions');
    if jsonb_typeof(new.vote_display) <> 'object'
       or jsonb_typeof(coalesce(new.vote_display->'author', 'true'::jsonb)) <> 'boolean'
       or jsonb_typeof(coalesce(new.vote_display->'fields', 'null'::jsonb)) not in ('null', 'array') then
        raise exception 'Invalid voting form display settings.';
    end if;
    if jsonb_typeof(new.criteria) <> 'array' or jsonb_array_length(new.criteria) not between 1 and 8 then
        raise exception 'The voting form needs 1 to 8 criteria.';
    end if;
    for f in select * from jsonb_array_elements(new.criteria) loop
        if jsonb_typeof(f) <> 'object'
           or char_length(coalesce(f->>'name', '')) not between 1 and 40
           or (f->>'name') = any(names)
           or char_length(coalesce(f->>'help', '')) > 200
           or jsonb_typeof(f->'max') <> 'number' or (f->>'max')::numeric not in (2, 3, 4, 5, 6, 7, 8, 9, 10) then
            raise exception 'One of the voting criteria is not valid: %', coalesce(f->>'name', '(untitled)');
        end if;
        names := names || (f->>'name');
    end loop;
    if jsonb_typeof(new.winner_criteria) <> 'object' then raise exception 'Invalid winner rules.'; end if;
    for k in select jsonb_object_keys(new.winner_criteria) loop
        if k not in ('top_n', 'top_percent', 'min_score_percent')
           or jsonb_typeof(new.winner_criteria->k) <> 'number'
           or (new.winner_criteria->>k)::numeric not between 1 and (case when k = 'top_n' then 1000 else 100 end) then
            raise exception 'Invalid winner rules.';
        end if;
    end loop;
    if new.submissions_open_at >= new.submissions_close_at then raise exception 'Entries must open before they close.'; end if;
    if new.voting_open_at >= new.voting_close_at then raise exception 'Voting must open before it closes.'; end if;
    if new.results_at < coalesce(new.voting_close_at, new.submissions_close_at) then
        raise exception 'Results can''t come out before % closes.', case when new.voting_close_at is null then 'entry' else 'voting' end;
    end if;
    return new;
end;
$$;

-- ==================== row level security ====================

-- signed-out visitors see public events only
drop policy events_read on public.events;
create policy events_read on public.events for select to anon, authenticated
    using (public.event_readable(events) or (select public.event_can(id, 'view')));

alter table public.event_ballots enable row level security;
alter table public.event_entry_limits enable row level security;
alter table public.event_results_posts enable row level security;

create policy event_ballots_read on public.event_ballots for select to authenticated
    using (voter_id = (select auth.uid()) or (select public.event_can(event_id, 'results')));

create policy event_entry_limits_read on public.event_entry_limits for select to authenticated
    using (user_id = (select auth.uid()) or (select public.event_can(event_id, 'edit')) or (select public.event_can(event_id, 'entries')));
create policy event_entry_limits_insert on public.event_entry_limits for insert to authenticated
    with check ((select public.event_can(event_id, 'edit')));
create policy event_entry_limits_update on public.event_entry_limits for update to authenticated
    using ((select public.event_can(event_id, 'edit'))) with check ((select public.event_can(event_id, 'edit')));
create policy event_entry_limits_delete on public.event_entry_limits for delete to authenticated
    using ((select public.event_can(event_id, 'edit')));

create policy event_results_posts_read on public.event_results_posts for select to anon, authenticated
    using ((select public.event_can(event_id, 'results')) or (select public.event_can(event_id, 'edit'))
           or exists (select 1 from public.events e where e.id = event_id and public.event_readable(e) and public.event_phase(e) = 'ended'));
create policy event_results_posts_insert on public.event_results_posts for insert to authenticated
    with check ((select public.event_can(event_id, 'edit')));
create policy event_results_posts_update on public.event_results_posts for update to authenticated
    using ((select public.event_can(event_id, 'edit'))) with check ((select public.event_can(event_id, 'edit')));

create or replace function public.event_results_posts_guard()
 returns trigger language plpgsql set search_path to 'public'
as $$
begin
    if tg_op = 'UPDATE' then new.event_id := old.event_id; end if;
    new.updated_by := auth.uid();
    new.updated_at := now();
    return new;
end;
$$;
create trigger event_results_posts_guard before insert or update on public.event_results_posts
    for each row execute function public.event_results_posts_guard();

revoke all on public.event_ballots, public.event_entry_limits, public.event_results_posts from anon, authenticated;
grant select on public.event_ballots to authenticated;
grant select, insert, update, delete on public.event_entry_limits to authenticated;
grant select on public.event_results_posts to anon, authenticated;
grant insert, update on public.event_results_posts to authenticated;

-- withdrawing your own entry follows the dates too
drop policy event_entries_delete on public.event_entries;
create policy event_entries_delete on public.event_entries for delete to authenticated
    using ((select public.event_can(event_id, 'entries'))
           or (user_id = (select auth.uid()) and exists (select 1 from public.events e where e.id = event_id and public.event_phase(e) = 'open')));

-- ==================== entering ====================

-- A Fakemon answer: the whole Fakemon, minus its collection bookkeeping, with
-- every picture or sound it carries checked to be inline data of the right kind.
create or replace function public.clean_event_fakemon(v jsonb)
 returns jsonb language plpgsql immutable set search_path to 'public'
as $$
declare
    k text;
begin
    if jsonb_typeof(v) <> 'object' or coalesce(v->>'name', '') = '' then return null; end if;
    v := v - 'id' - 'createdAt' - 'updatedAt' - 'regionIds' - 'folderId' - 'pinned';
    foreach k in array array['artwork', 'shinyArtwork', 'sprite', 'shinySprite', 'icon'] loop
        if v ? k and not (jsonb_typeof(v->k) = 'string' and char_length(v->>k) <= 1500000
                          and v->>k ~ '^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$') then
            v := v - k;
        end if;
    end loop;
    if v ? 'cry' and not (jsonb_typeof(v->'cry') = 'string' and char_length(v->>'cry') <= 400000
                          and v->>'cry' ~ '^data:audio/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$') then
        v := v - 'cry';
    end if;
    if pg_column_size(v) > 2500000 then return null; end if;
    return v;
end;
$$;

-- Stores an entry: answers checked against the form, private ones (email,
-- Discord, anything the organizer marked) split into their own table.
create or replace function public.event_store_entry(ev public.events, p_user uuid, p_answers jsonb)
 returns uuid language plpgsql set search_path to 'public'
as $$
declare
    clean jsonb;
    f jsonb;
    pub jsonb := '{}'::jsonb;
    priv jsonb := '{}'::jsonb;
    new_id uuid;
begin
    if pg_column_size(p_answers) > 6000000 then raise exception 'That entry is too large. Use smaller images.'; end if;
    clean := public.event_clean_answers(ev.form, p_answers);
    for f in select * from jsonb_array_elements(ev.form) loop
        continue when not clean ? (f->>'id');
        if f->>'type' in ('email', 'discord') or coalesce((f->>'private')::boolean, false) then
            priv := priv || jsonb_build_object(f->>'id', clean->(f->>'id'));
        else
            pub := pub || jsonb_build_object(f->>'id', clean->(f->>'id'));
        end if;
    end loop;
    insert into public.event_entries(event_id, user_id, answers) values (ev.id, p_user, pub) returning id into new_id;
    insert into public.event_entry_private(entry_id, event_id, user_id, answers) values (new_id, ev.id, p_user, priv);
    return new_id;
end;
$$;

-- Members: held to the event's entry limit, and to a site-wide pace.
create or replace function public.submit_event_entry(p_event uuid, p_answers jsonb)
 returns uuid language plpgsql security definer set search_path to 'public'
as $$
declare
    uid uuid := auth.uid();
    ev public.events;
    allowed integer;
begin
    if uid is null then raise exception 'Sign in to enter.'; end if;
    select * into ev from public.events where id = p_event for update;
    if not found or not public.event_readable(ev) or public.event_phase(ev) <> 'open' then
        raise exception 'This event is not taking entries.';
    end if;
    if exists (select 1 from public.profiles p where p.id = uid
               and ((p.banned_until is not null and p.banned_until > now())
                 or (p.muted_until is not null and p.muted_until > now()))) then
        raise exception 'Your account cannot enter events right now.';
    end if;
    allowed := coalesce((select l.max_entries from public.event_entry_limits l where l.event_id = p_event and l.user_id = uid), ev.max_entries_per_user);
    if (select count(*) from public.event_entries e where e.event_id = p_event and e.user_id = uid) >= allowed then
        raise exception 'You have used all % of your entries for this event.', allowed;
    end if;
    -- one account entering everything in a loop: big entries add up
    if not public.rate_limit_hit('event-entry:' || uid, 30, interval '1 hour') then
        raise exception 'You are entering events too quickly. Try again in a while.';
    end if;
    return public.event_store_entry(ev, uid, p_answers);
end;
$$;

-- Guests (public events only). Callable by the submit-event-guest edge
-- function alone (service role): it has already checked a Turnstile
-- challenge, and passes the caller's real address, signed by our proxy, so
-- these limits can't be dodged by faking a header.
create or replace function public.submit_event_entry_guest(p_event uuid, p_answers jsonb, p_ip text)
 returns uuid language plpgsql security definer set search_path to 'public'
as $$
declare
    ev public.events;
    ip text := left(coalesce(nullif(btrim(p_ip), ''), 'unknown'), 64);
begin
    select * into ev from public.events where id = p_event for update;
    if not found or ev.phase = 'draft' or not ev.public_access or public.event_phase(ev) <> 'open' then
        raise exception 'This event is not taking entries.';
    end if;
    -- per address on this event, per address across events, and the whole
    -- event's guest intake: a determined spammer with many addresses still
    -- hits the last one, and the organizer can remove what got through
    if not public.rate_limit_hit('event-guest:' || p_event || ':' || ip, 3, interval '1 hour')
       or not public.rate_limit_hit('event-guest-day:' || p_event || ':' || ip, ev.max_entries_per_user + 4, interval '1 day')
       or not public.rate_limit_hit('event-guest-ip:' || ip, 20, interval '1 day')
       or not public.rate_limit_hit('event-guest-all:' || p_event, 500, interval '1 day') then
        raise exception 'Too many entries from here. Try again later.';
    end if;
    return public.event_store_entry(ev, null, p_answers);
end;
$$;

-- ==================== voting ====================

-- {criterion name: 1..its max} for every one of the event's criteria, summed; null if anything is off
create or replace function public.event_criteria_total(ev public.events, p_scores jsonb)
 returns integer language plpgsql immutable set search_path to 'public'
as $$
declare
    c jsonb;
    total integer := 0;
    n numeric;
begin
    if p_scores is null or jsonb_typeof(p_scores) <> 'object' then return null; end if;
    for c in select * from jsonb_array_elements(ev.criteria) loop
        if jsonb_typeof(p_scores->(c->>'name')) <> 'number' then return null; end if;
        n := (p_scores->>(c->>'name'))::numeric;
        if n <> trunc(n) or n < 1 or n > (c->>'max')::numeric then return null; end if;
        total := total + n::integer;
    end loop;
    return total;
end;
$$;

create or replace function public.event_remarks_ok(ev public.events, p_remarks text)
 returns boolean language sql immutable set search_path to 'public'
as $$
    select char_length(coalesce(p_remarks, '')) <= 2000
       and not (ev.voter_remarks = 'required' and btrim(coalesce(p_remarks, '')) = '')
       and not (ev.voter_remarks = 'off' and btrim(coalesce(p_remarks, '')) <> '');
$$;

-- One account, one vote only works if accounts aren't free to mint by the
-- dozen: a vote from an account made in the last day doesn't count.
-- ponytail: fixed 24h; make it an event setting if organizers need otherwise.
create or replace function public.event_voter_seasoned(p_user uuid)
 returns boolean language sql stable set search_path to 'public'
as $$
    select exists (select 1 from public.profiles p where p.id = p_user and p.created_at < now() - interval '24 hours');
$$;

-- community: a vote is a 1, and you have votes_per_user of them to spread.
-- judges: helpers with `judge` score one entry at a time on the criteria.
-- ballot: use submit_event_ballot. Nothing given takes your vote back.
-- Organizers and helpers vote like anyone else, just never on their own entry.
drop function public.cast_event_vote(uuid, integer);
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
    if en.user_id = uid then raise exception 'You cannot vote for your own entry.'; end if;
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

-- The Fakemon-contest ballot: every entry but your own, every criterion,
-- once, all at the same time.
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
    select count(*) into eligible from public.event_entries e where e.event_id = p_event and e.user_id is distinct from uid;
    if eligible = 0 then raise exception 'There is nothing to vote on.'; end if;
    if jsonb_array_length(p_votes) <> eligible
       or (select count(distinct x->>'entry_id') from jsonb_array_elements(p_votes) x) <> eligible then
        raise exception 'Rate every entry before submitting your ballot.';
    end if;
    for x in select * from jsonb_array_elements(p_votes) loop
        if not exists (select 1 from public.event_entries e where e.id::text = x->>'entry_id' and e.event_id = p_event and e.user_id is distinct from uid)
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

-- Tallies. points_percent is the share of every point the entry could have
-- got: its score total over (voters x the most one voter can give it), so
-- an entry only some voters rated scores lower than one everyone rated.
drop function public.get_event_results(uuid);
create or replace function public.get_event_results(p_event uuid)
 returns table(entry_id uuid, votes bigint, score_total bigint, score_avg numeric, criteria_avg jsonb, total_voters bigint, points_percent numeric)
 language plpgsql stable security definer set search_path to 'public'
as $$
declare
    ev public.events;
    voters bigint;
    per_voter integer;
begin
    select * into ev from public.events where id = p_event;
    if not found or not (public.event_can(p_event, 'results')
        or (public.event_readable(ev) and (public.event_phase(ev) = 'ended' or (public.event_phase(ev) = 'voting' and ev.live_results)))) then
        raise exception 'Results are not public yet.';
    end if;
    voters := case when ev.voting = 'ballot'
        then (select count(*) from public.event_ballots b where b.event_id = p_event)
        else (select count(distinct v.voter_id) from public.event_votes v where v.event_id = p_event) end;
    per_voter := case when ev.voting = 'community' then 1
        else (select coalesce(sum((c->>'max')::integer), 0) from jsonb_array_elements(ev.criteria) c) end;
    return query
        select en.id, count(v.voter_id), coalesce(sum(v.score), 0)::bigint, round(coalesce(avg(v.score), 0), 2),
               coalesce((select jsonb_object_agg(c->>'name', (select round(avg((v2.scores->>(c->>'name'))::numeric), 2)
                                                    from public.event_votes v2 where v2.entry_id = en.id and v2.scores ? (c->>'name')))
                         from jsonb_array_elements(ev.criteria) c), '{}'::jsonb),
               voters,
               case when voters * per_voter > 0 then round(coalesce(sum(v.score), 0) * 100.0 / (voters * per_voter), 2) else 0 end
        from public.event_entries en
        left join public.event_votes v on v.entry_id = en.id
        where en.event_id = p_event
        group by en.id;
end;
$$;

-- ==================== entry codes ====================
-- An organizer makes a code and hands it out (in DMs, say); whoever redeems
-- it may send that many entries. The code is kept as typed so the team can
-- read it back; redeeming is the only way to use one, and it's rate limited
-- so codes can't be guessed.

create table public.event_codes (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    code text not null check (code ~ '^[A-Za-z0-9-]{4,32}$'),
    max_entries smallint not null check (max_entries between 1 and 100),
    max_uses integer check (max_uses between 1 and 100000),
    uses integer not null default 0,
    created_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now()
);
create unique index event_codes_code_idx on public.event_codes(event_id, lower(code));

create table public.event_code_redemptions (
    code_id uuid not null references public.event_codes(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    redeemed_at timestamptz not null default now(),
    primary key (code_id, user_id)
);
create index event_code_redemptions_user_idx on public.event_code_redemptions(user_id);

create or replace function public.event_codes_guard()
 returns trigger language plpgsql set search_path to 'public'
as $$
begin
    if tg_op = 'UPDATE' then
        new.event_id := old.event_id;
        -- only redeem_event_code (running as the owner) counts uses
        if current_user <> 'postgres' then new.uses := old.uses; end if;
        new.created_by := old.created_by;
        new.created_at := old.created_at;
    else
        new.uses := 0;
        new.created_by := auth.uid();
    end if;
    return new;
end;
$$;
create trigger event_codes_guard before insert or update on public.event_codes
    for each row execute function public.event_codes_guard();

alter table public.event_codes enable row level security;
alter table public.event_code_redemptions enable row level security;
create policy event_codes_read on public.event_codes for select to authenticated using ((select public.event_can(event_id, 'edit')));
create policy event_codes_insert on public.event_codes for insert to authenticated with check ((select public.event_can(event_id, 'edit')));
create policy event_codes_update on public.event_codes for update to authenticated
    using ((select public.event_can(event_id, 'edit'))) with check ((select public.event_can(event_id, 'edit')));
create policy event_codes_delete on public.event_codes for delete to authenticated using ((select public.event_can(event_id, 'edit')));
create policy event_code_redemptions_read on public.event_code_redemptions for select to authenticated
    using (user_id = (select auth.uid()) or exists (select 1 from public.event_codes c where c.id = code_id and public.event_can(c.event_id, 'edit')));
revoke all on public.event_codes, public.event_code_redemptions from anon, authenticated;
grant select, insert, update, delete on public.event_codes to authenticated;
grant select on public.event_code_redemptions to authenticated;

-- Returns the number of entries the code allows. Never says whether a code
-- exists without counting the attempt.
create or replace function public.redeem_event_code(p_event uuid, p_code text)
 returns integer language plpgsql security definer set search_path to 'public'
as $$
declare
    uid uuid := auth.uid();
    c public.event_codes;
begin
    if uid is null then raise exception 'Sign in to use a code.'; end if;
    if not public.rate_limit_hit('event-code:' || uid, 10, interval '1 hour') then
        raise exception 'Too many tries. Try again in a while.';
    end if;
    select * into c from public.event_codes where event_id = p_event and lower(code) = lower(btrim(coalesce(p_code, ''))) for update;
    if not found then raise exception 'That code doesn''t work for this event.'; end if;
    if not exists (select 1 from public.event_code_redemptions r where r.code_id = c.id and r.user_id = uid) then
        if c.max_uses is not null and c.uses >= c.max_uses then raise exception 'That code has been used up.'; end if;
        insert into public.event_code_redemptions(code_id, user_id) values (c.id, uid);
        update public.event_codes set uses = uses + 1 where id = c.id;
    end if;
    -- a code raises your limit, never lowers one you already have
    insert into public.event_entry_limits(event_id, user_id, max_entries) values (p_event, uid, c.max_entries)
        on conflict (event_id, user_id) do update set max_entries = greatest(public.event_entry_limits.max_entries, excluded.max_entries);
    return (select max_entries from public.event_entry_limits where event_id = p_event and user_id = uid);
end;
$$;
revoke execute on function public.redeem_event_code(uuid, text) from public, anon;
grant execute on function public.redeem_event_code(uuid, text) to authenticated;
revoke execute on function public.event_codes_guard() from public, anon, authenticated;

-- ==================== events in the feed ====================

alter table public.community_posts drop constraint community_posts_repost_kind_check;
alter table public.community_posts add constraint community_posts_repost_kind_check check (repost_kind in ('mon', 'post', 'event'));

create or replace function public.guard_repost()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare
    inner_kind text;
    inner_id uuid;
begin
    if tg_op = 'UPDATE' then
        new.repost_kind := old.repost_kind;
        new.repost_id := old.repost_id;
        return new;
    end if;
    if new.repost_id is null then return new; end if;
    if new.repost_kind = 'post' then
        select repost_kind, repost_id into inner_kind, inner_id from public.community_posts where id = new.repost_id;
        if not found then
            raise exception 'That post is gone.' using errcode = 'P0001';
        end if;
        if inner_id is not null then
            new.repost_kind := inner_kind;
            new.repost_id := inner_id;
        end if;
    end if;
    if new.repost_kind = 'mon' and not exists (select 1 from public.published_mons where id = new.repost_id) then
        raise exception 'That Fakémon is gone.' using errcode = 'P0001';
    end if;
    -- drafts can't be shared: they aren't public yet
    if new.repost_kind = 'event' and not exists (select 1 from public.events where id = new.repost_id and phase <> 'draft') then
        raise exception 'That event isn''t open to share.' using errcode = 'P0001';
    end if;
    return new;
end $$;

create trigger drop_plain_reposts after delete on public.events
    for each row execute function public.drop_plain_reposts('event');

create or replace function public.repost_embed(p_kind text, p_id uuid)
 returns jsonb language sql stable security definer set search_path to 'public'
as $$
    select case p_kind
        when 'mon' then (
            select jsonb_build_object(
                'kind', 'mon', 'id', m.id, 'user_id', m.user_id, 'created_at', m.published_at,
                'author_name', m.author_name, 'author_avatar_url', m.author_avatar_url, 'author_badges', m.author_badges,
                'name', m.fakemon_data->>'name', 'species', m.fakemon_data->>'species', 'number', m.fakemon_data->>'number',
                'type1', m.fakemon_data->>'type1', 'type2', m.fakemon_data->>'type2',
                'customTypes', coalesce(m.fakemon_data->'customTypes', '[]'::jsonb),
                'caption', left(coalesce(m.fakemon_data->>'dexEntry1', ''), 280),
                'like_count', (select count(*) from public.mon_reactions r where r.mon_id = m.id),
                'liked_by_me', exists (select 1 from public.mon_reactions r where r.mon_id = m.id and r.emoji = 'heart' and r.user_id = auth.uid()),
                'reactions', coalesce((select jsonb_object_agg(emoji, n) from (
                        select emoji, count(*) n from public.mon_reactions r where r.mon_id = m.id group by emoji) x), '{}'::jsonb),
                'my_reactions', coalesce((select jsonb_agg(emoji) from public.mon_reactions r where r.mon_id = m.id and r.user_id = auth.uid()), '[]'::jsonb),
                'comment_count', (select count(*) from public.mon_comments c where c.mon_id = m.id),
                'repost_count', (select count(*) from public.community_posts rp where rp.repost_kind = 'mon' and rp.repost_id = m.id),
                'reposted_by_me', exists (select 1 from public.community_posts rp where rp.repost_kind = 'mon' and rp.repost_id = m.id
                                            and rp.user_id = auth.uid() and rp.body = '' and rp.mon_ids = '{}'))
            from public.published_mons m where m.id = p_id)
        when 'post' then (
            select jsonb_build_object(
                'kind', 'post', 'id', p.id, 'user_id', p.user_id, 'created_at', p.created_at,
                'body', left(p.body, 600), 'truncated', char_length(p.body) > 600, 'mon_ids', p.mon_ids,
                'mons', coalesce((select jsonb_agg(jsonb_build_object(
                            'id', pm.id, 'name', pm.fakemon_data->>'name', 'type1', pm.fakemon_data->>'type1', 'type2', pm.fakemon_data->>'type2')
                            order by array_position(p.mon_ids, pm.id))
                          from public.published_mons pm where pm.id = any(p.mon_ids)), '[]'::jsonb),
                'tags', p.tags, 'edited_at', p.edited_at,
                'reactions', coalesce((select jsonb_object_agg(emoji, n) from (
                        select emoji, count(*) n from public.post_reactions r where r.post_id = p.id group by emoji) x), '{}'::jsonb),
                'my_reactions', coalesce((select jsonb_agg(emoji) from public.post_reactions r where r.post_id = p.id and r.user_id = auth.uid()), '[]'::jsonb),
                'comment_count', (select count(*) from public.post_comments c where c.post_id = p.id),
                'repost_count', (select count(*) from public.community_posts rp where rp.repost_kind = 'post' and rp.repost_id = p.id),
                'reposted_by_me', exists (select 1 from public.community_posts rp where rp.repost_kind = 'post' and rp.repost_id = p.id
                                            and rp.user_id = auth.uid() and rp.body = '' and rp.mon_ids = '{}'))
            from public.community_posts p where p.id = p_id)
        when 'event' then (
            select jsonb_build_object(
                'kind', 'event', 'id', e.id, 'slug', e.slug, 'user_id', e.owner_id, 'created_at', e.created_at,
                'title', e.title, 'tagline', e.tagline, 'category', e.category, 'cover_image', e.cover_image,
                'stage', public.event_phase(e), 'submissions_close_at', e.submissions_close_at, 'voting_close_at', e.voting_close_at,
                'entry_count', (select count(*) from public.event_entries en where en.event_id = e.id),
                'repost_count', (select count(*) from public.community_posts rp where rp.repost_kind = 'event' and rp.repost_id = e.id),
                'reposted_by_me', exists (select 1 from public.community_posts rp where rp.repost_kind = 'event' and rp.repost_id = e.id
                                            and rp.user_id = auth.uid() and rp.body = '' and rp.mon_ids = '{}'))
            from public.events e where e.id = p_id and e.phase <> 'draft')
    end;
$$;

-- ==================== grants ====================

revoke execute on function public.cast_event_vote(uuid, integer, jsonb, text, jsonb), public.submit_event_ballot(uuid, jsonb) from public, anon;
grant execute on function public.cast_event_vote(uuid, integer, jsonb, text, jsonb), public.submit_event_ballot(uuid, jsonb) to authenticated;
-- guests enter only through the submit-event-guest edge function
revoke execute on function public.submit_event_entry_guest(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.submit_event_entry_guest(uuid, jsonb, text) to service_role;
revoke execute on function public.get_event_results(uuid) from public;
grant execute on function public.get_event_results(uuid) to anon, authenticated;
revoke execute on function public.clean_event_fakemon(jsonb), public.event_criteria_total(public.events, jsonb),
    public.event_remarks_ok(public.events, text), public.event_results_posts_guard(),
    public.event_clean_answers(jsonb, jsonb),
    public.event_store_entry(public.events, uuid, jsonb), public.event_voter_seasoned(uuid) from public, anon, authenticated;
