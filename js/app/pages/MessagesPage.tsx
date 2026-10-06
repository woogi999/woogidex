// Private messages (/messages, /messages/<chat id>), laid out like Facebook
// Messenger: your chats down the left, the open chat on the right, and its
// details (people, mute, leave, block) in a panel you can open beside it.
// Everything in a chat is end-to-end encrypted (js/features/messaging.ts and
// messaging-crypto.ts); this page only ever sees it decrypted, in your browser.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from 'react';
import { api, state } from '../../core/app.ts';
import { Avatar } from '../components/Avatar.tsx';
import { Icon } from '../components/Icon.tsx';
import { EmojiInput, RichText } from '../components/EmojiInput.tsx';
import { Modal } from '../components/Modal.tsx';
import { registerDialog, openDialog, type DialogProps } from '../dialogs.tsx';
import { timeAgo } from '../components/feed.tsx';
import { useStore } from '../store.ts';
import type { Attachment, ChatMessage, Conversation, ChatMember, Outgoing } from '../../features/messaging.ts';
import { NAME_MAX } from '../../core/data.ts';

export function MessagesPage() {
    useStore();
    const m = api.messagingState();
    if (!state.user) return <div className="messenger-gate"><Icon name="lock-closed" size={28} /><p>Sign in to see your messages.</p></div>;
    if (m.status !== 'ready') return <KeyGate status={m.status} />;
    const active: Conversation | null = m.conversations.find((c: Conversation) => c.id === m.activeId) || null;
    return (
        <div className={`messenger${m.activeId ? ' has-active' : ''}`}>
            <ChatList conversations={m.conversations} loaded={m.conversationsLoaded} activeId={m.activeId} />
            {m.activeId ? <Thread key={m.activeId} conversationId={m.activeId} convo={active} /> : <NoChatOpen />}
        </div>
    );
}

// ==================== keys: set up, unlock ====================

