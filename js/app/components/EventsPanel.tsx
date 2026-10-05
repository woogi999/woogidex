// The Community Hub's Events panel: the list of events, one event's page (the
// link entrants are sent), its voting (a quick vote, judges' scores, or the
// Fakémon-contest ballot), the organizer dashboard, and the event editor with
// its live preview. Data and actions are js/features/events.ts; the database
// enforces who may do what.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, state } from '../../core/app.ts';
import { routeUrl } from '../../core/router.ts';
import { confirmDialog } from '../../core/confirm-dialog.ts';
import { SELECTABLE_TYPES } from '../../core/data.ts';
import {
    isPrivateField, CATEGORIES, DEFAULT_CRITERIA, FIELD_TYPES, SLUG_PATTERN, VOTE_FIELD_TYPES, answered, criteriaOf, detailFor, formPages, hasOptions, voteAnswersOk, isGuestView, remarksOk, saveResultsPost, standingsMarkdown, toggleEventRepost, PHASES, STAGE_LABEL, addHelper, autofillFor, ballotEntries,
    canCreateEvents, castVote, clearEventDraft, closeBallot, computeWinners, copyLink, createEvent, dashboardLink, deleteEvent,
    describeWinnerRules, effectivePhase, entryAllowance, entryImage, entryTitle, events, exportEntriesCsv, exportVotesJson,
    fakemonForEntry, fakemonFromFile, fmtDate, hasSubmittedBallot, isLive, isPast, loadEvent, loadEventsList, permsFor,
    previewEventFakemon, ranked, readEventDraft, relTime, removeEntry, removeEntryLimit, removeHelper, saveEvent, scoresComplete,
    setEntryLimit, setPhase, setPlacement, shareLink, showEventView, shrinkImage, startBallot, submitBallot, submitEntry,
    readEventTemplates, saveEventTemplate, deleteEventTemplate, removeEntryAsTeam, findPeople,
    takingEntries, updateBallot, updateEntry, updateHelper, votingOpen, writeEventDraft, readEntryDraft, writeEntryDraft, clearEntryDraft,
    myTimeZone, timeZones, zonedParts, zonedToUtc,
    LIB_KINDS, MON_PARTS, describeMonRules, libLabel, libraryForEntry, libraryFromFile, memberRuleProblems, monRuleProblems, monRuleSentence, myLibrary,
    LINE_MAX, fakemonLineForEntry, lineLabel, lineOf, newSourceId, packLineForEntry,
    type LibKind, type LineMember, type MonRules,
    type DashTab, type Detail, type Entry, type EventRow, type Field, type FieldType, type Helper, type Person, type Phase,
    createEventCode, deleteEventCode, randomCode, redeemEventCode, voteDisplay,
    canSeeEntries, entriesPublic, VARIABLES, variablesFor, fillVariables, setFollowing, postAnnouncement, deleteAnnouncement,
    requestEntryEdit, publishResults, createSheetLink, deleteSheetLink, sheetUrl, sheetFormula,
    type Announcement, type HelperPerms, type TeamPick,
    TIE_RULES, placeLabel, loadFullEntry, fullAnswers, sampleVariables, sendFeedback, votesFor, compileFeedback, exportVotesCsv,
    templateContents, eventTemplatesStatus, pendingTemplate, type EventTemplate, type RankRow, type TieRule,
    type Criterion, type EventCode, type EventTab, type Remarks, type Stage, type Voting, type WinnerRules
} from '../../features/events.ts';
import { Avatar } from './Avatar.tsx';
import { EmojiInput, RichText } from './EmojiInput.tsx';
import { Icon } from './Icon.tsx';
import { Modal } from './Modal.tsx';
import { PokedexBoard } from './board/PokedexBoard.tsx';
import { EvoStrip } from './board/CommunityEvoStrip.tsx';
import { openDialog, registerDialog, type DialogProps } from '../dialogs.tsx';
import { cropThen } from '../dialogs/cropImage.tsx';
import { useStore } from '../store.ts';

export function EventsPanel() {
    useStore();
    const v = events.view;
    if (v.kind === 'new') return <EventEditor event={null} />;
    if (v.kind === 'event') {
        const d = detailFor(v.id);
        return events.ballot && d?.event && events.ballot.eventId === d.event.id ? <BallotView ev={d.event} /> : <EventPage id={v.id} tab={v.tab || 'about'} />;
    }
    if (v.kind === 'dashboard') return <Dashboard id={v.id} tab={v.tab || 'overview'} />;
    return <EventsList />;
}

const personName = (p?: Person) => p ? (p.display_name || p.username || 'Someone') : 'Someone';
/** Who sent an entry: nobody we can name for a guest's (public events) or for a guest reader. */
const authorOf = (d: Detail, en: Entry) => en.user_id ? d.people[en.user_id] : undefined;
const authorName = (d: Detail, en: Entry) => !en.user_id ? 'Guest' : d.people[en.user_id] ? personName(d.people[en.user_id]) : 'A member';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function PhasePill({ ev }: { ev: EventRow }) {
    const stage = effectivePhase(ev);
    return (
        <span className={`ev-pill ev-pill-${stage}`}>{STAGE_LABEL[stage]}</span>
    );
}

function BackLink({ to, children }: { to: Parameters<typeof showEventView>[0]; children: ReactNode }) {
    return <button type="button" className="ev-back" data-leave-guard onClick={() => showEventView(to)}><Icon name="arrow-left" size={14} />{children}</button>;
}

// ==================== the list: every event a ticket ====================

function EventsList() {
    const mine = events.list.filter(e => permsFor(e).view);
    const others = events.list.filter(e => !permsFor(e).view && e.phase !== 'draft');
    const live = others.filter(isLive);
    const rest = others.filter(e => !isLive(e));
    const loading = events.status === 'loading' && !events.list.length;
    const draft = canCreateEvents() ? readEventDraft(null) : null;
    return (
        <div className="ev-list-page">
            <header className="ev-list-head">
                <div>
                    <h2>Events</h2>
                    <p>Contests, competitions and sign-ups run by the community.</p>
                </div>
                <div className="ev-head-actions">
                    <button className="btn btn-secondary" type="button" onClick={loadEventsList} aria-label="Refresh events"><Icon name="arrow-path" size={15} className={events.status === 'loading' ? 'spin' : ''} /></button>
                    {canCreateEvents() && <button className="btn btn-secondary" type="button"
                        onClick={() => openDialog('event-templates', { onLoad: (values: any, name: string) => { pendingTemplate.values = { values, name }; showEventView({ kind: 'new' }); } })}>
                        <Icon name="folder-open" />From a template</button>}
                    {canCreateEvents() && <button className="btn btn-primary" type="button" onClick={() => showEventView({ kind: 'new' })}><Icon name="plus" />Create event</button>}
                </div>
            </header>

            {events.status === 'error' && (
                <div className="ev-empty"><Icon name="exclamation-triangle" size={22} /><p>Events could not load. {events.error}</p>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={loadEventsList}>Try again</button></div>
            )}
            {loading && <ListSkeleton />}

            {draft && (
                <button type="button" className="ev-draft-banner" onClick={() => showEventView({ kind: 'new' })}>
                    <Icon name="pencil-square" size={18} />
                    <span><strong>You have an unfinished event</strong><small>{draft.values?.title || 'Untitled'} · saved {relTime(new Date(draft.savedAt).toISOString())}</small></span>
                    <span className="ev-draft-banner-go">Continue<Icon name="chevron-right" size={14} /></span>
                </button>
            )}

            {mine.length > 0 && (
                <section className="ev-section">
                    <h3 className="ev-section-title">Your events</h3>
                    <div className="ev-tickets">{mine.map(e => <Ticket key={e.id} ev={e} manage />)}</div>
                </section>
            )}
            {live.length > 0 && (
                <section className="ev-section">
                    <h3 className="ev-section-title">Happening now</h3>
                    <div className="ev-tickets">{live.map(e => <Ticket key={e.id} ev={e} />)}</div>
                </section>
            )}
            {rest.length > 0 && (
                <section className="ev-section">
                    <h3 className="ev-section-title">{live.length ? 'Other events' : 'All events'}</h3>
                    <div className="ev-tickets">{rest.map(e => <Ticket key={e.id} ev={e} />)}</div>
                </section>
            )}
            {!loading && events.status !== 'error' && !events.list.length && (
                <div className="ev-empty">
                    <Icon name="trophy" size={28} />
                    <h4>No events yet</h4>
                    <p>{canCreateEvents()
                        ? 'Run the first one: a PoA contest, a poster competition, sign-ups for a tournament. You decide what entrants send in and how winners are picked.'
                        : 'When an organizer opens an event, it shows up here. Enter it from this page or the link they share.'}</p>
                    {canCreateEvents() && <button className="btn btn-primary" type="button" onClick={() => showEventView({ kind: 'new' })}><Icon name="plus" />Create event</button>}
                </div>
            )}
        </div>
    );
}

function ListSkeleton() {
    return (
        <div className="ev-tickets" aria-busy="true">
            {[0, 1, 2].map(i => (
                <div className="ev-ticket is-skeleton" key={i}><div className="ev-ticket-shape">
                    <span className="ev-ticket-main">
                        <span className="skel ev-ticket-art" />
                        <span className="ev-ticket-body">
                            <span className="skel skel-text" style={{ width: '30%' }} />
                            <span className="skel skel-text" style={{ width: '70%', height: 20 }} />
                            <span className="skel skel-text" style={{ width: '50%' }} />
                        </span>
                    </span>
                    <span className="ev-ticket-stub"><span className="skel skel-text" style={{ width: '70%' }} /></span>
                </div></div>
            ))}
        </div>
    );
}

function Cover({ ev, className }: { ev: Pick<EventRow, 'cover_image' | 'cover_thumb'>; className: string }) {
    const src = ev.cover_thumb || ev.cover_image;
    return (
        <div className={`${className} ev-cover`} aria-hidden="true">
            {src ? <img src={src} alt="" draggable={false} /> : <Icon name="trophy" size={28} />}
        </div>
    );
}

/** The date that matters right now, for the ticket stub: [what, when]. */
function keyDate(ev: EventRow): [string, string | null] {
    const stage = effectivePhase(ev);
    if (stage === 'upcoming') return ['Entries open', ev.submissions_open_at];
    if (stage === 'open') return ['Entries close', ev.submissions_close_at];
    if (stage === 'closed') return ['Voting opens', ev.voting_open_at && !isPast(ev.voting_open_at) ? ev.voting_open_at : null];
    if (stage === 'voting') return ['Voting closes', ev.voting_close_at];
    if (stage === 'tallying') return ['Results', ev.results_at];
    return ['Ended', null];
}

const stubDate = (v: string | null) => v ? new Date(v).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';

/** An event as a ticket: the event on the left, where it's at on the tear-off stub. */
function Ticket({ ev, manage = false }: { ev: EventRow; manage?: boolean }) {
    const p = permsFor(ev);
    const [what, when] = keyDate(ev);
    const open = () => showEventView({ kind: 'event', id: ev.slug || ev.id, tab: 'about' });
    return (
        // the outer box draws the shadow, the inner one is cut to a ticket's shape (a mask would clip the shadow)
        <div className={`ev-ticket${isLive(ev) ? ' is-live' : ''}`}><div className="ev-ticket-shape">
            <button type="button" className="ev-ticket-main" onClick={open} aria-label={`${ev.title}, ${STAGE_LABEL[effectivePhase(ev)]}`}>
                <Cover ev={ev} className="ev-ticket-art" />
                <span className="ev-ticket-body">
                    <span className="ev-meta-line">{ev.category || 'Event'}</span>
                    <strong className="ev-ticket-title">{ev.title}</strong>
                    {ev.tagline && <span className="ev-ticket-tagline">{ev.tagline}</span>}
                </span>
            </button>
            <div className="ev-ticket-stub">
                <PhasePill ev={ev} />
                <span className="ev-stub-what">{what}</span>
                {when && <span className="ev-stub-when">{stubDate(when)}</span>}
                {when && <span className="ev-stub-rel">{relTime(when)}</span>}
                {manage
                    ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => showEventView({ kind: 'dashboard', id: ev.slug || ev.id })}><Icon name="chart-bar" size={14} />{p.owner && ev.owner_id === state.user?.id ? 'Dashboard' : 'Team'}</button>
                    : <span className="ev-stub-go" aria-hidden="true">View<Icon name="arrow-right" size={13} /></span>}
            </div>
        </div></div>
    );
}

// ==================== one event ====================

function useDetail(id: string) {
    useEffect(() => { if (!detailFor(id)) loadEvent(id); }, [id]);
    return detailFor(id);
}

function DetailState({ d }: { d: Detail | null }) {
    if (d?.status === 'error') {
        return (
            <div className="ev-empty">
                <Icon name="exclamation-triangle" size={24} />
                <h4>This event can't be shown</h4>
                <p>{state.user ? d.error : 'It may be for Woogidex members only. Sign in to see it.'}</p>
                {state.user
                    ? <button className="btn btn-secondary btn-sm" type="button" onClick={() => showEventView({ kind: 'list' })}>See all events</button>
                    : <button className="btn btn-primary btn-sm" type="button" onClick={() => api.openAuthModal?.('signin')}>Sign in</button>}
            </div>
        );
    }
    return (
        <div aria-busy="true">
            <span className="skel ev-banner" style={{ display: 'block' }} />
            <span className="skel skel-text" style={{ width: '45%', height: 26, marginTop: 20 }} />
            <span className="skel skel-text" style={{ width: '70%' }} />
            <span className="skel skel-text" style={{ width: '60%' }} />
        </div>
    );
}

function Timeline({ ev }: { ev: EventRow }) {
    const stage = effectivePhase(ev);
    // each step: 0 not yet, 1 now, 2 done
    const order: Stage[] = ['draft', 'upcoming', 'open', 'closed', 'voting', 'tallying', 'ended'];
    const at = order.indexOf(stage);
    const status = (step: Stage) => at > order.indexOf(step) ? 2 : at === order.indexOf(step) ? 1 : 0;
    const range = (open: string | null, close: string | null) => [open && `${isPast(open) ? 'opened' : 'opens'} ${fmtDate(open)}`, close && `${isPast(close) ? 'closed' : 'until'} ${fmtDate(close)}`].filter(Boolean) as string[];
    const steps: Array<[string, number, string[]]> = [
        ['Entries', status('open'), range(ev.submissions_open_at, ev.submissions_close_at)],
        ...(ev.voting !== 'none' ? [['Voting', status('voting'), range(ev.voting_open_at, ev.voting_close_at)] as [string, number, string[]]] : []),
        ['Results', stage === 'ended' ? 1 : 0, ev.results_at ? [`${isPast(ev.results_at) ? 'out' : 'out on'} ${fmtDate(ev.results_at)}`] : []]
    ];
    return (
        <ol className="ev-timeline">
            {steps.map(([label, s, dates]) => (
                <li key={label} className={s === 2 ? 'is-done' : s === 1 ? 'is-current' : ''}>
                    <span className="ev-timeline-dot" aria-hidden="true">{s === 2 && <Icon name="check" size={11} />}</span>
                    <span><strong>{label}</strong>{dates.map(t => <small key={t}>{t}</small>)}</span>
                </li>
            ))}
        </ol>
    );
}

// ---- the calendar ----
// A month at a time, in the reader's own time zone: the days entries are open,
// the days voting runs, and the day the results come out.

type CalStage = 'entries' | 'voting' | 'results';
const dayKey = (t: number) => { const x = new Date(t); return x.getFullYear() * 10_000 + x.getMonth() * 100 + x.getDate(); };

function EventCalendar({ ev }: { ev: EventRow }) {
    const at = (v: string | null | undefined) => v ? new Date(v).getTime() : null;
    const resultsAt = at(ev.results_at) ?? (ev.voting !== 'none' ? at(ev.voting_close_at) : null);
    const ranges: Array<[CalStage, number | null, number | null]> = [
        // entries without an opening date are open from the moment it went live
        ['entries', at(ev.submissions_open_at) ?? (at(ev.submissions_close_at) ? at(ev.created_at) : null), at(ev.submissions_close_at)],
        ['voting', ev.voting !== 'none' ? (at(ev.voting_open_at) ?? at(ev.submissions_close_at)) : null, ev.voting !== 'none' ? at(ev.voting_close_at) : null]
    ];
    const keyDates = [...ranges.flatMap(([, a, b]) => [a, b]), resultsAt].filter((t): t is number => t !== null);
    // open on the month of what's next, or the last thing that happened
    const upcoming = keyDates.filter(t => t >= Date.now()).sort((a, b) => a - b)[0] ?? keyDates.sort((a, b) => b - a)[0] ?? Date.now();
    const [month, setMonth] = useState(() => { const x = new Date(upcoming); return { y: x.getFullYear(), m: x.getMonth() }; });
    if (!keyDates.length) return null;
    const stagesOn = (y: number, m: number, day: number): CalStage[] => {
        const k = y * 10_000 + m * 100 + day;
        const out: CalStage[] = [];
        for (const [stage, a, b] of ranges) {
            if (a === null && b === null) continue;
            const from = dayKey(a ?? b!), to = dayKey(b ?? a!);
            if (k >= from && k <= to) out.push(stage);
        }
        if (resultsAt !== null && k === dayKey(resultsAt)) out.push('results');
        return out;
    };
    const first = new Date(month.y, month.m, 1).getDay();
    const days = new Date(month.y, month.m + 1, 0).getDate();
    const today = dayKey(Date.now());
    const shift = (by: number) => setMonth(({ y, m }) => { const x = new Date(y, m + by, 1); return { y: x.getFullYear(), m: x.getMonth() }; });
    const used = new Set(ranges.filter(([, a, b]) => a !== null || b !== null).map(([st]) => st));
    if (resultsAt !== null) used.add('results');
    const LABEL: Record<CalStage, string> = { entries: 'Entries open', voting: 'Voting', results: 'Results' };
    return (
        <div className="ev-mini-cal" aria-label="Event calendar">
            <div className="ev-mini-cal-head">
                <button type="button" className="ev-icon-btn" onClick={() => shift(-1)} aria-label="Previous month"><Icon name="chevron-left" size={15} /></button>
                <strong>{new Date(month.y, month.m, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })}</strong>
                <button type="button" className="ev-icon-btn" onClick={() => shift(1)} aria-label="Next month"><Icon name="chevron-right" size={15} /></button>
            </div>
            <div className="ev-mini-cal-grid">
                {WEEKDAYS.map(w => <span key={w} className="ev-mini-cal-wd" aria-hidden="true">{w}</span>)}
                {Array.from({ length: first }, (_, i) => <span key={`b${i}`} />)}
                {Array.from({ length: days }, (_, i) => {
                    const day = i + 1;
                    const on = stagesOn(month.y, month.m, day);
                    const isToday = month.y * 10_000 + month.m * 100 + day === today;
                    const label = `${new Date(month.y, month.m, day).toLocaleDateString([], { dateStyle: 'long' })}${on.length ? `: ${on.map(st => LABEL[st]).join(', ')}` : ''}`;
                    return (
                        <span key={day} title={label} aria-label={label}
                            className={`ev-mini-cal-day${on.map(st => ` is-${st}`).join('')}${isToday ? ' is-today' : ''}`}>{day}</span>
                    );
                })}
            </div>
            <ul className="ev-mini-cal-legend">
                {(['entries', 'voting', 'results'] as CalStage[]).filter(st => used.has(st)).map(st => (
                    <li key={st}><span className={`ev-mini-cal-swatch is-${st}`} aria-hidden="true" />{LABEL[st]}</li>
                ))}
            </ul>
        </div>
    );
}

// ---- announcements, on the event's page ----

function Announcements({ ev, d }: { ev: EventRow; d: Detail }) {
    const [all, setAll] = useState(false);
    const list = all ? d.announcements : d.announcements.slice(0, 2);
    return (
        <section className="ev-block ev-announcements" aria-label="Announcements">
            <div className="ev-block-head"><h3><Icon name="megaphone" size={16} />Announcements</h3>
                {!d.following && state.user && ev.phase !== 'draft' && <button type="button" className="ev-link" onClick={() => setFollowing(ev.id, true)}><Icon name="bell" size={13} />Follow to get these</button>}</div>
            <ol className="ev-announce-list">
                {list.map(a => <AnnouncementItem key={a.id} ev={ev} d={d} a={a} />)}
            </ol>
            {d.announcements.length > 2 && <button type="button" className="ev-link" onClick={() => setAll(v => !v)}>{all ? 'Show fewer' : `Show all ${d.announcements.length}`}</button>}
        </section>
    );
}

function AnnouncementItem({ ev, d, a, manage = false }: { ev: EventRow; d: Detail; a: Announcement; manage?: boolean }) {
    const who = a.author_id ? d.people[a.author_id] : undefined;
    return (
        <li className="ev-announce">
            <div className="ev-announce-head">
                <strong>{a.title}</strong>
                <span className="ev-hint ev-inline-hint">{who ? `${personName(who)} · ` : ''}<time dateTime={a.created_at} title={fmtDate(a.created_at)}>{relTime(a.created_at)}</time></span>
                {manage && <button type="button" className="ev-icon-btn" aria-label={`Delete "${a.title}"`} onClick={() => deleteAnnouncement(a)}><Icon name="trash-2" size={14} /></button>}
            </div>
            {a.body && <EventText ev={ev} d={d} text={a.body} />}
        </li>
    );
}

function EventPage({ id, tab }: { id: string; tab: EventTab }) {
    const d = useDetail(id);
    if (!d?.event) return <><BackLink to={{ kind: 'list' }}>All events</BackLink><DetailState d={d} /></>;
    return <EventView ev={d.event} d={d} tab={tab} onTab={t => showEventView({ kind: 'event', id, tab: t })} />;
}

const emptyDetail = (ev: EventRow): Detail => ({
    id: ev.id, status: 'ready', error: '', event: ev, entries: [], privateAnswers: {}, myVotes: {}, votes: [], ballots: [], limits: [],
    results: null, helpers: [], people: {}, resultsPost: null, share: null, codes: [], announcements: [], following: false, editRequests: {}, sheet: null,
    full: {}, feedback: {}
});

/** Previews set this: variables fill with made-up values instead of the event's real (often still empty) ones. */
const SampleVars = createContext(false);

/** An event's own text (about, results post, announcements) with its {{variables}} filled in. */
function EventText({ ev, d, text, className = 'ev-rich' }: { ev: EventRow; d: Detail; text: string; className?: string }) {
    const sample = useContext(SampleVars);
    return <RichText text={fillVariables(text, sample ? sampleVariables(ev) : variablesFor(ev, d))} className={className} />;
}

/** "Fill variables with sample data": a switch for previews. */
function SampleSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
    return (
        <label className="ev-check ev-sample-switch" title="Variables like {{winner1}} show made-up winners, counts and dates, so you can see how it will read">
            <input type="checkbox" checked={on} onChange={e => onChange(e.target.checked)} />Fill variables with sample data
        </label>
    );
}

/** Opens an entry in full (its pictures, the whole Fakémon) the first time it's shown; until then, what's loaded. */
function useFullEntry(d: Detail, en: Entry | null | undefined) {
    const loaded = !!en && (!!d.full[en.id] || d.event?.id === 'preview' || en.id === 'sample');
    useEffect(() => { if (en && !loaded) loadFullEntry(en); }, [en?.id, loaded]);
    return { answers: en ? fullAnswers(d, en) : {}, loading: !!en && !loaded };
}

/**
 * The event as entrants see it. Its page is the About: what it is and the one
 * thing to do next. Entering, voting and results each open as a page of their
 * own with nothing but the form (or the entries) on it. In preview: the
 * organizer's unsaved version, with nothing submittable.
 */
function EventView({ ev, d, tab, onTab, preview = false }: { ev: EventRow; d: Detail; tab: EventTab; onTab: (t: EventTab) => void; preview?: boolean }) {
    const perms = preview ? permsFor(null) : permsFor(ev, d.helpers);
    const guest = !preview && isGuestView();
    const mine = state.user ? d.entries.filter(e => e.user_id === state.user!.id) : [];
    const allowance = entryAllowance(ev, d.limits);
    const organizer = d.people[ev.owner_id];
    const current: EventTab = tab === 'vote' && ev.voting === 'none' ? 'about' : tab;
    const footer = guest && (
        <footer className="ev-guest-footer">
            <span>© {new Date().getFullYear()} Woogidex. All rights reserved.</span>
            <button type="button" onClick={() => api.openTermsPage?.()}>Terms of Service</button>
            <button type="button" onClick={() => api.openPrivacyPage?.()}>Privacy Policy</button>
        </footer>
    );
    useEffect(() => { if (!preview) window.scrollTo({ top: 0 }); }, [current]);
    // signing in on a guest page brings the hub's sidebar back
    useEffect(() => { if (state.user) document.body.classList.remove('event-guest'); }, [state.user]);

    if (current !== 'about') {
        const kicker = current === 'enter' ? (mine.length && !takingEntries(ev) ? 'Your entries' : 'Entry form')
            : current === 'vote' ? 'Voting' : ev.voting === 'none' ? 'Entries' : 'Results';
        return (
            <article className="ev-page ev-focus">
                <button type="button" className="ev-back" data-leave-guard={preview ? undefined : true} onClick={() => onTab('about')}><Icon name="chevron-left" size={15} />About this event</button>
                <header className="ev-focus-head">
                    {ev.cover_image && <div className="ev-focus-cover ev-cover"><img src={ev.cover_image} alt="" draggable={false} /></div>}
                    <div className="ev-focus-title">
                        <span className="ev-focus-kicker">{kicker}</span>
                        <h2>{ev.title || 'Untitled event'}</h2>
                        {current === 'enter' && ev.submissions_close_at && takingEntries(ev) && <p className="ev-hint">Entries close {fmtDate(ev.submissions_close_at)} ({relTime(ev.submissions_close_at)}).</p>}
                        {current === 'vote' && ev.voting_close_at && votingOpen(ev) && <p className="ev-hint">Voting closes {fmtDate(ev.voting_close_at)} ({relTime(ev.voting_close_at)}).</p>}
                    </div>
                </header>
                {current === 'enter' && <EnterTab ev={ev} d={d} preview={preview} mine={mine} allowance={allowance} />}
                {current === 'vote' && <VoteTab ev={ev} d={d} preview={preview} />}
                {current === 'results' && <ResultsView ev={ev} d={d} perms={perms} />}
                {footer}
            </article>
        );
    }

    return (
        <article className="ev-page">
            {!preview && !guest && <BackLink to={{ kind: 'list' }}>All events</BackLink>}
            <div className={`ev-banner ev-cover${ev.cover_image ? '' : ' is-empty'}`}>
                {ev.cover_image ? <img src={ev.cover_image} alt="" draggable={false} /> : <Icon name="trophy" size={40} />}
            </div>
            <header className="ev-page-head">
                <div className="ev-page-title">
                    <div className="ev-meta-line"><PhasePill ev={ev} />{ev.category && <span>{ev.category}</span>}</div>
                    <h2>{ev.title || 'Untitled event'}</h2>
                    {ev.tagline && <p className="ev-tagline">{ev.tagline}</p>}
                    {!preview && organizer && <span className="ev-organizer"><Avatar userId={ev.owner_id} url={organizer.avatar_url} name={personName(organizer)} className="ev-avatar" />Organized by {personName(organizer)}</span>}
                </div>
                {!preview && (
                    <div className="ev-head-actions">
                        {state.user && ev.phase !== 'draft' && (
                            <button className={`btn btn-secondary ev-follow${d.following ? ' is-on' : ''}`} type="button" aria-pressed={d.following}
                                title={d.following ? 'You get its announcements. Click to stop.' : 'Get its announcements on the bell (and by email, if you turned that on)'}
                                onClick={() => setFollowing(ev.id, !d.following)}>
                                <Icon name={d.following ? 'bell-alert' : 'bell'} size={15} />{d.following ? 'Following' : 'Follow'}
                            </button>
                        )}
                        <ShareMenu ev={ev} d={d} />
                        {perms.view && <button className="btn btn-secondary" type="button" onClick={() => showEventView({ kind: 'dashboard', id: ev.slug || ev.id })}><Icon name="chart-bar" size={15} />Dashboard</button>}
                    </div>
                )}
            </header>
            {ev.phase === 'draft' && !preview && (
                <p className="ev-notice"><Icon name="eye-slash" size={15} />
                    <span>This is a draft. Only you and your team can see it until it goes live.</span>
                    {perms.edit && <button type="button" className="ev-link" onClick={() => setPhase(ev, 'announced')}>Go live (entries closed)</button>}
                </p>
            )}

            <div className="ev-page-grid">
                <div className="ev-page-main">
                    <AboutTab ev={ev} d={d} preview={preview} mine={mine} perms={perms} onTab={onTab} />
                </div>
                <aside className="ev-facts" aria-label="Event details">
                    <Timeline ev={ev} />
                    <EventCalendar ev={ev} />
                    <dl>
                        {/* private entries: not even how many */}
                        {(preview ? entriesPublic(ev) : canSeeEntries(ev, perms)) && <div><dt>Entries</dt><dd>{d.entries.length}</dd></div>}
                        {!guest && <div><dt>Per person</dt><dd>{plural(allowance, 'entry', 'entries')}{allowance !== ev.max_entries_per_user && ' (just for you)'}</dd></div>}
                        <div><dt>Voting</dt><dd>{
                            ev.voting === 'community' ? `Community vote, ${plural(ev.votes_per_user, 'vote')} each`
                            : ev.voting === 'judges' ? `Judges score ${criteriaOf(ev).map(c => c.name).join(', ')}`
                            : ev.voting === 'ballot' ? `Everyone rates every entry on ${criteriaOf(ev).map(c => c.name).join(', ')}`
                            : 'No voting'}</dd></div>
                        {ev.voting !== 'none' && <div><dt>Who wins</dt><dd>{describeWinnerRules(ev.winner_criteria)}</dd></div>}
                        <div><dt>Results</dt><dd>{ev.live_results && ev.voting !== 'none' ? 'Live while voting'
                            : ev.hold_results ? (ev.results_released_at ? 'Out' : 'When the organizers post them')
                            : ev.results_at ? `Out ${fmtDate(ev.results_at)}` : 'Shown when it ends'}</dd></div>
                    </dl>
                    <p className="ev-tz-note"><Icon name="globe-alt" size={13} />Times are in your time zone.</p>
                </aside>
            </div>
            {footer}
        </article>
    );
}

