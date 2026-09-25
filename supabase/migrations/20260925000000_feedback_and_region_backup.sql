-- ==================== feedback & bug reports, region cloud backup ====================
-- Two additions that both reach the admin panel:
--   1. public.feedback: signed-in users send bug reports / feedback / ideas;
--      staff holding the new manage_feedback permission triage them.
--   2. Regions in the cloud backup get their own cap (cloud_regions), set as a
--      site default and raisable per badge like every other limit.
--      -1 is unlimited and 0 turns region backup off.

-- ---- region backup limit ----
alter table public.site_limits
    add column if not exists cloud_regions integer not null default 3;
alter table public.site_limits drop constraint if exists site_limits_regions_sane;
alter table public.site_limits add constraint site_limits_regions_sane check (cloud_regions >= -1);

alter table public.badges
    add column if not exists limit_cloud_regions integer,
    add column if not exists can_manage_feedback boolean not null default false;
alter table public.badges drop constraint if exists badges_regions_sane;
alter table public.badges add constraint badges_regions_sane check (limit_cloud_regions is null or limit_cloud_regions >= -1);

comment on column public.badges.limit_cloud_regions is
    'null inherits the site default, -1 is unlimited. Most generous badge wins.';

-- return type changes, so both are dropped and recreated (my_limits depends on nothing)
drop function if exists public.my_limits();
drop function if exists public.effective_limits(uuid);

create function public.effective_limits(uid uuid)
returns table (
    cloud_items              integer,
    cloud_bytes              bigint,
    community_uploads        integer,
    publish_cooldown_seconds integer,
    auto_backup              boolean,
    cloud_regions            integer
)
language sql
stable
security definer
set search_path to 'public'
as $$
    with d as (select * from public.site_limits where id),
    b as (
        select
            max(case when bb.limit_cloud_items = -1 then 2147483647
                     else bb.limit_cloud_items end)       as items,
            max(case when bb.limit_community_uploads = -1 then 2147483647
                     else bb.limit_community_uploads end) as uploads,
            min(bb.limit_publish_cooldown_seconds)        as cooldown,
            bool_or(bb.can_auto_backup)                   as auto_backup,
            max(case when bb.limit_cloud_regions = -1 then 2147483647
                     else bb.limit_cloud_regions end)     as regions
        from public.profile_badges pb
        join public.badges bb on bb.key = pb.badge_key
        where pb.user_id = uid
    )
    select
        case when b.items   = 2147483647 then -1 else coalesce(b.items,   d.cloud_items)       end,
        d.cloud_bytes,
        case when b.uploads = 2147483647 then -1 else coalesce(b.uploads, d.community_uploads) end,
        coalesce(b.cooldown, d.publish_cooldown_seconds),
        d.auto_backup_enabled and coalesce(b.auto_backup, false),
        case when b.regions = 2147483647 then -1 else coalesce(b.regions, d.cloud_regions)     end
    from d cross join b;
$$;

create function public.my_limits()
returns table (
    cloud_items              integer,
    cloud_bytes              bigint,
    community_uploads        integer,
    publish_cooldown_seconds integer,
    auto_backup              boolean,
    cloud_regions            integer
)
language sql
stable
security definer
set search_path to 'public'
as $$
    select * from public.effective_limits(auth.uid());
$$;

-- same grants as before: effective_limits stays internal
revoke all on function public.effective_limits(uuid) from public, anon, authenticated;
revoke all on function public.my_limits() from public, anon;
grant execute on function public.my_limits() to authenticated;

create or replace function public.enforce_collection_quota()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    lim       record;
    n_items   integer;
    n_regions integer;
    n_bytes   bigint;
