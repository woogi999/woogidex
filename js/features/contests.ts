// ==================== events & contests ====================
// Contest data and actions for the Community Hub's Events panel
// (js/app/components/EventsPanel.tsx renders it). Phases, deadlines and
// voting rules mirror the database's RLS, which is the real enforcement.

import { state, api } from '../core/app.ts';
import { confirmDialog } from '../core/confirm-dialog.ts';
import { notify } from '../app/store.ts';
import { openDialog } from '../app/dialogs.tsx';

export type Phase = 'draft' | 'submission' | 'voting' | 'results' | 'closed';

export interface Submission { id: string; contest_id: string; user_id: string; source_fakemon_id: string; fakemon_data: any; submitted_at: string; }
export interface ResultRow { submission_id: string; avg_competitive: number | string; avg_design: number | string; vote_count: number | string; total_voters?: number | string; }
export interface Contest {
    id: string; event_id: string; title: string; description?: string; rules?: string; phase: Phase;
    submission_deadline?: string; voting_start?: string; voting_deadline?: string; results_at?: string;
    max_submissions_per_user?: number; winner_criteria?: { top_n?: number; top_percent?: number; min_score_percent?: number } | null;
    submissions: Submission[];
    results?: ResultRow[] | 'loading' | 'error';
    totalVoters?: number;
    [extra: string]: any;
}
export interface ContestEvent { id: string; title: string; description?: string; starts_at?: string; ends_at?: string; contests: Contest[]; }

export interface Voting {
    contestId: string;
    order: string[];
    index: number;
    scores: Record<string, number>;
    remarks: Record<string, string>;
}

export const contests: {
    events: ContestEvent[];
    expanded: Set<string>;
    loaded: boolean;
    status: 'idle' | 'loading' | 'ready' | 'error';
    error: string;
    voting: Voting | null;
} = { events: [], expanded: new Set(), loaded: false, status: 'idle', error: '', voting: null };

export const fmtDate = (v?: string) => v ? new Date(v).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '-';
export const phaseLabel = (p?: string) => ({ draft: 'Draft', submission: 'Submission', voting: 'Voting', results: 'Results', closed: 'Closed' } as Record<string, string>)[p || ''] || p || 'Draft';
export const PHASE_STEPS: Phase[] = ['submission', 'voting', 'results'];