/** About: what the event is, the one thing to do next, and the ways in to the rest. */
function AboutTab({ ev, d, preview, mine, perms, onTab }: { ev: EventRow; d: Detail; preview: boolean; mine: Entry[]; perms: ReturnType<typeof permsFor>; onTab: (t: EventTab) => void }) {
    const stage = effectivePhase(ev);
    const next: [EventTab, string, string, string] | null =
        stage === 'upcoming' ? ['enter', 'Entries open soon', ev.submissions_open_at ? `Entries open ${fmtDate(ev.submissions_open_at)} (${relTime(ev.submissions_open_at)}).` : 'Entries aren\'t open yet. Have a look at the form in the meantime.', 'See the form']
        : stage === 'open' || preview ? ['enter', 'Taking entries', ev.submissions_close_at ? `Entries close ${fmtDate(ev.submissions_close_at)} (${relTime(ev.submissions_close_at)}).` : 'Send yours in while entries are open.', mine.length ? 'Your entries' : 'Enter now']
        : stage === 'voting' ? ['vote', 'Voting is open', ev.voting_close_at ? `Voting closes ${fmtDate(ev.voting_close_at)} (${relTime(ev.voting_close_at)}).` : 'Have your say on the entries.', 'Vote now']
        : stage === 'tallying' ? ['results', 'Results soon', ev.results_at && !isPast(ev.results_at) ? `Results come out ${fmtDate(ev.results_at)} (${relTime(ev.results_at)}).` : 'The organizers are getting the results ready.', 'See the entries']
        : stage === 'ended' ? ['results', 'The results are in', 'See who won and every entry.', 'See the results']
        : stage === 'closed' ? [ev.voting === 'none' ? 'results' : 'vote', 'Entries are closed', ev.voting_open_at && !isPast(ev.voting_open_at) ? `Voting opens ${fmtDate(ev.voting_open_at)} (${relTime(ev.voting_open_at)}).` : 'Nothing more to send in.', 'See the entries']
        : null;
    // the other pages, when there's something on them
    const entriesVisible = canSeeEntries(ev, perms);
    const more: Array<[EventTab, string, string]> = [];
    if (mine.length && next?.[0] !== 'enter') more.push(['enter', `Your ${mine.length === 1 ? 'entry' : 'entries'}`, 'paper-airplane']);
    if (!preview && entriesVisible && d.entries.length && next?.[0] !== 'results') more.push(['results', 'See the entries', 'squares-2x2']);
    return (
        <>
            {next && (
                <section className="ev-block ev-cta">
                    <div><h3>{next[1]}</h3><p className="ev-hint">{next[2]}</p></div>
                    <button className="btn btn-primary" type="button" onClick={() => onTab(next[0])}>{next[3]}<Icon name="arrow-right" size={15} /></button>
                </section>
            )}
            {more.length > 0 && (
                <div className="ev-more">
                    {more.map(([key, label, icon]) => <button key={key} type="button" className="ev-link" onClick={() => onTab(key)}><Icon name={icon} size={14} />{label}</button>)}
                </div>
            )}
            {ev.description
                ? <section className="ev-block"><h3>About</h3><EventText ev={ev} d={d} text={ev.description} /></section>
                : <p className="ev-hint">The organizers haven't written a description.</p>}
            {d.announcements.length > 0 && <Announcements ev={ev} d={d} />}
        </>
    );
}

/**
 * While `dirty`: closing or reloading the tab gets the browser's "Leave site?",
 * and the site's own ways out (the header, the hub's menu, a [data-leave-guard]
 * button) ask first.
 * ponytail: the browser's Back button isn't asked about; the autosave keeps the work.
 */
const LEAVING = '.logo-button, .header-nav-btn, .header-messages-btn, .notification-item, .header-profile-popover-identity, '
    + 'button.header-profile-popover-item, .header-profile-popover-legal button, .hub-nav button, [data-leave-guard]';
function useLeaveGuard(dirty: boolean, message: string) {
    useEffect(() => {
        if (!dirty) return;
        let passing = false;
        const unload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
        const click = (e: MouseEvent) => {
            const el = (e.target as Element | null)?.closest?.(LEAVING) as HTMLElement | null;
            if (passing || !el || el.closest('.modal-overlay, #react-dialogs')) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            confirmDialog({ title: 'Leave without finishing?', message, confirmLabel: 'Leave', cancelLabel: 'Keep going', danger: false }).then(yes => {
                if (!yes) return;
                passing = true;
                el.click();
                passing = false;
            });
        };
        window.addEventListener('beforeunload', unload);
        document.addEventListener('click', click, true);
        return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', click, true); };
    }, [dirty, message]);
}

/** Two sets of answers differ in anything actually answered. */
const answersDiffer = (a: Record<string, any>, b: Record<string, any>) =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])].some(k => (answered(a[k]) || answered(b[k])) && JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));

/** Enter: your entries (changeable until entries close), the form, and a code box for extra entries. */
function EnterTab({ ev, d, preview, mine, allowance }: { ev: EventRow; d: Detail; preview: boolean; mine: Entry[]; allowance: number }) {
    const stage = effectivePhase(ev);
    const [editing, setEditing] = useState<Entry | null>(null);
    const canEnter = preview || (takingEntries(ev) && (state.user ? mine.length < allowance : ev.public_access));
    // yours change while entries are open, or after, when the team asked you to (update_event_entry)
    const canEdit = (en: Entry) => takingEntries(ev) || (!!d.editRequests[en.id] && stage !== 'ended');
    const asked = mine.filter(en => d.editRequests[en.id]);
    const edit = async (en: Entry) => { if (await loadFullEntry(en)) setEditing(en); };
    const sentFeedback = mine.filter(en => d.feedback[en.id]);
    if (editing && canEdit(editing)) return <EntryForm key={editing.id} ev={ev} d={d} left={0} preview={false} editing={editing} onDone={() => setEditing(null)} />;
    return (
        <>
            {asked.map(en => (
                <div className="ev-notice is-ask ev-edit-asked" key={en.id} role="status">
                    <Icon name="pencil-square" size={15} />
                    <span><strong>The organizers asked you to change "{entryTitle(ev, en, d.people)}".</strong> {d.editRequests[en.id].reason}</span>
                    {stage !== 'ended' && <button type="button" className="btn btn-primary btn-sm" onClick={() => edit(en)}>Edit entry</button>}
                </div>
            ))}
            {mine.length > 0 && (
                <section className="ev-block">
                    <h3>Your {mine.length === 1 ? 'entry' : 'entries'}</h3>
                    {takingEntries(ev) && <p className="ev-hint">You can change or withdraw {mine.length === 1 ? 'it' : 'them'} until entries close.</p>}
                    <div className="ev-gallery">{mine.map(en => <EntryCard key={en.id} ev={ev} d={d} entry={en} own onEdit={canEdit(en) ? () => edit(en) : undefined} />)}</div>
                </section>
            )}
            {sentFeedback.map(en => (
                <section className="ev-block ev-feedback" key={`fb-${en.id}`}>
                    <div className="ev-block-head"><h3><Icon name="chat-bubble-left-right" size={16} />Feedback on {entryTitle(ev, en, d.people)}</h3>
                        <span className="ev-hint ev-inline-hint">From the organizers · {relTime(d.feedback[en.id].at)}</span></div>
                    <RichText text={d.feedback[en.id].text} className="ev-rich" />
                </section>
            ))}
            {canEnter && <EntryForm ev={ev} d={d} left={allowance - mine.length} preview={preview} />}
            {!preview && takingEntries(ev) && !canEnter && <p className="ev-notice"><Icon name="check-circle" size={15} />You've used all {plural(allowance, 'entry', 'entries')}. Withdraw one to enter something else.</p>}
            {!preview && !takingEntries(ev) && (
                <p className="ev-notice"><Icon name="clock" size={15} />{stage === 'upcoming' ? (ev.submissions_open_at ? `Entries open ${fmtDate(ev.submissions_open_at)} (${relTime(ev.submissions_open_at)}).` : 'Entries aren\'t open yet. Check back soon.') : stage === 'draft' ? 'Entries open when the organizer publishes this event.' : 'Entries are closed.'}</p>
            )}
            {!preview && state.user && ['upcoming', 'open'].includes(stage) && <CodeBox ev={ev} />}
            {!preview && !state.user && !ev.public_access && takingEntries(ev) && (
                <p className="ev-notice"><Icon name="user" size={15} /><span>Sign in to enter this event.</span><button type="button" className="ev-link" onClick={() => api.openAuthModal?.('signin')}>Sign in</button></p>
            )}
        </>
    );
}

/** Redeem an entry code an organizer gave you. */
function CodeBox({ ev }: { ev: EventRow }) {
    const [open, setOpen] = useState(false);
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    if (!open) return <button type="button" className="ev-link ev-code-toggle" onClick={() => setOpen(true)}><Icon name="ticket" size={14} />Have an entry code?</button>;
    async function redeem(e: React.FormEvent) {
        e.preventDefault();
        setBusy(true);
        if (await redeemEventCode(ev.id, code)) { setCode(''); setOpen(false); }
        setBusy(false);
    }
    return (
        <form className="ev-block ev-code-box" onSubmit={redeem}>
            <h4>Entry code</h4>
            <p className="ev-hint">If an organizer sent you a code, it gives you more entries.</p>
            <div className="ev-share-field">
                <input type="text" value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" maxLength={32} autoComplete="off" spellCheck={false} aria-label="Entry code" />
                <button className="btn btn-primary btn-sm" type="submit" disabled={busy || code.trim().length < 4}>Use code</button>
            </div>
        </form>
    );
}

/** Vote: the ballot, judging, or a quick vote on each entry. */
function VoteTab({ ev, d, preview }: { ev: EventRow; d: Detail; preview: boolean }) {
    const stage = effectivePhase(ev);
    const perms = permsFor(ev, d.helpers);
    // what you may vote on: everyone else's, and your own too when the organizer allows it
    const others = d.entries.filter(e => !state.user || ev.allow_self_vote || e.user_id !== state.user.id);
    if (preview) return <p className="ev-notice"><Icon name="eye" size={15} />Voting shows here once it opens. The preview of the voting form is below.</p>;
    if (!votingOpen(ev)) {
        return (
            <>
                <p className="ev-notice"><Icon name="clock" size={15} />{
                    stage === 'closed' && ev.voting_open_at && !isPast(ev.voting_open_at) ? `Voting opens ${fmtDate(ev.voting_open_at)} (${relTime(ev.voting_open_at)}).`
                    : ['tallying', 'ended'].includes(stage) ? 'Voting is over.'
                    : 'Voting opens after entries close.'}</p>
                {others.length > 0 && canSeeEntries(ev, perms) && <Gallery ev={ev} d={d} entries={others} title="Entries" />}
            </>
        );
    }
    if (!state.user) return <p className="ev-notice"><Icon name="star" size={15} /><span>Voting is open to Woogidex members.</span><button type="button" className="ev-link" onClick={() => api.openAuthModal?.('signin')}>Sign in to vote</button></p>;
    if (ev.voting === 'judges' && !perms.judge) {
        return <><p className="ev-notice"><Icon name="scale" size={15} />The event's judges are scoring the entries.</p><Gallery ev={ev} d={d} entries={others} title="Entries" /></>;
    }
    return (
        <>
            {ev.voting === 'ballot' && <BallotCall ev={ev} d={d} />}
            {!others.length ? <p className="ev-hint">There's nothing to vote on yet.</p> : <Gallery ev={ev} d={d} entries={others} title={ev.voting === 'ballot' ? 'Entries' : 'Vote on the entries'} />}
        </>
    );
}

/** Results: the announcement, the winners, and every entry, best first. */
function ResultsView({ ev, d, perms }: { ev: EventRow; d: Detail; perms: ReturnType<typeof permsFor> }) {
    const stage = effectivePhase(ev);
    const others = d.entries.filter(e => !state.user || e.user_id !== state.user.id);
    const visible = canSeeEntries(ev, perms);
    if (stage !== 'ended') {
        const when = ev.results_at && !isPast(ev.results_at) ? `Results come out ${fmtDate(ev.results_at)} (${relTime(ev.results_at)}).`
            : ev.hold_results ? 'Results come out once the organizers post them.'
            : 'Results come out when the event ends.';
        return (
            <>
                <p className="ev-notice"><Icon name="clock" size={15} />{when}</p>
                {visible && others.length > 0 && <Gallery ev={ev} d={d} entries={others} title="Entries so far" />}
            </>
        );
    }
    const rows = ranked(ev, d.entries, d.results);
    const won = d.results || ev.voting === 'none' ? computeWinners(ev, rows) : new Set<string>();
    const places = new Map(rows.filter(r => won.has(r.entry.id)).map(r => [r.entry.id, r.place || 0]));
    return (
        <>
            {d.resultsPost && <section className="ev-block ev-results-post"><h3>Results</h3><EventText ev={ev} d={d} text={d.resultsPost} /></section>}
            {(d.results || ev.voting === 'none') && <Podium ev={ev} d={d} />}
            {visible && d.entries.length > 0 && <Gallery ev={ev} d={d} entries={rows.map(r => r.entry)} title="All entries" winners={places} />}
            {visible && !d.entries.length && <p className="ev-hint">This event had no entries.</p>}
        </>
    );
}

function Gallery({ ev, d, entries, title, winners }: { ev: EventRow; d: Detail; entries: Entry[]; title: string; winners?: Map<string, number> }) {
    return (
        <section className="ev-block">
            <div className="ev-block-head"><h3>{title}</h3><VoteBudget ev={ev} d={d} /></div>
            <div className="ev-gallery">{entries.map(en => <EntryCard key={en.id} ev={ev} d={d} entry={en} own={!!state.user && en.user_id === state.user.id} place={winners?.get(en.id)} />)}</div>
        </section>
    );
}

/** Copy the link, or (signed in) repost the event or share it with your thoughts, like a post. */
function ShareMenu({ ev, d }: { ev: EventRow; d: Detail }) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
        document.addEventListener('mousedown', away);
        return () => document.removeEventListener('mousedown', away);
    }, [open]);
    if (!state.user || !d.share) return <button className="btn btn-secondary" type="button" onClick={() => copyLink(shareLink(ev), 'Event link')}><Icon name="link" size={15} />Copy link</button>;
    const act = (fn: () => void) => () => { setOpen(false); fn(); };
    return (
        <div className="ev-share-menu" ref={ref}>
            <button className="btn btn-secondary" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}><Icon name="share" size={15} />Share</button>
            {open && (
                <div className="feed-menu ev-menu" role="menu">
                    <button type="button" role="menuitem" onClick={act(() => copyLink(shareLink(ev), 'Event link'))}><Icon name="link" size={14} />Copy link</button>
                    <button type="button" role="menuitem" onClick={act(toggleEventRepost)}><Icon name="arrow-path-rounded-square" size={14} />{d.share.reposted_by_me ? 'Undo repost' : 'Repost to your feed'}</button>
                    <button type="button" role="menuitem" onClick={act(() => openDialog('quote-repost', { item: d.share }))}><Icon name="pencil-square" size={14} />Share with your thoughts</button>
                </div>
            )}
        </div>
    );
}

function VoteBudget({ ev, d }: { ev: EventRow; d: Detail }) {
    if (!votingOpen(ev) || ev.voting !== 'community' || !state.user) return null;
    const used = Object.keys(d.myVotes).length;
    return <span className="ev-budget">{ev.votes_per_user - used} of {plural(ev.votes_per_user, 'vote')} left</span>;
}

function BallotCall({ ev, d }: { ev: EventRow; d: Detail }) {
    const n = ballotEntries(ev, d.entries).length;
    if (!n) return null;
    if (!state.user) return <p className="ev-notice"><Icon name="star" size={15} /><span>Voting is open to Woogidex members.</span><button type="button" className="ev-link" onClick={() => api.openAuthModal?.('signin')}>Sign in to vote</button></p>;
    if (hasSubmittedBallot(d)) return <p className="ev-notice is-done"><Icon name="check-circle" size={15} />Your ballot is in. Thanks for voting!</p>;
    return (
        <section className="ev-block ev-ballot-call">
            <div>
                <h3>Voting is open</h3>
                <p className="ev-hint">Rate all {plural(n, 'entry', 'entries')} on {criteriaOf(ev).map(c => c.name).join(', ')}, then send your ballot. Your order is shuffled, and your progress is kept if you leave.{ev.voting_close_at && ` Closes ${fmtDate(ev.voting_close_at)}.`}</p>
            </div>
            <button className="btn btn-primary" type="button" onClick={() => startBallot(ev)}><Icon name="star" size={15} />Start voting</button>
        </section>
    );
}

function EntryCard({ ev, d, entry: en, own = false, place, onEdit }: { ev: EventRow; d: Detail; entry: Entry; own?: boolean; place?: number; onEdit?: () => void }) {
    const winner = place !== undefined;
    const perms = permsFor(ev, d.helpers);
    const img = entryImage(ev, en);
    const author = authorOf(d, en);
    const result = d.results?.find(r => r.entry_id === en.id);
    const myVote = d.myVotes[en.id];
    const voting = votingOpen(ev) && (!own || !!ev.allow_self_vote) && !!state.user;
    const outOfVotes = ev.voting === 'community' && !myVote && Object.keys(d.myVotes).length >= ev.votes_per_user;
    const [open, setOpen] = useState(false);
    return (
        <div className={`ev-entry${winner ? ' is-winner' : ''}${myVote && ev.voting === 'community' ? ' is-voted' : ''}`}>
            <button type="button" className="ev-entry-art" onClick={() => setOpen(true)} aria-label={`Open ${entryTitle(ev, en, d.people)}`}>
                {img ? <img src={img} alt="" draggable={false} loading="lazy" /> : <Icon name="document-text" size={26} />}
                {winner && <span className="ev-place">{place ? placeLabel(place) : 'Winner'}</span>}
            </button>
            <div className="ev-entry-body">
                <strong>{entryTitle(ev, en, d.people)}</strong>
                {(own || !votingOpen(ev) || voteDisplay(ev).author) && <span className="ev-entry-by"><Avatar userId={en.user_id} url={author?.avatar_url} name={authorName(d, en)} className="ev-avatar ev-avatar-xs" />{authorName(d, en)}</span>}
                {result && <span className="ev-entry-score">{ev.voting === 'community' ? plural(Number(result.votes), 'vote') : `${Number(result.points_percent).toFixed(1)}% · ${plural(Number(result.votes), 'vote')}`}</span>}
                {d.editRequests[en.id] && (own || perms.entries) && <span className="ev-chip-flag" title={d.editRequests[en.id].reason}><Icon name="pencil-square" size={12} />Edit requested</span>}
            </div>
            <div className="ev-entry-actions">
                {voting && ev.voting === 'community' && (
                    <button type="button" className={`ev-vote${myVote ? ' is-on' : ''}`} aria-pressed={!!myVote} disabled={outOfVotes}
                        title={outOfVotes ? 'You have used all your votes. Take one back to move it.' : undefined}
                        onClick={() => castVote(en, myVote ? null : 1)}>
                        <Icon name="heart" size={15} />{myVote ? 'Voted' : 'Vote'}
                    </button>
                )}
                {voting && ev.voting === 'judges' && perms.judge && (
                    <button type="button" className={`ev-vote${myVote ? ' is-on' : ''}`} onClick={() => openDialog('event-judge', { ev, entry: en })}>
                        <Icon name="star" size={15} />{myVote ? `Scored ${myVote.score}` : 'Score'}
                    </button>
                )}
                {onEdit && <button type="button" className="btn btn-secondary btn-sm" onClick={onEdit}><Icon name="pencil" size={13} />Edit</button>}
                {own && takingEntries(ev) && <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeEntry(en, true)}>Withdraw</button>}
            </div>
            {open && <EntryDialog ev={ev} d={d} entry={en} close={() => setOpen(false)} />}
        </div>
    );
}

function Podium({ ev, d }: { ev: EventRow; d: Detail }) {
    const rows = ranked(ev, d.entries, d.results);
    const winners = computeWinners(ev, rows);
    // the top three places; entries tied for one of them stand on it together
    const top = rows.filter(r => winners.has(r.entry.id) && (r.place || 99) <= 3).slice(0, 6);
    if (!top.length) return null;
    return (
        <section className="ev-block">
            <h3>Winners</h3>
            <ol className="ev-podium">
                {top.map(({ entry: en, result, place }) => (
                    <li key={en.id} className={`ev-podium-${place}`}>
                        <span className="ev-podium-art">{entryImage(ev, en) ? <img src={entryImage(ev, en)} alt="" /> : <Icon name="trophy" size={28} />}</span>
                        <span className="ev-place">{placeLabel(place || 1)}</span>
                        <strong>{entryTitle(ev, en, d.people)}</strong>
                        <span>{authorName(d, en)}{result ? ` · ${ev.voting === 'community' ? plural(Number(result.votes), 'vote') : `${Number(result.points_percent).toFixed(1)}%`}` : ''}</span>
                    </li>
                ))}
            </ol>
            {winners.size > top.length && <p className="ev-hint ev-podium-more">{winners.size - top.length} more {winners.size - top.length === 1 ? 'entry wins' : 'entries win'} too, marked below.</p>}
        </section>
    );
}

// ---- one entry, every answer ----

function Answer({ field: f, value }: { field: Field; value: any }) {
    if (value == null || value === '' || value === false) return <span className="ev-muted">No answer</span>;
    // a picture left out of a list (event_entries_light): open the response to see it
    if (value === '[image]') return <span className="ev-muted"><Icon name="photo" size={13} /> Picture (open the response to see it)</span>;
    if (f.type === 'image') return <img className="ev-answer-img" src={value} alt={f.label} />;
    if (f.type === 'fakemon') {
        const stats = value.stats && typeof value.stats === 'object' ? Object.values(value.stats as Record<string, unknown>).reduce((n: number, x) => n + (Number(x) || 0), 0) : 0;
        const line = lineOf(value);
        return (
            <span className="ev-answer-mon">
                {value.artwork && <img src={value.artwork} alt="" />}
                <span>
                    <strong>{value.name}</strong>
                    {[value.type1, value.type2].filter(Boolean).join(' / ')}{stats ? ` · BST ${stats}` : ''}
                    {line.length > 1 && <span className="ev-line-names" aria-label="Evolution line">
                        {line.map((m, i) => <span key={m.sourceId}>{i > 0 && <Icon name={m.isMega || m.isFormeChange ? 'sparkles' : 'arrow-right'} size={11} />}{m.mon?.name || '?'}</span>)}
                    </span>}
                    {Array.isArray(value.learnset) && <button type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('event-fakemon-board', { mon: value })}><Icon name="book-open" size={14} />Full Pokédex page{line.length > 1 ? 's' : ''}</button>}
                </span>
            </span>
        );
    }
    if (f.type === 'library' && typeof value === 'object') return <LibCard v={value} />;
    if (f.type === 'url' && /^https?:\/\//i.test(value)) return <a href={value} target="_blank" rel="noopener noreferrer nofollow ugc">{value}</a>;
    if (f.type === 'agree') return <span><Icon name="check" size={13} /> Yes</span>;
    if (f.type === 'checkboxes' && Array.isArray(value)) return <span className="ev-prose">{value.join(', ')}</span>;
    if (f.type === 'scale') return <span><strong>{value}</strong> / {f.max || 5}</span>;
    if (f.type === 'date') return <span>{new Date(`${value}T00:00`).toLocaleDateString([], { dateStyle: 'long' })}</span>;
    return <span className="ev-prose">{String(value)}</span>;
}

function EntryAnswers({ ev, d, entry: en }: { ev: EventRow; d: Detail; entry: Entry }) {
    const priv = d.privateAnswers[en.id] || {};
    const { answers, loading } = useFullEntry(d, en);
    return (
        <dl className={`ev-answers${loading ? ' is-loading' : ''}`} aria-busy={loading}>
            {ev.form.map(f => {
                const isPrivate = isPrivateField(f);
                if (f.type === 'section' || (isPrivate && !(f.id in priv))) return null;
                return (
                    <div key={f.id}>
                        <dt>{f.label}{isPrivate && <span className="ev-private"><Icon name="lock-closed" size={11} />Private</span>}</dt>
                        <dd><Answer field={f} value={isPrivate ? priv[f.id] : answers[f.id]} /></dd>
                    </div>
                );
            })}
        </dl>
    );
}

function EntryDialog({ ev, d, entry: en, close }: { ev: EventRow; d: Detail; entry: Entry; close: () => void }) {
    return (
        <Modal onClose={close} title={entryTitle(ev, en, d.people)} className="modal-wide ev-entry-modal">
            <p className="ev-hint">By {authorName(d, en)} · {fmtDate(en.created_at)}</p>
            <EntryAnswers ev={ev} d={d} entry={en} />
        </Modal>
    );
}

/**
 * A Fakémon answer drawn as its full Pokédex page, so it can be judged
 * competitively. A whole line gets the Community Hub's evolution strip to
 * switch between them.
 */
function FakemonBoardDialog({ close, mon, start }: DialogProps<{ mon: any; start?: string }>) {
    useStore();
    const line = useMemo(() => lineOf(mon), [mon]);
    const [active, setActive] = useState(() => start && line.some(m => m.sourceId === start) ? start : line.find(m => m.face)?.sourceId || line[0]?.sourceId || '');
    const shown = line.find(m => m.sourceId === active)?.mon || mon;
    const [ready, setReady] = useState(false);
    useEffect(() => {
        Promise.resolve(api.fetchShowdownData?.()).finally(() => { previewEventFakemon(shown); setReady(true); });
    }, [shown]);
    return (
        <Modal onClose={close} title={shown?.name || 'Fakémon'} className="quick-preview-modal">
            <div className="preview-modal-board-wrap">
                {ready ? <PokedexBoard id="pokedex-board-event" model={api.boardModel()} onToggleShiny={() => api.togglePreviewArtworkMode()}
                    evolution={line.length > 1 ? <EvoStrip members={line} activeId={active} onPick={setActive} /> : undefined} />
                    : <span className="skel" style={{ display: 'block', height: 480, borderRadius: 'var(--panel-r)' }} />}
            </div>
        </Modal>
    );
}
registerDialog('event-fakemon-board', FakemonBoardDialog);

// ==================== voting: judges and the ballot ====================

function Stars({ value, max, onChange, label }: { value: number; max: number; onChange: (n: number) => void; label: string }) {
    return (
        <div className="ev-stars" role="radiogroup" aria-label={label}>
            {Array.from({ length: max }, (_, i) => (
                <button key={i} type="button" role="radio" aria-checked={value === i + 1} className={`ev-star${i < value ? ' is-on' : ''}`}
                    onClick={() => onChange(i + 1)} aria-label={`${i + 1} out of ${max}`}><Icon name="star" size={18} /></button>
            ))}
            <strong className="ev-stars-value">{value || '-'}<small>/{max}</small></strong>
        </div>
    );
}

/** The voting form: one row of stars per criterion, as the organizer set it up. */
function CriteriaScores({ criteria, scores, onChange }: { criteria: Criterion[]; scores: Record<string, number>; onChange: (s: Record<string, number>) => void }) {
    return (
        <div className="ev-criteria">
            {criteria.map(c => (
                <div className="ev-criterion" key={c.name}>
                    <span className="ev-criterion-label">{c.name}</span>
                    {c.help && <small className="ev-field-help">{c.help}</small>}
                    <Stars label={c.name} max={c.max} value={scores[c.name] || 0} onChange={n => onChange({ ...scores, [c.name]: n })} />
                </div>
            ))}
        </div>
    );
}