begin
    new.updated_at := now();

    select * into lim from public.effective_limits(new.user_id);

    n_items := jsonb_array_length(new.fakemon_db)
             + jsonb_array_length(new.custom_moves)
             + jsonb_array_length(new.custom_abilities)
             + jsonb_array_length(new.custom_items);

    if lim.cloud_items <> -1 and n_items > lim.cloud_items then
        raise exception 'Cloud backup holds at most % items (Fakemon, moves, abilities and items combined). This backup has %.',
            lim.cloud_items, n_items using errcode = 'P0001';
    end if;

    select count(*) into n_regions
      from jsonb_array_elements(coalesce(new.folders, '[]'::jsonb)) as f
     where f->>'type' = 'region';

    if lim.cloud_regions <> -1 and n_regions > lim.cloud_regions then
        raise exception '%',
            case when lim.cloud_regions = 0 then 'Regions cannot be backed up to the cloud on this account.'
                 else format('Cloud backup holds at most %s region%s. This backup has %s.',
                             lim.cloud_regions, case when lim.cloud_regions = 1 then '' else 's' end, n_regions) end
            using errcode = 'P0001';
    end if;

    n_bytes := octet_length(new.fakemon_db::text)
             + octet_length(new.folders::text)
             + octet_length(new.custom_moves::text)
             + octet_length(new.custom_abilities::text)
             + octet_length(new.custom_items::text);

    if n_bytes > lim.cloud_bytes then
        raise exception 'Cloud backup is % MB, over the % MB limit. Artwork and cries are most of that size.',
            round(n_bytes / 1048576.0, 1), round(lim.cloud_bytes / 1048576.0, 1) using errcode = 'P0001';
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('id', entry->>'id', 'u', coalesce(entry->>'updatedAt', ''))), '[]'::jsonb)
      into new.manifest
      from jsonb_array_elements(new.fakemon_db) as entry
     where entry->>'id' is not null;

    return new;
end;
$function$;

