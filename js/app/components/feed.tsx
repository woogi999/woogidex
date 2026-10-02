// The Community Hub feed's pieces: a Fakemon card (big picture first, like
// Instagram), a post (text first, like Tumblr, with the Fakemon it shows
// off), emoji reactions, the "write a post" box, and the picker for adding
// your published Fakemon to a post. Data and actions: js/features/social.ts.

import { useEffect, useRef, useState } from 'react';
import { api, state } from '../../core/app.ts';
import { emojiByName } from '../../core/emoji.ts';
import { evoBadgeLabel } from '../../features/community-feed-model.ts';
import { Avatar } from './Avatar.tsx';
import { BadgeRow } from './Badge.tsx';
import { Icon } from './Icon.tsx';
import { EmojiButton, EmojiImg, EmojiInput, RichText } from './EmojiInput.tsx';
import { LazyArt } from './community.tsx';
import { TypeBadges } from './profile.tsx';
import { Modal } from './Modal.tsx';
import { registerDialog, openDialog, type DialogProps } from '../dialogs.tsx';
import type { FeedItem } from '../../features/feed-algorithm.ts';

export function timeAgo(iso: string): string {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: s > 86400 * 300 ? 'numeric' : undefined });
}

/** Counts a card as seen once most of it has been on screen for a moment. */
function useImpression(id: string) {
    const ref = useRef<HTMLElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof IntersectionObserver === 'undefined') return;
        let timer: any = null;
        const io = new IntersectionObserver(entries => {
            const visible = entries.some(e => e.intersectionRatio >= 0.6);
            if (visible && !timer) timer = setTimeout(() => { api.recordImpression?.(id); io.disconnect(); }, 900);
            if (!visible && timer) { clearTimeout(timer); timer = null; }
        }, { threshold: [0, 0.6] });
        io.observe(el);
        return () => { io.disconnect(); clearTimeout(timer); };
    }, [id]);
    return ref;
}

function Byline({ item, verb }: { item: FeedItem; verb?: string }) {
    const isMine = !!state.user && state.user.id === item.user_id;
    const following = !isMine && api.isFollowing?.(item.user_id);
    return (
        <div className="feed-byline">
            <button type="button" className="feed-byline-avatar" onClick={() => api.showUserProfile(item.user_id)} aria-label={`${item.author_name || 'Creator'}'s profile`}>
                <Avatar userId={item.user_id} url={item.author_avatar_url} name={item.author_name} className="feed-avatar" />
            </button>
            <div className="feed-byline-text">
                <span className="feed-byline-name">
                    <span className="community-author-link" data-user-id={item.user_id} onClick={() => api.showUserProfile(item.user_id)}>{item.author_name || 'Someone'}</span>
                    <BadgeRow badgeKeys={item.author_badges} size={13} />
                </span>
                <span className="feed-byline-meta">
                    {verb && <>{verb} · </>}
                    <time dateTime={item.created_at} title={new Date(item.created_at).toLocaleString()}>{timeAgo(item.created_at)}</time>
                    {item.edited_at && <> · edited</>}
                </span>
            </div>
            {!isMine && state.user && (
                following
                    ? <span className="feed-following-chip"><Icon name="check" size={12} /> Following</span>
                    : <button type="button" className="feed-follow-btn" onClick={() => api.followUser(item.user_id)}>Follow</button>
            )}
        </div>
    );
}

// ==================== a published Fakemon ====================

