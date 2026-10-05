-- Discord answers: private unless the organizer unticks it (email stays
-- private always), and entrants can edit their own entry while entries are open.

create or replace function public.event_store_entry(ev public.events, p_user uuid, p_answers jsonb, p_entry uuid default null)
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
        -- same rule as isPrivateField in js/features/events.ts
        if f->>'type' = 'email' or coalesce((f->>'private')::boolean, f->>'type' = 'discord') then
            priv := priv || jsonb_build_object(f->>'id', clean->(f->>'id'));
        else
            pub := pub || jsonb_build_object(f->>'id', clean->(f->>'id'));
        end if;
    end loop;
    if p_entry is not null then
        update public.event_entries set answers = pub where id = p_entry;
        update public.event_entry_private set answers = priv where entry_id = p_entry;
        return p_entry;
    end if;
    insert into public.event_entries(event_id, user_id, answers) values (ev.id, p_user, pub) returning id into new_id;
    insert into public.event_entry_private(entry_id, event_id, user_id, answers) values (new_id, ev.id, p_user, priv);
    return new_id;
end;
$$;
drop function public.event_store_entry(public.events, uuid, jsonb);
revoke execute on function public.event_store_entry(public.events, uuid, jsonb, uuid) from public, anon, authenticated;

-- answers only change through event_store_entry (runs as the owner)
create or replace function public.event_entries_guard()
 returns trigger language plpgsql set search_path to 'public'
as $$
begin
    new.id := old.id;
    new.event_id := old.event_id;
    new.user_id := old.user_id;
    if current_user <> 'postgres' then new.answers := old.answers; end if;
    new.created_at := old.created_at;
    return new;
end;
$$;

-- Your own entry, while the event still takes entries.
create or replace function public.update_event_entry(p_entry uuid, p_answers jsonb)
 returns uuid language plpgsql security definer set search_path to 'public'
as $$
declare
    uid uuid := auth.uid();
    ev public.events;
begin
    if uid is null then raise exception 'Sign in to edit your entry.'; end if;
    if not public.rate_limit_hit('event-entry-edit:' || uid, 60, interval '1 hour') then
        raise exception 'You''re editing too quickly. Try again in a bit.';
    end if;
    select e.* into ev from public.events e join public.event_entries en on en.event_id = e.id
        where en.id = p_entry and en.user_id = uid for update of e;
    if not found then raise exception 'That entry isn''t yours.'; end if;
    if public.event_phase(ev) <> 'open' then raise exception 'Entries are closed, so it can''t be changed now.'; end if;
    return public.event_store_entry(ev, uid, p_answers, p_entry);
end;
$$;
revoke execute on function public.update_event_entry(uuid, jsonb) from public, anon;
grant execute on function public.update_event_entry(uuid, jsonb) to authenticated;
