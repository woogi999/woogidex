// A comment thread, the same everywhere it appears: under a feed card (opened
// in place, like Facebook), on a post's page, on a Fakemon's page, on a
// profile's wall and on an event. Comments nest (Reddit style): each can be
// replied to, reacted to (one reaction each), and edited or deleted by
// whoever may. Data and actions: js/features/comments.ts.

import { useEffect, useRef, useState } from 'react';
import { api, state } from '../../core/app.ts';
import { emojiByName, isUnicodeKey, unicodeChar } from '../../core/emoji.ts';
import {
    addComment, canDeleteComment, deleteComment, editComment, getThread, loadThread, toggleCommentReaction,
    type Comment, type CommentKind
} from '../../features/comments.ts';
import { Avatar } from './Avatar.tsx';
import { BadgeRow } from './Badge.tsx';
import { Icon } from './Icon.tsx';
import { EmojiButton, EmojiGlyph, EmojiInput, QUICK_REACTIONS, RichText } from './EmojiInput.tsx';
import { Modal } from './Modal.tsx';
import { openDialog, registerDialog, type DialogProps } from '../dialogs.tsx';
import { PollEditor, PollView } from './polls.tsx';
import { commentPollParent, emptyPoll, type PollDraft } from '../../features/polls.ts';

export function timeAgo(iso: string): string {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: s > 86400 * 300 ? 'numeric' : undefined });
}

// ==================== reactions ====================

function ReactionChip({ emoji, count, mine, onClick, small }: { emoji: string; count: number; mine: boolean; onClick: () => void; small?: boolean }) {
    // ours, a standard emoji, or the heart; one this copy of the site doesn't know isn't drawn
    if (emoji !== 'heart' && !isUnicodeKey(emoji) && !emojiByName(emoji)) return null;
    const title = emoji === 'heart' ? 'Heart' : isUnicodeKey(emoji) ? unicodeChar(emoji) : `:${emoji}:`;
    return (
        <button type="button" className={`reaction-chip${mine ? ' is-mine' : ''}${small ? ' is-small' : ''}`} onClick={onClick} aria-pressed={mine} title={title}>
            <EmojiGlyph code={emoji} size={small ? 15 : 18} />
            <span>{count}</span>
        </button>
    );
}

/**
 * Emoji reaction chips plus the "add one" picker. `always` keeps chips for
 * those emojis even at zero (the feed always offers a heart).
 */
export function ReactionBar({ counts, mine, onToggle, always = [], small = false, picker = true }: {
    counts: Record<string, number>; mine: string[]; onToggle: (emoji: string) => void; always?: string[]; small?: boolean;
    /** whether it ends with the button to add another */
    picker?: boolean;
}) {
    const keys = Object.keys(counts).filter(k => counts[k] > 0).sort((a, b) => counts[b] - counts[a]);
    for (const q of always) if (!keys.includes(q)) keys.unshift(q);
    return (
        <div className={`reaction-bar${small ? ' is-small' : ''}`}>
            {keys.map(k => <ReactionChip key={k} emoji={k} count={counts[k] || 0} mine={mine.includes(k)} onClick={() => onToggle(k)} small={small} />)}
            {state.user && picker && (
                <EmojiButton className="reaction-add" title="Add a reaction" onPick={onToggle} quick={QUICK_REACTIONS}>
                    <Icon name="face-smile" size={small ? 15 : 18} /><span className="reaction-add-plus">+</span>
                </EmojiButton>
            )}
        </div>
    );
}

/** Draws a reaction key this copy of the site knows (see ReactionChip). */
const knownReaction = (k: string) => k === 'heart' || isUnicodeKey(k) || !!emojiByName(k);

/**
 * Facebook's way: the three most-used reactions and a total, which opens
 * everyone's reactions; then one React button that toggles yours.
 * `kind` and `id` say which reaction table the full list reads.
 */
