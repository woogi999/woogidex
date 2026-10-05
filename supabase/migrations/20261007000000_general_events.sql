-- General-purpose events (poster competitions, mascot contests, ...), run
-- from the Community Hub instead of the admin panel. Replaces the
-- Fakemon-only contest_* tables (left in place, unused; drop them once this
-- is deployed).
--
-- Who can do what:
--   * create_events (badge permission): create events; you own what you make.
--   * owner: everything on their event, including who helps and how.
--   * helpers: per-event grants -- edit, entries, judge, results.
--   * manage_events (badge permission): site staff, everything on every event.
-- Entrants write only through submit_event_entry() and cast_event_vote(),
-- which validate against the event's own form and rules. Answers to fields
-- marked private (email and Discord always are) live in a separate table only
-- the entrant and helpers with `entries` can read.

-- ==================== the organizer permission ====================

alter table public.badges add column if not exists can_create_events boolean not null default false;

create or replace function public.has_perm(uid uuid, perm text)
 returns boolean language sql stable security definer set search_path to 'public'
as $$
    select case when perm = 'staff' then public.is_moderator(uid)
    else coalesce((select bool_or(
        case perm
            when 'delete_content'  then b.can_delete_content
            when 'purge_content'   then b.can_purge_content
            when 'warn'            then b.can_warn
            when 'mute'            then b.can_mute
            when 'ban'             then b.can_ban
            when 'delete_users'    then b.can_delete_users
            when 'manage_filter'   then b.can_manage_filter
            when 'view_ips'        then b.can_view_ips
            when 'view_log'        then b.can_view_log
            when 'manage_events'   then b.can_manage_events
            when 'create_events'   then b.can_create_events or b.can_manage_events
            when 'manage_badges'   then b.can_manage_badges
            when 'manage_limits'   then b.can_manage_limits
            when 'manage_feedback' then b.can_manage_feedback
            when 'auto_backup'     then b.can_auto_backup
            else false
        end)
        from public.profile_badges pb
        join public.badges b on b.key = pb.badge_key
        where pb.user_id = uid), false)
    end;
$$;

create or replace function public.my_permissions()
 returns jsonb language sql stable security definer set search_path to 'public'
as $$
    select jsonb_build_object(
        'rank',            public.my_badge_rank(auth.uid()),
        'staff',           public.is_moderator(auth.uid()),
        'delete_content',  public.has_perm(auth.uid(), 'delete_content'),
        'purge_content',   public.has_perm(auth.uid(), 'purge_content'),
        'warn',            public.has_perm(auth.uid(), 'warn'),
        'mute',            public.has_perm(auth.uid(), 'mute'),
        'ban',             public.has_perm(auth.uid(), 'ban'),
        'delete_users',    public.has_perm(auth.uid(), 'delete_users'),
        'manage_filter',   public.has_perm(auth.uid(), 'manage_filter'),
        'view_ips',        public.has_perm(auth.uid(), 'view_ips'),
        'view_log',        public.has_perm(auth.uid(), 'view_log'),
        'manage_events',   public.has_perm(auth.uid(), 'manage_events'),
        'create_events',   public.has_perm(auth.uid(), 'create_events'),
        'manage_badges',   public.has_perm(auth.uid(), 'manage_badges'),
        'manage_limits',   public.has_perm(auth.uid(), 'manage_limits'),
        'manage_feedback', public.has_perm(auth.uid(), 'manage_feedback'));
$$;

-- the badge editor's save: same as before, plus create_events
create or replace function public.admin_upsert_badge_v3(p_key text, p_label text, p_icon text, p_color text, p_description text, p_rank integer, p_perms jsonb, p_limits jsonb)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare
    my_rank int := public.my_badge_rank(auth.uid());
    perm text;
    v_items    integer := nullif(p_limits->>'cloud_items', '')::integer;
    v_uploads  integer := nullif(p_limits->>'community_uploads', '')::integer;
    v_cooldown integer := nullif(p_limits->>'publish_cooldown_seconds', '')::integer;
    v_regions  integer := nullif(p_limits->>'cloud_regions', '')::integer;
    v_auto     boolean := coalesce((p_limits->>'auto_backup')::boolean, false);
