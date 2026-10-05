// ==================== polls ====================
// A poll on a feed post, a comment (on a post or a Fakemon) or a wall post:
// up to six options, one choice or several, open for a while or until it's
// deleted. Drawn by js/app/components/polls.tsx.
//
// Every poll on screen is fetched in one go per render pass (polls are rare,
// so most lookups come back empty and cheap). The database keeps the totals
// (poll_votes_tally) and decides who may read, vote and create:
// supabase/migrations/20261013000200_polls_mentions_discovery.sql.

import { state, api } from '../core/app.ts';
import { notify } from '../app/store.ts';
import type { CommentKind } from './comments.ts';

export type PollParent = 'post' | 'post_comment' | 'mon_comment' | 'profile_comment';
export interface Poll {
    id: string; user_id: string; question: string; options: string[]; multi: boolean;
    closes_at: string | null; counts: number[]; voters: number; created_at: string;
}
/** A poll being written, before it's attached to anything. */
export interface PollDraft { question: string; options: string[]; multi: boolean; /** hours it stays open; null: until deleted */ hours: number | null; }

const COLUMN: Record<PollParent, string> = { post: 'post_id', post_comment: 'post_comment_id', mon_comment: 'mon_comment_id', profile_comment: 'profile_comment_id' };
const COLUMNS = 'id,user_id,question,options,multi,closes_at,counts,voters,created_at,post_id,post_comment_id,mon_comment_id,profile_comment_id';
export const MAX_OPTIONS = 6;
export const POLL_LENGTHS: Array<[number | null, string]> = [[24, '1 day'], [72, '3 days'], [168, '1 week'], [null, 'No end']];
export const emptyPoll = (): PollDraft => ({ question: '', options: ['', ''], multi: false, hours: 72 });

/** A comment's poll lives under its own kind of comment. */
export const commentPollParent = (kind: CommentKind): PollParent => kind === 'mon' ? 'mon_comment' : kind === 'post' ? 'post_comment' : 'profile_comment';

// key "kind:id" -> the poll, null (none), or missing (not asked yet)
const polls = new Map<string, Poll | null>();
const mine = new Map<string, number[]>();
const waiting = new Map<PollParent, Set<string>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const key = (kind: PollParent, id: string) => `${kind}:${id}`;

/** The poll on something: undefined while it loads, null when there is none. */
export function pollFor(kind: PollParent, parentId: string): Poll | null | undefined {
    const k = key(kind, parentId);
    if (!polls.has(k)) request(kind, parentId);
    return polls.get(k);
}
export const myChoices = (poll: Poll): number[] => mine.get(poll.id) || [];
export const pollClosed = (poll: Poll) => !!poll.closes_at && Date.now() > new Date(poll.closes_at).getTime();

function request(kind: PollParent, id: string) {
    if (!state.user) return;
    if (!waiting.has(kind)) waiting.set(kind, new Set());
    waiting.get(kind)!.add(id);
    flushTimer ||= setTimeout(flush, 0);
}

async function flush() {
    flushTimer = null;
    const batch = [...waiting.entries()].map(([kind, ids]) => [kind, [...ids]] as const);
    waiting.clear();
    try {
        const client = await api.getClient();
        const found: Poll[] = [];
        await Promise.all(batch.map(async ([kind, ids]) => {
            // asked-about ones with no poll are remembered as having none
            ids.forEach(id => { if (!polls.has(key(kind, id))) polls.set(key(kind, id), null); });
            const { data, error } = await client.from('polls').select(COLUMNS).in(COLUMN[kind], ids);
            if (error) throw error;
            for (const row of data || []) {
                polls.set(key(kind, row[COLUMN[kind]]), shape(row));
                found.push(row);
            }
        }));
        if (found.length) {
            const { data } = await client.from('poll_votes').select('poll_id,choices').eq('user_id', state.user!.id).in('poll_id', found.map(p => p.id));
            for (const v of data || []) mine.set(v.poll_id, v.choices || []);
        }
    } catch {
        // asked again next time it's drawn
        batch.forEach(([kind, ids]) => ids.forEach(id => polls.delete(key(kind, id))));
    }
    notify();
}

