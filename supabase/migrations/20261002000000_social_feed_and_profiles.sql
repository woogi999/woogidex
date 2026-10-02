-- ==================== the social update ====================
-- Following creators, blocking, the new profile page's extra fields, and the
-- Community Hub feed's own posts (text, and "here are my mons" collections),
-- with emoji reactions and comments.
--
-- Mons published to the hub stay in published_mons; the feed mixes them with
-- community_posts (see community_feed() below and docs/feed-algorithm.md).

-- ---------- profile page: banner, theme colour and a few details ----------
alter table public.profiles
    add column if not exists banner_url   text not null default '',
    add column if not exists banner_color text not null default '',
    add column if not exists accent_color text not null default '',
    add column if not exists pronouns     text not null default '',
    add column if not exists location     text not null default '',
    add column if not exists website      text not null default '',
    -- who may start a private chat: everyone, only people this user follows, or nobody
    add column if not exists dm_privacy   text not null default 'everyone';

alter table public.profiles
    add constraint profiles_banner_url_shape   check (banner_url = '' or (banner_url ~ '^https://' and char_length(banner_url) <= 500)),
    add constraint profiles_banner_color_shape check (banner_color = '' or banner_color ~ '^(#[0-9a-fA-F]{6}|preset:[a-z0-9-]{1,24})$'),
    add constraint profiles_accent_color_shape check (accent_color = '' or accent_color ~ '^#[0-9a-fA-F]{6}$'),
    add constraint profiles_pronouns_len       check (char_length(pronouns) <= 30),
    add constraint profiles_location_len       check (char_length(location) <= 40),
    add constraint profiles_website_shape      check (website = '' or (website ~* '^https?://[^\s]+$' and char_length(website) <= 200)),
    add constraint profiles_dm_privacy_values  check (dm_privacy in ('everyone', 'following', 'nobody'));

-- ---------- blocks ----------
create table if not exists public.user_blocks (
    blocker_id uuid not null references public.profiles(id) on delete cascade,
    blocked_id uuid not null references public.profiles(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (blocker_id, blocked_id),
    check (blocker_id <> blocked_id)
);
create index if not exists user_blocks_blocked_idx on public.user_blocks (blocked_id);
alter table public.user_blocks enable row level security;

create policy "Users see their own blocks" on public.user_blocks
    for select to authenticated using (blocker_id = (select auth.uid()));
create policy "Users block as themselves" on public.user_blocks
    for insert to authenticated with check (blocker_id = (select auth.uid()));
create policy "Users unblock as themselves" on public.user_blocks
    for delete to authenticated using (blocker_id = (select auth.uid()));

-- either direction counts: neither side can follow, message or add the other
create or replace function public.is_blocked_between(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.user_blocks
                   where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a));
$$;

-- everyone I blocked or who blocked me (the feed hides both)
create or replace function public.my_block_list()
returns setof uuid language sql stable security definer set search_path = public as $$
    select blocked_id from public.user_blocks where blocker_id = auth.uid()
    union
    select blocker_id from public.user_blocks where blocked_id = auth.uid();
$$;

-- ---------- follows ----------
create table if not exists public.follows (
    follower_id uuid not null references public.profiles(id) on delete cascade,
    followee_id uuid not null references public.profiles(id) on delete cascade,
    created_at  timestamptz not null default now(),
    primary key (follower_id, followee_id),
    check (follower_id <> followee_id)
);
create index if not exists follows_followee_idx on public.follows (followee_id, created_at desc);
alter table public.follows enable row level security;

create policy "Signed-in users can see follows" on public.follows
    for select to authenticated using (true);
create policy "Users follow as themselves" on public.follows
    for insert to authenticated with check (follower_id = (select auth.uid()));
-- unfollow, or remove someone from your own followers
create policy "Users unfollow or remove followers" on public.follows
    for delete to authenticated using (follower_id = (select auth.uid()) or followee_id = (select auth.uid()));

create or replace function public.guard_follow_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if public.is_banned(new.follower_id) then
        raise exception 'Your account is suspended.' using errcode = 'P0001';
    end if;
    if public.is_blocked_between(new.follower_id, new.followee_id) then
        raise exception 'You can''t follow this person.' using errcode = 'P0001';
    end if;
    if not public.rate_limit_hit('follow:' || new.follower_id::text, 60, interval '1 hour') then
        raise exception 'You are following people too quickly. Try again in a bit.' using errcode = 'P0001';
    end if;
    return new;