export function ReactionSummary({ kind, id, counts, mine, onToggle }: {
    kind: ReactionKind; id: string; counts: Record<string, number>; mine: string[]; onToggle: (emoji: string) => void;
}) {
    const keys = Object.keys(counts).filter(k => counts[k] > 0 && knownReaction(k)).sort((a, b) => counts[b] - counts[a]);
    const total = keys.reduce((n, k) => n + counts[k], 0);
    return (
        <div className="reaction-summary">
            {state.user && (
                <EmojiButton className="reaction-react" buttonClassName={mine.length ? 'is-on' : ''} title="React" onPick={onToggle} quick={QUICK_REACTIONS}>
                    {mine.length ? <EmojiGlyph code={mine[0]} size={18} /> : <Icon name="face-smile" size={18} />}
                    <span className="reaction-react-label">{mine.length ? 'Reacted' : 'React'}</span>
                </EmojiButton>
            )}
            {total > 0 && (
                <button type="button" className="reaction-top" title="See all reactions" onClick={() => openDialog('reaction-list', { kind, id })}>
                    <span className="reaction-top-icons">{keys.slice(0, 3).map(k => <span key={k} className="reaction-top-icon"><EmojiGlyph code={k} size={16} /></span>)}</span>
                    <span>{total}</span>
                </button>
            )}
        </div>
    );
}

type ReactionKind = 'mon' | 'post' | 'event';
const REACTION_TABLE: Record<ReactionKind, [string, string]> = { mon: ['mon_reactions', 'mon_id'], post: ['post_reactions', 'post_id'], event: ['event_reactions', 'event_id'] };

/** Everyone who reacted, with a tab per emoji. */
function ReactionListDialog({ close, kind, id }: DialogProps<{ kind: ReactionKind; id: string }>) {
    const [rows, setRows] = useState<Array<{ emoji: string; user: any }> | null>(null);
    const [tab, setTab] = useState('');
    useEffect(() => {
        let live = true;
        (async () => {
            try {
                const client = await api.getClient();
                // ponytail: first 500 reactions only; page it if a post ever gets more
                const [table, column] = REACTION_TABLE[kind];
                const { data, error } = await client.from(table).select('user_id, emoji').eq(column, id).order('created_at', { ascending: false }).limit(500);
                if (error) throw error;
                const ids = [...new Set((data || []).map((r: any) => r.user_id))];
                const { data: people } = ids.length
                    ? await client.from('profiles').select('id, username, display_name, avatar_url').in('id', ids)
                    : { data: [] as any[] };
                const byId = new Map((people || []).map((p: any) => [p.id, p]));
                if (live) setRows((data || []).filter((r: any) => knownReaction(r.emoji)).map((r: any) => ({ emoji: r.emoji, user: byId.get(r.user_id) || { id: r.user_id } })));
            } catch { if (live) setRows([]); }
        })();
        return () => { live = false; };
    }, [kind, id]);
    const counts = new Map<string, number>();
    for (const r of rows || []) counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1);
    const tabs = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const list = (rows || []).filter(r => !tab || r.emoji === tab);
    return (
        <Modal onClose={close} title="Reactions" className="reaction-list-modal">
            <div className="reaction-list-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={!tab} className={!tab ? 'active' : ''} onClick={() => setTab('')}>All {rows?.length ?? ''}</button>
                {tabs.map(([k, n]) => (
                    <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}><EmojiGlyph code={k} size={16} /> {n}</button>
                ))}
            </div>
            <div className="reaction-list">
                {rows === null ? <p className="comment-empty">Loading…</p>
                    : !list.length ? <p className="comment-empty">No reactions yet.</p>
                    : list.map((r, i) => (
                        <button type="button" key={`${r.user.id}-${r.emoji}-${i}`} className="reaction-list-row" onClick={() => { close(); api.showUserProfile(r.user.id); }}>
                            <Avatar userId={r.user.id} url={r.user.avatar_url} name={r.user.display_name || r.user.username} className="feed-avatar feed-avatar-sm" />
                            <span className="reaction-list-name">{r.user.display_name || r.user.username || 'Someone'}</span>
                            <EmojiGlyph code={r.emoji} size={18} />
                        </button>
                    ))}
            </div>
        </Modal>
    );
}
registerDialog('reaction-list', ReactionListDialog);

// ==================== writing ====================

