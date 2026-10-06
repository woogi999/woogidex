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
import { ALL_VANILLA_TYPES } from './custom-types.ts';
import { NAME_MAX } from '../core/data.ts';
import { applyMyReaction } from './comments.ts';

/** 'announced': visible to everyone, entries not open yet (they open on the date, or by hand). */
export type Phase = 'draft' | 'announced' | 'open' | 'voting' | 'ended';
export type FieldType = 'short' | 'long' | 'url' | 'email' | 'discord' | 'choice' | 'dropdown' | 'checkboxes' | 'number' | 'date' | 'scale'
    | 'image' | 'fakemon' | 'library' | 'agree' | 'section';
/** What a 'library' question takes: one of the entrant's moves, abilities, items or types. */
export type LibKind = 'move' | 'ability' | 'item' | 'type';
/** Parts a Fakémon question can insist on. */
export type MonPart = 'artwork' | 'shiny' | 'abilities' | 'dex' | 'moves' | 'sets';
/** A Fakémon question's rules (event_fakemon_problem in the database enforces the same). */
export interface MonRules {
    require?: MonPart[]; noCustomTypes?: boolean; noCustomAbilities?: boolean; noCustomMoves?: boolean;
    /** the final evolution must have at least one of these types */
    types?: string[]; minBst?: number | null; maxBst?: number | null;
    /** how many Fakémon the entered line may hold, Megas and forms included (1: no evolutions) */
    minLine?: number | null; maxLine?: number | null;
    /** no Megas or other forms in the line */
    noForms?: boolean;
    /** custom moves, abilities, and all custom things (types too), counted once each across the line */
    maxCustomMoves?: number | null; maxCustomAbilities?: number | null; maxCustomTotal?: number | null;
}
/**
 * One Fakémon of an entered evolution line, kept on the answer as `family`.
 * The face (the last stage, which cards show) is the answer itself, so its
 * member carries `face` and no `mon`. `from`: the Fakémon it evolves from, or
 * for a Mega or form the one it's a form of.
 */
export interface LineMember {
    sourceId: string; stage: number; isMega?: boolean; isFormeChange?: boolean;
    from?: string | null; method?: string; face?: boolean; mon?: any;
}
export type Voting = 'none' | 'community' | 'judges' | 'ballot';
/** Where an event is right now; the dates move it along (see effectivePhase). */
export type Stage = 'draft' | 'upcoming' | 'open' | 'closed' | 'voting' | 'tallying' | 'ended';
export interface WinnerRules { top_n?: number; top_percent?: number; min_score_percent?: number; }
/** One line of the voting form: scored 1 to max. */
export interface Criterion { name: string; help?: string; max: number; }
export type Remarks = 'off' | 'optional' | 'required';

/** A question. 'section' is a page break: its label and help head the next page. min/max: number bounds, or a scale's top. */
export interface Field {
    id: string; type: FieldType; label: string; help?: string; required?: boolean; private?: boolean; options?: string[]; min?: number | null; max?: number | null;
    /** a 'library' question: which kinds it takes */
    kinds?: LibKind[];
    /** a 'fakemon' question's rules */
    rules?: MonRules;
}
export interface EventRow {
    id: string; owner_id: string; title: string; tagline: string; description: string; category: string;
    accent: string; cover_image: string | null; phase: Phase;
    /** the cover, small: lists, tickets and the feed use this one */
    cover_thumb?: string | null;
    /** what happens when entries score the same (see ranked()) */
    tie_rule?: TieRule; tie_criterion?: string | null;
    submissions_open_at: string | null; submissions_close_at: string | null;
    voting_open_at: string | null; voting_close_at: string | null; results_at: string | null;
    criteria: Criterion[]; voter_remarks: Remarks; winner_criteria: WinnerRules;
    form: Field[]; voting: Voting; votes_per_user: number; max_entries_per_user: number;
    live_results: boolean; show_entries: boolean; public_access: boolean; created_at: string; updated_at: string;
    /** people may vote on their own entries (off by default) */
    allow_self_vote?: boolean;
    /** questions voters answer about each entry, besides the scores */
    vote_form: Field[];
    /** the custom link, /events/<slug>; null uses the id */
    slug: string | null;
    /** what of an entry the voting form shows: which answers (null: all) and who sent it */
    vote_display: { fields: string[] | null; author: boolean };
    /** the entries are the team's: the public sees them only while it votes on them, and never their number */
    entries_private?: boolean;
    /** the results wait for the team's results post (publish_event_results) */
    hold_results?: boolean;
    results_released_at?: string | null;
}
export interface EventCode { id: string; event_id: string; code: string; max_entries: number; max_uses: number | null; uses: number; created_at: string; }
/** user_id is null for a guest's entry (public events) */
/**
 * answers: as loaded for lists, pictures left out ("[image]"); open the entry
 * for everything (loadFullEntry). thumb: its picture, small.
 */
export interface Entry { id: string; event_id: string; user_id: string | null; answers: Record<string, any>; placement: number | null; created_at: string; thumb?: string | null; }
/** When entries score the same: share the place, or settle it by a criterion, the number of votes, or who entered first. */
export type TieRule = 'share' | 'criterion' | 'votes' | 'earliest';
export const TIE_RULES: Array<[TieRule, string]> = [
    ['share', 'They share the place (two 2nd places, say)'],
    ['criterion', 'The higher score on one criterion wins'],
    ['votes', 'The one more people voted for wins'],
    ['earliest', 'The one entered first wins']
];
export interface Helper {
    event_id: string; user_id: string; can_edit: boolean; can_entries: boolean; can_judge: boolean; can_results: boolean;
    /** may add people to the team, with no more than they hold */
    can_add?: boolean;
    /** everything but deleting the event */
    is_organizer?: boolean;
    added_by?: string | null;
}
/** show_author false: posted as the event (author_id is empty then; the audit log says who). */
export interface Announcement { id: string; event_id: string; author_id: string | null; title: string; body: string; created_at: string; show_author?: boolean; }
/** One line of an event's audit log (event_audit_log, written by triggers). */
export interface AuditRow { id: number; event_id: string; actor_id: string | null; action: string; detail: Record<string, any>; created_at: string; }
/** the team asked the entrant to change their entry (event_entry_private) */
export interface EditRequest { reason: string; at: string; }
export interface Result {
    entry_id: string; votes: number; score_total: number; score_avg: number;
    criteria_avg: Record<string, number | null>; total_voters: number; points_percent: number;
}
export interface Vote { entry_id: string; voter_id: string; score: number; scores: Record<string, number> | null; answers: Record<string, any> | null; remarks: string; created_at: string; }
export interface EntryLimit { event_id: string; user_id: string; max_entries: number; }
export interface Person { id: string; username?: string; display_name?: string; avatar_url?: string; }
export interface Perms { owner: boolean; view: boolean; edit: boolean; entries: boolean; judge: boolean; results: boolean; add: boolean; team: boolean; }
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
    announcements: Announcement[];
    /** whether you follow it (announcements reach you) */
    following: boolean;
    /** edit requests on entries you may see the private side of, by entry id */
    editRequests: Record<string, EditRequest>;
    /** the Google Sheets link's token (the Entries team) */
    sheet: { token: string; include_private: boolean } | null;
    /** the votes' own sheet link (team members who see results) */
    voteSheet: { token: string; include_private: boolean } | null;
    /** entries opened in full (answers with their pictures), by entry id */
    full: Record<string, Record<string, any>>;
    /** feedback the team sent the entrant, by entry id (yours, or every one with Entries access) */
    feedback: Record<string, { text: string; at: string }>;
    /** reactions on the event, by emoji, and yours (one each) */
    reactions: Record<string, number>;
    myReactions: string[];
}

/** An event's page has tabs: what it is, entering it, voting, and the results. */
export type EventTab = 'about' | 'enter' | 'vote' | 'results';
export const EVENT_TABS: EventTab[] = ['about', 'enter', 'vote', 'results'];
export type View =
    | { kind: 'list' }
    | { kind: 'event'; id: string; tab?: EventTab }
    | { kind: 'dashboard'; id: string; tab?: DashTab }
    | { kind: 'new' };
export type DashTab = 'overview' | 'entries' | 'announcements' | 'results' | 'team' | 'audit' | 'settings';

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
    ['library', 'Move, ability, item or type', 'puzzle-piece'],
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
/** Hidden from everyone but the entrant and the team with Entries access.
 *  Email always is; Discord is unless the organizer unticks it (same rule as event_store_entry). */
export const isPrivateField = (f: Field) => f.type === 'email' || (f.private ?? f.type === 'discord');
export const CATEGORIES = ['PoA contest', 'Fakémon contest', 'Art contest', 'Poster competition', 'Mascot contest', 'Writing contest', 'Tournament', 'Sign-ups', 'Community event'];
export const DEFAULT_CRITERIA: Criterion[] = [{ name: 'Competitive', max: 10 }, { name: 'Design', max: 10 }];

export const PHASES: Array<[Phase, string]> = [['draft', 'Draft'], ['announced', 'Live, entries not open'], ['open', 'Taking entries'], ['voting', 'Voting'], ['ended', 'Ended']];
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
/** Everything of an entry but who sent it (event_entry_authors hands that out). */
const ENTRY_COLUMNS = 'id,event_id,answers,placement,created_at';

/**
 * Every entry of an event with its pictures left out: event_entries_light,
 * which counts the download against the site's egress budget and stops when
 * it's spent. Until that migration is in, the table itself.
 */
async function lightEntries(c: any, eventId: string): Promise<{ data: any[] | null; error: any }> {
    const r = await c.rpc('event_entries_light', { p_event: eventId });
    if (!r.error) return { data: r.data || [], error: null };
    if (r.error.code !== 'PGRST202' && r.error.code !== '42883') return { data: null, error: r.error };
    return c.from('event_entries').select(ENTRY_COLUMNS).eq('event_id', eventId).order('created_at', { ascending: true });
}