function KeyGate({ status }: { status: string }) {
    const [pin, setPin] = useState('');
    const [pin2, setPin2] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [resetting, setResetting] = useState(false);

    if (status === 'checking' || status === 'signed-out') return <div className="messenger-gate"><div className="spinner" /><p>Getting your chats ready…</p></div>;
    if (status === 'unsupported') return <div className="messenger-gate"><Icon name="exclamation-triangle" size={28} /><p>Messages need a browser that can do encryption (any recent Chrome, Firefox, Safari or Edge), on the real site.</p></div>;
    if (status === 'offline') return <div className="messenger-gate"><Icon name="wifi" size={28} /><p>Couldn’t reach the server. Check your connection.</p><button type="button" className="btn btn-secondary btn-sm" onClick={() => api.onMessagingAuthChange?.()}>Try again</button></div>;

    const setup = status === 'needs-setup' || resetting;
    async function go() {
        setError('');
        if (setup && pin !== pin2) { setError('Those PINs don’t match.'); return; }
        setBusy(true);
        try {
            if (resetting) await api.resetMessagingKeys(pin);
            else if (setup) await api.setupMessaging(pin);
            else await api.unlockMessaging(pin);
        } catch (e: any) {
            setError(e?.message || 'Something went wrong.');
        } finally {
            setBusy(false);
        }
    }
    return (
        <div className="messenger-gate">
            <div className="messenger-gate-card panel">
                <div className="messenger-gate-icon"><Icon name="lock-closed" size={26} /></div>
                {setup ? (
                    <>
                        <h2>{resetting ? 'Pick a new chat PIN' : 'Private messages, for real'}</h2>
                        <p>Everything you send here is <strong>end-to-end encrypted</strong>: it's locked on your device before it leaves, and only the people in the chat can unlock it. Not even Woogidex's owners can read it.</p>
                        <p>Pick a <strong>chat PIN</strong> (6+ characters). It unlocks your messages when you sign in on another device. <strong>We can't reset it for you</strong>, so keep it somewhere safe.</p>
                    </>
                ) : (
                    <>
                        <h2>Unlock your messages</h2>
                        <p>This device hasn't opened your messages before. Enter your chat PIN to unlock them.</p>
                    </>
                )}
                <form onSubmit={e => { e.preventDefault(); go(); }}>
                    <input type="password" autoComplete={setup ? 'new-password' : 'current-password'} placeholder="Chat PIN" value={pin} onChange={e => setPin(e.target.value)} autoFocus minLength={6} />
                    {setup && <input type="password" autoComplete="new-password" placeholder="Type it again" value={pin2} onChange={e => setPin2(e.target.value)} minLength={6} />}
                    {error && <p className="auth-modal-error">{error}</p>}
                    <button type="submit" className="btn btn-primary" disabled={busy || pin.length < 6}>{busy ? 'One sec…' : setup ? 'Turn on messages' : 'Unlock'}</button>
                </form>
                {!setup && <button type="button" className="link-btn" onClick={() => { setResetting(true); setError(''); }}>Forgot your PIN? Start over with new keys</button>}
                {resetting && <p className="field-hint">Starting over keeps your chats, but older messages you never opened on this device can't be unlocked any more.</p>}
            </div>
        </div>
    );
}

// ==================== the list of chats ====================

function ChatAvatar({ convo, size = 'md' }: { convo: Conversation; size?: 'sm' | 'md' | 'lg' }) {
    const others = convo.members.filter(x => x.id !== state.user?.id);
    if (convo.kind === 'group' && others.length > 1) {
        return (
            <span className={`chat-avatar chat-avatar-${size} is-group`}>
                {others.slice(0, 2).map(o => <Avatar key={o.id} userId={o.id} url={o.avatar_url} name={o.display_name || o.username} className="chat-avatar-img" />)}
            </span>
        );
    }
    const o = others[0];
    return <span className={`chat-avatar chat-avatar-${size}`}><Avatar userId={o?.id} url={o?.avatar_url} name={o?.display_name || o?.username || '?'} className="chat-avatar-img" /></span>;
}

function ChatList({ conversations, loaded, activeId }: { conversations: Conversation[]; loaded: boolean; activeId: string | null }) {
    const [query, setQuery] = useState('');
    const list = conversations.filter(c => !query || api.conversationTitle(c).toLowerCase().includes(query.toLowerCase()));
    return (
        <aside className="chat-list" aria-label="Your chats">
            <div className="chat-list-head">
                <h2>Chats</h2>
                <div className="chat-list-actions">
                    <button type="button" className="chat-icon-btn" title="New group" aria-label="New group chat" onClick={() => openDialog('new-group-chat')}><Icon name="user-group" size={18} /></button>
                    <button type="button" className="chat-icon-btn" title="New message" aria-label="New message" onClick={() => openDialog('new-chat')}><Icon name="pencil-square" size={18} /></button>
                </div>
            </div>
            <input className="chat-search" type="search" placeholder="Search chats" value={query} onChange={e => setQuery(e.target.value)} />
            <div className="chat-list-items">
                {!loaded ? Array.from({ length: 5 }, (_, i) => <div className="chat-row skel-card" key={i}><span className="chat-avatar chat-avatar-md skel skel-circle" /><span className="skel skel-text" style={{ width: '60%' }} /></div>)
                    : !list.length ? (
                        <div className="chat-list-empty">
                            <p>{query ? 'No chats match.' : 'No chats yet.'}</p>
                            {!query && <button type="button" className="btn btn-primary btn-sm" onClick={() => openDialog('new-chat')}>Start one</button>}
                        </div>
                    ) : list.map(c => (
                        <button type="button" key={c.id} className={`chat-row${c.id === activeId ? ' active' : ''}${c.unread ? ' is-unread' : ''}`} onClick={() => api.openMessages(c.id)}>
                            <ChatAvatar convo={c} />
                            <span className="chat-row-text">
                                <span className="chat-row-title">{api.conversationTitle(c)}{c.muted && <Icon name="bell-slash" size={12} className="chat-muted" />}</span>
                                <span className="chat-row-preview">{c.preview || (c.kind === 'group' ? `${c.members.length} people` : 'Say hi!')} · {timeAgo(c.last_message_at)}</span>
                            </span>
                            {c.unread > 0 && <span className="chat-unread-dot" aria-label={`${c.unread} unread`}>{c.unread > 9 ? '9+' : c.unread}</span>}
                        </button>
                    ))}
            </div>
            <div className="chat-list-foot"><Icon name="lock-closed" size={12} /> End-to-end encrypted</div>
        </aside>
    );
}

function NoChatOpen() {
    return (
        <section className="chat-thread chat-thread-empty">
            <Icon name="chat-bubble-left-right" size={40} />
            <h3>Your messages</h3>
            <p>Send private messages, photos, videos and voice notes to people on Woogidex. Make a group with people who follow you.</p>
            <button type="button" className="btn btn-primary" onClick={() => openDialog('new-chat')}>Send a message</button>
        </section>
    );
}

// ==================== one chat ====================

function sameDay(a: string, b: string) { return new Date(a).toDateString() === new Date(b).toDateString(); }

function dayLabel(iso: string) {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function Thread({ conversationId, convo }: { conversationId: string; convo: Conversation | null }) {
    const m = api.messagingState();
    const t = m.threads[conversationId] || { items: [], loading: true, hasMore: false, keyMissing: false, error: '' };
    const [info, setInfo] = useState(false);
    const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const stick = useRef(true);
    const prevHeight = useRef(0);
    const me = state.user!.id;
    const byId = useMemo(() => new Map<string, ChatMember>((convo?.members || []).map(x => [x.id, x])), [convo]);

    // stay pinned to the bottom unless you've scrolled up to read
    useLayoutEffect(() => {
        const el = scroller.current;
        if (!el) return;
        if (stick.current) el.scrollTop = el.scrollHeight;
        else if (prevHeight.current && el.scrollHeight > prevHeight.current && el.scrollTop < 40) el.scrollTop = el.scrollHeight - prevHeight.current;
        prevHeight.current = el.scrollHeight;
    }, [t.items.length]);

    function onScroll() {
        const el = scroller.current!;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (el.scrollTop < 60 && t.hasMore && !t.loading) { prevHeight.current = el.scrollHeight; api.loadOlderMessages(conversationId); }
    }

    if (!convo) {
        return <section className="chat-thread chat-thread-empty"><Icon name="exclamation-triangle" size={28} /><p>{t.error || 'This chat isn’t available.'}</p><button type="button" className="btn btn-secondary btn-sm" onClick={() => api.openMessages(null)}>Back to chats</button></section>;
    }
    const other = api.otherMember(convo);
    const waitingOn = convo.members.filter(x => x.id !== me && x.has_key === false);

    return (
        <div className={`chat-thread-wrap${info ? ' info-open' : ''}`}>
            <section className="chat-thread" aria-label={`Chat with ${api.conversationTitle(convo)}`}>
                <header className="chat-head">
                    <button type="button" className="chat-icon-btn chat-back" aria-label="Back to chats" onClick={() => api.openMessages(null)}><Icon name="arrow-left" size={18} /></button>
                    <button type="button" className="chat-head-who" onClick={() => (convo.kind === 'dm' && other ? api.showUserProfile(other.id) : setInfo(true))}>
                        <ChatAvatar convo={convo} size="sm" />
                        <span>
                            <strong>{api.conversationTitle(convo)}</strong>
                            <small>{convo.kind === 'group' ? `${convo.members.length} people` : other?.username ? `@${other.username}` : ''}</small>
                        </span>
                    </button>
                    <span className="chat-lock" title="End-to-end encrypted"><Icon name="lock-closed" size={14} /></span>
                    <button type="button" className={`chat-icon-btn${info ? ' active' : ''}`} aria-label="Chat details" aria-pressed={info} onClick={() => setInfo(v => !v)}><Icon name="information-circle" size={20} /></button>
                </header>

                <div className="chat-messages" ref={scroller} onScroll={onScroll}>
                    {t.hasMore && <div className="chat-older">{t.loading ? 'Loading…' : <button type="button" className="link-btn" onClick={() => api.loadOlderMessages(conversationId)}>Load older messages</button>}</div>}
                    <div className="chat-intro">
                        <ChatAvatar convo={convo} size="lg" />
                        <strong>{api.conversationTitle(convo)}</strong>
                        <small><Icon name="lock-closed" size={12} /> Messages in this chat are end-to-end encrypted. Only the people in it can read them.</small>
                    </div>
                    {t.items.map((msg: ChatMessage, i: number) => {
                        const prev = t.items[i - 1];
                        const next = t.items[i + 1];
                        const newDay = !prev || !sameDay(prev.created_at, msg.created_at);
                        const groupedWithPrev = !newDay && prev && prev.kind === 'message' && prev.sender_id === msg.sender_id && new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60000;
                        const groupedWithNext = next && next.kind === 'message' && next.sender_id === msg.sender_id && sameDay(next.created_at, msg.created_at) && new Date(next.created_at).getTime() - new Date(msg.created_at).getTime() < 5 * 60000;
                        return (
                            <div key={msg.id}>
                                {newDay && <div className="chat-day"><span>{dayLabel(msg.created_at)}</span></div>}
                                {msg.kind === 'system'
                                    ? <SystemLine msg={msg} byId={byId} />
                                    : <Bubble msg={msg} mine={msg.sender_id === me} sender={byId.get(msg.sender_id || '')} showName={convo.kind === 'group' && !groupedWithPrev && msg.sender_id !== me}
                                        tail={!groupedWithNext} replyTarget={msg.replyTo ? t.items.find((x: ChatMessage) => x.id === msg.replyTo) : undefined}
                                        onReply={() => setReplyTo(msg)} />}
                            </div>
                        );
                    })}
                    <SeenBy convo={convo} items={t.items} />
                </div>

                {t.keyMissing && <div className="chat-banner"><Icon name="key" size={14} /> Some messages are still locked for you. They'll open once someone else in the chat opens it and hands your device the key.</div>}
                {waitingOn.length > 0 && <div className="chat-banner"><Icon name="clock" size={14} /> {waitingOn.map(x => x.display_name || x.username).join(', ')} {waitingOn.length === 1 ? 'hasn’t' : 'haven’t'} turned on messages yet. They'll be able to read this chat once they do.</div>}
                <Composer conversationId={conversationId} replyTo={replyTo} clearReply={() => setReplyTo(null)} byId={byId} />
            </section>
            {info && <ChatInfo convo={convo} onClose={() => setInfo(false)} />}
        </div>
    );
}

function SystemLine({ msg, byId }: { msg: ChatMessage; byId: Map<string, ChatMember> }) {
    const ev = msg.event || {};
    const name = (id: string) => (id === state.user?.id ? 'You' : byId.get(id)?.display_name || byId.get(id)?.username || 'Someone');
    let text = '';
    if (ev.event === 'created') text = `${name(ev.by)} made this group`;
    else if (ev.event === 'added') text = `${name(ev.by)} added ${(ev.users || []).map(name).join(', ')}`;
    else if (ev.event === 'left') text = `${name(ev.user)} left`;
    else if (ev.event === 'removed') text = `${name(ev.by)} removed ${name(ev.user)}`;
    if (!text) return null;
    return <div className="chat-system">{text}</div>;
}

/** "Seen by" under your latest message, from everyone's last-read time. */
function SeenBy({ convo, items }: { convo: Conversation; items: ChatMessage[] }) {
    const me = state.user!.id;
    const last = [...items].reverse().find(x => x.kind === 'message' && !x.pending);
    if (!last || last.sender_id !== me) return null;
    const seen = convo.members.filter(x => x.id !== me && x.last_read_at && new Date(x.last_read_at) >= new Date(last.created_at));
    if (!seen.length) return null;
    return (
        <div className="chat-seen" title={`Seen by ${seen.map(x => x.display_name || x.username).join(', ')}`}>
            {seen.slice(0, 5).map(x => <Avatar key={x.id} userId={x.id} url={x.avatar_url} name={x.display_name || x.username} className="chat-seen-avatar" />)}
        </div>
    );
}

function Bubble({ msg, mine, sender, showName, tail, replyTarget, onReply }:
    { msg: ChatMessage; mine: boolean; sender?: ChatMember; showName: boolean; tail: boolean; replyTarget?: ChatMessage; onReply: () => void }) {
    const [menu, setMenu] = useState(false);
    const deleted = !!msg.deleted_at;
    const time = new Date(msg.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const onlyEmoji = !!msg.text && !msg.attachments?.length && /^(\s*:[a-z0-9_]+:\s*){1,3}$/.test(msg.text);
    return (
        <div className={`chat-msg${mine ? ' is-mine' : ''}${tail ? ' has-tail' : ''}${msg.pending ? ' is-pending' : ''}`}>
            {!mine && <span className="chat-msg-avatar">{tail && <Avatar userId={sender?.id} url={sender?.avatar_url} name={sender?.display_name || sender?.username || '?'} className="chat-avatar-img" />}</span>}
            <div className="chat-msg-col">
                {showName && <span className="chat-msg-name">{sender?.display_name || sender?.username || 'Someone'}</span>}
                {replyTarget && !deleted && (
                    <div className="chat-msg-reply">↩ {replyTarget.deleted_at ? 'Deleted message' : (replyTarget.text?.slice(0, 80) || (replyTarget.attachments?.length ? 'Attachment' : 'Message'))}</div>
                )}
                <div className="chat-msg-row">
                    {deleted ? <div className="chat-bubble is-deleted"><Icon name="no-symbol" size={14} /> Message deleted</div>
                        : msg.error ? <div className="chat-bubble is-locked" title="This message is encrypted with a key your device doesn't have yet"><Icon name="lock-closed" size={14} /> {msg.error === 'locked' ? 'Waiting for the key to unlock this' : 'This message couldn’t be unlocked'}</div>
                        : (
                            <div className={`chat-bubble-stack${onlyEmoji ? ' is-emoji' : ''}`}>
                                {(msg.attachments || []).length > 0 && <Attachments conversationId={msg.conversation_id} list={msg.attachments!} />}
                                {msg.text && <div className={`chat-bubble${onlyEmoji ? ' is-emoji' : ''}`} title={time}><RichText text={msg.text} /></div>}
                            </div>
                        )}
                    {!deleted && !msg.pending && (
                        <div className="chat-msg-tools">
                            <button type="button" aria-label="Reply" title="Reply" onClick={onReply}><Icon name="arrow-uturn-left" size={14} /></button>
                            <button type="button" aria-label="More" title="More" onClick={() => setMenu(v => !v)}><Icon name="ellipsis-vertical" size={14} /></button>
                            {menu && (
                                <div className={`feed-menu chat-msg-menu${mine ? ' feed-menu-right' : ''}`} onMouseLeave={() => setMenu(false)}>
                                    {msg.text && <button type="button" onClick={() => { setMenu(false); navigator.clipboard?.writeText(msg.text || ''); api.showToast('Copied', 'success'); }}><Icon name="clipboard-document" size={14} /> Copy</button>}
                                    {mine && <button type="button" className="is-danger" onClick={() => { setMenu(false); api.deleteMessage(msg); }}><Icon name="trash-2" size={14} /> Delete for everyone</button>}
                                    {!mine && !msg.error && <button type="button" className="is-danger" onClick={() => { setMenu(false); openDialog('report-message', { msg }); }}><Icon name="flag" size={14} /> Report</button>}
                                </div>
                            )}
                        </div>
                    )}
                </div>
                {tail && <span className="chat-msg-time">{msg.pending ? 'Sending…' : time}</span>}
            </div>
        </div>
    );
}

// ==================== attachments ====================

function formatBytes(n: number) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(s?: number) {
    if (!s || !Number.isFinite(s)) return '';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function Attachments({ conversationId, list }: { conversationId: string; list: Attachment[] }) {
    const media = list.filter(a => a.kind === 'image' || a.kind === 'video');
    const rest = list.filter(a => a.kind !== 'image' && a.kind !== 'video');
    return (
        <>
            {media.length > 0 && <div className={`chat-media chat-media-${Math.min(media.length, 4)}`}>{media.map(a => <MediaTile key={a.path} conversationId={conversationId} att={a} />)}</div>}
            {rest.map(a => (a.kind === 'audio' || a.kind === 'voice') ? <AudioTile key={a.path} conversationId={conversationId} att={a} /> : <FileTile key={a.path} conversationId={conversationId} att={a} />)}
        </>
    );
}

function useAttachment(conversationId: string, att: Attachment, auto: boolean) {
    const [url, setUrl] = useState<string>(() => api.cachedAttachmentUrl(att.path));
    const [state_, setState] = useState<'idle' | 'loading' | 'error'>('idle');
    const load = async () => {
        if (url) return url;
        setState('loading');
        try { const u = await api.attachmentUrl(conversationId, att); setUrl(u); setState('idle'); return u; }
        catch { setState('error'); return ''; }
    };
    useEffect(() => { if (auto && !url) load(); }, [auto]);
    return { url, status: state_, load };
}

function MediaTile({ conversationId, att }: { conversationId: string; att: Attachment }) {
    // small images load straight away; big ones and videos wait for a tap,
    // which is where the bandwidth goes
    const auto = att.kind === 'image' && att.size < 600 * 1024;
    const { url, status, load } = useAttachment(conversationId, att, auto);
    const [playing, setPlaying] = useState(false);
    const ratio = att.width && att.height ? `${att.width} / ${att.height}` : '4 / 3';
    if (att.kind === 'video') {
        return (
            <div className="chat-media-tile" style={{ aspectRatio: ratio }}>
                {playing && url ? <video src={url} controls autoPlay playsInline />
                    : (
                        <button type="button" className="chat-media-poster" onClick={async () => { if (await load()) setPlaying(true); }}>
                            {att.thumb && <img src={att.thumb} alt="" />}
                            <span className="chat-media-play">{status === 'loading' ? <span className="spinner" /> : <Icon name="play" size={26} />}</span>
                            <span className="chat-media-meta">{formatDuration(att.duration)} · {formatBytes(att.size)}</span>
                        </button>
                    )}
            </div>
        );
    }
    return (
        <button type="button" className="chat-media-tile" style={{ aspectRatio: ratio }} onClick={async () => { const u = await load(); if (u) openDialog('chat-lightbox', { url: u, att, conversationId }); }}>
            <img src={url || att.thumb || ''} alt={att.name} className={url ? '' : 'is-preview'} draggable={false} />
            {!url && <span className="chat-media-meta">{status === 'loading' ? 'Loading…' : status === 'error' ? 'Couldn’t load' : `Tap to load · ${formatBytes(att.size)}`}</span>}
        </button>
    );
}

function AudioTile({ conversationId, att }: { conversationId: string; att: Attachment }) {
    const { url, status, load } = useAttachment(conversationId, att, false);
    return (
        <div className={`chat-audio${att.kind === 'voice' ? ' is-voice' : ''}`}>
            <Icon name={att.kind === 'voice' ? 'microphone' : 'musical-note'} size={16} />
            {url ? <audio src={url} controls autoPlay preload="auto" />
                : (
                    <button type="button" className="chat-audio-play" onClick={load} aria-label="Play">
                        {status === 'loading' ? <span className="spinner" /> : <Icon name="play" size={16} />}
                        <span>{att.kind === 'voice' ? 'Voice message' : att.name}</span>
                        <span className="chat-audio-len">{formatDuration(att.duration)}</span>
                    </button>
                )}
        </div>
    );
}

function FileTile({ conversationId, att }: { conversationId: string; att: Attachment }) {
    return (
        <button type="button" className="chat-file" onClick={() => api.saveAttachment(conversationId, att)}>
            <Icon name="document" size={22} />
            <span><strong>{att.name}</strong><small>{formatBytes(att.size)} · Download</small></span>
        </button>
    );
}

function Lightbox({ close, url, att, conversationId }: DialogProps<{ url: string; att: Attachment; conversationId: string }>) {
    return (
        <Modal onClose={close} className="chat-lightbox" overlayClassName="chat-lightbox-overlay">
            <img src={url} alt={att.name} />
            <div className="chat-lightbox-bar">
                <span>{att.name} · {formatBytes(att.size)}</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => api.saveAttachment(conversationId, att)}><Icon name="arrow-down-tray" size={14} /> Save</button>
            </div>
        </Modal>
    );
}
registerDialog('chat-lightbox', Lightbox);

// ==================== writing ====================

function Composer({ conversationId, replyTo, clearReply, byId }: { conversationId: string; replyTo: ChatMessage | null; clearReply: () => void; byId: Map<string, ChatMember> }) {
    const [text, setText] = useState('');
    const [files, setFiles] = useState<Array<Outgoing & { preview?: string }>>([]);
    const [sending, setSending] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);

    function addFiles(list: FileList | File[] | null) {
        const next = [...files];
        for (const f of Array.from(list || [])) {
            const problem: string = api.fileProblem(f);
            if (problem) { api.showToast(problem, 'warning'); continue; }
            if (next.length >= 6) { api.showToast('Up to 6 files at a time.', 'warning'); break; }
            next.push({ file: f, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined });
        }
        setFiles(next);
    }

    async function send(extra: Outgoing[] = []) {
        if (sending) return;
        const all = [...files, ...extra];
        if (!text.trim() && !all.length) return;
        setSending(true);
        const body = text;
        setText('');
        const ok = await api.sendMessage(conversationId, body, all.map(f => ({ file: f.file, voice: f.voice, duration: f.duration })), replyTo?.id || null);
        setSending(false);
        if (ok) { files.forEach(f => f.preview && URL.revokeObjectURL(f.preview)); setFiles([]); clearReply(); }
        else setText(body);
    }

    function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
        const pasted = Array.from(e.clipboardData?.files || []);
        if (pasted.length) { e.preventDefault(); addFiles(pasted); }
    }

    const replyName = replyTo ? (replyTo.sender_id === state.user?.id ? 'yourself' : byId.get(replyTo.sender_id || '')?.display_name || 'them') : '';
    return (
        <div className="chat-composer" onDragOver={(e: DragEvent) => e.preventDefault()} onDrop={(e: DragEvent) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}>
            {replyTo && (
                <div className="chat-composer-reply">
                    <span>Replying to {replyName}: <em>{replyTo.text?.slice(0, 80) || 'attachment'}</em></span>
                    <button type="button" aria-label="Cancel reply" onClick={clearReply}><Icon name="x" size={14} /></button>
                </div>
            )}
            {files.length > 0 && (
                <div className="chat-composer-files">
                    {files.map((f, i) => (
                        <span className="chat-composer-file" key={i}>
                            {f.preview ? <img src={f.preview} alt="" /> : <Icon name={f.file.type.startsWith('video/') ? 'film' : f.file.type.startsWith('audio/') ? 'musical-note' : 'document'} size={20} />}
                            <span>{f.file.name}</span>
                            <button type="button" aria-label="Remove" onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
                        </span>
                    ))}
                </div>
            )}
            <div className="chat-composer-row">
                <button type="button" className="chat-icon-btn" title="Attach photos, videos or files (up to 10 MB each)" aria-label="Attach files" onClick={() => fileInput.current?.click()}><Icon name="paper-clip" size={20} /></button>
                <input ref={fileInput} type="file" multiple style={{ display: 'none' }} onChange={(e: ChangeEvent<HTMLInputElement>) => { addFiles(e.target.files); e.target.value = ''; }} />
                <VoiceRecorder onDone={(file, duration) => send([{ file, voice: true, duration }])} />
                <EmojiInput value={text} onChange={setText} rows={1} maxLength={4000} placeholder="Aa" onSubmit={() => send()} onPaste={onPaste} ariaLabel="Message" className="chat-input" />
                <button type="button" className="chat-send" disabled={sending || (!text.trim() && !files.length)} onClick={() => send()} aria-label="Send"><Icon name="paper-airplane" size={20} /></button>
            </div>
        </div>
    );
}

/** Hold-free voice notes: tap to record, tap to send (or the bin to throw away). Up to 5 minutes. */
function VoiceRecorder({ onDone }: { onDone: (file: File, duration: number) => void }) {
    const [rec, setRec] = useState<{ recorder: MediaRecorder; started: number; stream: MediaStream } | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const chunks = useRef<Blob[]>([]);
    const discard = useRef(false);

    useEffect(() => {
        if (!rec) return;
        const t = setInterval(() => {
            const s = (Date.now() - rec.started) / 1000;
            setElapsed(s);
            if (s >= 300) stop();
        }, 250);
        return () => clearInterval(t);
    }, [rec]);

    async function start() {
        if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) { api.showToast('This browser can’t record audio.', 'warning'); return; }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported?.(t)) || '';
            const recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
            chunks.current = [];
            discard.current = false;
            recorder.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data); };
            const started = Date.now();
            recorder.onstop = () => {
                stream.getTracks().forEach(tr => tr.stop());
                if (discard.current || !chunks.current.length) return;
                const mime = recorder.mimeType || 'audio/webm';
                const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
                onDone(new File(chunks.current, `voice-message.${ext}`, { type: mime.split(';')[0] }), (Date.now() - started) / 1000);
            };
            recorder.start(500);
            setRec({ recorder, started, stream });
        } catch {
            api.showToast('Microphone access was blocked.', 'warning');
        }
    }
    function stop(throwAway = false) {
        if (!rec) return;
        discard.current = throwAway;
        rec.recorder.stop();
        setRec(null);
        setElapsed(0);
    }

    if (!rec) return <button type="button" className="chat-icon-btn" title="Record a voice message" aria-label="Record a voice message" onClick={start}><Icon name="microphone" size={20} /></button>;
    return (
        <div className="chat-recording">
            <button type="button" className="chat-icon-btn" aria-label="Throw away" onClick={() => stop(true)}><Icon name="trash-2" size={18} /></button>
            <span className="chat-recording-dot" /> {formatDuration(elapsed) || '0:00'}
            <button type="button" className="chat-send" aria-label="Send voice message" onClick={() => stop(false)}><Icon name="paper-airplane" size={18} /></button>
        </div>
    );
}