export function CommentComposer({ onSubmit, placeholder = 'Write a comment…', autoFocus = false, polls = true, onCancel }: {
    onSubmit: (text: string, poll: PollDraft | null) => Promise<boolean>; placeholder?: string; autoFocus?: boolean;
    /** offer a poll (not on replies, nor on events) */
    polls?: boolean;
    /** a reply box: Esc (while empty) and the cancel button close it */
    onCancel?: () => void;
}) {
    const [text, setText] = useState('');
    const [poll, setPoll] = useState<PollDraft | null>(null);
    const [busy, setBusy] = useState(false);
    if (!state.user) {
        return <p className="comment-signin"><button type="button" className="link-btn" onClick={() => api.openAuthModal('signin')}>Sign in</button> to comment.</p>;
    }
    async function send() {
        if (!text.trim() || busy) return;
        setBusy(true);
        const ok = await onSubmit(text, poll);
        setBusy(false);
        if (ok) { setText(''); setPoll(null); }
    }
    return (
        <div className="comment-composer-wrap" onKeyDown={onCancel ? e => { if (e.key === 'Escape' && !text.trim()) { e.preventDefault(); onCancel(); } } : undefined}>
            <div className="comment-composer">
                <Avatar userId={state.user.id} url={state.user.avatarUrl} name={state.user.displayName || state.user.username} className="feed-avatar feed-avatar-sm" />
                <EmojiInput value={text} onChange={setText} maxLength={1000} rows={1} placeholder={placeholder} onSubmit={poll ? undefined : send} autoFocus={autoFocus}
                    tools={<>
                        {onCancel && <button type="button" className="comment-tool" onClick={onCancel} aria-label="Cancel reply" title="Cancel"><Icon name="x-mark" size={18} /></button>}
                        {polls && !poll && <button type="button" className="comment-tool" onClick={() => setPoll(emptyPoll())} aria-label="Add a poll" title="Add a poll"><Icon name="chart-bar" size={18} /></button>}
                        <button type="button" className="comment-send" disabled={busy || !text.trim()} onClick={send} aria-label="Post comment"><Icon name="paper-airplane" size={18} /></button>
                    </>} />
            </div>
            {poll && <PollEditor compact value={poll} onChange={setPoll} onRemove={() => setPoll(null)} />}
        </div>
    );
}

// ==================== one comment ====================

/** Replies indent this many levels; deeper ones line up with the last (Reddit's "continue this thread", without leaving the page). */
const MAX_DEPTH = 4;
/** More replies than this start folded ("View 5 replies"). */
const FOLD_AT = 2;

interface ItemProps {
    kind: CommentKind; parentId: string; parentOwnerId?: string | null; comment: Comment;
    /** comments by the one they reply to */
    replies: Map<string, Comment[]>;
    depth: number;
    moderator: boolean;
    ownerId?: string | null;
    targetName?: string;
}

