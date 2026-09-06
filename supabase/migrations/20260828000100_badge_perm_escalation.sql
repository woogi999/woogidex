-- ==================== you cannot mint a permission you do not hold ====================
-- admin_upsert_badge_v2() only checked rank, not which permissions a badge may
-- carry. An admin could create/assign themselves a lower-rank badge with a
-- permission they didn't already hold (has_perm is bool_or across all held
-- badges), self-escalating via two ordinary admin-panel calls. Fix: a
-- permission may only be written into a badge by someone who already holds it.
create or replace function public.admin_upsert_badge_v2(
    p_key text, p_label text, p_icon text, p_color text, p_description text,
    p_rank integer, p_perms jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
    my_rank int := public.my_badge_rank(auth.uid());
    perm text;
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
                                'manage_events','manage_badges']
    loop
        if coalesce((p_perms->>perm)::boolean, false)
           and not public.has_perm(auth.uid(), perm) then
            raise exception 'Cannot grant a permission you do not hold: %',
                replace(perm, '_', ' ');
        end if;
    end loop;

    insert into public.badges (key, label, icon, color, description, rank,
        can_delete_content, can_purge_content, can_warn, can_mute, can_ban,
        can_delete_users, can_manage_filter, can_view_ips, can_view_log,
        can_manage_events, can_manage_badges, can_delete_any)
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
        coalesce((p_perms->>'delete_content')::boolean, false))
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
        can_delete_any     = excluded.can_delete_any;

    perform public.mod_log(null, 'badge_upsert', p_label,
        jsonb_build_object('key', p_key, 'rank', p_rank, 'perms', p_perms));
end;
$fn$;

-- Same rule for self-assignment: granting a badge to someone else is ordinary
-- delegation, but granting one to yourself is the escalation shape. Compares
-- my_permissions() before/after and refuses if anything turned on, rather than
-- re-deriving which permissions the badges carry.
create or replace function public.admin_set_user_badges(
    target_user_id uuid, new_badge_keys text[])
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
    my_rank int := public.my_badge_rank(auth.uid());
    target_rank int := public.my_badge_rank(target_user_id);
    max_new_rank int;
    is_self boolean := target_user_id = auth.uid();
    perms_before jsonb;
    gained text;
begin
    if not public.has_perm(auth.uid(), 'manage_badges') then
        raise exception 'You do not have the manage badges permission';
    end if;
    if not is_self and target_rank >= my_rank then
        raise exception 'Cannot manage a user of equal or higher rank';
    end if;

    select coalesce(max(rank), 0) into max_new_rank from public.badges where key = any(new_badge_keys);
    if is_self then
        if max_new_rank > my_rank then
            raise exception 'Cannot grant yourself a badge higher than your current rank';
        end if;
        perms_before := public.my_permissions();
    else
        if max_new_rank >= my_rank then
            raise exception 'Cannot grant a badge of equal or higher rank than your own';
        end if;
    end if;

    delete from public.profile_badges where user_id = target_user_id;
    insert into public.profile_badges (user_id, badge_key, granted_by)
    select target_user_id, k, auth.uid() from unnest(new_badge_keys) as k
    on conflict do nothing;

    if is_self then
        select a.key into gained
          from jsonb_each(public.my_permissions()) a
         where a.key <> 'rank'
           and a.value = to_jsonb(true)
           and coalesce(perms_before -> a.key, to_jsonb(false)) <> to_jsonb(true)
         limit 1;
        if gained is not null then
            raise exception 'Cannot grant yourself a permission you do not already hold: %',
                replace(gained, '_', ' ');
        end if;
    end if;

    perform public.mod_log(target_user_id, 'badge_change', '',
        jsonb_build_object('badges', to_jsonb(new_badge_keys)));
end;
$fn$;

-- ==================== drop the legacy role/badge API ====================
-- Dead endpoints: all three read a `public.roles` table that no longer exists
-- and error on call. They also predate the rank checks above (admin_upsert_role
-- has no rank check at all).
drop function if exists public.admin_upsert_badge(text, text, text, text, text, integer, boolean, boolean);
drop function if exists public.admin_upsert_role(text, text, text, integer, boolean, boolean, boolean);
drop function if exists public.admin_set_user_role(uuid, text);

-- ==================== the IP tables are service-role only ====================
-- auth_events and login_attempts should only be written by service_role and
-- read via the view_ips-gated RPCs, but anon/authenticated held the default
-- full grant. RLS-with-no-policy blocks SELECT/INSERT/UPDATE/DELETE but not
-- TRUNCATE, which ignores RLS entirely -- anon could wipe both tables.
revoke all on public.auth_events    from anon, authenticated;
revoke all on public.login_attempts from anon, authenticated;

-- Same hole applies to every other table; no browser-facing role should hold TRUNCATE.
revoke truncate on all tables in schema public from anon, authenticated;
