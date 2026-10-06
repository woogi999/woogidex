-- A Google Sheets link for an event's votes, next to the one for its
-- submissions. Each event now has up to two links, one per kind; a votes
-- link is for the team members who see results (the same people who can
-- read event_votes), a submissions link stays with the ones who see entries.
-- worker/index.js turns event_sheet_data() into CSV either way.

alter table public.event_sheet_links add column if not exists kind text not null default 'entries';
do $$ begin
    alter table public.event_sheet_links add constraint event_sheet_links_kind_check check (kind in ('entries', 'votes'));
exception when duplicate_object then null; end $$;

-- one link per event and kind (was one per event)
alter table public.event_sheet_links drop constraint if exists event_sheet_links_pkey;
alter table public.event_sheet_links add constraint event_sheet_links_pkey primary key (event_id, kind);

drop policy if exists event_sheet_links_read on public.event_sheet_links;
drop policy if exists event_sheet_links_delete on public.event_sheet_links;
create policy event_sheet_links_read on public.event_sheet_links for select to authenticated
    using ((select public.event_can(event_id, case when kind = 'votes' then 'results' else 'entries' end)));
create policy event_sheet_links_delete on public.event_sheet_links for delete to authenticated
    using ((select public.event_can(event_id, case when kind = 'votes' then 'results' else 'entries' end)));

-- makes (or replaces, which retires the old link) the event's link of that kind
drop function if exists public.create_event_sheet_link(uuid, boolean);
create or replace function public.create_event_sheet_link(p_event uuid, p_private boolean, p_kind text default 'entries')
 returns text language plpgsql security definer set search_path to 'public'
as $$
declare
    t text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    k text := coalesce(p_kind, 'entries');
begin
    if k not in ('entries', 'votes') then raise exception 'Unknown kind of sheet.'; end if;
    if k = 'votes' and not public.event_can(p_event, 'results') then raise exception 'Only the team members who see results can link the votes to a sheet.'; end if;
    if k = 'entries' and not public.event_can(p_event, 'entries') then raise exception 'Only the team members who see entries can link a sheet.'; end if;
    insert into public.event_sheet_links(event_id, kind, token, include_private, created_by)
        values (p_event, k, t, k = 'entries' and coalesce(p_private, false), auth.uid())
        on conflict (event_id, kind) do update set token = excluded.token, include_private = excluded.include_private,
            created_by = excluded.created_by, created_at = now();
    return t;
end;
$$;
revoke execute on function public.create_event_sheet_link(uuid, boolean, text) from public, anon;
grant execute on function public.create_event_sheet_link(uuid, boolean, text) to authenticated;

-- an entry's name the way the site shows it (entryTitle in js/features/events.ts):
-- its first short answer, else its Fakemon's (or library's) name
create or replace function public.event_entry_title(p_form jsonb, p_answers jsonb)
 returns text language sql immutable set search_path to 'public'
as $$
    select coalesce((
        select case when f->>'type' = 'short' then p_answers->>(f->>'id') else p_answers->(f->>'id')->>'name' end
          from jsonb_array_elements(coalesce(p_form, '[]'::jsonb)) with ordinality as x(f, n)
         where (f->>'type' = 'short' and jsonb_typeof(p_answers->(f->>'id')) = 'string' and p_answers->>(f->>'id') <> '')
            or (f->>'type' in ('fakemon', 'library') and jsonb_typeof(p_answers->(f->>'id')) = 'object'
                and coalesce(p_answers->(f->>'id')->>'name', '') <> '')
         order by n limit 1), 'Entry');
$$;
revoke execute on function public.event_entry_title(jsonb, jsonb) from public, anon, authenticated;

-- what the sheet link serves; the token is the key
create or replace function public.event_sheet_data(p_token text)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare
    l public.event_sheet_links;
    ev public.events;
begin
    select * into l from public.event_sheet_links where token = p_token and char_length(p_token) = 64;
    if not found then return null; end if;
    select * into ev from public.events where id = l.event_id;
    if l.kind = 'votes' then
        return jsonb_build_object(
            'kind', 'votes',
            'title', ev.title,
            'criteria', coalesce(ev.criteria, '[]'::jsonb),
            'questions', (select coalesce(jsonb_agg(jsonb_build_object('id', q->>'id', 'label', q->>'label')), '[]'::jsonb)
                            from jsonb_array_elements(coalesce(ev.vote_form, '[]'::jsonb)) q
                           where q->>'type' <> 'section'),
            'votes', (select coalesce(jsonb_agg(jsonb_build_object(
                            'created_at', v.created_at,
                            'voter', coalesce('@' || vp.username, 'Voter'),
                            'entry', case when en.id is null then 'Removed entry' else public.event_entry_title(ev.form, en.answers) end,
                            'entrant', case when en.id is null then '' when en.user_id is null then 'Guest' else coalesce('@' || ep.username, 'Member') end,
                            'total', v.score,
                            'scores', coalesce(v.scores, '{}'::jsonb),
                            'answers', (select coalesce(jsonb_object_agg(x.k, public.event_sheet_cell(x.v)), '{}'::jsonb)
                                          from jsonb_each(coalesce(v.answers, '{}'::jsonb)) x(k, v)),
                            'remarks', coalesce(v.remarks, ''))
                            order by v.created_at), '[]'::jsonb)
                        from public.event_votes v
                        left join public.event_entries en on en.id = v.entry_id
                        left join public.profiles vp on vp.id = v.voter_id
                        left join public.profiles ep on ep.id = en.user_id
                       where v.event_id = l.event_id));
    end if;
    return jsonb_build_object(
        'kind', 'entries',
        'title', ev.title,
        'questions', (select coalesce(jsonb_agg(jsonb_build_object('id', f->>'id', 'label', f->>'label')), '[]'::jsonb)
                        from jsonb_array_elements(ev.form) f
                       where f->>'type' <> 'section'
                         and (l.include_private or not (f->>'type' = 'email' or coalesce((f->>'private')::boolean, f->>'type' = 'discord')))),
        'entries', (select coalesce(jsonb_agg(jsonb_build_object(
                        'id', en.id, 'created_at', en.created_at, 'placement', en.placement,
                        'entrant', case when en.user_id is null then 'Guest' else coalesce('@' || pr.username, 'Member') end,
                        'answers', (select coalesce(jsonb_object_agg(x.k, public.event_sheet_cell(x.v)), '{}'::jsonb)
                                      from jsonb_each(en.answers || case when l.include_private then coalesce(p.answers, '{}'::jsonb) else '{}'::jsonb end) x(k, v)))
                        order by en.created_at), '[]'::jsonb)
                      from public.event_entries en
                      left join public.event_entry_private p on p.entry_id = en.id
                      left join public.profiles pr on pr.id = en.user_id
                     where en.event_id = l.event_id));
end;
$$;
revoke execute on function public.event_sheet_data(text) from public;
grant execute on function public.event_sheet_data(text) to anon, authenticated;
