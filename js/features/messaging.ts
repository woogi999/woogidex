// ==================== private messages ====================
// Direct messages and group chats, end-to-end encrypted. The encryption
// itself is js/features/messaging-crypto.ts; this module is the plumbing:
// setting up and unlocking your keys, getting each chat's key, sending and
// receiving (Supabase Realtime, with polling as the fallback), encrypted file
// attachments, reports, and managing groups.
//
// The page is js/app/pages/MessagesPage.tsx (/messages, /messages/<chat id>).
//
// Bandwidth: messages are small and arrive over one Realtime channel; a chat
// loads 40 at a time. Pictures and videos travel with a tiny preview inside
// the (encrypted) message, so a chat full of photos shows instantly without
// downloading any of them; the full file is only fetched when opened, once,
// and kept in memory for the rest of the visit.

import { log } from '../core/log.ts';
import { state, api } from '../core/app.ts';
import { notify } from '../app/store.ts';
import { navigateRoute } from '../core/router.ts';
import { confirmDialog } from '../core/confirm-dialog.ts';
import * as C from './messaging-crypto.ts';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 6;
const PAGE = 40;
const BUCKET = 'chat-files';

export type KeyStatus = 'signed-out' | 'checking' | 'needs-setup' | 'needs-pin' | 'ready' | 'unsupported' | 'offline';

export interface ChatMember { id: string; username?: string; display_name?: string; avatar_url?: string; role: string; last_read_at?: string; has_key?: boolean; }
export interface Conversation {
    id: string; kind: 'dm' | 'group'; title: string; created_by: string | null; last_message_at: string; key_version: number;
    my_role: string; last_read_at: string; muted: boolean; unread: number; members: ChatMember[];
    preview?: string;
}
export interface Attachment {
    path: string; name: string; mime: string; size: number; key: string; iv: string;
    kind: 'image' | 'video' | 'audio' | 'voice' | 'file'; thumb?: string; width?: number; height?: number; duration?: number;
}
export interface ChatMessage {
    id: string; conversation_id: string; sender_id: string | null; kind: 'message' | 'system'; created_at: string; deleted_at: string | null;
    key_version: number;
    /** decrypted */
    text?: string; attachments?: Attachment[]; replyTo?: string | null; event?: any;
    /** the message's own key, kept to answer a report without asking again */
    msgKey?: string;
    error?: string; pending?: boolean;
    raw?: any;
}

interface MessagingState {
    status: KeyStatus;
    statusFor: string | null;
    identity: C.Identity | null;
    conversations: Conversation[];
    conversationsLoaded: boolean;
    activeId: string | null;
    threads: Record<string, { items: ChatMessage[]; loading: boolean; hasMore: boolean; keyMissing: boolean; error: string }>;
    unreadTotal: number;
    live: boolean;
}

function ms(): MessagingState {
    if (!state.messaging) {
        state.messaging = {
            status: 'signed-out', statusFor: null, identity: null, conversations: [], conversationsLoaded: false,
            activeId: null, threads: {}, unreadTotal: 0, live: false
        } as MessagingState;
    }
    return state.messaging;
}
export function messagingState(): MessagingState { return ms(); }

const publicKeys = new Map<string, { jwk: JsonWebKey; keyId: string }>();
const chatKeys = new Map<string, { key: CryptoKey; raw: Uint8Array<ArrayBuffer> }>();   // `${cid}:${version}`
const fileUrls = new Map<string, string>();                        // storage path -> blob: url
const fileLoads = new Map<string, Promise<string>>();

// ==================== your keys ====================
const idKey = (uid: string) => `identity:${uid}`;
const chatKeyKey = (uid: string, cid: string, v: number) => `chat:${uid}:${cid}:${v}`;

export async function onMessagingAuthChange() {
    const m = ms();
    const uid = state.user?.id || null;
    if (m.statusFor === uid) return;
    stopLive();
    m.statusFor = uid;
    m.identity = null;
    m.conversations = [];
    m.conversationsLoaded = false;
    m.threads = {};
    m.activeId = null;
    m.unreadTotal = 0;
    publicKeys.clear();
    chatKeys.clear();
    if (!uid) { m.status = 'signed-out'; stopUnreadPolling(); notify(); return; }
    if (!globalThis.crypto?.subtle || typeof indexedDB === 'undefined') { m.status = 'unsupported'; notify(); return; }
    m.status = 'checking';
    notify();
    await checkKeys();
    startUnreadPolling();
}

async function checkKeys() {
    const m = ms();
    const uid = state.user?.id;
    if (!uid) return;
    try {
        const client = await api.getClient();
        const { data: pub, error } = await client.from('user_public_keys').select('public_key, key_id').eq('user_id', uid).maybeSingle();
        if (error) throw error;
        const local = await C.idbGet<C.Identity>(idKey(uid));
        if (pub && local && local.keyId === pub.key_id) {
            m.identity = local;
            m.status = 'ready';
            startLive();
        } else if (pub) {
            m.status = 'needs-pin';
        } else {
            m.status = 'needs-setup';
        }
    } catch (e: any) {
        log.warn('MESSAGES', 'Could not check message keys', e);
        m.status = /user_public_keys/.test(String(e?.message)) ? 'unsupported' : 'offline';
    }
    notify();
}

