-- ==================== private messages (end-to-end encrypted) ====================
-- Direct messages and group chats. Everything anyone types or sends is
-- encrypted in the sender's browser before it gets here; this database only
-- ever holds ciphertext, so nobody with database access (site owner included)
-- can read a conversation. What the server does know: who is in which chat,
-- when messages were sent, and how big attachments are.
--
-- Keys (all made in the browser, js/features/messaging-crypto.ts):
--   * each person has an ECDH P-256 key pair. The public half is in
--     user_public_keys. The private half is stored in user_key_backups only
--     after being encrypted with a key derived from the person's chat PIN
--     (PBKDF2), which never leaves their browser.
--   * each conversation has a random AES key per "version". conversation_keys
--     holds it once per member, wrapped with ECDH(wrapper, member).
--     Removing someone from a group bumps the version, so they can't read
--     what comes after.
--   * each message has its own random key, wrapped with the conversation
--     key. That's what makes reporting work without exposing a whole chat:
--     reporting a message hands staff only those messages' own keys
--     (message_reports.disclosed_keys), which open those messages and
--     nothing else.

-- ---------- keys ----------
create table if not exists public.user_public_keys (
    user_id    uuid primary key references public.profiles(id) on delete cascade,
    public_key jsonb not null,                       -- JWK, ECDH P-256
    key_id     text not null check (key_id ~ '^[A-Za-z0-9_-]{8,64}$'),
    updated_at timestamptz not null default now()
);
alter table public.user_public_keys enable row level security;
create policy "Signed-in users read public keys" on public.user_public_keys
    for select to authenticated using (true);
create policy "Users publish their own key" on public.user_public_keys
    for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users replace their own key" on public.user_public_keys
    for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table if not exists public.user_key_backups (
    user_id     uuid primary key references public.profiles(id) on delete cascade,
    key_id      text not null,
    wrapped_key text not null check (char_length(wrapped_key) <= 4000),   -- AES-GCM(pkcs8), base64
    iv          text not null,
    salt        text not null,
    iterations  int  not null check (iterations between 100000 and 5000000),
    updated_at  timestamptz not null default now()
);
alter table public.user_key_backups enable row level security;
create policy "Users manage their own key backup" on public.user_key_backups
    for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------- conversations ----------
create table if not exists public.conversations (
    id              uuid primary key default gen_random_uuid(),
    kind            text not null check (kind in ('dm', 'group')),
    title           text not null default '' check (char_length(title) <= 60),
    created_by      uuid references public.profiles(id) on delete set null,
    created_at      timestamptz not null default now(),
    last_message_at timestamptz not null default now(),
    key_version     int not null default 1,
    -- "smaller-uuid:larger-uuid" for a DM, so two people only ever have one
    dm_key          text unique
);
alter table public.conversations enable row level security;

create table if not exists public.conversation_members (
    conversation_id uuid not null references public.conversations(id) on delete cascade,
    user_id         uuid not null references public.profiles(id) on delete cascade,
    role            text not null default 'member' check (role in ('owner', 'member')),
    added_by        uuid references public.profiles(id) on delete set null,
    joined_at       timestamptz not null default now(),
    last_read_at    timestamptz not null default now(),
    muted           boolean not null default false,
    primary key (conversation_id, user_id)
);
create index if not exists conversation_members_user_idx on public.conversation_members (user_id);
alter table public.conversation_members enable row level security;

create or replace function public.is_conversation_member(p_conversation uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.conversation_members where conversation_id = p_conversation and user_id = p_user);
$$;

create policy "Members see their conversations" on public.conversations
    for select to authenticated using ((select public.is_conversation_member(id, (select auth.uid()))));
create policy "Members see who else is in the chat" on public.conversation_members
    for select to authenticated using ((select public.is_conversation_member(conversation_id, (select auth.uid()))));
-- everything else about membership goes through the functions below

create table if not exists public.conversation_keys (
    conversation_id uuid not null references public.conversations(id) on delete cascade,
    version         int  not null,
    user_id         uuid not null references public.profiles(id) on delete cascade,
    wrapped_key     text not null check (char_length(wrapped_key) <= 400),
    iv              text not null check (char_length(iv) <= 64),
    wrapped_by      uuid not null references public.profiles(id) on delete cascade,
    -- which of the two people's key pairs were used, so a rotated key pair is noticed
    wrapper_key_id  text not null,
    member_key_id   text not null,
    created_at      timestamptz not null default now(),
    primary key (conversation_id, version, user_id)
);
alter table public.conversation_keys enable row level security;

create policy "Members read their own conversation keys" on public.conversation_keys
    for select to authenticated using (user_id = (select auth.uid()) or wrapped_by = (select auth.uid()));
