// Posts and events: the community's own content beyond comments and Fakémon.
// Every action here is an admin_* RPC (supabase/migrations/
// 20261016000000_events_social_audit_moderation.sql) that checks the
// permission and rank again, notifies the owner with the reason, and writes
// the mod log.

import { useEffect, useState } from 'react';
import { Icon } from '../app/components/Icon.tsx';
import { useStore } from '../app/store.ts';
import { routeUrl } from '../core/router.ts';
import { timeAgo } from '../features/moderation-model.ts';
import { ask, can, getClient, reload, reloads, showToast } from './core.ts';
import { ListState } from './ui.tsx';

/** A page of the main site (the panel sits beside it, so its base works for both). */
const siteLink = routeUrl;

/** Runs one moderation RPC after asking for the reason. @returns whether it went through */
async function moderate(opts: { title: string; blurb: string; confirm: string; danger?: boolean; dangerText?: string }, rpc: string, args: (reason: string) => Record<string, any>, done: string): Promise<boolean> {
    const answer = await ask(opts);
    if (!answer) return false;
    try {
        const client = await getClient();
        const { error } = await client.rpc(rpc, args(answer.reason));
        if (error) throw error;
        showToast(done, 'success');
        reload('log');
        return true;
    } catch (e: any) {
        showToast(e.message || 'That action failed.', 'error');
        return false;
    }
}

// ==================== posts ====================
interface PostRow {
    id: string; user_id: string; author_name: string; body: string; created_at: string; edited_at: string | null;
    mon_count: number; event_count: number; repost_kind: string | null; comment_count: number; reaction_count: number;
}