function checkPin(pin: string) {
    if (String(pin || '').length < 6) throw new Error('Pick a PIN of at least 6 characters.');
}

/**
 * First time: makes your key pair, backs it up under your PIN, and publishes
 * the public half. Also how a forgotten PIN is replaced (old chats you never
 * opened on this device become unreadable, which the page warns about).
 */
export async function setupMessaging(pin: string): Promise<void> {
    checkPin(pin);
    const uid = state.user?.id;
    if (!uid) throw new Error('Sign in first.');
    const { identity, pkcs8 } = await C.generateIdentity();
    const backup = await C.sealBackup(pkcs8, pin, identity.keyId);
    const client = await api.getClient();
    const b = await client.from('user_key_backups').upsert({ user_id: uid, ...backup, updated_at: new Date().toISOString() });
    if (b.error) throw new Error('Could not save your key backup: ' + b.error.message);
    const p = await client.from('user_public_keys').upsert({ user_id: uid, public_key: identity.publicJwk, key_id: identity.keyId, updated_at: new Date().toISOString() });
    if (p.error) throw new Error('Could not publish your key: ' + p.error.message);
    await C.idbSet(idKey(uid), identity);
    const m = ms();
    m.identity = identity;
    m.status = 'ready';
    publicKeys.set(uid, { jwk: identity.publicJwk, keyId: identity.keyId });
    log.info('MESSAGES', 'Message keys set up');
    notify();
    startLive();
    loadConversations();
}

/** On a new device: opens the backup with your PIN. */
export async function unlockMessaging(pin: string): Promise<void> {
    const uid = state.user?.id;
    if (!uid) throw new Error('Sign in first.');
    const client = await api.getClient();
    const [{ data: backup }, { data: pub }] = await Promise.all([
        client.from('user_key_backups').select('key_id, wrapped_key, iv, salt, iterations').eq('user_id', uid).maybeSingle(),
        client.from('user_public_keys').select('public_key, key_id').eq('user_id', uid).maybeSingle()
    ]);
    if (!backup || !pub) throw new Error('No key backup was found. Set up messages again.');
    const identity = await C.unlockBackup(backup, pub.public_key, pin);
    await C.idbSet(idKey(uid), identity);
    const m = ms();
    m.identity = identity;
    m.status = 'ready';
    notify();
    startLive();
    loadConversations();
}

export async function resetMessagingKeys(pin: string): Promise<void> {
    if (!await confirmDialog({
        title: 'Start over with new keys?',
        message: 'Your chats stay, but messages you haven’t opened on this device before can’t be read any more. People in your chats will hand you the keys for new messages automatically.',
        confirmLabel: 'Reset my keys'
    })) return;
    await C.idbDeletePrefix(`chat:${state.user?.id}:`);
    chatKeys.clear();
    await setupMessaging(pin);
}

// ==================== conversations ====================
export async function loadConversations() {
    const m = ms();
    if (!state.user) return;
    try {
        const client = await api.getClient();
        const { data, error } = await client.rpc('my_conversations');
        if (error) throw error;
        const old = new Map(m.conversations.map(c => [c.id, c]));
        m.conversations = (data || []).map((c: any) => ({ ...c, unread: Number(c.unread || 0), members: c.members || [], preview: old.get(c.id)?.preview }));
        m.conversationsLoaded = true;
        m.unreadTotal = m.conversations.filter(c => !c.muted).reduce((s, c) => s + c.unread, 0);
        for (const c of m.conversations) for (const mem of c.members) if (!mem.has_key) publicKeys.delete(mem.id);
        notify();
        if (m.status === 'ready') loadPreviews();
    } catch (e: any) {
        log.warn('MESSAGES', 'Could not load chats', e);
        m.conversationsLoaded = true;
        notify();
    }
}

/** The newest message of the top chats, decrypted for the inbox list. */
async function loadPreviews() {
    const m = ms();
    const top = m.conversations.slice(0, 20);
    if (!top.length) return;
    try {
        const client = await api.getClient();
        const { data } = await client.from('messages')
            .select('id, conversation_id, sender_id, kind, key_version, ciphertext, iv, msg_key, msg_key_iv, created_at, deleted_at')
            .in('conversation_id', top.map(c => c.id))
            .eq('kind', 'message')
            .order('created_at', { ascending: false })
            .limit(top.length * 3);
        const newest = new Map<string, any>();
        for (const row of data || []) if (!newest.has(row.conversation_id)) newest.set(row.conversation_id, row);
        await Promise.all([...newest.values()].map(async row => {
            const convo = m.conversations.find(c => c.id === row.conversation_id);
            if (!convo) return;
            const msg = await decryptRow(row, { fetchKey: false });
            const who = row.sender_id === state.user?.id ? 'You: ' : '';
            convo.preview = msg.deleted_at ? `${who}Message deleted`
                : msg.error ? '🔒 Encrypted message'
                : `${who}${msg.text?.trim() || attachmentSummary(msg.attachments || [])}`;
        }));
        notify();
    } catch (e: any) {
        log.debug('MESSAGES', 'Previews skipped', { error: String(e?.message || e) });
    }
}