// ==================== chat details ====================

function ChatInfo({ convo, onClose }: { convo: Conversation; onClose: () => void }) {
    const me = state.user!.id;
    const isOwner = convo.my_role === 'owner';
    const other = api.otherMember(convo);
    const [title, setTitle] = useState(convo.title || '');
    return (
        <aside className="chat-info" aria-label="Chat details">
            <div className="chat-info-head">
                <ChatAvatar convo={convo} size="lg" />
                <strong>{api.conversationTitle(convo)}</strong>
                <button type="button" className="chat-icon-btn chat-info-close" aria-label="Close details" onClick={onClose}><Icon name="x" size={18} /></button>
            </div>
            {convo.kind === 'group' && (
                <div className="chat-info-section">
                    <label htmlFor="chat-title">Group name</label>
                    <div className="chat-info-rename">
                        <input id="chat-title" type="text" maxLength={NAME_MAX} value={title} placeholder="Name this group" onChange={e => setTitle(e.target.value)} />
                        <button type="button" className="btn btn-secondary btn-sm" disabled={title === convo.title} onClick={() => api.renameGroupChat(convo.id, title)}>Save</button>
                    </div>
                </div>
            )}
            <div className="chat-info-section">
                <div className="chat-info-section-head">
                    <span>{convo.kind === 'group' ? `People (${convo.members.length})` : 'In this chat'}</span>
                    {convo.kind === 'group' && <button type="button" className="link-btn" onClick={() => openDialog('add-group-members', { convo })}><Icon name="user-plus" size={14} /> Add</button>}
                </div>
                {convo.members.map(x => (
                    <div className="chat-member" key={x.id}>
                        <button type="button" className="chat-member-main" onClick={() => api.showUserProfile(x.id)}>
                            <Avatar userId={x.id} url={x.avatar_url} name={x.display_name || x.username} className="feed-avatar feed-avatar-sm" />
                            <span>{x.display_name || x.username}{x.id === me && ' (you)'}{x.role === 'owner' && convo.kind === 'group' && <small className="chat-owner"> · owner</small>}</span>
                        </button>
                        {convo.kind === 'group' && isOwner && x.id !== me && (
                            <button type="button" className="chat-icon-btn" title="Remove from group" aria-label={`Remove ${x.display_name || x.username}`} onClick={() => api.removeGroupMember(convo.id, x.id, x.display_name || x.username)}><Icon name="user-minus" size={16} /></button>
                        )}
                    </div>
                ))}
            </div>
            <div className="chat-info-section chat-info-actions">
                <button type="button" onClick={() => api.setChatMuted(convo.id, !convo.muted)}><Icon name={convo.muted ? 'bell' : 'bell-slash'} size={16} /> {convo.muted ? 'Unmute' : 'Mute'} notifications</button>
                {convo.kind === 'dm' && other && <button type="button" onClick={() => api.showUserProfile(other.id)}><Icon name="user" size={16} /> View profile</button>}
                {convo.kind === 'dm' && other && <button type="button" className="is-danger" onClick={() => api.blockUser(other.id, other.display_name || other.username)}><Icon name="no-symbol" size={16} /> Block {other.display_name || other.username}</button>}
                <button type="button" className="is-danger" onClick={() => api.removeGroupMember(convo.id, me)}><Icon name="arrow-right-start-on-rectangle" size={16} /> {convo.kind === 'group' ? 'Leave group' : 'Leave chat'}</button>
            </div>
            <p className="chat-info-note"><Icon name="lock-closed" size={12} /> Messages are encrypted on your device. If you report a message, only that message and the ten before it are shared with the moderators.</p>
        </aside>
    );
}