/** One entry in full (its pictures, the whole Fakémon), loaded once when it's opened. */
export async function loadFullEntry(en: Entry): Promise<Record<string, any> | null> {
    const d = detailFor(en.event_id);
    if (d?.full[en.id]) return d.full[en.id];
    try {
        const c = await client();
        const r = await c.rpc('event_entry_full', { p_entry: en.id });
        let answers: Record<string, any> | null = r.data?.answers ?? null;
        if (r.error) {
            if (r.error.code !== 'PGRST202' && r.error.code !== '42883') throw r.error;
            const t = await c.from('event_entries').select('answers').eq('id', en.id).maybeSingle();
            answers = t.data?.answers ?? null;
        }
        if (answers && d) { d.full[en.id] = answers; notify(); }
        return answers;
    } catch (e) { fail(e); return null; }
}

/** The entry as far as it's loaded: in full once opened, otherwise without its pictures. */
export const fullAnswers = (d: Detail, en: Entry) => d.full[en.id] || en.answers;

/** A small picture of an entry (its first image or Fakémon artwork), for galleries; '' if it has none. */
export async function entryThumb(form: Field[], answers: Record<string, any>): Promise<string> {
    for (const f of form) {
        const v = answers[f.id];
        const src = f.type === 'image' && typeof v === 'string' ? v : (f.type === 'fakemon' || f.type === 'library') && typeof v?.artwork === 'string' ? v.artwork : '';
        if (src.startsWith('data:image/')) return shrinkImage(src, 360, 60_000).catch(() => '');
    }
    return '';
}
const me = () => state.user?.id || '';
const sitePerms = () => (state.user?.permissions || {}) as Record<string, boolean>;

export const canCreateEvents = () => !!(sitePerms().create_events || sitePerms().manage_events);

/** What the signed-in user may do on an event. UI only: the database checks again. */
export function permsFor(ev: EventRow | null | undefined, helpers: Helper[] = events.helping): Perms {
    const none = { owner: false, view: false, edit: false, entries: false, judge: false, results: false, add: false, team: false };
    if (!ev || !me()) return none;
    const all = { owner: true, view: true, edit: true, entries: true, judge: true, results: true, add: true, team: true };
    if (ev.owner_id === me() || sitePerms().manage_events) return all;
    const h = helpers.find(x => x.event_id === ev.id && x.user_id === me());
    if (!h) return none;
    // a co-organizer: everything but deleting the event (event_can in the database)
    if (h.is_organizer) return { ...all, owner: false };
    return { owner: false, view: true, edit: h.can_edit, entries: h.can_entries, judge: h.can_judge, results: h.can_results, add: !!h.can_add, team: false };
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
    const stage = basePhase(e);
    // held for the results post: "results soon" until the team publishes it
    return stage === 'ended' && e.hold_results && !e.results_released_at ? 'tallying' : stage;
}
function basePhase(e: EventRow): Stage {
    const now = Date.now();
    const at = (v: string | null) => v ? new Date(v).getTime() : null;
    const vOpen = at(e.voting_open_at), vClose = at(e.voting_close_at), sOpen = at(e.submissions_open_at), sClose = at(e.submissions_close_at);
    const results = at(e.results_at);
    if (e.phase === 'draft' || e.phase === 'ended') return e.phase;
    if (e.phase === 'announced' && (sOpen === null || now < sOpen)) return 'upcoming';
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
/**
 * Whether the public sees the entries now (public.event_entries_visible).
 * Private ones: only while the public is the one voting on them.
 */
export function entriesPublic(e: EventRow): boolean {
    const stage = effectivePhase(e);
    if (e.entries_private) return (e.voting === 'community' || e.voting === 'ballot') && stage === 'voting';
    return e.show_entries || ['closed', 'voting', 'tallying', 'ended'].includes(stage);
}
/** Whether this viewer sees the entries: the public's rule, or the team's access. */
export const canSeeEntries = (e: EventRow, p: Perms) => entriesPublic(e) || p.entries || p.judge || p.results;
export const votingOpen = (e: EventRow) => e.voting !== 'none' && effectivePhase(e) === 'voting';
export const isLive = (e: EventRow) => takingEntries(e) || votingOpen(e);

/** How many entries this user may send: the event's default, or what the organizers gave them. */
export function entryAllowance(ev: EventRow, limits: EntryLimit[] = events.detail?.limits || []): number {
    return limits.find(l => l.event_id === ev.id && l.user_id === me())?.max_entries ?? ev.max_entries_per_user;
}

/** A moment in the viewer's own time zone, named ("Oct 9, 2026, 8:00 PM GMT+8"). */
export const fmtDate = (v?: string | null, timeZone?: string) => v ? new Date(v).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone }) : '';

// ---- time zones ----
// Dates are stored as moments (UTC). The organizer picks a wall-clock time in
// a zone of their choosing; everyone else reads it in their own zone.

export const myTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const timeZones = (): string[] => (Intl as any).supportedValuesOf?.('timeZone') || [myTimeZone(), 'UTC'];

