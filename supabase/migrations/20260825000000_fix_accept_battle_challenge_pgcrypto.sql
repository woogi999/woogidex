-- pgcrypto lives in the `extensions` schema, not `public` (this function's
-- search_path), so gen_random_bytes() must be schema-qualified. Widening
-- search_path instead would weaken this SECURITY DEFINER function against
-- name-shadowing attacks.

CREATE OR REPLACE FUNCTION public.accept_battle_challenge(p_challenge_id uuid, p_my_team jsonb)
 RETURNS battles
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := auth.uid();
  ch public.battle_challenges;
  new_battle public.battles;
begin
  if me is null then raise exception 'You must be signed in.'; end if;

  select * into ch from public.battle_challenges where id = p_challenge_id for update;
  if ch.id is null then raise exception 'Challenge not found.'; end if;
  if ch.to_id <> me then raise exception 'That challenge is not addressed to you.'; end if;
  if ch.status <> 'pending' then
    if ch.status = 'accepted' and ch.battle_id is not null then
      select * into new_battle from public.battles where id = ch.battle_id;
      return new_battle;
    end if;
    raise exception 'That challenge is no longer open.';
  end if;

  insert into public.battles(format, seed, p1_id, p2_id, p1_team, p2_team, team_hash, status, started_at)
  values (
    ch.format, encode(extensions.gen_random_bytes(16), 'hex'),
    ch.from_id, me,
    ch.from_team, p_my_team,
    md5(ch.from_team::text || p_my_team::text),
    'active', now()
  )
  returning * into new_battle;

  update public.battle_challenges
     set status = 'accepted', battle_id = new_battle.id
   where id = p_challenge_id;

  -- Any other challenge either player had open is now moot.
  update public.battle_challenges
     set status = 'cancelled'
   where status = 'pending'
     and id <> p_challenge_id
     and (from_id in (ch.from_id, me) or to_id in (ch.from_id, me));

  return new_battle;
end;
$function$;
