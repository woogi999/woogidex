// ==================== events ====================
// Community events of any kind (a poster competition, a mascot contest, a
// Fakémon contest, sign-ups): their own entry form, optional voting,
// organizers and the helpers they invite. Rendered by
// js/app/components/EventsPanel.tsx.
//
// Everything here is convenience; the database decides. Who may create, edit,
// see private answers, judge or read results is enforced by RLS and the
// functions in supabase/migrations/20261007000000_general_events.sql and
// 20261008000000_events_schedule_ballots.sql.

import { state, api } from '../core/app.ts';
import { routeUrl } from '../core/router.ts';
import { confirmDialog } from '../core/confirm-dialog.ts';
import { myIdentities } from './oauth.ts';
import { notify } from '../app/store.ts';

export type Phase = 'draft' | 'open' | 'voting' | 'ended';
export type FieldType = 'short' | 'long' | 'url' | 'email' | 'discord' | 'choice' | 'dropdown' | 'checkboxes' | 'number' | 'date' | 'scale'
    | 'image' | 'fakemon' | 'agree' | 'section';
export type Voting = 'none' | 'community' | 'judges' | 'ballot';
/** Where an event is right now; the dates move it along (see effectivePhase). */
export type Stage = 'draft' | 'upcoming' | 'open' | 'closed' | 'voting' | 'tallying' | 'ended';
export interface WinnerRules { top_n?: number; top_percent?: number; min_score_percent?: number; }
/** One line of the voting form: scored 1 to max. */
export interface Criterion { name: string; help?: string; max: number; }
export type Remarks = 'off' | 'optional' | 'required';

/** A question. 'section' is a page break: its label and help head the next page. min/max: number bounds, or a scale's top. */
export interface Field { id: string; type: FieldType; label: string; help?: string; required?: boolean; private?: boolean; options?: string[]; min?: number | null; max?: number | null; }
export interface EventRow {
    id: string; owner_id: string; title: string; tagline: string; description: string; category: string;
    accent: string; cover_image: string | null; phase: Phase;
    submissions_open_at: string | null; submissions_close_at: string | null;
    voting_open_at: string | null; voting_close_at: string | null; results_at: string | null;
    criteria: Criterion[]; voter_remarks: Remarks; winner_criteria: WinnerRules;
    form: Field[]; voting: Voting; votes_per_user: number; max_entries_per_user: number;
    live_results: boolean; show_entries: boolean; public_access: boolean; created_at: string; updated_at: string;
    /** questions voters answer about each entry, besides the scores */
    vote_form: Field[];
    /** the custom link, /events/<slug>; null uses the id */
    slug: string | null;
    /** what of an entry the voting form shows: which answers (null: all) and who sent it */
    vote_display: { fields: string[] | null; author: boolean };
}
export interface EventCode { id: string; event_id: string; code: string; max_entries: number; max_uses: number | null; uses: number; created_at: string; }
/** user_id is null for a guest's entry (public events) */
export interface Entry { id: string; event_id: string; user_id: string | null; answers: Record<string, any>; placement: number | null; created_at: string; }
export interface Helper { event_id: string; user_id: string; can_edit: boolean; can_entries: boolean; can_judge: boolean; can_results: boolean; }
export interface Result {
    entry_id: string; votes: number; score_total: number; score_avg: number;
    criteria_avg: Record<string, number | null>; total_voters: number; points_percent: number;
}
export interface Vote { entry_id: string; voter_id: string; score: number; scores: Record<string, number> | null; answers: Record<string, any> | null; remarks: string; created_at: string; }
export interface EntryLimit { event_id: string; user_id: string; max_entries: number; }
export interface Person { id: string; username?: string; display_name?: string; avatar_url?: string; }
export interface Perms { owner: boolean; view: boolean; edit: boolean; entries: boolean; judge: boolean; results: boolean; }
export interface Detail {
    id: string; status: 'loading' | 'ready' | 'error'; error: string;
    event: EventRow | null; entries: Entry[]; privateAnswers: Record<string, Record<string, any>>;
    myVotes: Record<string, Vote>; votes: Vote[]; ballots: Array<{ voter_id: string; submitted_at: string }>;
    limits: EntryLimit[]; results: Result[] | null; helpers: Helper[]; people: Record<string, Person>;
    /** the team's results announcement (markdown), once you may read it */
    resultsPost: string | null;
    /** what the feed's repost button acts on (signed in only) */
    share: any | null;
    /** entry codes (the team, with edit) */
    codes: EventCode[];
}

/** An event's page has tabs: what it is, entering it, voting, and the results. */
export type EventTab = 'about' | 'enter' | 'vote' | 'results';
export const EVENT_TABS: EventTab[] = ['about', 'enter', 'vote', 'results'];
export type View =
    | { kind: 'list' }
    | { kind: 'event'; id: string; tab?: EventTab }
    | { kind: 'dashboard'; id: string; tab?: DashTab }
    | { kind: 'new' };
export type DashTab = 'overview' | 'entries' | 'results' | 'team' | 'settings';

export const FIELD_TYPES: Array<[FieldType, string, string]> = [
    ['short', 'Short answer', 'pencil'],
    ['long', 'Paragraph', 'bars-3-bottom-left'],
    ['choice', 'Multiple choice', 'list-bullet'],
    ['checkboxes', 'Checkboxes', 'check-badge'],
    ['dropdown', 'Dropdown', 'chevron-up-down'],
    ['scale', 'Linear scale', 'adjustments-horizontal'],
    ['number', 'Number', 'hashtag'],
    ['date', 'Date', 'calendar'],
    ['image', 'Image upload', 'photo'],
    ['fakemon', 'Fakémon', 'sparkles'],
    ['url', 'Link', 'link'],
    ['email', 'Email', 'envelope'],
    ['discord', 'Discord username', 'chat-bubble-left-right'],
    ['agree', 'Checkbox to agree', 'check-circle'],
    ['section', 'Page break', 'document-duplicate']
];
/** What voters may be asked about an entry: nothing that uploads or collects personal details. */
export const VOTE_FIELD_TYPES: FieldType[] = ['short', 'long', 'choice', 'checkboxes', 'dropdown', 'scale', 'number', 'section'];
/** The voting form's display settings, with defaults for events saved before they existed. */
export const voteDisplay = (ev: Pick<EventRow, 'vote_display'>) => ({ fields: ev.vote_display?.fields ?? null, author: ev.vote_display?.author ?? true });
const OPTION_TYPES: FieldType[] = ['choice', 'dropdown', 'checkboxes'];
export const hasOptions = (t: FieldType) => OPTION_TYPES.includes(t);

