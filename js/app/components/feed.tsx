// The Community Hub feed's pieces: a Fakemon card (laid out like Instagram),
// a post (text first, like Tumblr, with the Fakemon it shows off), reposts
// and shares, emoji reactions, the "write a post" box, and the picker for
// adding your published Fakemon to a post. Data and actions: js/features/social.ts.

import { useEffect, useRef, useState } from 'react';
import { api, state } from '../../core/app.ts';
import { evoBadgeLabel } from '../../features/community-feed-model.ts';
import { Avatar } from './Avatar.tsx';
import { BadgeRow } from './Badge.tsx';
import { Icon } from './Icon.tsx';
import { EmojiInput, RichText } from './EmojiInput.tsx';
import { CommentThread, ReactionSummary, timeAgo } from './comments.tsx';
import { notify } from '../store.ts';
import { LazyArt } from './community.tsx';
import { TypeBadges } from './profile.tsx';
import { Modal } from './Modal.tsx';
import { useClickAway } from './editor/fields.tsx';
import { registerDialog, openDialog, type DialogProps } from '../dialogs.tsx';
import { PollEditor, PollView } from './polls.tsx';
import { emptyPoll, type PollDraft } from '../../features/polls.ts';
import type { FeedItem } from '../../features/feed-algorithm.ts';
import { STAGE_LABEL, effectivePhase, fetchEvents } from '../../features/events.ts';

// timeAgo lives with the comments now; it's re-exported for the pages that
// already import it from here
export { timeAgo };

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

// ==================== under every card ====================

/** A card's comments, opened in place under it (like Facebook) rather than on another page. */
function InlineComments({ kind, item, targetName }: { kind: 'mon' | 'post'; item: FeedItem; targetName?: string }) {
    return (
        <div className="feed-comments">
            <CommentThread kind={kind} parentId={item.id} ownerId={item.user_id} targetName={targetName} autoFocus
                onCount={n => { if (Number(item.comment_count || 0) !== n) { item.comment_count = n; notify(); } }} />
        </div>
    );
}

export function Reactions({ post }: { post: any }) {
    const kind = post.kind === 'mon' ? 'mon' : 'post';
    return <ReactionSummary kind={kind} id={post.id} counts={post.reactions || {}} mine={post.my_reactions || []} onToggle={emoji => api.toggleReaction({ ...post, kind }, emoji)} />;
}

/** Repost, share with your own words on top (Threads' Repost / Quote, Facebook's Share), or copy the link. */
function RepostButton({ item }: { item: FeedItem }) {
    const [menu, setMenu] = useState(false);
    const target = api.repostTarget(item);
    const mine = !!target.reposted_by_me;
    const ref = useClickAway(menu, () => setMenu(false));
    return (
        <div className="feed-menu-wrap feed-repost-wrap" ref={ref}>
            <button type="button" className={`feed-action${mine ? ' is-reposted' : ''}`} aria-haspopup="menu" aria-expanded={menu}
                title={mine ? 'Reposted' : 'Share'} onClick={() => setMenu(v => !v)}>
                <Icon name="arrow-path-rounded-square" size={18} /><span>{Number(target.repost_count || 0)}</span>
            </button>
            {menu && (
                <div className="feed-menu feed-repost-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => { setMenu(false); if (api.requireAccount?.('Sign in to repost.')) api.toggleRepost(item); }}>
                        <Icon name="arrow-path-rounded-square" size={14} /> {mine ? 'Undo repost' : 'Repost'}
                    </button>
                    <button type="button" role="menuitem" onClick={() => { setMenu(false); if (api.requireAccount?.('Sign in to share.')) openDialog('quote-repost', { item: target }); }}>
                        <Icon name="pencil-square" size={14} /> Share with your thoughts
                    </button>
                    <button type="button" role="menuitem" onClick={() => { setMenu(false); target.kind === 'mon' ? api.copyCommunityShareLink(target.id) : api.copyPostLink(target.id); }}>
                        <Icon name="link" size={14} /> Copy link
                    </button>
                </div>
            )}
        </div>
    );
}

/** The same row on every card, Fakémon and posts alike. */
function FeedActions({ item, comments, onComments }: { item: FeedItem; comments: boolean; onComments: () => void }) {
    return (
        <div className="feed-actions">
            <Reactions post={item} />
            <button type="button" className={`feed-action${comments ? ' is-open' : ''}`} onClick={onComments} aria-expanded={comments} title="Comments">
                <Icon name="message-circle" size={18} /><span>{Number(item.comment_count || 0)}</span>
            </button>
            <RepostButton item={item} />
        </div>
    );
}