function Remarks({ mode, value, onChange, placeholder }: { mode: Remarks; value: string; onChange: (v: string) => void; placeholder: string }) {
    if (mode === 'off') return null;
    return (
        <label className="ev-field">
            <span className="ev-field-label">Remarks{mode === 'required' ? <span className="ev-req" aria-hidden="true"> *</span> : <span className="ev-optional"> (optional)</span>}</span>
            <textarea className="ev-remarks" rows={3} maxLength={2000} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} />
        </label>
    );
}

/** The entry as the voting form shows it: the answers and author the organizer chose to show. */
function EntrySummary({ ev, d, entry: en }: { ev: EventRow; d: Detail; entry: Entry }) {
    const shown = voteDisplay(ev);
    const view = shown.fields ? { ...ev, form: ev.form.filter(f => shown.fields!.includes(f.id)) } : ev;
    return (
        <div className="ev-vote-entry">
            <div className="ev-vote-entry-body">
                <h3>{entryTitle(ev, en, shown.author ? d.people : {})}</h3>
                {shown.author && <p className="ev-hint">By {authorName(d, en)}</p>}
                <EntryAnswers ev={view} d={d} entry={en} />
            </div>
        </div>
    );
}

interface VoteState { scores: Record<string, number>; answers: Record<string, any>; remarks: string; }

/**
 * The voting form for one entry: the entry, the scores, the organizer's
 * questions, then remarks, split into pages at each page break. `actions`
 * draws what goes under the last page (save, next entry).
 */
function VoteSheet({ ev, d, entry, value, onChange, actions }: { ev: EventRow; d: Detail; entry: Entry; value: VoteState; onChange: (v: VoteState) => void; actions: ReactNode }) {
    const pages = formPages(ev.vote_form || []);
    const [page, setPage] = useState(0);
    const at = Math.min(page, pages.length - 1);
    const last = at === pages.length - 1;
    const missing = pages[at].fields.find(f => f.required && !answered(value.answers[f.id]));
    function next() {
        if (at === 0 && !scoresComplete(ev, value.scores)) { api.showToast?.('Score every criterion first.', 'warning'); return; }
        if (missing) { api.showToast?.(`"${missing.label}" needs an answer.`, 'warning'); return; }
        setPage(at + 1);
    }
    return (
        <div className="ev-vote-sheet">
            {pages.length > 1 && (
                <div className="ev-pages" aria-label={`Page ${at + 1} of ${pages.length}`}>
                    <span>Page {at + 1} of {pages.length}</span>
                    <span className="ev-pages-bar" aria-hidden="true"><span style={{ transform: `scaleX(${(at + 1) / pages.length})` }} /></span>
                </div>
            )}
            {at === 0 && <EntrySummary ev={ev} d={d} entry={entry} />}
            {at === 0 && <CriteriaScores criteria={criteriaOf(ev)} scores={value.scores} onChange={scores => onChange({ ...value, scores })} />}
            {pages[at].head && <div className="ev-page-intro"><h4>{pages[at].head!.label}</h4>{pages[at].head!.help && <p className="ev-hint">{pages[at].head!.help}</p>}</div>}
            {pages[at].fields.length > 0 && (
                <div className="ev-vote-questions">
                    {pages[at].fields.map(f => <FieldInput key={f.id} field={f} value={value.answers[f.id]} autofilled={false} onChange={v => onChange({ ...value, answers: { ...value.answers, [f.id]: v } })} />)}
                </div>
            )}
            {last && <Remarks mode={ev.voter_remarks} value={value.remarks} onChange={remarks => onChange({ ...value, remarks })} placeholder="Only the team sees these" />}
            <div className="ev-form-actions">
                {at > 0 && <button type="button" className="btn btn-secondary" onClick={() => setPage(at - 1)}><Icon name="chevron-left" size={15} />Back</button>}
                {last ? actions : <button type="button" className="btn btn-primary" onClick={next}>Next<Icon name="chevron-right" size={15} /></button>}
            </div>
        </div>
    );
}

const voteReady = (ev: EventRow, v: VoteState) => scoresComplete(ev, v.scores) && remarksOk(ev, v.remarks) && voteAnswersOk(ev, v.answers);

function JudgeDialog({ close, ev, entry: en }: DialogProps<{ ev: EventRow; entry: Entry }>) {
    const d = events.detail!;
    const mine = d.myVotes[en.id];
    const [value, setValue] = useState<VoteState>({ scores: mine?.scores || {}, answers: mine?.answers || {}, remarks: mine?.remarks || '' });
    const [busy, setBusy] = useState(false);
    async function run(task: () => Promise<boolean>) {
        setBusy(true);
        if (await task()) close();
        setBusy(false);
    }
    return (
        <Modal onClose={close} title={`Score ${entryTitle(ev, en, voteDisplay(ev).author ? d.people : {})}`} className="modal-wide ev-entry-modal">
            <VoteSheet ev={ev} d={d} entry={en} value={value} onChange={setValue} actions={<>
                {mine && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(() => castVote(en, null))}>Clear my score</button>}
                <button type="button" className="btn btn-primary" disabled={busy}
                    onClick={() => voteReady(ev, value) ? run(() => castVote(en, null, value.scores, value.remarks, value.answers)) : api.showToast?.('Finish the voting form first.', 'warning')}>Save score</button>
            </>} />
        </Modal>
    );
}
registerDialog('event-judge', JudgeDialog);

/** The Fakémon-contest ballot: every entry, every criterion, then one submit. */
function BallotView({ ev }: { ev: EventRow }) {
    const d = events.detail!;
    const b = events.ballot!;
    const byId = new Map(d.entries.map(e => [e.id, e]));
    const current = byId.get(b.order[b.index]);
    const stateOf = (id: string): VoteState => ({ scores: b.scores[id] || {}, answers: b.answers?.[id] || {}, remarks: b.remarks[id] || '' });
    const finished = (id: string) => voteReady(ev, stateOf(id));
    const done = b.order.filter(finished).length;
    const all = done === b.order.length;
    const go = (i: number) => { updateBallot({ index: Math.max(0, Math.min(i, b.order.length - 1)) }); window.scrollTo({ top: 0 }); };
    const save = (id: string, v: VoteState) => updateBallot({ scores: { ...b.scores, [id]: v.scores }, answers: { ...b.answers, [id]: v.answers }, remarks: { ...b.remarks, [id]: v.remarks } });
    return (
        <div className="ev-page ev-ballot">
            <button type="button" className="ev-back" onClick={closeBallot}><Icon name="arrow-left" size={14} />Back to the event</button>
            <header className="ev-ballot-head">
                <div>
                    <h2>{ev.title}</h2>
                    <p className="ev-hint">{done} of {plural(b.order.length, 'entry', 'entries')} rated. Your progress is saved on this device until you submit.</p>
                </div>
                <div className="ev-ballot-progress" aria-hidden="true"><span style={{ transform: `scaleX(${done / b.order.length})` }} /></div>
            </header>
            <div className="ev-ballot-grid">
                <nav className="ev-ballot-queue" aria-label="Entries on your ballot">
                    {b.order.map((id, i) => {
                        const en = byId.get(id);
                        const ok = finished(id);
                        return (
                            <button key={id} type="button" className={`ev-queue-item${i === b.index ? ' is-current' : ''}${ok ? ' is-done' : ''}`} aria-current={i === b.index} onClick={() => go(i)}>
                                <span className="ev-queue-num">{ok ? <Icon name="check" size={12} /> : i + 1}</span>
                                <span className="ev-queue-name">{en ? entryTitle(ev, en, voteDisplay(ev).author ? d.people : {}) : 'Removed entry'}</span>
                            </button>
                        );
                    })}
                </nav>
                <div className="ev-ballot-main">
                    {current ? (
                        <section className="ev-block">
                            <p className="ev-ballot-count">Entry {b.index + 1} of {b.order.length}</p>
                            <VoteSheet key={current.id} ev={ev} d={d} entry={current} value={stateOf(current.id)} onChange={v => save(current.id, v)} actions={<>
                                {b.index > 0 && <button type="button" className="btn btn-secondary" onClick={() => go(b.index - 1)}><Icon name="chevron-left" size={15} />Previous entry</button>}
                                {b.index < b.order.length - 1 && (
                                    <button type="button" className="btn btn-primary" onClick={() => finished(current.id) ? go(b.index + 1) : api.showToast?.('Finish this entry first.', 'warning')}>Next entry<Icon name="chevron-right" size={15} /></button>
                                )}
                            </>} />
                        </section>
                    ) : <p className="ev-hint">This entry was removed. Pick another from the list.</p>}
                    <section className={`ev-block ev-ballot-submit${all ? ' is-ready' : ''}`}>
                        <div><strong>{all ? 'Every entry is rated' : 'Keep going'}</strong><span className="ev-hint">{all ? 'Send your ballot. You can\'t change it after.' : `${b.order.length - done} left to rate.`}</span></div>
                        <button type="button" className="btn btn-primary" disabled={!all} onClick={() => submitBallot(ev)}><Icon name="paper-airplane" size={15} />Submit ballot</button>
                    </section>
                </div>
            </div>
        </div>
    );
}

// ==================== entering ====================

const MAX_IMAGE_CHARS = 1_400_000;

// Cloudflare Turnstile widget "Woogidex guest event entries" (dex.woogi.xyz,
// localhost). The site key is public by design; its secret lives in the
// submit-event-guest function's TURNSTILE_SECRET_KEY.
const TURNSTILE_SITE_KEY: string = import.meta.env.VITE_TURNSTILE_SITE_KEY || '0x4AAAAAAFOdMFmuLvO018AE';
let turnstileScript: Promise<any> | null = null;
function loadTurnstile(): Promise<any> {
    return turnstileScript ||= new Promise((resolve, reject) => {
        const tag = document.createElement('script');
        tag.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        tag.async = true;
        tag.onload = () => resolve((window as any).turnstile);
        tag.onerror = () => { turnstileScript = null; reject(new Error('The anti-spam check could not load.')); };
        document.head.appendChild(tag);
    });
}

/** Cloudflare's anti-spam check, for guests. Each token is good for one entry; bump resetKey after a submit. */
function Turnstile({ onToken, resetKey }: { onToken: (t: string) => void; resetKey: number }) {
    const box = useRef<HTMLDivElement>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let id: string | null = null;
        let live = true;
        onToken('');
        loadTurnstile().then(t => {
            if (!live || !box.current) return;
            id = t.render(box.current, {
                sitekey: TURNSTILE_SITE_KEY,
                theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
                callback: (token: string) => onToken(token),
                'expired-callback': () => onToken(''),
                'error-callback': () => onToken('')
            });
        }).catch(() => setFailed(true));
        return () => { live = false; if (id) (window as any).turnstile?.remove(id); };
    }, [resetKey]);
    return failed ? <p className="ev-error">The anti-spam check could not load. Check your connection and reload the page.</p> : <div className="ev-turnstile" ref={box} />;
}

/**
 * The entry form, Google Forms style: one card per question, page by page.
 * What you fill in is kept on this device as you go (until it's sent), and
 * leaving with unsent answers asks first. With `editing`: your own entry,
 * changed in place while entries are open.
 */
function EntryForm({ ev, d, left, preview, editing, onDone }: { ev: EventRow; d: Detail; left: number; preview: boolean; editing?: Entry; onDone?: () => void }) {
    // your entry as it is, pictures and all (EnterTab loads it in full before it opens this)
    const original = useMemo(() => editing ? { ...fullAnswers(d, editing), ...(d.privateAnswers[editing.id] || {}) } : {}, [editing?.id]);
    const [draft] = useState(() => preview ? null : readEntryDraft(ev.id, editing?.id));
    const [answers, setAnswers] = useState<Record<string, any>>(() => draft || original);
    const [restored, setRestored] = useState(!!draft);
    const [filled, setFilled] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [sent, setSent] = useState(false);
    const [page, setPage] = useState(0);
    const [token, setToken] = useState('');
    const [tries, setTries] = useState(0);
    const top = useRef<HTMLFormElement>(null);
    const guest = !state.user && !preview;
    const formKey = ev.form.map(f => `${f.id}:${f.type}`).join();
    const pages = formPages(ev.form);
    const at = Math.min(page, pages.length - 1);
    const current = pages[at];
    const last = at === pages.length - 1;
    const base = editing ? original : filled;
    const dirty = !preview && !sent && answersDiffer(answers, base);
    useLeaveGuard(dirty, 'Your answers stay saved on this device, so you can come back and finish.');

    useEffect(() => {
        if (editing) return;
        let live = true;
        autofillFor(ev.form).then(found => {
            if (!live) return;
            setFilled(found);
            setAnswers(a => ({ ...found, ...a }));
        });
        return () => { live = false; };
    }, [ev.id, formKey]);
    useEffect(() => { setPage(0); }, [formKey]);
    // autosave, a moment after the last change
    useEffect(() => {
        if (preview || sent) return;
        const t = setTimeout(() => dirty ? writeEntryDraft(ev.id, answers, editing?.id) : clearEntryDraft(ev.id, editing?.id), 500);
        return () => clearTimeout(t);
    }, [answers, dirty]);

    const set = (id: string, v: any) => setAnswers(a => ({ ...a, [id]: v }));
    const missing = (fields: Field[]) => fields.find(f => f.required && !answered(answers[f.id]));
    // what's wrong on a page: a required answer missing, or a Fakémon breaking the question's rules
    const issue = (fields: Field[]) => {
        const m = missing(fields);
        if (m) return `"${m.label}" is required.`;
        for (const f of fields) {
            const broken = f.type === 'fakemon' && answered(answers[f.id]) ? monRuleProblems(answers[f.id], f.rules) : [];
            if (broken.length) return `"${f.label}": ${monRuleSentence(broken)}`;
        }
        return '';
    };
    const goTo = (i: number) => { setPage(i); setError(''); top.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
    function startOver() {
        clearEntryDraft(ev.id, editing?.id);
        setAnswers({ ...base });
        setRestored(false);
        goTo(0);
    }

    function next() {
        const problem = issue(current.fields);
        if (problem) { setError(problem); return; }
        goTo(at + 1);
    }

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        if (preview) return;
        if (!last) { next(); return; }
        const gap = pages.findIndex(p => issue(p.fields));
        if (gap !== -1) { const problem = issue(pages[gap].fields); goTo(gap); setError(problem); return; }
        if (guest && !token) { setError('Complete the anti-spam check below first.'); return; }
        setBusy(true);
        setError('');
        const ok = editing ? await updateEntry(editing, answers) : await submitEntry(ev.id, answers, token);
        setBusy(false);
        // a token is spent either way
        if (guest) setTries(n => n + 1);
        if (!ok) return;
        clearEntryDraft(ev.id, editing?.id);
        setRestored(false);
        if (editing) { onDone?.(); return; }
        setAnswers({ ...filled });
        setPage(0);
        setSent(true);
    }

    if (sent) {
        return (
            <section className="ev-block ev-sent">
                <Icon name="check-circle" size={28} />
                <h3>{state.user ? 'You\'re in!' : 'Your response was recorded'}</h3>
                <p className="ev-hint">{state.user ? 'Your entry is above. You can change it until entries close.' : 'Thanks for taking part. The organizers will take it from here.'}</p>
                {(!state.user || left > 1) && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSent(false)}>{state.user ? 'Enter again' : 'Send another response'}</button>}
            </section>
        );
    }

    const anyRequired = ev.form.some(f => f.required);
    return (
        <form className="ev-form" onSubmit={submit} noValidate ref={top}>
            {(editing || restored || anyRequired || (!preview && left > 1 && state.user)) && (
                <div className="ev-form-status">
                    {editing ? <span className="ev-form-editing"><Icon name="pencil" size={13} />Editing your entry</span>
                        : restored ? <span><Icon name="arrow-uturn-left" size={13} />Picked up where you left off. <button type="button" className="ev-link" onClick={startOver}>Start over</button></span>
                        : <span />}
                    <span className="ev-form-status-end">
                        {!editing && !preview && left > 1 && state.user && <span className="ev-budget">{plural(left, 'entry', 'entries')} left</span>}
                        {anyRequired && <span className="ev-req-note"><span className="ev-req" aria-hidden="true">*</span> Required</span>}
                    </span>
                </div>
            )}
            {pages.length > 1 && (
                <div className="ev-pages" aria-label={`Page ${at + 1} of ${pages.length}`}>
                    <span>Page {at + 1} of {pages.length}</span>
                    <span className="ev-pages-bar" aria-hidden="true"><span style={{ transform: `scaleX(${(at + 1) / pages.length})` }} /></span>
                </div>
            )}
            {current.head && (
                <div className="ev-page-intro">
                    <h3>{current.head.label}</h3>
                    {current.head.help && <p className="ev-hint">{current.head.help}</p>}
                </div>
            )}
            {current.fields.map(f => <FieldInput key={f.id} field={f} value={answers[f.id]} autofilled={filled[f.id] !== undefined && filled[f.id] === answers[f.id]} onChange={v => set(f.id, v)} />)}
            {!ev.form.length && <div className="ev-field"><p className="ev-hint">This event asks for nothing more. Submit to sign up.</p></div>}
            {guest && last && (TURNSTILE_SITE_KEY
                ? <Turnstile onToken={setToken} resetKey={tries} />
                : <p className="ev-error">Entries without an account aren't switched on for this site yet. Sign in to enter.</p>)}
            {error && <p className="ev-error" role="alert">{error}</p>}
            <div className="ev-form-actions">
                {preview && <span className="ev-hint ev-inline-hint">Preview: submitting is off.</span>}
                {editing && <button className="btn btn-secondary" type="button" onClick={() => { clearEntryDraft(ev.id, editing.id); onDone?.(); }}>Cancel</button>}
                {at > 0 && <button className="btn btn-secondary" type="button" onClick={() => goTo(at - 1)}><Icon name="chevron-left" size={15} />Back</button>}
                {last
                    // keyed apart: reusing the Next button as Submit would submit on the click that turned the page
                    ? <button key="submit" className="btn btn-primary" type="submit" disabled={busy || preview || (guest && !TURNSTILE_SITE_KEY)}>{busy ? (editing ? 'Saving…' : 'Submitting…') : editing ? 'Save changes' : 'Submit'}</button>
                    : <button key="next" className="btn btn-primary" type="button" onClick={next}>Next<Icon name="chevron-right" size={15} /></button>}
            </div>
        </form>
    );
}

function FieldInput({ field: f, value, autofilled, onChange }: { field: Field; value: any; autofilled: boolean; onChange: (v: any) => void }) {
    const id = `ev-f-${f.id}`;
    const [busy, setBusy] = useState(false);
    const isPrivate = isPrivateField(f);
    const label = (
        <label htmlFor={id} className="ev-field-label">
            {f.label}{f.required ? <span className="ev-req" aria-hidden="true"> *</span> : <span className="ev-optional"> (optional)</span>}
            {isPrivate && <span className="ev-private" title="Only the organizers see this"><Icon name="lock-closed" size={11} />Private</span>}
        </label>
    );
    const help = (f.help || autofilled) && (
        <small className="ev-field-help">{f.help}{autofilled && <span className="ev-autofill"><Icon name="check-circle" size={12} />Filled in from your account</span>}</small>
    );
    const ruleList = f.type === 'fakemon' ? describeMonRules(f.rules) : [];
    const broken = f.type === 'fakemon' && value ? monRuleProblems(value, f.rules) : [];
    const line = f.type === 'fakemon' ? lineOf(value) : [];
    async function run(task: () => Promise<void>) {
        setBusy(true);
        try { await task(); } catch (e: any) { api.showToast?.(e?.message || 'That file could not be used.', 'error'); } finally { setBusy(false); }
    }
    const pickImage = (file?: File | null) => file && run(async () => onChange(await shrinkImage(file, 1800, MAX_IMAGE_CHARS)));
    // from your collection it goes straight in with its evolution line; from a file it's checked over first
    // (an event that takes one Fakémon only gets just the one)
    const pickMon = (mon: any) => run(async () => onChange(f.rules?.maxLine === 1 ? await fakemonForEntry(mon) : await fakemonLineForEntry(mon)));
    const checkMon = (mon: any) => run(async () => openDialog('event-fakemon-details', { mon: await fakemonForEntry(mon), imported: true, rules: f.rules, onSave: onChange }));
    const makeMon = () => openDialog('event-fakemon-details', { mon: {}, rules: f.rules, onSave: onChange });
    const kinds = kindsOf(f);
    const nouns = kinds.map(k => libLabel(k).toLowerCase()).join(', ').replace(/, ([^,]*)$/, ' or $1');
    const pickLib = (x: any) => run(async () => onChange(await libraryForEntry(x)));
    const checkLib = (x: any) => openDialog('event-library-edit', { kinds, item: x, imported: true, onSave: onChange });
    const uploadLib = (file?: File | null) => file && run(async () => {
        const found = await libraryFromFile(file, kinds);
        if (found.length === 1) checkLib(found[0]);
        else openDialog('event-library-picker', { items: found, onPick: checkLib, title: 'Which one from that file?' });
    });
    const uploadMon = (file?: File | null) => file && run(async () => {
        const mons = await fakemonFromFile(file);
        // a collection export carries the line too: connected ones in the file come along
        const take = (mon: any) => run(async () => {
            const v = f.rules?.maxLine === 1 ? null : await fakemonLineForEntry(mon, mons);
            if (v && lineOf(v).length > 1) onChange(v);
            else checkMon(mon);
        });
        if (mons.length === 1) checkMon(mons[0]);
        else openDialog('event-fakemon-picker', { mons, onPick: take });
    });
    let input: ReactNode;
    switch (f.type) {
        case 'long': input = <textarea id={id} rows={5} maxLength={4000} value={value || ''} onChange={e => onChange(e.target.value)} required={f.required} />; break;
        case 'email': input = <input id={id} type="email" autoComplete="email" maxLength={254} value={value || ''} onChange={e => onChange(e.target.value)} required={f.required} />; break;
        case 'url': input = <input id={id} type="url" placeholder="https://" maxLength={500} value={value || ''} onChange={e => onChange(e.target.value)} required={f.required} />; break;
        case 'discord': input = <input id={id} type="text" placeholder="yourname" maxLength={40} autoComplete="off" value={value || ''} onChange={e => onChange(e.target.value)} required={f.required} />; break;
        case 'choice':
            input = (
                <div className="ev-choices" role="radiogroup" aria-labelledby={id}>
                    {(f.options || []).map(o => (
                        <label key={o} className={`ev-choice${value === o ? ' is-on' : ''}`}>
                            <input type="radio" name={id} checked={value === o} onChange={() => onChange(o)} />{o}
                        </label>
                    ))}
                </div>
            );
            break;
        case 'agree':
            return (
                <div className="ev-field">
                    <label className="ev-agree"><input id={id} type="checkbox" checked={value === true} onChange={e => onChange(e.target.checked)} />
                        <span>{f.label}{f.required && <span className="ev-req" aria-hidden="true"> *</span>}</span></label>
                    {f.help && <small className="ev-field-help">{f.help}</small>}
                </div>
            );
        case 'image':
            input = (
                <div className="ev-upload">
                    {value ? <img src={value} alt="" /> : <Icon name="photo" size={26} />}
                    <span>
                        <label className="btn btn-secondary btn-sm" htmlFor={id}>{busy ? 'Preparing…' : value ? 'Replace image' : 'Choose image'}</label>
                        {value && <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange('')}>Remove</button>}
                    </span>
                    <input id={id} className="ev-sr" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => { pickImage(e.target.files?.[0]); e.target.value = ''; }} />
                </div>
            );
            break;
        case 'fakemon': {
            const gaps = value ? monGaps(value) : [];
            const face = line.find(m => m.face) || line[0];
            const setLine = (members: LineMember[]) => run(async () => onChange(members.length ? await packLineForEntry(members) : null));
            const editMon = (m: LineMember) => openDialog('event-fakemon-details', {
                mon: m.mon, rules: f.rules, face: m.sourceId === face?.sourceId,
                onSave: (mon: any) => setLine(line.map(x => x.sourceId === m.sourceId ? { ...x, mon } : x))
            });
            input = (
                <div className="ev-mon-answer">
                    <div className="ev-upload ev-mon-pick">
                        {value?.artwork ? <img src={value.artwork} alt="" /> : <Icon name="sparkles" size={26} />}
                        <span>
                            {value && <strong>{value.name || 'Unnamed Fakémon'}{value.type1 && <small> · {[value.type1, value.type2].filter(Boolean).join(' / ')}</small>}</strong>}
                            {broken.length > 0 && <small className="ev-mon-gaps is-problem"><Icon name="shield-exclamation" size={12} />{monRuleSentence(broken)}</small>}
                            {gaps.length > 0 && <small className="ev-mon-gaps"><Icon name="exclamation-circle" size={12} />No {gaps.join(', ')} yet</small>}
                            {busy ? <span className="ev-hint ev-inline-hint">Preparing…</span> : value ? <span className="ev-mon-actions">
                                <button id={id} type="button" className="btn btn-secondary btn-sm" onClick={() => face && editMon(face)}><Icon name="pencil" size={14} />Edit details</button>
                                <button type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('event-fakemon-board', { mon: value })}><Icon name="book-open" size={14} />Preview</button>
                                <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange(null)}>{line.length > 1 ? 'Remove all' : 'Remove'}</button>
                            </span> : <span className="ev-mon-actions">
                                <button id={id} type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('event-fakemon-picker', { onPick: pickMon })}><Icon name="squares-2x2" size={14} />From my collection</button>
                                <label className="btn btn-secondary btn-sm" htmlFor={`${id}-file`}><Icon name="arrow-up-tray" size={14} />Import a file</label>
                                <button type="button" className="btn btn-secondary btn-sm" onClick={makeMon}><Icon name="plus" size={14} />Make one here</button>
                            </span>}
                        </span>
                        <input id={`${id}-file`} className="ev-sr" type="file" accept=".json,.txt,application/json,text/plain" onChange={e => { uploadMon(e.target.files?.[0]); e.target.value = ''; }} />
                    </div>
                    {value && (f.rules?.maxLine !== 1 || line.length > 1) && <MonLineEditor line={line} rules={f.rules} busy={busy} onChange={setLine} onEdit={editMon} />}
                </div>
            );
            break;
        }
        case 'library':
            input = (
                <div className={`ev-lib-pick${value ? ' has-value' : ''}`}>
                    {value && <LibCard v={value} />}
                    {busy ? <span className="ev-hint ev-inline-hint">Preparing…</span> : value ? <span className="ev-mon-actions">
                        <button id={id} type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('event-library-edit', { kinds, item: value, onSave: onChange })}><Icon name="pencil" size={14} />Edit</button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange(null)}>Remove</button>
                    </span> : <span className="ev-mon-actions">
                        <button id={id} type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('event-library-picker', { items: myLibrary(kinds), onPick: pickLib, title: `Choose your ${nouns}` })}><Icon name="squares-2x2" size={14} />From my collection</button>
                        <label className="btn btn-secondary btn-sm" htmlFor={`${id}-file`}><Icon name="arrow-up-tray" size={14} />Import a file</label>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('event-library-edit', { kinds, onSave: onChange })}><Icon name="plus" size={14} />Make one</button>
                    </span>}
                    <input id={`${id}-file`} className="ev-sr" type="file" accept=".json,application/json" onChange={e => { uploadLib(e.target.files?.[0]); e.target.value = ''; }} />
                </div>
            );
            break;
        case 'dropdown':
            input = (
                <select id={id} value={value || ''} onChange={e => onChange(e.target.value)} required={f.required}>
                    <option value="">Choose…</option>
                    {(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                </select>
            );
            break;
        case 'checkboxes': {
            const picked: string[] = Array.isArray(value) ? value : [];
            input = (
                <div className="ev-choices" role="group" aria-labelledby={id}>
                    {(f.options || []).map(o => (
                        <label key={o} className={`ev-choice${picked.includes(o) ? ' is-on' : ''}`}>
                            <input type="checkbox" checked={picked.includes(o)} onChange={e => onChange(e.target.checked ? [...picked, o] : picked.filter(x => x !== o))} />{o}
                        </label>
                    ))}
                </div>
            );
            break;
        }
        case 'number':
            input = <input id={id} type="number" className="ev-field-num" min={f.min ?? undefined} max={f.max ?? undefined} value={value ?? ''}
                onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} required={f.required} />;
            break;
        case 'date': input = <input id={id} type="date" className="ev-field-num" value={value || ''} onChange={e => onChange(e.target.value)} required={f.required} />; break;
        case 'scale':
            input = (
                <div className="ev-scale" role="radiogroup" aria-labelledby={id}>
                    {Array.from({ length: f.max || 5 }, (_, i) => (
                        <button key={i} type="button" role="radio" aria-checked={value === i + 1} className={`ev-scale-step${value === i + 1 ? ' is-on' : ''}`} onClick={() => onChange(i + 1)}>{i + 1}</button>
                    ))}
                </div>
            );
            break;
        default: input = <input id={id} type="text" maxLength={200} value={value || ''} onChange={e => onChange(e.target.value)} required={f.required} />;
    }
    return (
        <div className="ev-field">{label}{input}{help}
            {ruleList.length > 0 && <ul className="ev-mon-rules" aria-label="Rules">{ruleList.map(r => <li key={r}><Icon name="shield-check" size={12} />{r}</li>)}</ul>}
            {f.type === 'library' && <small className="ev-field-help">Takes a {nouns}. Pick one you've made, import a Woogidex export (.json), or make one right here.</small>}
            {f.type === 'fakemon' && <small className="ev-field-help">Pick one from your collection and its evolution line comes with it. No Woogidex collection? Import a Woogidex export (.json or .txt), or make one right here; you'll be asked for anything it's missing. Your entry holds its own copy, so it doesn't count toward your Community uploads or cloud storage.</small>}
        </div>
    );
}

/** Choose a Fakémon: from your collection, or from the ones in an uploaded file. */
function FakemonPickerDialog({ close, onPick, mons }: DialogProps<{ onPick: (v: any) => void; mons?: any[] }>) {
    const [query, setQuery] = useState('');
    const q = query.trim().toLowerCase();
    const source: any[] = mons || (state.fakemonDB || []).filter(m => !m.pendingVanilla);
    const options = source.filter(m => !q || [m.name, m.type1, m.type2].some(x => (x || '').toLowerCase().includes(q)));
    return (
        <Modal onClose={close} className="modal-wide" title={mons ? 'Which Fakémon from that file?' : 'Choose a Fakémon'}>
            <div className="search-bar"><input type="search" placeholder="Search…" value={query} onChange={e => setQuery(e.target.value)} autoFocus aria-label="Search Fakémon" /></div>
            {options.length ? (
                <div className="collection-grid contest-mon-picker-grid" style={{ display: 'grid' }}>
                    {options.map((m, i) => (
                        <button type="button" className="collection-card" key={m.id || i} onClick={() => { close(); onPick(m); }}>
                            <div className="card-art">{m.artwork ? <img src={m.artwork} alt="" draggable={false} /> : <img className="no-art-placeholder" src="assets/no_art_placeholder.png" alt="" draggable={false} />}</div>
                            <div className="card-name">{m.name || 'Unnamed'}</div>
                        </button>
                    ))}
                </div>
            ) : <div className="ev-empty"><p>{source.length ? 'Nothing matches your search.' : 'Your collection is empty. Make a Fakémon first, or upload a file.'}</p></div>}
        </Modal>
    );
}
registerDialog('event-fakemon-picker', FakemonPickerDialog);

// ---- a Fakémon answer's evolution line ----
// Picked from a collection, the line comes along by itself; anyone else (a
// file, or one made here) adds the rest and says how they connect.

/** Who a member comes after, in words: "evolves from Sproutle (Level 16)". */
function lineLink(line: LineMember[], m: LineMember): string {
    const parent = m.from ? line.find(x => x.sourceId === m.from)?.mon?.name || '?' : '';
    const how = m.method ? ` (${m.method})` : '';
    if (!parent) return m.stage === 1 && line.length > 1 ? 'First stage' : '';
    return m.isMega ? `Mega Evolution of ${parent}${how}` : m.isFormeChange ? `A form of ${parent}${how}` : `Evolves from ${parent}${how}`;
}

/** Take one out; whatever came after it now comes after what it came from. */
function withoutMember(line: LineMember[], m: LineMember): LineMember[] {
    return line.filter(x => x.sourceId !== m.sourceId).map(x => x.from === m.sourceId ? { ...x, from: m.from ?? null } : x);
}

function MonLineEditor({ line, rules, busy, onChange, onEdit }: {
    line: LineMember[]; rules?: MonRules; busy: boolean; onChange: (l: LineMember[]) => void; onEdit: (m: LineMember) => void;
}) {
    const cap = Math.min(LINE_MAX, rules?.maxLine || LINE_MAX);
    const full = line.length >= cap;
    const add = () => openDialog('event-line-member', { line, rules, onSave: onChange });
    return (
        <div className="ev-line">
            <div className="ev-line-head">
                <span className="ev-q-sub">Evolution line{line.length > 1 && <span className="ev-budget">{line.length}{rules?.maxLine ? ` / ${rules.maxLine}` : ''}</span>}</span>
                {!full && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={add}><Icon name="plus" size={14} />Add an evolution or form</button>}
            </div>
            {line.length > 1 ? (
                <ol className="ev-line-list">
                    {line.map(m => (
                        <li key={m.sourceId} className={m.face ? 'is-face' : ''}>
                            <span className="ev-line-art">{m.mon?.artwork ? <img src={m.mon.artwork} alt="" /> : <Icon name="sparkles" size={18} />}</span>
                            <span className="ev-line-who">
                                <strong>{m.mon?.name || 'Unnamed'} <span className="ev-line-stage">{lineLabel(m)}</span></strong>
                                <small>{[lineLink(line, m), m.face && 'Shown on cards'].filter(Boolean).join(' · ')}</small>
                            </span>
                            <span className="ev-mon-actions">
                                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => openDialog('event-line-member', { line, rules, member: m, onSave: onChange })}><Icon name="link" size={14} />Connect</button>
                                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onEdit(m)}><Icon name="pencil" size={14} />Edit</button>
                                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} aria-label={`Take ${m.mon?.name || 'this one'} out of the line`} onClick={() => onChange(withoutMember(line, m))}><Icon name="x-mark" size={14} /></button>
                            </span>
                        </li>
                    ))}
                </ol>
            ) : <p className="ev-hint">Does it evolve, or have a Mega or another form? Add them here and they're entered and judged together.</p>}
            {full && rules?.maxLine && <p className="ev-hint">This event takes up to {rules.maxLine} Fakémon in a line.</p>}
        </div>
    );
}