export function MonFeedCard({ item }: { item: FeedItem }) {
    const ref = useImpression(`mon:${item.id}`);
    const mon = item.fakemon_data || {};
    const evo = evoBadgeLabel(item);
    const open = () => { api.recordOpened?.(item.id, item.user_id); openMon(item); };
    return (
        <article className="feed-card feed-card-mon" ref={ref as any}>
            <Byline item={item} verb="published a Fakémon" />
            <button type="button" className="feed-mon-art-btn" onClick={open} aria-label={`Open ${mon.name || 'this Fakémon'}`}>
                <LazyArt row={item as any} className="feed-mon-art">{evo && <span className="community-card-evo-badge">{evo}</span>}</LazyArt>
            </button>
            <div className="feed-mon-body">
                <div className="feed-mon-title">
                    <button type="button" className="feed-mon-name" onClick={open}>{mon.name || 'Unnamed'}</button>
                    {mon.number && <span className="feed-mon-number">{mon.number}</span>}
                </div>
                {mon.species && <div className="feed-mon-species">The {mon.species}</div>}
                <TypeBadges type1={mon.type1} type2={mon.type2} />
                {item.caption && <p className="feed-mon-caption">{item.caption}</p>}
            </div>
            <div className="feed-actions">
                <button type="button" className={`feed-action${item.liked_by_me ? ' is-on' : ''}`} onClick={() => api.toggleFeedMonLike(item)} aria-pressed={!!item.liked_by_me} title={item.liked_by_me ? 'Unlike' : 'Like'}>
                    <Icon name="heart" size={18} /><span>{Number(item.like_count || 0)}</span>
                </button>
                <button type="button" className="feed-action" onClick={open} title="Comments"><Icon name="message-circle" size={18} /><span>{Number(item.comment_count || 0)}</span></button>
                <span className="feed-action feed-action-static" title="Views"><Icon name="eye" size={18} /><span>{Number(item.view_count || 0)}</span></span>
                <button type="button" className="feed-action feed-action-end" onClick={() => api.copyCommunityShareLink(item.id)} title="Copy link"><Icon name="link" size={18} /></button>
            </div>
        </article>
    );
}

/** The feed's rows aren't in the hub grid's list; the detail page opens from the id. */
function openMon(item: FeedItem) {
    api.openPublishedMonById(item.id);
}

// ==================== reactions ====================

const QUICK_REACTIONS = ['heart'];

function ReactionChip({ emoji, count, mine, onClick }: { emoji: string; count: number; mine: boolean; onClick: () => void }) {
    const e = emoji === 'heart' ? null : emojiByName(emoji);
    if (emoji !== 'heart' && !e) return null;     // an emoji this copy of the site doesn't have
    return (
        <button type="button" className={`reaction-chip${mine ? ' is-mine' : ''}`} onClick={onClick} aria-pressed={mine} title={`:${emoji}:`}>
            {e ? <EmojiImg emoji={e} size={18} /> : <Icon name="heart" size={16} className="reaction-heart" />}
            <span>{count}</span>
        </button>
    );
}

export function Reactions({ post }: { post: any }) {
    const counts: Record<string, number> = post.reactions || {};
    const mine: string[] = post.my_reactions || [];
    const keys = Object.keys(counts).filter(k => counts[k] > 0).sort((a, b) => counts[b] - counts[a]);
    for (const q of QUICK_REACTIONS) if (!keys.includes(q)) keys.unshift(q);
    return (
        <div className="reaction-bar">
            {keys.map(k => <ReactionChip key={k} emoji={k} count={counts[k] || 0} mine={mine.includes(k)} onClick={() => api.toggleReaction(post, k)} />)}
            {state.user && <EmojiButton className="reaction-add" title="Add a reaction" onPick={name => api.toggleReaction(post, name)}><Icon name="face-smile" size={18} /><span className="reaction-add-plus">+</span></EmojiButton>}
        </div>
    );
}

// ==================== a post ====================