end $$;
create trigger follows_guard before insert on public.follows
    for each row execute function public.guard_follow_insert();

-- blocking someone also unfollows in both directions
create or replace function public.unfollow_on_block()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    delete from public.follows
     where (follower_id = new.blocker_id and followee_id = new.blocked_id)
        or (follower_id = new.blocked_id and followee_id = new.blocker_id);
    return new;
end $$;
create trigger user_blocks_unfollow after insert on public.user_blocks
    for each row execute function public.unfollow_on_block();

-- ---------- community posts ----------
create table if not exists public.community_posts (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references public.profiles(id) on delete cascade,
    body        text not null default '' check (char_length(body) <= 4000),
    -- published_mons this post shows off ("here are my mons for my region!")
    mon_ids     uuid[] not null default '{}' check (cardinality(mon_ids) <= 12),
    tags        text[] not null default '{}' check (cardinality(tags) <= 8),
    created_at  timestamptz not null default now(),
    edited_at   timestamptz,
    activity_at timestamptz not null default now(),
    check (char_length(btrim(body)) > 0 or cardinality(mon_ids) > 0)
);
create index if not exists community_posts_created_idx  on public.community_posts (created_at desc);
create index if not exists community_posts_activity_idx on public.community_posts (activity_at desc);
create index if not exists community_posts_user_idx     on public.community_posts (user_id, created_at desc);
alter table public.community_posts enable row level security;

create policy "Signed-in users can read posts" on public.community_posts
    for select to authenticated using (true);
create policy "Users post as themselves" on public.community_posts
    for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users edit their own posts" on public.community_posts
    for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Owners and staff delete posts" on public.community_posts
    for delete to authenticated using (user_id = (select auth.uid()) or (select public.is_staff((select auth.uid()))));

create or replace function public.guard_community_post()
returns trigger language plpgsql security definer set search_path = public as $$
declare bad_tag text;
begin
    if tg_op = 'UPDATE' then
        new.id := old.id;
        new.user_id := old.user_id;
        new.created_at := old.created_at;
        new.edited_at := now();
    else
        new.created_at := now();
        new.activity_at := now();
        new.edited_at := null;
        if not public.rate_limit_hit('post-hour:' || new.user_id::text, 20, interval '1 hour') then
            raise exception 'That''s a lot of posts! Try again in a little while.' using errcode = 'P0001';
        end if;
    end if;
    -- only your own published Fakemon can go in a collection post
    if exists (select 1 from unnest(new.mon_ids) m(id)
               where not exists (select 1 from public.published_mons pm where pm.id = m.id and pm.user_id = new.user_id)) then
        raise exception 'You can only show off your own published Fakemon in a post.' using errcode = 'P0001';
    end if;
    select t into bad_tag from unnest(new.tags) t where t !~ '^[a-z0-9_]{1,24}$' limit 1;
    if found then
        raise exception 'Tags are letters, numbers and underscores (up to 24).' using errcode = 'P0001';
    end if;
    return new;
end $$;
create trigger community_posts_guard before insert or update on public.community_posts
    for each row execute function public.guard_community_post();
-- banned/muted, the 10-a-minute limit and the word filter (reads `body`)
create trigger enforce_content_policy before insert or update on public.community_posts
    for each row execute function public.enforce_content_policy();

-- ---------- reactions (custom emojis, plus "heart") ----------
create table if not exists public.post_reactions (
    post_id    uuid not null references public.community_posts(id) on delete cascade,
    user_id    uuid not null references public.profiles(id) on delete cascade,
    emoji      text not null check (emoji ~ '^[a-z0-9_]{1,48}$'),
    created_at timestamptz not null default now(),
    primary key (post_id, user_id, emoji)
);
create index if not exists post_reactions_user_idx on public.post_reactions (user_id);
alter table public.post_reactions enable row level security;

create policy "Signed-in users can see reactions" on public.post_reactions
    for select to authenticated using (true);
create policy "Users react as themselves" on public.post_reactions
    for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users remove their own reactions" on public.post_reactions
    for delete to authenticated using (user_id = (select auth.uid()));

