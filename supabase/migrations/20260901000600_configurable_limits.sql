-- ==================== configurable limits ====================
-- Cloud-backup size, upload cap and publish cooldown used to be constants
-- compiled into trigger functions, requiring a migration to change and giving
-- no way to vary them per group. Now: one row of site-wide defaults plus
-- optional per-badge overrides, set from the admin panel.
--
-- Two sentinels on per-badge columns: null = inherit (doesn't participate in
-- the cap), -1 = unlimited.
--
-- Stacking is most-generous-wins across held badges: highest cap, shortest
-- cooldown, unlimited beats any number.

-- ---- site-wide defaults ----
-- id fixed to true so a second row of defaults is a constraint violation, not a silent tiebreak.
create table if not exists public.site_limits (
    id                        boolean primary key default true,
    cloud_items               integer not null default 60,
    cloud_bytes               bigint  not null default 5 * 1024 * 1024,
    community_uploads         integer not null default 20,
    publish_cooldown_seconds  integer not null default 3600,
    auto_backup_enabled       boolean not null default false,
    updated_at                timestamptz not null default now(),
    constraint site_limits_single_row check (id),
    constraint site_limits_sane check (
        cloud_items >= -1 and cloud_bytes > 0
        and community_uploads >= -1 and publish_cooldown_seconds >= 0
    )
);

insert into public.site_limits (id) values (true) on conflict (id) do nothing;

alter table public.site_limits enable row level security;

-- Readable by anyone: shown on the backup meters and in Settings, not secret.
drop policy if exists "Anyone can read the site limits" on public.site_limits;
create policy "Anyone can read the site limits"
    on public.site_limits for select to anon, authenticated using (true);
-- No write policy; writes go through admin_set_site_limits(), which checks the permission itself.

-- ---- per-badge overrides ----
alter table public.badges
    add column if not exists limit_cloud_items              integer,
    add column if not exists limit_community_uploads        integer,
    add column if not exists limit_publish_cooldown_seconds integer,
    add column if not exists can_auto_backup                boolean not null default false,
    add column if not exists can_manage_limits              boolean not null default false;

alter table public.badges drop constraint if exists badges_limits_sane;
alter table public.badges add constraint badges_limits_sane check (
    (limit_cloud_items              is null or limit_cloud_items              >= -1) and
    (limit_community_uploads        is null or limit_community_uploads        >= -1) and
    (limit_publish_cooldown_seconds is null or limit_publish_cooldown_seconds >= 0)
);

comment on column public.badges.limit_cloud_items is
    'null inherits the site default, -1 is unlimited. Most generous badge wins.';
comment on column public.badges.limit_community_uploads is
    'null inherits the site default, -1 is unlimited. Most generous badge wins.';
comment on column public.badges.limit_publish_cooldown_seconds is
    'null inherits the site default, 0 removes the cooldown. Shortest badge wins.';

-- ---- resolving one user's limits ----
-- SECURITY DEFINER: called by the triggers below on behalf of someone who
-- cannot read other people's badge rows.
create or replace function public.effective_limits(uid uuid)
returns table (
    cloud_items              integer,
    cloud_bytes              bigint,
    community_uploads        integer,
    publish_cooldown_seconds integer,
    auto_backup              boolean
)
language sql
stable
security definer
set search_path to 'public'
as $$
    with d as (select * from public.site_limits where id),
    b as (
        select
            -- -1 (unlimited) ranked above every real number so it always wins; folded back to -1 below
            max(case when bb.limit_cloud_items = -1 then 2147483647
                     else bb.limit_cloud_items end)       as items,
            max(case when bb.limit_community_uploads = -1 then 2147483647
                     else bb.limit_community_uploads end) as uploads,
            min(bb.limit_publish_cooldown_seconds)        as cooldown,
            bool_or(bb.can_auto_backup)                   as auto_backup
        from public.profile_badges pb
        join public.badges bb on bb.key = pb.badge_key
        where pb.user_id = uid
    )
    select
        case when b.items   = 2147483647 then -1 else coalesce(b.items,   d.cloud_items)       end,
        d.cloud_bytes,
        case when b.uploads = 2147483647 then -1 else coalesce(b.uploads, d.community_uploads) end,
        coalesce(b.cooldown, d.publish_cooldown_seconds),
        d.auto_backup_enabled and coalesce(b.auto_backup, false)
    from d cross join b;
$$;

-- What the signed-in user is allowed, for the meters and the Settings toggle.
create or replace function public.my_limits()
returns table (
    cloud_items              integer,
    cloud_bytes              bigint,
    community_uploads        integer,
    publish_cooldown_seconds integer,
    auto_backup              boolean
)
language sql
stable
security definer
set search_path to 'public'
as $$
    select * from public.effective_limits(auth.uid());
$$;

grant execute on function public.effective_limits(uuid) to authenticated;
grant execute on function public.my_limits() to authenticated;

-- ---- the quota triggers, now reading those numbers ----
create or replace function public.enforce_collection_quota()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    lim     record;
    n_items integer;
    n_bytes bigint;
begin
    new.updated_at := now();

    select * into lim from public.effective_limits(new.user_id);

    n_items := jsonb_array_length(new.fakemon_db)
             + jsonb_array_length(new.custom_moves)
             + jsonb_array_length(new.custom_abilities)
             + jsonb_array_length(new.custom_items);

    -- -1 is unlimited, so skip the check rather than compare against it
    if lim.cloud_items <> -1 and n_items > lim.cloud_items then
        raise exception 'Cloud backup holds at most % items (Fakemon, moves, abilities and items combined). This backup has %.',
            lim.cloud_items, n_items using errcode = 'P0001';
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

create or replace function public.published_mons_enforce_cooldown()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    lim record;
    n   integer;
begin
    new.published_at := now();

    select * into lim from public.effective_limits(new.user_id);

    -- A zero cooldown skips the lookup rather than querying for rows published in the last zero seconds.
    if lim.publish_cooldown_seconds > 0 and exists (
        select 1
        from public.published_mons
        where user_id = new.user_id
          and published_at > now() - make_interval(secs => lim.publish_cooldown_seconds)
          and (new.family_id is null or family_id is distinct from new.family_id)
    ) then
        raise exception 'You can only publish once every %.',
            case when lim.publish_cooldown_seconds >= 3600
                 then (lim.publish_cooldown_seconds / 3600) || ' hour(s)'
                 else greatest(1, lim.publish_cooldown_seconds / 60) || ' minute(s)' end
            using errcode = '42501';
    end if;

    if lim.community_uploads <> -1 then
        select count(*) into n from public.published_mons where user_id = new.user_id;
        if n >= lim.community_uploads then
            raise exception 'You have reached the limit of % community uploads. Delete one of your listings to publish something new.',
                lim.community_uploads using errcode = '42501';
        end if;
    end if;

    return new;
end;
$function$;