function attachmentSummary(list: Attachment[]): string {
    if (!list.length) return '';
    const k = list[0].kind;
    const label = k === 'image' ? 'a photo' : k === 'video' ? 'a video' : k === 'voice' ? 'a voice message' : k === 'audio' ? 'an audio clip' : 'a file';
    return list.length > 1 ? `Sent ${list.length} attachments` : `Sent ${label}`;
}

export function conversationTitle(c: Conversation | null | undefined): string {
    if (!c) return 'Chat';
    if (c.kind === 'group') return c.title || c.members.filter(x => x.id !== state.user?.id).map(memberName).slice(0, 3).join(', ') || 'Group chat';
    const other = c.members.find(x => x.id !== state.user?.id);
    return other ? memberName(other) : 'Just you';
}

export function memberName(m: ChatMember | null | undefined): string {
    return m?.display_name || m?.username || 'Someone';
}

export function otherMember(c: Conversation | null | undefined): ChatMember | null {
    return c?.members.find(x => x.id !== state.user?.id) || null;
}

/** Opens the inbox, or a chat in it. */
export async function openMessages(conversationId: string | null = null, { preserveRoute = false } = {}): Promise<boolean> {
    if (!api.requireAccount?.('Sign in to see your messages.', () => openMessages(conversationId, { preserveRoute }))) return false;
    api.activateTopLevelView?.('messages-view');
    api.setPageTitle?.('Messages');
    const m = ms();
    if (m.status === 'signed-out' || m.statusFor !== state.user?.id) await onMessagingAuthChange();
    if (!preserveRoute) navigateRoute(conversationId ? `messages/${encodeURIComponent(conversationId)}` : 'messages');
    if (!m.conversationsLoaded || !conversationId) await loadConversations();
    if (conversationId) await openConversation(conversationId);
    else { m.activeId = null; notify(); }
    return true;
}

/** Message someone: finds or makes your DM with them and opens it. */
export async function messageUser(userId: string) {
    if (!api.requireAccount?.('Sign in to send messages.')) return;
    try {
        const client = await api.getClient();
        const { data, error } = await client.rpc('start_direct_chat', { p_other: userId });
        if (error) throw error;
        await loadConversations();
        await openMessages(data);
    } catch (e: any) {
        api.showToast?.(cleanError(e) || 'Could not start that chat.', 'error');
    }
}

export async function createGroupChat(title: string, memberIds: string[]): Promise<string | null> {
    try {
        const client = await api.getClient();
        const { data, error } = await client.rpc('create_group_chat', { p_title: title, p_members: memberIds });
        if (error) throw error;
        await loadConversations();
        await openMessages(data);
        return data;
    } catch (e: any) {
        api.showToast?.(cleanError(e) || 'Could not make the group.', 'error');
        return null;
    }
}

export async function addGroupMembers(conversationId: string, memberIds: string[]): Promise<boolean> {
    try {
        const client = await api.getClient();
        const { error } = await client.rpc('add_group_members', { p_conversation: conversationId, p_members: memberIds });
        if (error) throw error;
        await loadConversations();
        await shareKeyWithMembers(conversationId);
        await refreshThread(conversationId);
        return true;
    } catch (e: any) {
        api.showToast?.(cleanError(e) || 'Could not add them.', 'error');
        return false;
    }
}

export async function removeGroupMember(conversationId: string, userId: string, name = 'them'): Promise<boolean> {
    const leaving = userId === state.user?.id;
    if (!await confirmDialog(leaving
        ? { title: 'Leave this chat?', message: 'You won’t get its messages any more.', confirmLabel: 'Leave' }
        : { title: `Remove ${name}?`, message: 'They won’t be able to read anything said after this.', confirmLabel: 'Remove' })) return false;
    try {
        const client = await api.getClient();
        const { error } = await client.rpc('remove_group_member', { p_conversation: conversationId, p_user: userId });
        if (error) throw error;
        await loadConversations();
        if (leaving) { await openMessages(null); }
        else await refreshThread(conversationId);
        return true;
    } catch (e: any) {
        api.showToast?.(cleanError(e) || 'Could not do that.', 'error');
        return false;
    }
}

export async function renameGroupChat(conversationId: string, title: string) {
    const client = await api.getClient();
    const { error } = await client.rpc('rename_group_chat', { p_conversation: conversationId, p_title: title });
    if (error) { api.showToast?.(cleanError(error), 'error'); return; }
    await loadConversations();
}

export async function setChatMuted(conversationId: string, muted: boolean) {
    const client = await api.getClient();
    await client.rpc('set_conversation_muted', { p_conversation: conversationId, p_muted: muted });
    await loadConversations();
}

function cleanError(e: any): string {
    return String(e?.message || e || '').replace(/^.*?ERROR:\s*/, '');
}