create policy "Members hand the key to other members" on public.conversation_keys
    for insert to authenticated with check (
        wrapped_by = (select auth.uid())
        and (select public.is_conversation_member(conversation_id, (select auth.uid())))
        and (select public.is_conversation_member(conversation_id, user_id))
        and version = (select c.key_version from public.conversations c where c.id = conversation_id));
-- a member who set up a new key pair (forgot their PIN) gets the key re-wrapped
create policy "Members refresh a member's conversation key" on public.conversation_keys
    for update to authenticated using ((select public.is_conversation_member(conversation_id, (select auth.uid()))))
    with check (wrapped_by = (select auth.uid()) and (select public.is_conversation_member(conversation_id, user_id)));

-- ---------- messages ----------
create table if not exists public.messages (
    id               uuid primary key default gen_random_uuid(),
    conversation_id  uuid not null references public.conversations(id) on delete cascade,
    sender_id        uuid references public.profiles(id) on delete set null,
    kind             text not null default 'message' check (kind in ('message', 'system')),
    key_version      int  not null default 1,
    -- AES-GCM(message key, JSON payload) and the message key wrapped with the
    -- conversation key; for a 'system' row ciphertext is a plain JSON event
    -- (someone joined or left), which the server knows anyway
    ciphertext       text not null check (char_length(ciphertext) <= 120000),
    iv               text not null default '',
    msg_key          text not null default '',
    msg_key_iv       text not null default '',
    attachment_paths text[] not null default '{}' check (cardinality(attachment_paths) <= 6),
    attachment_bytes bigint not null default 0,
    created_at       timestamptz not null default now(),
    deleted_at       timestamptz
);
create index if not exists messages_conversation_idx on public.messages (conversation_id, created_at desc);
create index if not exists messages_sender_idx on public.messages (sender_id);
alter table public.messages enable row level security;

create policy "Members read messages" on public.messages
    for select to authenticated using ((select public.is_conversation_member(conversation_id, (select auth.uid()))));
create policy "Members send messages as themselves" on public.messages
    for insert to authenticated with check (
        sender_id = (select auth.uid()) and kind = 'message'
        and (select public.is_conversation_member(conversation_id, (select auth.uid()))));

create or replace function public.guard_message_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    convo public.conversations;
    other uuid;
    path text;
begin
    if new.kind = 'system' then return new; end if;     -- written by the functions below
    select * into convo from public.conversations where id = new.conversation_id;
    if public.is_banned(new.sender_id) then
        raise exception 'Your account is suspended.' using errcode = 'P0001';
    end if;
    if public.is_muted(new.sender_id) then
        raise exception 'You are muted and cannot send messages right now.' using errcode = 'P0001';
    end if;
    -- the spam guard: a short burst limit and an hourly ceiling, both per person
    if not public.rate_limit_hit('msg:' || new.sender_id::text, 20, interval '30 seconds') then
        raise exception 'Whoa, slow down! You''re sending messages too fast.' using errcode = 'P0001';
    end if;
    if not public.rate_limit_hit('msg-hour:' || new.sender_id::text, 600, interval '1 hour') then
        raise exception 'You''ve sent a lot of messages this hour. Take a little break!' using errcode = 'P0001';
    end if;
    if cardinality(new.attachment_paths) > 0 then
        if not public.rate_limit_hit('msg-files:' || new.sender_id::text, 60, interval '1 day') then
            raise exception 'You''ve sent a lot of files today. Try again tomorrow.' using errcode = 'P0001';
        end if;
        foreach path in array new.attachment_paths loop
            if split_part(path, '/', 1) <> new.conversation_id::text then
                raise exception 'That attachment belongs to another chat.' using errcode = 'P0001';
            end if;
        end loop;
    end if;
    if convo.kind = 'dm' then
        select user_id into other from public.conversation_members
         where conversation_id = convo.id and user_id <> new.sender_id limit 1;
        if other is not null and public.is_blocked_between(new.sender_id, other) then
            raise exception 'You can''t message this person.' using errcode = 'P0001';
        end if;
    end if;
    new.created_at := now();
    new.deleted_at := null;
    new.key_version := convo.key_version;
    return new;
end $$;
create trigger messages_guard before insert on public.messages
    for each row execute function public.guard_message_insert();

create or replace function public.touch_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
    -- sending a message means you've read everything before it
    if new.sender_id is not null then
        update public.conversation_members set last_read_at = new.created_at
         where conversation_id = new.conversation_id and user_id = new.sender_id;
    end if;
    return null;
end $$;
create trigger messages_touch after insert on public.messages
    for each row execute function public.touch_conversation();

-- live delivery (Supabase Realtime checks the select policy per subscriber)
alter publication supabase_realtime add table public.messages;
