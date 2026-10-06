// ==================== comments, all kinds ====================
// One place for the four comment threads: on a published Fakemon
// (mon_comments), on a post (post_comments), on a profile's wall
// (profile_comments) and on an event (event_comments). Each thread loads with
// its reactions; comments can be edited by whoever wrote them, answered with a
// reply (parent_id: threads nest, Reddit style) and reacted to by anyone
// signed in, one reaction each.
// The thread itself is drawn by js/app/components/comments.tsx, wherever it
// appears: under a feed card (opened in place, like Facebook), on a post's
// page, on a Fakemon's page, and on profile walls.
// Schema: supabase/migrations/20261005000000_comment_edits_and_reactions.sql
// and 20261016000000_events_social_audit_moderation.sql (replies, events).

import { state, api } from '../core/app.ts';
import { log } from '../core/log.ts';
import { notify } from '../app/store.ts';
import { publicName } from '../core/html.ts';
import { createPoll, commentPollParent, pollProblem, type PollDraft } from './polls.ts';

export type CommentKind = 'mon' | 'post' | 'profile' | 'event';

const TABLE: Record<CommentKind, string> = { mon: 'mon_comments', post: 'post_comments', profile: 'profile_comments', event: 'event_comments' };
const PARENT: Record<CommentKind, string> = { mon: 'mon_id', post: 'post_id', profile: 'profile_id', event: 'event_id' };
const MAX_LENGTH = 1000;

export interface Comment {
    id: string;
    user_id: string;
    /** the comment this one replies to; null at the top of the thread */
    parent_id?: string | null;
    body: string;
    created_at: string;
    edited_at?: string | null;
    author_name?: string;
    author_avatar_url?: string;
    author_badges?: string[];
    reactions: Record<string, number>;
    my_reactions: string[];
}

export interface Thread {
    status: 'loading' | 'ready' | 'error';
    comments: Comment[];
}

const threads = new Map<string, Thread>();
const key = (kind: CommentKind, parentId: string) => `${kind}:${parentId}`;

/** The thread as loaded so far, or null before the first load. */
export function getThread(kind: CommentKind, parentId: string): Thread | null {
    return threads.get(key(kind, parentId)) || null;
}

/** Loads (or reloads) a thread and its reactions. */
export async function loadThread(kind: CommentKind, parentId: string) {
    const k = key(kind, parentId);
    const had = threads.get(k);
    threads.set(k, { status: had?.status === 'ready' ? 'ready' : 'loading', comments: had?.comments || [] });
    notify();
    try {
        const client = await api.getClient();
        const { data, error } = await client.from(TABLE[kind]).select('*').eq(PARENT[kind], parentId)
            .order('created_at', { ascending: true }).limit(500);
        if (error) throw error;
        const rows: Comment[] = (data || []).map((c: any) => ({ ...c, reactions: {}, my_reactions: [] }));
        await Promise.all([
            api.attachLiveAuthorInfo?.(rows),
            attachReactions(kind, rows)
        ]);
        threads.set(k, { status: 'ready', comments: rows.filter(c => !api.hasBlocked?.(c.user_id)) });
    } catch (e: any) {
        log.error('COMMENTS', 'Thread load failed', { kind, parentId, error: e?.message || String(e) });
        threads.set(k, { status: 'error', comments: had?.comments || [] });
    }
    notify();
}

async function attachReactions(kind: CommentKind, rows: Comment[]) {
    if (!rows.length) return;
    const client = await api.getClient();
    const { data, error } = await client.from('comment_reactions').select('comment_id, user_id, emoji')
        .eq('comment_kind', kind).in('comment_id', rows.map(r => r.id));
    // reactions are extra: a thread still shows without them (and before the
    // migration that adds them has run)
    if (error) { log.warn('COMMENTS', 'Reactions unavailable', error); return; }
    const byId = new Map(rows.map(r => [r.id, r]));
    const me = state.user?.id;
    for (const r of data || []) {
        const c = byId.get(r.comment_id);
        if (!c) continue;
        c.reactions[r.emoji] = (c.reactions[r.emoji] || 0) + 1;
        if (r.user_id === me) c.my_reactions.push(r.emoji);
    }
}

function tooLong(text: string) {
    if (text.length <= MAX_LENGTH) return false;
    api.showToast?.(`Comments are limited to ${MAX_LENGTH} characters.`, 'warning');
    return true;
}

/**
 * Adds a comment. `owner` is whose Fakemon / post / profile it's on, for
 * their notification; `targetName` names the thing in that notification.
 * `replyTo`: the comment it answers (the database tells that one's author).
 * @returns whether it was posted
 */