function CommentItem({ kind, parentId, parentOwnerId, comment, replies: tree, depth, moderator, ownerId, targetName }: ItemProps) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(comment.body);
    const [busy, setBusy] = useState(false);
    const [replying, setReplying] = useState(false);
    const replies = tree.get(comment.id) || [];
    const [open, setOpen] = useState(replies.length <= FOLD_AT);
    const mine = !!state.user && comment.user_id === state.user.id;
    const canDelete = canDeleteComment(kind, comment, parentOwnerId, moderator);
    const reacted = comment.my_reactions.length > 0;
    const total = countReplies(comment.id, tree);

    async function save() {
        if (busy) return;
        setBusy(true);
        const ok = await editComment(kind, parentId, comment, draft);
        setBusy(false);
        if (ok) setEditing(false);
    }
    async function remove() {
        if (!window.confirm(total ? `Delete this comment and its ${total === 1 ? 'reply' : `${total} replies`}?` : 'Delete this comment?')) return;
        await deleteComment(kind, parentId, comment);
    }
    async function reply(text: string) {
        const ok = await addComment(kind, parentId, text, ownerId ? { id: ownerId, targetName } : undefined, null, comment.id);
        if (ok) { setReplying(false); setOpen(true); }
        return ok;
    }

    return (
        <div className={`comment${depth ? ' is-reply' : ''}`}>
            <button type="button" className="comment-avatar" onClick={() => api.showUserProfile(comment.user_id)} aria-label={`${comment.author_name || 'Someone'}'s profile`}>
                <Avatar userId={comment.user_id} url={comment.author_avatar_url} name={comment.author_name} className="feed-avatar feed-avatar-sm" />
            </button>
            <div className="comment-main">
                {editing ? (
                    <div className="comment-edit" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setDraft(comment.body); setEditing(false); } }}>
                        <EmojiInput value={draft} onChange={setDraft} maxLength={1000} rows={2} autoFocus onSubmit={save} ariaLabel="Edit your comment" />
                        <div className="comment-edit-actions">
                            <span className="comment-edit-hint">Enter to save · Esc to cancel</span>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setDraft(comment.body); setEditing(false); }}>Cancel</button>
                            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !draft.trim()} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
                        </div>
                    </div>
                ) : (
                    <div className="comment-bubble">
                        <span className="comment-author">
                            <span className="community-author-link" data-user-id={comment.user_id} onClick={() => api.showUserProfile(comment.user_id)}>{comment.author_name || 'Someone'}</span>
                            <BadgeRow badgeKeys={comment.author_badges} size={12} />
                        </span>
                        <RichText text={comment.body} className="comment-body" />
                    </div>
                )}
                {!editing && kind !== 'event' && <PollView kind={commentPollParent(kind)} parentId={comment.id} />}
                {!editing && (
                    <div className="comment-meta">
                        <time dateTime={comment.created_at} title={new Date(comment.created_at).toLocaleString()}>{timeAgo(comment.created_at)}</time>
                        {comment.edited_at && <span title={`Edited ${new Date(comment.edited_at).toLocaleString()}`}>Edited</span>}
                        {/* one React: a heart is a tap away on its quick row, anything else below it */}
                        {state.user && (
                            <EmojiButton className="comment-act" buttonClassName={reacted ? 'is-on' : ''} title="React to this comment" quick={QUICK_REACTIONS}
                                onPick={emoji => toggleCommentReaction(kind, comment, emoji)}>{reacted ? 'Reacted' : 'React'}</EmojiButton>
                        )}
                        {state.user && <button type="button" className="comment-act" onClick={() => setReplying(r => !r)} aria-expanded={replying}>Reply</button>}
                        {mine && <button type="button" className="comment-act" onClick={() => { setDraft(comment.body); setEditing(true); }}>Edit</button>}
                        {canDelete && <button type="button" className="comment-act" onClick={remove}>Delete</button>}
                    </div>
                )}
                {!editing && Object.keys(comment.reactions).length > 0 && (
                    <ReactionBar small picker={false} counts={comment.reactions} mine={comment.my_reactions} onToggle={emoji => toggleCommentReaction(kind, comment, emoji)} />
                )}
                {replying && (
                    <div className="comment-reply-box">
                        <CommentComposer autoFocus polls={false} placeholder={`Reply to ${comment.author_name || 'them'}…`} onSubmit={reply} onCancel={() => setReplying(false)} />
                    </div>
                )}
                {replies.length > 0 && (open ? (
                    <div className={`comment-replies${depth + 1 >= MAX_DEPTH ? ' is-flat' : ''}`}>
                        {replies.length > FOLD_AT && <button type="button" className="comment-fold" onClick={() => setOpen(false)}><Icon name="chevron-up" size={13} />Hide replies</button>}
                        {replies.map(r => <CommentItem key={r.id} kind={kind} parentId={parentId} parentOwnerId={parentOwnerId} comment={r} replies={tree}
                            depth={depth + 1} moderator={moderator} ownerId={ownerId} targetName={targetName} />)}
                    </div>
                ) : (
                    <button type="button" className="comment-fold" onClick={() => setOpen(true)}>
                        <Icon name="arrow-uturn-right" size={13} />View {total === 1 ? '1 reply' : `${total} replies`}
                    </button>
                ))}
            </div>
        </div>
    );
}

/** Every reply under a comment, however deep. */
function countReplies(id: string, tree: Map<string, Comment[]>): number {
    let n = 0;
    for (const c of tree.get(id) || []) n += 1 + countReplies(c.id, tree);
    return n;
}

// ==================== the thread ====================

interface ThreadProps {
    kind: CommentKind;
    parentId: string;
    /** whose Fakemon / post / profile this is on (deleting, notifications) */
    ownerId?: string | null;
    /** names the thing in the owner's notification ("Sparkit") */
    targetName?: string;
    /** told the comment count whenever it changes */
    onCount?: (n: number) => void;
    autoFocus?: boolean;
    placeholder?: string;
    /** where the box to write one goes */
    composer?: 'top' | 'bottom';
    /** may delete anyone's comment here (an event's team) */
    moderator?: boolean;
}