/** The wall-clock parts of a moment in a zone (month 0-based). */
export function zonedParts(t: number, timeZone: string) {
    const p: Record<string, number> = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(t)) {
        if (x.type !== 'literal') p[x.type] = Number(x.value);
    }
    return { y: p.year, mo: p.month - 1, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

/** The moment a wall-clock time in a zone names (a time skipped by a DST change rounds forward). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): Date {
    const wall = Date.UTC(y, mo, d, h, mi);
    const offset = (t: number) => { const p = zonedParts(t, timeZone); return Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s) - t; };
    let t = wall - offset(wall);
    const again = wall - offset(t);
    if (again !== t) t = Math.max(t, again);
    return new Date(t);
}
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
        if ((f.type === 'fakemon' || f.type === 'library') && v?.name) return v.name;
    }
    const p = people[en.user_id || ""];
    return p ? `Entry by ${p.display_name || p.username}` : 'Entry';
}

/** The entry's picture: its small thumb, else its first image answer or Fakémon artwork (once loaded in full). */
export function entryImage(ev: EventRow, en: Entry, full?: Record<string, any>): string {
    if (!full && en.thumb) return en.thumb;
    const answers = full || en.answers;
    for (const f of ev.form) {
        const v = answers[f.id];
        if (f.type === 'image' && typeof v === 'string' && v.startsWith('data:image/')) return v;
        if ((f.type === 'fakemon' || f.type === 'library') && typeof v?.artwork === 'string' && v.artwork.startsWith('data:image/')) return v.artwork;
    }
    return en.thumb || '';
}

export interface RankRow { entry: Entry; result: Result | null; /** 1 for first; shared when tied (tie_rule 'share'); null when unplaced */ place: number | null; }

/**
 * Entries best first, each with its place. On an event that votes, the votes
 * alone decide (placements can't be set there; the database refuses), and a
 * tie goes by the event's tie rule. Without voting, the organizer's
 * placements are the result.
 */
export function ranked(ev: EventRow, entries: Entry[], results: Result[] | null): RankRow[] {
    const byId = new Map((results || []).map(r => [r.entry_id, r]));
    const rows: RankRow[] = entries.map(en => ({ entry: en, result: byId.get(en.id) || null, place: null }));
    const first = (a: RankRow, b: RankRow) => a.entry.created_at.localeCompare(b.entry.created_at);
    if (ev.voting === 'none') {
        rows.sort((a, b) => (a.entry.placement ?? 999) - (b.entry.placement ?? 999) || first(a, b));
        rows.forEach(r => { r.place = r.entry.placement ?? null; });
        return rows;
    }
    const score = (r: RankRow) => ev.voting === 'community' ? Number(r.result?.votes || 0) : Number(r.result?.points_percent || 0);
    const votes = (r: RankRow) => Number(r.result?.votes || 0);
    const crit = (r: RankRow) => Number(r.result?.criteria_avg?.[ev.tie_criterion || ''] ?? 0);
    const tieBreak = (a: RankRow, b: RankRow) =>
        ev.tie_rule === 'criterion' ? crit(b) - crit(a)
        : ev.tie_rule === 'votes' ? votes(b) - votes(a)
        : ev.tie_rule === 'earliest' ? first(a, b)
        : 0;
    rows.sort((a, b) => score(b) - score(a) || tieBreak(a, b) || first(a, b));
    // a place is shared only while the score and the tie-break are both equal;
    // an entry nobody has voted on yet has no place
    rows.forEach((r, i) => {
        const prev = rows[i - 1];
        r.place = !votes(r) ? null : i > 0 && score(prev) === score(r) && tieBreak(prev, r) === 0 ? prev.place : i + 1;
    });
    return rows;
}

export function describeWinnerRules(wc: WinnerRules = {}): string {
    const parts: string[] = [];
    if (wc.top_n) parts.push(`the top ${wc.top_n}`);
    if (wc.top_percent) parts.push(`the top ${wc.top_percent}%`);
    if (wc.min_score_percent) parts.push(`anyone with at least ${wc.min_score_percent}% of the possible points`);
    return parts.length ? parts.join(', or ') : 'the top 3';
}

/**
 * Who wins. Without voting: whoever the organizers placed. With voting: every
 * entry that meets any of the winner rules (top N places, top %, at least X%
 * of the possible points). Places come from ranked(), so a tie for the last
 * winning place lets both in when the event shares tied places.
 */
export function computeWinners(ev: EventRow, rows: RankRow[]): Set<string> {
    if (ev.voting === 'none') return new Set(rows.filter(r => r.entry.placement).map(r => r.entry.id));
    const winners = new Set<string>();
    const scored = rows.filter(r => r.result && Number(r.result.votes) > 0);
    if (!scored.length) return winners;
    const wc = ev.winner_criteria || {};
    const topN = !wc.top_n && !wc.top_percent && !wc.min_score_percent ? 3 : wc.top_n || 0;
    if (topN) scored.forEach(r => { if ((r.place ?? 999) <= topN) winners.add(r.entry.id); });
    if (wc.top_percent) {
        const k = Math.max(1, Math.ceil(scored.length * wc.top_percent / 100));
        scored.forEach(r => { if ((r.place ?? 999) <= k) winners.add(r.entry.id); });
    }
    if (wc.min_score_percent) scored.forEach(r => { if (Number(r.result!.points_percent) >= wc.min_score_percent!) winners.add(r.entry.id); });
    return winners;
}

/** "1st", "2nd", "3rd", "4th"... */
export const placeLabel = (n: number) => {
    const t = n % 100;
    return `${n}${t >= 11 && t <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
};

// ---- loading ----

async function fetchPeople(ids: string[]): Promise<Record<string, Person>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return {};
    const { data } = await (await client()).from('profiles').select('id,username,display_name,avatar_url').in('id', unique);
    return Object.fromEntries((data || []).map((p: Person) => [p.id, p]));
}

/** Every event this user can see (public ones, plus their own drafts), and their helper roles. */
/** What the events list needs: everything but the full cover image and the forms (an event page loads those). */
const LIST_COLUMNS = 'id,owner_id,title,tagline,category,accent,cover_thumb,phase,submissions_open_at,submissions_close_at,voting_open_at,voting_close_at,'
    + 'results_at,voting,slug,public_access,show_entries,entries_private,hold_results,results_released_at,live_results,max_entries_per_user,votes_per_user,created_at,updated_at';

export async function fetchEvents(): Promise<EventRow[]> {
    const c = await client();
    const listed = (q: any) => q.order('created_at', { ascending: false }).limit(100);
    const [{ data, error }, helping] = await Promise.all([
        // the small cover; a site that hasn't had the migration yet falls back to the whole row
        listed(c.from('events').select(LIST_COLUMNS)).then((r: any) => r.error ? listed(c.from('events').select('*')) : r),
        me() ? c.from('event_helpers').select('*').eq('user_id', me()) : Promise.resolve({ data: [] })
    ]);
    if (error) throw error;
    events.list = (data || []).map((e: any) => ({ form: [], vote_form: [], criteria: [], winner_criteria: {}, vote_display: { fields: null, author: true }, description: '', ...e, cover_image: e.cover_image ?? null }));
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
        resultsPost: keep?.resultsPost ?? null, share: keep?.share || null, codes: keep?.codes || [],
        announcements: keep?.announcements || [], following: keep?.following || false, editRequests: keep?.editRequests || {}, sheet: keep?.sheet || null, voteSheet: keep?.voteSheet || null,
        full: keep?.full || {}, feedback: keep?.feedback || {}, reactions: keep?.reactions || {}, myReactions: keep?.myReactions || []
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
        const announceCols = 'id,event_id,author_id,title,body,created_at';
        const [entries, authors, helpers, votes, priv, results, ballots, limits, post, share, codes, news, follow, sheet, reacts] = await Promise.all([
            // who sent each one comes from event_entry_authors: hidden where the event hides it (blind voting)
            lightEntries(c, id),
            me() ? c.rpc('event_entry_authors', { p_event: id }) : none,
            me() ? c.from('event_helpers').select('*').eq('event_id', id) : none,
            me() ? c.from('event_votes').select('entry_id,voter_id,score,scores,answers,remarks,created_at').eq('event_id', id) : none,
            me() ? c.from('event_entry_private').select('entry_id,answers,edit_request,edit_requested_at,feedback,feedback_at').eq('event_id', id)
                .then((r: any) => r.error ? c.from('event_entry_private').select('entry_id,answers,edit_request,edit_requested_at').eq('event_id', id) : r) : none,
            // refused (not an error worth showing) until results are public or you're on the team
            c.rpc('get_event_results', { p_event: id }).then((r: any) => r.error ? null : r.data),
            me() ? c.from('event_ballots').select('voter_id,submitted_at').eq('event_id', id) : none,
            me() ? c.from('event_entry_limits').select('*').eq('event_id', id) : none,
            // hidden by RLS until the results are out, unless you're on the team
            c.from('event_results_posts').select('body').eq('event_id', id).maybeSingle(),
            me() && ev.phase !== 'draft' ? c.rpc('repost_embed', { p_kind: 'event', p_id: id }) : Promise.resolve({ data: null }),
            // RLS: only the team members who can edit see codes
            me() ? c.from('event_codes').select('*').eq('event_id', id).order('created_at', { ascending: true }) : none,
            // show_author: until that migration is in, the columns from before it
            c.from('event_announcements').select(`${announceCols},show_author`).eq('event_id', id).order('created_at', { ascending: false }).limit(50)
                .then((r: any) => r.error ? c.from('event_announcements').select(announceCols).eq('event_id', id).order('created_at', { ascending: false }).limit(50) : r),
            me() ? c.from('event_follows').select('event_id').eq('event_id', id).eq('user_id', me()).maybeSingle() : Promise.resolve({ data: null }),
            // RLS: the team members who see entries (and, for the votes' link, results);
            // kind: until the vote sheets migration is in, the one link is the submissions'
            me() ? c.from('event_sheet_links').select('token,include_private,kind').eq('event_id', id)
                .then((r: any) => r.error ? c.from('event_sheet_links').select('token,include_private').eq('event_id', id) : r) : none,
            // signed-in readers only; none until the reactions migration is in
            me() ? c.from('event_reactions').select('user_id,emoji').eq('event_id', id).limit(5000) : none
        ]);
        if (entries.error) throw entries.error;
        const by = new Map<string, string>(((authors as any).data || []).map((a: any) => [a.entry_id, a.user_id]));
        d.event = ev;
        d.entries = ((entries.data || []) as any[]).map(en => ({ ...en, user_id: by.get(en.id) ?? null }));
        d.helpers = (helpers as any).data || [];
        d.votes = (votes as any).data || [];
        d.myVotes = Object.fromEntries(d.votes.filter(v => v.voter_id === me()).map(v => [v.entry_id, v]));
        d.privateAnswers = Object.fromEntries(((priv as any).data || []).map((p: any) => [p.entry_id, p.answers]));
        d.feedback = Object.fromEntries(((priv as any).data || []).filter((p: any) => p.feedback).map((p: any) => [p.entry_id, { text: p.feedback, at: p.feedback_at }]));
        d.editRequests = Object.fromEntries(((priv as any).data || []).filter((p: any) => p.edit_requested_at).map((p: any) => [p.entry_id, { reason: p.edit_request || '', at: p.edit_requested_at }]));
        d.announcements = (news as any).data || [];
        d.following = !!(follow as any).data;
        const sheets: any[] = (sheet as any).data || [];
        d.sheet = sheets.find(s => (s.kind || 'entries') === 'entries') || null;
        d.voteSheet = sheets.find(s => s.kind === 'votes') || null;
        d.results = results;
        d.ballots = (ballots as any).data || [];
        d.limits = (limits as any).data || [];
        d.resultsPost = (post as any).data?.body ?? null;
        d.share = (share as any).data || null;
        d.codes = (codes as any).data || [];
        d.reactions = {};
        d.myReactions = [];
        for (const r of ((reacts as any).data || []) as Array<{ user_id: string; emoji: string }>) {
            d.reactions[r.emoji] = (d.reactions[r.emoji] || 0) + 1;
            if (r.user_id === me()) d.myReactions.push(r.emoji);
        }
        // profiles are for signed-in readers only; a guest sees no names
        if (me()) d.people = await fetchPeople([ev.owner_id, ...d.entries.map(e => e.user_id || ''), ...d.helpers.map(h => h.user_id),
            ...d.limits.map(l => l.user_id), ...d.votes.map(v => v.voter_id), ...d.announcements.map(a => a.author_id || '')]);
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

/**
 * Signed out while an event's page was open: it carries on as the guest page
 * (no hub sidebar), the way the link opens for someone without an account.
 * Whether a guest may see it at all is up to the event (loadEvent says).
 * @returns false when no event page was open
 */
export function reopenEventAsGuest(): boolean {
    const v = events.view;
    if (v.kind !== 'event' || (api.communityState?.().panel !== 'events')) return false;
    openGuestEvent(v.id, v.tab);
    loadEvent(v.id);
    return true;
}

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

/** Someone to put on a new event's team as soon as it exists (the editor's team list, and templates). */
export type HelperPerms = Pick<Helper, 'can_edit' | 'can_entries' | 'can_judge' | 'can_results'> & { can_add?: boolean; is_organizer?: boolean };
export interface TeamPick { person: Person; perms: HelperPerms; }

export async function createEvent(row: Partial<EventRow>, team: TeamPick[] = []): Promise<string | null> {
    try {
        const c = await client();
        const { data, error } = await c.from('events').insert({ ...row, owner_id: me() }).select('id').single();
        if (error) throw error;
        // the team goes on in one insert; if that fails the event still exists, and says so
        const rows = team.filter(t => t.person.id !== me()).map(t => ({ event_id: data.id, user_id: t.person.id, ...t.perms }));
        if (rows.length) {
            const { error: teamError } = await c.from('event_helpers').insert(rows);
            if (teamError) toast(`The event was created, but its team couldn't be added (${teamError.message}). Add them from the Team tab.`, 'warning');
        }
        toast('Event created. It is a draft until you open it.', 'success');
        showEventView({ kind: 'dashboard', id: data.id, tab: 'overview' });
        return data.id;
    } catch (e) { fail(e); return null; }
}

/**
 * Saves changes to an event. With `since` (the updated_at the editor loaded),
 * it refuses to save over someone else's newer changes instead of silently
 * undoing them; the editor keeps yours as a draft.
 */