// ==================== chat keys ====================
async function publicKeyOf(userId: string): Promise<{ jwk: JsonWebKey; keyId: string } | null> {
    if (publicKeys.has(userId)) return publicKeys.get(userId)!;
    const client = await api.getClient();
    const { data } = await client.from('user_public_keys').select('user_id, public_key, key_id').eq('user_id', userId).maybeSingle();
    if (!data) return null;
    const entry = { jwk: data.public_key, keyId: data.key_id };
    publicKeys.set(userId, entry);
    return entry;
}

async function publicKeysOf(userIds: string[]) {
    const missing = userIds.filter(id => !publicKeys.has(id));
    if (missing.length) {
        const client = await api.getClient();
        const { data } = await client.from('user_public_keys').select('user_id, public_key, key_id').in('user_id', missing);
        for (const row of data || []) publicKeys.set(row.user_id, { jwk: row.public_key, keyId: row.key_id });
    }
    return userIds.map(id => ({ id, key: publicKeys.get(id) || null }));
}

/**
 * The chat's key for a version: from memory, from this device, or unwrapped
 * from the server. For the current version, if nobody has made one yet (a new
 * chat, or a group right after someone left), this browser makes it and hands
 * it to everyone who has messaging set up.
 * @returns null when it isn't available to you yet (someone has to hand it over)
 */
async function chatKey(conversationId: string, version: number, { create = false, fetchKey = true } = {}) {
    const m = ms();
    const uid = state.user?.id;
    if (!uid || !m.identity) return null;
    const cacheKey = `${conversationId}:${version}`;
    if (chatKeys.has(cacheKey)) return chatKeys.get(cacheKey)!;
    const stored = await C.idbGet<Uint8Array<ArrayBuffer>>(chatKeyKey(uid, conversationId, version));
    if (stored) {
        const entry = { raw: stored, key: await C.chatKeyFromBytes(stored) };
        chatKeys.set(cacheKey, entry);
        return entry;
    }
    if (!fetchKey) return null;
    const client = await api.getClient();
    const { data: row } = await client.from('conversation_keys')
        .select('wrapped_key, iv, wrapped_by, wrapper_key_id, member_key_id')
        .eq('conversation_id', conversationId).eq('version', version).eq('user_id', uid).maybeSingle();
    if (row && row.member_key_id === m.identity.keyId) {
        const wrapper = row.wrapped_by === uid ? { jwk: m.identity.publicJwk } : await publicKeyOf(row.wrapped_by);
        if (wrapper) {
            try {
                const opened = await C.unwrapChatKey(row, m.identity, wrapper.jwk, conversationId, version);
                await C.idbSet(chatKeyKey(uid, conversationId, version), opened.raw);
                chatKeys.set(cacheKey, opened);
                return opened;
            } catch (e: any) {
                log.warn('MESSAGES', 'A chat key would not open (the person who shared it may have reset their keys)', { conversationId, version });
            }
        }
    }
    if (!create) return null;
    // nobody holds this version yet: make it
    const { data: holders } = await client.rpc('conversation_key_holders', { p_conversation: conversationId });
    if ((holders || []).length) return null;      // someone has it, but not for you yet
    const convo = m.conversations.find(c => c.id === conversationId);
    const memberIds = convo ? convo.members.map(x => x.id) : [uid];
    const raw = C.newChatKeyBytes();
    const rows: any[] = [];
    for (const { id, key } of await publicKeysOf(memberIds)) {
        const target = id === uid ? { jwk: m.identity.publicJwk, keyId: m.identity.keyId } : key;
        if (!target) continue;      // hasn't set up messages yet; gets it later
        const wrapped = await C.wrapChatKey(raw, m.identity, target.jwk, conversationId, version);
        rows.push({ conversation_id: conversationId, version, user_id: id, ...wrapped, wrapped_by: uid, wrapper_key_id: m.identity.keyId, member_key_id: target.keyId });
    }
    // one insert for everyone: if someone else made a key at the same moment,
    // this fails as a whole and we take theirs instead
    const { error } = await client.from('conversation_keys').insert(rows);
    if (error) {
        log.info('MESSAGES', 'Another member made this chat key first; using theirs', { conversationId });
        return chatKey(conversationId, version, { create: false });
    }
    const entry = { raw, key: await C.chatKeyFromBytes(raw) };
    await C.idbSet(chatKeyKey(uid, conversationId, version), raw);
    chatKeys.set(cacheKey, entry);
    return entry;
}

/**
 * Hands the current chat key to members who don't have it: someone just
 * added, someone who only now set up messages, someone who reset their keys.
 * Any member's browser does this when it opens the chat.
 */