export function PostsTab() {
    useStore();
    const [search, setSearch] = useState('');
    const [state, setState] = useState<{ loading: boolean; error: string; posts: PostRow[] }>({ loading: true, error: '', posts: [] });

    async function load() {
        setState(s => ({ ...s, loading: true, error: '' }));
        try {
            const client = await getClient();
            const { data, error } = await client.rpc('admin_recent_posts', { p_limit: 150, p_search: search.trim() });
            if (error) throw error;
            setState({ loading: false, error: '', posts: data || [] });
        } catch (e: any) {
            setState({ loading: false, error: e.message, posts: [] });
        }
    }
    useEffect(() => { load(); }, [reloads.posts]);

    async function remove(p: PostRow) {
        const ok = await moderate({ title: 'Delete post', blurb: 'The post goes with its comments, reactions and polls. Its author is notified with your reason, and the deletion is recorded in the mod log.', confirm: 'Delete' },
            'admin_delete_post', reason => ({ p_post: p.id, p_reason: reason }), 'Post deleted');
        if (ok) setState(s => ({ ...s, posts: s.posts.filter(x => x.id !== p.id) }));
    }

    return (
        <>
            <div className="admin-section-head">
                <h3>Posts</h3>
                <button type="button" className="btn btn-secondary btn-sm" onClick={load}><Icon name="refresh-cw" /> Reload</button>
            </div>
            <p className="admin-section-sub">Every post in the Community feed, newest first: plain posts, reposts and shares. Open one to see it in place, or delete it.</p>
            <form className="admin-search-bar" onSubmit={e => { e.preventDefault(); load(); }}>
                <input type="text" placeholder="Search post text or author" autoComplete="off" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search posts" />
                <button type="submit" className="btn btn-primary"><Icon name="search" /> Search</button>
            </form>
            {state.loading || state.error || !state.posts.length
                ? <ListState loading={state.loading} error={state.error} empty="no posts match that" />
                : state.posts.map(p => (
                    <div className="admin-comment-row" key={p.id}>
                        <div>
                            <div className="admin-comment-meta">
                                <span className="admin-comment-kind">{p.repost_kind ? (p.body ? 'share' : 'repost') : 'post'}</span>
                                <strong>{p.author_name}</strong>
                                <span>{timeAgo(p.created_at)}{p.edited_at ? ' · edited' : ''}</span>
                                <span>{[p.mon_count && `${p.mon_count} Fakemon`, p.event_count && `${p.event_count} event${p.event_count === 1 ? '' : 's'}`,
                                    `${p.comment_count} comment${Number(p.comment_count) === 1 ? '' : 's'}`, `${p.reaction_count} reaction${Number(p.reaction_count) === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</span>
                                <a href={siteLink(`post/${p.id}`)} target="_blank" rel="noopener noreferrer">Open <Icon name="external-link" /></a>
                            </div>
                            {p.body ? <p>{p.body.length > 600 ? `${p.body.slice(0, 600)}…` : p.body}</p> : <p className="admin-muted">(no text)</p>}
                        </div>
                        {can('delete_content') && <button type="button" className="admin-mon-delete" title="Delete this post" onClick={() => remove(p)}><Icon name="trash-2" /></button>}
                    </div>
                ))}
        </>
    );
}

// ==================== events ====================
interface EventListRow {
    id: string; slug: string | null; title: string; owner_id: string; owner_name: string; phase: string; stage: string; created_at: string;
    entry_count: number; comment_count: number; announcement_count: number;
}
interface EventContent {
    announcements: Array<{ id: string; title: string; body: string; created_at: string; poster: string | null }>;
    entries: Array<{ id: string; user_id: string | null; created_at: string; thumb: string | null; author: string | null; title: string }>;
}

const STAGE_NAMES: Record<string, string> = { draft: 'draft', upcoming: 'opens soon', open: 'taking entries', closed: 'entries closed', voting: 'voting', tallying: 'results soon', ended: 'ended' };

export function EventsTab() {
    useStore();
    const [search, setSearch] = useState('');
    const [open, setOpen] = useState<string | null>(null);
    const [state, setState] = useState<{ loading: boolean; error: string; events: EventListRow[] }>({ loading: true, error: '', events: [] });

    async function load() {
        setState(s => ({ ...s, loading: true, error: '' }));
        try {
            const client = await getClient();
            const { data, error } = await client.rpc('admin_list_events', { p_search: search.trim(), p_limit: 150 });
            if (error) throw error;
            setState({ loading: false, error: '', events: data || [] });
        } catch (e: any) {
            setState({ loading: false, error: e.message, events: [] });
        }
    }
    useEffect(() => { load(); }, [reloads.events]);

    async function unpublish(ev: EventListRow) {
        if (await moderate({ title: `Take down ${ev.title}`, blurb: 'The event goes back to a draft: off the Events page, its link stops working for everyone but its team. Nothing is deleted. The organizer is notified with your reason.', confirm: 'Take down' },
            'admin_unpublish_event', reason => ({ p_event: ev.id, p_reason: reason }), 'Event taken down')) reload('events');
    }
    async function remove(ev: EventListRow) {
        if (await moderate({ title: `Delete ${ev.title}`, blurb: 'Deletes the event with every entry, vote, comment and announcement. The organizer is notified with your reason.', confirm: 'Delete event', danger: true, dangerText: 'This cannot be undone.' },
            'admin_delete_event', reason => ({ p_event: ev.id, p_reason: reason }), 'Event deleted')) {
            setState(s => ({ ...s, events: s.events.filter(x => x.id !== ev.id) }));
        }
    }

    return (
        <>
            <div className="admin-section-head">
                <h3>Events</h3>
                <button type="button" className="btn btn-secondary btn-sm" onClick={load}><Icon name="refresh-cw" /> Reload</button>
            </div>
            <p className="admin-section-sub">Every event, drafts included, newest first. Take one down (back to a draft, nothing lost) or delete it, and look through its announcements and entries. Its comments are in the Comments tab.</p>
            <form className="admin-search-bar" onSubmit={e => { e.preventDefault(); load(); }}>
                <input type="text" placeholder="Search by title, link or organizer" autoComplete="off" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search events" />
                <button type="submit" className="btn btn-primary"><Icon name="search" /> Search</button>
            </form>
            {state.loading || state.error || !state.events.length
                ? <ListState loading={state.loading} error={state.error} empty="no events match that" />
                : state.events.map(ev => (
                    <div className="admin-event-block" key={ev.id}>
                        <div className="admin-comment-row">
                            <div>
                                <div className="admin-comment-meta">
                                    <span className="admin-comment-kind">{STAGE_NAMES[ev.stage] || ev.stage}</span>
                                    <strong>{ev.title}</strong>
                                    <span>by {ev.owner_name} · {timeAgo(ev.created_at)}</span>
                                    <span>{ev.entry_count} entries · {ev.comment_count} comments · {ev.announcement_count} announcements</span>
                                    <a href={siteLink(`events/${ev.slug || ev.id}`)} target="_blank" rel="noopener noreferrer">Open <Icon name="external-link" /></a>
                                    {can('manage_events') && <a href={siteLink(`events/${ev.slug || ev.id}/dashboard`)} target="_blank" rel="noopener noreferrer">Dashboard <Icon name="external-link" /></a>}
                                </div>
                                <button type="button" className="admin-link-btn" onClick={() => setOpen(open === ev.id ? null : ev.id)}>
                                    <Icon name={open === ev.id ? 'chevron-down' : 'chevron-right'} /> Announcements and entries
                                </button>
                            </div>
                            {can('delete_content') && (
                                <div className="admin-row-actions">
                                    {ev.phase !== 'draft' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => unpublish(ev)}><Icon name="eye-slash" /> Take down</button>}
                                    <button type="button" className="admin-mon-delete" title="Delete this event" onClick={() => remove(ev)}><Icon name="trash-2" /></button>
                                </div>
                            )}
                        </div>
                        {open === ev.id && <EventContentList ev={ev} />}
                    </div>
                ))}
        </>
    );
}

function EventContentList({ ev }: { ev: EventListRow }) {
    const [state, setState] = useState<{ loading: boolean; error: string; content: EventContent | null }>({ loading: true, error: '', content: null });
    async function load() {
        try {
            const client = await getClient();
            const { data, error } = await client.rpc('admin_event_content', { p_event: ev.id });
            if (error) throw error;
            setState({ loading: false, error: '', content: data });
        } catch (e: any) {
            setState({ loading: false, error: e.message, content: null });
        }
    }
    useEffect(() => { load(); }, [ev.id]);
    if (state.loading || state.error || !state.content) return <div className="admin-event-content"><ListState loading={state.loading} error={state.error} empty="nothing here" /></div>;
    const c = state.content;
    const removeAnnouncement = async (id: string) => {
        if (await moderate({ title: 'Delete announcement', blurb: 'It comes off the event page. Notifications already sent stay sent. Recorded in the mod log.', confirm: 'Delete' },
            'admin_delete_event_announcement', reason => ({ p_id: id, p_reason: reason }), 'Announcement deleted')) load();
    };
    const removeEntry = async (id: string) => {
        if (await moderate({ title: 'Remove entry', blurb: 'The entry and its votes are deleted. Its entrant is notified with your reason.', confirm: 'Remove' },
            'admin_delete_event_entry', reason => ({ p_entry: id, p_reason: reason }), 'Entry removed')) { load(); reload('events'); }
    };
    return (
        <div className="admin-event-content">
            <h4>Announcements ({c.announcements.length})</h4>
            {!c.announcements.length && <p className="admin-muted">None.</p>}
            {c.announcements.map(a => (
                <div className="admin-comment-row" key={a.id}>
                    <div>
                        <div className="admin-comment-meta"><strong>{a.title}</strong><span>{a.poster ? `by ${a.poster}` : ''} · {timeAgo(a.created_at)}</span></div>
                        {a.body && <p>{a.body}</p>}
                    </div>
                    {can('delete_content') && <button type="button" className="admin-mon-delete" title="Delete this announcement" onClick={() => removeAnnouncement(a.id)}><Icon name="trash-2" /></button>}
                </div>
            ))}
            <h4>Entries ({c.entries.length})</h4>
            {!c.entries.length && <p className="admin-muted">None.</p>}
            {c.entries.map(en => (
                <div className="admin-comment-row admin-entry-row" key={en.id}>
                    {en.thumb ? <img src={en.thumb} alt="" className="admin-entry-thumb" /> : <span className="admin-entry-thumb"><Icon name="file-text" /></span>}
                    <div>
                        <div className="admin-comment-meta"><strong>{en.title}</strong><span>{en.user_id ? `by ${en.author || 'unknown'}` : 'by a guest'} · {timeAgo(en.created_at)}</span></div>
                    </div>
                    {can('delete_content') && <button type="button" className="admin-mon-delete" title="Remove this entry" onClick={() => removeEntry(en.id)}><Icon name="trash-2" /></button>}
                </div>
            ))}
        </div>
    );
}