export function relTime(v?: string): string {
    if (!v) return '';
    const diff = new Date(v).getTime() - Date.now();
    const mins = Math.round(Math.abs(diff) / 60000);
    const unit = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
    return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

export function findContest(contestId: string): Contest | undefined {
    return contests.events.flatMap(e => e.contests || []).find(c => c.id === contestId);
}

// must never disagree with contests.phase in the DB, since RLS checks that
// column directly - dates only auto-advance FORWARD past a deadline, never
// fall back to a phase the admin already moved past.
export function effectivePhase(c: Contest): Phase {
    if (c.phase === 'draft' || c.phase === 'closed' || c.phase === 'results') return c.phase;
    const now = Date.now();
    if (c.phase === 'voting') {
        if (c.voting_deadline && now >= new Date(c.voting_deadline).getTime()) return 'results';
        return 'voting';
    }
    if (c.voting_start && now >= new Date(c.voting_start).getTime()) {
        if (c.voting_deadline && now >= new Date(c.voting_deadline).getTime()) return 'results';
        return 'voting';
    }
    if (c.submission_deadline && now >= new Date(c.submission_deadline).getTime()) return 'voting';
    return 'submission';
}

// mirrors server-side RLS: phase='voting' alone isn't enough - voting_start
// must have arrived and voting_deadline must not have passed
export function votingWindowOpen(c: Contest): boolean {
    const now = Date.now();
    if (c.voting_start && now < new Date(c.voting_start).getTime()) return false;
    if (c.voting_deadline && now > new Date(c.voting_deadline).getTime()) return false;
    return true;
}

export function eventIsLive(e: ContestEvent): boolean {
    return (e.contests || []).some(c => ['submission', 'voting'].includes(effectivePhase(c)));
}

/** The artwork a submission carries (a plain data-URI string). */
export function submissionImage(data: any): string { return data?.artwork || data?.image || data?.sprite || ''; }

// ==================== loading ====================

/** Loads every event with its contests and entries. The hub landing uses this too. */
export async function fetchEvents(): Promise<ContestEvent[]> {
    const client = await api.getClient();
    const [{ data: events, error }, { data: rows, error: ce }, { data: subs, error: se }] = await Promise.all([
        client.from('contest_events').select('*').order('starts_at', { ascending: false }),
        client.from('contests').select('*').order('created_at', { ascending: false }),
        client.from('contest_submissions').select('id, contest_id, user_id, source_fakemon_id, fakemon_data, submitted_at')
    ]);
    if (error) throw error;
    if (ce) throw ce;
    if (se) throw se;
    contests.events = (events || []).map((e: any) => ({
        ...e,
        contests: (rows || []).filter((c: any) => c.event_id === e.id).map((c: any) => ({ ...c, submissions: (subs || []).filter((s: any) => s.contest_id === c.id) }))
    }));
    contests.loaded = true;
    notify();
    return contests.events;
}

/** Contests open for entries or votes right now. */
export function getLiveContests(): Array<Contest & { eventTitle: string }> {
    return contests.events
        .flatMap(e => (e.contests || []).map(c => ({ ...c, eventTitle: e.title })))
        .filter(c => ['submission', 'voting'].includes(effectivePhase(c)));
}

export function getLoadedEvents() { return contests.events; }

/** (Re)loads the Events panel. */
export async function loadEventsView(): Promise<void> {
    contests.status = 'loading';
    notify();
    try {
        await fetchEvents();
        contests.status = 'ready';
        contests.error = '';
    } catch (e: any) {
        contests.status = 'error';
        contests.error = e?.message || String(e);
    }
    notify();
}

/** events is a panel of the hub; /events opens the hub on it. */
export async function openEvents() {
    await api.openCommunityHub?.({ panel: 'events' });
}

/** Switching to the panel: out of any vote in progress, and fresh data. */
export async function showEventsPanel() {
    closeContestVoting();
    await loadEventsView();
}

/** Painted before the first load, so a deep link shows skeletons. */
export function renderEventsSkeleton() {
    contests.status = 'loading';
    notify();
}

// ==================== details & results ====================

export function toggleContestDetails(id: string) {
    if (contests.expanded.has(id)) contests.expanded.delete(id); else contests.expanded.add(id);
    notify();
}

export function showContestResults(id: string) {
    contests.expanded.add(id);
    notify();
}

export async function loadContestResults(c: Contest) {
    if (c.results !== undefined && c.results !== 'error') return;
    c.results = 'loading';
    notify();
    try {
        const client = await api.getClient();
        const { data, error } = await client.rpc('get_contest_results', { p_contest_id: c.id });
        if (error) throw error;
        c.totalVoters = data?.[0] ? Number(data[0].total_voters) : 0;
        c.results = (data || []).slice().sort((a: ResultRow, b: ResultRow) =>
            (Number(b.avg_competitive) + Number(b.avg_design)) - (Number(a.avg_competitive) + Number(a.avg_design)));
    } catch {
        c.results = 'error';
    }
    notify();
}

export function describeWinnerCriteria(wc: Contest['winner_criteria']): string {
    const parts: string[] = [];
    if (wc?.top_n) parts.push(`top ${wc.top_n}`);
    if (wc?.top_percent) parts.push(`top ${wc.top_percent}%`);
    if (wc?.min_score_percent) parts.push(`≥${wc.min_score_percent}% of possible points`);
    return parts.length ? parts.join(', or ') : 'top 3';
}

// denominator uses the contest's total voter count, not this submission's own
// vote_count, so an entry only some voters rated scores lower than one
// everyone rated, even at the same average
export function submissionPointsPercent(r: ResultRow, totalVoters: number): number {
    const maxPossible = (totalVoters || 0) * 20;
    if (!maxPossible) return 0;
    return (Number(r.avg_competitive) + Number(r.avg_design)) * Number(r.vote_count) / maxPossible * 100;
}

export function computeWinners(rows: ResultRow[], wc: Contest['winner_criteria'], totalVoters: number): Set<string> {
    const winners = new Set<string>();
    if (wc?.top_n) rows.slice(0, wc.top_n).forEach(r => winners.add(r.submission_id));
    if (wc?.top_percent) rows.slice(0, Math.max(1, Math.ceil(rows.length * wc.top_percent / 100))).forEach(r => winners.add(r.submission_id));
    if (wc?.min_score_percent) rows.forEach(r => { if (submissionPointsPercent(r, totalVoters) >= wc.min_score_percent!) winners.add(r.submission_id); });
    if (!wc?.top_n && !wc?.top_percent && !wc?.min_score_percent) rows.slice(0, 3).forEach(r => winners.add(r.submission_id));
    return winners;
}

// ==================== entering ====================

export function openContestSignIn() {
    api.showToast?.('Sign in to join this contest.', 'info');
    api.openAuthModal?.('signin');
}

export function openContestMonPicker(contestId: string) {
    if (!state.user) return openContestSignIn();
    const c = findContest(contestId);
    if (!c) return;
    const maxSubs = c.max_submissions_per_user || 1;
    const mine = (c.submissions || []).filter(s => s.user_id === state.user!.id);
    if (mine.length >= maxSubs) return api.showToast?.(`You've already used all ${maxSubs} of your entries for this contest.`, 'info');
    openDialog('contest-picker', { contestId });
}

export async function submitContestEntry(contestId: string, mon: any) {
    if (!state.user) return api.showToast?.('Sign in first.', 'warning');
    if (!mon) return api.showToast?.('Choose a Fakemon first.', 'warning');
    const client = await api.getClient();
    const { error } = await client.from('contest_submissions').insert({ contest_id: contestId, user_id: state.user.id, source_fakemon_id: String(mon.id), fakemon_data: mon });
    if (error) return api.showToast?.(error.message, 'error');
    api.showToast?.('Contest entry submitted!', 'success');
    await loadEventsView();
}

export async function withdrawContestEntry(submissionId: string) {
    if (!await confirmDialog({ title: 'Withdraw this entry?', message: 'You can submit a different Fakémon in its place while submissions are still open.', confirmLabel: 'Withdraw' })) return;
    try {
        const client = await api.getClient();
        const { error } = await client.from('contest_submissions').delete().eq('id', submissionId);
        if (error) throw error;
        api.showToast?.('Entry withdrawn.', 'success');
        await loadEventsView();
    } catch (e: any) { api.showToast?.(e?.message || String(e), 'error'); }
}

// ==================== voting ====================

function shuffle<T>(items: T[]): T[] {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}

/** Entries the signed-in user may vote on: everyone's but their own. */
export function eligibleEntries(c: Contest | undefined): Submission[] {
    return (c?.submissions || []).filter(s => s.user_id !== state.user?.id);
}

export async function startContestVoting(contestId: string) {
    if (!state.user) return openContestSignIn();
    const contest = findContest(contestId);
    if (!contest) return;
    if (!votingWindowOpen(contest)) {
        return api.showToast?.(contest.voting_start && Date.now() < new Date(contest.voting_start).getTime() ? 'Voting hasn\'t opened yet.' : 'Voting has closed.', 'info');
    }
    const eligible = eligibleEntries(contest);
    if (!eligible.length) return api.showToast?.('There are no eligible entries to vote on.', 'info');
    try {
        const client = await api.getClient();
        const { data: session } = await client.from('contest_vote_sessions').select('id,submitted_at').eq('contest_id', contestId).eq('voter_id', state.user.id).maybeSingle();
        if (session?.submitted_at) return api.showToast?.('You have already submitted your votes for this contest.', 'info');
        const { data: existing, error } = await client.from('contest_votes').select('submission_id,competitive_score,design_score,remarks').eq('contest_id', contestId).eq('voter_id', state.user.id);
        if (error) throw error;
        // the order is random per voter, but stays put for this browser session
        const key = `contest-vote-order-${contestId}`;
        const stored: string[] | null = JSON.parse(sessionStorage.getItem(key) || 'null');
        const ids = eligible.map(s => s.id);
        const order = stored && stored.length === ids.length && stored.every(id => ids.includes(id)) ? stored : shuffle(ids);
        sessionStorage.setItem(key, JSON.stringify(order));
        contests.voting = {
            contestId, order, index: 0,
            scores: Object.fromEntries((existing || []).flatMap((v: any) => [[`${v.submission_id}:competitive`, v.competitive_score], [`${v.submission_id}:design`, v.design_score]])),
            remarks: Object.fromEntries((existing || []).map((v: any) => [v.submission_id, v.remarks || '']))
        };
        notify();
    } catch (e: any) { api.showToast?.(e?.message || String(e), 'error'); }
}

export function setContestVoteScore(kind: 'competitive' | 'design', value: number) {
    const v = contests.voting;
    if (!v) return;
    v.scores[`${v.order[v.index]}:${kind}`] = value;
    notify();
}

export function setContestVoteRemarks(value: string) {
    const v = contests.voting;
    if (v) v.remarks[v.order[v.index]] = value;
    notify();
}

export function jumpContestVote(index: number) {
    const v = contests.voting;
    if (!v) return;
    v.index = Math.max(0, Math.min(index, v.order.length - 1));
    notify();
}

export function voteComplete(v: Voting, id: string): boolean {
    return !!v.scores[`${id}:competitive`] && !!v.scores[`${id}:design`];
}

export function saveAndNextContestVote() {
    const v = contests.voting;
    if (!v) return;
    const id = v.order[v.index];
    if (!voteComplete(v, id)) return api.showToast?.('Give both scores from 1 to 10 before continuing.', 'warning');
    if (v.index < v.order.length - 1) { v.index++; notify(); }
    else api.showToast?.('This entry is complete. Submit your ballot when all entries are green.', 'success');
}

export async function submitContestBallot() {
    const v = contests.voting;
    if (!v || !state.user) return;
    const votes = eligibleEntries(findContest(v.contestId)).map(s => ({
        submission_id: s.id,
        competitive_score: v.scores[`${s.id}:competitive`],
        design_score: v.scores[`${s.id}:design`],
        remarks: v.remarks[s.id] || ''
    }));
    if (votes.some(x => !x.competitive_score || !x.design_score)) return api.showToast?.('Complete every entry before submitting.', 'warning');
    try {
        const client = await api.getClient();
        const { error } = await client.rpc('submit_contest_ballot', { p_contest_id: v.contestId, p_votes: votes });
        if (error) throw error;
        api.showToast?.('Your completed ballot has been submitted.', 'success');
        closeContestVoting();
        await loadEventsView();
    } catch (e: any) { api.showToast?.(e?.message || String(e), 'error'); }
}

export function closeContestVoting() {
    if (!contests.voting) return;
    contests.voting = null;
    notify();
}
