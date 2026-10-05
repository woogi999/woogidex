-- Event forms: a "library" question (a move, ability, item or type, from the
-- entrant's collection, a file, or made on the spot) and rules on Fakémon
-- questions (must have artwork, no custom types, a BST range...). The browser
-- checks the same rules (monRuleProblems in js/features/events.ts); these are
-- the ones that count.

-- the 18 types, ??? and Stellar: anything else on a Fakémon is a custom type
create or replace function public.event_vanilla_type(t text)
 returns boolean language sql immutable set search_path to 'public'
as $$
    select coalesce(t, '') = '' or t = any(array['Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison', 'Ground',
        'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy', '???', 'Stellar']);
$$;

-- A Fakémon question's rules, checked for shape when the form is saved.
create or replace function public.event_rules_ok(r jsonb)
 returns boolean language plpgsql immutable set search_path to 'public'
as $$
declare
    k text;
begin
    if r is null or r = 'null'::jsonb then return true; end if;
    if jsonb_typeof(r) <> 'object' then return false; end if;
    for k in select jsonb_object_keys(r) loop
        if k not in ('require', 'noCustomTypes', 'noCustomAbilities', 'noCustomMoves', 'types', 'minBst', 'maxBst') then return false; end if;
    end loop;
    if r ? 'require' and (jsonb_typeof(r->'require') <> 'array' or exists (
           select 1 from jsonb_array_elements(r->'require') x
           where jsonb_typeof(x) <> 'string' or (x #>> '{}') not in ('artwork', 'shiny', 'abilities', 'dex', 'moves', 'sets'))) then
        return false;
    end if;
    if r ? 'types' and (jsonb_typeof(r->'types') <> 'array' or jsonb_array_length(r->'types') > 30 or exists (
           select 1 from jsonb_array_elements(r->'types') x where jsonb_typeof(x) <> 'string' or char_length(x #>> '{}') not between 1 and 24)) then
        return false;
    end if;
    if exists (select 1 from unnest(array['noCustomTypes', 'noCustomAbilities', 'noCustomMoves']) b
               where r ? b and jsonb_typeof(r->b) <> 'boolean') then
        return false;
    end if;
    if exists (select 1 from unnest(array['minBst', 'maxBst']) b
               where r ? b and not (jsonb_typeof(r->b) = 'null' or (jsonb_typeof(r->b) = 'number' and (r->>b)::numeric between 1 and 1530))) then
        return false;
    end if;
    return true;
end;
$$;

-- What a Fakémon breaks of a question's rules, in words; null when it's fine.
create or replace function public.event_fakemon_problem(v jsonb, r jsonb)
 returns text language plpgsql immutable set search_path to 'public'
as $$
declare
    part text;
    bst numeric := 0;
    k text;
begin
    if r is null or jsonb_typeof(r) <> 'object' then return null; end if;
    if r ? 'require' then
        for part in select jsonb_array_elements_text(r->'require') loop
            if (part = 'artwork' and coalesce(v->>'artwork', '') = '')
               or (part = 'shiny' and coalesce(v->>'shinyArtwork', '') = '')
               or (part = 'abilities' and not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v->'abilities') = 'array' then v->'abilities' else '[]' end) a where coalesce(btrim(a->>'name'), '') <> ''))
               or (part = 'dex' and coalesce(btrim(v->>'dexEntry1'), '') = '')
               or (part = 'moves' and coalesce(jsonb_array_length(case when jsonb_typeof(v->'learnset') = 'array' then v->'learnset' end), 0) = 0)
               or (part = 'sets' and coalesce(jsonb_array_length(case when jsonb_typeof(v->'sampleSets') = 'array' then v->'sampleSets' end), 0) = 0) then
                return 'needs ' || case part when 'artwork' then 'artwork' when 'shiny' then 'shiny artwork' when 'abilities' then 'abilities'
                    when 'dex' then 'a Pokédex entry' when 'moves' then 'a learnset' else 'sample sets' end;
            end if;
        end loop;
    end if;
    if coalesce((r->>'noCustomTypes')::boolean, false) and not (public.event_vanilla_type(v->>'type1') and public.event_vanilla_type(v->>'type2')) then
        return 'can''t have a custom type';
    end if;
    if coalesce((r->>'noCustomAbilities')::boolean, false) and exists (
           select 1 from jsonb_array_elements(case when jsonb_typeof(v->'abilities') = 'array' then v->'abilities' else '[]' end) a
           where a->>'custom' = 'true' or a->>'source' = 'custom') then
        return 'can''t have a custom ability';
    end if;
    if coalesce((r->>'noCustomMoves')::boolean, false) and (exists (
           select 1 from jsonb_array_elements(case when jsonb_typeof(v->'learnset') = 'array' then v->'learnset' else '[]' end) m
           where m->>'custom' = 'true' or m->>'source' = 'custom')
           or coalesce(jsonb_array_length(case when jsonb_typeof(v->'customMoves') = 'array' then v->'customMoves' end), 0) > 0) then
        return 'can''t have custom moves';
    end if;
    if jsonb_typeof(r->'types') = 'array' and jsonb_array_length(r->'types') > 0
       and not (r->'types' ? coalesce(v->>'type1', '') or r->'types' ? coalesce(v->>'type2', '')) then
        return 'must be ' || (select string_agg(x, ' or ') from jsonb_array_elements_text(r->'types') x) || ' type';
    end if;
    if jsonb_typeof(r->'minBst') = 'number' or jsonb_typeof(r->'maxBst') = 'number' then
        foreach k in array array['hp', 'atk', 'def', 'spa', 'spd', 'spe'] loop
            begin
                bst := bst + coalesce((v->'stats'->>k)::numeric, 0);
            exception when others then
                return 'has stats that aren''t numbers';
            end;
        end loop;
        if jsonb_typeof(r->'minBst') = 'number' and bst < (r->>'minBst')::numeric then return 'needs a BST of at least ' || (r->>'minBst'); end if;
        if jsonb_typeof(r->'maxBst') = 'number' and bst > (r->>'maxBst')::numeric then return 'needs a BST of at most ' || (r->>'maxBst'); end if;
    end if;
    return null;
end;
$$;

-- A move, ability, item or type answer: one of the kinds the question takes,
-- named, without collection bookkeeping, its picture checked, kept small.
create or replace function public.clean_event_library(v jsonb, p_kinds jsonb)
 returns jsonb language plpgsql immutable set search_path to 'public'
as $$
begin
    if jsonb_typeof(v) <> 'object' or jsonb_typeof(p_kinds) <> 'array' or not (p_kinds ? coalesce(v->>'kind', ''))
       or char_length(btrim(coalesce(v->>'name', ''))) not between 1 and 60 then
        return null;
    end if;
    v := v - 'id' - 'createdAt' - 'updatedAt' - 'regionIds' - 'folderId' - 'pinned' - 'vanillaOf';
    if v ? 'artwork' and not (jsonb_typeof(v->'artwork') = 'string' and char_length(v->>'artwork') <= 400000
                              and v->>'artwork' ~ '^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$') then
        v := v - 'artwork';
    end if;
    if pg_column_size(v) > 600000 then return null; end if;
    return v;
end;
$$;

-- The form check, now knowing 'library' (and its kinds) and Fakémon rules.
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
           or (f->>'type' = 'number' and f ? 'max' and jsonb_typeof(f->'max') not in ('number', 'null'))
           or (f->>'type' = 'library' and (jsonb_typeof(f->'kinds') <> 'array' or jsonb_array_length(f->'kinds') not between 1 and 4
                or exists (select 1 from jsonb_array_elements(f->'kinds') k where jsonb_typeof(k) <> 'string' or (k #>> '{}') not in ('move', 'ability', 'item', 'type'))))
           or (f ? 'rules' and not public.event_rules_ok(f->'rules')) then
            raise exception 'One of the % questions is not valid: %', p_what, coalesce(f->>'label', '(untitled)');
        end if;
        ids := ids || (f->>'id');
    end loop;
end;
$$;

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
    problem text;
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
                problem := public.event_fakemon_problem(v, f->'rules');
                if problem is not null then raise exception 'Your Fakémon % (%).', problem, f->>'label'; end if;
            when 'library' then
                v := public.clean_event_library(v, f->'kinds');
                if v is null then raise exception 'That could not be used for: %', f->>'label'; end if;
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

-- the entry form may now ask for a 'library' answer
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
        'checkboxes', 'number', 'date', 'scale', 'image', 'fakemon', 'library', 'agree', 'section'], 'entry form');
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

revoke execute on function public.event_fakemon_problem(jsonb, jsonb), public.clean_event_library(jsonb, jsonb),
    public.event_vanilla_type(text) from public, anon, authenticated;