async function shareKeyWithMembers(conversationId: string) {
    const m = ms();
    const uid = state.user?.id;
    const convo = m.conversations.find(c => c.id === conversationId);
    if (!uid || !m.identity || !convo) return;
    const mine = await chatKey(conversationId, convo.key_version, { create: true });
    if (!mine) return;
    const client = await api.getClient();
    const { data: holders } = await client.rpc('conversation_key_holders', { p_conversation: conversationId });
    const held = new Map<string, string>((holders || []).map((h: any) => [h.user_id, h.member_key_id]));
    const needing = convo.members.filter(x => x.id !== uid && x.has_key !== false);
    for (const { id, key } of await publicKeysOf(needing.map(x => x.id))) {
        if (!key || held.get(id) === key.keyId) continue;
        const wrapped = await C.wrapChatKey(mine.raw, m.identity, key.jwk, conversationId, convo.key_version);
        const row = { conversation_id: conversationId, version: convo.key_version, user_id: id, ...wrapped, wrapped_by: uid, wrapper_key_id: m.identity.keyId, member_key_id: key.keyId };
        const { error } = held.has(id)
            ? await client.from('conversation_keys').update(row).eq('conversation_id', conversationId).eq('version', convo.key_version).eq('user_id', id)
            : await client.from('conversation_keys').insert(row);
        if (error) log.debug('MESSAGES', 'Could not hand a chat key over', { id, error: error.message });
    }
}

// ==================== reading ====================
async function decryptRow(row: any, { fetchKey = true } = {}): Promise<ChatMessage> {
    const base: ChatMessage = {
        id: row.id, conversation_id: row.conversation_id, sender_id: row.sender_id, kind: row.kind,
        created_at: row.created_at, deleted_at: row.deleted_at, key_version: row.key_version, raw: row
    };
    if (row.kind === 'system') {
        try { return { ...base, event: JSON.parse(row.ciphertext) }; } catch { return { ...base, event: {} }; }
    }
    if (row.deleted_at || !row.ciphertext) return base;
    try {
        const key = await chatKey(row.conversation_id, row.key_version, { fetchKey });
        if (!key) return { ...base, error: 'locked' };
        const { payload, msgKey } = await C.openMessage(row, key.key, row.conversation_id);
        return { ...base, text: String(payload?.text || ''), attachments: Array.isArray(payload?.attachments) ? payload.attachments : [], replyTo: payload?.replyTo || null, msgKey };
    } catch (e: any) {
        return { ...base, error: 'unreadable' };
    }
}

const MESSAGE_COLUMNS = 'id, conversation_id, sender_id, kind, key_version, ciphertext, iv, msg_key, msg_key_iv, attachment_paths, created_at, deleted_at';

function thread(cid: string) {
    const m = ms();
    m.threads[cid] ||= { items: [], loading: false, hasMore: true, keyMissing: false, error: '' };
    return m.threads[cid];
}

export async function openConversation(conversationId: string) {
    const m = ms();
    m.activeId = conversationId;
    const convo = m.conversations.find(c => c.id === conversationId);
    if (!convo) {
        thread(conversationId).error = 'This chat doesn’t exist, or you’re not in it any more.';
        notify();
        return;
    }
    api.setPageTitle?.(`${conversationTitle(convo)} · Messages`);
    notify();
    if (m.status !== 'ready') return;
    await refreshThread(conversationId);
    markRead(conversationId);
    // in the background: make sure everyone else can read what's sent here
    shareKeyWithMembers(conversationId).catch(e => log.debug('MESSAGES', 'Key sharing skipped', { error: String(e?.message || e) }));
}

async function refreshThread(conversationId: string) {
    const t = thread(conversationId);
    t.loading = true;
    t.error = '';
    notify();
    try {
        const convo = ms().conversations.find(c => c.id === conversationId);
        // make the current key if this is a brand new chat
        if (convo) await chatKey(conversationId, convo.key_version, { create: true });
        const client = await api.getClient();
        const { data, error } = await client.from('messages').select(MESSAGE_COLUMNS)
            .eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(PAGE);
        if (error) throw error;
        const items = await Promise.all((data || []).reverse().map(r => decryptRow(r)));
        // keep anything still sending
        t.items = [...items, ...t.items.filter(x => x.pending)];
        t.hasMore = (data || []).length === PAGE;
        t.keyMissing = items.some(x => x.error === 'locked');
    } catch (e: any) {
        log.error('MESSAGES', 'Could not load messages', e);
        t.error = 'Couldn’t load this chat.';
    } finally {
        t.loading = false;
        notify();
    }
}

export async function loadOlderMessages(conversationId: string) {
    const t = thread(conversationId);
    if (t.loading || !t.hasMore || !t.items.length) return;
    t.loading = true;
    notify();
    try {
        const oldest = t.items.find(x => !x.pending)?.created_at;
        const client = await api.getClient();
        const { data, error } = await client.from('messages').select(MESSAGE_COLUMNS)
            .eq('conversation_id', conversationId).lt('created_at', oldest).order('created_at', { ascending: false }).limit(PAGE);
        if (error) throw error;
        const older = await Promise.all((data || []).reverse().map(r => decryptRow(r)));
        t.items = [...older, ...t.items];
        t.hasMore = (data || []).length === PAGE;
    } catch (e: any) {
        log.warn('MESSAGES', 'Older messages failed', e);
    } finally {
        t.loading = false;
        notify();
    }
}

