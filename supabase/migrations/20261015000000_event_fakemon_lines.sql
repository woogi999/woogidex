-- Fakémon answers can carry their whole evolution line, the way a Community
-- upload does: the answer is the line's face (its last stage) and the rest ride
-- along in "family" (sourceId, stage, from, method, isMega, isFormeChange, and
-- a full "mon" for every member but the face). Rules on a Fakémon question
-- gain the line's size, no Megas/forms, and limits on custom moves, abilities
-- and types counted once across the line. The browser checks the same rules
-- (monRuleProblems in js/features/events.ts); these are the ones that count.

-- ==================== rules ====================

create or replace function public.event_rules_ok(r jsonb)
 returns boolean language plpgsql immutable set search_path to 'public'
as $$
declare
    k text;
begin
    if r is null or r = 'null'::jsonb then return true; end if;
    if jsonb_typeof(r) <> 'object' then return false; end if;
    for k in select jsonb_object_keys(r) loop
        if k not in ('require', 'noCustomTypes', 'noCustomAbilities', 'noCustomMoves', 'types', 'minBst', 'maxBst',
                     'minLine', 'maxLine', 'noForms', 'maxCustomMoves', 'maxCustomAbilities', 'maxCustomTotal') then
            return false;
        end if;
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
    if exists (select 1 from unnest(array['noCustomTypes', 'noCustomAbilities', 'noCustomMoves', 'noForms']) b
               where r ? b and jsonb_typeof(r->b) <> 'boolean') then
        return false;
    end if;
    if exists (select 1 from unnest(array['minBst', 'maxBst']) b
               where r ? b and not (jsonb_typeof(r->b) = 'null' or (jsonb_typeof(r->b) = 'number' and (r->>b)::numeric between 1 and 1530))) then
        return false;
    end if;
    -- whole numbers: a line of 1 to 10, a custom limit of 0 to 50
    if exists (select 1 from unnest(array['minLine', 'maxLine']) b
               where r ? b and not (jsonb_typeof(r->b) = 'null' or (jsonb_typeof(r->b) = 'number' and (r->>b)::numeric in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10)))) then
        return false;
    end if;
    if exists (select 1 from unnest(array['maxCustomMoves', 'maxCustomAbilities', 'maxCustomTotal']) b
               where r ? b and not (jsonb_typeof(r->b) = 'null' or (jsonb_typeof(r->b) = 'number'
                   and (r->>b)::numeric between 0 and 50 and (r->>b)::numeric = trunc((r->>b)::numeric)))) then
        return false;
    end if;
    return true;
end;
$$;

-- ==================== cleaning an answer ====================

-- one Fakémon: minus its collection bookkeeping (and the board that pointed
-- at the rest of a collection), every picture or sound checked to be inline
-- data of the right kind
create or replace function public.clean_event_mon_one(v jsonb)
 returns jsonb language plpgsql immutable set search_path to 'public'
as $$
declare
    k text;
begin
    if jsonb_typeof(v) <> 'object' or coalesce(v->>'name', '') = '' then return null; end if;
    v := v - 'id' - 'createdAt' - 'updatedAt' - 'regionIds' - 'folderId' - 'pinned' - 'family' - 'evolutionGraph' - 'sourceId';
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

-- a Fakémon answer: one Fakémon, or a line of 2 to 10 with exactly one face
create or replace function public.clean_event_fakemon(v jsonb)
 returns jsonb language plpgsql immutable set search_path to 'public'
as $$
declare
    fam jsonb;
    m jsonb;
    mon jsonb;
    out_fam jsonb := '[]'::jsonb;
    ids text[] := '{}';
    faces integer := 0;
    id_pattern constant text := '^[A-Za-z0-9_.:-]{1,64}$';