// ==================== dialogs ====================

function NewChat({ close }: DialogProps) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<any[]>([]);
    useEffect(() => {
        const q = query.trim();
        let live = true;
        const timer = setTimeout(async () => {
            const client = await api.getClient();
            let req = client.from('profiles').select('id, username, display_name, avatar_url').neq('id', state.user!.id).limit(12);
            if (q) {
                const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
                req = req.or(`username.ilike.${pattern},display_name.ilike.${pattern}`);
            } else {
                // nothing typed: the people you follow
                const ids = [...api.socialState().following].slice(0, 12);
                if (!ids.length) { if (live) setResults([]); return; }
                req = req.in('id', ids);
            }
            const { data } = await req;
            if (live) setResults(data || []);
        }, 200);
        return () => { live = false; clearTimeout(timer); };
    }, [query]);
    return (
        <Modal onClose={close} title="New message" className="chat-dialog">
            <input type="search" placeholder="Search for someone by name" value={query} onChange={e => setQuery(e.target.value)} autoFocus />
            <div className="chat-dialog-list">
                {!results.length ? <div className="community-empty">{query ? 'Nobody by that name.' : 'Type a name, or follow some creators first.'}</div>
                    : results.map(p => (
                        <button type="button" key={p.id} className="chat-pick" onClick={() => { close(); api.messageUser(p.id); }}>
                            <Avatar userId={p.id} url={p.avatar_url} name={p.display_name || p.username} className="feed-avatar" />
                            <span><strong>{p.display_name || p.username}</strong><small>@{p.username}</small></span>
                        </button>
                    ))}
            </div>
        </Modal>
    );
}
registerDialog('new-chat', NewChat);