/** Add a Fakémon to the line (from your collection, a file, or made here), or change how one connects. */
function LineMemberDialog({ close, line, rules, member, onSave }: DialogProps<{ line: LineMember[]; rules?: MonRules; member?: LineMember; onSave: (l: LineMember[]) => void }>) {
    const [mon, setMon] = useState<any>(member?.mon || null);
    const [busy, setBusy] = useState(false);
    const face = line.find(m => m.face) || line[line.length - 1];
    // what comes after this one can't be what it comes from
    const after = useMemo(() => {
        const out = new Set<string>(member ? [member.sourceId] : []);
        for (let grew = true; grew;) {
            grew = false;
            for (const x of line) if (x.from && out.has(x.from) && !out.has(x.sourceId)) { out.add(x.sourceId); grew = true; }
        }
        return out;
    }, [line, member]);
    const others = line.filter(x => !after.has(x.sourceId));
    const initial = member
        ? (!member.from ? 'first' : `${member.isMega ? 'mega' : member.isFormeChange ? 'form' : 'from'}:${member.from}`)
        : `from:${face?.sourceId}`;
    const [link, setLink] = useState(initial);
    const [method, setMethod] = useState(member?.method || '');
    const [kind, target] = link.split(':');
    const name = (x: LineMember) => x.mon?.name || 'Unnamed';

    async function run(task: () => Promise<void>) {
        setBusy(true);
        try { await task(); } catch (e: any) { api.showToast?.(e?.message || 'That could not be used.', 'error'); } finally { setBusy(false); }
    }
    const fromFile = (file?: File | null) => file && run(async () => {
        const mons = await fakemonFromFile(file);
        const check = (x: any) => run(async () => openDialog('event-fakemon-details', { mon: await fakemonForEntry(x), imported: true, rules, face: false, onSave: setMon }));
        if (mons.length === 1) check(mons[0]);
        else openDialog('event-fakemon-picker', { mons, onPick: check });
    });

    function save() {
        if (!mon) { api.showToast?.('Choose the Fakémon first.', 'warning'); return; }
        const id = member?.sourceId || newSourceId();
        const how = method.trim().slice(0, 120);
        let next = line.map(x => ({ ...x }));
        const me: LineMember = {
            sourceId: id, stage: 1, mon, isMega: kind === 'mega', isFormeChange: kind === 'form',
            from: kind === 'first' ? null : kind === 'into' ? (next.find(x => x.sourceId === target)?.from ?? null) : target,
            method: kind === 'into' || kind === 'first' ? '' : how
        };
        // slotted in before one: that one now evolves from this, the way described
        if (kind === 'into') next = next.map(x => x.sourceId === target ? { ...x, from: id, isMega: false, isFormeChange: false, method: how } : x);
        next = member ? next.map(x => x.sourceId === id ? me : x) : [...next, me];
        onSave(next);
        close();
    }

    return (
        <Modal onClose={close} className="ev-line-modal" title={member ? `Connect ${name(member)}` : 'Add to the evolution line'} dismissible={!busy}>
            {!member && (
                <div className="ev-field">
                    <span className="ev-field-label">The Fakémon</span>
                    {mon ? (
                        <div className="ev-upload ev-mon-pick">
                            {mon.artwork ? <img src={mon.artwork} alt="" /> : <Icon name="sparkles" size={26} />}
                            <span>
                                <strong>{mon.name || 'Unnamed Fakémon'}{mon.type1 && <small> · {[mon.type1, mon.type2].filter(Boolean).join(' / ')}</small>}</strong>
                                <span className="ev-mon-actions">
                                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('event-fakemon-details', { mon, rules, face: false, onSave: setMon })}><Icon name="pencil" size={14} />Edit details</button>
                                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMon(null)}>Choose another</button>
                                </span>
                            </span>
                        </div>
                    ) : busy ? <span className="ev-hint">Preparing…</span> : (
                        <span className="ev-mon-actions">
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('event-fakemon-picker', { onPick: (x: any) => run(async () => setMon(await fakemonForEntry(x))) })}><Icon name="squares-2x2" size={14} />From my collection</button>
                            <label className="btn btn-secondary btn-sm" htmlFor="ev-line-file"><Icon name="arrow-up-tray" size={14} />Import a file</label>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('event-fakemon-details', { mon: {}, rules, face: false, onSave: setMon })}><Icon name="plus" size={14} />Make one here</button>
                        </span>
                    )}
                    <input id="ev-line-file" className="ev-sr" type="file" accept=".json,.txt,application/json,text/plain" onChange={e => { fromFile(e.target.files?.[0]); e.target.value = ''; }} />
                </div>
            )}
            <div className="ev-field">
                <label className="ev-field-label" htmlFor="ev-line-link">How it connects</label>
                <select id="ev-line-link" value={link} onChange={e => setLink(e.target.value)}>
                    {member && <option value="first">It's the first stage</option>}
                    {others.map(x => <option key={`from:${x.sourceId}`} value={`from:${x.sourceId}`}>Evolves from {name(x)}</option>)}
                    {!member && others.map(x => <option key={`into:${x.sourceId}`} value={`into:${x.sourceId}`}>Evolves into {name(x)}</option>)}
                    {others.filter(x => !x.isMega && !x.isFormeChange).map(x => <option key={`mega:${x.sourceId}`} value={`mega:${x.sourceId}`}>Mega Evolution of {name(x)}</option>)}
                    {others.filter(x => !x.isMega && !x.isFormeChange).map(x => <option key={`form:${x.sourceId}`} value={`form:${x.sourceId}`}>Another form of {name(x)}</option>)}
                </select>
            </div>
            {kind !== 'first' && (
                <div className="ev-field">
                    <label className="ev-field-label" htmlFor="ev-line-how">How it happens <span className="ev-optional">(optional)</span></label>
                    <input id="ev-line-how" maxLength={120} value={method} onChange={e => setMethod(e.target.value)}
                        placeholder={kind === 'mega' ? 'Holding its Mega Stone' : kind === 'form' ? 'In the rain, holding an item…' : 'Level 16, a Fire Stone, high friendship…'} />
                </div>
            )}
            {rules?.noForms && (kind === 'mega' || kind === 'form') && <p className="ev-notice is-problem"><Icon name="shield-exclamation" size={15} /><span>This event doesn't allow Megas or other forms.</span></p>}
            <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={close}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={busy || !mon} onClick={save}>{member ? 'Save' : 'Add to the line'}</button>
            </div>
        </Modal>
    );
}
registerDialog('event-line-member', LineMemberDialog);

// ---- a Fakémon answer's details ----
// An imported file (a text export especially) can leave things out; this asks
// for them, and lets an entrant fix anything before it goes in.

const MON_STATS: Array<[string, string]> = [['hp', 'HP'], ['atk', 'Attack'], ['def', 'Defense'], ['spa', 'Sp. Atk'], ['spd', 'Sp. Def'], ['spe', 'Speed']];
/** What a Fakémon answer is missing that a judge would look for. */
const monGaps = (m: any): string[] => [
    !String(m?.name || '').trim() && 'name',
    !m?.type1 && 'type',
    !m?.artwork && 'artwork',
    !(m?.abilities || []).some((a: any) => a?.name) && 'abilities',
    !String(m?.dexEntry1 || '').trim() && 'Pokédex entry'
].filter(Boolean) as string[];

/** A typed ability's source: a main-game one if Showdown knows the name, else custom. */
const abilitySource = (name: string) => state.sdAbilities?.[name.toLowerCase().replace(/[^a-z0-9]/g, '')]
    ? { source: 'sd', custom: false } : { source: 'custom', custom: true };

function FakemonDetailsDialog({ close, mon, imported = false, rules, face = true, onSave }: DialogProps<{ mon: any; imported?: boolean; rules?: MonRules; face?: boolean; onSave: (m: any) => void }>) {
    // made right here, from nothing (no collection, no file)
    const [fresh] = useState(() => !imported && !String(mon?.name || '').trim() && !mon?.type1);
    const [m, setM] = useState<any>(() => ({
        ...mon,
        stats: Object.fromEntries(MON_STATS.map(([k]) => [k, Number(mon?.stats?.[k]) || 60])),
        abilities: [0, 1, 2].map(i => mon?.abilities?.[i] || { name: '', source: 'custom', custom: true, desc: '' })
    }));
    const [busy, setBusy] = useState(false);
    // the main-game abilities, so a typed "Overgrow" isn't counted as a custom one
    useEffect(() => { Promise.resolve(api.fetchShowdownData?.()).catch(() => {}); }, []);
    const set = (patch: any) => setM((x: any) => ({ ...x, ...patch }));
    const gaps = monGaps(m);
    const bst = MON_STATS.reduce((n, [k]) => n + (Number(m.stats[k]) || 0), 0);
    const cleaned = () => ({ ...m, name: String(m.name || '').trim(), abilities: m.abilities.filter((a: any) => a.name.trim()) });
    const missingClass = (gap: string) => gaps.includes(gap) ? ' is-missing' : '';

    async function pickArt(file?: File | null) {
        if (!file) return;
        setBusy(true);
        try { set({ artwork: await shrinkImage(file, 1200, MAX_IMAGE_CHARS) }); }
        catch (e: any) { api.showToast?.(e?.message || 'That image could not be used.', 'error'); }
        setBusy(false);
    }
    async function save() {
        if (!String(m.name || '').trim()) { api.showToast?.('Give your Fakémon a name.', 'warning'); return; }
        if (!m.type1) { api.showToast?.('Give your Fakémon a type.', 'warning'); return; }
        setBusy(true);
        try { onSave(await fakemonForEntry(cleaned())); close(); }
        catch (e: any) { api.showToast?.(e?.message || 'That Fakémon could not be used.', 'error'); }
        setBusy(false);
    }

    return (
        <Modal onClose={close} className="modal-wide ev-mon-modal" title={imported ? 'Check your Fakémon' : fresh ? 'Make a Fakémon' : 'Edit your Fakémon'} dismissible={!busy}>
            {imported && (gaps.length
                ? <p className="ev-notice"><Icon name="exclamation-circle" size={15} /><span>The file didn't include its <strong>{gaps.join(', ')}</strong>. Fill in what you can; only the name and type are needed.</span></p>
                : <p className="ev-notice is-done"><Icon name="check-circle" size={15} />Everything came through. Look it over, then use it.</p>)}
            {memberRuleProblems(cleaned(), rules, face).length > 0 && (
                <p className="ev-notice is-problem"><Icon name="shield-exclamation" size={15} /><span>{monRuleSentence(memberRuleProblems(cleaned(), rules, face))}</span></p>
            )}
            <div className="ev-mon-edit">
                <div className={`ev-mon-art${missingClass('artwork')}`}>
                    {m.artwork ? <img src={m.artwork} alt="" /> : <Icon name="photo" size={30} />}
                    <span>
                        <label className="btn btn-secondary btn-sm" htmlFor="ev-mon-art">{m.artwork ? 'Replace art' : 'Add artwork'}</label>
                        {m.artwork && <button type="button" className="btn btn-secondary btn-sm" onClick={() => set({ artwork: '' })}>Remove</button>}
                    </span>
                    <input id="ev-mon-art" className="ev-sr" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => { pickArt(e.target.files?.[0]); e.target.value = ''; }} />
                </div>
                <div className="ev-mon-fields">
                    <div className="ev-two">
                        <div className={`ev-field${missingClass('name')}`}><label className="ev-field-label" htmlFor="ev-mon-name">Name<span className="ev-req" aria-hidden="true"> *</span></label>
                            <input id="ev-mon-name" maxLength={40} value={m.name || ''} onChange={e => set({ name: e.target.value })} /></div>
                        <div className="ev-field"><label className="ev-field-label" htmlFor="ev-mon-species">Species</label>
                            <input id="ev-mon-species" maxLength={40} value={m.species || ''} onChange={e => set({ species: e.target.value })} placeholder="Seed Pokémon" /></div>
                    </div>
                    <div className="ev-two">
                        <div className={`ev-field${missingClass('type')}`}><label className="ev-field-label" htmlFor="ev-mon-t1">Type<span className="ev-req" aria-hidden="true"> *</span></label>
                            <input id="ev-mon-t1" list="ev-mon-types" maxLength={24} value={m.type1 || ''} onChange={e => set({ type1: e.target.value })} placeholder="Grass" /></div>
                        <div className="ev-field"><label className="ev-field-label" htmlFor="ev-mon-t2">Second type</label>
                            <input id="ev-mon-t2" list="ev-mon-types" maxLength={24} value={m.type2 || ''} onChange={e => set({ type2: e.target.value })} placeholder="None" /></div>
                        <datalist id="ev-mon-types">{SELECTABLE_TYPES.map((t: string) => <option key={t} value={t} />)}</datalist>
                    </div>
                </div>
            </div>
            <fieldset className="ev-mon-stats">
                <legend className="ev-field-label">Base stats <span className="ev-budget">BST {bst}</span></legend>
                {MON_STATS.map(([k, label]) => (
                    <label key={k}><span>{label}</span>
                        <input type="number" min={1} max={255} value={m.stats[k]} onChange={e => set({ stats: { ...m.stats, [k]: Math.min(255, Math.max(0, Number(e.target.value) || 0)) } })} /></label>
                ))}
            </fieldset>
            <div className={`ev-field${missingClass('abilities')}`}>
                <span className="ev-field-label">Abilities</span>
                <div className="ev-mon-abilities">
                    {m.abilities.map((a: any, i: number) => (
                        <input key={i} maxLength={40} value={a.name} aria-label={`Ability ${i + 1}`} placeholder={i === 2 ? 'Hidden ability' : `Ability ${i + 1}`}
                            onChange={e => set({ abilities: m.abilities.map((x: any, j: number) => j === i ? { ...x, name: e.target.value, ...abilitySource(e.target.value) } : x) })} />
                    ))}
                </div>
            </div>
            <div className={`ev-field${missingClass('Pokédex entry')}`}><label className="ev-field-label" htmlFor="ev-mon-dex">Pokédex entry</label>
                <textarea id="ev-mon-dex" rows={3} maxLength={600} value={m.dexEntry1 || ''} onChange={e => set({ dexEntry1: e.target.value })} /></div>
            <div className="ev-two">
                <div className="ev-field"><label className="ev-field-label" htmlFor="ev-mon-h">Height</label>
                    <input id="ev-mon-h" maxLength={20} value={m.height || ''} onChange={e => set({ height: e.target.value })} placeholder="0.7 m" /></div>
                <div className="ev-field"><label className="ev-field-label" htmlFor="ev-mon-w">Weight</label>
                    <input id="ev-mon-w" maxLength={20} value={m.weight || ''} onChange={e => set({ weight: e.target.value })} placeholder="6.9 kg" /></div>
            </div>
            <p className="ev-hint">{fresh
                ? 'That covers what judges look at first. For moves, sample sets and the rest, make it in the Woogidex editor and import it.'
                : 'Moves, sets and everything else come along as they are. To change those, edit it in Woogidex and import it again.'}</p>
            <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => openDialog('event-fakemon-board', { mon: cleaned() })}><Icon name="book-open" size={15} />Preview</button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Preparing…' : 'Use this Fakémon'}</button>
            </div>
        </Modal>
    );
}
registerDialog('event-fakemon-details', FakemonDetailsDialog);

// ---- moves, abilities, items and types as answers ----

const ALL_LIB_KINDS: LibKind[] = ['move', 'ability', 'item', 'type'];
const kindsOf = (f: Field): LibKind[] => f.kinds?.length ? f.kinds : ALL_LIB_KINDS;
const kindIcon = (k: LibKind) => LIB_KINDS.find(x => x[0] === k)?.[2] || 'puzzle-piece';
const typeClass = (t: string) => `type-badge type-${String(t).toLowerCase()}`;
const swatch = (v: any) => v.gradient?.stops?.length
    ? `linear-gradient(${v.gradient.angle ?? 90}deg, ${v.gradient.stops.map((s: any) => `${s.color} ${s.pos}%`).join(', ')})`
    : v.color || 'var(--text-muted)';

/** A move, ability, item or type, the way an entrant or a voter sees it. */
function LibCard({ v }: { v: any }) {
    const acc = v.accuracy === true || v.accuracy === '' || v.accuracy == null ? '—' : `${v.accuracy}%`;
    return (
        <div className="ev-lib-card">
            {v.kind === 'item' && v.artwork ? <img className="ev-lib-art" src={v.artwork} alt="" />
                : v.kind === 'type' ? <span className="ev-lib-art ev-lib-swatch" style={{ background: swatch(v) }} aria-hidden="true" />
                : <span className="ev-lib-art"><Icon name={kindIcon(v.kind)} size={22} /></span>}
            <div className="ev-lib-body">
                <span className="ev-lib-kind">{libLabel(v.kind)}</span>
                <strong>{v.name || 'Unnamed'}</strong>
                {v.kind === 'move' && (
                    <span className="ev-lib-meta">
                        {v.type && <span className={typeClass(v.type)}>{v.type}</span>}
                        <span>{[v.category, `Power ${v.basePower || '—'}`, `Accuracy ${acc}`, v.pp && `PP ${v.pp}`, Number(v.priority) ? `Priority ${Number(v.priority) > 0 ? '+' : ''}${v.priority}` : '']
                            .filter(Boolean).join(' · ')}</span>
                    </span>
                )}
                {v.desc && <p className="ev-prose">{v.desc}</p>}
            </div>
        </div>
    );
}

/** Pick one of your own, or one from a file. */
function LibraryPickerDialog({ close, items, onPick, title }: DialogProps<{ items: any[]; onPick: (v: any) => void; title: string }>) {
    const [query, setQuery] = useState('');
    const q = query.trim().toLowerCase();
    const shown = items.filter(x => !q || [x.name, x.type, x.desc].some(s => String(s || '').toLowerCase().includes(q)));
    return (
        <Modal onClose={close} title={title} className="ev-lib-picker">
            <div className="search-bar"><input type="search" placeholder="Search…" value={query} onChange={e => setQuery(e.target.value)} autoFocus aria-label="Search" /></div>
            {shown.length ? (
                <ul className="ev-lib-list">
                    {shown.map((x, i) => (
                        <li key={`${x.kind}-${x.id || i}`}>
                            <button type="button" onClick={() => { close(); onPick(x); }}><LibCard v={x} /></button>
                        </li>
                    ))}
                </ul>
            ) : <div className="ev-empty"><p>{items.length ? 'Nothing matches your search.' : 'You haven\'t made any yet. Close this and choose "Make one".'}</p></div>}
        </Modal>
    );
}
registerDialog('event-library-picker', LibraryPickerDialog);

const MOVE_CATEGORIES = ['Physical', 'Special', 'Status'];