/** The form split into pages at each page break; the first page has no heading of its own. */
export function formPages(form: Field[]): Array<{ head: Field | null; fields: Field[] }> {
    const pages: Array<{ head: Field | null; fields: Field[] }> = [{ head: null, fields: [] }];
    for (const f of form) {
        if (f.type === 'section') pages.push({ head: f, fields: [] });
        else pages[pages.length - 1].fields.push(f);
    }
    return pages.filter((p, i) => i === 0 ? p.fields.length || pages.length === 1 : true);
}

/** Whether a question has an answer (what "required" checks). */
export const answered = (v: any) => !(v == null || v === '' || v === false || (Array.isArray(v) && !v.length));
export const ALWAYS_PRIVATE: FieldType[] = ['email', 'discord'];
export const CATEGORIES = ['PoA contest', 'Fakémon contest', 'Art contest', 'Poster competition', 'Mascot contest', 'Writing contest', 'Tournament', 'Sign-ups', 'Community event'];
export const DEFAULT_CRITERIA: Criterion[] = [{ name: 'Competitive', max: 10 }, { name: 'Design', max: 10 }];

export const PHASES: Array<[Phase, string]> = [['draft', 'Draft'], ['open', 'Taking entries'], ['voting', 'Voting'], ['ended', 'Ended']];
export const STAGE_LABEL: Record<Stage, string> = { draft: 'Draft', upcoming: 'Opens soon', open: 'Taking entries', closed: 'Entries closed', voting: 'Voting', tallying: 'Results soon', ended: 'Ended' };

/** The voting form's criteria, whatever shape they were saved in. */
export const criteriaOf = (ev: Pick<EventRow, 'criteria'>): Criterion[] =>
    (ev.criteria?.length ? ev.criteria : DEFAULT_CRITERIA).map((c: any) => typeof c === 'string' ? { name: c, max: 10 } : { name: c.name, help: c.help || '', max: Number(c.max) || 10 });

// ---- state ----

export const events: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    error: string;
    list: EventRow[];
    helping: Helper[];
    view: View;
    detail: Detail | null;
    /** a ballot in progress (Fakémon-contest scoring); kept in sessionStorage until it's sent */
    ballot: null | { eventId: string; order: string[]; index: number; scores: Record<string, Record<string, number>>; remarks: Record<string, string>; answers: Record<string, Record<string, any>> };
} = { status: 'idle', error: '', list: [], helping: [], view: { kind: 'list' }, detail: null, ballot: null };

const client = () => api.getClient();
const me = () => state.user?.id || '';
const sitePerms = () => (state.user?.permissions || {}) as Record<string, boolean>;

export const canCreateEvents = () => !!(sitePerms().create_events || sitePerms().manage_events);

/** What the signed-in user may do on an event. UI only: the database checks again. */
export function permsFor(ev: EventRow | null | undefined, helpers: Helper[] = events.helping): Perms {
    const none = { owner: false, view: false, edit: false, entries: false, judge: false, results: false };
    if (!ev || !me()) return none;
    if (ev.owner_id === me() || sitePerms().manage_events) return { owner: true, view: true, edit: true, entries: true, judge: true, results: true };
    const h = helpers.find(x => x.event_id === ev.id && x.user_id === me());
    return h ? { owner: false, view: true, edit: h.can_edit, entries: h.can_entries, judge: h.can_judge, results: h.can_results } : none;
}

/** An event's address: its custom link if it has one. */
const eventPath = (ev: Pick<EventRow, 'id' | 'slug'>) => `events/${ev.slug || ev.id}`;
export const shareLink = (ev: Pick<EventRow, 'id' | 'slug'>) => routeUrl(eventPath(ev));
export const dashboardLink = (ev: Pick<EventRow, 'id' | 'slug'>) => routeUrl(`${eventPath(ev)}/dashboard`);
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
/** The loaded event a view key (id or custom link) names, if that's the one loaded. */
export const detailFor = (key: string) => {
    const d = events.detail;
    return d && (d.id === key || d.event?.id === key || (!!d.event?.slug && d.event.slug === key)) ? d : null;
};

export const isPast = (v: string | null) => !!v && Date.now() > new Date(v).getTime();

/**
 * Where an event is now. Mirrors public.event_phase() in the database, which
 * is what actually lets people enter or vote: the organizer's phase is a
 * floor, and dates only ever move it forward.
 */
export function effectivePhase(e: EventRow): Stage {
    const now = Date.now();
    const at = (v: string | null) => v ? new Date(v).getTime() : null;
    const vOpen = at(e.voting_open_at), vClose = at(e.voting_close_at), sOpen = at(e.submissions_open_at), sClose = at(e.submissions_close_at);
    const results = at(e.results_at);
    if (e.phase === 'draft' || e.phase === 'ended') return e.phase;
    if (e.voting !== 'none' && vClose !== null && now > vClose) return results !== null && now < results ? 'tallying' : 'ended';
    if (e.voting !== 'none' && (e.phase === 'voting' || (vOpen !== null && now >= vOpen))) return vOpen !== null && now < vOpen ? 'closed' : 'voting';
    if (sOpen !== null && now < sOpen) return 'upcoming';
    if (e.phase === 'voting') return 'closed';
    if (sClose !== null && now > sClose) {
        if (e.voting !== 'none') return vOpen === null ? 'voting' : 'closed';
        return results !== null && now >= results ? 'ended' : 'closed';
    }
    return 'open';
}
export const takingEntries = (e: EventRow) => effectivePhase(e) === 'open';
export const votingOpen = (e: EventRow) => e.voting !== 'none' && effectivePhase(e) === 'voting';
export const isLive = (e: EventRow) => takingEntries(e) || votingOpen(e);

