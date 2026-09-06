-- ==================== close the unauthenticated read surface ====================
-- Several SECURITY DEFINER functions were granted to `anon`, letting a
-- signed-out caller bypass the underlying tables' RLS. Revoking anon access
-- below closes that hole; RLS itself was already correct.

-- 1. list_battle_lobby() is SECURITY DEFINER and doesn't honour
--    battle_presence's signed-in-only policy; it only excluded anon rows
--    because auth.uid() IS NULL happened to make the WHERE clause drop
--    everything. State the requirement explicitly and drop the anon grant.
create or replace function public.list_battle_lobby()
returns table (user_id uuid, display_name text, username text,
               avatar_url text, status text, last_seen timestamptz)
language sql
security definer
set search_path = public
as $$
  select p.user_id, p.display_name, p.username, p.avatar_url, p.status, p.last_seen
  from public.battle_presence p
  where auth.uid() is not null
    and p.user_id <> auth.uid()
    and p.last_seen > now() - interval '90 seconds'
  order by p.last_seen desc
  limit 100;
$$;

revoke execute on function public.list_battle_lobby() from public, anon;
grant  execute on function public.list_battle_lobby() to authenticated;

-- 2. These answer permission/rank questions for an arbitrary user id and were
--    callable while signed out, letting anon map the staff roster.
revoke execute on function public.has_perm(uuid, text)     from anon;
revoke execute on function public.is_staff(uuid)           from public, anon;
revoke execute on function public.is_staff()               from anon;
revoke execute on function public.is_moderator(uuid)       from anon;
revoke execute on function public.my_badge_rank(uuid)      from public, anon;

-- 3. Dead code, superseded by has_perm()/my_permissions(); unused anon-callable
--    SECURITY DEFINER entry points.
drop function if exists public.my_can_delete_any(uuid);
drop function if exists public.my_can_manage_badges(uuid);

-- 4. Community hub is sign-in only, so anon has no legitimate reason to call this.
revoke execute on function public.increment_published_mon_view(uuid) from anon;

-- 5. Mutable search_path on a SECURITY DEFINER trigger is hijackable via name shadowing.
alter function public.guard_published_mon_update() set search_path = public;

-- ==================== IP retention ====================
-- battle_signals holds WebRTC SDP/ICE payloads, which contain both peers' IPs.
-- Rows were kept forever, permanently exposing each player's IP to their
-- opponent. Delete them once the battle finishes.
create or replace function public.finish_battle(p_battle_id uuid, p_winner_id uuid,
                                                p_reason text, p_actions jsonb)
returns public.battles
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.battles;
begin
  select * into b from public.battles where id = p_battle_id for update;
  if b.id is null then raise exception 'Battle not found.'; end if;
  if auth.uid() not in (b.p1_id, b.p2_id) then raise exception 'Not your battle.'; end if;
  if b.status = 'finished' then return b; end if;
  if p_winner_id is not null and p_winner_id not in (b.p1_id, b.p2_id) then
    raise exception 'Winner must be one of the two players.';
  end if;

  update public.battles
     set status = 'finished', winner_id = p_winner_id, end_reason = p_reason,
         actions = coalesce(p_actions, '[]'::jsonb), ended_at = now()
   where id = p_battle_id
  returning * into b;

  delete from public.battle_signals where battle_id = p_battle_id;

  return b;
end;
$$;

-- Clean up existing rows too: finished or older than a day means the handshake is done.
delete from public.battle_signals s
 where exists (select 1 from public.battles b
                where b.id = s.battle_id and b.status = 'finished')
    or s.created_at < now() - interval '1 day';