begin
    if not public.has_perm(auth.uid(), 'manage_badges') then
        raise exception 'You do not have the manage badges permission';
    end if;
    if p_rank >= my_rank then
        raise exception 'Cannot create or edit a badge at or above your own rank';
    end if;
    if exists (select 1 from public.badges where key = p_key and rank >= my_rank) then
        raise exception 'Cannot edit a badge at or above your own rank';
    end if;

    foreach perm in array array['delete_content','purge_content','warn','mute','ban',
                                'delete_users','manage_filter','view_ips','view_log',
                                'manage_events','create_events','manage_badges','manage_limits','manage_feedback']
    loop
        if coalesce((p_perms->>perm)::boolean, false)
           and not public.has_perm(auth.uid(), perm) then
            raise exception 'Cannot grant a permission you do not hold: %',
                replace(perm, '_', ' ');
        end if;
    end loop;

    if not public.has_perm(auth.uid(), 'manage_limits')
       and exists (
           select 1 from public.badges b where b.key = p_key
           and (b.limit_cloud_items              is distinct from v_items
             or b.limit_community_uploads        is distinct from v_uploads
             or b.limit_publish_cooldown_seconds is distinct from v_cooldown
             or b.limit_cloud_regions            is distinct from v_regions
             or b.can_auto_backup                is distinct from v_auto)
       ) then
        raise exception 'You do not have the manage limits permission, so you cannot change this badge''s limits';
    end if;
    if not public.has_perm(auth.uid(), 'manage_limits')
       and not exists (select 1 from public.badges where key = p_key)
       and (v_items is not null or v_uploads is not null
            or v_cooldown is not null or v_regions is not null or v_auto) then
        raise exception 'You do not have the manage limits permission, so you cannot create a badge that carries limits';
    end if;

    insert into public.badges (key, label, icon, color, description, rank,
        can_delete_content, can_purge_content, can_warn, can_mute, can_ban,
        can_delete_users, can_manage_filter, can_view_ips, can_view_log,
        can_manage_events, can_create_events, can_manage_badges, can_manage_limits, can_manage_feedback, can_delete_any,
        limit_cloud_items, limit_community_uploads, limit_publish_cooldown_seconds,
        limit_cloud_regions, can_auto_backup)
    values (p_key, p_label, coalesce(nullif(p_icon,''),'star'), coalesce(nullif(p_color,''),'#6b7280'),
        coalesce(p_description,''), p_rank,
        coalesce((p_perms->>'delete_content')::boolean, false),
        coalesce((p_perms->>'purge_content')::boolean, false),
        coalesce((p_perms->>'warn')::boolean, false),
        coalesce((p_perms->>'mute')::boolean, false),
        coalesce((p_perms->>'ban')::boolean, false),
        coalesce((p_perms->>'delete_users')::boolean, false),
        coalesce((p_perms->>'manage_filter')::boolean, false),
        coalesce((p_perms->>'view_ips')::boolean, false),
        coalesce((p_perms->>'view_log')::boolean, false),
        coalesce((p_perms->>'manage_events')::boolean, false),
        coalesce((p_perms->>'create_events')::boolean, false),
        coalesce((p_perms->>'manage_badges')::boolean, false),
        coalesce((p_perms->>'manage_limits')::boolean, false),
        coalesce((p_perms->>'manage_feedback')::boolean, false),
        coalesce((p_perms->>'delete_content')::boolean, false),
        v_items, v_uploads, v_cooldown, v_regions, v_auto)
    on conflict (key) do update set
        label = excluded.label, icon = excluded.icon, color = excluded.color,
        description = excluded.description, rank = excluded.rank,
        can_delete_content  = excluded.can_delete_content,
        can_purge_content   = excluded.can_purge_content,
        can_warn            = excluded.can_warn,
        can_mute            = excluded.can_mute,
        can_ban             = excluded.can_ban,
        can_delete_users    = excluded.can_delete_users,
        can_manage_filter   = excluded.can_manage_filter,
        can_view_ips        = excluded.can_view_ips,
        can_view_log        = excluded.can_view_log,
        can_manage_events   = excluded.can_manage_events,
        can_create_events   = excluded.can_create_events,
        can_manage_badges   = excluded.can_manage_badges,
        can_manage_limits   = excluded.can_manage_limits,
        can_manage_feedback = excluded.can_manage_feedback,
        can_delete_any      = excluded.can_delete_any,
        limit_cloud_items              = excluded.limit_cloud_items,
        limit_community_uploads        = excluded.limit_community_uploads,
        limit_publish_cooldown_seconds = excluded.limit_publish_cooldown_seconds,
        limit_cloud_regions            = excluded.limit_cloud_regions,
        can_auto_backup                = excluded.can_auto_backup;

    perform public.mod_log(null, 'badge_upsert', p_label,
        jsonb_build_object('key', p_key, 'rank', p_rank,
                           'perms', p_perms, 'limits', p_limits));