export function CommentThread({ kind, parentId, ownerId = null, targetName, onCount, autoFocus = false, placeholder, composer = 'bottom', moderator = false }: ThreadProps) {
    const thread = getThread(kind, parentId);
    useEffect(() => { loadThread(kind, parentId); }, [kind, parentId]);
    const count = thread?.status === 'ready' ? thread.comments.length : null;
    const reported = useRef<number | null>(null);
    useEffect(() => {
        if (count === null || reported.current === count) return;
        reported.current = count;
        onCount?.(count);
    }, [count]);

    const box = (
        <CommentComposer autoFocus={autoFocus} placeholder={placeholder} polls={kind !== 'event'}
            onSubmit={(text, poll) => addComment(kind, parentId, text, ownerId ? { id: ownerId, targetName } : undefined, poll)} />
    );
    // the thread as a tree; a reply whose comment is gone (or hidden) shows at the top
    const all = thread?.comments || [];
    const ids = new Set(all.map(c => c.id));
    const tree = new Map<string, Comment[]>();
    const top: Comment[] = [];
    for (const c of all) {
        if (c.parent_id && ids.has(c.parent_id)) {
            if (!tree.has(c.parent_id)) tree.set(c.parent_id, []);
            tree.get(c.parent_id)!.push(c);
        } else top.push(c);
    }
    return (
        <div className="comment-thread">
            {composer === 'top' && box}
            {!thread || (thread.status === 'loading' && !thread.comments.length) ? (
                <div className="comment-list" aria-busy="true">
                    {[70, 45].map(w => (
                        <div className="comment" key={w}>
                            <span className="feed-avatar feed-avatar-sm skel skel-circle" />
                            <div className="comment-main"><div className="comment-bubble"><span className="skel skel-text" style={{ width: `${w}%`, minWidth: 120 }} /></div></div>
                        </div>
                    ))}
                </div>
            ) : thread.status === 'error' && !thread.comments.length ? (
                <p className="comment-empty">Couldn't load comments. <button type="button" className="link-btn" onClick={() => loadThread(kind, parentId)}>Try again</button></p>
            ) : thread.comments.length ? (
                <div className="comment-list">
                    {top.map(c => <CommentItem key={c.id} kind={kind} parentId={parentId} parentOwnerId={ownerId} comment={c} replies={tree}
                        depth={0} moderator={moderator} ownerId={ownerId} targetName={targetName} />)}
                </div>
            ) : (
                <p className="comment-empty">No comments yet. Say something!</p>
            )}
            {composer === 'bottom' && box}
        </div>
    );
}

// ==================== a post on someone's wall ====================

/**
 * Something written on a profile's wall, drawn as a post in that profile's
 * timeline (Facebook's "Ana ▸ Ben"). It is a profile comment underneath, so
 * it edits, reacts and deletes like one.
 */