/** The Fakemon a post shows off, as a small gallery. */
export function PostMons({ mons }: { mons: any[] }) {
    if (!mons?.length) return null;
    const many = mons.length > 1;
    return (
        <div className={`post-mons post-mons-${Math.min(mons.length, 4)}${many ? ' is-many' : ''}`}>
            {mons.map(m => {
                const row = { id: m.id, fakemon_data: { name: m.name, type1: m.type1, type2: m.type2 } };
                return (
                    <button type="button" key={m.id} className="post-mon" onClick={() => api.openPublishedMonById(m.id)} title={`Open ${m.name || 'this Fakémon'}`}>
                        <LazyArt row={row as any} className="post-mon-art" />
                        <span className="post-mon-label">
                            <strong>{m.name || 'Unnamed'}</strong>
                            <span className="post-mon-types">
                                {[m.type1, m.type2].filter(Boolean).map(t => <span key={t} className={`type-badge type-${String(t).toLowerCase()}`}>{t}</span>)}
                            </span>
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

export function PostFeedCard({ item, full = false }: { item: FeedItem; full?: boolean }) {
    const ref = useImpression(`post:${item.id}`);
    const isMine = !!state.user && state.user.id === item.user_id;
    const canDelete = isMine || !!api.isStaff?.();
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(item.body || '');
    const [menu, setMenu] = useState(false);
    const open = () => api.openPost(item.id);
    const verb = (item.mon_ids || []).length ? `shared ${(item.mon_ids || []).length} Fakémon` : '';
    return (
        <article className={`feed-card feed-card-post${full ? ' is-full' : ''}`} ref={ref as any}>
            <div className="feed-card-head">
                <Byline item={item} verb={verb} />
                {(isMine || canDelete) && (
                    <div className="feed-menu-wrap">
                        <button type="button" className="feed-menu-btn" aria-label="Post options" onClick={() => setMenu(v => !v)}><Icon name="ellipsis-horizontal" size={18} /></button>
                        {menu && (
                            <div className="feed-menu" onMouseLeave={() => setMenu(false)}>
                                {isMine && <button type="button" onClick={() => { setMenu(false); setDraft(item.body || ''); setEditing(true); }}><Icon name="pencil" size={14} /> Edit</button>}
                                <button type="button" onClick={() => { setMenu(false); api.copyPostLink(item.id); }}><Icon name="link" size={14} /> Copy link</button>
                                {canDelete && <button type="button" className="is-danger" onClick={() => { setMenu(false); api.deletePost(item.id); }}><Icon name="trash-2" size={14} /> {isMine ? 'Delete' : 'Remove (staff)'}</button>}
                            </div>
                        )}
                    </div>
                )}
            </div>
            {editing ? (
                <div className="post-edit">
                    <EmojiInput value={draft} onChange={setDraft} maxLength={4000} rows={4} autoFocus />
                    <div className="post-edit-actions">
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(false)}>Cancel</button>
                        <button type="button" className="btn btn-primary btn-sm" onClick={async () => { if (await api.editPost(item.id, draft)) setEditing(false); }}>Save</button>
                    </div>
                </div>
            ) : item.body ? (
                <div className={`post-body${!full ? ' is-clamped' : ''}`} onClick={e => { if (!full && !(e.target as HTMLElement).closest('a')) open(); }}>
                    <RichText text={item.body} />
                    {item.truncated && !full && <span className="post-more">Keep reading</span>}
                </div>
            ) : null}
            <PostMons mons={item.mons || []} />
            {(item.tags || []).length > 0 && (
                <div className="post-tags">{(item.tags || []).map((t: string) => <span key={t} className="post-tag">#{t}</span>)}</div>
            )}
            <div className="feed-actions">
                <Reactions post={item} />
                <button type="button" className="feed-action feed-action-end" onClick={open} title="Comments"><Icon name="message-circle" size={18} /><span>{Number(item.comment_count || 0)}</span></button>
            </div>
        </article>
    );
}

export function FeedCard({ item }: { item: FeedItem }) {
    return item.kind === 'mon' ? <MonFeedCard item={item} /> : <PostFeedCard item={item} />;
}

export function FeedSkeleton({ count = 3 }: { count?: number }) {
    return (
        <>
            {Array.from({ length: count }, (_, i) => (
                <div className="feed-card skel-card" key={i}>
                    <div className="feed-byline"><span className="feed-avatar skel skel-circle" /><span className="skel skel-text" style={{ width: 140 }} /></div>
                    <div className="feed-mon-art skel" style={{ aspectRatio: i % 2 ? '16 / 7' : '1 / 1' }} />
                    <div className="feed-mon-body"><span className="skel skel-text" style={{ width: '60%' }} /><span className="skel skel-text" style={{ width: '40%' }} /></div>
                </div>
            ))}
        </>
    );
}

// ==================== writing a post ====================

export function PostComposer({ onPosted }: { onPosted?: () => void }) {
    const [open, setOpen] = useState(false);
    const [text, setText] = useState('');
    const [mons, setMons] = useState<any[]>([]);
    const [busy, setBusy] = useState(false);
    const user = state.user;
    if (!user) return null;
    const name = user.displayName || user.username || 'you';
    async function post() {
        if (busy) return;
        setBusy(true);
        const id = await api.createPost({ body: text, monIds: mons.map(m => m.id) });
        setBusy(false);
        if (id) { setText(''); setMons([]); setOpen(false); onPosted?.(); }
    }
    if (!open) {
        return (
            <div className="post-composer is-collapsed">
                <Avatar userId={user.id} url={user.avatarUrl} name={name} className="feed-avatar" />
                <button type="button" className="post-composer-prompt" onClick={() => setOpen(true)}>What are you making, {name.split(' ')[0]}?</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setOpen(true); openDialog('pick-post-mons', { selected: mons, onDone: setMons }); }}>
                    <Icon name="sparkles" size={14} /> Show off Fakémon
                </button>
            </div>
        );
    }
    return (
        <div className="post-composer">
            <div className="post-composer-top">
                <Avatar userId={user.id} url={user.avatarUrl} name={name} className="feed-avatar" />
                <strong>{name}</strong>
            </div>
            <EmojiInput value={text} onChange={setText} maxLength={4000} rows={4} autoFocus
                placeholder="Say something! Use #tags, **bold**, and :emojis: (try typing :tatsu)" />
            {mons.length > 0 && (
                <div className="post-composer-mons">
                    {mons.map(m => (
                        <span key={m.id} className="post-composer-mon">
                            {m.name}
                            <button type="button" aria-label={`Remove ${m.name}`} onClick={() => setMons(mons.filter(x => x.id !== m.id))}><Icon name="x" size={12} /></button>
                        </span>
                    ))}
                </div>
            )}
            <div className="post-composer-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('pick-post-mons', { selected: mons, onDone: setMons })}>
                    <Icon name="sparkles" size={14} /> {mons.length ? `Fakémon (${mons.length})` : 'Add Fakémon'}
                </button>
                <span className="post-composer-count">{text.length}/4000</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setOpen(false); }}>Cancel</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || (!text.trim() && !mons.length)} onClick={post}>{busy ? 'Posting…' : 'Post'}</button>
            </div>
        </div>
    );
}

// ==================== which Fakemon go in a post ====================

function PickPostMons({ close, selected, onDone }: DialogProps<{ selected: any[]; onDone: (mons: any[]) => void }>) {
    const [mine, setMine] = useState<any[] | null>(null);
    const [picked, setPicked] = useState<Map<string, any>>(() => new Map((selected || []).map(m => [m.id, m])));
    const [query, setQuery] = useState('');
    useEffect(() => {
        let live = true;
        (async () => {
            const client = await api.getClient();
            const { data } = await client.from('published_mons')
                .select('id, published_at, fakemon_data->>name, fakemon_data->>type1, fakemon_data->>type2')
                .eq('user_id', state.user!.id).order('published_at', { ascending: false }).limit(100);
            if (live) setMine(data || []);
        })();
        return () => { live = false; };
    }, []);
    const toggle = (m: any) => {
        const next = new Map(picked);
        if (next.has(m.id)) next.delete(m.id);
        else if (next.size < 12) next.set(m.id, m);
        else api.showToast?.('Up to 12 Fakémon per post.', 'warning');
        setPicked(next);
    };
    const list = (mine || []).filter(m => !query || String(m.name || '').toLowerCase().includes(query.toLowerCase()));
    return (
        <Modal onClose={close} title="Show off your Fakémon" className="pick-post-mons">
            <p className="field-hint">Pick from what you've published to the hub (up to 12). Haven't published one yet? Publish it from your collection first.</p>
            <input type="search" placeholder="Find one…" value={query} onChange={e => setQuery(e.target.value)} />
            <div className="pick-post-mons-grid">
                {mine === null ? <div className="community-empty">Loading…</div>
                    : !list.length ? <div className="community-empty">{mine.length ? 'Nothing matches.' : 'You haven’t published any Fakémon yet.'}</div>
                    : list.map(m => (
                        <button type="button" key={m.id} className={`pick-post-mon${picked.has(m.id) ? ' is-picked' : ''}`} onClick={() => toggle(m)} aria-pressed={picked.has(m.id)}>
                            <LazyArt row={{ id: m.id, fakemon_data: { name: m.name } } as any} className="pick-post-mon-art" />
                            <span>{m.name || 'Unnamed'}</span>
                            {picked.has(m.id) && <span className="pick-post-mon-check"><Icon name="check" size={14} /></span>}
                        </button>
                    ))}
            </div>
            <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={close}>Cancel</button>
                <button type="button" className="btn btn-primary" onClick={() => { onDone([...picked.values()]); close(); }}>Done ({picked.size})</button>
            </div>
        </Modal>
    );
}
registerDialog('pick-post-mons', PickPostMons);

// ==================== comments on a post ====================

export function PostComments({ postId, postOwner, comments }: { postId: string; postOwner: string; comments: any[] | null }) {
    if (comments === null) return <div className="community-empty">Loading comments…</div>;
    if (!comments.length) return <div className="community-empty">No comments yet. Say something!</div>;
    const me = state.user?.id;
    return (
        <div className="post-comments">
            {comments.map(c => {
                const canDelete = c.user_id === me || postOwner === me || !!api.isStaff?.();
                return (
                    <div className="post-comment" key={c.id}>
                        <Avatar userId={c.user_id} url={c.author_avatar_url} name={c.author_name} className="feed-avatar feed-avatar-sm" />
                        <div className="post-comment-bubble">
                            <div className="post-comment-head">
                                <span className="community-author-link" data-user-id={c.user_id} onClick={() => api.showUserProfile(c.user_id)}>{c.author_name || 'Someone'}</span>
                                <BadgeRow badgeKeys={c.author_badges} size={12} />
                                <time className="post-comment-time" title={new Date(c.created_at).toLocaleString()}>{timeAgo(c.created_at)}</time>
                                {canDelete && (
                                    <button type="button" className="mon-comment-delete" title="Delete" onClick={() => api.deletePostComment(c.id, postId)}><Icon name="trash-2" size={12} /></button>
                                )}
                            </div>
                            <RichText text={c.body} className="post-comment-body" />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

export function CommentComposer({ onSubmit, placeholder = 'Write a comment…' }: { onSubmit: (text: string) => Promise<boolean>; placeholder?: string }) {
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    if (!state.user) return <p className="mon-detail-signin-hint" style={{ display: 'block' }}><a href="#" onClick={e => { e.preventDefault(); api.openAuthModal('signin'); }}>Sign in</a> to comment.</p>;
    async function send() {
        if (!text.trim() || busy) return;
        setBusy(true);
        const ok = await onSubmit(text);
        setBusy(false);
        if (ok) setText('');
    }
    return (
        <div className="comment-composer">
            <Avatar userId={state.user.id} url={state.user.avatarUrl} name={state.user.displayName || state.user.username} className="feed-avatar feed-avatar-sm" />
            <EmojiInput value={text} onChange={setText} maxLength={1000} rows={2} placeholder={placeholder} onSubmit={send}
                tools={<button type="button" className="comment-send" disabled={busy || !text.trim()} onClick={send} aria-label="Post comment"><Icon name="paper-airplane" size={18} /></button>} />
        </div>
    );
}