/** Picks from your followers: the only people a group can be made with. */
function FollowerPicker({ exclude = [], onPick, actionLabel, title, withName = false, close }:
    { exclude?: string[]; onPick: (ids: string[], name: string) => Promise<unknown>; actionLabel: string; title: string; withName?: boolean; close: () => void }) {
    const [followers, setFollowers] = useState<any[] | null>(null);
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [name, setName] = useState('');
    const [query, setQuery] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => { api.myFollowers().then((r: any[]) => setFollowers(r.filter(x => !exclude.includes(x.id)))).catch(() => setFollowers([])); }, []);
    const list = (followers || []).filter(f => !query || `${f.display_name} ${f.username}`.toLowerCase().includes(query.toLowerCase()));
    const toggle = (id: string) => { const next = new Set(picked); if (next.has(id)) next.delete(id); else next.add(id); setPicked(next); };
    return (
        <Modal onClose={close} title={title} className="chat-dialog">
            <p className="field-hint">You can add people who follow you.</p>
            {withName && <input type="text" maxLength={NAME_MAX} placeholder="Group name (optional)" value={name} onChange={e => setName(e.target.value)} />}
            <input type="search" placeholder="Search your followers" value={query} onChange={e => setQuery(e.target.value)} />
            <div className="chat-dialog-list">
                {followers === null ? <div className="community-empty">Loading…</div>
                    : !list.length ? <div className="community-empty">{followers.length ? 'Nobody matches.' : 'Nobody to add yet. Once people follow you, you can add them here.'}</div>
                    : list.map(f => (
                        <label key={f.id} className={`chat-pick${picked.has(f.id) ? ' is-picked' : ''}`}>
                            <input type="checkbox" checked={picked.has(f.id)} onChange={() => toggle(f.id)} />
                            <Avatar userId={f.id} url={f.avatar_url} name={f.display_name || f.username} className="feed-avatar" />
                            <span><strong>{f.display_name || f.username}</strong><small>@{f.username}</small></span>
                        </label>
                    ))}
            </div>
            <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={close}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={!picked.size || busy}
                    onClick={async () => { setBusy(true); await onPick([...picked], name); setBusy(false); close(); }}>{actionLabel} ({picked.size})</button>
            </div>
        </Modal>
    );
}