export async function addComment(kind: CommentKind, parentId: string, body: string, owner?: { id: string; targetName?: string }, poll: PollDraft | null = null, replyTo: string | null = null): Promise<boolean> {
    if (!api.requireAccount?.('Sign in to comment.')) return false;
    const text = String(body || '').trim();
    if (!text || tooLong(text)) return false;
    const pollIssue = poll ? pollProblem(poll) : '';
    if (pollIssue) { api.showToast?.(pollIssue, 'warning'); return false; }

    // posts already have their own path (counts, notifications, ranking)
    if (kind === 'post') {
        const ok = await api.commentOnPost(parentId, text, poll, replyTo);
        if (ok) await loadThread(kind, parentId);
        return ok;
    }

    if (!(await api.guardContent?.(text, `${kind} comment`) ?? true)) return false;
    const me = state.user!;
    const row: Record<string, any> = { [PARENT[kind]]: parentId, user_id: me.id, body: text };
    if (replyTo) row.parent_id = replyTo;
    if (kind === 'mon') Object.assign(row, {
        author_name: publicName(me),
        author_avatar_url: me.avatarUrl || null,
        author_role: me.role || 'user',
        author_badges: me.badges || []
    });
    const client = await api.getClient();
    const { data: made, error } = await client.from(TABLE[kind]).insert(row).select('id').single();
    if (error) {
        api.showToast?.(api.friendlyModerationError?.(error) || error.message || 'Comment failed.', 'error');
        return false;
    }
    // a comment whose poll didn't attach comes back down, so the box keeps it all for another try
    if (poll && kind !== 'event') {
        try { await createPoll(commentPollParent(kind), made.id, poll); }
        catch (e: any) {
            await client.from(TABLE[kind]).delete().eq('id', made.id);
            api.showToast?.(`Your poll couldn't be added: ${e?.message || e}`, 'error');
            return false;
        }
    }
    await loadThread(kind, parentId);
    // a reply's author is told by the database; the owner hears about new threads (events: nobody)
    if (owner && owner.id !== me.id && !replyTo && kind !== 'event') {
        api.createNotification?.({
            userId: owner.id, actorId: me.id,
            actorName: publicName(me),
            actorAvatarUrl: me.avatarUrl || null,
            type: kind === 'mon' ? 'mon_comment' : 'profile_comment',
            targetId: parentId,
            ...(owner.targetName ? { targetName: owner.targetName } : {}),
            preview: text
        });
    }
    return true;
}

/** Changes the text of your own comment. @returns whether it saved */
export async function editComment(kind: CommentKind, parentId: string, comment: Comment, body: string): Promise<boolean> {
    if (!state.user || comment.user_id !== state.user.id) return false;
    const text = String(body || '').trim();
    if (!text || tooLong(text)) return false;
    if (text === comment.body) return true;
    if (!(await api.guardContent?.(text, `${kind} comment`) ?? true)) return false;
    const client = await api.getClient();
    const { data, error } = await client.from(TABLE[kind]).update({ body: text })
        .eq('id', comment.id).eq('user_id', state.user.id).select('body, edited_at').maybeSingle();
    if (error || !data) {
        api.showToast?.(api.friendlyModerationError?.(error) || error?.message || 'Could not save your edit.', 'error');
        return false;
    }
    comment.body = data.body;
    comment.edited_at = data.edited_at || new Date().toISOString();
    notify();
    return true;
}

/** Deletes a comment (yours, one on your post or wall, or any if you're staff). */
export async function deleteComment(kind: CommentKind, parentId: string, comment: Comment): Promise<boolean> {
    if (!state.user) return false;
    // its replies go with it (on delete cascade)
    const t = threads.get(key(kind, parentId));
    const gone = new Set([comment.id]);
    for (let grew = !!t; grew;) {
        grew = false;
        for (const c of t!.comments) if (c.parent_id && gone.has(c.parent_id) && !gone.has(c.id)) { gone.add(c.id); grew = true; }
    }
    if (kind === 'post') await api.deletePostComment(comment.id, parentId, gone.size);
    else {
        const client = await api.getClient();
        const { error } = await client.from(TABLE[kind]).delete().eq('id', comment.id);
        if (error) { api.showToast?.('Could not delete: ' + error.message, 'error'); return false; }
    }
    if (t) t.comments = t.comments.filter(c => !gone.has(c.id));
    notify();
    return true;
}

/**
 * Counts after your reaction changes: one each, so whatever you had comes off
 * and `emoji` (null: none) goes on. The database's replace_my_reaction does
 * the same to the rows.
 */
export function applyMyReaction(counts: Record<string, number>, mine: string[], emoji: string | null): { reactions: Record<string, number>; my_reactions: string[] } {
    const reactions = { ...counts };
    for (const e of mine) { reactions[e] = Math.max(0, (reactions[e] || 0) - 1); if (!reactions[e]) delete reactions[e]; }
    if (emoji) reactions[emoji] = (reactions[emoji] || 0) + 1;
    return { reactions, my_reactions: emoji ? [emoji] : [] };
}

/** Your reaction on a comment: the same emoji again takes it back, another one swaps it. */
export async function toggleCommentReaction(kind: CommentKind, comment: Comment, emoji: string) {
    if (!api.requireAccount?.('Sign in to react.')) return;
    const before = { reactions: comment.reactions, my_reactions: comment.my_reactions };
    const had = comment.my_reactions.includes(emoji);
    // optimistic: the chip moves straight away and moves back if the write fails
    Object.assign(comment, applyMyReaction(comment.reactions, comment.my_reactions, had ? null : emoji));
    notify();
    const client = await api.getClient();
    const mine = { comment_kind: kind, comment_id: comment.id, user_id: state.user!.id };
    const { error } = had
        ? await client.from('comment_reactions').delete().match(mine)
        : await client.from('comment_reactions').insert({ ...mine, emoji });
    if (error && error.code !== '23505') {
        Object.assign(comment, before);
        notify();
        api.showToast?.(api.friendlyModerationError?.(error) || error.message || 'Could not react.', 'error');
    }
}

/** Who may delete this comment: its author, the owner of what it's on (an event's team: `moderator`), or staff. */
export function canDeleteComment(kind: CommentKind, comment: Comment, parentOwnerId?: string | null, moderator = false) {
    const me = state.user?.id;
    if (!me) return false;
    if (comment.user_id === me || moderator || api.isStaff?.()) return true;
    if (kind === 'event') return false;
    // mon comments: only the author or staff (RLS); posts and walls: their owner too
    return kind !== 'mon' && !!parentOwnerId && parentOwnerId === me;
}
