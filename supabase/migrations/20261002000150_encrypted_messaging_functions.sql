-- ==================== private messages, part 2 ====================
-- The functions, reports, and the encrypted file bucket for the tables in
-- 20261002000100_encrypted_messaging.sql (read that file's header for how
-- the encryption works).

-- ---------- starting and managing chats ----------
create or replace function public.start_direct_chat(p_other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
    me uuid := auth.uid();
    key text;
    convo uuid;
    privacy text;
begin
    if me is null then raise exception 'Sign in first.'; end if;
    if p_other is null or p_other = me then raise exception 'Pick someone else to message.'; end if;
    if public.is_banned(me) then raise exception 'Your account is suspended.'; end if;
    if public.is_blocked_between(me, p_other) then raise exception 'You can''t message this person.'; end if;
    key := least(me::text, p_other::text) || ':' || greatest(me::text, p_other::text);
    select id into convo from public.conversations where dm_key = key;
    if convo is not null then
        -- someone who left a DM comes back to it
        insert into public.conversation_members (conversation_id, user_id, role, added_by)
        values (convo, me, 'member', me) on conflict do nothing;
        return convo;
    end if;
    select dm_privacy into privacy from public.profiles where id = p_other;
    if privacy is null then raise exception 'That account doesn''t exist.'; end if;
    if privacy = 'nobody' then raise exception 'This person isn''t taking new messages.'; end if;
    if privacy = 'following' and not exists (select 1 from public.follows where follower_id = p_other and followee_id = me) then
        raise exception 'This person only takes messages from people they follow.';
    end if;
    if not public.rate_limit_hit('new-chat:' || me::text, 20, interval '1 hour') then
        raise exception 'You''re starting a lot of chats. Try again in a bit.';
    end if;
    insert into public.conversations (kind, created_by, dm_key) values ('dm', me, key) returning id into convo;
    insert into public.conversation_members (conversation_id, user_id, role, added_by)
    values (convo, me, 'owner', me), (convo, p_other, 'member', me);
    return convo;
end $$;

-- the rule for groups: you can only add people who follow you
create or replace function public.assert_can_add_to_group(p_adder uuid, p_user uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
    if p_user = p_adder then return; end if;
    if not exists (select 1 from public.follows where follower_id = p_user and followee_id = p_adder) then
        raise exception 'You can only add people who follow you.';
    end if;
    if public.is_blocked_between(p_adder, p_user) then
        raise exception 'You can''t add someone you''ve blocked (or who blocked you).';
    end if;
end $$;

create or replace function public.create_group_chat(p_title text, p_members uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare
    me uuid := auth.uid();
    convo uuid;
    member uuid;
    others uuid[] := array(select distinct m from unnest(coalesce(p_members, '{}')) m where m is not null and m <> me);
begin
    if me is null then raise exception 'Sign in first.'; end if;
    if public.is_banned(me) then raise exception 'Your account is suspended.'; end if;
    if cardinality(others) < 1 then raise exception 'Add at least one person.'; end if;
    if cardinality(others) > 49 then raise exception 'Groups can have up to 50 people.'; end if;
    foreach member in array others loop
        perform public.assert_can_add_to_group(me, member);
    end loop;
    if not public.rate_limit_hit('new-chat:' || me::text, 20, interval '1 hour') then
        raise exception 'You''re starting a lot of chats. Try again in a bit.';
    end if;
    insert into public.conversations (kind, title, created_by)
    values ('group', left(btrim(coalesce(p_title, '')), 60), me) returning id into convo;
    insert into public.conversation_members (conversation_id, user_id, role, added_by) values (convo, me, 'owner', me);
    insert into public.conversation_members (conversation_id, user_id, role, added_by)
    select convo, m, 'member', me from unnest(others) m;
    insert into public.messages (conversation_id, sender_id, kind, ciphertext)
    values (convo, me, 'system', jsonb_build_object('event', 'created', 'by', me)::text);
    return convo;
end $$;

create or replace function public.add_group_members(p_conversation uuid, p_members uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare
    me uuid := auth.uid();
    convo public.conversations;
    member uuid;
    adding uuid[];
begin
    select * into convo from public.conversations where id = p_conversation;
    if convo.id is null or convo.kind <> 'group' or not public.is_conversation_member(p_conversation, me) then
        raise exception 'You''re not in that group.';
    end if;
    adding := array(select distinct m from unnest(coalesce(p_members, '{}')) m
                     where m is not null and not public.is_conversation_member(p_conversation, m));
    if (select count(*) from public.conversation_members where conversation_id = p_conversation) + cardinality(adding) > 50 then
        raise exception 'Groups can have up to 50 people.';
    end if;
    foreach member in array adding loop
        perform public.assert_can_add_to_group(me, member);
    end loop;
    insert into public.conversation_members (conversation_id, user_id, role, added_by)
    select p_conversation, m, 'member', me from unnest(adding) m;
    if cardinality(adding) > 0 then
        insert into public.messages (conversation_id, sender_id, kind, ciphertext)
        values (p_conversation, me, 'system', jsonb_build_object('event', 'added', 'by', me, 'users', to_jsonb(adding))::text);
    end if;
end $$;

-- the owner removes someone, or anyone leaves. Either way the conversation
-- key moves to a new version so what's said next stays out of their reach.
create or replace function public.remove_group_member(p_conversation uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
    me uuid := auth.uid();
    convo public.conversations;
    my_role text;
    next_owner uuid;
begin
    select * into convo from public.conversations where id = p_conversation;
    select role into my_role from public.conversation_members where conversation_id = p_conversation and user_id = me;
    if convo.id is null or my_role is null then raise exception 'You''re not in that chat.'; end if;
    if p_user <> me and (convo.kind <> 'group' or my_role <> 'owner') then
        raise exception 'Only the group''s owner can remove people.';
    end if;
    delete from public.conversation_members where conversation_id = p_conversation and user_id = p_user;
    if convo.kind = 'group' then
        update public.conversations set key_version = key_version + 1 where id = p_conversation;
        insert into public.messages (conversation_id, sender_id, kind, ciphertext)
        values (p_conversation, me, 'system',
                jsonb_build_object('event', case when p_user = me then 'left' else 'removed' end, 'by', me, 'user', p_user)::text);
        -- a group whose owner left gets the longest-standing member as its new owner
        if not exists (select 1 from public.conversation_members where conversation_id = p_conversation and role = 'owner') then
            select user_id into next_owner from public.conversation_members
             where conversation_id = p_conversation order by joined_at limit 1;
            if next_owner is not null then
                update public.conversation_members set role = 'owner' where conversation_id = p_conversation and user_id = next_owner;
            end if;
        end if;
    end if;
end $$;

create or replace function public.rename_group_chat(p_conversation uuid, p_title text)
returns void language plpgsql security definer set search_path = public as $$
begin
    if not exists (select 1 from public.conversations c where c.id = p_conversation and c.kind = 'group')
       or not public.is_conversation_member(p_conversation, auth.uid()) then
        raise exception 'You''re not in that group.';
    end if;
    update public.conversations set title = left(btrim(coalesce(p_title, '')), 60) where id = p_conversation;
end $$;

create or replace function public.mark_conversation_read(p_conversation uuid)
returns void language sql security definer set search_path = public as $$
    update public.conversation_members set last_read_at = now()
     where conversation_id = p_conversation and user_id = auth.uid();
$$;

create or replace function public.set_conversation_muted(p_conversation uuid, p_muted boolean)
returns void language sql security definer set search_path = public as $$
    update public.conversation_members set muted = coalesce(p_muted, false)
     where conversation_id = p_conversation and user_id = auth.uid();
$$;

-- a sender takes back a message: its ciphertext is wiped, the row stays as "deleted"
-- returns the message's file paths so the sender's browser can delete the files too
create or replace function public.delete_my_message(p_message uuid)
returns text[] language plpgsql security definer set search_path = public as $$
declare paths text[];
begin
    select attachment_paths into paths from public.messages
     where id = p_message and sender_id = auth.uid() and deleted_at is null;
    if not found then raise exception 'You can only delete your own messages.'; end if;
    -- a reported message is evidence: it disappears from the chat but staff
    -- can still open it (and its files) from the report
    if exists (select 1 from public.message_reports where p_message = any(message_ids)) then
        update public.messages set deleted_at = now() where id = p_message;
        return '{}';
    end if;
    update public.messages set ciphertext = '', iv = '', msg_key = '', msg_key_iv = '', deleted_at = now(),
           attachment_paths = '{}'
     where id = p_message;
    return coalesce(paths, '{}');
end $$;

-- who in a chat already has its current key, so a member's browser knows who
-- still needs it handed over (someone new, or someone who reset their PIN)
create or replace function public.conversation_key_holders(p_conversation uuid)
returns table(user_id uuid, member_key_id text) language sql stable security definer set search_path = public as $$
    select k.user_id, k.member_key_id
    from public.conversation_keys k
    join public.conversations c on c.id = k.conversation_id and c.key_version = k.version
    where k.conversation_id = p_conversation
      and public.is_conversation_member(p_conversation, auth.uid());
$$;

-- the inbox: every chat I'm in, newest first, with who's in it and how much I haven't read
create or replace function public.my_conversations()
returns table(id uuid, kind text, title text, created_by uuid, last_message_at timestamptz, key_version int,
              my_role text, last_read_at timestamptz, muted boolean, unread bigint, members jsonb)
language sql stable security definer set search_path = public as $$
    select c.id, c.kind, c.title, c.created_by, c.last_message_at, c.key_version,
           me.role, me.last_read_at, me.muted,
           (select count(*) from public.messages m
             where m.conversation_id = c.id and m.created_at > me.last_read_at
               and m.sender_id is distinct from auth.uid() and m.kind = 'message' and m.deleted_at is null),
           (select jsonb_agg(jsonb_build_object(
                'id', p.id, 'username', p.username, 'display_name', p.display_name, 'avatar_url', p.avatar_url,
                'role', cm.role, 'last_read_at', cm.last_read_at,
                'has_key', exists (select 1 from public.user_public_keys k where k.user_id = p.id))
                order by cm.joined_at)
              from public.conversation_members cm join public.profiles p on p.id = cm.user_id
             where cm.conversation_id = c.id)
    from public.conversation_members me
    join public.conversations c on c.id = me.conversation_id
    where me.user_id = auth.uid()
    order by c.last_message_at desc
    limit 200;
$$;

create or replace function public.unread_message_count()
returns bigint language sql stable security definer set search_path = public as $$
    select count(*) from public.conversation_members me
    join public.messages m on m.conversation_id = me.conversation_id
    where me.user_id = auth.uid() and not me.muted
      and m.created_at > me.last_read_at and m.sender_id is distinct from auth.uid()
      and m.kind = 'message' and m.deleted_at is null;
$$;

-- ---------- reports ----------
-- The reporter's browser decrypts the reported messages itself and sends
-- staff each one's own message key. Staff (moderators) can then open exactly
-- those messages, and their attachments, and nothing else in the chat.
create table if not exists public.message_reports (
    id              uuid primary key default gen_random_uuid(),
    reporter_id     uuid references public.profiles(id) on delete set null,
    conversation_id uuid references public.conversations(id) on delete set null,
    reported_user   uuid references public.profiles(id) on delete set null,
    message_ids     uuid[] not null check (cardinality(message_ids) between 1 and 30),
    disclosed_keys  jsonb not null,             -- { message id: raw message key, base64 }
    reason          text not null default '' check (char_length(reason) <= 1000),
    status          text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
    staff_note      text not null default '' check (char_length(staff_note) <= 2000),
    handled_by      uuid references public.profiles(id) on delete set null,
    created_at      timestamptz not null default now(),
    handled_at      timestamptz
);
create index if not exists message_reports_status_idx on public.message_reports (status, created_at desc);
alter table public.message_reports enable row level security;
create policy "Reporters see their own reports" on public.message_reports
    for select to authenticated using (reporter_id = (select auth.uid()));
create policy "Moderators see every report" on public.message_reports
    for select to authenticated using ((select public.has_perm((select auth.uid()), 'delete_content')));

create or replace function public.report_messages(p_conversation uuid, p_message_ids uuid[], p_keys jsonb, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
    me uuid := auth.uid();
    rid uuid;
    target uuid;
begin
    if not public.is_conversation_member(p_conversation, me) then raise exception 'You''re not in that chat.'; end if;
    if cardinality(coalesce(p_message_ids, '{}')) not between 1 and 30 then raise exception 'Pick between 1 and 30 messages.'; end if;
    if exists (select 1 from unnest(p_message_ids) x(id)
               where not exists (select 1 from public.messages m where m.id = x.id and m.conversation_id = p_conversation)) then
        raise exception 'Those messages aren''t in this chat.';
    end if;
    if jsonb_typeof(p_keys) <> 'object' then raise exception 'Missing message keys.'; end if;
    if not public.rate_limit_hit('report:' || me::text, 10, interval '1 day') then
        raise exception 'You''ve sent a lot of reports today. Staff will get to them!';
    end if;
    -- the person reported: whoever wrote most of the reported messages, if not me
    select sender_id into target from public.messages
     where id = any(p_message_ids) and sender_id <> me
     group by sender_id order by count(*) desc limit 1;
    insert into public.message_reports (reporter_id, conversation_id, reported_user, message_ids, disclosed_keys, reason)
    values (me, p_conversation, target, p_message_ids, p_keys, left(coalesce(p_reason, ''), 1000))
    returning id into rid;
    return rid;
end $$;

-- staff: the reports, with the encrypted messages they point at (the admin
-- page decrypts them with the disclosed keys)
create or replace function public.admin_message_reports(p_status text default 'open', p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
    if not public.has_perm(auth.uid(), 'delete_content') then raise exception 'Staff only.'; end if;
    return coalesce((
        select jsonb_agg(r order by r->>'created_at' desc) from (
            select jsonb_build_object(
                'id', mr.id, 'status', mr.status, 'reason', mr.reason, 'staff_note', mr.staff_note,
                'created_at', mr.created_at, 'handled_at', mr.handled_at,
                'conversation_id', mr.conversation_id, 'disclosed_keys', mr.disclosed_keys,
                'reporter', (select jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name) from public.profiles p where p.id = mr.reporter_id),
                'reported', (select jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name) from public.profiles p where p.id = mr.reported_user),
                'messages', coalesce((select jsonb_agg(jsonb_build_object(
                        'id', m.id, 'sender_id', m.sender_id, 'created_at', m.created_at, 'deleted_at', m.deleted_at,
                        'ciphertext', m.ciphertext, 'iv', m.iv, 'attachment_paths', m.attachment_paths,
                        'sender', (select jsonb_build_object('username', p.username, 'display_name', p.display_name) from public.profiles p where p.id = m.sender_id))
                        order by m.created_at)
                    from public.messages m where m.id = any(mr.message_ids)), '[]'::jsonb)
            ) r
            from public.message_reports mr
            where p_status = 'all' or mr.status = p_status
            order by mr.created_at desc
            limit least(greatest(coalesce(p_limit, 50), 1), 200)
        ) x), '[]'::jsonb);
end $$;

create or replace function public.admin_resolve_message_report(p_report uuid, p_status text, p_note text default '')
returns void language plpgsql security definer set search_path = public as $$
begin
    if not public.has_perm(auth.uid(), 'delete_content') then raise exception 'Staff only.'; end if;
    if p_status not in ('open', 'actioned', 'dismissed') then raise exception 'Unknown status.'; end if;
    update public.message_reports
       set status = p_status, staff_note = left(coalesce(p_note, ''), 2000), handled_by = auth.uid(),
           handled_at = case when p_status = 'open' then null else now() end
     where id = p_report;
    if p_status <> 'open' and (select reported_user from public.message_reports where id = p_report) is not null then
        perform public.mod_log((select reported_user from public.message_reports where id = p_report),
                               'message_report_' || p_status, coalesce(p_note, ''), jsonb_build_object('report', p_report), null);
    end if;
end $$;

-- ---------- attachments: encrypted files in a private bucket ----------
-- 10 MB of file plus the encryption's few bytes of overhead. Files are
-- stored as opaque ciphertext under <conversation id>/<random name>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-files', 'chat-files', false, 10486784, array['application/octet-stream'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.chat_path_conversation(p_name text)
returns uuid language plpgsql immutable set search_path = public as $$
begin
    return split_part(p_name, '/', 1)::uuid;
exception when others then
    return null;
end $$;

-- uploads count against a daily allowance so files can't eat the bandwidth
create or replace function public.chat_upload_ok(p_name text)
returns boolean language plpgsql security definer set search_path = public as $$
declare convo uuid := public.chat_path_conversation(p_name);
begin
    if convo is null or not public.is_conversation_member(convo, auth.uid()) then return false; end if;
    if public.is_banned(auth.uid()) or public.is_muted(auth.uid()) then return false; end if;
    return public.rate_limit_hit('chat-upload:' || auth.uid()::text, 80, interval '1 day');
end $$;

create or replace function public.chat_file_readable(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
    select public.is_conversation_member(public.chat_path_conversation(p_name), auth.uid())
        or (public.has_perm(auth.uid(), 'delete_content') and exists (
                select 1 from public.message_reports mr
                join public.messages m on m.id = any(mr.message_ids)
                where p_name = any(m.attachment_paths)));
$$;

create policy "Chat members upload encrypted files" on storage.objects
    for insert to authenticated with check (bucket_id = 'chat-files' and public.chat_upload_ok(name));
create policy "Chat members (and staff, for reports) download files" on storage.objects
    for select to authenticated using (bucket_id = 'chat-files' and public.chat_file_readable(name));
create policy "Senders delete their own files" on storage.objects
    for delete to authenticated using (bucket_id = 'chat-files' and owner_id = (select auth.uid())::text);

grant execute on function public.start_direct_chat(uuid) to authenticated;
grant execute on function public.create_group_chat(text, uuid[]) to authenticated;
grant execute on function public.add_group_members(uuid, uuid[]) to authenticated;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;
grant execute on function public.rename_group_chat(uuid, text) to authenticated;
grant execute on function public.mark_conversation_read(uuid) to authenticated;
grant execute on function public.set_conversation_muted(uuid, boolean) to authenticated;
grant execute on function public.delete_my_message(uuid) to authenticated;
grant execute on function public.conversation_key_holders(uuid) to authenticated;
grant execute on function public.my_conversations() to authenticated;
grant execute on function public.unread_message_count() to authenticated;
grant execute on function public.report_messages(uuid, uuid[], jsonb, text) to authenticated;
grant execute on function public.admin_message_reports(text, int) to authenticated;
grant execute on function public.admin_resolve_message_report(uuid, text, text) to authenticated;
revoke execute on function public.start_direct_chat(uuid) from anon;
revoke execute on function public.create_group_chat(text, uuid[]) from anon;
revoke execute on function public.add_group_members(uuid, uuid[]) from anon;
revoke execute on function public.remove_group_member(uuid, uuid) from anon;
revoke execute on function public.my_conversations() from anon;
revoke execute on function public.unread_message_count() from anon;
revoke execute on function public.report_messages(uuid, uuid[], jsonb, text) from anon;
revoke execute on function public.admin_message_reports(text, int) from anon;
revoke execute on function public.admin_resolve_message_report(uuid, text, text) from anon;
