-- Three things the feed needed:
--   1. Fakémon take emoji reactions, exactly like posts. Every existing like
--      becomes a "heart" reaction. mon_likes is left as it was (nothing
--      reads it any more), as a record of the likes before the move.
--   2. Reposts, like Threads / Facebook's Share: a community post that points
--      at a Fakémon or another post, with or without your own words on top.
--   3. Notification settings: each person picks which kinds they get.

-- ==================== 1. reactions on Fakémon ====================
create table if not exists public.mon_reactions (
    mon_id     uuid not null references public.published_mons(id) on delete cascade,
    user_id    uuid not null references public.profiles(id) on delete cascade,
    emoji      text not null check (emoji ~ '^[a-z0-9_]{1,48}$'),
    created_at timestamptz not null default now(),
    primary key (mon_id, user_id, emoji)
);
create index if not exists mon_reactions_user_idx on public.mon_reactions (user_id);
alter table public.mon_reactions enable row level security;

create policy "Signed-in users can see Fakemon reactions" on public.mon_reactions
    for select to authenticated using (true);
create policy "Users react to Fakemon as themselves" on public.mon_reactions
    for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users remove their own Fakemon reactions" on public.mon_reactions
    for delete to authenticated using (user_id = (select auth.uid()));

-- every like so far is a heart now (copied before the guard below exists:
-- its rate limit would otherwise refuse someone's likes arriving all at once)
insert into public.mon_reactions (mon_id, user_id, emoji, created_at)
select l.mon_id, l.user_id, 'heart', coalesce(l.created_at, now())
  from public.mon_likes l
 where exists (select 1 from public.profiles p where p.id = l.user_id)
on conflict do nothing;

create or replace function public.guard_mon_reaction()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if public.is_banned(new.user_id) then
        raise exception 'Your account is suspended.' using errcode = 'P0001';
    end if;
    if not public.rate_limit_hit('react:' || new.user_id::text, 60, interval '1 minute') then
        raise exception 'Slow down a little!' using errcode = 'P0001';
    end if;
    if (select count(*) from public.mon_reactions where mon_id = new.mon_id and user_id = new.user_id) >= 10 then
        raise exception 'That''s plenty of reactions on one Fakémon.' using errcode = 'P0001';
    end if;
    return new;
end $$;
create trigger mon_reactions_guard before insert on public.mon_reactions
    for each row execute function public.guard_mon_reaction();
-- a reaction bumps the Fakémon up "Latest activity", as a like did
create trigger mon_reactions_touch_activity after insert on public.mon_reactions
    for each row execute function public.touch_mon_activity_from_child();

-- the hub grid's numbers: "likes" is every reaction now; liked_by_me is your heart
create or replace function public.community_mon_stats(p_ids uuid[])
returns table(mon_id uuid, like_count bigint, comment_count bigint, liked_by_me boolean)
language sql stable set search_path = public as $$
    select
        m.id,
        (select count(*) from public.mon_reactions r where r.mon_id = m.id),
        (select count(*) from public.mon_comments c where c.mon_id = m.id),
        exists (select 1 from public.mon_reactions r
                 where r.mon_id = m.id and r.emoji = 'heart' and r.user_id = (select auth.uid()))
    from unnest(p_ids) as m(id);
$$;

-- ==================== 2. reposts ====================
alter table public.community_posts
    add column if not exists repost_kind text check (repost_kind in ('mon', 'post')),
    add column if not exists repost_id   uuid;
alter table public.community_posts
    add constraint community_posts_repost_pair check ((repost_kind is null) = (repost_id is null));

-- one plain repost (no words of your own) per person per thing
create unique index if not exists community_posts_one_plain_repost
    on public.community_posts (user_id, repost_kind, repost_id)
    where repost_id is not null and body = '' and mon_ids = '{}';
create index if not exists community_posts_repost_idx on public.community_posts (repost_kind, repost_id)
    where repost_id is not null;

-- the target has to exist, and reposting a repost reposts the original
create or replace function public.guard_repost()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    inner_kind text;
    inner_id uuid;
begin
    if tg_op = 'UPDATE' then
        new.repost_kind := old.repost_kind;
        new.repost_id := old.repost_id;
        return new;
    end if;
    if new.repost_id is null then return new; end if;
    if new.repost_kind = 'post' then
        select repost_kind, repost_id into inner_kind, inner_id from public.community_posts where id = new.repost_id;
        if not found then
            raise exception 'That post is gone.' using errcode = 'P0001';
        end if;
        if inner_id is not null then
            new.repost_kind := inner_kind;
            new.repost_id := inner_id;
        end if;
    end if;
    if new.repost_kind = 'mon' and not exists (select 1 from public.published_mons where id = new.repost_id) then
        raise exception 'That Fakémon is gone.' using errcode = 'P0001';
    end if;
    return new;
end $$;
create trigger community_posts_repost_guard before insert or update on public.community_posts
    for each row execute function public.guard_repost();

-- when the original goes, plain reposts of it go too; reposts with words of
-- their own stay, showing "no longer available" where the original was
create or replace function public.drop_plain_reposts()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    delete from public.community_posts
     where repost_kind = tg_argv[0] and repost_id = old.id and body = '' and mon_ids = '{}';
    return null;
end $$;
create trigger drop_plain_reposts after delete on public.published_mons
    for each row execute function public.drop_plain_reposts('mon');
create trigger drop_plain_reposts after delete on public.community_posts
    for each row execute function public.drop_plain_reposts('post');

-- the original a repost shows, with its live numbers, so a plain repost can be
-- drawn as the original's own card (reactions, comments and all)
create or replace function public.repost_embed(p_kind text, p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
    select case p_kind
        when 'mon' then (
            select jsonb_build_object(
                'kind', 'mon', 'id', m.id, 'user_id', m.user_id, 'created_at', m.published_at,
                'author_name', m.author_name, 'author_avatar_url', m.author_avatar_url, 'author_badges', m.author_badges,
                'name', m.fakemon_data->>'name', 'species', m.fakemon_data->>'species', 'number', m.fakemon_data->>'number',
                'type1', m.fakemon_data->>'type1', 'type2', m.fakemon_data->>'type2',
                'customTypes', coalesce(m.fakemon_data->'customTypes', '[]'::jsonb),
                'caption', left(coalesce(m.fakemon_data->>'dexEntry1', ''), 280),
                'like_count', (select count(*) from public.mon_reactions r where r.mon_id = m.id),
                'liked_by_me', exists (select 1 from public.mon_reactions r where r.mon_id = m.id and r.emoji = 'heart' and r.user_id = auth.uid()),
                'reactions', coalesce((select jsonb_object_agg(emoji, n) from (
                        select emoji, count(*) n from public.mon_reactions r where r.mon_id = m.id group by emoji) x), '{}'::jsonb),
                'my_reactions', coalesce((select jsonb_agg(emoji) from public.mon_reactions r where r.mon_id = m.id and r.user_id = auth.uid()), '[]'::jsonb),
                'comment_count', (select count(*) from public.mon_comments c where c.mon_id = m.id),
                'repost_count', (select count(*) from public.community_posts rp where rp.repost_kind = 'mon' and rp.repost_id = m.id),
                'reposted_by_me', exists (select 1 from public.community_posts rp where rp.repost_kind = 'mon' and rp.repost_id = m.id
                                            and rp.user_id = auth.uid() and rp.body = '' and rp.mon_ids = '{}'))
            from public.published_mons m where m.id = p_id)
        when 'post' then (
            select jsonb_build_object(
                'kind', 'post', 'id', p.id, 'user_id', p.user_id, 'created_at', p.created_at,
                'body', left(p.body, 600), 'truncated', char_length(p.body) > 600, 'mon_ids', p.mon_ids,
                'mons', coalesce((select jsonb_agg(jsonb_build_object(
                            'id', pm.id, 'name', pm.fakemon_data->>'name', 'type1', pm.fakemon_data->>'type1', 'type2', pm.fakemon_data->>'type2')
                            order by array_position(p.mon_ids, pm.id))
                          from public.published_mons pm where pm.id = any(p.mon_ids)), '[]'::jsonb),
                'tags', p.tags, 'edited_at', p.edited_at,
                'reactions', coalesce((select jsonb_object_agg(emoji, n) from (
                        select emoji, count(*) n from public.post_reactions r where r.post_id = p.id group by emoji) x), '{}'::jsonb),
                'my_reactions', coalesce((select jsonb_agg(emoji) from public.post_reactions r where r.post_id = p.id and r.user_id = auth.uid()), '[]'::jsonb),
                'comment_count', (select count(*) from public.post_comments c where c.post_id = p.id),
                'repost_count', (select count(*) from public.community_posts rp where rp.repost_kind = 'post' and rp.repost_id = p.id),
                'reposted_by_me', exists (select 1 from public.community_posts rp where rp.repost_kind = 'post' and rp.repost_id = p.id
                                            and rp.user_id = auth.uid() and rp.body = '' and rp.mon_ids = '{}'))
            from public.community_posts p where p.id = p_id)
    end;
$$;
revoke execute on function public.repost_embed(text, uuid) from public, anon;
grant execute on function public.repost_embed(text, uuid) to authenticated;

-- ==================== the feed and timelines, with both ====================
create or replace function public.community_feed(p_before timestamptz default null, p_limit integer default 100, p_following_only boolean default false)
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
    'like_count', (select count(*) from public.mon_reactions r where r.mon_id = m.id),
    'liked_by_me', exists (select 1 from public.mon_reactions r where r.mon_id = m.id and r.emoji = 'heart' and r.user_id = (select uid from me)),
    'reactions', coalesce((select jsonb_object_agg(emoji, n) from (
            select emoji, count(*) n from public.mon_reactions r where r.mon_id = m.id group by emoji) x), '{}'::jsonb),
    'my_reactions', coalesce((select jsonb_agg(emoji) from public.mon_reactions r where r.mon_id = m.id and r.user_id = (select uid from me)), '[]'::jsonb),
    'comment_count', (select count(*) from public.mon_comments c where c.mon_id = m.id),
    'repost_count', (select count(*) from public.community_posts rp where rp.repost_kind = 'mon' and rp.repost_id = m.id),
    'reposted_by_me', exists (select 1 from public.community_posts rp where rp.repost_kind = 'mon' and rp.repost_id = m.id
                                and rp.user_id = (select uid from me) and rp.body = '' and rp.mon_ids = '{}'),
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
    'repost_kind', p.repost_kind, 'repost_id', p.repost_id,
    'repost', case when p.repost_id is null then null else coalesce(public.repost_embed(p.repost_kind, p.repost_id), '{"missing": true}'::jsonb) end,
    'comment_count', (select count(*) from public.post_comments c where c.post_id = p.id),
    'reactions', coalesce((select jsonb_object_agg(emoji, n) from (
            select emoji, count(*) n from public.post_reactions r where r.post_id = p.id group by emoji) x), '{}'::jsonb),
    'my_reactions', coalesce((select jsonb_agg(emoji) from public.post_reactions r where r.post_id = p.id and r.user_id = (select uid from me)), '[]'::jsonb),
    'repost_count', (select count(*) from public.community_posts rp where rp.repost_kind = 'post' and rp.repost_id = p.id),
    'reposted_by_me', exists (select 1 from public.community_posts rp where rp.repost_kind = 'post' and rp.repost_id = p.id
                                and rp.user_id = (select uid from me) and rp.body = '' and rp.mon_ids = '{}'),
    'followed', p.user_id in (select id from followed))
from post_rows p;
$$;

create or replace function public.profile_timeline(p_user uuid, p_before timestamptz default null, p_limit integer default 30)
returns setof jsonb language sql stable set search_path = public as $$
    select item from (
        select jsonb_build_object(
            'kind', 'post', 'id', p.id, 'user_id', p.user_id, 'created_at', p.created_at, 'activity_at', p.activity_at, 'edited_at', p.edited_at,
            'body', p.body, 'truncated', false, 'tags', p.tags, 'mon_ids', p.mon_ids,
            'mons', coalesce((select jsonb_agg(jsonb_build_object(
                        'id', pm.id, 'name', pm.fakemon_data->>'name', 'type1', pm.fakemon_data->>'type1', 'type2', pm.fakemon_data->>'type2',
                        'customTypes', coalesce(pm.fakemon_data->'customTypes', '[]'::jsonb)) order by array_position(p.mon_ids, pm.id))
                      from public.published_mons pm where pm.id = any(p.mon_ids)), '[]'::jsonb),
            'repost_kind', p.repost_kind, 'repost_id', p.repost_id,
            'repost', case when p.repost_id is null then null else coalesce(public.repost_embed(p.repost_kind, p.repost_id), '{"missing": true}'::jsonb) end,
            'comment_count', (select count(*) from public.post_comments c where c.post_id = p.id),
            'reactions', coalesce((select jsonb_object_agg(emoji, n) from (
                    select emoji, count(*) n from public.post_reactions r where r.post_id = p.id group by emoji) x), '{}'::jsonb),
            'my_reactions', coalesce((select jsonb_agg(emoji) from public.post_reactions r where r.post_id = p.id and r.user_id = auth.uid()), '[]'::jsonb),
            'repost_count', (select count(*) from public.community_posts rp where rp.repost_kind = 'post' and rp.repost_id = p.id),
            'reposted_by_me', exists (select 1 from public.community_posts rp where rp.repost_kind = 'post' and rp.repost_id = p.id
                                        and rp.user_id = auth.uid() and rp.body = '' and rp.mon_ids = '{}')
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
            'like_count', (select count(*) from public.mon_reactions r where r.mon_id = m.id),
            'liked_by_me', exists (select 1 from public.mon_reactions r where r.mon_id = m.id and r.emoji = 'heart' and r.user_id = auth.uid()),
            'reactions', coalesce((select jsonb_object_agg(emoji, n) from (
                    select emoji, count(*) n from public.mon_reactions r where r.mon_id = m.id group by emoji) x), '{}'::jsonb),
            'my_reactions', coalesce((select jsonb_agg(emoji) from public.mon_reactions r where r.mon_id = m.id and r.user_id = auth.uid()), '[]'::jsonb),
            'comment_count', (select count(*) from public.mon_comments c where c.mon_id = m.id),
            'repost_count', (select count(*) from public.community_posts rp where rp.repost_kind = 'mon' and rp.repost_id = m.id),
            'reposted_by_me', exists (select 1 from public.community_posts rp where rp.repost_kind = 'mon' and rp.repost_id = m.id
                                        and rp.user_id = auth.uid() and rp.body = '' and rp.mon_ids = '{}')
        ), m.published_at
        from public.published_mons m
        where m.user_id = p_user and (p_before is null or m.published_at < p_before)
    ) t
    where auth.uid() is not null
    order by at desc
    limit least(greatest(coalesce(p_limit, 30), 1), 60);
$$;

-- ==================== 3. notification settings ====================
-- Private to each person (a column on profiles would be readable by anyone
-- signed in). Keys are notification types; false turns that kind off, and
-- "all": false pauses everything. Moderation notices always get through.
create table if not exists public.notification_prefs (
    user_id    uuid primary key references public.profiles(id) on delete cascade,
    prefs      jsonb not null default '{}'::jsonb check (jsonb_typeof(prefs) = 'object'),
    updated_at timestamptz not null default now()
);
alter table public.notification_prefs enable row level security;
create policy "People read their own notification settings" on public.notification_prefs
    for select to authenticated using (user_id = (select auth.uid()));
create policy "People create their own notification settings" on public.notification_prefs
    for insert to authenticated with check (user_id = (select auth.uid()));
create policy "People change their own notification settings" on public.notification_prefs
    for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- a notification someone turned off is never stored, so it can't count as unread
create or replace function public.respect_notification_prefs()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    p jsonb;
begin
    if new.type like 'mod\_%' or new.type in ('mon_deleted', 'contest_submission_deleted') then
        return new;
    end if;
    select prefs into p from public.notification_prefs where user_id = new.user_id;
    if p is null then return new; end if;
    if (p->>'all') = 'false' or (p->>new.type) = 'false' then
        return null;
    end if;
    return new;
end $$;
create trigger respect_notification_prefs before insert on public.notifications
    for each row execute function public.respect_notification_prefs();

-- trigger functions only: nothing should call them over the API
revoke execute on function public.guard_mon_reaction()        from public, anon, authenticated;
revoke execute on function public.guard_repost()              from public, anon, authenticated;
revoke execute on function public.drop_plain_reposts()        from public, anon, authenticated;
revoke execute on function public.respect_notification_prefs() from public, anon, authenticated;