function shape(row: any): Poll {
    return {
        id: row.id, user_id: row.user_id, question: row.question || '', options: row.options || [], multi: !!row.multi,
        closes_at: row.closes_at, counts: (row.counts || []).map(Number), voters: Number(row.voters || 0), created_at: row.created_at
    };
}

function replace(next: Poll) {
    for (const [k, p] of polls) if (p?.id === next.id) polls.set(k, next);
}

/** What's wrong with a draft, or '' when it can go out. */
export function pollProblem(d: PollDraft): string {
    const options = d.options.map(o => o.trim());
    if (options.filter(Boolean).length < 2) return 'A poll needs at least two options.';
    if (options.some(o => o.length > 80)) return 'Poll options can be up to 80 characters.';
    if (new Set(options.filter(Boolean).map(o => o.toLowerCase())).size !== options.filter(Boolean).length) return 'Two poll options are the same.';
    if (d.question.trim().length > 200) return 'The poll question can be up to 200 characters.';
    return '';
}

/** Attaches a poll to something you just wrote. Throws with the reason if it can't. */
export async function createPoll(kind: PollParent, parentId: string, d: PollDraft): Promise<void> {
    const problem = pollProblem(d);
    if (problem) throw new Error(problem);
    const client = await api.getClient();
    const { data, error } = await client.from('polls').insert({
        user_id: state.user!.id, [COLUMN[kind]]: parentId, question: d.question.trim(),
        options: d.options.map(o => o.trim()).filter(Boolean), multi: d.multi,
        closes_at: d.hours ? new Date(Date.now() + d.hours * 3600_000).toISOString() : null
    }).select(COLUMNS).single();
    if (error) throw error;
    polls.set(key(kind, parentId), shape(data));
    notify();
}

/** Your vote (or, with no choices, taking it back). */
export async function votePoll(poll: Poll, choices: number[]) {
    if (!api.requireAccount?.('Sign in to vote.')) return;
    const before = myChoices(poll);
    const was = { ...poll, counts: [...poll.counts] };
    // shown straight away; the server's totals replace it
    const next = { ...poll, counts: poll.counts.map((n, i) => n - (before.includes(i) ? 1 : 0) + (choices.includes(i) ? 1 : 0)), voters: poll.voters + (before.length ? 0 : 1) - (choices.length ? 0 : 1) };
    replace(next);
    if (choices.length) mine.set(poll.id, choices); else mine.delete(poll.id);
    notify();
    try {
        const client = await api.getClient();
        const { error } = choices.length
            ? await client.from('poll_votes').upsert({ poll_id: poll.id, user_id: state.user!.id, choices }, { onConflict: 'poll_id,user_id' })
            : await client.from('poll_votes').delete().eq('poll_id', poll.id).eq('user_id', state.user!.id);
        if (error) throw error;
        const { data } = await client.from('polls').select(COLUMNS).eq('id', poll.id).maybeSingle();
        if (data) replace(shape(data));
    } catch (e: any) {
        replace(was);
        if (before.length) mine.set(poll.id, before); else mine.delete(poll.id);
        api.showToast?.(e?.message || 'Your vote could not be saved.', 'error');
    }
    notify();
}

export async function deletePoll(poll: Poll) {
    if (!window.confirm('Remove this poll? Its votes go with it.')) return;
    try {
        const client = await api.getClient();
        const { error } = await client.from('polls').delete().eq('id', poll.id);
        if (error) throw error;
        for (const [k, p] of polls) if (p?.id === poll.id) polls.set(k, null);
        notify();
    } catch (e: any) { api.showToast?.(e?.message || 'The poll could not be removed.', 'error'); }
}
