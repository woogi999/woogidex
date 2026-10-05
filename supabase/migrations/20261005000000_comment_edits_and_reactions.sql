-- Comments, Facebook-style: authors can edit what they wrote, and everyone
-- can react to a comment with the same emojis posts take. Covers all three
-- comment tables: on published Fakemon (mon_comments), on posts
-- (post_comments) and on profile walls (profile_comments).
--
-- Also lets a profile's owner remove what others write on their wall.

-- ---------- editing ----------
alter table public.mon_comments     add column if not exists edited_at timestamptz;
alter table public.post_comments    add column if not exists edited_at timestamptz;
alter table public.profile_comments add column if not exists edited_at timestamptz;

create policy "Authors edit their own comments" on public.mon_comments
    for update to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Authors edit their own comments" on public.post_comments
    for update to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Authors edit their own comments" on public.profile_comments
    for update to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- An edit changes the text and nothing else (not who wrote it, where, or
-- when), and the server stamps edited_at itself so it can't be faked.
create or replace function public.guard_comment_edit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if (to_jsonb(new) - 'body' - 'edited_at') is distinct from (to_jsonb(old) - 'body' - 'edited_at') then
        raise exception 'Only a comment''s text can be changed.' using errcode = 'P0001';
    end if;
    if new.body is distinct from old.body then
        new.edited_at := now();
    else
        new.edited_at := old.edited_at;
    end if;
    return new;
end $$;

create trigger comment_edit_guard before update on public.mon_comments
    for each row execute function public.guard_comment_edit();
create trigger comment_edit_guard before update on public.post_comments
    for each row execute function public.guard_comment_edit();
create trigger comment_edit_guard before update on public.profile_comments
    for each row execute function public.guard_comment_edit();

-- mon_comments and profile_comments already run the content filter on
-- UPDATE; post_comments only did on INSERT, which was fine while comments
-- couldn't change. An edit is filtered exactly like a new comment.
create trigger enforce_content_policy_on_edit before update of body on public.post_comments
    for each row execute function public.enforce_content_policy();

-- ---------- a profile's owner tidies their own wall ----------
create policy "Profile owners remove wall comments" on public.profile_comments
    for delete to authenticated using (profile_id = (select auth.uid()));

-- ---------- reactions ----------
-- One table for all three kinds of comment. There is no foreign key to point
-- at three tables, so the triggers further down remove a comment's reactions
-- when the comment goes.
create table if not exists public.comment_reactions (
    comment_kind text not null check (comment_kind in ('mon', 'post', 'profile')),
    comment_id   uuid not null,
    user_id      uuid not null references public.profiles(id) on delete cascade,
    emoji        text not null check (emoji ~ '^[a-z0-9_]{1,48}$'),
    created_at   timestamptz not null default now(),
    primary key (comment_kind, comment_id, user_id, emoji)
);
create index if not exists comment_reactions_user_idx on public.comment_reactions (user_id);
alter table public.comment_reactions enable row level security;

create policy "Signed-in users can see comment reactions" on public.comment_reactions
    for select to authenticated using (true);
create policy "Users react to comments as themselves" on public.comment_reactions
    for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users remove their own comment reactions" on public.comment_reactions
    for delete to authenticated using (user_id = (select auth.uid()));

-- same limits as reacting to a post, and the comment has to exist
create or replace function public.guard_comment_reaction()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    found_it boolean;
begin
    if public.is_banned(new.user_id) then
        raise exception 'Your account is suspended.' using errcode = 'P0001';
    end if;
    if not public.rate_limit_hit('react:' || new.user_id::text, 60, interval '1 minute') then
        raise exception 'Slow down a little!' using errcode = 'P0001';
    end if;
    found_it := case new.comment_kind
        when 'mon'     then exists (select 1 from public.mon_comments     where id = new.comment_id)
        when 'post'    then exists (select 1 from public.post_comments    where id = new.comment_id)
        when 'profile' then exists (select 1 from public.profile_comments where id = new.comment_id)
        else false
    end;
    if not found_it then
        raise exception 'That comment is gone.' using errcode = 'P0001';
    end if;
    if (select count(*) from public.comment_reactions
         where comment_kind = new.comment_kind and comment_id = new.comment_id and user_id = new.user_id) >= 10 then
        raise exception 'That''s plenty of reactions on one comment.' using errcode = 'P0001';
    end if;
    return new;
end $$;
create trigger comment_reactions_guard before insert on public.comment_reactions
    for each row execute function public.guard_comment_reaction();

create or replace function public.drop_comment_reactions()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    delete from public.comment_reactions
     where comment_kind = tg_argv[0] and comment_id = old.id;
    return null;
end $$;
create trigger comment_reactions_cleanup after delete on public.mon_comments
    for each row execute function public.drop_comment_reactions('mon');
create trigger comment_reactions_cleanup after delete on public.post_comments
    for each row execute function public.drop_comment_reactions('post');
create trigger comment_reactions_cleanup after delete on public.profile_comments
    for each row execute function public.drop_comment_reactions('profile');

-- trigger functions only: nothing should call them over the API
revoke execute on function public.guard_comment_edit()      from public, anon, authenticated;
revoke execute on function public.guard_comment_reaction()  from public, anon, authenticated;
revoke execute on function public.drop_comment_reactions()  from public, anon, authenticated;