// ==================== a published Fakemon ====================
// Instagram's order: who posted it, the picture, the actions, then the words.

export function MonFeedCard({ item }: { item: FeedItem }) {
    const ref = useImpression(`mon:${item.id}`);
    const [comments, setComments] = useState(false);
    const mon = item.fakemon_data || {};
    const evo = evoBadgeLabel(item);
    const open = () => { api.recordOpened?.(item.id, item.user_id); openMon(item); };
    return (
        <article className="feed-card feed-card-mon" ref={ref as any}>
            <Byline item={item} verb="published a Fakémon" />
            <button type="button" className="feed-mon-art-btn" onClick={open} aria-label={`Open ${mon.name || 'this Fakémon'}`}>
                <LazyArt row={item as any} className="feed-mon-art" full>{evo && <span className="community-card-evo-badge">{evo}</span>}</LazyArt>
            </button>
            <FeedActions item={item} comments={comments} onComments={() => setComments(v => !v)} />
            <div className="feed-mon-body">
                <div className="feed-mon-title">
                    <button type="button" className="feed-mon-name" onClick={open}>{mon.name || 'Unnamed'}</button>
                    {mon.number && <span className="feed-mon-number">{mon.number}</span>}
                    <TypeBadges type1={mon.type1} type2={mon.type2} />
                </div>
                {mon.species && <div className="feed-mon-species">The {mon.species}</div>}
                {item.caption && <p className="feed-mon-caption">{item.caption}</p>}
            </div>
            {comments && <InlineComments kind="mon" item={item} targetName={mon.name || 'your Fakémon'} />}
        </article>
    );
}