begin
    if jsonb_typeof(v) <> 'object' then return null; end if;
    fam := v->'family';
    v := public.clean_event_mon_one(v);
    if v is null then return null; end if;
    if fam is null or jsonb_typeof(fam) <> 'array' or jsonb_array_length(fam) < 2 then return v; end if;
    if jsonb_array_length(fam) > 10 then return null; end if;

    for m in select * from jsonb_array_elements(fam) loop
        if jsonb_typeof(m) <> 'object' or coalesce(m->>'sourceId', '') !~ id_pattern or (m->>'sourceId') = any(ids) then
            return null;
        end if;
        ids := ids || (m->>'sourceId');
    end loop;

    for m in select * from jsonb_array_elements(fam) loop
        mon := null;
        if m->'face' = 'true'::jsonb then
            faces := faces + 1;
        else
            mon := public.clean_event_mon_one(m->'mon');
            if mon is null then return null; end if;
        end if;
        out_fam := out_fam || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
            'sourceId', m->>'sourceId',
            'stage', case when jsonb_typeof(m->'stage') = 'number' then least(20, greatest(1, trunc((m->>'stage')::numeric)))::integer else 1 end,
            'isMega', case when m->'isMega' = 'true'::jsonb then true end,
            'isFormeChange', case when m->'isFormeChange' = 'true'::jsonb then true end,
            -- a link to something outside the line is dropped, not trusted
            'from', case when (m->>'from') = any(ids) and (m->>'from') <> (m->>'sourceId') then m->>'from' end,
            'method', nullif(left(btrim(case when jsonb_typeof(m->'method') = 'string' then m->>'method' else '' end), 120), ''),
            'face', case when mon is null then true end,
            'mon', mon)));
    end loop;
    if faces <> 1 then return null; end if;

    v := v || jsonb_build_object('family', out_fam);
    if pg_column_size(v) > 5000000 then return null; end if;
    return v;
end;
$$;

-- ==================== checking an answer against the rules ====================

-- one Fakémon against a question's rules; type and BST rules are the face's alone
create or replace function public.event_mon_problem(v jsonb, r jsonb, p_face boolean)
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
    if not coalesce(p_face, false) then return null; end if;
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

-- What a Fakémon answer breaks of a question's rules, in words that follow
-- "Your Fakémon "; null when it's fine. Same checks as monRuleProblems.
create or replace function public.event_fakemon_problem(v jsonb, r jsonb)
 returns text language plpgsql immutable set search_path to 'public'
as $$
declare
    mons jsonb;
    m jsonb;
    n integer;
    p text;
    lim integer;
    c_moves integer;
    c_abilities integer;
    c_types integer;
    subject text;