/** How many entries this user may send: the event's default, or what the organizers gave them. */
export function entryAllowance(ev: EventRow, limits: EntryLimit[] = events.detail?.limits || []): number {
    return limits.find(l => l.event_id === ev.id && l.user_id === me())?.max_entries ?? ev.max_entries_per_user;
}

export const fmtDate = (v?: string | null) => v ? new Date(v).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
export function relTime(v?: string | null): string {
    if (!v) return '';
    const diff = new Date(v).getTime() - Date.now();
    const mins = Math.round(Math.abs(diff) / 60000);
    const unit = mins < 60 ? `${mins} min` : mins < 1440 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} d`;
    return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

// ---- entries: how one is shown ----

/** The entry's name: its first short answer, its Fakémon's name, or whose it is. */
export function entryTitle(ev: EventRow, en: Entry, people: Record<string, Person> = {}): string {
    for (const f of ev.form) {
        const v = en.answers[f.id];
        if (f.type === 'short' && typeof v === 'string' && v) return v;
        if (f.type === 'fakemon' && v?.name) return v.name;
    }
    const p = people[en.user_id || ""];
    return p ? `Entry by ${p.display_name || p.username}` : 'Entry';
}

/** The entry's picture: its first image answer or Fakémon artwork. */
export function entryImage(ev: EventRow, en: Entry): string {
    for (const f of ev.form) {
        const v = en.answers[f.id];
        if (f.type === 'image' && typeof v === 'string' && v.startsWith('data:image/')) return v;
        if (f.type === 'fakemon' && typeof v?.artwork === 'string' && v.artwork.startsWith('data:image/')) return v.artwork;
    }
    return '';
}

/** Results joined to entries, best first. Organizer placements outrank the tally. */
export function ranked(ev: EventRow, entries: Entry[], results: Result[] | null) {
    const byId = new Map((results || []).map(r => [r.entry_id, r]));
    const rows = entries.map(en => ({ entry: en, result: byId.get(en.id) || null }));
    const score = (r: Result | null) => ev.voting === 'community' ? Number(r?.votes || 0) : Number(r?.points_percent || 0);
    return rows.sort((a, b) =>
        (a.entry.placement ?? 999) - (b.entry.placement ?? 999)
        || score(b.result) - score(a.result)
        || Number(b.result?.votes || 0) - Number(a.result?.votes || 0)
        || a.entry.created_at.localeCompare(b.entry.created_at));
}

export function describeWinnerRules(wc: WinnerRules = {}): string {
    const parts: string[] = [];
    if (wc.top_n) parts.push(`the top ${wc.top_n}`);
    if (wc.top_percent) parts.push(`the top ${wc.top_percent}%`);
    if (wc.min_score_percent) parts.push(`anyone with at least ${wc.min_score_percent}% of the possible points`);
    return parts.length ? parts.join(', or ') : 'the top 3';
}

/**
 * Who wins: organizer placements always, plus every entry that meets any of
 * the winner rules (top N, top %, at least X% of the possible points), the
 * same rules the old Fakémon contests had. Takes ranked() rows, best first.
 */
export function computeWinners(ev: EventRow, rows: ReturnType<typeof ranked>): Set<string> {
    const winners = new Set(rows.filter(r => r.entry.placement).map(r => r.entry.id));
    const scored = rows.filter(r => r.result && Number(r.result.votes) > 0);
    if (ev.voting === 'none' || !scored.length) return winners;
    const wc = ev.winner_criteria || {};
    const topN = !wc.top_n && !wc.top_percent && !wc.min_score_percent ? 3 : wc.top_n || 0;
    if (topN) scored.slice(0, topN).forEach(r => winners.add(r.entry.id));
    if (wc.top_percent) scored.slice(0, Math.max(1, Math.ceil(scored.length * wc.top_percent / 100))).forEach(r => winners.add(r.entry.id));
    if (wc.min_score_percent) scored.forEach(r => { if (Number(r.result!.points_percent) >= wc.min_score_percent!) winners.add(r.entry.id); });
    return winners;
}

// ---- loading ----

async function fetchPeople(ids: string[]): Promise<Record<string, Person>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return {};
    const { data } = await (await client()).from('profiles').select('id,username,display_name,avatar_url').in('id', unique);
    return Object.fromEntries((data || []).map((p: Person) => [p.id, p]));
}

/** Every event this user can see (public ones, plus their own drafts), and their helper roles. */
export async function fetchEvents(): Promise<EventRow[]> {
    const c = await client();
    const [{ data, error }, helping] = await Promise.all([
        c.from('events').select('*').order('created_at', { ascending: false }).limit(100),
        me() ? c.from('event_helpers').select('*').eq('user_id', me()) : Promise.resolve({ data: [] })
    ]);
    if (error) throw error;
    events.list = data || [];
    events.helping = (helping as any).data || [];
    notify();
    return events.list;
}

export async function loadEventsList() {
    events.status = 'loading';
    notify();
    try {
        await fetchEvents();
        events.status = 'ready';
        events.error = '';
    } catch (e: any) {
        events.status = 'error';
        events.error = e?.message || String(e);
    }
    notify();
}

/** One event with its entries, votes, results (when you may see them), and its team. */
export async function loadEvent(key: string) {
    const keep = detailFor(key);
    let id = keep?.event?.id || key;
    events.detail = {
        id, status: keep?.event ? 'ready' : 'loading', error: '', event: keep?.event || null, entries: keep?.entries || [],
        privateAnswers: keep?.privateAnswers || {}, myVotes: keep?.myVotes || {}, votes: keep?.votes || [], ballots: keep?.ballots || [],
        limits: keep?.limits || [], results: keep?.results || null, helpers: keep?.helpers || [], people: keep?.people || {},
        resultsPost: keep?.resultsPost ?? null, share: keep?.share || null, codes: keep?.codes || []
    };
    notify();
    const d = events.detail;
    try {
        const c = await client();
        const { data: ev, error } = await c.from('events').select('*').eq(isUuid(id) ? 'id' : 'slug', id.toLowerCase()).maybeSingle();
        if (error) throw error;
        if (!ev) throw new Error('This event does not exist, or it has not been published yet.');
        d.id = ev.id;
        id = ev.id;
        const none = Promise.resolve({ data: [] });
        // votes, ballots, private answers: your own, or everyone's where the team may see them (RLS decides)
        const [entries, helpers, votes, priv, results, ballots, limits, post, share, codes] = await Promise.all([
            c.from('event_entries').select('*').eq('event_id', id).order('created_at', { ascending: true }),
            me() ? c.from('event_helpers').select('*').eq('event_id', id) : none,
            me() ? c.from('event_votes').select('entry_id,voter_id,score,scores,answers,remarks,created_at').eq('event_id', id) : none,
            me() ? c.from('event_entry_private').select('entry_id,answers').eq('event_id', id) : none,
            // refused (not an error worth showing) until results are public or you're on the team
            c.rpc('get_event_results', { p_event: id }).then((r: any) => r.error ? null : r.data),
            me() ? c.from('event_ballots').select('voter_id,submitted_at').eq('event_id', id) : none,
            me() ? c.from('event_entry_limits').select('*').eq('event_id', id) : none,
            // hidden by RLS until the results are out, unless you're on the team
            c.from('event_results_posts').select('body').eq('event_id', id).maybeSingle(),
            me() && ev.phase !== 'draft' ? c.rpc('repost_embed', { p_kind: 'event', p_id: id }) : Promise.resolve({ data: null }),
            // RLS: only the team members who can edit see codes
            me() ? c.from('event_codes').select('*').eq('event_id', id).order('created_at', { ascending: true }) : none
        ]);
        if (entries.error) throw entries.error;
        d.event = ev;
        d.entries = entries.data || [];
        d.helpers = (helpers as any).data || [];
        d.votes = (votes as any).data || [];
        d.myVotes = Object.fromEntries(d.votes.filter(v => v.voter_id === me()).map(v => [v.entry_id, v]));
        d.privateAnswers = Object.fromEntries(((priv as any).data || []).map((p: any) => [p.entry_id, p.answers]));
        d.results = results;
        d.ballots = (ballots as any).data || [];
        d.limits = (limits as any).data || [];
        d.resultsPost = (post as any).data?.body ?? null;
        d.share = (share as any).data || null;
        d.codes = (codes as any).data || [];
        // profiles are for signed-in readers only; a guest sees no names
        if (me()) d.people = await fetchPeople([ev.owner_id, ...d.entries.map(e => e.user_id), ...d.helpers.map(h => h.user_id),
            ...d.limits.map(l => l.user_id), ...d.votes.map(v => v.voter_id)]);
        // a helper row for this event also counts toward the list's permissions
        events.helping = [...events.helping.filter(h => h.event_id !== id), ...d.helpers.filter(h => h.user_id === me())];
        d.status = 'ready';
        api.setShareMeta?.({ title: ev.title, description: ev.tagline || ev.description?.slice(0, 160) || '' });
    } catch (e: any) {
        d.status = 'error';
        d.error = e?.message || String(e);
    }
    notify();
}

// ---- navigation ----
// /events                  the list (the hub's Events panel)
// /events/new              create one
// /events/<id>             the event page: the shareable link for entrants
// /events/<id>/dashboard   organizers and helpers: entries, results, team, settings

function routeFor(v: View): [string, string] {
    if (v.kind === 'new') return ['events/new', 'New event'];
    // a loaded event's custom link wins over whatever key opened it
    const key = v.kind === 'event' || v.kind === 'dashboard' ? (detailFor(v.id)?.event?.slug || v.id) : '';
    if (v.kind === 'event') return [`events/${key}${v.tab && v.tab !== 'about' ? `/${v.tab}` : ''}`, 'Event'];
    if (v.kind === 'dashboard') return [`events/${key}/dashboard`, 'Event dashboard'];
    return ['events', 'Events'];
}

export function showEventView(v: View, { route = true } = {}) {
    events.view = v;
    events.ballot = null;
    if (route) {
        const [path, title] = routeFor(v);
        api.setRoute?.(path, title);
    }
    if (v.kind === 'list') loadEventsList();
    else if (v.kind !== 'new') loadEvent(v.id);
    notify();
    window.scrollTo({ top: 0 });
}

function viewFromParam(param = ''): View {
    const [id, sub] = param.split('/');
    if (!id) return { kind: 'list' };
    if (id === 'new') return { kind: 'new' };
    if (!isUuid(id) && !SLUG_PATTERN.test(id.toLowerCase())) return { kind: 'list' };
    if (sub === 'dashboard') return { kind: 'dashboard', id };
    return { kind: 'event', id, tab: (EVENT_TABS as string[]).includes(sub) ? sub as EventTab : 'about' };
}

/** /events[/...]: the hub, on the Events panel, at whatever the address names. */
export async function openEvents(param = '') {
    const view = viewFromParam(param);
    // a shared link opened without an account: the event alone, like a form
    // (it shows only if the organizer made the event public)
    if (!state.user && view.kind === 'event') return openGuestEvent(view.id, view.tab);
    if (!api.requireAccount?.('Sign in to see events.', () => openEvents(param))) return;
    events.view = view;
    await api.openCommunityHub?.({ panel: 'events' });
    // the hub just set its own address; put the event's back
    const [path, title] = routeFor(view);
    api.replaceRoute?.(path);
    api.setPageTitle?.(title);
}

/**
 * The guest view: the hub's page with the header and the hub's sidebar
 * hidden (body.event-guest, css/events.css), so a public event reads as a
 * standalone page. Any other page clears it (activateTopLevelView).
 */
function openGuestEvent(id: string, tab: EventTab = 'about') {
    events.view = { kind: 'event', id, tab };
    api.activateTopLevelView?.('community-view');
    api.showCommunityPanel?.('events');
    document.body.classList.add('event-guest');
}

export const isGuestView = () => !state.user && document.body.classList.contains('event-guest');

/** The hub calls this whenever the Events panel is shown. */
export async function showEventsPanel() {
    const v = events.view;
    if (v.kind === 'list') await loadEventsList();
    else if (v.kind !== 'new') await loadEvent(v.id);
}

/** Painted before the first load, so a deep link shows skeletons. */
export function renderEventsSkeleton() {
    events.status = 'loading';
    notify();
}

/** Events taking entries or votes now, for the feed's rail. */
export function getLiveEvents(): EventRow[] {
    return events.list.filter(isLive);
}

// ---- organizer actions ----

const toast = (m: string, t = 'info') => api.showToast?.(m, t);
const fail = (e: any) => toast(e?.code === '23505' && /slug/.test(e?.message || '') ? 'That link is taken. Try another.' : e?.message || String(e), 'error');
const usernamePattern = (name: string) => name.replace(/[%_\\]/g, '\\$&');

export async function copyLink(url: string, what = 'Link') {
    try { await navigator.clipboard.writeText(url); toast(`${what} copied.`, 'success'); }
    catch { window.prompt('Copy this link:', url); }
}

export async function createEvent(row: Partial<EventRow>): Promise<string | null> {
    try {
        const { data, error } = await (await client()).from('events').insert({ ...row, owner_id: me() }).select('id').single();
        if (error) throw error;
        toast('Event created. It is a draft until you open it.', 'success');
        showEventView({ kind: 'dashboard', id: data.id, tab: 'overview' });
        return data.id;
    } catch (e) { fail(e); return null; }
}

export async function saveEvent(id: string, patch: Partial<EventRow>, message = 'Saved.'): Promise<boolean> {
    try {
        const { data, error } = await (await client()).from('events').update(patch).eq('id', id).select('*');
        if (error) throw error;
        if (!data?.length) throw new Error('You do not have permission to edit this event.');
        if (events.detail?.id === id) events.detail.event = data[0];
        toast(message, 'success');
        notify();
        return true;
    } catch (e) { fail(e); return false; }
}

/** Moves an event by hand, now. Dates that would contradict it are cleared, or they'd move it straight back. */
export function setPhase(ev: EventRow, phase: Phase) {
    const msg: Record<Phase, string> = { draft: 'Back to draft.', open: 'Entries are open.', voting: 'Voting is open.', ended: 'Event ended. Results are public.' };
    const patch: Partial<EventRow> = { phase };
    const future = (v: string | null) => !!v && !isPast(v);
    if (phase === 'open') {
        if (future(ev.submissions_open_at)) patch.submissions_open_at = null;
        if (isPast(ev.submissions_close_at)) patch.submissions_close_at = null;
        if (isPast(ev.voting_open_at)) patch.voting_open_at = null;
    }
    if (phase === 'voting') {
        if (future(ev.voting_open_at)) patch.voting_open_at = null;
        if (isPast(ev.voting_close_at)) patch.voting_close_at = null;
    }
    if (phase === 'ended' && future(ev.results_at)) patch.results_at = null;
    if (phase !== 'ended' && isPast(ev.results_at)) patch.results_at = null;
    return saveEvent(ev.id, patch, msg[phase]);
}

export async function deleteEvent(ev: EventRow) {
    if (!await confirmDialog({ title: `Delete ${ev.title}?`, message: 'Every entry, vote and team member goes with it. This cannot be undone.', confirmLabel: 'Delete event', danger: true })) return;
    try {
        const { data, error } = await (await client()).from('events').delete().eq('id', ev.id).select('id');
        if (error) throw error;
        if (!data?.length) throw new Error('Only the organizer can delete this event.');
        clearEventDraft(ev.id);
        toast('Event deleted.', 'success');
        showEventView({ kind: 'list' });
    } catch (e) { fail(e); }
}

export async function removeEntry(en: Entry, own: boolean) {
    const ok = await confirmDialog(own
        ? { title: 'Withdraw your entry?', message: 'You can enter again while entries are open.', confirmLabel: 'Withdraw' }
        : { title: 'Remove this entry?', message: 'It and its votes are deleted for good.', confirmLabel: 'Remove entry', danger: true });
    if (!ok) return;
    try {
        const { data, error } = await (await client()).from('event_entries').delete().eq('id', en.id).select('id');
        if (error) throw error;
        if (!data?.length) throw new Error(own ? 'Entries can only be withdrawn while the event is taking them.' : 'You do not have permission to remove entries.');
        toast(own ? 'Entry withdrawn.' : 'Entry removed.', 'success');
        await loadEvent(en.event_id);
    } catch (e) { fail(e); }
}

export async function setPlacement(en: Entry, placement: number | null) {
    try {
        const { data, error } = await (await client()).from('event_entries').update({ placement }).eq('id', en.id).select('id');
        if (error) throw error;
        if (!data?.length) throw new Error('You do not have permission to pick winners.');
        en.placement = placement;
        notify();
    } catch (e) { fail(e); }
}

export async function addHelper(eventId: string, username: string, perms: Omit<Helper, 'event_id' | 'user_id'>): Promise<boolean> {
    const name = username.trim().replace(/^@/, '');
    if (!name) return false;
    try {
        const c = await client();
        const { data: person } = await c.from('profiles').select('id,username').ilike('username', usernamePattern(name)).maybeSingle();
        if (!person) throw new Error(`No one is called @${name}.`);
        const { error } = await c.from('event_helpers').insert({ event_id: eventId, user_id: person.id, ...perms });
        if (error) throw error.code === '23505' ? new Error(`@${person.username} is already on the team.`) : error;
        toast(`@${person.username} joined the team.`, 'success');
        await loadEvent(eventId);
        return true;
    } catch (e) { fail(e); return false; }
}

export async function updateHelper(h: Helper, patch: Partial<Helper>) {
    try {
        const { data, error } = await (await client()).from('event_helpers').update(patch).eq('event_id', h.event_id).eq('user_id', h.user_id).select('*');
        if (error) throw error;
        if (!data?.length) throw new Error('Only the organizer can change the team.');
        Object.assign(h, data[0]);
        notify();
    } catch (e) { fail(e); }
}

export async function removeHelper(h: Helper, self = false) {
    if (!await confirmDialog({ title: self ? 'Leave this event\'s team?' : 'Remove from the team?', message: self ? 'You lose access to its dashboard.' : 'They lose access to this event\'s dashboard.', confirmLabel: self ? 'Leave' : 'Remove', danger: true })) return;
    try {
        const { error } = await (await client()).from('event_helpers').delete().eq('event_id', h.event_id).eq('user_id', h.user_id);
        if (error) throw error;
        if (self) showEventView({ kind: 'event', id: h.event_id });
        else await loadEvent(h.event_id);
    } catch (e) { fail(e); }
}

// ---- more entries for specific people ----

export async function setEntryLimit(eventId: string, username: string, max: number): Promise<boolean> {
    const name = username.trim().replace(/^@/, '');
    if (!name) return false;
    const n = Math.min(100, Math.max(1, Math.round(max) || 1));
    try {
        const c = await client();
        const { data: person } = await c.from('profiles').select('id,username').ilike('username', usernamePattern(name)).maybeSingle();
        if (!person) throw new Error(`No one is called @${name}.`);
        const { error } = await c.from('event_entry_limits').upsert({ event_id: eventId, user_id: person.id, max_entries: n });
        if (error) throw error;
        toast(`@${person.username} can now send ${n} ${n === 1 ? 'entry' : 'entries'}.`, 'success');
        await loadEvent(eventId);
        return true;
    } catch (e) { fail(e); return false; }
}

export async function removeEntryLimit(l: EntryLimit) {
    try {
        const { error } = await (await client()).from('event_entry_limits').delete().eq('event_id', l.event_id).eq('user_id', l.user_id);
        if (error) throw error;
        await loadEvent(l.event_id);
    } catch (e) { fail(e); }
}

// ---- entry codes ----

/** A code that's easy to read out: no 0/O or 1/I. */
export function randomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, b => chars[b % chars.length]).join('').replace(/^(.{4})/, '$1-');
}

export async function createEventCode(eventId: string, code: string, maxEntries: number, maxUses: number | null): Promise<boolean> {
    try {
        const { error } = await (await client()).from('event_codes').insert({ event_id: eventId, code: code.trim(), max_entries: maxEntries, max_uses: maxUses });
        if (error) throw error.code === '23505' ? new Error('That code already exists for this event.') : error;
        toast('Code created.', 'success');
        await loadEvent(eventId);
        return true;
    } catch (e) { fail(e); return false; }
}

export async function deleteEventCode(code: EventCode) {
    if (!await confirmDialog({ title: `Delete ${code.code}?`, message: 'Nobody can redeem it after this. People who already did keep their extra entries.', confirmLabel: 'Delete code', danger: true })) return;
    try {
        const { error } = await (await client()).from('event_codes').delete().eq('id', code.id);
        if (error) throw error;
        await loadEvent(code.event_id);
    } catch (e) { fail(e); }
}

/** Redeems a code the organizer gave you: your entry limit becomes what it allows. */
export async function redeemEventCode(eventId: string, code: string): Promise<boolean> {
    if (!state.user) { api.requireAccount?.('Sign in to use a code.'); return false; }
    try {
        const { data, error } = await (await client()).rpc('redeem_event_code', { p_event: eventId, p_code: code });
        if (error) throw error;
        toast(`Code accepted. You can send ${data} ${data === 1 ? 'entry' : 'entries'}.`, 'success');
        await loadEvent(eventId);
        return true;
    } catch (e) { fail(e); return false; }
}

// ---- entrant actions ----

/**
 * Sends an entry. A guest (public events) goes through the submit-event-guest
 * edge function with their Turnstile token; members call the database directly.
 */
export async function submitEntry(eventId: string, answers: Record<string, any>, turnstileToken = ''): Promise<boolean> {
    const ev = detailFor(eventId)?.event;
    if (!state.user && !ev?.public_access) { api.requireAccount?.('Sign in to enter.'); return false; }
    try {
        const c = await client();
        if (state.user) {
            const { error } = await c.rpc('submit_event_entry', { p_event: eventId, p_answers: answers });
            if (error) throw error;
        } else {
            if (!turnstileToken) throw new Error('Complete the anti-spam check first.');
            const { data, error } = await c.functions.invoke('submit-event-guest', { body: { event_id: eventId, answers, token: turnstileToken } });
            if (error) throw new Error(((await error.context?.json?.().catch(() => null)) as any)?.error || 'Your response could not be sent.');
            if (!data?.ok) throw new Error(data?.error || 'Your response could not be sent.');
        }
        toast(state.user ? 'You\'re in! Your entry was submitted.' : 'Thanks! Your response was recorded.', 'success');
        await loadEvent(eventId);
        return true;
    } catch (e) { fail(e); return false; }
}

/** The team's results announcement. Readers see it once the results are out. */
export async function saveResultsPost(eventId: string, body: string): Promise<boolean> {
    try {
        const { error } = await (await client()).from('event_results_posts').upsert({ event_id: eventId, body: body.trim() });
        if (error) throw error;
        if (events.detail?.id === eventId) events.detail.resultsPost = body.trim();
        toast('Results post saved.', 'success');
        notify();
        return true;
    } catch (e) { fail(e); return false; }
}

/** The standings as markdown, to start a results post from. */
export function standingsMarkdown(ev: EventRow, d: Detail): string {
    const rows = ranked(ev, d.entries, d.results);
    const winners = computeWinners(ev, rows);
    const medal = (i: number) => ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    const lines = rows.filter(r => winners.has(r.entry.id)).map((r, i) => {
        const p = d.people[r.entry.user_id || ''];
        const by = p ? ` by @${p.username}` : '';
        const score = r.result ? (ev.voting === 'community' ? ` (${r.result.votes} votes)` : ` (${Number(r.result.points_percent).toFixed(1)}%)`) : '';
        return `${medal(i)} **${entryTitle(ev, r.entry, d.people)}**${by}${score}`;
    });
    return [`## Winners of ${ev.title}`, '', ...(lines.length ? lines : ['_No winners yet._']), '', 'Thanks to everyone who took part!'].join('\n');
}