async function markRead(conversationId: string) {
    const convo = ms().conversations.find(c => c.id === conversationId);
    if (convo) {
        convo.unread = 0;
        convo.last_read_at = new Date().toISOString();
        ms().unreadTotal = ms().conversations.filter(c => !c.muted).reduce((s, c) => s + c.unread, 0);
        notify();
    }
    try {
        const client = await api.getClient();
        await client.rpc('mark_conversation_read', { p_conversation: conversationId });
    } catch { /* the count catches up on the next load */ }
}

// ==================== sending ====================
function fileKind(file: File, voice = false): Attachment['kind'] {
    if (voice) return 'voice';
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    if (file.type.startsWith('audio/')) return 'audio';
    return 'file';
}

// a small preview that travels inside the message, so the chat shows
// pictures without downloading them
async function imagePreview(source: CanvasImageSource, w: number, h: number): Promise<string> {
    const MAX = 240;
    const scale = Math.min(1, MAX / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/webp', 0.55);
    return url.length < 40000 ? url : canvas.toDataURL('image/jpeg', 0.4);
}

async function describeFile(file: File, kind: Attachment['kind']): Promise<Partial<Attachment>> {
    try {
        if (kind === 'image' && !/gif/.test(file.type)) {
            const bmp = await createImageBitmap(file);
            const out = { width: bmp.width, height: bmp.height, thumb: await imagePreview(bmp, bmp.width, bmp.height) };
            bmp.close();
            return out;
        }
        if (kind === 'image') {
            // a GIF's preview is its first frame; opening it plays the real thing
            const bmp = await createImageBitmap(file);
            const out = { width: bmp.width, height: bmp.height, thumb: await imagePreview(bmp, bmp.width, bmp.height) };
            bmp.close();
            return out;
        }
        if (kind === 'video') {
            const url = URL.createObjectURL(file);
            try {
                const video = document.createElement('video');
                video.muted = true;
                video.preload = 'metadata';
                video.src = url;
                await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error('video')); setTimeout(resolve, 4000); });
                video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
                await new Promise<void>(resolve => { video.onseeked = () => resolve(); setTimeout(resolve, 1500); });
                return { width: video.videoWidth, height: video.videoHeight, duration: Number.isFinite(video.duration) ? video.duration : undefined, thumb: video.videoWidth ? await imagePreview(video, video.videoWidth, video.videoHeight) : undefined };
            } finally { URL.revokeObjectURL(url); }
        }
        if (kind === 'audio' || kind === 'voice') {
            const url = URL.createObjectURL(file);
            try {
                const audio = document.createElement('audio');
                audio.preload = 'metadata';
                audio.src = url;
                await new Promise<void>(resolve => { audio.onloadedmetadata = () => resolve(); audio.onerror = () => resolve(); setTimeout(resolve, 3000); });
                return { duration: Number.isFinite(audio.duration) ? audio.duration : undefined };
            } finally { URL.revokeObjectURL(url); }
        }
    } catch (e: any) {
        log.debug('MESSAGES', 'No preview for this file', { name: file.name, error: String(e?.message || e) });
    }
    return {};
}

export function fileProblem(file: File): string {
    if (file.size > MAX_FILE_BYTES) return `${file.name} is bigger than 10 MB.`;
    if (!file.size) return `${file.name} is empty.`;
    return '';
}

export interface Outgoing { file: File; voice?: boolean; duration?: number; }

export async function sendMessage(conversationId: string, text: string, files: Outgoing[] = [], replyTo: string | null = null): Promise<boolean> {
    const m = ms();
    const uid = state.user?.id;
    const convo = m.conversations.find(c => c.id === conversationId);
    if (!uid || !convo || m.status !== 'ready') return false;
    const body = String(text || '').trim();
    if (!body && !files.length) return false;
    if (body.length > 4000) { api.showToast?.('Messages can be up to 4000 characters.', 'warning'); return false; }
    if (files.length > MAX_FILES_PER_MESSAGE) { api.showToast?.(`Up to ${MAX_FILES_PER_MESSAGE} files per message.`, 'warning'); return false; }
    for (const f of files) { const p = fileProblem(f.file); if (p) { api.showToast?.(p, 'warning'); return false; } }

    const t = thread(conversationId);
    const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const pending: ChatMessage = {
        id: tempId, conversation_id: conversationId, sender_id: uid, kind: 'message', created_at: new Date().toISOString(),
        deleted_at: null, key_version: convo.key_version, text: body, attachments: [], pending: true
    };
    t.items = [...t.items, pending];
    notify();

    const uploaded: string[] = [];
    try {
        const key = await chatKey(conversationId, convo.key_version, { create: true });
        if (!key) throw new Error('This chat’s key hasn’t reached you yet. Ask someone in the chat to open it, then try again.');
        const client = await api.getClient();
        const attachments: Attachment[] = [];
        let bytes = 0;
        for (const out of files) {
            const kind = fileKind(out.file, out.voice);
            const meta = await describeFile(out.file, kind);
            const sealed = await C.sealFile(await out.file.arrayBuffer(), conversationId);
            const path = `${conversationId}/${crypto.randomUUID()}.bin`;
            const { error } = await client.storage.from(BUCKET).upload(path, new Blob([sealed.body], { type: 'application/octet-stream' }), {
                contentType: 'application/octet-stream', upsert: false, cacheControl: '31536000'
            });
            if (error) throw new Error(/row-level security|policy/i.test(error.message) ? 'You’ve sent a lot of files today. Try again tomorrow.' : `Upload failed: ${error.message}`);
            uploaded.push(path);
            bytes += sealed.body.byteLength;
            attachments.push({
                path, name: out.file.name || (kind === 'voice' ? 'Voice message' : 'file'), mime: out.file.type || 'application/octet-stream',
                size: out.file.size, key: sealed.key, iv: sealed.iv, kind, ...meta,
                ...(out.duration ? { duration: out.duration } : {})
            });
        }
        const payload = { v: 1, text: body, attachments, replyTo };
        const sealed = await C.sealMessage(payload, key.key, conversationId);
        const { data, error } = await client.from('messages').insert({
            conversation_id: conversationId, sender_id: uid, kind: 'message', key_version: convo.key_version,
            ...sealed, attachment_paths: uploaded, attachment_bytes: bytes
        }).select(MESSAGE_COLUMNS).single();
        if (error) throw new Error(cleanError(error));
        const sent = await decryptRow(data);
        t.items = t.items.map(x => (x.id === tempId ? sent : x)).filter((x, i, all) => all.findIndex(y => y.id === x.id) === i);
        convo.last_message_at = sent.created_at;
        convo.preview = `You: ${body || attachmentSummary(attachments)}`;
        m.conversations = [convo, ...m.conversations.filter(c => c.id !== convo.id)];
        notify();
        return true;
    } catch (e: any) {
        log.error('MESSAGES', 'Send failed', e);
        // files that made it up before the failure would otherwise sit there unused
        if (uploaded.length) { try { (await api.getClient()).storage.from(BUCKET).remove(uploaded); } catch {} }
        t.items = t.items.filter(x => x.id !== tempId);
        api.showToast?.(e?.message || 'Could not send that.', 'error');
        notify();
        return false;
    }
}