export function WallPostCard({ profileId, profileName, comment }: { profileId: string; profileName: string; comment: Comment }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(comment.body);
    const [busy, setBusy] = useState(false);
    const [menu, setMenu] = useState(false);
    const mine = !!state.user && comment.user_id === state.user.id;
    const canDelete = canDeleteComment('profile', comment, profileId);
    const onOwnWall = comment.user_id === profileId;

    async function save() {
        if (busy) return;
        setBusy(true);
        const ok = await editComment('profile', profileId, comment, draft);
        setBusy(false);
        if (ok) setEditing(false);
    }
    async function remove() {
        setMenu(false);
        if (!window.confirm('Delete this post from the wall?')) return;
        await deleteComment('profile', profileId, comment);
    }

    return (
        <article className="feed-card feed-card-post wall-post">
            <div className="feed-card-head">
                <div className="feed-byline">
                    <button type="button" className="feed-byline-avatar" onClick={() => api.showUserProfile(comment.user_id)} aria-label={`${comment.author_name || 'Someone'}'s profile`}>
                        <Avatar userId={comment.user_id} url={comment.author_avatar_url} name={comment.author_name} className="feed-avatar" />
                    </button>
                    <div className="feed-byline-text">
                        <span className="feed-byline-name">
                            <span className="community-author-link" data-user-id={comment.user_id} onClick={() => api.showUserProfile(comment.user_id)}>{comment.author_name || 'Someone'}</span>
                            <BadgeRow badgeKeys={comment.author_badges} size={13} />
                            {!onOwnWall && <><Icon name="chevron-right" size={13} className="wall-post-arrow" /><span>{profileName}</span></>}
                        </span>
                        <span className="feed-byline-meta">
                            wrote on the wall · <time dateTime={comment.created_at} title={new Date(comment.created_at).toLocaleString()}>{timeAgo(comment.created_at)}</time>
                            {comment.edited_at && <> · edited</>}
                        </span>
                    </div>
                </div>
                {(mine || canDelete) && (
                    <div className="feed-menu-wrap">
                        <button type="button" className="feed-menu-btn" aria-label="Wall post options" onClick={() => setMenu(v => !v)}><Icon name="ellipsis-horizontal" size={18} /></button>
                        {menu && (
                            <div className="feed-menu" onMouseLeave={() => setMenu(false)}>
                                {mine && <button type="button" onClick={() => { setMenu(false); setDraft(comment.body); setEditing(true); }}><Icon name="pencil" size={14} /> Edit</button>}
                                {canDelete && <button type="button" className="is-danger" onClick={remove}><Icon name="trash-2" size={14} /> Delete</button>}
                            </div>
                        )}
                    </div>
                )}
            </div>
            {editing ? (
                <div className="post-edit" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setEditing(false); } }}>
                    <EmojiInput value={draft} onChange={setDraft} maxLength={1000} rows={3} autoFocus ariaLabel="Edit your wall post" />
                    <div className="post-edit-actions">
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(false)}>Cancel</button>
                        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !draft.trim()} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
                    </div>
                </div>
            ) : (
                <div className="post-body"><RichText text={comment.body} /></div>
            )}
            <PollView kind="profile_comment" parentId={comment.id} />
            <div className="feed-actions">
                <ReactionBar counts={comment.reactions} mine={comment.my_reactions} always={['heart']} onToggle={emoji => toggleCommentReaction('profile', comment, emoji)} />
            </div>
        </article>
    );
}

/**
 * The box at the top of a timeline: "Write something to Ben…" on someone
 * else's, "Write on your wall…" on your own. Either way it's a wall post,
 * kept on that profile rather than sent out to the feed.
 */
export function WallComposer({ profileId, profileName, own = false, onPosted }: { profileId: string; profileName: string; own?: boolean; onPosted?: () => void }) {
    const [text, setText] = useState('');
    const [poll, setPoll] = useState<PollDraft | null>(null);
    const [busy, setBusy] = useState(false);
    const user = state.user;
    if (!user) return null;
    async function post() {
        if (!text.trim() || busy) return;
        setBusy(true);
        const ok = await addComment('profile', profileId, text, own ? undefined : { id: profileId }, poll);
        setBusy(false);
        if (ok) { setText(''); setPoll(null); onPosted?.(); }
    }
    const label = own ? 'Write on your wall' : `Write on ${profileName}'s wall`;
    return (
        <div className="post-composer wall-composer">
            <div className="post-composer-top">
                <Avatar userId={user.id} url={user.avatarUrl} name={user.displayName || user.username} className="feed-avatar" />
                <EmojiInput value={text} onChange={setText} maxLength={1000} rows={2} placeholder={own ? 'Write on your wall…' : `Write something to ${profileName}…`}
                    onSubmit={poll ? undefined : post} ariaLabel={label} />
            </div>
            {poll && <PollEditor value={poll} onChange={setPoll} onRemove={() => setPoll(null)} />}
            {(text.trim() || poll) && (
                <div className="post-composer-actions">
                    {!poll && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPoll(emptyPoll())}><Icon name="chart-bar" size={14} /> Poll</button>}
                    {own && <span className="post-composer-note">Stays on your profile; it doesn't go to the feed.</span>}
                    <span className="post-composer-count">{text.length}/1000</span>
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy || !text.trim()} onClick={post}>{busy ? 'Posting…' : 'Post'}</button>
                </div>
            )}
        </div>
    );
}