/** Make one on the spot, or check one from a file or your collection before it goes in. */
function LibraryEditDialog({ close, kinds, item, imported = false, onSave }: DialogProps<{ kinds: LibKind[]; item?: any; imported?: boolean; onSave: (v: any) => void }>) {
    const [v, setV] = useState<any>(() => item ? { ...item } : { kind: kinds[0], name: '', desc: '', category: 'Physical', color: '#7c5cff' });
    const [busy, setBusy] = useState(false);
    const set = (patch: any) => setV((x: any) => ({ ...x, ...patch }));
    const num = (s: string) => s === '' ? '' : Math.max(0, Math.min(999, Number(s) || 0));

    async function pickArt(file?: File | null) {
        if (!file) return;
        setBusy(true);
        try { set({ artwork: await shrinkImage(file, 512, 380_000) }); }
        catch (e: any) { api.showToast?.(e?.message || 'That image could not be used.', 'error'); }
        setBusy(false);
    }
    async function save() {
        if (!String(v.name || '').trim()) { api.showToast?.('Give it a name.', 'warning'); return; }
        setBusy(true);
        try { onSave(await libraryForEntry(v)); close(); }
        catch (e: any) { api.showToast?.(e?.message || 'That could not be used.', 'error'); }
        setBusy(false);
    }

    const noun = libLabel(v.kind).toLowerCase();
    return (
        <Modal onClose={close} className="ev-lib-modal" dismissible={!busy}
            title={item ? (imported ? `Check your ${noun}` : `Edit your ${noun}`) : 'Make one for this entry'}>
            {!item && kinds.length > 1 && (
                <div className="ev-segmented ev-lib-kinds" role="radiogroup" aria-label="What it is">
                    {kinds.map(k => (
                        <button key={k} type="button" role="radio" aria-checked={v.kind === k} className={v.kind === k ? 'active' : ''} onClick={() => set({ kind: k })}>
                            <Icon name={kindIcon(k)} size={14} />{libLabel(k)}
                        </button>
                    ))}
                </div>
            )}
            <div className="ev-field"><label className="ev-field-label" htmlFor="ev-lib-name">Name<span className="ev-req" aria-hidden="true"> *</span></label>
                <input id="ev-lib-name" maxLength={v.kind === 'type' ? 16 : 40} value={v.name || ''} onChange={e => set({ name: e.target.value })} autoFocus /></div>
            {v.kind === 'move' && <>
                <div className="ev-two">
                    <div className="ev-field"><label className="ev-field-label" htmlFor="ev-lib-type">Type</label>
                        <input id="ev-lib-type" list="ev-lib-types" maxLength={24} value={v.type || ''} onChange={e => set({ type: e.target.value })} placeholder="Fire" />
                        <datalist id="ev-lib-types">{SELECTABLE_TYPES.map((t: string) => <option key={t} value={t} />)}</datalist></div>
                    <div className="ev-field"><label className="ev-field-label" htmlFor="ev-lib-cat">Category</label>
                        <select id="ev-lib-cat" value={v.category || 'Physical'} onChange={e => set({ category: e.target.value })}>
                            {MOVE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select></div>
                </div>
                <div className="ev-lib-nums">
                    <label><span>Power</span><input type="number" min={0} max={999} value={v.basePower ?? ''} onChange={e => set({ basePower: num(e.target.value) })} placeholder="—" /></label>
                    <label><span>Accuracy</span><input type="number" min={0} max={100} value={v.accuracy === true ? '' : v.accuracy ?? ''} onChange={e => set({ accuracy: e.target.value === '' ? true : num(e.target.value) })} placeholder="Always hits" /></label>
                    <label><span>PP</span><input type="number" min={1} max={64} value={v.pp ?? ''} onChange={e => set({ pp: num(e.target.value) })} /></label>
                    <label><span>Priority</span><input type="number" min={-7} max={5} value={v.priority ?? 0} onChange={e => set({ priority: Math.max(-7, Math.min(5, Number(e.target.value) || 0)) })} /></label>
                </div>
            </>}
            {v.kind === 'type' && (
                <div className="ev-field"><label className="ev-field-label" htmlFor="ev-lib-color">Colour</label>
                    <input id="ev-lib-color" type="color" value={/^#[0-9a-f]{6}$/i.test(v.color || '') ? v.color : '#7c5cff'} onChange={e => set({ color: e.target.value, gradient: null })} /></div>
            )}
            {v.kind === 'item' && (
                <div className="ev-field"><span className="ev-field-label">Picture <span className="ev-optional">(optional)</span></span>
                    <div className="ev-upload">
                        {v.artwork ? <img src={v.artwork} alt="" /> : <Icon name="photo" size={26} />}
                        <span>
                            <label className="btn btn-secondary btn-sm" htmlFor="ev-lib-art">{v.artwork ? 'Replace' : 'Upload'}</label>
                            {v.artwork && <button type="button" className="btn btn-secondary btn-sm" onClick={() => set({ artwork: '' })}>Remove</button>}
                        </span>
                        <input id="ev-lib-art" className="ev-sr" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => { pickArt(e.target.files?.[0]); e.target.value = ''; }} />
                    </div></div>
            )}
            <div className="ev-field"><label className="ev-field-label" htmlFor="ev-lib-desc">What it does</label>
                <textarea id="ev-lib-desc" rows={3} maxLength={600} value={v.desc || ''} onChange={e => set({ desc: e.target.value })}
                    placeholder={v.kind === 'move' ? 'Has a 30% chance to burn the target.' : v.kind === 'type' ? 'Strong against Fairy, weak to Steel…' : v.kind === 'item' ? 'Holder’s Fire moves have 1.2x power.' : 'Boosts the user’s Speed in the rain.'} /></div>
            {item && <p className="ev-hint">Anything else it has (battle code, matchups) comes along as it is.</p>}
            <div className="ev-lib-preview"><span className="ev-field-label">Preview</span><LibCard v={v} /></div>
            <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={close}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Preparing…' : `Use this ${noun}`}</button>
            </div>
        </Modal>
    );
}
registerDialog('event-library-edit', LibraryEditDialog);

/** A Fakémon question's rules, in the form builder. */
function MonRulesEditor({ rules = {}, onChange }: { rules?: MonRules; onChange: (r: MonRules | undefined) => void }) {
    const update = (patch: Partial<MonRules>) => {
        const next: MonRules = { ...rules, ...patch };
        // nothing set: no rules object at all
        // unset keys dropped (event_rules_ok refuses keys it doesn't know, and null is noise)
        for (const k of Object.keys(next) as Array<keyof MonRules>) if (next[k] == null || next[k] === false) delete next[k];
        if (next.maxLine === 1) { delete next.minLine; delete next.noForms; }
        if (next.minLine && next.maxLine && next.minLine > next.maxLine) next.minLine = next.maxLine;
        const empty = !next.require?.length && !next.types?.length && Object.keys(next).every(k => k === 'require' || k === 'types');
        onChange(empty ? undefined : next);
    };
    // a custom-content limit as one select: any, none (the old noCustom flag), or up to n
    const limitValue = (no: boolean | undefined, max: number | null | undefined) => no ? 'none' : max != null ? String(max) : 'any';
    const limitPatch = (noKey: 'noCustomAbilities' | 'noCustomMoves', maxKey: 'maxCustomAbilities' | 'maxCustomMoves', v: string): Partial<MonRules> =>
        v === 'none' ? { [noKey]: true, [maxKey]: undefined } : { [noKey]: undefined, [maxKey]: v === 'any' ? undefined : Number(v) };
    const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    const toggle = <T,>(list: T[] | undefined, x: T) => list?.includes(x) ? list.filter(y => y !== x) : [...(list || []), x];
    const count = describeMonRules(rules).length;
    return (
        <details className="ev-q-rules" open={count > 0 || undefined}>
            <summary><Icon name="shield-check" size={14} />Rules{count > 0 && <span className="ev-budget">{count}</span>}</summary>
            <div className="ev-q-rules-body">
                <div className="ev-q-rule-row"><span className="ev-q-sub">Must have</span>
                    <div className="ev-chips">
                        {MON_PARTS.map(([p, words]) => {
                            const on = !!rules.require?.includes(p);
                            return <button key={p} type="button" className={`ev-chip${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => update({ require: toggle(rules.require, p) })}>{words.replace(/^an? /, '')}</button>;
                        })}
                    </div></div>
                <div className="ev-q-rule-row"><span className="ev-q-sub">Evolution line</span>
                    <div className="ev-criterion-row">
                        <label className="ev-inline-select">Fakémon in the line
                            <select value={rules.maxLine ?? ''} onChange={e => update({ maxLine: e.target.value === '' ? undefined : Number(e.target.value) })}>
                                <option value="">Any number</option>
                                <option value="1">Just one: no evolutions or forms</option>
                                {upTo(LINE_MAX).slice(1).map(n => <option key={n} value={n}>Up to {n}</option>)}
                            </select></label>
                        {rules.maxLine !== 1 && <label className="ev-inline-select">At least
                            <select value={rules.minLine ?? ''} onChange={e => update({ minLine: e.target.value === '' ? undefined : Number(e.target.value) })}>
                                <option value="">No minimum</option>
                                {upTo(rules.maxLine || LINE_MAX).slice(1).map(n => <option key={n} value={n}>{n}</option>)}
                            </select></label>}
                    </div>
                    {rules.maxLine !== 1 && <div className="ev-q-flags">
                        <label><input type="checkbox" checked={!!rules.noForms} onChange={e => update({ noForms: e.target.checked || undefined })} />No Megas or other forms</label>
                    </div>}
                    {rules.maxLine !== 1 && <small className="ev-field-help">Megas and forms count toward the number. Type and BST rules apply to the final evolution; everything else applies to each Fakémon.</small>}
                </div>
                <div className="ev-q-rule-row"><span className="ev-q-sub">Custom content <span className="ev-optional">{rules.maxLine === 1 ? '' : '(counted once across the line)'}</span></span>
                    <div className="ev-criterion-row">
                        <label className="ev-inline-select">Custom types
                            <select value={rules.noCustomTypes ? 'none' : 'any'} onChange={e => update({ noCustomTypes: e.target.value === 'none' || undefined })}>
                                <option value="any">Allowed</option><option value="none">Not allowed</option>
                            </select></label>
                        <label className="ev-inline-select">Custom abilities
                            <select value={limitValue(rules.noCustomAbilities, rules.maxCustomAbilities)} onChange={e => update(limitPatch('noCustomAbilities', 'maxCustomAbilities', e.target.value))}>
                                <option value="any">Any number</option><option value="none">None</option>
                                {upTo(4).map(n => <option key={n} value={n}>Up to {n}</option>)}
                            </select></label>
                        <label className="ev-inline-select">Custom moves
                            <select value={limitValue(rules.noCustomMoves, rules.maxCustomMoves)} onChange={e => update(limitPatch('noCustomMoves', 'maxCustomMoves', e.target.value))}>
                                <option value="any">Any number</option><option value="none">None</option>
                                {upTo(10).map(n => <option key={n} value={n}>Up to {n}</option>)}
                            </select></label>
                        <label className="ev-inline-select">All together
                            <select value={rules.maxCustomTotal ?? ''} onChange={e => update({ maxCustomTotal: e.target.value === '' ? undefined : Number(e.target.value) })}>
                                <option value="">No limit</option>
                                {upTo(10).map(n => <option key={n} value={n}>Up to {n}</option>)}
                            </select></label>
                    </div>
                    <small className="ev-field-help">For example: up to 1 custom ability and 1 custom move, or up to 2 custom things of any kind in all.</small>
                </div>
                <div className="ev-q-rule-row"><span className="ev-q-sub">Base stat total</span>
                    <div className="ev-criterion-row">
                        <label className="ev-inline-select">At least <input type="number" className="ev-num" min={1} max={1530} value={rules.minBst ?? ''} onChange={e => update({ minBst: e.target.value === '' ? undefined : Math.min(1530, Math.max(1, Number(e.target.value) || 1)) })} /></label>
                        <label className="ev-inline-select">At most <input type="number" className="ev-num" min={1} max={1530} value={rules.maxBst ?? ''} onChange={e => update({ maxBst: e.target.value === '' ? undefined : Math.min(1530, Math.max(1, Number(e.target.value) || 1)) })} /></label>
                    </div></div>
                <div className="ev-q-rule-row"><span className="ev-q-sub">Must be one of these types <span className="ev-optional">(none picked: any)</span></span>
                    <div className="ev-chips">
                        {SELECTABLE_TYPES.map((t: string) => {
                            const on = !!rules.types?.includes(t);
                            return <button key={t} type="button" className={`ev-chip${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => update({ types: toggle(rules.types, t) })}>{t}</button>;
                        })}
                    </div></div>
            </div>
        </details>
    );
}

// ==================== the dashboard ====================

const TABS: Array<[DashTab, string, string, keyof ReturnType<typeof permsFor>]> = [
    ['overview', 'Overview', 'squares-2x2', 'view'],
    ['entries', 'Responses', 'inbox-stack', 'entries'],
    ['announcements', 'Announcements', 'megaphone', 'edit'],
    ['results', 'Results', 'chart-bar', 'results'],
    ['team', 'Team', 'users', 'view'],
    ['settings', 'Settings', 'cog-6-tooth', 'edit']
];

function Dashboard({ id, tab }: { id: string; tab: DashTab }) {
    const d = useDetail(id);
    if (!d?.event) return <><BackLink to={{ kind: 'list' }}>All events</BackLink><DetailState d={d} /></>;
    const ev = d.event;
    const perms = permsFor(ev, d.helpers);
    if (!perms.view) {
        return (
            <>
                <BackLink to={{ kind: 'event', id }}>Event page</BackLink>
                <div className="ev-empty"><Icon name="lock-closed" size={24} /><h4>This dashboard is for the event's team</h4>
                    <p>Ask the organizer to add you to the team if you're helping run it.</p></div>
            </>
        );
    }
    const tabs = TABS.filter(t => perms[t[3]]);
    const current = tabs.find(t => t[0] === tab) ? tab : 'overview';
    return (
        <div className="ev-dash">
            <BackLink to={{ kind: 'event', id }}>Event page</BackLink>
            <header className="ev-dash-head">
                <Cover ev={ev} className="ev-dash-art" />
                <div>
                    <div className="ev-meta-line"><PhasePill ev={ev} /><span>Dashboard</span></div>
                    <h2>{ev.title}</h2>
                </div>
            </header>
            <nav className="ev-tabs" role="tablist" aria-label="Dashboard sections">
                {tabs.map(([key, label, icon]) => (
                    <button key={key} type="button" role="tab" aria-selected={current === key} className={`ev-tab${current === key ? ' active' : ''}`}
                        onClick={() => { events.view = { kind: 'dashboard', id, tab: key }; showEventView(events.view, { route: false }); }}>
                        <Icon name={icon} size={15} />{label}
                    </button>
                ))}
            </nav>
            {current === 'overview' && <Overview ev={ev} d={d} />}
            {current === 'entries' && <EntriesTab ev={ev} d={d} />}
            {current === 'announcements' && <AnnouncementsTab ev={ev} d={d} />}
            {current === 'results' && <ResultsTab ev={ev} d={d} />}
            {current === 'team' && <TeamTab ev={ev} d={d} />}
            {current === 'settings' && <EventEditor event={ev} />}
        </div>
    );
}

function Overview({ ev, d }: { ev: EventRow; d: Detail }) {
    const perms = permsFor(ev, d.helpers);
    const stage = effectivePhase(ev);
    const entrants = new Set(d.entries.map(e => e.user_id)).size;
    const voters = ev.voting === 'ballot' ? d.ballots.length : new Set(d.votes.map(v => v.voter_id)).size;
    const scheduled = !!ev.submissions_open_at && !isPast(ev.submissions_open_at);
    const next: [Phase, string] | null =
        stage === 'draft' ? ['announced', scheduled ? 'Go live (entries open on schedule)' : 'Go live (entries closed)']
        : stage === 'upcoming' ? ['open', 'Open entries now']
        : stage === 'open' ? (ev.voting === 'none' ? ['ended', 'Close and end the event'] : ['voting', 'Close entries, start voting'])
        : stage === 'closed' ? (ev.voting === 'none' ? ['ended', 'End event and publish results'] : ['voting', 'Start voting now'])
        : stage === 'voting' ? ['ended', 'End event and publish results'] : null;
    // an event that waits for its results post only ends for real when that's published
    if (next?.[0] === 'ended' && ev.hold_results && !ev.results_released_at) next[1] = stage === 'voting' ? 'Close voting (results wait for your post)' : 'End the event (results wait for your post)';
    const go = ([p]: [Phase, string]) => setPhase(ev, p);
    return (
        <div className="ev-dash-grid">
            <section className="ev-block">
                <h3>Where it's at</h3>
                <Timeline ev={ev} />
                {perms.edit && (
                    <div className="ev-phase-controls">
                        {next && <button className="btn btn-primary" type="button" onClick={() => go(next)}>{next[1]}</button>}
                        {/* live without entries: listed and shareable, the form visible but closed */}
                        {stage === 'draft' && <button className="btn btn-secondary" type="button" onClick={() => setPhase(ev, 'open')}>Go live and open entries now</button>}
                        {stage === 'open' && <button className="btn btn-secondary" type="button" onClick={() => setPhase(ev, 'announced')}>Stop entries, stay live</button>}
                        <label className="ev-inline-select">Set phase
                            <select value={ev.phase} onChange={e => setPhase(ev, e.target.value as Phase)}>
                                {PHASES.filter(([p]) => p !== 'voting' || ev.voting !== 'none').map(([p, label]) => <option key={p} value={p}>{label}</option>)}
                            </select>
                        </label>
                    </div>
                )}
                <p className="ev-hint">"Go live" puts the event on the Events page and makes its link work, with entries closed until their open date (or until you open them). Dates move the event along by themselves; setting a phase by hand happens now and clears dates that would undo it.</p>
                <p className="ev-hint">You and your team can enter and vote too, from the <button type="button" className="ev-link" onClick={() => showEventView({ kind: 'event', id: ev.id })}>event page</button>. {ev.allow_self_vote ? 'This event lets people vote on their own entries.' : 'Nobody can vote on their own entry.'}</p>
                <dl className="ev-stats">
                    <div><dt>Entries</dt><dd>{d.entries.length}</dd></div>
                    <div><dt>Entrants</dt><dd>{entrants}</dd></div>
                    {ev.voting !== 'none' && <div><dt>{ev.voting === 'ballot' ? 'Ballots' : 'Voters'}</dt><dd>{perms.results ? voters : '-'}</dd></div>}
                    <div><dt>Team</dt><dd>{d.helpers.length + 1}</dd></div>
                </dl>
            </section>
            <section className="ev-block">
                <h3>Share</h3>
                <ShareRow label="Entry link" hint={ev.phase === 'draft' ? 'Works once the event leaves draft.' : 'For anyone who wants to take part.'} url={shareLink(ev)} />
                <ShareRow label="Dashboard link" hint="Only you and your team can open it." url={dashboardLink(ev)} />
            </section>
        </div>
    );
}

function ShareRow({ label, hint, url }: { label: string; hint: string; url: string }) {
    return (
        <div className="ev-share">
            <div><strong>{label}</strong><small>{hint}</small></div>
            <div className="ev-share-field">
                <input type="text" readOnly value={url} aria-label={label} onFocus={e => e.target.select()} />
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => copyLink(url, label)}><Icon name="clipboard" size={14} />Copy</button>
            </div>
        </div>
    );
}

// ---- responses, Google Forms style ----
// Summary: every question with its answers added up. Question: one question,
// everyone's answer. Individual: one response at a time, with what the team
// can do about it. Plus a live Google Sheets link and the CSV.

type ResponsesView = 'summary' | 'question' | 'individual' | 'votes';
const RESPONSE_VIEWS: Array<[ResponsesView, string, string]> = [['summary', 'Summary', 'chart-pie'], ['question', 'Question', 'queue-list'], ['individual', 'Individual', 'document-text'], ['votes', 'Voter feedback', 'chat-bubble-left-right']];

/** One entry's answer to one question, from the public or the private side. */
const answerOf = (d: Detail, en: Entry, f: Field) => isPrivateField(f) ? d.privateAnswers[en.id]?.[f.id] : en.answers[f.id];

function EntriesTab({ ev, d }: { ev: EventRow; d: Detail }) {
    const perms = permsFor(ev, d.helpers);
    const questions = ev.form.filter(f => f.type !== 'section');
    const [view, setView] = useState<ResponsesView>('summary');
    const [at, setAt] = useState(0);
    const [qid, setQid] = useState(questions[0]?.id || '');
    const open = (entryId: string) => { setAt(Math.max(0, d.entries.findIndex(e => e.id === entryId))); setView('individual'); };
    // what voters wrote: for events that vote, to the team that sees results
    const views = RESPONSE_VIEWS.filter(([k]) => k !== 'votes' || (ev.voting !== 'none' && perms.results));
    return (
        <>
            <section className="ev-block ev-responses">
                <div className="ev-block-head">
                    <h3>{plural(d.entries.length, 'response')}</h3>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={exportEntriesCsv} disabled={!d.entries.length}><Icon name="arrow-down-tray" size={14} />Download CSV</button>
                </div>
                <div className="ev-segmented ev-responses-tabs" role="tablist" aria-label="How to look at the responses">
                    {views.map(([key, label, icon]) => (
                        <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? 'active' : ''} onClick={() => setView(key)}><Icon name={icon} size={14} />{label}</button>
                    ))}
                </div>
                {!d.entries.length && <p className="ev-hint">{ev.phase === 'draft' ? 'Responses show up here once the event is live and taking entries.' : 'No responses yet. Share the entry link to get people in.'}</p>}
                {d.entries.length > 0 && view === 'summary' && (
                    <div className="ev-summary">
                        {questions.map(f => <QuestionSummary key={f.id} d={d} f={f} onOpen={open} />)}
                        {!questions.length && <p className="ev-hint">The form has no questions, so each response is a sign-up.</p>}
                    </div>
                )}
                {d.entries.length > 0 && view === 'question' && <QuestionResponses d={d} questions={questions} qid={qid} onQid={setQid} onOpen={open} />}
                {d.entries.length > 0 && view === 'individual' && <IndividualResponse ev={ev} d={d} perms={perms} at={Math.min(at, d.entries.length - 1)} onAt={setAt} />}
                {d.entries.length > 0 && view === 'votes' && <VoterFeedback ev={ev} d={d} perms={perms} at={Math.min(at, d.entries.length - 1)} onAt={setAt} />}
            </section>
            <SheetLink ev={ev} d={d} />
            {perms.edit && <ExtraEntries ev={ev} d={d} />}
            {perms.edit && <EntryCodes ev={ev} d={d} />}
        </>
    );
}

/** One question's answers, added up the way its type calls for. */
function QuestionSummary({ d, f, onOpen }: { d: Detail; f: Field; onOpen: (entryId: string) => void }) {
    const [all, setAll] = useState(false);
    const got = d.entries.map(en => ({ en, v: answerOf(d, en, f) })).filter(x => answered(x.v));
    const counted = (options: string[], pick: (v: any) => string[]) => {
        const n = new Map<string, number>(options.map(o => [o, 0]));
        for (const { v } of got) for (const o of pick(v)) n.set(o, (n.get(o) || 0) + 1);
        return [...n.entries()];
    };
    let body: ReactNode;
    if (f.type === 'choice' || f.type === 'dropdown' || f.type === 'checkboxes' || f.type === 'scale') {
        const options = f.type === 'scale' ? Array.from({ length: f.max || 5 }, (_, i) => String(i + 1)) : f.options || [];
        const rows = counted(options, v => Array.isArray(v) ? v.map(String) : [String(v)]);
        const top = Math.max(1, ...rows.map(([, n]) => n));
        body = (
            <ul className="ev-sum-bars">
                {rows.map(([o, n]) => (
                    <li key={o}>
                        <span className="ev-sum-label">{o}</span>
                        <span className="ev-sum-track" aria-hidden="true"><span style={{ transform: `scaleX(${n / top})` }} /></span>
                        <span className="ev-sum-num">{n} <small>({got.length ? Math.round((n / got.length) * 100) : 0}%)</small></span>
                    </li>
                ))}
            </ul>
        );
    } else if (f.type === 'agree') {
        body = <p className="ev-sum-big">{got.length} <small>of {d.entries.length} agreed</small></p>;
    } else if (f.type === 'number') {
        const nums = got.map(x => Number(x.v)).filter(n => Number.isFinite(n));
        const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
        body = nums.length ? (
            <dl className="ev-sum-stats">
                <div><dt>Average</dt><dd>{avg.toLocaleString(undefined, { maximumFractionDigits: 2 })}</dd></div>
                <div><dt>Lowest</dt><dd>{Math.min(...nums).toLocaleString()}</dd></div>
                <div><dt>Highest</dt><dd>{Math.max(...nums).toLocaleString()}</dd></div>
            </dl>
        ) : null;
    } else if (f.type === 'image' || f.type === 'fakemon' || (f.type === 'library' && got.some(x => x.v?.artwork))) {
        const shown = all ? got : got.slice(0, 12);
        body = (
            <div className="ev-sum-thumbs">
                {shown.map(({ en, v }) => {
                    const src = typeof v === 'string' ? v : v?.artwork;
                    const name = typeof v === 'object' ? v?.name : '';
                    return (
                        <button key={en.id} type="button" className="ev-sum-thumb" onClick={() => onOpen(en.id)} title={name || 'Open this response'}>
                            <span className="ev-sum-thumb-art">{src ? <img src={src} alt="" loading="lazy" /> : <Icon name="sparkles" size={18} />}</span>
                            {name && <span className="ev-sum-thumb-name">{name}</span>}
                        </button>
                    );
                })}
            </div>
        );
    } else {
        const shown = all ? got : got.slice(0, 6);
        body = (
            <ul className="ev-sum-list">
                {shown.map(({ en, v }) => (
                    <li key={en.id}><button type="button" onClick={() => onOpen(en.id)}>{typeof v === 'object' ? v?.name || 'Answer' : f.type === 'date' ? new Date(`${v}T00:00`).toLocaleDateString([], { dateStyle: 'medium' }) : String(v)}</button></li>
                ))}
            </ul>
        );
    }
    const more = (f.type === 'image' || f.type === 'fakemon' || f.type === 'library') ? got.length > 12 : got.length > 6;
    const listed = !['choice', 'dropdown', 'checkboxes', 'scale', 'agree', 'number'].includes(f.type);
    return (
        <article className="ev-sum-card">
            <header>
                <strong>{f.label}</strong>
                {isPrivateField(f) && <span className="ev-private"><Icon name="lock-closed" size={11} />Private</span>}
                <small>{plural(got.length, 'response')}</small>
            </header>
            {got.length ? body : <p className="ev-hint">Nobody answered this yet.</p>}
            {listed && more && <button type="button" className="ev-link" onClick={() => setAll(v => !v)}>{all ? 'Show fewer' : `Show all ${got.length}`}</button>}
        </article>
    );
}