end;
$$;

-- ==================== tables ====================

create table public.events (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete cascade,
    title text not null check (char_length(title) between 3 and 120),
    tagline text not null default '' check (char_length(tagline) <= 200),
    description text not null default '' check (char_length(description) <= 8000),
    category text not null default '' check (char_length(category) <= 40),
    accent text not null default '' check (accent ~ '^(#[0-9a-fA-F]{6})?$'),
    cover_image text check (cover_image is null or (char_length(cover_image) <= 600000
        and cover_image ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$')),
    phase text not null default 'draft' check (phase in ('draft', 'open', 'voting', 'ended')),
    submissions_close_at timestamptz,
    voting_close_at timestamptz,
    form jsonb not null default '[]'::jsonb,
    voting text not null default 'community' check (voting in ('none', 'community', 'judges')),
    votes_per_user smallint not null default 3 check (votes_per_user between 1 and 50),
    max_entries_per_user smallint not null default 1 check (max_entries_per_user between 1 and 20),
    live_results boolean not null default false,
    show_entries boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index events_owner_idx on public.events(owner_id);

create table public.event_helpers (
    event_id uuid not null references public.events(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    can_edit boolean not null default false,
    can_entries boolean not null default false,
    can_judge boolean not null default false,
    can_results boolean not null default true,
    added_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    primary key (event_id, user_id)
);
create index event_helpers_user_idx on public.event_helpers(user_id);

create table public.event_entries (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    answers jsonb not null default '{}'::jsonb,
    placement smallint check (placement between 1 and 100),
    created_at timestamptz not null default now()
);
create index event_entries_event_idx on public.event_entries(event_id);
create index event_entries_user_idx on public.event_entries(user_id);

create table public.event_entry_private (
    entry_id uuid primary key references public.event_entries(id) on delete cascade,
    event_id uuid not null references public.events(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    answers jsonb not null default '{}'::jsonb
);
create index event_entry_private_event_idx on public.event_entry_private(event_id);
create index event_entry_private_user_idx on public.event_entry_private(user_id);

create table public.event_votes (
    entry_id uuid not null references public.event_entries(id) on delete cascade,
    voter_id uuid not null references auth.users(id) on delete cascade,
    event_id uuid not null references public.events(id) on delete cascade,
    score smallint not null check (score between 1 and 10),
    created_at timestamptz not null default now(),
    primary key (entry_id, voter_id)
);
create index event_votes_event_voter_idx on public.event_votes(event_id, voter_id);
create index event_votes_voter_idx on public.event_votes(voter_id);

-- ==================== who may do what ====================

-- p_perm: 'view' (any helper), 'edit', 'entries', 'judge', 'results', or
-- 'owner' (managing helpers, deleting the event)
create or replace function public.event_can(p_event uuid, p_perm text)
 returns boolean language sql stable security definer set search_path to 'public'
as $$
    select auth.uid() is not null and (
        exists (select 1 from public.events e where e.id = p_event and e.owner_id = auth.uid())
        or public.has_perm(auth.uid(), 'manage_events')
        or (p_perm <> 'owner' and exists (
            select 1 from public.event_helpers h
            where h.event_id = p_event and h.user_id = auth.uid()
              and case p_perm
                    when 'view'    then true
                    when 'edit'    then h.can_edit
                    when 'entries' then h.can_entries
                    when 'judge'   then h.can_judge
                    when 'results' then h.can_results
                    else false
                  end)));
$$;
-- anon too: the read policies call it, and it answers false without a session
revoke execute on function public.event_can(uuid, text) from public;
grant execute on function public.event_can(uuid, text) to anon, authenticated;

-- An event is public once it leaves draft; its entries once the organizer
-- shows them or voting starts.
create or replace function public.event_entries_visible(p_event uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $$
    select exists (select 1 from public.events e where e.id = p_event and e.phase <> 'draft'
                   and (e.show_entries or e.phase in ('voting', 'ended')));
$$;

-- ==================== keeping rows honest ====================

-- The form is what entrants are validated against, so its shape is checked
-- here rather than trusted from the editor.
create or replace function public.events_guard()
 returns trigger language plpgsql set search_path to 'public'
as $$
declare
    f jsonb;
    ids text[] := '{}';
begin
    if tg_op = 'UPDATE' then
        new.owner_id := old.owner_id;
        new.created_at := old.created_at;
    end if;
    new.updated_at := now();
    if jsonb_typeof(new.form) <> 'array' or jsonb_array_length(new.form) > 25 then
        raise exception 'A form has at most 25 questions.';
    end if;
    for f in select * from jsonb_array_elements(new.form) loop
        if jsonb_typeof(f) <> 'object'
           or coalesce(f->>'id', '') !~ '^[a-z0-9_-]{1,24}$'
           or (f->>'id') = any(ids)
           or coalesce(f->>'type', '') not in ('short', 'long', 'url', 'email', 'discord', 'choice', 'image', 'fakemon', 'agree')
           or char_length(coalesce(f->>'label', '')) not between 1 and 120
           or char_length(coalesce(f->>'help', '')) > 300
           or (f ? 'options' and (jsonb_typeof(f->'options') <> 'array' or jsonb_array_length(f->'options') > 20))
           or (f->>'type' = 'choice' and jsonb_array_length(coalesce(f->'options', '[]'::jsonb)) < 2) then
            raise exception 'One of the form questions is not valid: %', coalesce(f->>'label', '(untitled)');
        end if;
        ids := ids || (f->>'id');
    end loop;
    return new;
end;
$$;
create trigger events_guard before insert or update on public.events
    for each row execute function public.events_guard();

create or replace function public.event_helpers_guard()
 returns trigger language plpgsql set search_path to 'public'
as $$
begin
    if exists (select 1 from public.events e where e.id = new.event_id and e.owner_id = new.user_id) then
        raise exception 'The organizer already has every permission.';
    end if;
    if tg_op = 'UPDATE' then
        new.event_id := old.event_id;
        new.user_id := old.user_id;
        new.added_by := old.added_by;
        new.created_at := old.created_at;
    else
        new.added_by := auth.uid();
    end if;
    return new;
end;
$$;
create trigger event_helpers_guard before insert or update on public.event_helpers
    for each row execute function public.event_helpers_guard();

-- placement is the only column anyone updates on an entry directly
create or replace function public.event_entries_guard()
 returns trigger language plpgsql set search_path to 'public'
as $$
begin
    new.id := old.id;
    new.event_id := old.event_id;
    new.user_id := old.user_id;
    new.answers := old.answers;
    new.created_at := old.created_at;
    return new;
end;
$$;
create trigger event_entries_guard before update on public.event_entries
    for each row execute function public.event_entries_guard();

-- ==================== row level security ====================

alter table public.events enable row level security;
alter table public.event_helpers enable row level security;
alter table public.event_entries enable row level security;
alter table public.event_entry_private enable row level security;
alter table public.event_votes enable row level security;

create policy events_read on public.events for select to anon, authenticated
    using (phase <> 'draft' or (select public.event_can(id, 'view')));
create policy events_insert on public.events for insert to authenticated
    with check (owner_id = (select auth.uid()) and (select public.has_perm(auth.uid(), 'create_events')));
create policy events_update on public.events for update to authenticated
    using ((select public.event_can(id, 'edit'))) with check ((select public.event_can(id, 'edit')));
create policy events_delete on public.events for delete to authenticated
    using ((select public.event_can(id, 'owner')));

create policy event_helpers_read on public.event_helpers for select to authenticated
    using (user_id = (select auth.uid()) or (select public.event_can(event_id, 'view')));
create policy event_helpers_insert on public.event_helpers for insert to authenticated
    with check ((select public.event_can(event_id, 'owner')));
create policy event_helpers_update on public.event_helpers for update to authenticated
    using ((select public.event_can(event_id, 'owner'))) with check ((select public.event_can(event_id, 'owner')));
create policy event_helpers_delete on public.event_helpers for delete to authenticated
    using ((select public.event_can(event_id, 'owner')) or user_id = (select auth.uid()));

create policy event_entries_read on public.event_entries for select to anon, authenticated
    using (user_id = (select auth.uid()) or (select public.event_entries_visible(event_id))
           or (select public.event_can(event_id, 'entries')) or (select public.event_can(event_id, 'judge'))
           or (select public.event_can(event_id, 'results')));
create policy event_entries_placement on public.event_entries for update to authenticated
    using ((select public.event_can(event_id, 'edit'))) with check ((select public.event_can(event_id, 'edit')));
create policy event_entries_delete on public.event_entries for delete to authenticated
    using ((select public.event_can(event_id, 'entries'))
           or (user_id = (select auth.uid()) and exists (select 1 from public.events e where e.id = event_id and e.phase = 'open')));

create policy event_entry_private_read on public.event_entry_private for select to authenticated
    using (user_id = (select auth.uid()) or (select public.event_can(event_id, 'entries')));

create policy event_votes_read on public.event_votes for select to authenticated
    using (voter_id = (select auth.uid()) or (select public.event_can(event_id, 'results')));

-- Supabase grants everything on new tables by default; start from nothing.
-- Entries, private answers and votes are only ever written by the functions below.
revoke all on public.events, public.event_helpers, public.event_entries, public.event_entry_private, public.event_votes from anon, authenticated;
grant select on public.events, public.event_entries to anon;
grant select, insert, update, delete on public.events, public.event_helpers to authenticated;
grant select, delete on public.event_entries to authenticated;
grant update (placement) on public.event_entries to authenticated;
grant select on public.event_entry_private, public.event_votes to authenticated;

-- ==================== entering ====================

create or replace function public.submit_event_entry(p_event uuid, p_answers jsonb)
 returns uuid language plpgsql security definer set search_path to 'public'
as $$
declare
    uid uuid := auth.uid();
    ev public.events;
    f jsonb;
    v jsonb;
    s text;
    pub jsonb := '{}'::jsonb;
    priv jsonb := '{}'::jsonb;
    is_private boolean;
    entry_id uuid;
begin
    if uid is null then raise exception 'Sign in to enter.'; end if;
    if exists (select 1 from public.profiles p where p.id = uid
               and ((p.banned_until is not null and p.banned_until > now())
                 or (p.muted_until is not null and p.muted_until > now()))) then
        raise exception 'Your account cannot enter events right now.';
    end if;
    select * into ev from public.events where id = p_event for update;
    if not found or ev.phase <> 'open' or (ev.submissions_close_at is not null and now() > ev.submissions_close_at) then
        raise exception 'This event is not taking entries.';
    end if;
    if (select count(*) from public.event_entries e where e.event_id = p_event and e.user_id = uid) >= ev.max_entries_per_user then
        raise exception 'You have used all % of your entries for this event.', ev.max_entries_per_user;
    end if;
    if jsonb_typeof(p_answers) <> 'object' then raise exception 'Answers must be an object.'; end if;
    if pg_column_size(p_answers) > 3000000 then raise exception 'That entry is too large. Use smaller images.'; end if;

    for f in select * from jsonb_array_elements(ev.form) loop
        v := p_answers -> (f->>'id');
        if v is null or v = 'null'::jsonb or v = '""'::jsonb or v = 'false'::jsonb then
            if coalesce((f->>'required')::boolean, false) then
                raise exception 'Please answer: %', f->>'label';
            end if;
            continue;
        end if;
        case f->>'type'
            when 'agree' then
                if v <> 'true'::jsonb then raise exception 'Please answer: %', f->>'label'; end if;
            when 'fakemon' then
                if jsonb_typeof(v) <> 'object' then raise exception 'Invalid answer for: %', f->>'label'; end if;
                -- only what is shown; never the whole saved Fakemon
                v := jsonb_strip_nulls(jsonb_build_object(
                    'name', left(v->>'name', 80), 'species', left(v->>'species', 80),
                    'type1', left(v->>'type1', 20), 'type2', left(v->>'type2', 20),
                    'description', left(v->>'description', 1000),
                    'artwork', case when char_length(v->>'artwork') <= 1500000
                                     and v->>'artwork' ~ '^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$'
                                    then v->>'artwork' end));
                if coalesce(v->>'name', '') = '' then raise exception 'Invalid answer for: %', f->>'label'; end if;
            else
                if jsonb_typeof(v) <> 'string' then raise exception 'Invalid answer for: %', f->>'label'; end if;
                s := btrim(v #>> '{}');
                if s = '' then
                    if coalesce((f->>'required')::boolean, false) then raise exception 'Please answer: %', f->>'label'; end if;
                    continue;
                end if;
                if (f->>'type' = 'short' and char_length(s) > 200)
                   or (f->>'type' = 'long' and char_length(s) > 4000)
                   or (f->>'type' = 'url' and (char_length(s) > 500 or s !~* '^https?://[^\s]+$'))
                   or (f->>'type' = 'email' and (char_length(s) > 254 or s !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'))
                   or (f->>'type' = 'discord' and (char_length(s) > 40 or s !~ '^[A-Za-z0-9_.#]{2,40}$'))
                   or (f->>'type' = 'choice' and not (coalesce(f->'options', '[]'::jsonb) ? s))
                   or (f->>'type' = 'image' and (char_length(s) > 1500000
                        or s !~ '^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$')) then
                    raise exception 'Invalid answer for: %', f->>'label';
                end if;
                v := to_jsonb(s);
        end case;
        is_private := f->>'type' in ('email', 'discord') or coalesce((f->>'private')::boolean, false);
        if is_private then priv := priv || jsonb_build_object(f->>'id', v);
        else pub := pub || jsonb_build_object(f->>'id', v); end if;
    end loop;

    insert into public.event_entries(event_id, user_id, answers) values (p_event, uid, pub) returning id into entry_id;
    insert into public.event_entry_private(entry_id, event_id, user_id, answers) values (entry_id, p_event, uid, priv);
    return entry_id;
end;
$$;

-- ==================== voting ====================

-- community: a vote is a 1, and you have votes_per_user of them to spread.
-- judges: helpers with `judge` score each entry 1-10. Calling again replaces
-- your score; p_score null takes your vote back.
create or replace function public.cast_event_vote(p_entry uuid, p_score integer)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare
    uid uuid := auth.uid();
    ev public.events;
    en public.event_entries;
begin
    if uid is null then raise exception 'Sign in to vote.'; end if;
    select * into en from public.event_entries where id = p_entry;
    if not found then raise exception 'That entry no longer exists.'; end if;
    select * into ev from public.events where id = en.event_id;
    if ev.phase <> 'voting' or (ev.voting_close_at is not null and now() > ev.voting_close_at) then
        raise exception 'Voting is not open.';
    end if;
    if p_score is null then
        delete from public.event_votes where entry_id = p_entry and voter_id = uid;
        return;
    end if;
    if ev.voting = 'none' then raise exception 'This event has no voting.'; end if;
    if en.user_id = uid then raise exception 'You cannot vote for your own entry.'; end if;
    if ev.voting = 'judges' then
        if not public.event_can(ev.id, 'judge') then raise exception 'Only this event''s judges can score entries.'; end if;
        if p_score not between 1 and 10 then raise exception 'Scores go from 1 to 10.'; end if;
    else
        if exists (select 1 from public.profiles p where p.id = uid
                   and p.banned_until is not null and p.banned_until > now()) then
            raise exception 'Your account cannot vote right now.';
        end if;
        if p_score <> 1 then raise exception 'Invalid vote.'; end if;
        -- serialise one voter's votes on this event so two tabs can't overspend
        perform pg_advisory_xact_lock(hashtext(uid::text || ev.id::text));
        if not exists (select 1 from public.event_votes where entry_id = p_entry and voter_id = uid)
           and (select count(*) from public.event_votes where event_id = ev.id and voter_id = uid) >= ev.votes_per_user then
            raise exception 'You have used all % of your votes.', ev.votes_per_user;
        end if;
    end if;
    insert into public.event_votes(entry_id, voter_id, event_id, score) values (p_entry, uid, ev.id, p_score)
        on conflict (entry_id, voter_id) do update set score = excluded.score, created_at = now();
end;
$$;

-- Tallies: organizers and helpers with `results` always; everyone else once
-- the event has ended, or during voting when live results are on.
create or replace function public.get_event_results(p_event uuid)
 returns table(entry_id uuid, votes bigint, score_total bigint, score_avg numeric)
 language plpgsql stable security definer set search_path to 'public'
as $$
begin
    if not (public.event_can(p_event, 'results') or exists (
        select 1 from public.events e where e.id = p_event
          and (e.phase = 'ended' or (e.phase = 'voting' and e.live_results)))) then
        raise exception 'Results are not public yet.';
    end if;
    return query
        select en.id, count(v.voter_id), coalesce(sum(v.score), 0)::bigint, round(coalesce(avg(v.score), 0), 2)
        from public.event_entries en
        left join public.event_votes v on v.entry_id = en.id
        where en.event_id = p_event
        group by en.id;
end;
$$;

revoke execute on function public.submit_event_entry(uuid, jsonb), public.cast_event_vote(uuid, integer) from public, anon;
grant execute on function public.submit_event_entry(uuid, jsonb), public.cast_event_vote(uuid, integer) to authenticated;
revoke execute on function public.get_event_results(uuid) from public;
grant execute on function public.get_event_results(uuid) to anon, authenticated;
revoke execute on function public.event_entries_visible(uuid) from public;
grant execute on function public.event_entries_visible(uuid) to anon, authenticated;
revoke execute on function public.events_guard(), public.event_helpers_guard(), public.event_entries_guard() from public, anon, authenticated;