function NewGroupChat({ close }: DialogProps) {
    return <FollowerPicker title="New group chat" actionLabel="Create group" withName close={close} onPick={(ids, name) => api.createGroupChat(name, ids)} />;
}
registerDialog('new-group-chat', NewGroupChat);

function AddGroupMembers({ close, convo }: DialogProps<{ convo: Conversation }>) {
    return <FollowerPicker title="Add people" actionLabel="Add" exclude={convo.members.map(x => x.id)} close={close} onPick={ids => api.addGroupMembers(convo.id, ids)} />;
}
registerDialog('add-group-members', AddGroupMembers);

function ReportMessage({ close, msg }: DialogProps<{ msg: ChatMessage }>) {
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    return (
        <Modal onClose={close} title="Report this message" className="chat-dialog">
            <p>The moderators will be able to read <strong>this message and the ten before it</strong> (so they can see what was going on). Nothing else in the chat is shared.</p>
            <div className="chat-report-quote">{msg.text?.slice(0, 300) || (msg.attachments?.length ? `${msg.attachments.length} attachment(s)` : '')}</div>
            <textarea rows={3} maxLength={1000} placeholder="What's wrong? (optional)" value={reason} onChange={e => setReason(e.target.value)} />
            <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={close}>Cancel</button>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={async () => { setBusy(true); if (await api.reportMessage(msg, reason)) close(); setBusy(false); }}>Send report</button>
            </div>
        </Modal>
    );
}
registerDialog('report-message', ReportMessage);