/** Pick a question, see everyone's answer to it. */
function QuestionResponses({ d, questions, qid, onQid, onOpen }: { d: Detail; questions: Field[]; qid: string; onQid: (id: string) => void; onOpen: (entryId: string) => void }) {
    const f = questions.find(q => q.id === qid) || questions[0];
    if (!f) return <p className="ev-hint">The form has no questions.</p>;
    const i = questions.indexOf(f);
    return (
        <div className="ev-question-view">
            <div className="ev-pager">
                <button type="button" className="ev-icon-btn" disabled={i === 0} onClick={() => onQid(questions[i - 1].id)} aria-label="Previous question"><Icon name="chevron-left" size={16} /></button>
                <select value={f.id} onChange={e => onQid(e.target.value)} aria-label="Question">
                    {questions.map(q => <option key={q.id} value={q.id}>{q.label}</option>)}
                </select>
                <button type="button" className="ev-icon-btn" disabled={i === questions.length - 1} onClick={() => onQid(questions[i + 1].id)} aria-label="Next question"><Icon name="chevron-right" size={16} /></button>
            </div>
            <ul className="ev-question-answers">
                {d.entries.map(en => (
                    <li key={en.id}>
                        <button type="button" className="ev-question-who" onClick={() => onOpen(en.id)} title="Open this response">
                            <Avatar userId={en.user_id} url={authorOf(d, en)?.avatar_url} name={authorName(d, en)} className="ev-avatar ev-avatar-xs" />
                            <span>{en.user_id ? `@${authorOf(d, en)?.username || 'member'}` : 'Guest'}</span>
                        </button>
                        <div className="ev-question-answer"><Answer field={f} value={answerOf(d, en, f)} /></div>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** One response at a time, with placement, asking for changes and removing. */
function IndividualResponse({ ev, d, perms, at, onAt }: { ev: EventRow; d: Detail; perms: ReturnType<typeof permsFor>; at: number; onAt: (i: number) => void }) {
    const en = d.entries[at];
    if (!en) return null;
    const asked = d.editRequests[en.id];
    const p = authorOf(d, en);
    return (
        <div className="ev-individual">
            <div className="ev-pager">
                <button type="button" className="ev-icon-btn" disabled={at === 0} onClick={() => onAt(at - 1)} aria-label="Previous response"><Icon name="chevron-left" size={16} /></button>
                <select value={en.id} onChange={e => onAt(d.entries.findIndex(x => x.id === e.target.value))} aria-label="Response">
                    {d.entries.map((x, i) => <option key={x.id} value={x.id}>{i + 1}. {entryTitle(ev, x, d.people)}</option>)}
                </select>
                <span className="ev-pager-count">{at + 1} of {d.entries.length}</span>
                <button type="button" className="ev-icon-btn" disabled={at === d.entries.length - 1} onClick={() => onAt(at + 1)} aria-label="Next response"><Icon name="chevron-right" size={16} /></button>
            </div>
            <div className="ev-individual-card">
                <header className="ev-individual-head">
                    <span className="ev-table-thumb">{entryImage(ev, en) ? <img src={entryImage(ev, en)} alt="" /> : <Icon name="document-text" size={18} />}</span>
                    <span className="ev-table-main">
                        <strong>{entryTitle(ev, en, d.people)}</strong>
                        <small>{en.user_id ? `@${p?.username || 'unknown'}` : 'Guest'} · {fmtDate(en.created_at)}</small>
                    </span>
                    {en.placement && <span className="ev-place">{placeLabel(en.placement)}</span>}
                </header>
                {asked && (
                    <p className="ev-notice is-ask"><Icon name="pencil-square" size={15} />
                        <span><strong>Edit requested {relTime(asked.at)}.</strong> {asked.reason}</span></p>
                )}
                <EntryAnswers ev={ev} d={d} entry={en} />
                <div className="ev-form-actions">
                    {perms.edit && canPlace(ev) && <PlacementPicker entry={en} />}
                    {perms.entries && en.user_id && effectivePhase(ev) !== 'ended' && (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('event-request-edit', { entry: en, title: entryTitle(ev, en, d.people), who: authorName(d, en), current: asked?.reason || '' })}>
                            <Icon name="pencil-square" size={14} />{asked ? 'Change the request' : 'Ask for changes'}</button>
                    )}
                    {perms.entries && <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => openDialog('event-remove-entry', { entry: en, title: entryTitle(ev, en, d.people), who: authorName(d, en) })}><Icon name="trash-2" size={14} />Remove entry</button>}
                </div>
            </div>
        </div>
    );
}

/** Placements by hand: only on events that don't vote (the votes are the result), and only until they end. */
const canPlace = (ev: EventRow) => ev.voting === 'none' && effectivePhase(ev) !== 'ended';

/**
 * What voters wrote about each entry (the voter questions and remarks), one
 * entry at a time, compiled into feedback the team can edit and send to the
 * entry's creator (send_event_feedback), or copy.
 */
function VoterFeedback({ ev, d, perms, at, onAt }: { ev: EventRow; d: Detail; perms: ReturnType<typeof permsFor>; at: number; onAt: (i: number) => void }) {
    const en = d.entries[at];
    const [names, setNames] = useState(false);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    if (!en) return null;
    const rows = votesFor(ev, d, en);
    const sent = d.feedback[en.id];
    const text = drafts[en.id] ?? sent?.text ?? compileFeedback(ev, d, en, { names });
    const setText = (t: string) => setDrafts(x => ({ ...x, [en.id]: t }));
    const withWords = d.entries.filter(x => compileFeedback(ev, d, x)).length;
    async function send() { setBusy(true); await sendFeedback(en, text); setBusy(false); }
    return (
        <div className="ev-individual ev-voter-feedback">
            <p className="ev-hint">What voters wrote about each entry, from your voter questions and their remarks. It starts compiled; edit it, then send it to the entry's creator (they get a notification, and read it with their entry) or copy it. {plural(withWords, 'entry has', 'entries have')} written feedback so far.
                {' '}<button type="button" className="ev-link" onClick={exportVotesCsv} disabled={!d.votes.length}><Icon name="arrow-down-tray" size={13} />Download every vote (CSV)</button></p>
            <div className="ev-pager">
                <button type="button" className="ev-icon-btn" disabled={at === 0} onClick={() => onAt(at - 1)} aria-label="Previous entry"><Icon name="chevron-left" size={16} /></button>
                <select value={en.id} onChange={e => onAt(d.entries.findIndex(x => x.id === e.target.value))} aria-label="Entry">
                    {d.entries.map((x, i) => <option key={x.id} value={x.id}>{i + 1}. {entryTitle(ev, x, d.people)}{d.feedback[x.id] ? ' (sent)' : ''}</option>)}
                </select>
                <span className="ev-pager-count">{at + 1} of {d.entries.length}</span>
                <button type="button" className="ev-icon-btn" disabled={at === d.entries.length - 1} onClick={() => onAt(at + 1)} aria-label="Next entry"><Icon name="chevron-right" size={16} /></button>
            </div>
            <div className="ev-individual-card">
                <header className="ev-individual-head">
                    <span className="ev-table-thumb">{entryImage(ev, en) ? <img src={entryImage(ev, en)} alt="" /> : <Icon name="document-text" size={18} />}</span>
                    <span className="ev-table-main">
                        <strong>{entryTitle(ev, en, d.people)}</strong>
                        <small>{en.user_id ? `@${authorOf(d, en)?.username || 'unknown'}` : 'Guest'} · {plural(rows.length, 'vote')}</small>
                    </span>
                    {sent && <span className="ev-chip-flag is-done"><Icon name="check" size={12} />Sent {relTime(sent.at)}</span>}
                </header>
                {rows.length ? (
                    <ol className="ev-vote-list">
                        {rows.map((r, i) => (
                            <li key={r.vote.voter_id}>
                                <strong>{names && r.who?.username ? `@${r.who.username}` : `Voter ${i + 1}`}</strong>
                                <span className="ev-hint ev-inline-hint">{criteriaOf(ev).map(c => `${c.name} ${r.vote.scores?.[c.name] ?? '-'}/${c.max}`).join(' · ')}</span>
                                {r.answers.map(a => <p key={a.q.id}><span className="ev-muted">{a.q.label}:</span> {a.value}</p>)}
                                {r.remarks && <p className="ev-vote-remarks">{r.remarks}</p>}
                                {!r.answers.length && !r.remarks && <p className="ev-muted">Scores only.</p>}
                            </li>
                        ))}
                    </ol>
                ) : <p className="ev-hint">No votes on this entry yet.</p>}
                <div className="ev-field">
                    <div className="ev-block-head ev-feedback-head">
                        <span className="ev-field-label">Feedback for its creator</span>
                        <span className="ev-head-actions">
                            <label className="ev-check"><input type="checkbox" checked={names} onChange={e => { setNames(e.target.checked); setDrafts(x => { const { [en.id]: _, ...rest } = x; return rest; }); }} />Show voters' names</label>
                            <button type="button" className="ev-link" onClick={() => setText(compileFeedback(ev, d, en, { names }))}><Icon name="arrow-path" size={13} />Compile again</button>
                        </span>
                    </div>
                    <EmojiInput value={text} onChange={setText} rows={8} maxLength={8000} className="ev-about-input" ariaLabel="Feedback for the entry's creator" toolbar mentions={false}
                        placeholder="Nothing written by voters yet. Write your own notes for the creator here." />
                </div>
                <div className="ev-form-actions">
                    <button type="button" className="btn btn-secondary btn-sm" disabled={!text.trim()} onClick={() => copyLink(text, 'Feedback')}><Icon name="clipboard" size={14} />Copy</button>
                    {perms.entries && en.user_id && <button type="button" className="btn btn-primary btn-sm" disabled={busy || !text.trim()} onClick={send}><Icon name="paper-airplane" size={14} />{sent ? 'Send again (replaces it)' : 'Send to the creator'}</button>}
                    {!en.user_id && <span className="ev-hint ev-inline-hint">A guest's entry: copy it and send it yourself.</span>}
                </div>
            </div>
        </div>
    );
}

/** Asking an entrant to change their entry, with the reason they'll see. */
function RequestEditDialog({ close, entry, title, who, current }: DialogProps<{ entry: Entry; title: string; who: string; current: string }>) {
    const [reason, setReason] = useState(current);
    const [busy, setBusy] = useState(false);
    async function send(text: string) {
        setBusy(true);
        if (await requestEntryEdit(entry, text)) close();
        setBusy(false);
    }
    return (
        <Modal onClose={close} title="Ask for changes" className="ev-remove-modal" dismissible={!busy}>
            <p className="ev-hint"><strong>{title}</strong> by {who}. They get a notification with your reason, and can edit their entry even after entries close, until the event ends.</p>
            <div className="ev-field"><label className="ev-field-label" htmlFor="ev-edit-reason">What needs changing</label>
                <textarea id="ev-edit-reason" rows={4} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} placeholder="The artwork is missing its shiny version. Add it and you're all set." autoFocus />
                <small className="ev-field-help">{500 - reason.length} characters left</small></div>
            <div className="modal-actions">
                {current && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => send('')}>Withdraw the request</button>}
                <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>Cancel</button>
                <button type="button" className="btn btn-primary" onClick={() => send(reason)} disabled={busy || !reason.trim()}>{busy ? 'Sending…' : 'Send request'}</button>
            </div>
        </Modal>
    );
}
registerDialog('event-request-edit', RequestEditDialog);

/** A spreadsheet of the responses that keeps itself up to date (Google Sheets' IMPORTDATA). */
function SheetLink({ ev, d }: { ev: EventRow; d: Detail }) {
    const [priv, setPriv] = useState(false);
    const [busy, setBusy] = useState(false);
    const make = async (includePrivate: boolean) => { setBusy(true); await createSheetLink(ev.id, includePrivate); setBusy(false); };
    return (
        <section className="ev-block ev-sheet">
            <div className="ev-block-head"><h3><Icon name="table-cells" size={16} />Google Sheets</h3></div>
            {!d.sheet ? (
                <>
                    <p className="ev-hint">Keep the responses in a spreadsheet that updates by itself. You get a private link; Google Sheets pulls in the latest responses about once an hour.</p>
                    <label className="ev-check"><input type="checkbox" checked={priv} onChange={e => setPriv(e.target.checked)} />Include private answers (emails, Discord names and other questions only organizers see)</label>
                    <div className="ev-form-actions"><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => make(priv)}><Icon name="link" size={14} />{busy ? 'Making the link…' : 'Link to Google Sheets'}</button></div>
                </>
            ) : (
                <>
                    <ol className="ev-sheet-steps">
                        <li><span>Open a new Google Sheet.</span> <a className="btn btn-secondary btn-sm" href="https://sheets.new" target="_blank" rel="noopener noreferrer"><Icon name="arrow-top-right-on-square" size={14} />sheets.new</a></li>
                        <li><span>Paste this into cell A1:</span>
                            <div className="ev-share-field">
                                <input type="text" readOnly value={sheetFormula(d.sheet.token)} aria-label="Formula for Google Sheets" onFocus={e => e.target.select()} />
                                <button className="btn btn-secondary btn-sm" type="button" onClick={() => copyLink(sheetFormula(d.sheet!.token), 'Formula')}><Icon name="clipboard" size={14} />Copy</button>
                            </div></li>
                    </ol>
                    <p className="ev-notice"><Icon name="shield-exclamation" size={15} />
                        <span>Anyone with this link can read the responses{d.sheet.include_private ? ', private answers included' : ' (not the private answers)'}. Share the sheet only with your team. A new link stops the old one working.</span></p>
                    <div className="ev-form-actions">
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => copyLink(sheetUrl(d.sheet!.token), 'CSV link')}><Icon name="clipboard" size={14} />Copy the CSV link</button>
                        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => make(!d.sheet!.include_private)}>{d.sheet.include_private ? 'New link without private answers' : 'New link with private answers'}</button>
                        <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => deleteSheetLink(ev.id)}>Turn off</button>
                    </div>
                </>
            )}
        </section>
    );
}

// ---- announcements, from the dashboard ----

const announceKey = (eventId: string) => `woogidex.eventAnnouncement.${state.user?.id || ''}.${eventId}`;

function AnnouncementsTab({ ev, d }: { ev: EventRow; d: Detail }) {
    // what you've typed is kept on this device until it's posted
    const [draft, setDraft] = useState<{ title: string; body: string }>(() => {
        try { return JSON.parse(localStorage.getItem(announceKey(ev.id)) || 'null') || { title: '', body: '' }; } catch { return { title: '', body: '' }; }
    });
    const [mode, setMode] = useState<'write' | 'preview'>('write');
    const [busy, setBusy] = useState(false);
    const [sample, setSample] = useState(false);
    useEffect(() => {
        try { draft.title || draft.body ? localStorage.setItem(announceKey(ev.id), JSON.stringify(draft)) : localStorage.removeItem(announceKey(ev.id)); } catch { /* full or private mode */ }
    }, [draft]);
    useLeaveGuard(!!(draft.title.trim() || draft.body.trim()), 'Your announcement stays saved on this device until you post it.');
    async function post() {
        setBusy(true);
        if (await postAnnouncement(ev.id, draft.title, draft.body)) setDraft({ title: '', body: '' });
        setBusy(false);
    }
    return (
        <>
            <section className="ev-block">
                <div className="ev-block-head">
                    <h3>New announcement</h3>
                    <div className="ev-segmented" role="tablist" aria-label="Announcement">
                        <button type="button" role="tab" aria-selected={mode === 'write'} className={mode === 'write' ? 'active' : ''} onClick={() => setMode('write')}>Write</button>
                        <button type="button" role="tab" aria-selected={mode === 'preview'} className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>Preview</button>
                    </div>
                </div>
                <p className="ev-hint">{ev.phase === 'draft'
                    ? 'It goes on the event page. While the event is a draft nobody is notified.'
                    : 'It goes at the top of the event page, and everyone following the event gets a notification (and an email, if they turned that on). Entering an event follows it.'}</p>
                {mode === 'write' ? (
                    <>
                        <div className="ev-field"><label className="ev-field-label" htmlFor="ev-ann-title">Title</label>
                            <input id="ev-ann-title" maxLength={120} value={draft.title} onChange={e => setDraft(x => ({ ...x, title: e.target.value }))} placeholder="Voting opens tomorrow!" /></div>
                        <EmojiInput value={draft.body} onChange={body => setDraft(x => ({ ...x, body }))} rows={6} maxLength={8000} className="ev-about-input" ariaLabel="Announcement" toolbar variables={VARIABLES}
                            placeholder={'Entries are closed: thank you all!\nVoting opens {{voting_open}}.'} />
                    </>
                ) : (
                    <div className="ev-preview-box">
                        <SampleSwitch on={sample} onChange={setSample} />
                        <SampleVars.Provider value={sample}><ol className="ev-announce-list"><AnnouncementItem ev={ev} d={d} a={{ id: 'preview', event_id: ev.id, author_id: state.user?.id || null, title: draft.title || 'Untitled', body: draft.body, created_at: new Date().toISOString() }} /></ol></SampleVars.Provider>
                    </div>
                )}
                <div className="ev-form-actions">
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy || !draft.title.trim()} onClick={post}><Icon name="megaphone" size={14} />{busy ? 'Posting…' : 'Post announcement'}</button>
                </div>
            </section>
            <section className="ev-block">
                <h3>Posted</h3>
                {d.announcements.length
                    ? <ol className="ev-announce-list">{d.announcements.map(a => <AnnouncementItem key={a.id} ev={ev} d={d} a={a} manage />)}</ol>
                    : <p className="ev-hint">Nothing yet.</p>}
            </section>
        </>
    );
}

/** Removing someone's entry: say why, if you like. They're told either way. */
function RemoveEntryDialog({ close, entry, title, who }: DialogProps<{ entry: Entry; title: string; who: string }>) {
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    async function remove() {
        setBusy(true);
        if (await removeEntryAsTeam(entry, reason)) close();
        setBusy(false);
    }
    return (
        <Modal onClose={close} title="Remove this entry?" className="ev-remove-modal" dismissible={!busy}>
            <p className="ev-hint"><strong>{title}</strong> by {who}, with its votes, is deleted for good.{entry.user_id ? ' They get a notification.' : ''}</p>
            {entry.user_id && (
                <div className="ev-field"><label className="ev-field-label" htmlFor="ev-remove-reason">Reason <span className="ev-optional">(optional, they'll see it)</span></label>
                    <textarea id="ev-remove-reason" rows={3} maxLength={300} value={reason} onChange={e => setReason(e.target.value)} placeholder="It isn't an original design, so it can't be entered." autoFocus />
                    <small className="ev-field-help">{300 - reason.length} characters left</small></div>
            )}
            <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>Cancel</button>
                <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>{busy ? 'Removing…' : 'Remove entry'}</button>
            </div>
        </Modal>
    );
}
registerDialog('event-remove-entry', RemoveEntryDialog);

/**
 * Type a name, see who it is: matching people drop down with their picture,
 * name and @username, and picking one shows them before you add them.
 */
function PersonField({ value, onChange, label = 'Username' }: { value: Person | null; onChange: (p: Person | null) => void; label?: string }) {
    const [text, setText] = useState('');
    const [found, setFound] = useState<Person[]>([]);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    useEffect(() => {
        if (value) return;
        let live = true;
        const t = setTimeout(() => findPeople(text).then(list => { if (live) { setFound(list); setActive(0); } }).catch(() => {}), 200);
        return () => { live = false; clearTimeout(t); };
    }, [text, value]);
    const pick = (p: Person) => { onChange(p); setOpen(false); setText(''); };
    if (value) {
        return (
            <span className="ev-person-picked">
                <Avatar userId={value.id} url={value.avatar_url} name={personName(value)} className="ev-avatar" />
                <span className="ev-team-name"><strong>{personName(value)}</strong><small>@{value.username}</small></span>
                <button type="button" className="ev-icon-btn" onClick={() => onChange(null)} aria-label="Pick someone else"><Icon name="x-mark" size={15} /></button>
            </span>
        );
    }
    const show = open && text.trim().replace(/^@/, '').length >= 2;
    return (
        <span className="ev-person-field">
            <input type="text" placeholder="Search by @username or name" value={text} aria-label={label} autoComplete="off" role="combobox"
                aria-expanded={show} aria-controls="ev-person-list" aria-autocomplete="list"
                onChange={e => { setText(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
                onKeyDown={e => {
                    if (!show || !found.length) return;
                    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (i + 1) % found.length); }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (i - 1 + found.length) % found.length); }
                    if (e.key === 'Enter') { e.preventDefault(); pick(found[active]); }
                }} />
            {show && (
                <span className="ev-person-list feed-menu" id="ev-person-list" role="listbox">
                    {found.length ? found.map((p, i) => (
                        <button key={p.id} type="button" role="option" aria-selected={i === active} className={i === active ? 'is-active' : ''}
                            onMouseDown={e => e.preventDefault()} onClick={() => pick(p)}>
                            <Avatar userId={p.id} url={p.avatar_url} name={personName(p)} className="ev-avatar ev-avatar-xs" />
                            <span className="ev-team-name"><strong>{personName(p)}</strong><small>@{p.username}</small></span>
                        </button>
                    )) : <span className="ev-person-none">Nobody by that name.</span>}
                </span>
            )}
        </span>
    );
}

/** People allowed a different number of entries than the event's default. */
function ExtraEntries({ ev, d }: { ev: EventRow; d: Detail }) {
    const [person, setPerson] = useState<Person | null>(null);
    const [max, setMax] = useState(ev.max_entries_per_user + 1);
    const [busy, setBusy] = useState(false);
    async function add(e: React.FormEvent) {
        e.preventDefault();
        setBusy(true);
        if (person && await setEntryLimit(ev.id, person.username || "", max)) setPerson(null);
        setBusy(false);
    }
    return (
        <section className="ev-block">
            <h3>Entries for specific people</h3>
            <p className="ev-hint">Everyone gets {plural(ev.max_entries_per_user, 'entry', 'entries')}. Give someone a different number here.</p>
            {d.limits.length > 0 && (
                <ul className="ev-team">
                    {d.limits.map(l => {
                        const p = d.people[l.user_id];
                        return (
                            <li key={l.user_id}>
                                <Avatar userId={l.user_id} url={p?.avatar_url} name={personName(p)} className="ev-avatar" />
                                <span className="ev-team-name"><strong>{personName(p)}</strong><small>@{p?.username}</small></span>
                                <span className="ev-limit">{plural(l.max_entries, 'entry', 'entries')}</span>
                                <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeEntryLimit(l)}>Reset</button>
                            </li>
                        );
                    })}
                </ul>
            )}
            <form className="ev-share-field ev-person-row" onSubmit={add}>
                <PersonField value={person} onChange={setPerson} />
                <input type="number" min={1} max={100} value={max} onChange={e => setMax(Number(e.target.value))} aria-label="Entries allowed" className="ev-num" />
                <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !person}>Set</button>
            </form>
        </section>
    );
}

/** Codes to hand out (in DMs, say) that give whoever redeems them more entries. */
function EntryCodes({ ev, d }: { ev: EventRow; d: Detail }) {
    const [code, setCode] = useState(randomCode);
    const [max, setMax] = useState(ev.max_entries_per_user + 1);
    const [uses, setUses] = useState('');
    const [busy, setBusy] = useState(false);
    async function add(e: React.FormEvent) {
        e.preventDefault();
        setBusy(true);
        if (await createEventCode(ev.id, code, Math.min(100, Math.max(1, max)), uses ? Math.max(1, Number(uses)) : null)) setCode(randomCode());
        setBusy(false);
    }
    return (
        <section className="ev-block">
            <h3>Entry codes</h3>
            <p className="ev-hint">Make a code and send it to the people you choose. Whoever redeems it on the event page can send that many entries.</p>
            {d.codes.length > 0 && (
                <ul className="ev-team">
                    {d.codes.map((c: EventCode) => (
                        <li key={c.id}>
                            <span className="ev-code">{c.code}</span>
                            <span className="ev-team-name"><strong>{plural(c.max_entries, 'entry', 'entries')}</strong><small>Used {c.uses}{c.max_uses ? ` of ${c.max_uses}` : ''} {c.uses === 1 ? 'time' : 'times'}</small></span>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => copyLink(c.code, 'Code')}><Icon name="clipboard" size={14} />Copy</button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => deleteEventCode(c)} aria-label={`Delete ${c.code}`}><Icon name="trash-2" size={14} /></button>
                        </li>
                    ))}
                </ul>
            )}
            <form className="ev-code-form" onSubmit={add}>
                <label className="ev-inline-select">Code
                    <input type="text" value={code} onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))} maxLength={32} spellCheck={false} aria-label="Code" />
                </label>
                <label className="ev-inline-select">Entries
                    <input type="number" min={1} max={100} value={max} onChange={e => setMax(Number(e.target.value))} className="ev-num" />
                </label>
                <label className="ev-inline-select">Uses
                    <input type="number" min={1} placeholder="Any" value={uses} onChange={e => setUses(e.target.value)} className="ev-num" />
                </label>
                <button className="btn btn-primary btn-sm" type="submit" disabled={busy || code.length < 4}>Create code</button>
            </form>
        </section>
    );
}

function PlacementPicker({ entry }: { entry: Entry }) {
    return (
        <label className="ev-inline-select">Placement
            <select value={entry.placement ?? ''} onChange={e => setPlacement(entry, e.target.value ? Number(e.target.value) : null)}>
                <option value="">None</option>
                {Array.from({ length: 10 }, (_, i) => <option key={i} value={i + 1}>{placeLabel(i + 1)}</option>)}
            </select>
        </label>
    );
}

function ResultsTab({ ev, d }: { ev: EventRow; d: Detail }) {
    const perms = permsFor(ev, d.helpers);
    const rows = ranked(ev, d.entries, d.results);
    const winners = computeWinners(ev, rows);
    const community = ev.voting === 'community';
    const max = Math.max(1, ...rows.map(r => community ? Number(r.result?.votes || 0) : Number(r.result?.points_percent || 0)));
    const totalVoters = Number(d.results?.[0]?.total_voters || 0);
    return (
        <>
            <section className="ev-block">
                <div className="ev-block-head">
                    <h3>Standings</h3>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => loadEvent(ev.id)}><Icon name="arrow-path" size={14} />Refresh</button>
                </div>
                <p className="ev-hint">
                    {ev.voting === 'none' ? (canPlace(ev) ? 'This event has no voting: pick winners with a placement. Placements lock when the event ends.' : 'This event had no voting; these are the placements it ended with.')
                        : `Winners: ${describeWinnerRules(ev.winner_criteria)}. Ties: ${(TIE_RULES.find(t => t[0] === (ev.tie_rule || 'share'))?.[1] || '').toLowerCase()}${ev.tie_rule === 'criterion' && ev.tie_criterion ? ` (${ev.tie_criterion})` : ''}. ${plural(totalVoters, 'voter')} so far. `}
                    {ev.voting !== 'none' && (ev.live_results ? 'Live results are on, so entrants see these while voting runs.' : 'Only the team sees these until the event ends.')}
                </p>
                {ev.voting !== 'none' && <p className="ev-notice"><Icon name="lock-closed" size={15} /><span>The standings come straight from the votes. Nobody can change them, the organizers and site staff included, and once voting starts the scoring and winner rules are locked too.</span></p>}
                {!rows.length && <p className="ev-hint">No entries yet.</p>}
                <ol className="ev-standings">
                    {rows.map(({ entry: en, result, place }) => {
                        const value = community ? Number(result?.votes || 0) : Number(result?.points_percent || 0);
                        const won = winners.has(en.id);
                        return (
                            <li key={en.id} className={won ? 'is-winner' : ''}>
                                <span className="ev-rank">{place ? placeLabel(place) : '-'}{won && <Icon name="trophy" size={13} />}</span>
                                <span className="ev-standing-main">
                                    <strong>{entryTitle(ev, en, d.people)}{won && <span className="ev-winner-chip">{effectivePhase(ev) === 'ended' ? 'Winner' : 'Winning'}</span>}</strong>
                                    <span className="ev-bar" aria-hidden="true"><span style={{ width: `${(value / max) * 100}%` }} /></span>
                                    {!community && result && <small className="ev-criteria-avgs">{criteriaOf(ev).map(c => `${c.name} ${result.criteria_avg?.[c.name] ?? '-'}/${c.max}`).join(' · ')}</small>}
                                </span>
                                <span className="ev-standing-num">{community ? plural(value, 'vote') : `${value.toFixed(1)}% · ${plural(Number(result?.votes || 0), 'vote')}`}</span>
                                {perms.edit && canPlace(ev) && <PlacementPicker entry={en} />}
                            </li>
                        );
                    })}
                </ol>
            </section>
            {perms.edit ? <ResultsPostEditor ev={ev} d={d} /> : d.resultsPost && <section className="ev-block"><h3>Results post</h3><RichText text={d.resultsPost} className="ev-rich" /></section>}
            {(ev.voting === 'ballot' || ev.voting === 'judges') && <VotersSection ev={ev} d={d} />}
        </>
    );
}

/** The announcement published with the results, in markdown, and a way to share it to the feed. */
function ResultsPostEditor({ ev, d }: { ev: EventRow; d: Detail }) {
    const [text, setText] = useState(d.resultsPost || '');
    const [mode, setMode] = useState<'write' | 'preview'>('write');
    const [busy, setBusy] = useState(false);
    // a reload brings the saved post in only if you haven't changed it here (it used to overwrite what you were typing)
    const lastSaved = useRef(d.resultsPost || '');
    useEffect(() => {
        setText(t => t.trim() === lastSaved.current.trim() ? (d.resultsPost || '') : t);
        lastSaved.current = d.resultsPost || '';
    }, [d.resultsPost]);
    const stage = effectivePhase(ev);
    const dirty = text.trim() !== (d.resultsPost || '');
    const waiting = !!ev.hold_results && !ev.results_released_at;
    const [sample, setSample] = useState(false);
    const filled = fillVariables(text, sample ? sampleVariables(ev) : variablesFor(ev, d));
    const realFilled = fillVariables(text, variablesFor(ev, d));
    useLeaveGuard(dirty, 'Your results post isn\'t saved yet.');
    async function save() { setBusy(true); await saveResultsPost(ev.id, text); setBusy(false); }
    async function publish() { setBusy(true); await publishResults(ev.id, text); setBusy(false); }
    return (
        <section className="ev-block">
            <div className="ev-block-head">
                <h3>Results post</h3>
                <div className="ev-segmented" role="tablist" aria-label="Results post">
                    <button type="button" role="tab" aria-selected={mode === 'write'} className={mode === 'write' ? 'active' : ''} onClick={() => setMode('write')}>Write</button>
                    <button type="button" role="tab" aria-selected={mode === 'preview'} className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>Preview</button>
                </div>
            </div>
            <p className="ev-hint">{waiting
                ? 'This event waits for this post: the results stay hidden until you publish it, whatever the dates say. Save it as a draft as often as you like.'
                : <>Shown at the top of the event page once the results are out{ev.results_at && stage !== 'ended' ? ` (${fmtDate(ev.results_at)})` : ''}. Until then only the team can read it.</>}</p>
            {mode === 'write'
                ? <EmojiInput value={text} onChange={setText} rows={10} maxLength={10000} className="ev-about-input" ariaLabel="Results post" toolbar variables={VARIABLES}
                    placeholder={'## The results are in!\n🥇 {{winner1}}\n🥈 {{winner2}}\n🥉 {{winner3}}\n\nThanks to all {{entrants}} of you who entered :woogi:'} />
                : <div className="ev-preview-box"><SampleSwitch on={sample} onChange={setSample} />{text.trim() ? <RichText text={filled} className="ev-rich" /> : <p className="ev-hint">Nothing written yet.</p>}</div>}
            <small className="ev-field-help">Variables like {'{{winner1}}'} fill in with the winners, counts and dates when people read it. The preview shows them as they stand now.</small>
            <div className="ev-form-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setText(t => (t.trim() ? `${t.trim()}\n\n` : '') + standingsMarkdown(ev, d))} disabled={!d.results}>
                    <Icon name="trophy" size={14} />Insert the standings</button>
                {d.share && !waiting && <button type="button" className="btn btn-secondary btn-sm" disabled={!text.trim()}
                    onClick={() => openDialog('quote-repost', { item: d.share, text: realFilled.trim().slice(0, 4000) })}><Icon name="megaphone" size={14} />Post it to the feed</button>}
                <button type="button" className={`btn btn-${waiting ? 'secondary' : 'primary'} btn-sm`} disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : waiting ? 'Save draft' : 'Save results post'}</button>
                {waiting && <button type="button" className="btn btn-primary btn-sm" disabled={busy || !text.trim()} onClick={publish}><Icon name="trophy" size={14} />Publish results</button>}
            </div>
        </section>
    );
}