/** Repost or share the event in the feed: the same buttons a post has. */
export async function toggleEventRepost() {
    const d = events.detail;
    if (!d?.share) return;
    if (await api.toggleRepost?.(d.share)) await loadEvent(d.id);
}

/** A community vote (score 1), a judge's criteria scores, or nothing to take yours back. */
export async function castVote(en: Entry, score: number | null, scores: Record<string, number> | null = null, remarks = '', answers: Record<string, any> | null = null): Promise<boolean> {
    if (!state.user) { api.requireAccount?.('Sign in to vote.'); return false; }
    try {
        const { error } = await (await client()).rpc('cast_event_vote', { p_entry: en.id, p_score: score, p_scores: scores, p_remarks: remarks, p_answers: answers });
        if (error) throw error;
        await loadEvent(en.event_id);
        return true;
    } catch (e) { fail(e); return false; }
}

// ---- the full ballot (the Fakémon-contest way) ----
// Every entry but yours, in an order shuffled per voter, each scored 1-10 on
// every criterion, then sent in one go. Progress survives a reload.

const ballotKey = (eventId: string) => `woogidex.eventBallot.${me()}.${eventId}`;

function shuffle<T>(items: T[]): T[] {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}

export const ballotEntries = (ev: EventRow, entries: Entry[]) => entries.filter(e => e.event_id === ev.id && e.user_id !== me());
export const hasSubmittedBallot = (d: Detail | null = events.detail) => !!d?.ballots.some(b => b.voter_id === me());
export const scoresComplete = (ev: EventRow, scores: Record<string, number> = {}) => criteriaOf(ev).every(c => scores[c.name] >= 1 && scores[c.name] <= c.max);
export const remarksOk = (ev: EventRow, remarks = '') => ev.voter_remarks !== 'required' || !!remarks.trim();
/** The voter's own questions: every required one answered. */
export const voteAnswersOk = (ev: EventRow, answers: Record<string, any> = {}) => (ev.vote_form || []).every(f => !f.required || answered(answers[f.id]));