create or replace function public.guard_post_reaction()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if public.is_banned(new.user_id) then
        raise exception 'Your account is suspended.' using errcode = 'P0001';
    end if;
    if not public.rate_limit_hit('react:' || new.user_id::text, 60, interval '1 minute') then
        raise exception 'Slow down a little!' using errcode = 'P0001';
    end if;
    if (select count(*) from public.post_reactions where post_id = new.post_id and user_id = new.user_id) >= 10 then
        raise exception 'That''s plenty of reactions on one post.' using errcode = 'P0001';
    end if;
    return new;
end $$;
create trigger post_reactions_guard before insert on public.post_reactions
    for each row execute function public.guard_post_reaction();

-- ---------- comments on posts ----------
create table if not exists public.post_comments (
    id         uuid primary key default gen_random_uuid(),
    post_id    uuid not null references public.community_posts(id) on delete cascade,
    user_id    uuid not null references public.profiles(id) on delete cascade,
    body       text not null check (char_length(btrim(body)) between 1 and 1000),
    created_at timestamptz not null default now()
);
create index if not exists post_comments_post_idx on public.post_comments (post_id, created_at);
create index if not exists post_comments_user_idx on public.post_comments (user_id);
alter table public.post_comments enable row level security;

create policy "Signed-in users can read post comments" on public.post_comments
    for select to authenticated using (true);
create policy "Users comment as themselves" on public.post_comments
    for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Authors, post owners and staff delete comments" on public.post_comments
    for delete to authenticated using (
        user_id = (select auth.uid())
        or exists (select 1 from public.community_posts p where p.id = post_id and p.user_id = (select auth.uid()))
        or (select public.is_staff((select auth.uid()))));

create trigger enforce_content_policy before insert on public.post_comments
    for each row execute function public.enforce_content_policy();

-- a reaction or comment bumps the post back up "Latest activity"
create or replace function public.touch_post_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    update public.community_posts set activity_at = now()
     where id = case when tg_op = 'DELETE' then old.post_id else new.post_id end;
    return null;
end $$;
create trigger post_comments_touch after insert on public.post_comments
    for each row execute function public.touch_post_activity();
create trigger post_reactions_touch after insert on public.post_reactions
    for each row execute function public.touch_post_activity();

-- ---------- stats for a page of posts ----------
create or replace function public.community_post_stats(p_ids uuid[])
returns table(post_id uuid, comment_count bigint, reactions jsonb, my_reactions text[])
language sql stable set search_path = public as $$
    select p.id,
        (select count(*) from public.post_comments c where c.post_id = p.id),
        coalesce((select jsonb_object_agg(emoji, n) from (
            select emoji, count(*) n from public.post_reactions r where r.post_id = p.id group by emoji) x), '{}'::jsonb),
        coalesce((select array_agg(emoji) from public.post_reactions r where r.post_id = p.id and r.user_id = (select auth.uid())), '{}')
    from unnest(p_ids) as p(id);
$$;