-- v2 of the site-limits writer; v1 stays so an open panel keeps working
create or replace function public.admin_set_site_limits_v2(
    p_cloud_items              integer,
    p_cloud_bytes              bigint,
    p_community_uploads        integer,
    p_publish_cooldown_seconds integer,
    p_auto_backup_enabled      boolean,
    p_cloud_regions            integer
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
    if not public.has_perm(auth.uid(), 'manage_limits') then
        raise exception 'You do not have the manage limits permission';
    end if;

    update public.site_limits set
        cloud_items              = p_cloud_items,
        cloud_bytes              = p_cloud_bytes,
        community_uploads        = p_community_uploads,
        publish_cooldown_seconds = p_publish_cooldown_seconds,
        auto_backup_enabled      = p_auto_backup_enabled,
        cloud_regions            = p_cloud_regions,
        updated_at               = now()
    where id;

    perform public.mod_log(null, 'site_limits_update', 'site limits',
        jsonb_build_object(
            'cloud_items', p_cloud_items,
            'cloud_bytes', p_cloud_bytes,
            'community_uploads', p_community_uploads,
            'publish_cooldown_seconds', p_publish_cooldown_seconds,
            'auto_backup_enabled', p_auto_backup_enabled,
            'cloud_regions', p_cloud_regions));
end;
$function$;

revoke all on function public.admin_set_site_limits_v2(integer, bigint, integer, integer, boolean, integer) from public, anon;
grant execute on function public.admin_set_site_limits_v2(integer, bigint, integer, integer, boolean, integer) to authenticated;

-- ---- the manage_feedback permission ----
create or replace function public.has_perm(uid uuid, perm text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
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
$function$;

-- reading reports is staff work, so it opens the panel like the other permissions
create or replace function public.is_moderator(uid uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
    select coalesce(bool_or(b.can_delete_content or b.can_purge_content or b.can_warn
        or b.can_mute or b.can_ban or b.can_delete_users or b.can_manage_filter
        or b.can_view_ips or b.can_view_log or b.can_manage_events or b.can_manage_badges
        or b.can_manage_feedback), false)
    from public.profile_badges pb
    join public.badges b on b.key = pb.badge_key
    where pb.user_id = uid;
$function$;

create or replace function public.my_permissions()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
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
        'manage_badges',   public.has_perm(auth.uid(), 'manage_badges'),
        'manage_limits',   public.has_perm(auth.uid(), 'manage_limits'),
        'manage_feedback', public.has_perm(auth.uid(), 'manage_feedback'));
$function$;

-- the staff badges that can already see everything else get it too
update public.badges set can_manage_feedback = true where key in ('developer', 'admin', 'moderator');

-- badge editor: v3 learns manage_feedback and the region limit in place
-- (both arrive in its existing jsonb arguments, so the signature is unchanged)
create or replace function public.admin_upsert_badge_v3(p_key text, p_label text, p_icon text, p_color text, p_description text, p_rank integer, p_perms jsonb, p_limits jsonb)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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
                                'manage_events','manage_badges','manage_limits','manage_feedback']
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
        can_manage_events, can_manage_badges, can_manage_limits, can_manage_feedback, can_delete_any,
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
$function$;

-- ---- feedback & bug reports ----
create table if not exists public.feedback (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references auth.users(id) on delete cascade,
    kind        text not null default 'bug',
    title       text not null,
    body        text not null,
    page        text not null default '',
    user_agent  text not null default '',
    status      text not null default 'open',
    staff_note  text not null default '',
    handled_by  uuid references auth.users(id) on delete set null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    constraint feedback_kind_ok   check (kind in ('bug', 'feedback', 'idea')),
    constraint feedback_status_ok check (status in ('open', 'in_progress', 'resolved', 'wont_fix', 'duplicate')),
    constraint feedback_sizes_ok  check (char_length(title) between 3 and 120
                                     and char_length(body) between 10 and 4000
                                     and char_length(page) <= 300
                                     and char_length(user_agent) <= 400
                                     and char_length(staff_note) <= 2000)
);

create index if not exists feedback_user_idx on public.feedback (user_id, created_at desc);
create index if not exists feedback_status_idx on public.feedback (status, created_at desc);
create index if not exists feedback_handled_by_idx on public.feedback (handled_by);

alter table public.feedback enable row level security;

drop policy if exists "Users read their own reports; staff read all" on public.feedback;
create policy "Users read their own reports; staff read all"
    on public.feedback for select to authenticated
    using (user_id = (select auth.uid()) or public.has_perm((select auth.uid()), 'manage_feedback'));

drop policy if exists "Signed-in users file reports as themselves" on public.feedback;
create policy "Signed-in users file reports as themselves"
    on public.feedback for insert to authenticated
    with check (user_id = (select auth.uid()) and status = 'open' and staff_note = '' and handled_by is null);

drop policy if exists "Staff update reports" on public.feedback;
create policy "Staff update reports"
    on public.feedback for update to authenticated
    using (public.has_perm((select auth.uid()), 'manage_feedback'))
    with check (public.has_perm((select auth.uid()), 'manage_feedback'));

drop policy if exists "Staff delete reports" on public.feedback;
create policy "Staff delete reports"
    on public.feedback for delete to authenticated
    using (public.has_perm((select auth.uid()), 'manage_feedback'));

grant select, insert, update, delete on public.feedback to authenticated;

-- a report can't be spammed, and a suspended account can't file one (a muted
-- one can: a mute is about comments, and bugs still need reporting);
-- staff edits stamp who handled it
create or replace function public.feedback_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
    if tg_op = 'INSERT' then
        if exists (select 1 from public.profiles p where p.id = new.user_id
                   and p.banned_until is not null and p.banned_until > now()) then
            raise exception 'Your account cannot send reports right now.' using errcode = '42501';
        end if;
        if not public.rate_limit_hit('feedback:' || new.user_id::text, 5, interval '1 hour') then
            raise exception 'You have sent several reports in the last hour. Please wait a little before sending another.' using errcode = '42501';
        end if;
        new.created_at := now();
        new.updated_at := now();
        return new;
    end if;
    -- staff change the status and note, never what the user wrote
    new.user_id    := old.user_id;
    new.kind       := old.kind;
    new.title      := old.title;
    new.body       := old.body;
    new.page       := old.page;
    new.user_agent := old.user_agent;
    new.created_at := old.created_at;
    new.updated_at := now();
    new.handled_by := auth.uid();
    return new;
end;
$function$;

revoke all on function public.feedback_guard() from public, anon, authenticated;

drop trigger if exists feedback_guard on public.feedback;
create trigger feedback_guard before insert or update on public.feedback
    for each row execute function public.feedback_guard();