export async function saveEvent(id: string, patch: Partial<EventRow>, message = 'Saved.', since?: string): Promise<boolean> {
    try {
        let q = (await client()).from('events').update(patch).eq('id', id);
        if (since) q = q.eq('updated_at', since);
        const { data, error } = await q.select('*');
        if (error) throw error;
        if (!data?.length) {
            if (since) {
                await loadEvent(id);
                if (events.detail?.event && events.detail.event.updated_at !== since) {
                    throw new Error('Someone else on the team saved changes to this event since you opened it. Yours are kept as a draft on this device: look over theirs, then save again.');
                }
            }
            throw new Error('You do not have permission to edit this event.');
        }
        if (events.detail?.id === id) events.detail.event = data[0];
        toast(message, 'success');
        notify();
        return true;
    } catch (e) { fail(e); return false; }
}

/** Moves an event by hand, now. Dates that would contradict it are cleared, or they'd move it straight back. */
export function setPhase(ev: EventRow, phase: Phase) {
    const msg: Record<Phase, string> = { draft: 'Back to draft.', announced: ev.submissions_open_at && !isPast(ev.submissions_open_at) ? 'It\'s live. Entries open on schedule.' : 'It\'s live. Entries stay closed until you open them.', open: 'Entries are open.', voting: 'Voting is open.', ended: 'Event ended. Results are public.' };
    const patch: Partial<EventRow> = { phase };
    const future = (v: string | null) => !!v && !isPast(v);
    // announced: a start date that's already gone would open entries straight away
    if (phase === 'announced' && isPast(ev.submissions_open_at)) patch.submissions_open_at = null;
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

/** The team removes someone's entry; the entrant is told, with the reason if there is one (remove_event_entry). */
export async function removeEntryAsTeam(en: Entry, reason: string): Promise<boolean> {
    try {
        const { error } = await (await client()).rpc('remove_event_entry', { p_entry: en.id, p_reason: reason.trim() });
        if (error) throw error;
        toast(en.user_id ? 'Entry removed. Its entrant has been told.' : 'Entry removed.', 'success');
        await loadEvent(en.event_id);
        return true;
    } catch (e) { fail(e); return false; }
}

/** People whose username or name starts with what's typed, for picking someone. */
export async function findPeople(query: string): Promise<Person[]> {
    const q = query.trim().replace(/^@/, '');
    if (q.length < 2) return [];
    // search_profiles leaves out people hidden from search (unless their exact username is typed)
    const { data } = await (await client()).rpc('search_profiles', { p_query: q, p_limit: 6, p_for: 'search' });
    return (data || []) as Person[];
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

export async function addHelper(eventId: string, username: string, perms: HelperPerms): Promise<boolean> {
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
        const { data, error } = await (await client()).rpc('redeem_event_code', { p_event: eventId, p_code: code.trim() });
        if (error) throw error;
        // failures come back as numbers, so the try still counts toward the guessing limit
        const refused: Record<number, string> = { [-1]: 'That code doesn\'t work for this event.', [-2]: 'That code has been used up.', [-3]: 'Too many tries. Try again in a while.' };
        if (refused[data]) throw new Error(refused[data]);
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
        // the gallery's small picture rides along; the database checks it and keeps it apart from the answers
        const thumb = ev ? await entryThumb(ev.form, answers) : '';
        if (thumb) answers = { ...answers, _thumb: thumb };
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

/** Changes your own entry while entries are open (update_event_entry checks it's yours). */
export async function updateEntry(en: Entry, answers: Record<string, any>): Promise<boolean> {
    try {
        const ev = detailFor(en.event_id)?.event;
        const thumb = ev ? await entryThumb(ev.form, answers) : '';
        const { error } = await (await client()).rpc('update_event_entry', { p_entry: en.id, p_answers: thumb ? { ...answers, _thumb: thumb } : answers });
        if (error) throw error;
        const d = detailFor(en.event_id);
        if (d) delete d.full[en.id];
        toast('Your entry was updated.', 'success');
        await loadEvent(en.event_id);
        return true;
    } catch (e) { fail(e); return false; }
}

// ---- unsent entry answers ----
// What you've filled in stays on this device until you send it, so leaving the
// form (or the tab crashing) loses nothing. Per account (or guest), event and entry.

const answersKey = (eventId: string, entryId = 'new') => `woogidex.eventEntry.${me() || 'guest'}.${eventId}.${entryId}`;

export function readEntryDraft(eventId: string, entryId?: string): Record<string, any> | null {
    try { return JSON.parse(localStorage.getItem(answersKey(eventId, entryId)) || 'null'); } catch { return null; }
}
export function writeEntryDraft(eventId: string, answers: Record<string, any>, entryId?: string) {
    try { localStorage.setItem(answersKey(eventId, entryId), JSON.stringify(answers)); }
    catch {
        // images and Fakémon can overflow storage; keep the typed answers at least
        const light = Object.fromEntries(Object.entries(answers).filter(([, v]) => JSON.stringify(v ?? '').length < 20_000));
        try { localStorage.setItem(answersKey(eventId, entryId), JSON.stringify(light)); } catch { /* full or private mode */ }
    }
}
export function clearEntryDraft(eventId: string, entryId?: string) {
    try { localStorage.removeItem(answersKey(eventId, entryId)); } catch { /* private mode */ }
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

/** Saves the results post and releases the results (what an event that holds them waits for). */
export async function publishResults(eventId: string, body: string): Promise<boolean> {
    if (!await confirmDialog({ title: 'Publish the results?', message: 'The results post goes up and everyone can see the results. This can\'t be taken back.', confirmLabel: 'Publish results' })) return false;
    try {
        const { error } = await (await client()).rpc('publish_event_results', { p_event: eventId, p_body: body.trim() });
        if (error) throw error;
        toast('The results are out.', 'success');
        await loadEvent(eventId);
        return true;
    } catch (e) { fail(e); return false; }
}

// ---- following, announcements ----

export async function setFollowing(eventId: string, on: boolean): Promise<boolean> {
    if (!api.requireAccount?.('Sign in to follow events.')) return false;
    try {
        const c = await client();
        const { error } = on
            ? await c.from('event_follows').upsert({ event_id: eventId, user_id: me() }, { onConflict: 'event_id,user_id', ignoreDuplicates: true })
            : await c.from('event_follows').delete().eq('event_id', eventId).eq('user_id', me());
        if (error) throw error;
        if (events.detail?.id === eventId) events.detail.following = on;
        toast(on ? 'Following. Its announcements will reach you.' : 'Unfollowed.', 'success');
        notify();
        return true;
    } catch (e) { fail(e); return false; }
}

/**
 * Posts an announcement: followers are notified, and emailed if they asked for
 * that. `asEvent`: readers see the event as its poster, not you.
 */
export async function postAnnouncement(eventId: string, title: string, body: string, asEvent = false): Promise<boolean> {
    try {
        const c = await client();
        const { data: id, error } = await c.rpc('post_event_announcement', { p_event: eventId, p_title: title.trim(), p_body: body.trim(), ...(asEvent ? { p_show_author: false } : {}) });
        if (error) throw error;
        toast('Announcement posted. Followers have been notified.', 'success');
        // the emails go out from the server; if that fails, the announcement stands
        c.functions.invoke('send-event-announcement', { body: { announcement_id: id } })
            .then((r: any) => { if (r?.error) console.warn('Announcement emails were not sent', r.error); })
            .catch(() => {});
        await loadEvent(eventId);
        return true;
    } catch (e) { fail(e); return false; }
}

export async function deleteAnnouncement(a: Announcement) {
    if (!await confirmDialog({ title: 'Delete this announcement?', message: 'It comes off the event page. Notifications already sent stay sent.', confirmLabel: 'Delete', danger: true })) return;
    try {
        const { data, error } = await (await client()).from('event_announcements').delete().eq('id', a.id).select('id');
        if (error) throw error;
        if (!data?.length) throw new Error('You do not have permission to delete announcements.');
        await loadEvent(a.event_id);
    } catch (e) { fail(e); }
}

// ---- reactions ----

/** Your reaction on the event, one each: the same emoji takes it back, another swaps it. */
export async function toggleEventReaction(emoji: string) {
    const d = events.detail;
    if (!d?.event || !api.requireAccount?.('Sign in to react.')) return;
    const had = d.myReactions.includes(emoji);
    const before = { reactions: d.reactions, myReactions: d.myReactions };
    const next = applyMyReaction(d.reactions, d.myReactions, had ? null : emoji);
    d.reactions = next.reactions;
    d.myReactions = next.my_reactions;
    notify();
    try {
        const c = await client();
        const mine = { event_id: d.event.id, user_id: me() };
        const { error } = had ? await c.from('event_reactions').delete().match(mine) : await c.from('event_reactions').insert({ ...mine, emoji });
        if (error && error.code !== '23505') throw error;
    } catch (e: any) {
        Object.assign(d, before);
        notify();
        toast(api.friendlyModerationError?.(e) || e?.message || 'Could not react.', 'error');
    }
}

// ---- the audit log ----

/** What the team has done on an event, newest first (the team reads it; triggers write it). */
export async function loadAuditLog(eventId: string, before: number | null = null): Promise<AuditRow[]> {
    let q = (await client()).from('event_audit_log').select('*').eq('event_id', eventId).order('id', { ascending: false }).limit(100);
    if (before) q = q.lt('id', before);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data || []) as AuditRow[];
    // names for whoever acted, and whoever it was done to
    const d = detailFor(eventId);
    if (d) {
        const ids = rows.flatMap(r => [r.actor_id || '', r.detail?.user_id || '', r.detail?.posted_by || '']).filter(id => id && !d.people[id]);
        if (ids.length) Object.assign(d.people, await fetchPeople(ids));
    }
    return rows;
}

// ---- asking for changes ----

/** Asks the entrant to change their entry (an empty reason takes the request back). */
export async function requestEntryEdit(en: Entry, reason: string): Promise<boolean> {
    try {
        const { error } = await (await client()).rpc('request_event_entry_edit', { p_entry: en.id, p_reason: reason.trim() });
        if (error) throw error;
        toast(reason.trim() ? 'Asked. They\'ve been sent a notification.' : 'Request withdrawn.', 'success');
        await loadEvent(en.event_id);
        return true;
    } catch (e) { fail(e); return false; }
}

// ---- voter feedback, for the entry's creator ----

/** Sends the team's compiled feedback to the entrant (send_event_feedback); sending again replaces it. */
export async function sendFeedback(en: Entry, text: string): Promise<boolean> {
    try {
        const { error } = await (await client()).rpc('send_event_feedback', { p_entry: en.id, p_text: text.trim() });
        if (error) throw error;
        const d = detailFor(en.event_id);
        if (d) { d.feedback[en.id] = { text: text.trim(), at: new Date().toISOString() }; notify(); }
        toast('Feedback sent. They\'ve been notified.', 'success');
        return true;
    } catch (e) { fail(e); return false; }
}

/** What voters wrote about one entry: each voter's answers to the voter questions, and their remarks. */
export function votesFor(ev: EventRow, d: Detail, en: Entry) {
    const questions = (ev.vote_form || []).filter(q => q.type !== 'section');
    return d.votes.filter(v => v.entry_id === en.id).map(v => ({
        vote: v,
        who: d.people[v.voter_id],
        answers: questions.filter(q => answered(v.answers?.[q.id])).map(q => ({ q, value: Array.isArray(v.answers![q.id]) ? v.answers![q.id].join(', ') : String(v.answers![q.id]) })),
        remarks: (v.remarks || '').trim()
    }));
}

/** A starting point for the feedback: every written answer and remark, one voter after another. */
export function compileFeedback(ev: EventRow, d: Detail, en: Entry, { names = false, onlyWritten = true } = {}): string {
    const rows = votesFor(ev, d, en);
    const parts = rows.map((r, i) => {
        const lines = [
            ...r.answers.filter(a => !onlyWritten || a.q.type === 'long' || a.q.type === 'short').map(a => `**${a.q.label}:** ${a.value}`),
            ...(r.remarks ? [r.remarks] : [])
        ];
        if (!lines.length) return '';
        const who = names && r.who?.username ? `@${r.who.username}` : `Voter ${i + 1}`;
        return `### ${who}\n${lines.join('\n\n')}`;
    }).filter(Boolean);
    return parts.length ? [`## Feedback on ${entryTitle(ev, en, d.people)}`, '', ...parts.flatMap(p => [p, ''])].join('\n').trim() : '';
}

/** Every vote as a spreadsheet: who, which entry, each score, each answer, the remarks. */
export function exportVotesCsv() {
    const d = events.detail;
    if (!d?.event) return;
    const ev = d.event;
    const criteria = criteriaOf(ev);
    const questions = (ev.vote_form || []).filter(q => q.type !== 'section');
    const header = ['Voter', 'Entry', 'Entrant', 'Total', ...criteria.map(c => `${c.name} (of ${c.max})`), ...questions.map(q => q.label), 'Remarks', 'When'];
    const rows = d.votes.map(v => {
        const en = d.entries.find(e => e.id === v.entry_id);
        const voter = d.people[v.voter_id];
        const entrant = en?.user_id ? d.people[en.user_id] : null;
        return [voter ? `@${voter.username}` : v.voter_id, en ? entryTitle(ev, en, d.people) : 'Removed entry', entrant ? `@${entrant.username}` : en?.user_id ? 'Member' : 'Guest',
            v.score, ...criteria.map(c => v.scores?.[c.name] ?? ''), ...questions.map(q => v.answers?.[q.id]), v.remarks || '', v.created_at];
    });
    download(new Blob([[header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' }), `${fileSlug(ev.title)}-votes.csv`);
}

// ---- the Google Sheets link ----

/** The address Google Sheets reads (=IMPORTDATA), served as CSV by worker/index.js. */
export const sheetUrl = (token: string) => routeUrl(`sheets/${token}.csv`);
export const sheetFormula = (token: string) => `=IMPORTDATA("${sheetUrl(token)}")`;

/** Makes the link for the submissions or the votes, or a new one (which retires the old). */
export async function createSheetLink(eventId: string, includePrivate: boolean, kind: 'entries' | 'votes' = 'entries'): Promise<boolean> {
    try {
        const { error } = await (await client()).rpc('create_event_sheet_link', kind === 'votes'
            ? { p_event: eventId, p_private: false, p_kind: 'votes' }
            : { p_event: eventId, p_private: includePrivate });
        if (error) throw error;
        await loadEvent(eventId);
        return true;
    } catch (e) { fail(e); return false; }
}

export async function deleteSheetLink(eventId: string, token: string) {
    if (!await confirmDialog({ title: 'Turn off the sheet link?', message: 'Sheets that use it stop updating. You can make a new link later.', confirmLabel: 'Turn off', danger: true })) return;
    try {
        // by token: each event can have two links now (submissions, votes)
        const { error } = await (await client()).from('event_sheet_links').delete().eq('event_id', eventId).eq('token', token);
        if (error) throw error;
        await loadEvent(eventId);
    } catch (e) { fail(e); }
}

// ---- variables ----
// {{name}} in an event's texts (about, results post, announcements) is filled
// in as it's shown: the winners in a results post, the dates, the counts.
// What this viewer can't see yet (the winners before the results) reads "TBA".

export const VARIABLES: Array<[string, string]> = [
    ['event', 'Event name'], ['organizer', 'Organizer'],
    ['winner1', '1st place'], ['winner2', '2nd place'], ['winner3', '3rd place'], ['winners', 'Every winner, as a list'],
    ['entries', 'Number of entries'], ['entrants', 'Number of entrants'], ['voters', 'Number of voters'],
    ['entries_open', 'When entries open'], ['entries_close', 'When entries close'],
    ['voting_open', 'When voting opens'], ['voting_close', 'When voting closes'], ['results_date', 'When results come out'],
    ['link', 'Link to the event']
];

/** Each variable's value for an event, as this viewer may see it. */
export function variablesFor(ev: EventRow, d: Detail | null): Record<string, string> {
    const tba = 'TBA';
    const seen = !!d && canSeeEntries(ev, permsFor(ev, d.helpers));
    const rows = d && seen ? ranked(ev, d.entries, d.results) : [];
    // winners only from real results or placements the viewer may see
    const winners = rows.length && (d!.results || rows.some(r => r.entry.placement)) ? computeWinners(ev, rows) : new Set<string>();
    const won = rows.filter(r => winners.has(r.entry.id));
    const one = (r: RankRow) => {
        const p = d!.people[r.entry.user_id || ''];
        return `**${entryTitle(ev, r.entry, d!.people)}**${p?.username ? ` by @${p.username}` : ''}`;
    };
    // {{winner2}}: whoever is in 2nd place, two of them if they tied
    const name = (i: number) => {
        const at = won.filter(r => r.place === i + 1);
        return at.length ? at.map(one).join(' and ') : tba;
    };
    const date = (v: string | null) => v ? fmtDate(v) : tba;
    const organizer = d?.people[ev.owner_id];
    return {
        event: ev.title || 'this event', organizer: organizer?.username ? `@${organizer.username}` : tba,
        winner1: name(0), winner2: name(1), winner3: name(2),
        winners: won.length ? won.map(r => `${['🥇', '🥈', '🥉'][(r.place || 99) - 1] || `${placeLabel(r.place || 0)}:`} ${one(r)}`).join('\n') : tba,
        entries: seen ? String(d!.entries.length) : tba,
        entrants: seen ? String(new Set(d!.entries.map(e => e.user_id || e.id)).size) : tba,
        voters: d?.results?.length ? String(d.results[0].total_voters) : tba,
        entries_open: date(ev.submissions_open_at), entries_close: date(ev.submissions_close_at),
        voting_open: date(ev.voting_open_at), voting_close: date(ev.voting_close_at), results_date: date(ev.results_at),
        link: shareLink(ev)
    };
}

/** Made-up values for every variable, so a preview reads like the real thing. */
export function sampleVariables(ev: EventRow): Record<string, string> {
    const soon = (days: number) => fmtDate(new Date(Date.now() + days * 86_400_000).toISOString());
    return {
        event: ev.title || 'Your event', organizer: state.user?.username ? `@${state.user.username}` : '@organizer',
        winner1: '**Blazelyn** by @mira', winner2: '**Mossbit** by @kai', winner3: '**Voltusk** by @juniper and **Frostail** by @sol',
        winners: '🥇 **Blazelyn** by @mira\n🥈 **Mossbit** by @kai\n🥉 **Voltusk** by @juniper and **Frostail** by @sol',
        entries: '24', entrants: '19', voters: '41',
        entries_open: ev.submissions_open_at ? fmtDate(ev.submissions_open_at) : soon(1),
        entries_close: ev.submissions_close_at ? fmtDate(ev.submissions_close_at) : soon(8),
        voting_open: ev.voting_open_at ? fmtDate(ev.voting_open_at) : soon(8),
        voting_close: ev.voting_close_at ? fmtDate(ev.voting_close_at) : soon(12),
        results_date: ev.results_at ? fmtDate(ev.results_at) : soon(13),
        link: shareLink(ev.id === 'preview' ? { id: 'your-event', slug: ev.slug } : ev)
    };
}

/** Text with its {{variables}} filled in; names it doesn't know stay as typed. */
export function fillVariables(text: string, vars: Record<string, string>): string {
    return String(text || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, k: string) => vars[k.toLowerCase()] ?? m);
}

/** The standings as markdown, to start a results post from. */
export function standingsMarkdown(ev: EventRow, d: Detail): string {
    const rows = ranked(ev, d.entries, d.results);
    const winners = computeWinners(ev, rows);
    const medal = (place: number) => ['🥇', '🥈', '🥉'][place - 1] || `${placeLabel(place)}:`;
    const lines = rows.filter(r => winners.has(r.entry.id)).map(r => {
        const p = d.people[r.entry.user_id || ''];
        const by = p ? ` by @${p.username}` : '';
        const score = r.result ? (ev.voting === 'community' ? ` (${r.result.votes} votes)` : ` (${Number(r.result.points_percent).toFixed(1)}%)`) : '';
        return `${medal(r.place || 1)} **${entryTitle(ev, r.entry, d.people)}**${by}${score}`;
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
// every criterion, then sent in one go. Progress is kept on this device until
// it's sent (localStorage: it used to be the tab's, so closing the tab lost a
// half-finished ballot).

const ballotKey = (eventId: string) => `woogidex.eventBallot.${me()}.${eventId}`;

function shuffle<T>(items: T[]): T[] {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}

export const ballotEntries = (ev: EventRow, entries: Entry[]) => entries.filter(e => e.event_id === ev.id && (ev.allow_self_vote || e.user_id !== me()));
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
    try { saved = JSON.parse(localStorage.getItem(ballotKey(ev.id)) || sessionStorage.getItem(ballotKey(ev.id)) || 'null'); } catch { /* private mode */ }
    const sameEntries = saved?.order?.length === ids.length && saved.order.every((id: string) => ids.includes(id));
    events.ballot = sameEntries ? { answers: {}, ...saved, eventId: ev.id } : { eventId: ev.id, order: shuffle(ids), index: 0, scores: {}, remarks: {}, answers: {} };
    notify();
    window.scrollTo({ top: 0 });
}

export function updateBallot(patch: Partial<NonNullable<typeof events.ballot>>) {
    const b = events.ballot;
    if (!b) return;
    Object.assign(b, patch);
    try { localStorage.setItem(ballotKey(b.eventId), JSON.stringify(b)); } catch { /* full or private mode */ }
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
        try { localStorage.removeItem(ballotKey(ev.id)); sessionStorage.removeItem(ballotKey(ev.id)); } catch { /* private mode */ }
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
export async function fakemonForEntry(mon: any, maxArt = ART_MAX): Promise<any> {
    const copy = JSON.parse(JSON.stringify(mon));
    // the board it was drawn on points at the rest of the collection; the line goes in as `family` instead
    for (const k of ['id', 'createdAt', 'updatedAt', 'regionIds', 'folderId', 'pinned', 'pendingVanilla', 'family', 'evolutionGraph', 'sourceId']) delete copy[k];
    if (typeof copy.name === 'string') copy.name = copy.name.trim().slice(0, NAME_MAX);
    for (const k of ['artwork', 'shinyArtwork']) {
        if (typeof copy[k] === 'string' && copy[k].startsWith('data:image/')) copy[k] = await shrinkImage(copy[k], 1200, maxArt).catch(() => '');
        else delete copy[k];
        if (!copy[k]) delete copy[k];
    }
    if (typeof copy.cry === 'string' && (!copy.cry.startsWith('data:audio/') || copy.cry.length > 400_000)) delete copy.cry;
    if (JSON.stringify(copy).length > 2_400_000) throw new Error('That Fakémon is too large to enter. Try one with smaller artwork.');
    return copy;
}

// ---- evolution lines ----
// A Fakémon answer can carry its whole line, the way a Community upload does:
// picked from the collection, its evolutions, Megas and forms come along; from
// a file or made here, they're added and connected on the form.

/** At most this many Fakémon in one answer (clean_event_fakemon allows the same). */
export const LINE_MAX = 10;
/** What a whole line may weigh; the server takes 5MB. */
const LINE_CHARS = 4_600_000;
export const newSourceId = () => 'n' + Math.random().toString(36).slice(2, 10);

/** Every Fakémon in a Fakémon answer, each with its `mon`, in stage order. */
export function lineOf(value: any): LineMember[] {
    if (!value || typeof value !== 'object') return [];
    const { family, ...face } = value;
    if (!Array.isArray(family) || family.length < 2) return [{ sourceId: 'main', stage: 1, face: true, mon: face }];
    return family.filter((m: any) => m && (m.face || m.mon)).map((m: any) => ({ ...m, mon: m.face ? face : m.mon }));
}

/** Stages worked out from the links: a Mega or form shares the stage of the one it's a form of. */
function staged(members: LineMember[]): LineMember[] {
    const byId = new Map(members.map(m => [m.sourceId, m]));
    const memo = new Map<string, number>();
    const stageOf = (m: LineMember, seen: Set<string>): number => {
        if (memo.has(m.sourceId)) return memo.get(m.sourceId)!;
        const parent = m.from && !seen.has(m.from) ? byId.get(m.from) : undefined;
        const s = parent ? stageOf(parent, new Set([...seen, m.sourceId])) + (m.isMega || m.isFormeChange ? 0 : 1) : 1;
        memo.set(m.sourceId, Math.min(20, s));
        return memo.get(m.sourceId)!;
    };
    return members
        .map(m => ({ ...m, from: m.from && byId.has(m.from) && m.from !== m.sourceId ? m.from : null, stage: stageOf(m, new Set([m.sourceId])) }))
        .sort((a, b) => a.stage - b.stage || Number(!!(a.isMega || a.isFormeChange)) - Number(!!(b.isMega || b.isFormeChange)));
}

/** The member cards and lists show: the last stage (Megas and forms don't count as later). */
function faceOf(members: LineMember[]): LineMember {
    const bases = members.filter(m => !m.isMega && !m.isFormeChange);
    const pool = bases.length ? bases : members;
    return pool.reduce((best, m) => (m.stage > best.stage ? m : best), pool[0]);
}

/** A line back into an answer: the face's Fakémon, with the rest as `family`. */
export function packLine(members: LineMember[]): any {
    if (!members.length) return null;
    const list = staged(members);
    if (list.length === 1) return { ...list[0].mon };
    const face = faceOf(list);
    return {
        ...face.mon,
        family: list.map(({ mon, face: _f, ...meta }) => {
            const clean = { ...meta, method: String(meta.method || '').trim().slice(0, 120) || undefined, isMega: meta.isMega || undefined, isFormeChange: meta.isFormeChange || undefined };
            return meta.sourceId === face.sourceId ? { ...clean, face: true } : { ...clean, mon };
        })
    };
}

/**
 * packLine, made to fit: when the line's pictures are too heavy together
 * they're shrunk to share the room, and only the face keeps its cry.
 */
export async function packLineForEntry(members: LineMember[]): Promise<any> {
    if (members.length > LINE_MAX) throw new Error(`An entry can hold at most ${LINE_MAX} Fakémon.`);
    let value = packLine(members);
    if (members.length < 2 || JSON.stringify(value).length <= LINE_CHARS) return value;
    const face = faceOf(staged(members));
    const images = members.reduce((n, m) => n + (m.mon?.artwork ? 1 : 0) + (m.mon?.shinyArtwork ? 1 : 0), 0);
    const budget = Math.max(120_000, Math.floor((LINE_CHARS - 400_000) / Math.max(1, images)));
    const fitted = await Promise.all(members.map(async m => {
        const mon = { ...m.mon };
        if (m.sourceId !== face.sourceId) delete mon.cry;
        for (const k of ['artwork', 'shinyArtwork']) {
            if (typeof mon[k] === 'string' && mon[k].length > budget) mon[k] = await shrinkImage(mon[k], 1000, budget).catch(() => '');
            if (!mon[k]) delete mon[k];
        }
        return { ...m, mon };
    }));
    value = packLine(fitted);
    if (JSON.stringify(value).length > LINE_CHARS) throw new Error('That line is too large to enter. Try smaller artwork, or fewer Fakémon.');
    return value;
}

/**
 * A Fakémon from your collection with everything its evolution board connects
 * it to (the Community upload's rule): each one's stage, what it evolves from,
 * and how ("Level 16"). `pool`: where the others are looked up (a whole
 * collection export works too).
 */
export async function fakemonLineForEntry(mon: any, pool: any[] = state.fakemonDB || []): Promise<any> {
    const g = mon?.evolutionGraph;
    const nodes: any[] = Array.isArray(g?.nodes) && Array.isArray(g?.edges) ? g.nodes.filter((n: any) => n.kind === 'fakemon' && n.refId) : [];
    const find = (id: any) => String(id) === String(mon.id) ? mon : pool.find((x: any) => x?.id != null && String(x.id) === String(id));
    const picked: Array<{ node: any; mon: any }> = [];
    for (const node of nodes) {
        const f = find(node.refId);
        // a main-game Pokémon on the board, or a Fakémon no longer in the collection
        if (!f || picked.some(p => String(p.mon.id) === String(f.id))) continue;
        picked.push({ node, mon: f });
    }
    if (!picked.some(p => String(p.mon.id) === String(mon.id))) picked.push({ node: null, mon });
    if (picked.length < 2) return fakemonForEntry(mon);
    if (picked.length > LINE_MAX) throw new Error(`That evolution line has ${picked.length} Fakémon; an entry can hold at most ${LINE_MAX}.`);

    // collection ids, made safe to store (clean_event_fakemon takes [A-Za-z0-9_.:-], up to 64)
    const safe = new Map(picked.map(p => [String(p.mon.id), String(p.mon.id).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64) || newSourceId()]));
    const methods: Map<string, any> = api.getEdgeMethodMap?.(g) || new Map();
    const nodeOf = (refId: string) => g.nodes.find((n: any) => n.kind === 'fakemon' && String(n.refId) === refId);
    const members: LineMember[] = [];
    for (const p of picked) {
        const id = String(p.mon.id);
        const from = ((api.prevolutionRefIds?.(g, id) || []) as string[]).find(x => safe.has(x)) || null;
        let method = '';
        const a = from && nodeOf(from), b = p.node || nodeOf(id);
        const methodNode = a && b ? (methods.get(`${a.id}->${b.id}`) ?? methods.get(`${b.id}->${a.id}`)) : null;
        if (methodNode) method = api.getMethodSummary?.(methodNode) || '';
        members.push({
            sourceId: safe.get(id)!, stage: 1, from: from ? safe.get(from)! : null, method,
            isMega: !!(p.node?.isMega ?? p.mon.isMega), isFormeChange: !!(p.node?.isFormeChange ?? p.mon.isFormeChange),
            mon: await fakemonForEntry(p.mon)
        });
    }
    return packLineForEntry(members);
}

/** How a line member is labelled: "Stage 2", "Mega", "Form". */
export const lineLabel = (m: LineMember) => m.isMega ? 'Mega' : m.isFormeChange ? 'Form' : `Stage ${m.stage}`;

/** The Fakémon in a Woogidex export (one Fakémon, a list, or a whole collection backup) or a plain-text export. */
export async function fakemonFromFile(file: File): Promise<any[]> {
    return fakemonFromText(await file.text());
}

/** fakemonFromFile's reading, for text pasted in (a plain-text export, or the JSON itself). */
export function fakemonFromText(text: string): any[] {
    if (!String(text || '').trim()) throw new Error('Paste a Woogidex export first.');
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { try { parsed = api.parsePlainTextFakemon?.(text); } catch { parsed = null; } }
    const list = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed?.fakemons) ? parsed.fakemons
        : Array.isArray(parsed?.fakemonDB) ? parsed.fakemonDB
        : Array.isArray(parsed?.collection) ? parsed.collection
        : parsed?.fakemon ? [parsed.fakemon] : [parsed];
    // a text export can be missing its name; the details dialog asks for it
    const mons = list.filter((m: any) => m && typeof m === 'object' && (m.name || m.species || m.type1));
    if (!mons.length) throw new Error('No Fakémon found in that. Use a Woogidex export (plain text or .json).');
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

// ---- Fakémon rules ----

export const MON_PARTS: Array<[MonPart, string]> = [['artwork', 'artwork'], ['shiny', 'shiny artwork'], ['abilities', 'abilities'], ['dex', 'a Pokédex entry'], ['moves', 'a learnset'], ['sets', 'sample sets']];
const isCustomType = (t?: string) => !!t && !ALL_VANILLA_TYPES.includes(t);
const isCustom = (x: any) => x?.custom === true || x?.source === 'custom';
export const monBst = (m: any) => ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].reduce((n, k) => n + (Number(m?.stats?.[k]) || 0), 0);

/** One Fakémon against the rules. Type and BST rules are the final evolution's (`face`) alone. */
function oneMonProblems(m: any, r: MonRules, face: boolean): string[] {
    const out: string[] = [];
    const has: Record<MonPart, boolean> = {
        artwork: !!m.artwork, shiny: !!m.shinyArtwork, abilities: (m.abilities || []).some((a: any) => String(a?.name || '').trim()),
        dex: !!String(m.dexEntry1 || '').trim(), moves: (m.learnset || []).length > 0, sets: (m.sampleSets || []).length > 0
    };
    for (const [part, words] of MON_PARTS) if (r.require?.includes(part) && !has[part]) out.push(`needs ${words}`);
    if (r.noCustomTypes && (isCustomType(m.type1) || isCustomType(m.type2))) out.push("can't have a custom type");
    if (r.noCustomAbilities && (m.abilities || []).some(isCustom)) out.push("can't have a custom ability");
    if (r.noCustomMoves && ((m.learnset || []).some(isCustom) || (m.customMoves || []).length)) out.push("can't have custom moves");
    if (!face) return out;
    if (r.types?.length && !r.types.includes(m.type1) && !r.types.includes(m.type2)) out.push(`must be ${r.types.join(' or ')} type`);
    const bst = monBst(m);
    if (r.minBst && bst < r.minBst) out.push(`needs a BST of at least ${r.minBst}`);
    if (r.maxBst && bst > r.maxBst) out.push(`needs a BST of at most ${r.maxBst}`);
    return out;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const lowName = (x: any) => String(x?.name || '').trim().toLowerCase();

/** The custom moves, abilities and types across a line, each counted once. */
export function lineCustoms(members: LineMember[]): { moves: number; abilities: number; types: number } {
    const moves = new Set<string>(), abilities = new Set<string>(), types = new Set<string>();
    for (const { mon: m } of members) {
        (m?.learnset || []).filter(isCustom).forEach((x: any) => moves.add(lowName(x)));
        (m?.customMoves || []).forEach((x: any) => moves.add(lowName(x)));
        (m?.abilities || []).filter(isCustom).forEach((x: any) => abilities.add(lowName(x)));
        [m?.type1, m?.type2].filter(isCustomType).forEach((t: string) => types.add(t.toLowerCase()));
    }
    for (const s of [moves, abilities, types]) s.delete('');
    return { moves: moves.size, abilities: abilities.size, types: types.size };
}

/**
 * What a Fakémon answer (one Fakémon, or a line) breaks of a question's
 * rules, as clauses ready to follow "For this event, " ([] when it's fine).
 * event_fakemon_problem in the database checks the same.
 */
export function monRuleProblems(v: any, r?: MonRules): string[] {
    if (!v || !r) return [];
    const members = lineOf(v);
    const many = members.length > 1;
    const faceId = many ? faceOf(staged(members)).sourceId : members[0]?.sourceId;
    const out: string[] = [];
    for (const m of members) {
        const who = many ? (String(m.mon?.name || '').trim() || 'one of your Fakémon') : 'your Fakémon';
        for (const p of oneMonProblems(m.mon || {}, r, m.sourceId === faceId)) out.push(`${who} ${p}`);
    }
    const n = members.length;
    if (r.maxLine && n > r.maxLine) out.push(r.maxLine === 1 ? "evolutions and forms aren't allowed, so enter just the one Fakémon" : `the line has ${n} Fakémon, but at most ${r.maxLine} are allowed`);
    if (r.minLine && n < r.minLine) out.push(`the entry needs an evolution line of at least ${r.minLine} Fakémon`);
    if (r.noForms && members.some(m => m.isMega || m.isFormeChange)) out.push("Megas and other forms aren't allowed");
    const c = lineCustoms(members);
    const has = many ? 'the line has' : 'your Fakémon has';
    if (r.maxCustomMoves != null && c.moves > r.maxCustomMoves) out.push(`${has} ${plural(c.moves, 'custom move')}, but at most ${r.maxCustomMoves} ${r.maxCustomMoves === 1 ? 'is' : 'are'} allowed`);
    if (r.maxCustomAbilities != null && c.abilities > r.maxCustomAbilities) out.push(`${has} ${plural(c.abilities, 'custom ability', 'custom abilities')}, but at most ${r.maxCustomAbilities} ${r.maxCustomAbilities === 1 ? 'is' : 'are'} allowed`);
    const total = c.moves + c.abilities + c.types;
    if (r.maxCustomTotal != null && total > r.maxCustomTotal) out.push(`${has} ${total} custom moves, abilities and types together, but at most ${r.maxCustomTotal} ${r.maxCustomTotal === 1 ? 'is' : 'are'} allowed`);
    return out;
}

/** One Fakémon's own problems (no line rules), each a clause about "your Fakémon". */
export const memberRuleProblems = (m: any, r: MonRules | undefined, face = true) =>
    m && r ? oneMonProblems(m, r, face).map(p => `your Fakémon ${p}`) : [];

/** monRuleProblems as one sentence. */
export const monRuleSentence = (problems: string[]) => problems.length ? `For this event, ${problems.join('; ')}.` : '';

/** The rules in words, for entrants. */
export function describeMonRules(r?: MonRules): string[] {
    if (!r) return [];
    const out: string[] = [];
    const lines = r.maxLine !== 1;
    const parts = MON_PARTS.filter(([p]) => r.require?.includes(p)).map(([, w]) => w);
    if (parts.length) out.push(`${lines ? 'Each Fakémon must have' : 'Must have'} ${parts.join(', ')}`);
    const last = lines ? ' (the final evolution)' : '';
    if (r.types?.length) out.push(`Must be ${r.types.join(' or ')} type${last}`);
    if (r.minBst && r.maxBst) out.push(`BST between ${r.minBst} and ${r.maxBst}${last}`);
    else if (r.minBst) out.push(`BST of at least ${r.minBst}${last}`);
    else if (r.maxBst) out.push(`BST of at most ${r.maxBst}${last}`);
    if (r.maxLine === 1) out.push('One Fakémon only: no evolutions or forms');
    else if (r.minLine && r.maxLine) out.push(r.minLine === r.maxLine ? `An evolution line of exactly ${r.maxLine} Fakémon` : `An evolution line of ${r.minLine} to ${r.maxLine} Fakémon`);
    else if (r.maxLine) out.push(`Up to ${r.maxLine} Fakémon in the line, Megas and forms included`);
    else if (r.minLine) out.push(`An evolution line of at least ${r.minLine} Fakémon`);
    if (r.noForms && r.maxLine !== 1) out.push('No Megas or other forms');
    const across = lines ? ' across the line' : '';
    if (r.noCustomTypes) out.push('No custom types');
    if (r.noCustomAbilities) out.push('No custom abilities');
    else if (r.maxCustomAbilities != null) out.push(`Up to ${plural(r.maxCustomAbilities, 'custom ability', 'custom abilities')}${across}`);
    if (r.noCustomMoves) out.push('No custom moves');
    else if (r.maxCustomMoves != null) out.push(`Up to ${plural(r.maxCustomMoves, 'custom move')}${across}`);
    if (r.maxCustomTotal != null) out.push(`Up to ${r.maxCustomTotal} custom moves, abilities and types combined${across}`);
    return out;
}

// ---- moves, abilities, items and types as answers ----

export const LIB_KINDS: Array<[LibKind, string, string]> = [['move', 'Move', 'bolt'], ['ability', 'Ability', 'sparkles'], ['item', 'Item', 'shopping-bag'], ['type', 'Type', 'swatch']];
export const libLabel = (k: LibKind) => LIB_KINDS.find(x => x[0] === k)?.[1] || 'Entry';

/** Your own moves, abilities, items and types, of the kinds a question takes. */
export function myLibrary(kinds: LibKind[]): any[] {
    const from = (kind: LibKind, list: any[]) => kinds.includes(kind) ? (list || []).map(x => ({ ...x, kind })) : [];
    return [
        ...from('move', state.customMoves), ...from('ability', state.customAbilities),
        ...from('item', state.customItems), ...from('type', api.getCustomTypes?.() || [])
    ];
}

/** One ready to go in an entry: no collection bookkeeping, its picture small (the database caps it at 600 KB). */
export async function libraryForEntry(item: any): Promise<any> {
    const copy = JSON.parse(JSON.stringify(item));
    for (const k of ['id', 'createdAt', 'updatedAt', 'regionIds', 'folderId', 'pinned', 'vanillaOf', 'customId']) delete copy[k];
    copy.name = String(copy.name || '').trim().slice(0, NAME_MAX);
    if (typeof copy.artwork === 'string' && copy.artwork.startsWith('data:image/')) copy.artwork = await shrinkImage(copy.artwork, 512, 380_000).catch(() => '');
    if (!copy.artwork) delete copy.artwork;
    if (JSON.stringify(copy).length > 550_000) throw new Error('That one is too large to enter.');
    return copy;
}

/** The moves, abilities, items and types in a Woogidex file: one exported entry, or a whole collection. */
export async function libraryFromFile(file: File, kinds: LibKind[]): Promise<any[]> {
    let parsed: any;
    try { parsed = JSON.parse(await file.text()); } catch { throw new Error("That file isn't a Woogidex export (.json)."); }
    const one: Record<string, LibKind> = { 'woogidex-custom-move': 'move', 'woogidex-custom-ability': 'ability', 'woogidex-custom-item': 'item' };
    const found: any[] = [];
    if (one[parsed?.format] && parsed.item) found.push({ ...parsed.item, kind: one[parsed.format] });
    for (const [key, kind] of [['customMoves', 'move'], ['customAbilities', 'ability'], ['customItems', 'item'], ['customTypes', 'type']] as Array<[string, LibKind]>) {
        if (Array.isArray(parsed?.[key])) found.push(...parsed[key].map((x: any) => ({ ...x, kind })));
    }
    if (!found.length && parsed?.type === 'custom-type') found.push({ ...parsed, kind: 'type' });
    const usable = found.filter(x => x && typeof x === 'object' && x.name && kinds.includes(x.kind));
    if (!usable.length) throw new Error(`No ${kinds.map(k => libLabel(k).toLowerCase()).join(', ')} found in that file.`);
    return usable;
}

// ---- your event templates ----
// An event's setup (form, voting, rules, about, team) without its dates or
// link, to start new events from. Saved to your account (event_templates), so
// they follow you between devices; the list loads names only, a template's
// contents load when you use it. Templates from before that, kept on one
// device, move to the account the first time the list loads there.

export interface EventTemplate { id: string; name: string; savedAt: number; values?: any; }
const templateState: { userId: string | null; status: 'idle' | 'loading' | 'ready' | 'error'; list: EventTemplate[]; local: boolean } = { userId: null, status: 'idle', list: [], local: false };
const oldTemplatesKey = () => `woogidex.eventTemplates.${me()}`;
const readLocalTemplates = (): EventTemplate[] => {
    try { const list = JSON.parse(localStorage.getItem(oldTemplatesKey()) || '[]'); return Array.isArray(list) ? list : []; } catch { return []; }
};
/** What a template keeps: the setup, not the dates or the link. */
const templateValues = (values: any) => {
    const { submissions_open_at, submissions_close_at, voting_open_at, voting_close_at, results_at, slug, ...setup } = values;
    return setup;
};

/** Your templates (names only), loading them the first time they're asked for. */
export function readEventTemplates(): EventTemplate[] {
    if (me() && templateState.userId !== me()) { templateState.userId = me(); templateState.status = 'idle'; templateState.list = []; }
    if (me() && templateState.status === 'idle') loadEventTemplates();
    return templateState.list;
}
export const eventTemplatesStatus = () => templateState.status;

export async function loadEventTemplates() {
    if (!me()) return;
    templateState.status = 'loading';
    notify();
    try {
        const c = await client();
        // one device's templates from before move to the account, once
        const local = readLocalTemplates();
        if (local.length) {
            const { error } = await c.from('event_templates').upsert(local.map(t => ({ name: t.name.slice(0, 60), values: templateValues(t.values || {}) })), { onConflict: 'owner_id,name' });
            if (!error) { try { localStorage.removeItem(oldTemplatesKey()); } catch { /* private mode */ } }
        }
        const { data, error } = await c.from('event_templates').select('id,name,updated_at').order('updated_at', { ascending: false });
        if (error) throw error;
        templateState.list = (data || []).map((t: any) => ({ id: t.id, name: t.name, savedAt: Date.parse(t.updated_at) }));
        templateState.local = false;
        templateState.status = 'ready';
    } catch {
        // the table isn't there yet (or the network failed): this device's own list
        templateState.list = readLocalTemplates();
        templateState.local = true;
        templateState.status = 'ready';
    }
    notify();
}

/** A template's contents, to apply. */
export async function templateContents(t: EventTemplate): Promise<any | null> {
    if (t.values) return t.values;
    try {
        const { data, error } = await (await client()).from('event_templates').select('values').eq('id', t.id).single();
        if (error) throw error;
        return data.values;
    } catch (e) { fail(e); return null; }
}

/** Saves (or, by the same name, replaces) a template. */
export async function saveEventTemplate(name: string, values: any): Promise<boolean> {
    const setup = templateValues(values);
    try {
        if (templateState.local) throw new Error('local');
        const c = await client();
        const { error } = await c.from('event_templates').upsert({ name, values: setup }, { onConflict: 'owner_id,name' });
        if (error) {
            // too big with its cover: keep it without one
            if (/values_check|check constraint/i.test(error.message) && setup.cover_image) {
                const again = await c.from('event_templates').upsert({ name, values: { ...setup, cover_image: null, cover_thumb: null } }, { onConflict: 'owner_id,name' });
                if (again.error) throw again.error;
            } else throw error;
        }
        toast(`Saved "${name}" as a template. It's on your account, on every device.`, 'success');
        await loadEventTemplates();
        return true;
    } catch (e: any) {
        if (e?.message !== 'local') { fail(e); return false; }
        const others = readLocalTemplates().filter(t => t.name.toLowerCase() !== name.toLowerCase());
        const entry = (v: any): EventTemplate => ({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, savedAt: Date.now(), values: v });
        const write = (list: EventTemplate[]) => { try { localStorage.setItem(oldTemplatesKey(), JSON.stringify(list)); return true; } catch { return false; } };
        const ok = write([entry(setup), ...others]) || write([entry({ ...setup, cover_image: null }), ...others]);
        toast(ok ? `Saved "${name}" as a template on this device.` : 'Couldn\'t save the template: this device\'s storage is full.', ok ? 'success' : 'error');
        templateState.list = readLocalTemplates();
        notify();
        return ok;
    }
}

export async function deleteEventTemplate(t: EventTemplate) {
    if (!await confirmDialog({ title: `Delete "${t.name}"?`, message: 'The template goes for good. Events made from it are untouched.', confirmLabel: 'Delete template', danger: true })) return;
    if (templateState.local) {
        try { localStorage.setItem(oldTemplatesKey(), JSON.stringify(readLocalTemplates().filter(x => x.id !== t.id))); } catch { /* private mode */ }
        templateState.list = readLocalTemplates();
        notify();
        return;
    }
    try {
        const { error } = await (await client()).from('event_templates').delete().eq('id', t.id);
        if (error) throw error;
        await loadEventTemplates();
    } catch (e) { fail(e); }
}

/** A template picked from the list page, for the new-event editor to start from. */
export const pendingTemplate: { values: { values: any; name: string } | null } = { values: null };

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

/** One spreadsheet cell: pictures as [image], a Fakémon (or its whole line) by name, and never a formula. */
function csvCell(v: any): string {
    const s = v == null ? '' : Array.isArray(v) ? v.join(', ')
        : typeof v === 'object' ? (Array.isArray(v.family) && v.family.length > 1 ? lineOf(v).map(m => m.mon?.name || '?').join(' → ') : (v.name || ''))
        : String(v);
    const text = s.startsWith('data:') ? '[image]' : s;
    // =, +, -, @ would run as a formula when the sheet is opened
    return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
}

/** Every entry with every answer (private ones too, when you may see them) as a CSV download. */
export function exportEntriesCsv() {
    const d = events.detail;
    if (!d?.event) return;
    const ev = d.event;
    const cell = csvCell;
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

/**
 * Every entry with every answer (private ones too, when you may see them) as
 * a JSON download: answers as they're stored, pictures and Fakémon in full,
 * so nothing is flattened the way a spreadsheet does. Entries not opened yet
 * are loaded in full first, a few at a time.
 */
export async function exportEntriesJson() {
    const d = events.detail;
    if (!d?.event) return;
    const ev = d.event;
    const results = new Map((d.results || []).map(r => [r.entry_id, r]));
    const full: Record<string, Record<string, any>> = {};
    for (let i = 0; i < d.entries.length; i += 6) {
        await Promise.all(d.entries.slice(i, i + 6).map(async en => { full[en.id] = (await loadFullEntry(en)) || en.answers; }));
    }
    const payload = {
        event_id: ev.id, event_title: ev.title, exported_at: new Date().toISOString(),
        questions: ev.form.filter(f => f.type !== 'section').map(f => ({ id: f.id, label: f.label, type: f.type })),
        entries: d.entries.map(en => {
            const p = d.people[en.user_id || ''];
            const r = results.get(en.id);
            return {
                entry_id: en.id, title: entryTitle(ev, en, d.people),
                entrant: en.user_id ? { user_id: en.user_id, username: p?.username || null } : null,
                submitted_at: en.created_at, placement: en.placement ?? null,
                votes: r?.votes ?? null, points_percent: r?.points_percent ?? null,
                answers: full[en.id] || en.answers, private_answers: d.privateAnswers[en.id] || null
            };
        })
    };
    download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${fileSlug(ev.title)}-entries.json`);
}