/** The feed's rows aren't in the hub grid's list; the detail page opens from the id. */
function openMon(item: FeedItem) {
    api.openPublishedMonById(item.id);
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
                        <LazyArt row={row as any} className="post-mon-art" full />
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

/** What a share-with-your-thoughts shows of its original: a small card you can open. */
export function RepostEmbed({ item }: { item: any }) {
    if (!item || item.missing) return <div className="repost-embed is-missing"><Icon name="no-symbol" size={16} /> This is no longer available.</div>;
    if (item.kind === 'event') return <EventEmbed item={item} />;
    const name = item.author_name || 'Someone';
    if (item.kind === 'mon') {
        const mon = item.fakemon_data || {};
        return (
            <button type="button" className="repost-embed is-mon" onClick={() => api.openPublishedMonById(item.id)}>
                <LazyArt row={item} className="repost-embed-art" />
                <span className="repost-embed-text">
                    <span className="repost-embed-by"><Avatar userId={item.user_id} url={item.author_avatar_url} name={name} className="feed-avatar feed-avatar-xs" />{name}</span>
                    <strong>{mon.name || 'Unnamed'}</strong>
                    <TypeBadges type1={mon.type1} type2={mon.type2} />
                </span>
            </button>
        );
    }
    return (
        <div className="repost-embed is-post" role="link" tabIndex={0} onClick={() => api.openPost(item.id)} onKeyDown={e => { if (e.key === 'Enter') api.openPost(item.id); }}>
            <span className="repost-embed-by">
                <Avatar userId={item.user_id} url={item.author_avatar_url} name={name} className="feed-avatar feed-avatar-xs" />{name}
                <time dateTime={item.created_at}>{timeAgo(item.created_at)}</time>
            </span>
            {item.body && <div className="post-body is-clamped repost-embed-body"><RichText text={item.body} /></div>}
            {(item.mons || []).length > 0 && <span className="repost-embed-mons">{(item.mons || []).map((m: any) => m.name).filter(Boolean).join(' · ')}</span>}
        </div>
    );
}

const EVENT_STAGE: Record<string, string> = { upcoming: 'Opens soon', open: 'Taking entries', closed: 'Entries closed', voting: 'Voting', tallying: 'Results soon', ended: 'Ended' };

/** The events a post shows, each as a small card that opens it. */
export function PostEvents({ events }: { events?: any[] }) {
    if (!events?.length) return null;
    return <div className="post-events">{events.map(e => <EventEmbed key={e.id} item={e} />)}</div>;
}

/** A shared event (js/features/events.ts): its cover, name and where it's at; opens the event. */
function EventEmbed({ item }: { item: any }) {
    const open = () => api.openEvents?.(item.slug || item.id);
    return (
        <div className="repost-embed is-event" role="link" tabIndex={0} onClick={open} onKeyDown={e => { if (e.key === 'Enter') open(); }}>
            <span className="repost-embed-event-art">{item.cover_image ? <img src={item.cover_image} alt="" loading="lazy" draggable={false} /> : <Icon name="trophy" size={24} />}</span>
            <span className="repost-embed-text">
                <span className="repost-embed-event-meta"><Icon name="calendar-days" size={13} />Event{item.category ? ` · ${item.category}` : ''} · {EVENT_STAGE[item.stage] || 'Event'}</span>
                <strong>{item.title}</strong>
                {item.tagline && <span className="repost-embed-event-tagline">{item.tagline}</span>}
                {item.entry_count != null && <span className="repost-embed-event-meta">{item.entry_count} {Number(item.entry_count) === 1 ? 'entry' : 'entries'}</span>}
            </span>
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
    // the full post page still has its own link; comments open right here
    const [comments, setComments] = useState(full);
    const open = () => api.openPost(item.id);
    const verb = item.repost ? 'shared' : (item.mon_ids || []).length ? `shared ${(item.mon_ids || []).length} Fakémon`
        : (item.events || []).length ? `shared ${(item.events || []).length === 1 ? 'an event' : `${item.events.length} events`}` : '';
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
            <PostEvents events={item.events} />
            <PollView kind="post" parentId={item.id} />
            {item.repost && <div className="repost-embed-wrap"><RepostEmbed item={item.repost} /></div>}
            {(item.tags || []).length > 0 && (
                <div className="post-tags">{(item.tags || []).map((t: string) => <span key={t} className="post-tag">#{t}</span>)}</div>
            )}
            <FeedActions item={item} comments={comments} onComments={() => setComments(v => !v)} />
            {comments && <InlineComments kind="post" item={item} />}
        </article>
    );
}

/** A plain repost (no words of its own): the original's own card, under who reposted it. */
function RepostedCard({ item }: { item: FeedItem }) {
    const mine = !!state.user && state.user.id === item.user_id;
    const original = item.repost;
    return (
        <div className="reposted">
            <div className="reposted-by">
                <Icon name="arrow-path-rounded-square" size={15} />
                <button type="button" className="link-btn" onClick={() => api.showUserProfile(item.user_id)}>{mine ? 'You' : item.author_name || 'Someone'}</button>
                <span>reposted · {timeAgo(item.created_at)}</span>
            </div>
            {original.kind === 'mon' ? <MonFeedCard item={original} />
                : original.kind === 'event' ? <div className="feed-card feed-event-card"><RepostEmbed item={original} /></div>
                : <PostFeedCard item={original} />}
        </div>
    );
}

export function FeedCard({ item }: { item: FeedItem }) {
    if (item.kind === 'mon') return <MonFeedCard item={item} />;
    const plain = item.repost && !item.repost.missing && !item.body && !(item.mon_ids || []).length && !(item.events || []).length;
    return plain ? <RepostedCard item={item} /> : <PostFeedCard item={item} />;
}

// ==================== sharing with your thoughts ====================

/** text: words to start from (an event's results post, say) */
function QuoteRepostDialog({ close, item, text: initial = '' }: DialogProps<{ item: any; text?: string }>) {
    const [text, setText] = useState(initial);
    const [busy, setBusy] = useState(false);
    async function share() {
        if (busy) return;
        setBusy(true);
        const ok = await api.quoteRepost(item, text);
        setBusy(false);
        if (ok) close();
    }
    return (
        <Modal onClose={close} title="Share with your thoughts" className="quote-repost-modal">
            <EmojiInput value={text} onChange={setText} maxLength={4000} rows={3} autoFocus placeholder="Say something about it…" ariaLabel="What you want to say" />
            <RepostEmbed item={item} />
            <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={close}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={share}>{busy ? 'Sharing…' : 'Share'}</button>
            </div>
        </Modal>
    );
}
registerDialog('quote-repost', QuoteRepostDialog);

export function FeedSkeleton({ count = 3 }: { count?: number }) {
    return (
        <>
            {Array.from({ length: count }, (_, i) => (
                <div className="feed-card skel-card" key={i}>
                    <div className="feed-byline"><span className="feed-avatar skel skel-circle" /><span className="skel skel-text" style={{ width: 140 }} /></div>
                    <div className="feed-mon-art skel" style={{ aspectRatio: i % 2 ? '16 / 7' : '4 / 3' }} />
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
    const [evs, setEvs] = useState<any[]>([]);
    const [poll, setPoll] = useState<PollDraft | null>(null);
    const [busy, setBusy] = useState(false);
    const user = state.user;
    if (!user) return null;
    const name = user.displayName || user.username || 'you';
    async function post() {
        if (busy) return;
        setBusy(true);
        const id = await api.createPost({ body: text, monIds: mons.map(m => m.id), eventIds: evs.map(e => e.id), poll });
        setBusy(false);
        if (id) { setText(''); setMons([]); setEvs([]); setPoll(null); setOpen(false); onPosted?.(); }
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
                placeholder="Say something! Use #tags, @mentions, **bold**, and :emojis: (try typing :tatsu)" />
            {poll && <PollEditor value={poll} onChange={setPoll} onRemove={() => setPoll(null)} />}
            {(mons.length > 0 || evs.length > 0) && (
                <div className="post-composer-mons">
                    {mons.map(m => (
                        <span key={m.id} className="post-composer-mon">
                            {m.name}
                            <button type="button" aria-label={`Remove ${m.name}`} onClick={() => setMons(mons.filter(x => x.id !== m.id))}><Icon name="x" size={12} /></button>
                        </span>
                    ))}
                    {evs.map(e => (
                        <span key={e.id} className="post-composer-mon is-event">
                            <Icon name="trophy" size={12} />{e.title}
                            <button type="button" aria-label={`Remove ${e.title}`} onClick={() => setEvs(evs.filter(x => x.id !== e.id))}><Icon name="x" size={12} /></button>
                        </span>
                    ))}
                </div>
            )}
            <div className="post-composer-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('pick-post-mons', { selected: mons, onDone: setMons })}>
                    <Icon name="sparkles" size={14} /> {mons.length ? `Fakémon (${mons.length})` : 'Add Fakémon'}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('pick-post-events', { selected: evs, onDone: setEvs })}>
                    <Icon name="trophy" size={14} /> {evs.length ? `Events (${evs.length})` : 'Add event'}
                </button>
                {!poll && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPoll(emptyPoll())}><Icon name="chart-bar" size={14} /> Poll</button>}
                <span className="post-composer-count">{text.length}/4000</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setOpen(false); }}>Cancel</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || (!text.trim() && !mons.length && !evs.length && !poll)} onClick={post}>{busy ? 'Posting…' : 'Post'}</button>
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

// ==================== which events go in a post ====================

const POST_EVENTS_MAX = 4;

/** Any live event (not a draft) can go in a post: yours to promote, or one you're entering. */
function PickPostEvents({ close, selected, onDone }: DialogProps<{ selected: any[]; onDone: (evs: any[]) => void }>) {
    const [list, setList] = useState<any[] | null>(null);
    const [picked, setPicked] = useState<Map<string, any>>(() => new Map((selected || []).map(e => [e.id, e])));
    const [query, setQuery] = useState('');
    useEffect(() => {
        let live = true;
        fetchEvents().then(rows => { if (live) setList(rows.filter(e => e.phase !== 'draft')); }).catch(() => { if (live) setList([]); });
        return () => { live = false; };
    }, []);
    const toggle = (e: any) => {
        const next = new Map(picked);
        if (next.has(e.id)) next.delete(e.id);
        else if (next.size < POST_EVENTS_MAX) next.set(e.id, { id: e.id, title: e.title });
        else api.showToast?.(`Up to ${POST_EVENTS_MAX} events per post.`, 'warning');
        setPicked(next);
    };
    const q = query.trim().toLowerCase();
    const shown = (list || []).filter(e => !q || [e.title, e.tagline, e.category].some(x => String(x || '').toLowerCase().includes(q)));
    return (
        <Modal onClose={close} title="Link an event" className="pick-post-mons pick-post-events">
            <p className="field-hint">People can open it straight from your post (up to {POST_EVENTS_MAX}).</p>
            <input type="search" placeholder="Find one…" value={query} onChange={e => setQuery(e.target.value)} />
            <div className="pick-post-events-list">
                {list === null ? <div className="community-empty">Loading…</div>
                    : !shown.length ? <div className="community-empty">{list.length ? 'Nothing matches.' : 'There are no live events yet.'}</div>
                    : shown.map(e => (
                        <button type="button" key={e.id} className={`pick-post-event${picked.has(e.id) ? ' is-picked' : ''}`} onClick={() => toggle(e)} aria-pressed={picked.has(e.id)}>
                            <span className="pick-post-event-art">{e.cover_thumb ? <img src={e.cover_thumb} alt="" loading="lazy" draggable={false} /> : <Icon name="trophy" size={20} />}</span>
                            <span className="pick-post-event-text"><strong>{e.title}</strong><small>{[e.category, STAGE_LABEL[effectivePhase(e)]].filter(Boolean).join(' · ')}</small></span>
                            {picked.has(e.id) && <span className="pick-post-mon-check"><Icon name="check" size={14} /></span>}
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
registerDialog('pick-post-events', PickPostEvents);
