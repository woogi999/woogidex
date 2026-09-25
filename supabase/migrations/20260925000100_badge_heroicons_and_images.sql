-- ==================== badge icons: Heroicons, or an uploaded image ====================
-- badges.icon now names a Heroicon (solid, 24px) instead of a lucide icon; the
-- existing rows are renamed to their nearest Heroicon below. A badge can
-- instead carry its own small image: the badge editor scales an upload to a
-- 64x64 PNG and stores it as a data URI in icon_image, which wins over icon.

alter table public.badges add column if not exists icon_image text;
alter table public.badges drop constraint if exists badges_icon_image_ok;
alter table public.badges add constraint badges_icon_image_ok check (
    icon_image is null
    or (icon_image like 'data:image/png;base64,%' and char_length(icon_image) <= 60000)
);

update public.badges set icon = case icon
    when 'code-2'        then 'code-bracket'
    when 'user-star'     then 'user-circle'
    when 'shield'        then 'shield-check'
    when 'calendars'     then 'calendar-days'
    when 'flask-conical' then 'beaker'
    when 'palette'       then 'paint-brush'
    else icon end;

-- v3 plus p_icon_image (null clears it); v3 stays for a panel left open across the deploy
create or replace function public.admin_upsert_badge_v4(
    p_key text, p_label text, p_icon text, p_color text, p_description text,
    p_rank integer, p_perms jsonb, p_limits jsonb, p_icon_image text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
    perform public.admin_upsert_badge_v3(p_key, p_label, p_icon, p_color, p_description, p_rank, p_perms, p_limits);
    update public.badges set icon_image = nullif(p_icon_image, '') where key = p_key;
end;
$function$;

revoke all on function public.admin_upsert_badge_v4(text, text, text, text, text, integer, jsonb, jsonb, text) from public, anon;
grant execute on function public.admin_upsert_badge_v4(text, text, text, text, text, integer, jsonb, jsonb, text) to authenticated;
