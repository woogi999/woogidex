-- ==================== managing limits from the admin panel ====================
-- Writing limits is its own permission, separate from manage_badges: one hands
-- out cosmetics/staff powers, the other decides what the server accepts from
-- an account. Keeps a badge moderator from minting themselves unlimited quota.

-- has_perm() answers to the new name.
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
            when 'delete_content' then b.can_delete_content
            when 'purge_content'  then b.can_purge_content
            when 'warn'           then b.can_warn
            when 'mute'           then b.can_mute
            when 'ban'            then b.can_ban
            when 'delete_users'   then b.can_delete_users
            when 'manage_filter'  then b.can_manage_filter
            when 'view_ips'       then b.can_view_ips
            when 'view_log'       then b.can_view_log
            when 'manage_events'  then b.can_manage_events
            when 'manage_badges'  then b.can_manage_badges
            when 'manage_limits'  then b.can_manage_limits
            when 'auto_backup'    then b.can_auto_backup
            else false
        end)
        from public.profile_badges pb
        join public.badges b on b.key = pb.badge_key
        where pb.user_id = uid), false)
    end;
$function$;

-- is_moderator() deliberately does NOT gain manage_limits or auto_backup: a
-- badge granting a bigger backup must not turn its holder into staff.

-- The admin panel reads its capabilities from here, so a permission missing
-- below never gets a control in the panel.
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
        'manage_limits',   public.has_perm(auth.uid(), 'manage_limits'));
$function$;

-- ---- site-wide defaults ----
create or replace function public.admin_set_site_limits(
    p_cloud_items              integer,
    p_cloud_bytes              bigint,
    p_community_uploads        integer,
    p_publish_cooldown_seconds integer,
    p_auto_backup_enabled      boolean
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
        updated_at               = now()
    where id;

    perform public.mod_log(null, 'site_limits_update', 'site limits',
        jsonb_build_object(
            'cloud_items', p_cloud_items,
            'cloud_bytes', p_cloud_bytes,
            'community_uploads', p_community_uploads,
            'publish_cooldown_seconds', p_publish_cooldown_seconds,
            'auto_backup_enabled', p_auto_backup_enabled));
end;
$function$;

grant execute on function public.admin_set_site_limits(integer, bigint, integer, integer, boolean) to authenticated;

-- ---- badges, now carrying limits ----
-- v3 rather than editing v2 in place, so a tab left open across the deploy
-- keeps working (v2 just sets no limits).
create or replace function public.admin_upsert_badge_v3(
    p_key text, p_label text, p_icon text, p_color text, p_description text,
    p_rank integer, p_perms jsonb, p_limits jsonb
)
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

    -- Clearing a permission is always fine; granting one you lack is not.
    foreach perm in array array['delete_content','purge_content','warn','mute','ban',
                                'delete_users','manage_filter','view_ips','view_log',
                                'manage_events','manage_badges','manage_limits']
    loop
        if coalesce((p_perms->>perm)::boolean, false)
           and not public.has_perm(auth.uid(), perm) then
            raise exception 'Cannot grant a permission you do not hold: %',
                replace(perm, '_', ' ');
        end if;
    end loop;

    -- Attaching quotas needs manage_limits even though creating the badge
    -- doesn't; checked against what's actually changing so a badge moderator
    -- can still rename/recolour a badge that carries limits.
    if not public.has_perm(auth.uid(), 'manage_limits')
       and exists (
           select 1 from public.badges b where b.key = p_key
           and (b.limit_cloud_items              is distinct from v_items
             or b.limit_community_uploads        is distinct from v_uploads
             or b.limit_publish_cooldown_seconds is distinct from v_cooldown
             or b.can_auto_backup                is distinct from v_auto)
       ) then
        raise exception 'You do not have the manage limits permission, so you cannot change this badge''s limits';
    end if;
    if not public.has_perm(auth.uid(), 'manage_limits')
       and not exists (select 1 from public.badges where key = p_key)
       and (v_items is not null or v_uploads is not null
            or v_cooldown is not null or v_auto) then
        raise exception 'You do not have the manage limits permission, so you cannot create a badge that carries limits';
    end if;

    insert into public.badges (key, label, icon, color, description, rank,
        can_delete_content, can_purge_content, can_warn, can_mute, can_ban,
        can_delete_users, can_manage_filter, can_view_ips, can_view_log,
        can_manage_events, can_manage_badges, can_manage_limits, can_delete_any,
        limit_cloud_items, limit_community_uploads, limit_publish_cooldown_seconds,
        can_auto_backup)
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
        coalesce((p_perms->>'delete_content')::boolean, false),
        v_items, v_uploads, v_cooldown, v_auto)
    on conflict (key) do update set
        label = excluded.label, icon = excluded.icon, color = excluded.color,
        description = excluded.description, rank = excluded.rank,
        can_delete_content = excluded.can_delete_content,
        can_purge_content  = excluded.can_purge_content,
        can_warn           = excluded.can_warn,
        can_mute           = excluded.can_mute,
        can_ban            = excluded.can_ban,
        can_delete_users   = excluded.can_delete_users,
        can_manage_filter  = excluded.can_manage_filter,
        can_view_ips       = excluded.can_view_ips,
        can_view_log       = excluded.can_view_log,
        can_manage_events  = excluded.can_manage_events,
        can_manage_badges  = excluded.can_manage_badges,
        can_manage_limits  = excluded.can_manage_limits,
        can_delete_any     = excluded.can_delete_any,
        limit_cloud_items              = excluded.limit_cloud_items,
        limit_community_uploads        = excluded.limit_community_uploads,
        limit_publish_cooldown_seconds = excluded.limit_publish_cooldown_seconds,
        can_auto_backup                = excluded.can_auto_backup;

    perform public.mod_log(null, 'badge_upsert', p_label,
        jsonb_build_object('key', p_key, 'rank', p_rank,
                           'perms', p_perms, 'limits', p_limits));
end;
$function$;

grant execute on function public.admin_upsert_badge_v3(text, text, text, text, text, integer, jsonb, jsonb) to authenticated;

-- ---- who may call what ----
-- effective_limits() takes a uid, so leaving it callable over REST would let
-- anyone ask what anyone else is allowed. my_limits() is the public door,
-- answering only for the caller; effective_limits() is for the SECURITY
-- DEFINER triggers, which need no grant.
--
-- Functions are granted EXECUTE to PUBLIC by default -- revoking named roles
-- alone wouldn't remove that.
revoke execute on function public.effective_limits(uuid) from public;
revoke execute on function public.effective_limits(uuid) from anon;
revoke execute on function public.effective_limits(uuid) from authenticated;

revoke execute on function public.my_limits() from public;
revoke execute on function public.my_limits() from anon;
grant execute on function public.my_limits() to authenticated;
