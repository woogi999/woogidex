-- ==================== published artwork stays full resolution ====================
-- Product decision: posts carry full-resolution artwork rather than a capped
-- display copy, since a resized version isn't what the artist published.
-- With no client-side downscaling, a size cap would reject ordinary uploads.
--
-- Tradeoff: published_mons holds full-resolution originals and is readable by
-- any signed-in account, so one table request returns every original on the
-- site. Client-side protections don't and can't close that; serving artwork
-- per-row through an RPC instead would.
drop trigger if exists trg_validate_published_mon_art_size on public.published_mons;
drop function if exists public.validate_published_mon_art_size();