-- ---------- profile header numbers ----------
-- followers, following and published counts for a profile header
create or replace function public.profile_social_stats(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
    select jsonb_build_object(
        'followers', (select count(*) from public.follows where followee_id = p_user),
        'following', (select count(*) from public.follows where follower_id = p_user),
        'mons',      (select count(*) from public.published_mons where user_id = p_user),
        'posts',     (select count(*) from public.community_posts where user_id = p_user),
        'i_follow',  exists (select 1 from public.follows where follower_id = auth.uid() and followee_id = p_user),
        'follows_me', exists (select 1 from public.follows where follower_id = p_user and followee_id = auth.uid()),
        'i_blocked', exists (select 1 from public.user_blocks where blocker_id = auth.uid() and blocked_id = p_user),
        'blocked_me', exists (select 1 from public.user_blocks where blocker_id = p_user and blocked_id = auth.uid())
    )
    where auth.uid() is not null;
$$;

-- ---------- the feed's candidates ----------
-- Everything the client-side ranking (js/features/feed-algorithm.ts) chooses
-- from: the most recently active mons and posts, plus anything recent from
-- people you follow, minus anyone you've blocked or who blocked you.
-- p_before pages back in time (used by the Latest and Following tabs).
create or replace function public.community_feed(p_before timestamptz default null, p_limit int default 100, p_following_only boolean default false)
returns setof jsonb language sql stable set search_path = public as $$
with me as (select auth.uid() as uid),
lim as (select least(greatest(coalesce(p_limit, 100), 1), 150) as n),
followed as (select f.followee_id as id from public.follows f, me where f.follower_id = me.uid),
hidden as (select id from public.my_block_list() as id),
mon_ids as (
    (select pm.id from public.published_mons pm, me
      where (p_before is null or pm.published_at < p_before)
        and pm.user_id not in (select id from hidden)
        and (not p_following_only or pm.user_id in (select id from followed) or pm.user_id = me.uid)
      order by case when p_before is null then pm.activity_at else pm.published_at end desc
      limit (select n from lim))
    union
    (select pm.id from public.published_mons pm
      where p_before is null and not p_following_only
        and pm.user_id in (select id from followed)
        and pm.published_at > now() - interval '30 days'
      order by pm.published_at desc limit 40)
),
mon_rows as (select pm.* from public.published_mons pm where pm.id in (select id from mon_ids)),
post_ids as (
    (select cp.id from public.community_posts cp, me
      where (p_before is null or cp.created_at < p_before)
        and cp.user_id not in (select id from hidden)
        and (not p_following_only or cp.user_id in (select id from followed) or cp.user_id = me.uid)
      order by case when p_before is null then cp.activity_at else cp.created_at end desc
      limit (select n from lim))
    union
    (select cp.id from public.community_posts cp
      where p_before is null and not p_following_only
        and cp.user_id in (select id from followed)
        and cp.created_at > now() - interval '30 days'
      order by cp.created_at desc limit 40)
),
post_rows as (select cp.* from public.community_posts cp where cp.id in (select id from post_ids))
select jsonb_build_object(
    'kind', 'mon', 'id', m.id, 'user_id', m.user_id,
    'created_at', m.published_at, 'activity_at', m.activity_at, 'view_count', m.view_count,
    'author_name', m.author_name, 'author_avatar_url', m.author_avatar_url, 'author_badges', m.author_badges,
    'source_fakemon_id', m.source_fakemon_id, 'family_snapshots', m.family_snapshots, 'evolution_stage', m.evolution_stage,
    'name', m.fakemon_data->>'name', 'species', m.fakemon_data->>'species', 'number', m.fakemon_data->>'number',
    'type1', m.fakemon_data->>'type1', 'type2', m.fakemon_data->>'type2',
    'customTypes', coalesce(m.fakemon_data->'customTypes', '[]'::jsonb),
    'caption', left(coalesce(nullif(m.fakemon_data->>'dexEntry1', ''), ''), 280),
    'like_count', (select count(*) from public.mon_likes l where l.mon_id = m.id),
    'comment_count', (select count(*) from public.mon_comments c where c.mon_id = m.id),
    'liked_by_me', exists (select 1 from public.mon_likes l where l.mon_id = m.id and l.user_id = (select uid from me)),
    'followed', m.user_id in (select id from followed))
from mon_rows m
union all
select jsonb_build_object(
    'kind', 'post', 'id', p.id, 'user_id', p.user_id,
    'created_at', p.created_at, 'activity_at', p.activity_at, 'edited_at', p.edited_at,
    'body', left(p.body, 1500), 'truncated', char_length(p.body) > 1500,
    'tags', p.tags, 'mon_ids', p.mon_ids,
    'mons', coalesce((select jsonb_agg(jsonb_build_object(
                'id', pm.id, 'name', pm.fakemon_data->>'name', 'type1', pm.fakemon_data->>'type1', 'type2', pm.fakemon_data->>'type2',
                'customTypes', coalesce(pm.fakemon_data->'customTypes', '[]'::jsonb)) order by array_position(p.mon_ids, pm.id))
              from public.published_mons pm where pm.id = any(p.mon_ids)), '[]'::jsonb),
    'comment_count', (select count(*) from public.post_comments c where c.post_id = p.id),
    'reactions', coalesce((select jsonb_object_agg(emoji, n) from (
            select emoji, count(*) n from public.post_reactions r where r.post_id = p.id group by emoji) x), '{}'::jsonb),
    'my_reactions', coalesce((select jsonb_agg(emoji) from public.post_reactions r where r.post_id = p.id and r.user_id = (select uid from me)), '[]'::jsonb),
    'followed', p.user_id in (select id from followed))
from post_rows p;
$$;

-- ---------- what a profile's timeline shows ----------
create or replace function public.profile_timeline(p_user uuid, p_before timestamptz default null, p_limit int default 30)
returns setof jsonb language sql stable set search_path = public as $$
    select item from (
        select jsonb_build_object(
            'kind', 'post', 'id', p.id, 'user_id', p.user_id, 'created_at', p.created_at, 'activity_at', p.activity_at, 'edited_at', p.edited_at,
            'body', p.body, 'truncated', false, 'tags', p.tags, 'mon_ids', p.mon_ids,
            'mons', coalesce((select jsonb_agg(jsonb_build_object(
                        'id', pm.id, 'name', pm.fakemon_data->>'name', 'type1', pm.fakemon_data->>'type1', 'type2', pm.fakemon_data->>'type2',
                        'customTypes', coalesce(pm.fakemon_data->'customTypes', '[]'::jsonb)) order by array_position(p.mon_ids, pm.id))
                      from public.published_mons pm where pm.id = any(p.mon_ids)), '[]'::jsonb),
            'comment_count', (select count(*) from public.post_comments c where c.post_id = p.id),
            'reactions', coalesce((select jsonb_object_agg(emoji, n) from (
                    select emoji, count(*) n from public.post_reactions r where r.post_id = p.id group by emoji) x), '{}'::jsonb),
            'my_reactions', coalesce((select jsonb_agg(emoji) from public.post_reactions r where r.post_id = p.id and r.user_id = auth.uid()), '[]'::jsonb)
        ) as item, p.created_at as at
        from public.community_posts p
        where p.user_id = p_user and (p_before is null or p.created_at < p_before)
        union all
        select jsonb_build_object(
            'kind', 'mon', 'id', m.id, 'user_id', m.user_id, 'created_at', m.published_at, 'activity_at', m.activity_at, 'view_count', m.view_count,
            'author_name', m.author_name, 'author_avatar_url', m.author_avatar_url, 'family_snapshots', m.family_snapshots,
            'name', m.fakemon_data->>'name', 'species', m.fakemon_data->>'species', 'number', m.fakemon_data->>'number',
            'type1', m.fakemon_data->>'type1', 'type2', m.fakemon_data->>'type2',
            'customTypes', coalesce(m.fakemon_data->'customTypes', '[]'::jsonb),
            'caption', left(coalesce(m.fakemon_data->>'dexEntry1', ''), 280),
            'like_count', (select count(*) from public.mon_likes l where l.mon_id = m.id),
            'comment_count', (select count(*) from public.mon_comments c where c.mon_id = m.id),
            'liked_by_me', exists (select 1 from public.mon_likes l where l.mon_id = m.id and l.user_id = auth.uid())
        ), m.published_at
        from public.published_mons m
        where m.user_id = p_user and (p_before is null or m.published_at < p_before)
    ) t
    where auth.uid() is not null
    order by at desc
    limit least(greatest(coalesce(p_limit, 30), 1), 60);
$$;

-- followers/following lists for the profile's tabs
create or replace function public.profile_follow_list(p_user uuid, p_which text, p_limit int default 100)
returns table(id uuid, username text, display_name text, avatar_url text, display_badges text[], bio text, followed_at timestamptz)
language sql stable set search_path = public as $$
    select pr.id, pr.username, pr.display_name, pr.avatar_url, pr.display_badges, left(pr.bio, 140), f.created_at
    from public.follows f
    join public.profiles pr on pr.id = case when p_which = 'following' then f.followee_id else f.follower_id end
    where (case when p_which = 'following' then f.follower_id else f.followee_id end) = p_user
      and auth.uid() is not null
    order by f.created_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

grant execute on function public.community_feed(timestamptz, int, boolean) to authenticated;
grant execute on function public.profile_timeline(uuid, timestamptz, int) to authenticated;
grant execute on function public.profile_follow_list(uuid, text, int) to authenticated;
grant execute on function public.profile_social_stats(uuid) to authenticated;
grant execute on function public.community_post_stats(uuid[]) to authenticated;
revoke execute on function public.is_blocked_between(uuid, uuid) from anon;
revoke execute on function public.my_block_list() from anon;