export function startBallot(ev: EventRow) {
    const d = events.detail;
    if (!d) return;
    if (!state.user) { api.requireAccount?.('Sign in to vote.'); return; }
    const ids = ballotEntries(ev, d.entries).map(e => e.id);
    if (!ids.length) { toast('There are no entries for you to vote on.'); return; }
    let saved: any = null;
    try { saved = JSON.parse(sessionStorage.getItem(ballotKey(ev.id)) || 'null'); } catch { /* private mode */ }
    const sameEntries = saved?.order?.length === ids.length && saved.order.every((id: string) => ids.includes(id));
    events.ballot = sameEntries ? { answers: {}, ...saved, eventId: ev.id } : { eventId: ev.id, order: shuffle(ids), index: 0, scores: {}, remarks: {}, answers: {} };
    notify();
    window.scrollTo({ top: 0 });
}

export function updateBallot(patch: Partial<NonNullable<typeof events.ballot>>) {
    const b = events.ballot;
    if (!b) return;
    Object.assign(b, patch);
    try { sessionStorage.setItem(ballotKey(b.eventId), JSON.stringify(b)); } catch { /* private mode */ }
    notify();
}

export function closeBallot() { events.ballot = null; notify(); }

export async function submitBallot(ev: EventRow) {
    const b = events.ballot;
    if (!b) return;
    if (b.order.some(id => !scoresComplete(ev, b.scores[id]))) { toast('Score every entry on every criterion first.', 'warning'); return; }
    if (b.order.some(id => !remarksOk(ev, b.remarks[id]))) { toast('This event needs remarks on every entry.', 'warning'); return; }
    if (b.order.some(id => !voteAnswersOk(ev, b.answers[id]))) { toast('Answer the required questions on every entry.', 'warning'); return; }
    try {
        const votes = b.order.map(id => ({ entry_id: id, scores: b.scores[id], remarks: b.remarks[id] || '', answers: b.answers[id] || {} }));
        const { error } = await (await client()).rpc('submit_event_ballot', { p_event: ev.id, p_votes: votes });
        if (error) throw error;
        try { sessionStorage.removeItem(ballotKey(ev.id)); } catch { /* private mode */ }
        events.ballot = null;
        toast('Your ballot is in. Thanks for voting!', 'success');
        await loadEvent(ev.id);
    } catch (e) { fail(e); }
}

