-- Security pass. Each block closes one way a signed-in (or signed-out) user
-- could read or forge something they should not.

-- ==================== 1. private profile columns ====================
-- bio/pronouns/location/website follow the privacy setting. The column lock
-- that enforces it is the next migration (applied once the client that reads
-- these through profile_details() is deployed); these functions come first.
create or replace function public.profile_details(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
    select case when public.profile_part_visible(pr.id, 'details')
        then jsonb_build_object('bio', coalesce(pr.bio, ''), 'pronouns', coalesce(pr.pronouns, ''),
                                'location', coalesce(pr.location, ''), 'website', coalesce(pr.website, ''))
        else jsonb_build_object('bio', '', 'pronouns', '', 'location', '', 'website', '', 'hidden', true) end
    from public.profiles pr where pr.id = p_user and auth.uid() is not null;
$$;
revoke execute on function public.profile_details(uuid) from public, anon;
grant execute on function public.profile_details(uuid) to authenticated;

-- read bio as the definer now (the caller cannot), and only where it may be seen
create or replace function public.profile_follow_list(p_user uuid, p_which text, p_limit integer default 100)
returns table(id uuid, username text, display_name text, avatar_url text, display_badges text[], bio text, followed_at timestamp with time zone)
language sql stable security definer set search_path = public as $$
    select pr.id, pr.username, pr.display_name, pr.avatar_url, pr.display_badges,
           case when public.profile_part_visible(pr.id, 'details') then left(pr.bio, 140) else '' end, f.created_at
    from public.follows f
    join public.profiles pr on pr.id = case when p_which = 'following' then f.followee_id else f.follower_id end
    where (case when p_which = 'following' then f.follower_id else f.followee_id end) = p_user
      and auth.uid() is not null
      and public.profile_part_visible(p_user, 'follows')
    order by f.created_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

-- link previews run signed out: a bio only shows there if it is public
do $$
declare def text;
begin
    select pg_get_functiondef('public.link_preview(text, text)'::regprocedure) into def;
    if position('privacy' in def) = 0 then
        def := replace(def, $r$'description', left(coalesce(pr.bio, ''), 220),$r$,
            $r$'description', case when coalesce(pr.privacy->>'profile', 'everyone') = 'everyone'
                                     and coalesce(pr.privacy->>'details', 'everyone') = 'everyone'
                                   then left(coalesce(pr.bio, ''), 220) else '' end,$r$);
        if position('privacy' in def) = 0 then raise exception 'link_preview: bio line not found'; end if;
        execute def;
    end if;
end $$;

-- pictures only from our own bucket or the sign-in providers: an arbitrary URL
-- is a tracking pixel that logs the address of everyone who views the profile.
-- NB: a new site domain needs adding here (and to the storage proxy pattern).
alter table public.profiles add constraint profiles_avatar_host check (
    coalesce(avatar_url, '') = '' or avatar_url ~ '^(https://(qstbascfeolkyxtrqqwv\.supabase\.co|dex\.woogi\.xyz/sb)/storage/v1/object/public/avatars/|https://lh3\.googleusercontent\.com/|https://cdn\.discordapp\.com/)');
alter table public.profiles add constraint profiles_banner_host check (
    coalesce(banner_url, '') = '' or banner_url ~ '^https://(qstbascfeolkyxtrqqwv\.supabase\.co|dex\.woogi\.xyz/sb)/storage/v1/object/public/avatars/');

-- no SVG (it can carry script) among uploaded pictures
update storage.buckets set allowed_mime_types = array['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']
 where id = 'avatars';

-- ==================== 2. forged authorship on published Fakémon ====================
-- The guard only ran on UPDATE, so an INSERT could claim any author name,
-- a staff badge and role, any avatar URL and a huge view count; and either
-- path could set activity_at in the future to sit on top of "Latest activity".
create or replace function public.guard_published_mon_update()
returns trigger language plpgsql set search_path = public as $$
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'UPDATE' then
        -- ownership and feed position are not editable by the author
        new.id           := old.id;
        new.user_id      := old.user_id;
        new.published_at := old.published_at;
        new.view_count   := old.view_count;
        new.family_id    := old.family_id;
        new.activity_at  := least(coalesce(new.activity_at, old.activity_at), now());
    else
        new.view_count  := 0;
        new.activity_at := now();
    end if;

    -- who posted it comes from their profile, never from the row they sent
    select coalesce(p.role, 'user'),
           coalesce(p.display_badges, '{}'),
           coalesce(nullif(p.display_name, ''), p.username, 'Someone'),
           nullif(p.avatar_url, '')
      into new.author_role, new.author_badges, new.author_name, new.author_avatar_url
      from public.profiles p
     where p.id = new.user_id;

    return new;
end;
$$;
drop trigger if exists trg_guard_published_mon_insert on public.published_mons;
create trigger trg_guard_published_mon_insert before insert on public.published_mons
    for each row execute function public.guard_published_mon_update();

-- the same future-date trick on posts
do $$
declare def text;
begin
    select pg_get_functiondef('public.guard_community_post()'::regprocedure) into def;
    if position('least(coalesce(new.activity_at' in def) = 0 then
        def := replace(def, 'new.created_at := old.created_at;',
            E'new.created_at := old.created_at;\n        new.activity_at := least(coalesce(new.activity_at, old.activity_at), now());');
        if position('least(coalesce(new.activity_at' in def) = 0 then raise exception 'guard_community_post: anchor not found'; end if;
        execute def;
    end if;
end $$;

-- ==================== 3. notifications ====================
-- Anyone could notify anyone: blocked people included, with an avatar URL of
-- their choosing (tracking pixel) and unbounded text.
do $$
declare def text;
begin
    select pg_get_functiondef('public.guard_notification_insert()'::regprocedure) into def;
    if position('is_blocked_between' in def) = 0 then
        def := replace(def, 'into new.actor_name from public.profiles where id = auth.uid();',
            E'into new.actor_name from public.profiles where id = auth.uid();\n' ||
            E'    new.actor_avatar_url := (select nullif(avatar_url, '''') from public.profiles where id = auth.uid());\n' ||
            E'    new.preview := left(new.preview, 300);\n' ||
            E'    new.target_name := left(new.target_name, 120);\n' ||
            E'    if auth.uid() is not null and public.is_blocked_between(auth.uid(), new.user_id) then\n' ||
            E'        return null;\n' ||
            E'    end if;');
        if position('is_blocked_between' in def) = 0 then raise exception 'guard_notification_insert: anchor not found'; end if;
        execute def;
    end if;
end $$;

-- ==================== 4. contest votes only through the full ballot ====================
-- submit_contest_ballot (security definer) makes you rate every entry once.
-- Direct inserts/updates and cast_contest_vote let a voter score only their
-- rivals, or change scores after submitting. Nothing in the client uses them.
drop policy if exists contest_votes_insert on public.contest_votes;
drop policy if exists contest_votes_update on public.contest_votes;
revoke execute on function public.cast_contest_vote(uuid, uuid, smallint, smallint, text) from public, anon, authenticated;

-- ==================== 5. view counts ====================
-- one view per person per Fakémon per 6 hours; it feeds the hub's ranking
create or replace function public.increment_published_mon_view(p_published_id uuid)
returns bigint language plpgsql security definer set search_path = public as $$
declare next_count bigint;
begin
    if auth.uid() is null
       or not public.rate_limit_hit('view:' || auth.uid()::text || ':' || p_published_id::text, 1, interval '6 hours') then
        return coalesce((select view_count from public.published_mons where id = p_published_id), 0);
    end if;
    update public.published_mons
       set view_count = coalesce(view_count, 0) + 1
     where id = p_published_id
    returning view_count into next_count;
    return coalesce(next_count, 0);
end;
$$;

-- ==================== 6. signed-out callers ====================
-- Every security definer function was executable by anon through PUBLIC. Keep
-- the three the signed-out site uses (link previews, contest results); every
-- other one keeps exactly the signed-in access it had.
do $$
declare f regprocedure;
begin
    for f in
        select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')
           and p.proname not in ('link_preview', 'link_preview_thumb', 'get_contest_results')
    loop
        execute format('grant execute on function %s to authenticated, service_role', f);
        execute format('revoke execute on function %s from public, anon', f);
    end loop;
end $$;

alter function public.account_deletion_grace() set search_path = public;

-- ==================== 7. battle results need the loser's word ====================
-- Either player could report themselves the winner (and edit the row
-- directly). Now a result stands when it costs the reporter something: naming
-- the other player the winner, or no winner (draw/desync). Claiming your own
-- win is only a claim until the opponent's report agrees. Both clients report
-- at the end, so an honest battle still finishes on the first report.
drop policy if exists battles_participant_update on public.battles;
alter table public.battles add column if not exists result_claims jsonb not null default '{}';

create or replace function public.finish_battle(p_battle_id uuid, p_winner_id uuid, p_reason text, p_actions jsonb)
returns public.battles language plpgsql security definer set search_path = public as $$
declare
  b public.battles;
  me uuid := auth.uid();
  opponent uuid;
begin
  select * into b from public.battles where id = p_battle_id for update;
  if b.id is null then raise exception 'Battle not found.'; end if;
  if me is null or me not in (b.p1_id, b.p2_id) then raise exception 'Not your battle.'; end if;
  if b.status = 'finished' then return b; end if;
  if p_winner_id is not null and p_winner_id not in (b.p1_id, b.p2_id) then
    raise exception 'Winner must be one of the two players.';
  end if;
  opponent := case when me = b.p1_id then b.p2_id else b.p1_id end;

  if p_winner_id = me and (b.result_claims->>opponent::text) is distinct from me::text then
    update public.battles set result_claims = result_claims || jsonb_build_object(me::text, me::text)
     where id = p_battle_id returning * into b;
    return b;
  end if;

  update public.battles
     set status = 'finished', winner_id = p_winner_id, end_reason = left(coalesce(p_reason, ''), 60),
         actions = coalesce(p_actions, '[]'::jsonb), ended_at = now(),
         result_claims = result_claims || jsonb_build_object(me::text, coalesce(p_winner_id::text, ''))
   where id = p_battle_id
  returning * into b;
  delete from public.battle_signals where battle_id = p_battle_id;
  return b;
end;
$$;

-- ==================== 8. publish cooldown ====================
-- Rows of one evolution family are exempt from each other's cooldown so a
-- family publishes in one go -- but reusing an old family_id skipped the
-- cooldown forever. The exemption now lasts 10 minutes.
do $$
declare def text;
begin
    select pg_get_functiondef('public.published_mons_enforce_cooldown()'::regprocedure) into def;
    if position('interval ''10 minutes''' in def) = 0 then
        def := replace(def, 'and (new.family_id is null or family_id is distinct from new.family_id)',
            'and (new.family_id is null or family_id is distinct from new.family_id or published_at < now() - interval ''10 minutes'')');
        if position('interval ''10 minutes''' in def) = 0 then raise exception 'cooldown: anchor not found'; end if;
        execute def;
    end if;
end $$;

-- ==================== 9. "edited" only when the post itself changed ====================
-- every update stamped edited_at, and a comment or reaction touches the post
-- (activity_at), so commenting marked posts as edited
do $$
declare def text;
begin
    select pg_get_functiondef('public.guard_community_post()'::regprocedure) into def;
    if position('is distinct from (old.body' in def) = 0 then
        def := replace(def, 'new.edited_at := now();',
            'if (new.body, new.mon_ids, new.tags) is distinct from (old.body, old.mon_ids, old.tags) then new.edited_at := now(); else new.edited_at := old.edited_at; end if;');
        if position('is distinct from (old.body' in def) = 0 then raise exception 'edited_at: anchor not found'; end if;
        execute def;
    end if;
end $$;

-- ==================== 10. adding an email must prove you own it ====================
-- This used to set the new address *confirmed*, unchecked: an account could
-- claim someone else's email, and a later "Sign in with Google" by its real
-- owner would link into that account. Now it only clears the placeholder;
-- the client then asks Supabase to change the email, which (with no current
-- address) sends one confirmation link, to the new address. The placeholder is
-- kept in app metadata so username sign-in can restore it while the link is
-- still unclicked (login-with-identifier).
create or replace function public.repair_my_invalid_email(new_email text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
    uid uuid := auth.uid();
    current_email text;
    normalized_email text := lower(trim(new_email));
begin
    if uid is null then raise exception 'You must be signed in.' using errcode = '42501'; end if;
    if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
        raise exception 'Please enter a valid email address.' using errcode = '22023';
    end if;
    select email into current_email from auth.users where id = uid;
    if current_email is null then return true; end if;     -- already cleared; the change is pending
    if current_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       and current_email !~* '@(users\.woogidex\.invalid|no-email\.woogidex\.com)$' then
        raise exception 'The current email is valid; use the normal email change flow.' using errcode = '42501';
    end if;
    if exists (select 1 from auth.users where lower(email) = normalized_email and id <> uid) then
        raise exception 'That email address is already in use.' using errcode = '23505';
    end if;
    update auth.users
       set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('placeholder_email', current_email),
           email = null, email_confirmed_at = null, updated_at = now()
     where id = uid;
    return true;
end;
$$;