export async function deleteMessage(msg: ChatMessage) {
    if (!await confirmDialog({ title: 'Delete this message?', message: 'It’s removed for everyone in the chat.', confirmLabel: 'Delete' })) return;
    try {
        const client = await api.getClient();
        const { data: paths, error } = await client.rpc('delete_my_message', { p_message: msg.id });
        if (error) throw error;
        if (Array.isArray(paths) && paths.length) await client.storage.from(BUCKET).remove(paths);
        const t = thread(msg.conversation_id);
        t.items = t.items.map(x => (x.id === msg.id ? { ...x, deleted_at: new Date().toISOString(), text: '', attachments: [] } : x));
        notify();
    } catch (e: any) {
        api.showToast?.(cleanError(e) || 'Could not delete it.', 'error');
    }
}

// ==================== attachments ====================
/** Downloads, decrypts and returns a blob: URL for an attachment (once per visit). */
export function attachmentUrl(conversationId: string, att: Attachment): Promise<string> {
    if (fileUrls.has(att.path)) return Promise.resolve(fileUrls.get(att.path)!);
    if (fileLoads.has(att.path)) return fileLoads.get(att.path)!;
    const load = (async () => {
        const client = await api.getClient();
        const { data, error } = await client.storage.from(BUCKET).download(att.path);
        if (error || !data) throw new Error('That file isn’t available any more.');
        const plain = await C.openFile(await data.arrayBuffer(), att.key, att.iv, conversationId);
        const url = URL.createObjectURL(new Blob([plain], { type: att.mime || 'application/octet-stream' }));
        fileUrls.set(att.path, url);
        return url;
    })();
    fileLoads.set(att.path, load);
    load.catch(() => fileLoads.delete(att.path));
    return load;
}

export function cachedAttachmentUrl(path: string): string { return fileUrls.get(path) || ''; }

export async function saveAttachment(conversationId: string, att: Attachment) {
    try {
        const url = await attachmentUrl(conversationId, att);
        const a = document.createElement('a');
        a.href = url;
        a.download = att.name || 'file';
        a.click();
    } catch (e: any) {
        api.showToast?.(e?.message || 'Could not download that file.', 'error');
    }
}

// ==================== reports ====================
/**
 * Reports a message to the moderators. Your browser opens the message (and
 * up to ten messages before it, for context) and sends staff only those
 * messages' own keys -- enough to read exactly these, nothing else.
 */
export async function reportMessage(msg: ChatMessage, reason: string): Promise<boolean> {
    const t = thread(msg.conversation_id);
    const at = t.items.findIndex(x => x.id === msg.id);
    const context = t.items.slice(Math.max(0, at - 10), at + 1).filter(x => x.kind === 'message' && x.msgKey && !x.pending);
    if (!context.length) { api.showToast?.('That message can’t be reported (it couldn’t be opened).', 'error'); return false; }
    const keys = Object.fromEntries(context.map(x => [x.id, x.msgKey]));
    try {
        const client = await api.getClient();
        const { error } = await client.rpc('report_messages', {
            p_conversation: msg.conversation_id, p_message_ids: context.map(x => x.id), p_keys: keys, p_reason: String(reason || '').slice(0, 1000)
        });
        if (error) throw error;
        api.showToast?.('Thanks. The moderators can now see that message (and the few before it) to look into it.', 'success');
        return true;
    } catch (e: any) {
        api.showToast?.(cleanError(e) || 'Could not send the report.', 'error');
        return false;
    }
}