/** Every vote with its scores and remarks, by voter, as a JSON download (the team's copy). */
export function exportVotesJson() {
    const d = events.detail;
    if (!d?.event) return;
    const byVoter: Record<string, Vote[]> = {};
    d.votes.forEach(v => (byVoter[v.voter_id] ??= []).push(v));
    const payload = {
        event_id: d.event.id, event_title: d.event.title, criteria: criteriaOf(d.event), exported_at: new Date().toISOString(),
        voters: Object.entries(byVoter).map(([id, votes]) => ({
            voter_id: id, username: d.people[id]?.username || null,
            submitted_at: d.ballots.find(b => b.voter_id === id)?.submitted_at || null,
            responses: votes.map(v => ({ entry_id: v.entry_id, entry: entryTitle(d.event!, d.entries.find(e => e.id === v.entry_id) || { answers: {} } as Entry, d.people), scores: v.scores, total: v.score, answers: v.answers, remarks: v.remarks }))
        }))
    };
    download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${fileSlug(d.event.title)}-votes.json`);
}

// ---- answers we already know ----

/** Their email, and their Discord name if Discord is connected. */
export async function autofillFor(form: Field[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const user = state.user;
    if (!user) return out;
    let discord = '';
    if (form.some(f => f.type === 'discord')) {
        const ids = await myIdentities().catch(() => []);
        const d: any = ids.find((i: any) => i.provider === 'discord')?.identity_data || {};
        discord = String(d.full_name || d.name || d.user_name || d.preferred_username || '').replace(/#0$/, '');
    }
    for (const f of form) {
        if (f.type === 'email' && user.hasRealEmail) out[f.id] = user.email || '';
        if (f.type === 'discord' && discord) out[f.id] = discord;
    }
    return out;
}

// ---- images and Fakémon ----

/**
 * A picture as a data URI small enough for the database's caps: scaled to
 * fit maxPx, re-encoded as WebP, quality stepped down until it fits.
 */
export async function shrinkImage(src: Blob | string, maxPx: number, maxChars: number): Promise<string> {
    const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src;
    if (!blob.type.startsWith('image/')) throw new Error('That file is not an image.');
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    for (const q of [0.9, 0.8, 0.7, 0.55, 0.4]) {
        const uri = canvas.toDataURL('image/webp', q);
        if (uri.length <= maxChars) return uri.startsWith('data:image/webp') ? uri : canvas.toDataURL('image/jpeg', q);
    }
    throw new Error('That image is too large, even after shrinking it.');
}

const ART_MAX = 1_400_000;

/**
 * A Fakémon ready to go in an entry: the whole thing (stats, abilities,
 * moves, so it can be judged competitively), its pictures shrunk to fit, its
 * collection bookkeeping dropped. It is stored in the entry only: not a
 * community upload, not a cloud save, so neither limit counts it.
 */
export async function fakemonForEntry(mon: any): Promise<any> {
    const copy = JSON.parse(JSON.stringify(mon));
    for (const k of ['id', 'createdAt', 'updatedAt', 'regionIds', 'folderId', 'pinned', 'pendingVanilla']) delete copy[k];
    for (const k of ['artwork', 'shinyArtwork']) {
        if (typeof copy[k] === 'string' && copy[k].startsWith('data:image/')) copy[k] = await shrinkImage(copy[k], 1200, ART_MAX).catch(() => '');
        else delete copy[k];
        if (!copy[k]) delete copy[k];
    }
    if (typeof copy.cry === 'string' && (!copy.cry.startsWith('data:audio/') || copy.cry.length > 400_000)) delete copy.cry;
    if (JSON.stringify(copy).length > 2_400_000) throw new Error('That Fakémon is too large to enter. Try one with smaller artwork.');
    return copy;
}

/** The Fakémon in a Woogidex export (one Fakémon, a list, or a whole collection backup) or a plain-text export. */
export async function fakemonFromFile(file: File): Promise<any[]> {
    const text = await file.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = api.parsePlainTextFakemon?.(text); }
    const list = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed?.fakemons) ? parsed.fakemons
        : Array.isArray(parsed?.fakemonDB) ? parsed.fakemonDB
        : Array.isArray(parsed?.collection) ? parsed.collection
        : parsed?.fakemon ? [parsed.fakemon] : [parsed];
    const mons = list.filter((m: any) => m && typeof m === 'object' && m.name);
    if (!mons.length) throw new Error('No Fakémon found in that file. Use a Woogidex export (.json or .txt).');
    return mons;
}

/**
 * Loads a Fakémon into the (hidden) editor so the Pokédex board can draw it,
 * the way the Community Hub's pages do. Flagged as a preview, so nothing is
 * ever saved into the viewer's collection.
 */
export function previewEventFakemon(mon: any) {
    if (state.autoSaveTimer) { clearTimeout(state.autoSaveTimer); state.autoSaveTimer = null; }
    state.isCommunityPreview = true;
    state.editingId = null;
    api.setVisitingTypes?.(mon?.customTypes || []);
    api.loadFakemonIntoEditor({ ...mon });
    notify();
}

// ---- unsaved event drafts ----
// The editor writes what you've typed here as you go, like a post draft, so
// leaving the page (or the tab crashing) doesn't lose an unfinished event.
// Per account and per device; cleared once the event is saved.

const draftKey = (eventId: string | null) => `woogidex.eventDraft.${me()}.${eventId || 'new'}`;

export function readEventDraft(eventId: string | null): { savedAt: number; values: any } | null {
    try { return JSON.parse(localStorage.getItem(draftKey(eventId)) || 'null'); } catch { return null; }
}
export function writeEventDraft(eventId: string | null, values: any) {
    try { localStorage.setItem(draftKey(eventId), JSON.stringify({ savedAt: Date.now(), values })); }
    catch {
        // a big cover image can overflow storage; keep the rest
        try { localStorage.setItem(draftKey(eventId), JSON.stringify({ savedAt: Date.now(), values: { ...values, cover_image: null } })); } catch { /* full or private mode */ }
    }
}
export function clearEventDraft(eventId: string | null) {
    try { localStorage.removeItem(draftKey(eventId)); } catch { /* private mode */ }
}

// ---- export ----

const fileSlug = (title: string) => title.replace(/[^\w-]+/g, '-').slice(0, 40) || 'event';
function download(blob: Blob, name: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Every entry with every answer (private ones too, when you may see them) as a CSV download. */
export function exportEntriesCsv() {
    const d = events.detail;
    if (!d?.event) return;
    const ev = d.event;
    const cell = (v: any) => {
        const s = v == null ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? (v.name || '') : String(v);
        const text = s.startsWith('data:') ? '[image]' : s;
        // =, +, -, @ would run as a formula when the sheet is opened
        return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
    };
    const questions = ev.form.filter(f => f.type !== 'section');
    const header = ['Entry', 'Entrant', 'Submitted', ...questions.map(f => f.label), 'Votes', 'Points %', 'Placement'];
    const results = new Map((d.results || []).map(r => [r.entry_id, r]));
    const rows = d.entries.map(en => {
        const all = { ...en.answers, ...(d.privateAnswers[en.id] || {}) };
        const p = d.people[en.user_id || ""];
        const r = results.get(en.id);
        return [en.id, !en.user_id ? 'Guest' : p ? `@${p.username}` : en.user_id, en.created_at, ...questions.map(f => all[f.id]), r?.votes ?? '', r?.points_percent ?? '', en.placement ?? ''];
    });
    download(new Blob([[header, ...rows].map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' }), `${fileSlug(ev.title)}-entries.csv`);
}
