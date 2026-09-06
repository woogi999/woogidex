-- ==================== bootstrapping manage_limits ====================
-- can_manage_limits defaulted to false for existing badges, so nobody held
-- it, and admin_upsert_badge_v3 refuses to grant a permission the caller
-- lacks -- a permission only grantable by someone who already has it must be
-- seeded from a migration.
--
-- Goes to badges that already carry manage_badges.
update public.badges
   set can_manage_limits = true
 where can_manage_badges;

-- Staff get the same allowances a supporter badge is being built to give.
-- Auto-backup stays gated by site_limits.auto_backup_enabled (ships off), so
-- this grants the entitlement without switching anything on.
update public.badges
   set limit_cloud_items              = -1,   -- unlimited
       limit_community_uploads        = -1,   -- unlimited
       limit_publish_cooldown_seconds = 0,    -- no cooldown
       can_auto_backup                = true
 where key in ('developer', 'admin');