// ==================== staying up to date ====================
let channel: any = null;
let pollTimer: any = null;
let unreadTimer: any = null;
let reloadSoon: any = null;

async function startLive() {
    if (channel || !state.user) return;
    try {
        const client = await api.getClient();
        channel = client.channel(`messages:${state.user.id}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (payload: any) => onLiveChange(payload))
            .subscribe((status: string) => {
                const live = status === 'SUBSCRIBED';
                ms().live = live;
                // without the socket, an open chat checks in every 15 seconds instead
                if (!live) startPolling(); else stopPolling();
            });
    } catch (e: any) {
        log.warn('MESSAGES', 'Live updates unavailable; polling instead', e);
        startPolling();
    }
}

function stopLive() {
    if (channel) { try { channel.unsubscribe(); } catch {} channel = null; }
    stopPolling();
    ms().live = false;
}

function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
        const m = ms();
        if (document.visibilityState === 'hidden' || !m.activeId) return;
        if (document.getElementById('messages-view')?.style.display !== 'block') return;
        pollActive();
    }, 15000);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function pollActive() {
    const m = ms();
    const cid = m.activeId;
    if (!cid) return;
    const t = thread(cid);
    const newest = [...t.items].reverse().find(x => !x.pending)?.created_at;
    const client = await api.getClient();
    let q = client.from('messages').select(MESSAGE_COLUMNS).eq('conversation_id', cid).order('created_at', { ascending: true }).limit(PAGE);
    if (newest) q = q.gt('created_at', newest);
    const { data } = await q;
    if (!data?.length) return;
    const fresh = await Promise.all(data.map(r => decryptRow(r)));
    t.items = [...t.items, ...fresh.filter(f => !t.items.some(x => x.id === f.id))];
    markRead(cid);
    notify();
}

async function onLiveChange(payload: any) {
    const row = payload.new || {};
    const m = ms();
    if (!row.id || !row.conversation_id) return;
    const t = m.threads[row.conversation_id];
    if (payload.eventType === 'UPDATE') {
        if (t) t.items = t.items.map(x => (x.id === row.id ? { ...x, deleted_at: row.deleted_at, text: row.deleted_at ? '' : x.text, attachments: row.deleted_at ? [] : x.attachments } : x));
        notify();
        return;
    }
    if (row.sender_id === state.user?.id && t?.items.some(x => x.id === row.id)) return;
    const viewing = m.activeId === row.conversation_id && document.getElementById('messages-view')?.style.display === 'block' && document.visibilityState === 'visible';
    if (t) {
        const msg = await decryptRow(row);
        if (!t.items.some(x => x.id === msg.id)) t.items = [...t.items, msg];
        if (row.kind === 'system') scheduleReload();     // someone joined or left: refresh members and keys
    }
    const convo = m.conversations.find(c => c.id === row.conversation_id);
    if (!convo) { scheduleReload(); return; }
    convo.last_message_at = row.created_at;
    if (viewing) markRead(row.conversation_id);
    else if (row.sender_id !== state.user?.id && row.kind === 'message') {
        convo.unread += 1;
        if (!convo.muted) m.unreadTotal += 1;
    }
    m.conversations = [convo, ...m.conversations.filter(c => c.id !== convo.id)];
    if (row.kind === 'message') {
        decryptRow(row, { fetchKey: false }).then(msg => {
            const who = row.sender_id === state.user?.id ? 'You: ' : '';
            convo.preview = msg.error ? '🔒 New message' : `${who}${msg.text?.trim() || attachmentSummary(msg.attachments || [])}`;
            notify();
        });
    }
    notify();
}

function scheduleReload() {
    clearTimeout(reloadSoon);
    reloadSoon = setTimeout(() => {
        loadConversations().then(() => {
            const cid = ms().activeId;
            if (cid) shareKeyWithMembers(cid).catch(() => {});
        });
    }, 800);
}

// the header's unread badge, for when the inbox isn't open (cheap: one number)
function startUnreadPolling() {
    if (unreadTimer) return;
    const tick = async () => {
        if (!state.user || document.visibilityState === 'hidden') return;
        if (ms().live && ms().conversationsLoaded) return;     // live updates keep it right already
        try {
            const client = await api.getClient();
            const { data, error } = await client.rpc('unread_message_count');
            if (!error) { ms().unreadTotal = Number(data || 0); notify(); }
        } catch { /* try again next tick */ }
    };
    tick();
    unreadTimer = setInterval(tick, 60000);
}
function stopUnreadPolling() { if (unreadTimer) { clearInterval(unreadTimer); unreadTimer = null; } }

export function unreadMessageTotal(): number { return ms().unreadTotal; }

/** /messages and /messages/<id> */
export async function handleMessagesRoute(param: string): Promise<boolean> {
    return openMessages(param || null, { preserveRoute: true });
}