begin
    if r is null or jsonb_typeof(r) <> 'object' then return null; end if;
    -- every member with its Fakémon; the face's is the answer itself
    if jsonb_typeof(v->'family') = 'array' and jsonb_array_length(v->'family') >= 2 then
        select jsonb_agg(case when x->'face' = 'true'::jsonb then (x - 'mon') || jsonb_build_object('mon', v - 'family') else x end)
          into mons from jsonb_array_elements(v->'family') x;
    else
        mons := jsonb_build_array(jsonb_build_object('face', true, 'mon', v - 'family'));
    end if;
    n := jsonb_array_length(mons);
    subject := case when n > 1 then 'line has' else 'has' end;

    for m in select * from jsonb_array_elements(mons) loop
        p := public.event_mon_problem(m->'mon', r, coalesce(m->'face' = 'true'::jsonb, false));
        if p is not null then
            return case when n > 1 then 'line''s ' || coalesce(nullif(btrim(m->'mon'->>'name'), ''), 'Fakémon') || ' ' || p else p end;
        end if;
    end loop;

    if jsonb_typeof(r->'maxLine') = 'number' and n > (r->>'maxLine')::integer then
        return case when (r->>'maxLine')::integer = 1 then 'can''t come with evolutions or forms for this event'
                    else format('line has %s Fakémon, but at most %s are allowed', n, r->>'maxLine') end;
    end if;
    if jsonb_typeof(r->'minLine') = 'number' and n < (r->>'minLine')::integer then
        return format('needs an evolution line of at least %s Fakémon', r->>'minLine');
    end if;
    if coalesce((r->>'noForms')::boolean, false)
       and exists (select 1 from jsonb_array_elements(mons) x where x->'isMega' = 'true'::jsonb or x->'isFormeChange' = 'true'::jsonb) then
        return 'line can''t include Megas or other forms';
    end if;

    -- custom moves, abilities and types, each counted once across the line
    with names(k, nm) as (
        select 'move', lower(btrim(mv->>'name'))
          from jsonb_array_elements(mons) x,
               jsonb_array_elements(case when jsonb_typeof(x->'mon'->'learnset') = 'array' then x->'mon'->'learnset' else '[]' end) mv
         where mv->>'custom' = 'true' or mv->>'source' = 'custom'
        union
        select 'move', lower(btrim(mv->>'name'))
          from jsonb_array_elements(mons) x,
               jsonb_array_elements(case when jsonb_typeof(x->'mon'->'customMoves') = 'array' then x->'mon'->'customMoves' else '[]' end) mv
        union
        select 'ability', lower(btrim(a->>'name'))
          from jsonb_array_elements(mons) x,
               jsonb_array_elements(case when jsonb_typeof(x->'mon'->'abilities') = 'array' then x->'mon'->'abilities' else '[]' end) a
         where a->>'custom' = 'true' or a->>'source' = 'custom'
        union
        select 'type', lower(t)
          from jsonb_array_elements(mons) x, lateral (values (x->'mon'->>'type1'), (x->'mon'->>'type2')) tt(t)
         where not public.event_vanilla_type(t)
    )
    select count(*) filter (where k = 'move' and coalesce(nm, '') <> ''),
           count(*) filter (where k = 'ability' and coalesce(nm, '') <> ''),
           count(*) filter (where k = 'type' and coalesce(nm, '') <> '')
      into c_moves, c_abilities, c_types
      from names;

    if jsonb_typeof(r->'maxCustomMoves') = 'number' then
        lim := (r->>'maxCustomMoves')::integer;
        if c_moves > lim then return format('%s %s custom move%s, but at most %s %s allowed', subject, c_moves, case when c_moves = 1 then '' else 's' end, lim, case when lim = 1 then 'is' else 'are' end); end if;
    end if;
    if jsonb_typeof(r->'maxCustomAbilities') = 'number' then
        lim := (r->>'maxCustomAbilities')::integer;
        if c_abilities > lim then return format('%s %s custom %s, but at most %s %s allowed', subject, c_abilities, case when c_abilities = 1 then 'ability' else 'abilities' end, lim, case when lim = 1 then 'is' else 'are' end); end if;
    end if;
    if jsonb_typeof(r->'maxCustomTotal') = 'number' then
        lim := (r->>'maxCustomTotal')::integer;
        if c_moves + c_abilities + c_types > lim then
            return format('%s %s custom moves, abilities and types together, but at most %s %s allowed', subject, c_moves + c_abilities + c_types, lim, case when lim = 1 then 'is' else 'are' end);
        end if;
    end if;
    return null;
end;
$$;

-- ==================== lists ====================

-- an answer without its pictures: a data URI becomes "[image]", a Fakemon or
-- move keeps what lists and summaries show, and a line keeps its names
create or replace function public.event_light_answer(v jsonb)
 returns jsonb language sql immutable set search_path to 'public'
as $$
    select case jsonb_typeof(v)
        when 'string' then case when v #>> '{}' like 'data:%' then '"[image]"'::jsonb else v end
        when 'object' then jsonb_strip_nulls(jsonb_build_object(
            'name', v->'name', 'species', v->'species', 'type1', v->'type1', 'type2', v->'type2', 'kind', v->'kind',
            'type', v->'type', 'category', v->'category', 'stats', v->'stats', 'abilities', v->'abilities',
            'dexEntry1', v->'dexEntry1', 'desc', v->'desc',
            'family', case when jsonb_typeof(v->'family') = 'array' then (
                select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                    'sourceId', m->'sourceId', 'stage', m->'stage', 'isMega', m->'isMega', 'isFormeChange', m->'isFormeChange',
                    'from', m->'from', 'method', m->'method', 'face', m->'face',
                    'mon', case when m ? 'mon' then jsonb_build_object('name', m->'mon'->'name', 'type1', m->'mon'->'type1', 'type2', m->'mon'->'type2') end)))
                from jsonb_array_elements(v->'family') m) end))
        else v end;
$$;

-- event_rules_ok keeps its grants: events_guard runs it as whoever saves the event
revoke execute on function public.clean_event_mon_one(jsonb), public.clean_event_fakemon(jsonb),
    public.event_mon_problem(jsonb, jsonb, boolean), public.event_fakemon_problem(jsonb, jsonb) from public, anon, authenticated;