/** Each voter's scores and remarks, for judges and ballots. */
function VotersSection({ ev, d }: { ev: EventRow; d: Detail }) {
    const [open, setOpen] = useState<string | null>(null);
    const byVoter = useMemo(() => {
        const m = new Map<string, Detail['votes']>();
        d.votes.forEach(v => m.set(v.voter_id, [...(m.get(v.voter_id) || []), v]));
        return [...m.entries()];
    }, [d.votes]);
    return (
        <section className="ev-block">
            <div className="ev-block-head">
                <h3>{ev.voting === 'ballot' ? 'Ballots' : 'Judges\' scores'}</h3>
                <button className="btn btn-secondary btn-sm" type="button" onClick={exportVotesJson} disabled={!byVoter.length}><Icon name="arrow-down-tray" size={14} />Export JSON</button>
            </div>
            {!byVoter.length && <p className="ev-hint">No votes yet.</p>}
            <ul className="ev-table">
                {byVoter.map(([voter, votes]) => {
                    const p = d.people[voter];
                    const expanded = open === voter;
                    const when = d.ballots.find(b => b.voter_id === voter)?.submitted_at || votes[0]?.created_at;
                    return (
                        <li key={voter}>
                            <button type="button" className="ev-table-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : voter)}>
                                <Avatar userId={voter} url={p?.avatar_url} name={personName(p)} className="ev-avatar ev-table-avatar" />
                                <span className="ev-table-main"><strong>{personName(p)}</strong><small>@{p?.username || 'unknown'} · {plural(votes.length, 'entry', 'entries')} scored · {fmtDate(when)}</small></span>
                                <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={16} />
                            </button>
                            {expanded && (
                                <div className="ev-table-detail">
                                    {votes.map(v => {
                                        const en = d.entries.find(e => e.id === v.entry_id);
                                        return (
                                            <div className="ev-response" key={v.entry_id}>
                                                <strong>{en ? entryTitle(ev, en, d.people) : 'Removed entry'}</strong>
                                                <span>{criteriaOf(ev).map(c => `${c.name} ${v.scores?.[c.name] ?? '-'}/${c.max}`).join(' · ')}</span>
                                                {(ev.vote_form || []).filter(q => answered(v.answers?.[q.id])).map(q => (
                                                    <span key={q.id}>{q.label}: {Array.isArray(v.answers![q.id]) ? v.answers![q.id].join(', ') : String(v.answers![q.id])}</span>
                                                ))}
                                                {v.remarks && <p>{v.remarks}</p>}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

type PermKey = 'can_edit' | 'can_entries' | 'can_judge' | 'can_results' | 'can_add' | 'is_organizer';
const HELPER_PERMS: Array<[PermKey, string, string]> = [
    ['is_organizer', 'Organizer', 'Everything you can do, except deleting the event'],
    ['can_edit', 'Edit', 'Change details, the form, phases, entry limits, winners and announcements'],
    ['can_entries', 'Entries', 'See every answer, private ones too, ask for changes and remove entries'],
    ['can_judge', 'Judge', 'Score entries when judges pick the winners'],
    ['can_results', 'Results', 'See standings, scores and remarks before they are public'],
    ['can_add', 'Add people', 'Add people to the team, with no more permissions than they have']
];
const NEW_GRANT = (ev?: Pick<EventRow, 'voting'>): HelperPerms => ({ can_edit: false, can_entries: false, can_judge: ev?.voting === 'judges', can_results: true, can_add: false, is_organizer: false });
/** What the signed-in person holds, as a grant: someone who may only add people can't hand out more. */
const heldGrant = (p: ReturnType<typeof permsFor>): Record<PermKey, boolean> =>
    ({ is_organizer: p.team, can_edit: p.edit, can_entries: p.entries, can_judge: p.judge, can_results: p.results, can_add: p.add });

/** A team member's permissions as chips; an organizer has them all. */
function PermChips({ grant, onChange, allowed }: { grant: HelperPerms; onChange?: (g: HelperPerms) => void; allowed?: Record<PermKey, boolean> }) {
    const org = !!grant.is_organizer;
    return (
        <span className="ev-perm-chips">
            {HELPER_PERMS.map(([k, label, desc]) => {
                const on = org || !!grant[k];
                const locked = !onChange || (k !== 'is_organizer' && org) || (allowed ? !allowed[k] && !grant[k] : false);
                return (
                    <label key={k} className={`ev-chip${on ? ' is-on' : ''}${k === 'is_organizer' ? ' is-organizer' : ''}`} title={desc}>
                        <input type="checkbox" checked={on} disabled={locked} onChange={e => onChange?.({ ...grant, [k]: e.target.checked })} />{label}
                    </label>
                );
            })}
        </span>
    );
}

/** Choosing permissions for someone new: a checkbox per permission, with what it lets them do. */
function PermGrid({ grant, onChange, allowed }: { grant: HelperPerms; onChange: (g: HelperPerms) => void; allowed: Record<PermKey, boolean> }) {
    const org = !!grant.is_organizer;
    return (
        <div className="ev-perm-grid">
            {HELPER_PERMS.map(([k, label, desc]) => (
                <label key={k} className={`ev-perm-option${!allowed[k] ? ' is-locked' : ''}`} title={allowed[k] ? undefined : 'You can only give permissions you have yourself'}>
                    <input type="checkbox" checked={org || !!grant[k]} disabled={!allowed[k] || (k !== 'is_organizer' && org)} onChange={e => onChange({ ...grant, [k]: e.target.checked })} />
                    <span><strong>{label}</strong><small>{desc}</small></span>
                </label>
            ))}
        </div>
    );
}

function TeamTab({ ev, d }: { ev: EventRow; d: Detail }) {
    const perms = permsFor(ev, d.helpers);
    const allowed = heldGrant(perms);
    const [person, setPerson] = useState<Person | null>(null);
    const [grant, setGrant] = useState<HelperPerms>(() => NEW_GRANT(ev));
    const [busy, setBusy] = useState(false);
    const owner = d.people[ev.owner_id];
    async function add(e: React.FormEvent) {
        e.preventDefault();
        setBusy(true);
        if (person && await addHelper(ev.id, person.username || "", grant)) setPerson(null);
        setBusy(false);
    }
    return (
        <section className="ev-block">
            <h3>Team</h3>
            <p className="ev-hint">People you add can open this dashboard. Give each one only what they need. An organizer can do everything you can except delete the event.</p>
            <ul className="ev-team">
                <li>
                    <Avatar userId={ev.owner_id} url={owner?.avatar_url} name={personName(owner)} className="ev-avatar" />
                    <span className="ev-team-name"><strong>{personName(owner)}</strong><small>@{owner?.username} · Created the event, can do everything</small></span>
                </li>
                {d.helpers.map(h => {
                    const p = d.people[h.user_id];
                    const self = h.user_id === state.user?.id;
                    const mineToRemove = perms.team || (perms.add && h.added_by === state.user?.id);
                    return (
                        <li key={h.user_id}>
                            <Avatar userId={h.user_id} url={p?.avatar_url} name={personName(p)} className="ev-avatar" />
                            <span className="ev-team-name"><strong>{personName(p)}</strong><small>@{p?.username}{h.is_organizer ? ' · Organizer' : ''}</small></span>
                            <PermChips grant={h} onChange={perms.team ? g => updateHelper(h, g) : undefined} />
                            {(mineToRemove || self) && <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeHelper(h, self && !perms.team)}>{self && !perms.team ? 'Leave' : 'Remove'}</button>}
                        </li>
                    );
                })}
            </ul>
            {perms.add && (
                <form className="ev-add-helper" onSubmit={add}>
                    <h4>Add someone</h4>
                    <div className="ev-share-field ev-person-row">
                        <PersonField value={person} onChange={setPerson} />
                        <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !person}><Icon name="user-plus" size={14} />Add</button>
                    </div>
                    <PermGrid grant={grant} onChange={setGrant} allowed={allowed} />
                </form>
            )}
        </section>
    );
}

/** A new event's team, added the moment it's created; templates keep it too. */
function TeamPicker({ team, onChange }: { team: TeamPick[]; onChange: (t: TeamPick[]) => void }) {
    const [person, setPerson] = useState<Person | null>(null);
    const [grant, setGrant] = useState<HelperPerms>(() => NEW_GRANT());
    const all = heldGrant(permsFor({ owner_id: state.user?.id || '' } as EventRow));
    function add() {
        if (!person) return;
        if (person.id === state.user?.id) { api.showToast?.('You run the event already.', 'info'); return; }
        onChange([...team.filter(t => t.person.id !== person.id), { person, perms: grant }]);
        setPerson(null);
    }
    return (
        <div className="ev-field">
            <span className="ev-field-label">Team <span className="ev-optional">(optional)</span></span>
            <small className="ev-field-help">Added to the team as soon as the event is created. Save it as a template and the next event starts with the same people.</small>
            {team.length > 0 && (
                <ul className="ev-team">
                    {team.map((t, i) => (
                        <li key={t.person.id}>
                            <Avatar userId={t.person.id} url={t.person.avatar_url} name={personName(t.person)} className="ev-avatar" />
                            <span className="ev-team-name"><strong>{personName(t.person)}</strong><small>@{t.person.username}</small></span>
                            <PermChips grant={t.perms} onChange={g => onChange(team.map((x, j) => j === i ? { ...x, perms: g } : x))} />
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange(team.filter((_, j) => j !== i))}>Remove</button>
                        </li>
                    ))}
                </ul>
            )}
            <div className="ev-add-helper">
                <div className="ev-share-field ev-person-row">
                    <PersonField value={person} onChange={setPerson} label="Someone to add" />
                    <button className="btn btn-secondary btn-sm" type="button" disabled={!person} onClick={add}><Icon name="user-plus" size={14} />Add to the list</button>
                </div>
                {person && <PermGrid grant={grant} onChange={setGrant} allowed={all} />}
            </div>
        </div>
    );
}

// ==================== the editor (new event, and Settings) ====================

const PRESETS: Array<[string, string, Field[], Voting]> = [
    ['PoA contest', 'PoA contest', [
        { id: 'mon', type: 'fakemon', label: 'Your Fakémon', required: true },
        { id: 'about', type: 'long', label: 'Why this one?' },
        { id: 'discord', type: 'discord', label: 'Discord username' }
    ], 'ballot'],
    ['Art contest', 'Art contest', [
        { id: 'title', type: 'short', label: 'Title of your piece', required: true },
        { id: 'art', type: 'image', label: 'Your artwork', required: true },
        { id: 'about', type: 'long', label: 'Tell us about it' }
    ], 'community'],
    ['Sign-ups', 'Sign-ups', [
        { id: 'discord', type: 'discord', label: 'Discord username', required: true },
        { id: 'email', type: 'email', label: 'Email' }
    ], 'none']
];

type VotingMode = Exclude<Voting, 'none'>;
const VOTING_OPTIONS: Array<[VotingMode, string, string]> = [
    ['ballot', 'Full ballot', 'Everyone rates every entry on your voting form, the Fakémon-contest way'],
    ['community', 'Community vote', 'Everyone gets a few votes to hand out'],
    ['judges', 'Judges', 'Team members marked Judge fill in your voting form for each entry']
];
const REMARKS: Array<[Remarks, string]> = [['optional', 'Optional'], ['required', 'Required'], ['off', 'Off']];

// schedule values are ISO moments ('' when unset); older drafts held local "2026-10-09T20:00", which parses the same
const iso = (v: string) => v ? new Date(v).toISOString() : null;
const newFieldId = (form: Field[], prefix = 'q') => { let i = form.length + 1; while (form.some(f => f.id === `${prefix}${i}`)) i++; return `${prefix}${i}`; };

// ---- picking a date and time ----
// The organizer picks a day and a time in the time zone of their choosing; it's
// stored as a moment, and everyone sees it in their own time zone.

const TZ_KEY = 'woogidex.eventTimeZone';
function savedTimeZone() {
    try { const z = localStorage.getItem(TZ_KEY); if (z && timeZones().includes(z)) return z; } catch { /* private mode */ }
    return myTimeZone();
}
const zoneLabel = (timeZone: string, at = Date.now()) =>
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(at).find(p => p.type === 'timeZoneName')?.value || timeZone;
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const pad = (n: number) => String(n).padStart(2, '0');

function DatePickerDialog({ close, title, value, timeZone, min, minLabel = 'Starts', onPick }: DialogProps<{ title: string; value: string; timeZone: string; min?: string; minLabel?: string; onPick: (iso: string, timeZone: string) => void }>) {
    const [zone, setZone] = useState(timeZone);
    // with nothing picked yet, open on the month the step before it starts
    const start = zonedParts(value ? Date.parse(value) : min ? Date.parse(min) : Date.now() + 86_400_000, zone);
    const [day, setDay] = useState<{ y: number; mo: number; d: number } | null>(value ? { y: start.y, mo: start.mo, d: start.d } : null);
    const [time, setTime] = useState(value ? `${pad(start.h)}:${pad(start.mi)}` : '12:00');
    const [month, setMonth] = useState({ y: start.y, mo: start.mo });
    const today = zonedParts(Date.now(), zone);
    const first = new Date(Date.UTC(month.y, month.mo, 1)).getUTCDay();
    const days = new Date(Date.UTC(month.y, month.mo + 1, 0)).getUTCDate();
    const shift = (by: number) => setMonth(m => { const t = new Date(Date.UTC(m.y, m.mo + by, 1)); return { y: t.getUTCFullYear(), mo: t.getUTCMonth() }; });
    const picked = day && /^\d{2}:\d{2}$/.test(time) ? zonedToUtc(day.y, day.mo, day.d, Number(time.slice(0, 2)), Number(time.slice(3)), zone) : null;
    const tooEarly = picked && min ? picked.getTime() < Date.parse(min) : false;
    // the start, in this zone: its day is marked, the days before it can't be picked
    const from = min ? zonedParts(Date.parse(min), zone) : null;
    const dayNum = (y: number, mo: number, d: number) => y * 10_000 + mo * 100 + d;
    const fromNum = from ? dayNum(from.y, from.mo, from.d) : 0;
    function pickDay(d: number) {
        setDay({ y: month.y, mo: month.mo, d });
        // on the start's own day, a time before it moves up to it
        if (from && dayNum(month.y, month.mo, d) === fromNum && time < `${pad(from.h)}:${pad(from.mi)}`) setTime(`${pad(from.h)}:${pad(from.mi)}`);
    }
    // switching zones keeps the moment and shows it in the new zone's clock
    function changeZone(z: string) {
        if (picked) {
            const p = zonedParts(picked.getTime(), z);
            setDay({ y: p.y, mo: p.mo, d: p.d });
            setTime(`${pad(p.h)}:${pad(p.mi)}`);
            setMonth({ y: p.y, mo: p.mo });
        }
        setZone(z);
    }
    function use() {
        if (!picked) return;
        try { localStorage.setItem(TZ_KEY, zone); } catch { /* private mode */ }
        onPick(picked.toISOString(), zone);
        close();
    }
    return (
        <Modal onClose={close} title={title} className="ev-date-modal">
            <div className="ev-cal">
                <div className="ev-cal-head">
                    <button type="button" className="ev-icon-btn" disabled={!!from && month.y * 100 + month.mo <= from.y * 100 + from.mo} onClick={() => shift(-1)} aria-label="Previous month"><Icon name="chevron-left" size={16} /></button>
                    <strong>{new Date(Date.UTC(month.y, month.mo, 1)).toLocaleDateString([], { month: 'long', year: 'numeric', timeZone: 'UTC' })}</strong>
                    <button type="button" className="ev-icon-btn" onClick={() => shift(1)} aria-label="Next month"><Icon name="chevron-right" size={16} /></button>
                </div>
                <div className="ev-cal-grid" role="grid">
                    {WEEKDAYS.map(w => <span key={w} className="ev-cal-wd" aria-hidden="true">{w}</span>)}
                    {Array.from({ length: first }, (_, i) => <span key={`b${i}`} />)}
                    {Array.from({ length: days }, (_, i) => {
                        const d = i + 1;
                        const on = day?.y === month.y && day.mo === month.mo && day.d === d;
                        const isToday = today.y === month.y && today.mo === month.mo && today.d === d;
                        const n = dayNum(month.y, month.mo, d);
                        const isStart = !!from && n === fromNum;
                        const label = new Date(Date.UTC(month.y, month.mo, d)).toLocaleDateString([], { dateStyle: 'full', timeZone: 'UTC' });
                        return (
                            <button key={d} type="button" className={`ev-cal-day${on ? ' is-on' : ''}${isToday ? ' is-today' : ''}${isStart ? ' is-start' : ''}`} aria-pressed={on}
                                disabled={!!from && n < fromNum} title={isStart ? `${minLabel}: ${fmtDate(min, zone)}` : undefined}
                                aria-label={isStart ? `${label}, ${minLabel.toLowerCase()}` : label}
                                onClick={() => pickDay(d)}>{d}</button>
                        );
                    })}
                </div>
                {from && <p className="ev-cal-legend"><span className="ev-cal-start-dot" aria-hidden="true" />{minLabel}: {fmtDate(min, zone)}</p>}
            </div>
            <div className="ev-two ev-date-row">
                <div className="ev-field"><label className="ev-field-label" htmlFor="ev-date-time">Time</label>
                    <input id="ev-date-time" type="time" value={time} onChange={e => setTime(e.target.value)} /></div>
                <div className="ev-field"><label className="ev-field-label" htmlFor="ev-date-zone">Time zone</label>
                    <select id="ev-date-zone" value={zone} onChange={e => changeZone(e.target.value)}>
                        {timeZones().map(z => <option key={z} value={z}>{z.replace(/_/g, ' ')} ({zoneLabel(z)})</option>)}
                    </select></div>
            </div>
            <p className={tooEarly ? 'ev-error' : 'ev-hint'}>
                {!picked ? 'Pick a day.' : tooEarly ? `Pick a time after ${minLabel.toLowerCase()} (${fmtDate(min, zone)}).` : <>Everyone sees this in their own time zone. For you: <strong>{fmtDate(picked.toISOString())}</strong>.</>}
            </p>
            <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={close}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={!picked || tooEarly} onClick={use}>Set date</button>
            </div>
        </Modal>
    );
}
registerDialog('event-date-picker', DatePickerDialog);

/** A schedule date: a button that opens the picker, shown in the organizer's chosen zone. */
function DateField({ id, label, value, onChange, timeZone, onTimeZone, min, minLabel, children }: {
    id: string; label: string; value: string; onChange: (iso: string) => void; timeZone: string; onTimeZone: (z: string) => void; min?: string; minLabel?: string; children?: ReactNode;
}) {
    const open = () => openDialog('event-date-picker', { title: label, value, timeZone, min: min || undefined, minLabel, onPick: (iso: string, z: string) => { onChange(iso); onTimeZone(z); } });
    return (
        <div className="ev-field">
            <label className="ev-field-label" htmlFor={id}>{label}</label>
            <div className="ev-date-field">
                <button id={id} type="button" className="ev-date-btn" onClick={open}>
                    <Icon name="calendar-days" size={16} />
                    {value ? <span>{fmtDate(value, timeZone)}</span> : <span className="ev-muted">Not set</span>}
                </button>
                {value && <button type="button" className="ev-icon-btn" onClick={() => onChange('')} aria-label={`Clear ${label}`}><Icon name="x-mark" size={15} /></button>}
            </div>
            {children}
        </div>
    );
}

/** Questions in order, Google Forms style: add, edit, reorder, page breaks. */
function FormBuilder({ form, onChange, types, prefix = 'q', personal = true }: { form: Field[]; onChange: (f: Field[]) => void; types: FieldType[]; prefix?: string; personal?: boolean }) {
    const setField = (i: number, patch: Partial<Field>) => onChange(form.map((x, j) => j === i ? { ...x, ...patch } : x));
    const move = (i: number, by: number) => { const next = [...form]; const [x] = next.splice(i, 1); next.splice(i + by, 0, x); onChange(next); };
    const meta = (t: FieldType) => FIELD_TYPES.find(x => x[0] === t)!;
    function add(type: FieldType) {
        const pageNo = form.filter(x => x.type === 'section').length + 2;
        onChange([...form, {
            id: newFieldId(form, prefix), type, label: type === 'section' ? `Page ${pageNo}` : meta(type)[1], required: type === 'agree',
            ...(hasOptions(type) ? { options: ['Option 1', 'Option 2'] } : {}), ...(type === 'scale' ? { max: 5 } : {}),
            ...(type === 'library' ? { kinds: [...ALL_LIB_KINDS] } : {})
        }]);
    }
    return (
        <>
            <ol className="ev-builder">
                {form.map((field, i) => {
                    const lockedPrivate = field.type === 'email';
                    const section = field.type === 'section';
                    return (
                        <li key={field.id} className={`ev-q${section ? ' is-section' : ''}`}>
                            <div className="ev-q-head">
                                <span className="ev-q-type"><Icon name={meta(field.type)[2]} size={14} />{meta(field.type)[1]}</span>
                                <span className="ev-q-tools">
                                    <button type="button" className="ev-icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><Icon name="chevron-up" size={15} /></button>
                                    <button type="button" className="ev-icon-btn" disabled={i === form.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><Icon name="chevron-down" size={15} /></button>
                                    <button type="button" className="ev-icon-btn" onClick={() => onChange(form.filter((_, j) => j !== i))} aria-label="Delete"><Icon name="trash-2" size={15} /></button>
                                </span>
                            </div>
                            <input type="text" maxLength={120} value={field.label} onChange={e => setField(i, { label: e.target.value })} aria-label={section ? 'Page title' : 'Question'} placeholder={section ? 'Page title' : 'Question'} />
                            <input type="text" maxLength={300} value={field.help || ''} onChange={e => setField(i, { help: e.target.value })} aria-label={section ? 'Page description' : 'Help text'} placeholder={section ? 'Description (optional)' : 'Help text (optional)'} className="ev-q-help" />
                            {hasOptions(field.type) && (
                                <textarea rows={3} value={(field.options || []).join('\n')} onChange={e => setField(i, { options: e.target.value.split('\n').slice(0, 20) })} aria-label="Options, one per line" placeholder="One option per line" />
                            )}
                            {field.type === 'scale' && (
                                <label className="ev-inline-select">From 1 to
                                    <select value={field.max || 5} onChange={e => setField(i, { max: Number(e.target.value) })}>
                                        {[2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => <option key={n} value={n}>{n}</option>)}
                                    </select>
                                </label>
                            )}
                            {field.type === 'number' && (
                                <div className="ev-criterion-row">
                                    <label className="ev-inline-select">At least <input type="number" className="ev-num" value={field.min ?? ''} onChange={e => setField(i, { min: e.target.value === '' ? null : Number(e.target.value) })} /></label>
                                    <label className="ev-inline-select">At most <input type="number" className="ev-num" value={field.max ?? ''} onChange={e => setField(i, { max: e.target.value === '' ? null : Number(e.target.value) })} /></label>
                                </div>
                            )}
                            {field.type === 'library' && (
                                <div className="ev-q-rule-row"><span className="ev-q-sub">Takes</span>
                                    <div className="ev-chips">
                                        {LIB_KINDS.map(([k, label, icon]) => {
                                            const on = kindsOf(field).includes(k);
                                            return (
                                                <button key={k} type="button" className={`ev-chip${on ? ' is-on' : ''}`} aria-pressed={on} disabled={on && kindsOf(field).length === 1}
                                                    onClick={() => setField(i, { kinds: on ? kindsOf(field).filter(x => x !== k) : ALL_LIB_KINDS.filter(x => x === k || kindsOf(field).includes(x)) })}>
                                                    <Icon name={icon} size={13} />{label}
                                                </button>
                                            );
                                        })}
                                    </div></div>
                            )}
                            {field.type === 'fakemon' && <MonRulesEditor rules={field.rules} onChange={rules => setField(i, { rules })} />}
                            {!section && (
                                <div className="ev-q-flags">
                                    <label><input type="checkbox" checked={!!field.required} onChange={e => setField(i, { required: e.target.checked })} />Required</label>
                                    {personal && <label title={lockedPrivate ? 'Email is always private' : 'Only you and helpers with Entries access see the answer'}><input type="checkbox" checked={isPrivateField(field)} disabled={lockedPrivate} onChange={e => setField(i, { private: e.target.checked })} />Only organizers see answers</label>}
                                </div>
                            )}
                        </li>
                    );
                })}
            </ol>
            <div className="ev-add-q" aria-label="Add a question">
                {form.length < 50 && types.map(type => (
                    <button key={type} type="button" className="ev-chip" onClick={() => add(type)}><Icon name={meta(type)[2]} size={13} />{meta(type)[1]}</button>
                ))}
            </div>
        </>
    );
}

type EditorValues = {
    title: string; tagline: string; description: string; category: string; cover_image: string | null; cover_thumb: string | null;
    tie_rule: TieRule; tie_criterion: string;
    submissions_open_at: string; submissions_close_at: string; voting_open_at: string; voting_close_at: string; results_at: string;
    form: Field[]; votingOn: boolean; mode: VotingMode; votes_per_user: number; max_entries_per_user: number;
    live_results: boolean; show_entries: boolean; public_access: boolean; slug: string; vote_form: Field[]; allow_self_vote: boolean;
    vote_display: { fields: string[] | null; author: boolean };
    entries_private: boolean; hold_results: boolean;
    /** a new event's team, added when it's created (and kept in templates) */
    team: TeamPick[];
    criteria: Criterion[]; voter_remarks: Remarks; winner: { topn: string | null; toppct: string | null; minscore: string | null };
};

function valuesFrom(event: EventRow | null): EditorValues {
    const wc: WinnerRules = event?.winner_criteria || { top_n: 3 };
    return {
        title: event?.title || '', tagline: event?.tagline || '', description: event?.description || '', category: event?.category || '',
        cover_image: event?.cover_image || null, cover_thumb: event?.cover_thumb || null,
        tie_rule: event?.tie_rule || 'share', tie_criterion: event?.tie_criterion || '',
        submissions_open_at: event?.submissions_open_at || '', submissions_close_at: event?.submissions_close_at || '',
        voting_open_at: event?.voting_open_at || '', voting_close_at: event?.voting_close_at || '', results_at: event?.results_at || '',
        form: event?.form || PRESETS[0][2], votingOn: (event?.voting || PRESETS[0][3]) !== 'none',
        mode: (event && event.voting !== 'none' ? event.voting : 'ballot') as VotingMode, votes_per_user: event?.votes_per_user || 3,
        max_entries_per_user: event?.max_entries_per_user || 1, live_results: event?.live_results || false, show_entries: event?.show_entries ?? true,
        allow_self_vote: event?.allow_self_vote ?? false,
        entries_private: event?.entries_private ?? false, hold_results: event?.hold_results ?? false, team: [],
        public_access: event?.public_access || false, slug: event?.slug || '', vote_form: event?.vote_form || [],
        vote_display: event ? voteDisplay(event) : { fields: null, author: true },
        criteria: event ? criteriaOf(event) : DEFAULT_CRITERIA, voter_remarks: event?.voter_remarks || 'optional',
        winner: { topn: wc.top_n != null ? String(wc.top_n) : null, toppct: wc.top_percent != null ? String(wc.top_percent) : null, minscore: wc.min_score_percent != null ? String(wc.min_score_percent) : null }
    };
}

function rowFrom(f: EditorValues): Partial<EventRow> {
    const winner_criteria: WinnerRules = {};
    if (f.winner.topn) winner_criteria.top_n = Number(f.winner.topn);
    if (f.winner.toppct) winner_criteria.top_percent = Number(f.winner.toppct);
    if (f.winner.minscore) winner_criteria.min_score_percent = Number(f.winner.minscore);
    if (!Object.keys(winner_criteria).length) winner_criteria.top_n = 3;
    const criteria = criteriaOf({ criteria: f.criteria })
        .map(c => ({ name: c.name.trim(), help: (c.help || '').trim(), max: Math.min(10, Math.max(2, c.max)) }))
        .filter(c => c.name);
    const votingOn = f.votingOn;
    return {
        title: f.title.trim(), tagline: f.tagline.trim(), description: f.description.trim(), category: f.category.trim(),
        cover_image: f.cover_image, cover_thumb: f.cover_image ? f.cover_thumb : null,
        tie_rule: f.tie_rule === 'criterion' && !f.tie_criterion.trim() ? 'share' : f.tie_rule,
        tie_criterion: f.tie_rule === 'criterion' ? f.tie_criterion.trim() || null : null,
        submissions_open_at: iso(f.submissions_open_at), submissions_close_at: iso(f.submissions_close_at),
        voting_open_at: votingOn ? iso(f.voting_open_at) : null, voting_close_at: votingOn ? iso(f.voting_close_at) : null,
        results_at: iso(f.results_at), public_access: f.public_access, voter_remarks: f.voter_remarks,
        slug: f.slug.trim() || null,
        vote_display: { fields: f.vote_display.fields ? f.vote_display.fields.filter(id => f.form.some(q => q.id === id)) : null, author: f.vote_display.author },
        vote_form: f.vote_form.map(x => ({ ...x, label: x.label.trim(), help: (x.help || '').trim(), options: hasOptions(x.type) ? (x.options || []).map(o => o.trim()).filter(Boolean) : undefined })),
        form: f.form.map(x => ({ ...x, label: x.label.trim(), help: (x.help || '').trim(), options: hasOptions(x.type) ? (x.options || []).map(o => o.trim()).filter(Boolean) : undefined })),
        voting: votingOn ? f.mode : 'none', votes_per_user: f.votes_per_user, max_entries_per_user: f.max_entries_per_user,
        live_results: f.live_results, show_entries: f.show_entries, allow_self_vote: f.votingOn && f.allow_self_vote,
        entries_private: f.entries_private, hold_results: f.hold_results,
        criteria: criteria.length ? criteria : DEFAULT_CRITERIA, winner_criteria
    };
}

/** Name a template; one by the same name is replaced. */
function TemplateSaveDialog({ close, name, values }: DialogProps<{ name: string; values: any }>) {
    const [value, setValue] = useState(name);
    const [busy, setBusy] = useState(false);
    const taken = readEventTemplates().some(t => t.name.toLowerCase() === value.trim().toLowerCase());
    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!value.trim() || busy) return;
        setBusy(true);
        if (await saveEventTemplate(value.trim(), values)) close();
        setBusy(false);
    };
    return (
        <Modal onClose={close} title="Save as template" className="ev-template-modal">
            <form onSubmit={save}>
                <p className="ev-hint">Keeps the form, voting, rules, about text and the team list, but not the dates or link. It's saved to your account, so it's there on every device: load it with "Templates" when you make an event.</p>
                <div className="ev-field"><label className="ev-field-label" htmlFor="ev-template-name">Template name</label>
                    <input id="ev-template-name" maxLength={60} value={value} onChange={e => setValue(e.target.value)} placeholder="Monthly PoA contest" autoFocus />
                    {taken && <small className="ev-field-help">You have a template with this name. Saving replaces it.</small>}</div>
                <div className="modal-actions">
                    <button type="button" className="btn btn-secondary" onClick={close}>Cancel</button>
                    <button type="submit" className="btn btn-primary" disabled={!value.trim() || busy}>{busy ? 'Saving…' : taken ? 'Replace template' : 'Save template'}</button>
                </div>
            </form>
        </Modal>
    );
}
registerDialog('event-template-save', TemplateSaveDialog);

/** Your templates (and the built-in starting points): load one, or delete it. */
function TemplatesDialog({ close, onLoad }: DialogProps<{ onLoad: (values: any, name: string) => void }>) {
    useStore();
    const list = readEventTemplates();
    const status = eventTemplatesStatus();
    const [busy, setBusy] = useState('');
    async function load(t: EventTemplate) {
        setBusy(t.id);
        const values = await templateContents(t);
        setBusy('');
        if (values) { onLoad(values, t.name); close(); }
    }
    return (
        <Modal onClose={close} title="Templates" className="ev-template-modal">
            <p className="ev-hint">Loading one fills in its setup: the form, voting, rules, about text and team. Dates and the link stay yours to set.</p>
            <h4 className="ev-template-group">Yours</h4>
            {status === 'loading' && !list.length ? <p className="ev-hint">Loading…</p>
                : !list.length ? <p className="ev-hint">None yet. Set up an event the way you like it, then "Save as template" at the top of the editor.</p>
                : (
                    <ul className="ev-template-list">
                        {list.map(t => (
                            <li key={t.id}>
                                <span className="ev-team-name"><strong>{t.name}</strong><small>Saved {relTime(new Date(t.savedAt).toISOString())}</small></span>
                                <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => load(t)}>{busy === t.id ? 'Loading…' : 'Load'}</button>
                                <button type="button" className="ev-icon-btn" aria-label={`Delete ${t.name}`} onClick={() => deleteEventTemplate(t)}><Icon name="trash-2" size={15} /></button>
                            </li>
                        ))}
                    </ul>
                )}
            <h4 className="ev-template-group">Built in</h4>
            <ul className="ev-template-list">
                {PRESETS.map(([name, category, form, voting]) => (
                    <li key={name}>
                        <span className="ev-team-name"><strong>{name}</strong><small>{form.length} questions · {voting === 'none' ? 'no voting' : VOTING_OPTIONS.find(v => v[0] === voting)?.[1] || voting}</small></span>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { onLoad({ form, votingOn: voting !== 'none', mode: voting === 'none' ? undefined : voting, category }, name); close(); }}>Load</button>
                    </li>
                ))}
            </ul>
        </Modal>
    );
}
registerDialog('event-templates', TemplatesDialog);

function EventEditor({ event }: { event: EventRow | null }) {
    const eventId = event?.id || null;
    const [restored] = useState(() => readEventDraft(eventId));
    const [f, setF] = useState<EditorValues>(() => {
        if (!restored?.values) return valuesFrom(event);
        const v = { ...valuesFrom(event), ...restored.values };
        return { ...v, criteria: criteriaOf({ criteria: v.criteria }) };
    });
    const [notice, setNotice] = useState(!!restored);
    const [mode, setMode] = useState<'edit' | 'preview'>('edit');
    const [busy, setBusy] = useState(false);
    const [savedAt, setSavedAt] = useState<number | null>(restored?.savedAt || null);
    const set = (patch: Partial<EditorValues>) => setF(v => ({ ...v, ...patch }));
    const perms = permsFor(event, events.detail?.helpers);
    const scored = f.votingOn && (f.mode === 'ballot' || f.mode === 'judges');
    const setCriterion = (i: number, patch: Partial<Criterion>) => set({ criteria: f.criteria.map((c, j) => j === i ? { ...c, ...patch } : c) });
    const moveCriterion = (i: number, by: number) => { const c = [...f.criteria]; const [x] = c.splice(i, 1); c.splice(i + by, 0, x); set({ criteria: c }); };
    const [previewTab, setPreviewTab] = useState<EventTab>('about');
    const [tz, setTz] = useState(savedTimeZone);
    /**
     * A template's setup goes in; the name only if you haven't typed one. On an
     * event that exists, what makes it that event (name, link, dates, cover)
     * stays, and so does its team (the Team tab manages that).
     */
    function applyTemplate(values: any, name = 'the template') {
        setF(v => {
            const next: EditorValues = { ...v, ...values, mode: values.mode || v.mode, criteria: criteriaOf({ criteria: values.criteria || v.criteria }), team: values.team || v.team };
            if (!event) return { ...next, title: v.title.trim() ? v.title : values.title || '', category: values.category || v.category };
            return { ...next, title: v.title, tagline: v.tagline, slug: v.slug, cover_image: v.cover_image, cover_thumb: v.cover_thumb, team: v.team,
                submissions_open_at: v.submissions_open_at, submissions_close_at: v.submissions_close_at, voting_open_at: v.voting_open_at, voting_close_at: v.voting_close_at, results_at: v.results_at };
        });
        api.showToast?.(`Loaded ${name}. Look it over, then save.`, 'success');
    }
    // "New from template" on the list page
    useEffect(() => {
        if (event || !pendingTemplate.values) return;
        applyTemplate(pendingTemplate.values.values, pendingTemplate.values.name);
        pendingTemplate.values = null;
    }, []);
    // voting has started: how entries are scored and who wins can't change (events_guard)
    const locked = !!event && event.voting !== 'none' && ['voting', 'tallying', 'ended'].includes(effectivePhase(event));
    const [sampleVars, setSampleVars] = useState(true);
    const [sample, setSample] = useState<{ scores: Record<string, number>; remarks: string; answers: Record<string, any> }>({ scores: {}, remarks: '', answers: {} });

    // autosave: what you've typed stays on this device until it's saved, like a post draft
    const pristine = useRef(JSON.stringify(valuesFrom(event)));
    // the version these settings were loaded from: saving over a newer one is refused (saveEvent)
    const loadedAt = useRef(event?.updated_at);
    useEffect(() => {
        const t = setTimeout(() => {
            if (JSON.stringify(f) === pristine.current) { clearEventDraft(eventId); setSavedAt(null); return; }
            writeEventDraft(eventId, f);
            setSavedAt(Date.now());
        }, 600);
        return () => clearTimeout(t);
    }, [f]);

    useLeaveGuard(!busy && JSON.stringify(f) !== pristine.current, 'Your changes are kept as a draft on this device until you save them.');

    function discardDraft() {
        clearEventDraft(eventId);
        setF(valuesFrom(event));
        setNotice(false);
        setSavedAt(null);
    }

    // cropped to the banner's 3.2:1 first (the tickets crop the middle of that)
    function pickCover(file?: File | null) {
        if (!file) return;
        cropThen(file, 3.2, async cropped => {
            // the small one is what the events list, tickets and the feed download
            try { set({ cover_image: await shrinkImage(cropped, 1600, 580_000), cover_thumb: await shrinkImage(cropped, 640, 70_000) }); }
            catch (e: any) { api.showToast?.(e?.message || 'That image could not be used.', 'error'); }
        });
    }

    async function save() {
        if (f.title.trim().length < 3) { api.showToast?.('Give the event a name (at least 3 characters).', 'warning'); setMode('edit'); return; }
        if (f.slug.trim() && !SLUG_PATTERN.test(f.slug.trim())) { api.showToast?.('The link can use lowercase letters, numbers and dashes, 3 to 48 of them.', 'warning'); setMode('edit'); return; }
        setBusy(true);
        // events made before small covers existed get one on their next save
        if (f.cover_image && !f.cover_thumb) {
            const thumb = await shrinkImage(f.cover_image, 640, 70_000).catch(() => null);
            f.cover_thumb = thumb;
            set({ cover_thumb: thumb });
        }
        // pristine first: creating navigates to the dashboard, and the autosave must not resurrect the draft
        const before = pristine.current;
        pristine.current = JSON.stringify(f);
        clearEventDraft(eventId);
        const ok = event ? await saveEvent(event.id, rowFrom(f), 'Settings saved.', loadedAt.current) : !!(await createEvent(rowFrom(f), f.team));
        setBusy(false);
        if (ok) { setSavedAt(null); setNotice(false); loadedAt.current = events.detail?.event?.updated_at; }
        else { pristine.current = before; writeEventDraft(eventId, f); }
    }

    const previewRow = {
        ...(event || { id: 'preview', owner_id: state.user?.id || '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
        ...rowFrom(f), phase: !event || event.phase === 'draft' ? 'open' : event.phase
    } as EventRow;

    const winnerRule = (k: keyof EditorValues['winner'], before: string, after: string, max: number) => (
        <label className="ev-rule">
            <input type="checkbox" checked={f.winner[k] !== null} onChange={e => set({ winner: { ...f.winner, [k]: e.target.checked ? '' : null } })} />
            <span>{before}</span>
            <input type="number" min={1} max={max} className="ev-num" disabled={f.winner[k] === null} value={f.winner[k] ?? ''} onChange={e => set({ winner: { ...f.winner, [k]: e.target.value } })} aria-label={`${before} ${after}`} />
            <span>{after}</span>
        </label>
    );

    return (
        // a div, not a form: the preview holds the entry form, and forms can't nest
        <div className="ev-editor">
            {!event && <BackLink to={{ kind: 'list' }}>All events</BackLink>}
            <header className="ev-list-head">
                <div>
                    {!event && <h2>New event</h2>}
                    <p>{event ? 'Changes go live when you save them.' : 'It starts as a draft only you can see. When it\'s ready, go live from its dashboard, with entries closed or open.'}</p>
                </div>
                <div className="ev-editor-tools">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('event-templates', { onLoad: applyTemplate })}><Icon name="folder-open" size={14} />Templates</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('event-template-save', { name: f.title.trim(), values: f })}><Icon name="bookmark" size={14} />Save as template</button>
                <div className="ev-segmented" role="tablist" aria-label="Editor mode">
                    <button type="button" role="tab" aria-selected={mode === 'edit'} className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}><Icon name="pencil" size={14} />Edit</button>
                    <button type="button" role="tab" aria-selected={mode === 'preview'} className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}><Icon name="eye" size={14} />Preview</button>
                </div>
                </div>
            </header>

            {notice && restored && (
                <p className="ev-notice">
                    <Icon name="arrow-uturn-left" size={15} />
                    <span>Restored your unsaved changes from {fmtDate(new Date(restored.savedAt).toISOString())}.</span>
                    <button type="button" className="ev-link" onClick={discardDraft}>Discard them</button>
                </p>
            )}

            {mode === 'preview' ? (
                <div className="ev-preview-frame">
                    <div className="ev-preview-label"><Icon name="eye" size={14} /><span>Preview: what entrants will see, with the entry form. Nothing here is saved or sent.</span>
                        <SampleSwitch on={sampleVars} onChange={setSampleVars} /></div>
                    <SampleVars.Provider value={sampleVars}>
                        <EventView ev={previewRow} d={emptyDetail(previewRow)} preview tab={previewTab} onTab={setPreviewTab} />
                    </SampleVars.Provider>
                    {scored && (
                        <section className="ev-block ev-preview-voting">
                            <h3>What voters fill in</h3>
                            <p className="ev-hint">{f.mode === 'ballot' ? 'Every voter fills this in for every entry.' : 'Your judges fill this in for each entry.'} Try it: nothing is sent.</p>
                            <VoteSheet ev={previewRow} d={emptyDetail(previewRow)} value={sample} onChange={setSample}
                                entry={{ id: 'sample', event_id: previewRow.id, user_id: null, answers: {}, placement: null, created_at: new Date().toISOString() }}
                                actions={<button type="button" className="btn btn-primary" disabled>Save score</button>} />
                        </section>
                    )}
                </div>
            ) : <>
                <section className="ev-block">
                    <h3>Basics</h3>
                    <div className="ev-field"><label className="ev-field-label" htmlFor="ev-title">Name</label>
                        <input id="ev-title" required minLength={3} maxLength={120} value={f.title} onChange={e => set({ title: e.target.value })} placeholder="New PoA Contest!" /></div>
                    <div className="ev-field"><label className="ev-field-label" htmlFor="ev-tagline">One-line pitch <span className="ev-optional">(optional)</span></label>
                        <input id="ev-tagline" maxLength={200} value={f.tagline} onChange={e => set({ tagline: e.target.value })} placeholder="Bring your best Fakémon to this round's PoA" /></div>
                    <div className="ev-field"><label className="ev-field-label" htmlFor="ev-slug">Link <span className="ev-optional">(optional)</span></label>
                        <div className="ev-slug">
                            <span className="ev-slug-base" title={routeUrl('events/')}>{routeUrl('events/').replace(/^https?:\/\//, '')}</span>
                            <input id="ev-slug" maxLength={48} value={f.slug} placeholder="new-poa-contest" spellCheck={false} autoComplete="off"
                                onChange={e => set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '') })} />
                        </div>
                        <small className="ev-field-help">Lowercase letters, numbers and dashes. Leave it empty for a generated link. Changing it later breaks links you've already shared.</small></div>
                    <div className="ev-field ev-field-half"><label className="ev-field-label" htmlFor="ev-category">Kind of event</label>
                        <input id="ev-category" list="ev-categories" maxLength={40} value={f.category} onChange={e => set({ category: e.target.value })} placeholder="PoA contest" />
                        <datalist id="ev-categories">{CATEGORIES.map(c => <option key={c} value={c} />)}</datalist></div>
                    <div className="ev-field"><span className="ev-field-label">Cover image <span className="ev-optional">(optional)</span></span>
                        <div className="ev-upload ev-upload-cover">
                            <div className="ev-cover ev-cover-preview">{f.cover_image ? <img src={f.cover_image} alt="" /> : <Icon name="photo" size={26} />}</div>
                            <span>
                                <label className="btn btn-secondary btn-sm" htmlFor="ev-cover">{f.cover_image ? 'Replace' : 'Upload'}</label>
                                {f.cover_image && <button type="button" className="btn btn-secondary btn-sm" onClick={() => set({ cover_image: null, cover_thumb: null })}>Remove</button>}
                            </span>
                            <input id="ev-cover" className="ev-sr" type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { pickCover(e.target.files?.[0]); e.target.value = ''; }} />
                        </div>
                    </div>
                    <div className="ev-field">
                        <span className="ev-field-label">About, rules and prizes</span>
                        <EmojiInput value={f.description} onChange={v => set({ description: v })} rows={9} maxLength={8000} className="ev-about-input" ariaLabel="About, rules and prizes"
                            toolbar variables={VARIABLES}
                            placeholder={'# New PoA Contest!\nMake a Fakémon for this round\'s PoA theme.\n\n## Rules\n- One entry each, original designs only\n- Keep it SFW\n\nEntries close {{entries_close}}.'} />
                        <small className="ev-field-help">Use the bar above to format (or type markdown), : to add an emoji, @ to mention someone. Variables like {'{{entries_close}}'} fill in with the event's dates, counts and winners.</small>
                    </div>
                </section>

                {!event ? (
                    <section className="ev-block">
                        <h3>Team</h3>
                        <TeamPicker team={f.team} onChange={team => set({ team })} />
                    </section>
                ) : null}

                <section className="ev-block">
                    <div className="ev-block-head">
                        <h3>What entrants send in</h3>
                        <button type="button" className="ev-link" onClick={() => openDialog('event-templates', { onLoad: applyTemplate })}><Icon name="folder-open" size={13} />Start from a template</button>
                    </div>
                    <p className="ev-hint">Email answers are always private and Discord ones are private unless you untick it. Both fill in by themselves for people who have them on their account. A Fakémon question takes the whole Fakémon, from the entrant's collection or a file they upload.</p>
                    <FormBuilder form={f.form} onChange={form => set({ form })} types={FIELD_TYPES.map(t => t[0])} />
                </section>

                <section className="ev-block">
                    <h3>Schedule</h3>
                    <p className="ev-hint">All optional. With dates set, the event opens entries, closes them and opens voting by itself. Leave "Voting opens" empty and voting starts the moment entries close.</p>
                    <p className="ev-tz-note"><Icon name="globe-alt" size={13} />Shown in {tz.replace(/_/g, ' ')} ({zoneLabel(tz)}). Change it in any date's picker; everyone else sees the times in their own zone.</p>
                    <div className="ev-two">
                        <DateField id="ev-sopen" label="Entries open" value={f.submissions_open_at} onChange={v => set({ submissions_open_at: v })} timeZone={tz} onTimeZone={setTz} />
                        <DateField id="ev-sclose" label="Entries close" value={f.submissions_close_at} onChange={v => set({ submissions_close_at: v })} timeZone={tz} onTimeZone={setTz} min={f.submissions_open_at} minLabel="Entries open" />
                    </div>
                    {f.votingOn && (
                        <div className="ev-two">
                            <DateField id="ev-vopen" label="Voting opens" value={f.voting_open_at} onChange={v => set({ voting_open_at: v })} timeZone={tz} onTimeZone={setTz} min={f.submissions_close_at} minLabel="Entries close">
                                <button type="button" className="ev-link" disabled={!f.submissions_close_at} title={f.submissions_close_at ? undefined : 'Set when entries close first'}
                                    onClick={() => set({ voting_open_at: f.submissions_close_at })}><Icon name="arrow-turn-down-right" size={13} />Start right when entries close</button>
                            </DateField>
                            <DateField id="ev-vclose" label="Voting closes" value={f.voting_close_at} onChange={v => set({ voting_close_at: v })} timeZone={tz} onTimeZone={setTz} min={f.voting_open_at || f.submissions_close_at} minLabel={f.voting_open_at ? 'Voting opens' : 'Entries close'} />
                        </div>
                    )}
                    <div className="ev-field-half">
                        <DateField id="ev-results" label="Results come out" value={f.results_at} onChange={v => set({ results_at: v })} timeZone={tz} onTimeZone={setTz} min={f.votingOn ? f.voting_close_at : f.submissions_close_at} minLabel={f.votingOn ? 'Voting closes' : 'Entries close'}>
                        {(() => {
                            const after = f.votingOn ? f.voting_close_at : f.submissions_close_at;
                            return (
                                <button type="button" className="ev-link" disabled={!after} title={after ? undefined : `Set when ${f.votingOn ? 'voting' : 'entries'} close first`}
                                    onClick={() => set({ results_at: after })}><Icon name="arrow-turn-down-right" size={13} />Right when {f.votingOn ? 'voting ends' : 'entries close'}</button>
                            );
                        })()}
                        <small className="ev-field-help">{f.votingOn ? 'Empty: the moment voting closes.' : 'Empty: when you end the event from the dashboard.'} Your results post goes up at the same time.</small>
                        </DateField>
                    </div>
                </section>

                <section className="ev-block">
                    <h3>Entries and winners</h3>
                    <div className="ev-field ev-field-narrow"><label className="ev-field-label" htmlFor="ev-max">Entries per person</label>
                        <input id="ev-max" type="number" min={1} max={20} value={f.max_entries_per_user} onChange={e => set({ max_entries_per_user: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })} />
                        <small className="ev-field-help">Give specific people more from the dashboard's Entries tab.</small></div>
                    <Toggle checked={f.public_access} onChange={v => set({ public_access: v })} label="Open to people without an account"
                        desc="Anyone with the link sees this event on its own page and can enter without signing in, like a form. Voting stays members-only." />
                    <Toggle checked={f.entries_private} onChange={v => set({ entries_private: v })} label="Keep entries private"
                        desc={f.votingOn && f.mode !== 'judges'
                            ? 'Only your team sees the entries, and nobody else sees how many there are. Voters see them only while voting is open, since they need to.'
                            : 'Only your team sees the entries, and nobody else sees how many there are, before or after the event.'} />
                </section>

                <section className="ev-block">
                    <h3>Voting</h3>
                    {locked && <p className="ev-notice"><Icon name="lock-closed" size={15} /><span>Voting has started, so how entries are scored and who wins are locked for everyone, you included. That keeps the results fair.</span></p>}
                    <fieldset className="ev-lockable" disabled={locked}>
                    <Toggle checked={f.votingOn} onChange={v => set({ votingOn: v })} label="This event has voting"
                        desc="Off for sign-ups and anything that doesn't pick winners by vote. Then you pick winners with placements, until the event ends." />
                    {f.votingOn && (
                        <div className="ev-field">
                            <span className="ev-field-label">How people vote</span>
                            <div className="ev-voting-options">
                                {VOTING_OPTIONS.map(([v, label, desc]) => (
                                    <label key={v} className={`ev-voting-option${f.mode === v ? ' is-on' : ''}`}>
                                        <input type="radio" name="ev-voting" checked={f.mode === v} onChange={() => set({ mode: v })} />
                                        <span><strong>{label}</strong><small>{desc}</small></span>
                                    </label>
                                ))}
                            </div>
                        </div>
                    )}
                    {f.votingOn && f.mode === 'community' && (
                        <div className="ev-field ev-field-narrow"><label className="ev-field-label" htmlFor="ev-votes">Votes per person</label>
                            <input id="ev-votes" type="number" min={1} max={50} value={f.votes_per_user} onChange={e => set({ votes_per_user: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })} /></div>
                    )}
                    {scored && (
                        <div className="ev-field">
                            <span className="ev-field-label">Voting form</span>
                            <small className="ev-field-help">What voters score each entry on. Each line gets its own scale and a note on what to look for.</small>
                            <ol className="ev-builder">
                                {f.criteria.map((c, i) => (
                                    <li key={i} className="ev-q">
                                        <div className="ev-q-head">
                                            <span className="ev-q-type"><Icon name="star" size={14} />Criterion {i + 1}</span>
                                            <span className="ev-q-tools">
                                                <button type="button" className="ev-icon-btn" disabled={i === 0} onClick={() => moveCriterion(i, -1)} aria-label="Move up"><Icon name="chevron-up" size={15} /></button>
                                                <button type="button" className="ev-icon-btn" disabled={i === f.criteria.length - 1} onClick={() => moveCriterion(i, 1)} aria-label="Move down"><Icon name="chevron-down" size={15} /></button>
                                                <button type="button" className="ev-icon-btn" disabled={f.criteria.length < 2} onClick={() => set({ criteria: f.criteria.filter((_, j) => j !== i) })} aria-label="Delete criterion"><Icon name="trash-2" size={15} /></button>
                                            </span>
                                        </div>
                                        <div className="ev-criterion-row">
                                            <input type="text" maxLength={40} value={c.name} aria-label="Criterion name" placeholder="Name, e.g. Creativity" onChange={e => setCriterion(i, { name: e.target.value })} />
                                            <label className="ev-inline-select">Scored 1 to
                                                <select value={c.max} onChange={e => setCriterion(i, { max: Number(e.target.value) })}>
                                                    {[2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => <option key={n} value={n}>{n}</option>)}
                                                </select>
                                            </label>
                                        </div>
                                        <input type="text" maxLength={200} value={c.help || ''} aria-label="What voters should look for" placeholder="What voters should look for (optional)" className="ev-q-help" onChange={e => setCriterion(i, { help: e.target.value })} />
                                    </li>
                                ))}
                            </ol>
                            <div className="ev-add-q">
                                {f.criteria.length < 8 && <button type="button" className="ev-chip" onClick={() => set({ criteria: [...f.criteria, { name: '', max: 10 }] })}><Icon name="plus" size={13} />Criterion</button>}
                                <label className="ev-inline-select">Remarks from voters
                                    <select value={f.voter_remarks} onChange={e => set({ voter_remarks: e.target.value as Remarks })}>
                                        {REMARKS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                                    </select>
                                </label>
                            </div>
                        </div>
                    )}
                    </fieldset>
                    {f.votingOn && (() => {
                        const shown = f.form.filter(q => q.type !== 'section' && !isPrivateField(q));
                        const fields = f.vote_display.fields;
                        const toggle = (id: string, on: boolean) => {
                            const now = fields ?? shown.map(q => q.id);
                            const next = on ? [...new Set([...now, id])] : now.filter(x => x !== id);
                            set({ vote_display: { ...f.vote_display, fields: next.length === shown.length ? null : next } });
                        };
                        return (
                            <div className="ev-field">
                                <span className="ev-field-label">What voters see of each entry</span>
                                <small className="ev-field-help">Untick answers voters shouldn't judge by. Private answers are never shown. This changes what the voting screens show, not who can look it up.</small>
                                <div className="ev-perm-chips">
                                    {shown.map(q => {
                                        const on = !fields || fields.includes(q.id);
                                        return <label key={q.id} className={`ev-chip${on ? ' is-on' : ''}`}><input type="checkbox" checked={on} onChange={e => toggle(q.id, e.target.checked)} />{q.label || 'Untitled'}</label>;
                                    })}
                                    {!shown.length && <span className="ev-hint ev-inline-hint">Add questions to the entry form first.</span>}
                                </div>
                                <Toggle checked={f.vote_display.author} onChange={author => set({ vote_display: { ...f.vote_display, author } })} label="Show who sent each entry"
                                    desc="Off for blind judging: voters see the entries without names." />
                            </div>
                        );
                    })()}
                    {scored && (
                        <div className="ev-field">
                            <span className="ev-field-label">Questions for voters <span className="ev-optional">(optional)</span></span>
                            <small className="ev-field-help">Asked about every entry, next to the scores, Google Forms style. They don't count toward the score; you see the answers in Results.</small>
                            <FormBuilder form={f.vote_form} onChange={vote_form => set({ vote_form })} types={VOTE_FIELD_TYPES} prefix="v" personal={false} />
                        </div>
                    )}
                    <fieldset className="ev-lockable" disabled={locked}>
                    {f.votingOn && (
                        <div className="ev-field">
                            <span className="ev-field-label">Who wins</span>
                            <div className="ev-rules">
                                {winnerRule('topn', 'The top', 'entries', 1000)}
                                {winnerRule('toppct', 'The top', '% of entries', 100)}
                                {winnerRule('minscore', 'Any entry with at least', '% of the possible points', 100)}
                            </div>
                            <small className="ev-field-help">An entry wins if it meets any ticked rule. Nothing ticked means the top 3. Possible points are every voter's maximum for that entry{scored ? ` (voters × ${f.criteria.reduce((n, c) => n + c.max, 0)})` : ' (one vote from each voter)'}. The standings come from the votes alone: nobody can place entries by hand.</small>
                        </div>
                    )}
                    {f.votingOn && (
                        <div className="ev-field">
                            <span className="ev-field-label">When entries tie</span>
                            <div className="ev-criterion-row">
                                <select value={f.tie_rule} onChange={e => set({ tie_rule: e.target.value as TieRule })} aria-label="When entries tie">
                                    {TIE_RULES.filter(([r]) => scored || r === 'share' || r === 'earliest').map(([r, label]) => <option key={r} value={r}>{label}</option>)}
                                </select>
                                {f.tie_rule === 'criterion' && scored && (
                                    <select value={f.tie_criterion} onChange={e => set({ tie_criterion: e.target.value })} aria-label="Which criterion settles a tie">
                                        <option value="" disabled>Which criterion?</option>
                                        {f.criteria.filter(c => c.name.trim()).map(c => <option key={c.name} value={c.name.trim()}>{c.name}</option>)}
                                    </select>
                                )}
                            </div>
                            <small className="ev-field-help">{
                                f.tie_rule === 'share' ? 'Entries with the same score share the place, so there can be two 2nd places (and then no 3rd). A tie for the last winning place lets both win.'
                                : f.tie_rule === 'criterion' ? 'Entries with the same score are ordered by their average on that criterion. If that ties too, they share the place.'
                                : f.tie_rule === 'votes' ? 'Entries with the same score are ordered by how many people voted for them. If that ties too, they share the place.'
                                : 'Entries with the same score are ordered by when they were sent in, earliest first.'}</small>
                        </div>
                    )}
                    {f.votingOn && <Toggle checked={f.allow_self_vote} onChange={v => set({ allow_self_vote: v })} label="Let people vote on their own entries" desc="Off by default: everyone votes on everyone else's. On: their own entries are on their ballot too." />}
                    </fieldset>
                    {f.votingOn && <Toggle checked={f.live_results} onChange={v => set({ live_results: v })} label="Live results" desc="Let everyone watch the standings while voting runs. Off: they're revealed when the results come out." />}
                    {!f.entries_private && <Toggle checked={f.show_entries} onChange={v => set({ show_entries: v })} label="Show entries while they come in" desc="Off: entries stay hidden until entries close." />}
                    <Toggle checked={f.hold_results} onChange={v => set({ hold_results: v })} label="Wait for the results post"
                        desc="The results stay hidden until you publish your results post from the dashboard's Results tab, even if the dates have passed." />
                </section>
            </>}

            <div className="ev-save-bar">
                {event && perms.owner && <button type="button" className="btn btn-danger-ghost" onClick={() => deleteEvent(event)}><Icon name="trash-2" size={15} />Delete event</button>}
                <span className="ev-autosave" aria-live="polite">{savedAt ? <><Icon name="check" size={13} />Draft saved on this device</> : ''}</span>
                {mode === 'edit'
                    ? <button className="btn btn-secondary" type="button" onClick={() => { setMode('preview'); window.scrollTo({ top: 0 }); }}><Icon name="eye" size={15} />Preview</button>
                    : <button className="btn btn-secondary" type="button" onClick={() => setMode('edit')}><Icon name="pencil" size={15} />Keep editing</button>}
                <button className="btn btn-primary" type="button" disabled={busy} onClick={save}>{busy ? 'Saving…' : event ? 'Save changes' : 'Create draft'}</button>
            </div>
        </div>
    );
}

function Toggle({ checked, onChange, label, desc }: { checked: boolean; onChange: (v: boolean) => void; label: string; desc: string }) {
    const id = `ev-t-${label.replace(/\W+/g, '-').toLowerCase()}`;
    return (
        <div className="ev-toggle">
            <span><strong id={id}>{label}</strong><small>{desc}</small></span>
            <span className="st-switch">
                <input type="checkbox" role="switch" checked={checked} aria-labelledby={id} onChange={e => onChange(e.target.checked)} />
                <span className="st-switch-track" aria-hidden="true" />
            </span>
        </div>
    );
}
