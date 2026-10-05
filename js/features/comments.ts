// ==================== comments, all kinds ====================
// One place for the three comment threads: on a published Fakemon
// (mon_comments), on a post (post_comments) and on a profile's wall
// (profile_comments). Each thread loads with its reactions; comments can be
// edited by whoever wrote them and reacted to by anyone signed in.
// The thread itself is drawn by js/app/components/comments.tsx, wherever it
// appears: under a feed card (opened in place, like Facebook), on a post's
// page, on a Fakemon's page, and on profile walls.
// Schema: supabase/migrations/20261005000000_comment_edits_and_reactions.sql.

import { state, api } from '../core/app.ts';
import { log } from '../core/log.ts';
import { notify } from '../app/store.ts';
import { publicName } from '../core/html.ts';
import { createPoll, commentPollParent, pollProblem, type PollDraft } from './polls.ts';

export type CommentKind = 'mon' | 'post' | 'profile';

const TABLE: Record<CommentKind, string> = { mon: 'mon_comments', post: 'post_comments', profile: 'profile_comments' };
const PARENT: Record<CommentKind, string> = { mon: 'mon_id', post: 'post_id', profile: 'profile_id' };
const MAX_LENGTH = 1000;

export interface Comment {
    id: string;
    user_id: string;
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
 * @returns whether it was posted
 */
export async function addComment(kind: CommentKind, parentId: string, body: string, owner?: { id: string; targetName?: string }, poll: PollDraft | null = null): Promise<boolean> {
    if (!api.requireAccount?.('Sign in to comment.')) return false;
    const text = String(body || '').trim();
    if (!text || tooLong(text)) return false;
    const pollIssue = poll ? pollProblem(poll) : '';
    if (pollIssue) { api.showToast?.(pollIssue, 'warning'); return false; }

    // posts already have their own path (counts, notifications, ranking)
    if (kind === 'post') {
        const ok = await api.commentOnPost(parentId, text, poll);
        if (ok) await loadThread(kind, parentId);
        return ok;
    }

    if (!(await api.guardContent?.(text, kind === 'mon' ? 'mon comment' : 'profile comment') ?? true)) return false;
    const me = state.user!;
    const row: Record<string, any> = { [PARENT[kind]]: parentId, user_id: me.id, body: text };
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
    if (poll) {
        try { await createPoll(commentPollParent(kind), made.id, poll); }
        catch (e: any) {
            await client.from(TABLE[kind]).delete().eq('id', made.id);
            api.showToast?.(`Your poll couldn't be added: ${e?.message || e}`, 'error');
            return false;
        }
    }
    await loadThread(kind, parentId);
    if (owner && owner.id !== me.id) {
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
    if (kind === 'post') await api.deletePostComment(comment.id, parentId);
    else {
        const client = await api.getClient();
        const { error } = await client.from(TABLE[kind]).delete().eq('id', comment.id);
        if (error) { api.showToast?.('Could not delete: ' + error.message, 'error'); return false; }
    }
    const t = threads.get(key(kind, parentId));
    if (t) t.comments = t.comments.filter(c => c.id !== comment.id);
    notify();
    return true;
}

/** Adds or takes back one emoji reaction on a comment. */
export async function toggleCommentReaction(kind: CommentKind, comment: Comment, emoji: string) {
    if (!api.requireAccount?.('Sign in to react.')) return;
    const had = comment.my_reactions.includes(emoji);
    // optimistic: the chip moves straight away and moves back if the write fails
    const apply = (adding: boolean) => {
        const n = Math.max(0, (comment.reactions[emoji] || 0) + (adding ? 1 : -1));
        if (n) comment.reactions[emoji] = n; else delete comment.reactions[emoji];
        comment.my_reactions = adding ? [...comment.my_reactions, emoji] : comment.my_reactions.filter(e => e !== emoji);
        notify();
    };
    apply(!had);
    const client = await api.getClient();
    const filter = { comment_kind: kind, comment_id: comment.id, user_id: state.user!.id, emoji };
    const { error } = had
        ? await client.from('comment_reactions').delete().match(filter)
        : await client.from('comment_reactions').insert(filter);
    if (error && error.code !== '23505') {
        apply(had);
        api.showToast?.(api.friendlyModerationError?.(error) || error.message || 'Could not react.', 'error');
    }
}

/** Who may delete this comment: its author, the owner of what it's on, or staff. */
export function canDeleteComment(kind: CommentKind, comment: Comment, parentOwnerId?: string | null) {
    const me = state.user?.id;
    if (!me) return false;
    if (comment.user_id === me || api.isStaff?.()) return true;
    // mon comments: only the author or staff (RLS); posts and walls: their owner too
    return kind !== 'mon' && !!parentOwnerId && parentOwnerId === me;
}
