// The Community Hub's Events panel: the list of events, one event's page (the
// link entrants are sent), its voting (a quick vote, judges' scores, or the
// Fakémon-contest ballot), the organizer dashboard, and the event editor with
// its live preview. Data and actions are js/features/events.ts; the database
// enforces who may do what.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
    takingEntries, updateBallot, updateEntry, updateHelper, votingOpen, writeEventDraft, readEntryDraft, writeEntryDraft, clearEntryDraft,
    myTimeZone, timeZones, zonedParts, zonedToUtc,
    LIB_KINDS, MON_PARTS, describeMonRules, libLabel, libraryForEntry, libraryFromFile, monRuleProblems, myLibrary,
    type LibKind, type MonRules,
    type DashTab, type Detail, type Entry, type EventRow, type Field, type FieldType, type Helper, type Person, type Phase,
    createEventCode, deleteEventCode, randomCode, redeemEventCode, voteDisplay,
    type Criterion, type EventCode, type EventTab, type Remarks, type Stage, type Voting, type WinnerRules
} from '../../features/events.ts';
import { Avatar } from './Avatar.tsx';
import { EmojiInput, RichText } from './EmojiInput.tsx';
import { Icon } from './Icon.tsx';
import { Modal } from './Modal.tsx';
import { PokedexBoard } from './board/PokedexBoard.tsx';
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
const placeLabel = (n: number) => n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
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

function Cover({ ev, className }: { ev: Pick<EventRow, 'cover_image'>; className: string }) {
    return (
        <div className={`${className} ev-cover`} aria-hidden="true">
            {ev.cover_image ? <img src={ev.cover_image} alt="" draggable={false} /> : <Icon name="trophy" size={28} />}
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

function EventPage({ id, tab }: { id: string; tab: EventTab }) {
    const d = useDetail(id);
    if (!d?.event) return <><BackLink to={{ kind: 'list' }}>All events</BackLink><DetailState d={d} /></>;
    return <EventView ev={d.event} d={d} tab={tab} onTab={t => showEventView({ kind: 'event', id, tab: t })} />;
}

const emptyDetail = (ev: EventRow): Detail => ({
    id: ev.id, status: 'ready', error: '', event: ev, entries: [], privateAnswers: {}, myVotes: {}, votes: [], ballots: [], limits: [],
    results: null, helpers: [], people: {}, resultsPost: null, share: null, codes: []
});

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
                        <ShareMenu ev={ev} d={d} />
                        {perms.view && <button className="btn btn-secondary" type="button" onClick={() => showEventView({ kind: 'dashboard', id: ev.slug || ev.id })}><Icon name="chart-bar" size={15} />Dashboard</button>}
                    </div>
                )}
            </header>
            {ev.phase === 'draft' && !preview && <p className="ev-notice"><Icon name="eye-slash" size={15} />This is a draft. Only you and your team can see it until it opens.</p>}

            <div className="ev-page-grid">
                <div className="ev-page-main">
                    <AboutTab ev={ev} d={d} preview={preview} mine={mine} perms={perms} onTab={onTab} />
                </div>
                <aside className="ev-facts" aria-label="Event details">
                    <Timeline ev={ev} />
                    <dl>
                        <div><dt>Entries</dt><dd>{d.entries.length}</dd></div>
                        {!guest && <div><dt>Per person</dt><dd>{plural(allowance, 'entry', 'entries')}{allowance !== ev.max_entries_per_user && ' (just for you)'}</dd></div>}
                        <div><dt>Voting</dt><dd>{
                            ev.voting === 'community' ? `Community vote, ${plural(ev.votes_per_user, 'vote')} each`
                            : ev.voting === 'judges' ? `Judges score ${criteriaOf(ev).map(c => c.name).join(', ')}`
                            : ev.voting === 'ballot' ? `Everyone rates every entry on ${criteriaOf(ev).map(c => c.name).join(', ')}`
                            : 'No voting'}</dd></div>
                        {ev.voting !== 'none' && <div><dt>Who wins</dt><dd>{describeWinnerRules(ev.winner_criteria)}</dd></div>}
                        <div><dt>Results</dt><dd>{ev.live_results && ev.voting !== 'none' ? 'Live while voting' : ev.results_at ? `Out ${fmtDate(ev.results_at)}` : 'Shown when it ends'}</dd></div>
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
        stage === 'upcoming' ? ['enter', 'Entries open soon', `Entries open ${fmtDate(ev.submissions_open_at)} (${relTime(ev.submissions_open_at)}).`, 'See the form']
        : stage === 'open' || preview ? ['enter', 'Taking entries', ev.submissions_close_at ? `Entries close ${fmtDate(ev.submissions_close_at)} (${relTime(ev.submissions_close_at)}).` : 'Send yours in while entries are open.', mine.length ? 'Your entries' : 'Enter now']
        : stage === 'voting' ? ['vote', 'Voting is open', ev.voting_close_at ? `Voting closes ${fmtDate(ev.voting_close_at)} (${relTime(ev.voting_close_at)}).` : 'Have your say on the entries.', 'Vote now']
        : stage === 'tallying' ? ['results', 'Results soon', `Results come out ${fmtDate(ev.results_at)} (${relTime(ev.results_at)}).`, 'See the entries']
        : stage === 'ended' ? ['results', 'The results are in', 'See who won and every entry.', 'See the results']
        : stage === 'closed' ? [ev.voting === 'none' ? 'results' : 'vote', 'Entries are closed', ev.voting_open_at && !isPast(ev.voting_open_at) ? `Voting opens ${fmtDate(ev.voting_open_at)} (${relTime(ev.voting_open_at)}).` : 'Nothing more to send in.', 'See the entries']
        : null;
    // the other pages, when there's something on them
    const entriesVisible = ev.show_entries || ['closed', 'voting', 'tallying', 'ended'].includes(stage) || perms.entries || perms.judge || perms.results;
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
                ? <section className="ev-block"><h3>About</h3><RichText text={ev.description} className="ev-rich" /></section>
                : <p className="ev-hint">The organizers haven't written a description.</p>}
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
    if (editing && takingEntries(ev)) return <EntryForm key={editing.id} ev={ev} d={d} left={0} preview={false} editing={editing} onDone={() => setEditing(null)} />;
    return (
        <>
            {mine.length > 0 && (
                <section className="ev-block">
                    <h3>Your {mine.length === 1 ? 'entry' : 'entries'}</h3>
                    {takingEntries(ev) && <p className="ev-hint">You can change or withdraw {mine.length === 1 ? 'it' : 'them'} until entries close.</p>}
                    <div className="ev-gallery">{mine.map(en => <EntryCard key={en.id} ev={ev} d={d} entry={en} own onEdit={takingEntries(ev) ? () => setEditing(en) : undefined} />)}</div>
                </section>
            )}
            {canEnter && <EntryForm ev={ev} d={d} left={allowance - mine.length} preview={preview} />}
            {!preview && takingEntries(ev) && !canEnter && <p className="ev-notice"><Icon name="check-circle" size={15} />You've used all {plural(allowance, 'entry', 'entries')}. Withdraw one to enter something else.</p>}
            {!preview && !takingEntries(ev) && (
                <p className="ev-notice"><Icon name="clock" size={15} />{stage === 'upcoming' ? `Entries open ${fmtDate(ev.submissions_open_at)} (${relTime(ev.submissions_open_at)}).` : stage === 'draft' ? 'Entries open when the organizer publishes this event.' : 'Entries are closed.'}</p>
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
    const others = d.entries.filter(e => !state.user || e.user_id !== state.user.id);
    if (preview) return <p className="ev-notice"><Icon name="eye" size={15} />Voting shows here once it opens. The preview of the voting form is below.</p>;
    if (!votingOpen(ev)) {
        return (
            <>
                <p className="ev-notice"><Icon name="clock" size={15} />{
                    stage === 'closed' && ev.voting_open_at && !isPast(ev.voting_open_at) ? `Voting opens ${fmtDate(ev.voting_open_at)} (${relTime(ev.voting_open_at)}).`
                    : ['tallying', 'ended'].includes(stage) ? 'Voting is over.'
                    : 'Voting opens after entries close.'}</p>
                {others.length > 0 && (ev.show_entries || ['closed', 'tallying', 'ended'].includes(stage) || perms.entries || perms.judge || perms.results) && <Gallery ev={ev} d={d} entries={others} title="Entries" />}
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
    const visible = ev.show_entries || ['closed', 'voting', 'tallying', 'ended'].includes(stage) || perms.entries || perms.judge || perms.results;
    if (stage !== 'ended') {
        return (
            <>
                <p className="ev-notice"><Icon name="clock" size={15} />{stage === 'tallying' || ev.results_at ? `Results come out ${fmtDate(ev.results_at)}${ev.results_at ? ` (${relTime(ev.results_at)})` : ''}.` : 'Results come out when the event ends.'}</p>
                {visible && others.length > 0 && <Gallery ev={ev} d={d} entries={others} title="Entries so far" />}
            </>
        );
    }
    const winners = d.results ? computeWinners(ev, ranked(ev, d.entries, d.results)) : new Set<string>();
    return (
        <>
            {d.resultsPost && <section className="ev-block ev-results-post"><h3>Results</h3><RichText text={d.resultsPost} className="ev-rich" /></section>}
            {d.results && <Podium ev={ev} d={d} />}
            {d.entries.length > 0 && <Gallery ev={ev} d={d} entries={ranked(ev, d.entries, d.results).map(r => r.entry)} title="All entries" winners={winners} />}
            {!d.entries.length && <p className="ev-hint">This event had no entries.</p>}
        </>
    );
}

function Gallery({ ev, d, entries, title, winners }: { ev: EventRow; d: Detail; entries: Entry[]; title: string; winners?: Set<string> }) {
    return (
        <section className="ev-block">
            <div className="ev-block-head"><h3>{title}</h3><VoteBudget ev={ev} d={d} /></div>
            <div className="ev-gallery">{entries.map(en => <EntryCard key={en.id} ev={ev} d={d} entry={en} own={!!state.user && en.user_id === state.user.id} winner={winners?.has(en.id)} />)}</div>
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

function EntryCard({ ev, d, entry: en, own = false, winner = false, onEdit }: { ev: EventRow; d: Detail; entry: Entry; own?: boolean; winner?: boolean; onEdit?: () => void }) {
    const perms = permsFor(ev, d.helpers);
    const img = entryImage(ev, en);
    const author = authorOf(d, en);
    const result = d.results?.find(r => r.entry_id === en.id);
    const myVote = d.myVotes[en.id];
    const voting = votingOpen(ev) && !own && !!state.user;
    const outOfVotes = ev.voting === 'community' && !myVote && Object.keys(d.myVotes).length >= ev.votes_per_user;
    const [open, setOpen] = useState(false);
    return (
        <div className={`ev-entry${winner ? ' is-winner' : ''}${myVote && ev.voting === 'community' ? ' is-voted' : ''}`}>
            <button type="button" className="ev-entry-art" onClick={() => setOpen(true)} aria-label={`Open ${entryTitle(ev, en, d.people)}`}>
                {img ? <img src={img} alt="" draggable={false} loading="lazy" /> : <Icon name="document-text" size={26} />}
                {(en.placement || winner) && <span className="ev-place">{en.placement ? placeLabel(en.placement) : 'Winner'}</span>}
            </button>
            <div className="ev-entry-body">
                <strong>{entryTitle(ev, en, d.people)}</strong>
                {(own || !votingOpen(ev) || voteDisplay(ev).author) && <span className="ev-entry-by"><Avatar userId={en.user_id} url={author?.avatar_url} name={authorName(d, en)} className="ev-avatar ev-avatar-xs" />{authorName(d, en)}</span>}
                {result && <span className="ev-entry-score">{ev.voting === 'community' ? plural(Number(result.votes), 'vote') : `${Number(result.points_percent).toFixed(1)}% · ${plural(Number(result.votes), 'vote')}`}</span>}
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
    const top = rows.filter(r => winners.has(r.entry.id)).slice(0, 3);
    if (!top.length) return null;
    return (
        <section className="ev-block">
            <h3>Winners</h3>
            <ol className="ev-podium">
                {top.map(({ entry: en, result }, i) => (
                    <li key={en.id} className={`ev-podium-${i + 1}`}>
                        <span className="ev-podium-art">{entryImage(ev, en) ? <img src={entryImage(ev, en)} alt="" /> : <Icon name="trophy" size={28} />}</span>
                        <span className="ev-place">{placeLabel(en.placement || i + 1)}</span>
                        <strong>{entryTitle(ev, en, d.people)}</strong>
                        <span>{authorName(d, en)}{result ? ` · ${ev.voting === 'community' ? plural(Number(result.votes), 'vote') : `${Number(result.points_percent).toFixed(1)}%`}` : ''}</span>
                    </li>
                ))}
            </ol>
            {winners.size > 3 && <p className="ev-hint ev-podium-more">{winners.size - 3} more {winners.size - 3 === 1 ? 'entry wins' : 'entries win'} too, marked below.</p>}
        </section>
    );
}

// ---- one entry, every answer ----

function Answer({ field: f, value }: { field: Field; value: any }) {
    if (value == null || value === '' || value === false) return <span className="ev-muted">No answer</span>;
    if (f.type === 'image') return <img className="ev-answer-img" src={value} alt={f.label} />;
    if (f.type === 'fakemon') {
        const stats = value.stats && typeof value.stats === 'object' ? Object.values(value.stats as Record<string, unknown>).reduce((n: number, x) => n + (Number(x) || 0), 0) : 0;
        return (
            <span className="ev-answer-mon">
                {value.artwork && <img src={value.artwork} alt="" />}
                <span>
                    <strong>{value.name}</strong>
                    {[value.type1, value.type2].filter(Boolean).join(' / ')}{stats ? ` · BST ${stats}` : ''}
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('event-fakemon-board', { mon: value })}><Icon name="book-open" size={14} />Full Pokédex page</button>
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
    return (
        <dl className="ev-answers">
            {ev.form.map(f => {
                const isPrivate = isPrivateField(f);
                if (f.type === 'section' || (isPrivate && !(f.id in priv))) return null;
                return (
                    <div key={f.id}>
                        <dt>{f.label}{isPrivate && <span className="ev-private"><Icon name="lock-closed" size={11} />Private</span>}</dt>
                        <dd><Answer field={f} value={isPrivate ? priv[f.id] : en.answers[f.id]} /></dd>
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

/** A Fakémon answer drawn as its full Pokédex page, so it can be judged competitively. */
function FakemonBoardDialog({ close, mon }: DialogProps<{ mon: any }>) {
    useStore();
    const [ready, setReady] = useState(false);
    useEffect(() => {
        Promise.resolve(api.fetchShowdownData?.()).finally(() => { previewEventFakemon(mon); setReady(true); });
    }, [mon]);
    return (
        <Modal onClose={close} title={mon?.name || 'Fakémon'} className="quick-preview-modal">
            <div className="preview-modal-board-wrap">
                {ready ? <PokedexBoard id="pokedex-board-event" model={api.boardModel()} onToggleShiny={() => api.togglePreviewArtworkMode()} />
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
    const original = useMemo(() => editing ? { ...editing.answers, ...(d.privateAnswers[editing.id] || {}) } : {}, [editing?.id]);
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
            if (broken.length) return `Your Fakémon ${broken.join(', ')} ("${f.label}").`;
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
    async function run(task: () => Promise<void>) {
        setBusy(true);
        try { await task(); } catch (e: any) { api.showToast?.(e?.message || 'That file could not be used.', 'error'); } finally { setBusy(false); }
    }
    const pickImage = (file?: File | null) => file && run(async () => onChange(await shrinkImage(file, 1800, MAX_IMAGE_CHARS)));
    // from your collection it goes straight in; from a file it's checked over first
    const pickMon = (mon: any) => run(async () => onChange(await fakemonForEntry(mon)));
    const checkMon = (mon: any) => run(async () => openDialog('event-fakemon-details', { mon: await fakemonForEntry(mon), imported: true, rules: f.rules, onSave: onChange }));
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
        if (mons.length === 1) checkMon(mons[0]);
        else openDialog('event-fakemon-picker', { mons, onPick: checkMon });
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
            input = (
                <div className="ev-upload ev-mon-pick">
                    {value?.artwork ? <img src={value.artwork} alt="" /> : <Icon name="sparkles" size={26} />}
                    <span>
                        {value && <strong>{value.name || 'Unnamed Fakémon'}{value.type1 && <small> · {[value.type1, value.type2].filter(Boolean).join(' / ')}</small>}</strong>}
                        {broken.length > 0 && <small className="ev-mon-gaps is-problem"><Icon name="shield-exclamation" size={12} />For this event it {broken.join(', ')}</small>}
                        {gaps.length > 0 && <small className="ev-mon-gaps"><Icon name="exclamation-circle" size={12} />No {gaps.join(', ')} yet</small>}
                        {busy ? <span className="ev-hint ev-inline-hint">Preparing…</span> : value ? <span className="ev-mon-actions">
                            <button id={id} type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('event-fakemon-details', { mon: value, rules: f.rules, onSave: onChange })}><Icon name="pencil" size={14} />Edit details</button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('event-fakemon-board', { mon: value })}><Icon name="book-open" size={14} />Preview</button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange(null)}>Remove</button>
                        </span> : <span className="ev-mon-actions">
                            <button id={id} type="button" className="btn btn-secondary btn-sm" onClick={() => openDialog('event-fakemon-picker', { onPick: pickMon })}><Icon name="squares-2x2" size={14} />From my collection</button>
                            <label className="btn btn-secondary btn-sm" htmlFor={`${id}-file`}><Icon name="arrow-up-tray" size={14} />Import a file</label>
                        </span>}
                    </span>
                    <input id={`${id}-file`} className="ev-sr" type="file" accept=".json,.txt,application/json,text/plain" onChange={e => { uploadMon(e.target.files?.[0]); e.target.value = ''; }} />
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
            {f.type === 'fakemon' && <small className="ev-field-help">Import a Woogidex export (.json) or a text export (.txt); you'll be asked for anything it's missing. The whole Fakémon goes in with your entry, and it doesn't count toward your Community uploads or cloud storage.</small>}
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

function FakemonDetailsDialog({ close, mon, imported = false, rules, onSave }: DialogProps<{ mon: any; imported?: boolean; rules?: MonRules; onSave: (m: any) => void }>) {
    const [m, setM] = useState<any>(() => ({
        ...mon,
        stats: Object.fromEntries(MON_STATS.map(([k]) => [k, Number(mon?.stats?.[k]) || 60])),
        abilities: [0, 1, 2].map(i => mon?.abilities?.[i] || { name: '', source: 'custom', custom: true, desc: '' })
    }));
    const [busy, setBusy] = useState(false);
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
        <Modal onClose={close} className="modal-wide ev-mon-modal" title={imported ? 'Check your Fakémon' : 'Edit your Fakémon'} dismissible={!busy}>
            {imported && (gaps.length
                ? <p className="ev-notice"><Icon name="exclamation-circle" size={15} /><span>The file didn't include its <strong>{gaps.join(', ')}</strong>. Fill in what you can; only the name and type are needed.</span></p>
                : <p className="ev-notice is-done"><Icon name="check-circle" size={15} />Everything came through. Look it over, then use it.</p>)}
            {monRuleProblems(m, rules).length > 0 && (
                <p className="ev-notice is-problem"><Icon name="shield-exclamation" size={15} /><span>For this event, your Fakémon {monRuleProblems(m, rules).join(', ')}.</span></p>
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
                            onChange={e => set({ abilities: m.abilities.map((x: any, j: number) => j === i ? { ...x, name: e.target.value } : x) })} />
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
            <p className="ev-hint">Moves, sets and everything else come along from the file as they are. To change those, edit it in Woogidex and import it again.</p>
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
        const empty = !next.require?.length && !next.types?.length && !next.noCustomTypes && !next.noCustomAbilities && !next.noCustomMoves && !next.minBst && !next.maxBst;
        onChange(empty ? undefined : next);
    };
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
                <div className="ev-q-rule-row"><span className="ev-q-sub">Not allowed</span>
                    <div className="ev-q-flags">
                        <label><input type="checkbox" checked={!!rules.noCustomTypes} onChange={e => update({ noCustomTypes: e.target.checked || undefined })} />Custom types</label>
                        <label><input type="checkbox" checked={!!rules.noCustomAbilities} onChange={e => update({ noCustomAbilities: e.target.checked || undefined })} />Custom abilities</label>
                        <label><input type="checkbox" checked={!!rules.noCustomMoves} onChange={e => update({ noCustomMoves: e.target.checked || undefined })} />Custom moves</label>
                    </div></div>
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
    ['entries', 'Entries', 'inbox-stack', 'entries'],
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
        stage === 'draft' ? ['open', scheduled ? 'Publish (entries open on schedule)' : 'Open for entries']
        : stage === 'upcoming' || stage === 'open' ? (ev.voting === 'none' ? ['ended', 'Close and end the event'] : ['voting', 'Close entries, start voting'])
        : stage === 'closed' ? (ev.voting === 'none' ? ['ended', 'End event and publish results'] : ['voting', 'Start voting now'])
        : stage === 'voting' ? ['ended', 'End event and publish results'] : null;
    // publishing a scheduled draft keeps its dates; any other move happens now
    const go = ([p]: [Phase, string]) => stage === 'draft' && scheduled ? saveEvent(ev.id, { phase: 'open' }, 'Published. Entries open on schedule.') : setPhase(ev, p);
    return (
        <div className="ev-dash-grid">
            <section className="ev-block">
                <h3>Where it's at</h3>
                <Timeline ev={ev} />
                {perms.edit && (
                    <div className="ev-phase-controls">
                        {next && <button className="btn btn-primary" type="button" onClick={() => go(next)}>{next[1]}</button>}
                        <label className="ev-inline-select">Set phase
                            <select value={ev.phase} onChange={e => setPhase(ev, e.target.value as Phase)}>
                                {PHASES.filter(([p]) => p !== 'voting' || ev.voting !== 'none').map(([p, label]) => <option key={p} value={p}>{label}</option>)}
                            </select>
                        </label>
                    </div>
                )}
                <p className="ev-hint">Dates move the event along by themselves. Setting a phase by hand happens now, and clears dates that would undo it.</p>
                <p className="ev-hint">You and your team can enter and vote too, from the <button type="button" className="ev-link" onClick={() => showEventView({ kind: 'event', id: ev.id })}>event page</button>. Nobody can vote on their own entry.</p>
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

function EntriesTab({ ev, d }: { ev: EventRow; d: Detail }) {
    const perms = permsFor(ev, d.helpers);
    const [open, setOpen] = useState<string | null>(null);
    const [q, setQ] = useState('');
    const query = q.trim().toLowerCase();
    const list = d.entries.filter(en => !query || entryTitle(ev, en, d.people).toLowerCase().includes(query) || (authorOf(d, en)?.username || '').toLowerCase().includes(query));
    return (
        <>
            <section className="ev-block">
                <div className="ev-block-head">
                    <h3>{plural(d.entries.length, 'entry', 'entries')}</h3>
                    <div className="ev-head-actions">
                        <input type="search" placeholder="Search entries" value={q} onChange={e => setQ(e.target.value)} aria-label="Search entries" />
                        <button className="btn btn-secondary btn-sm" type="button" onClick={exportEntriesCsv} disabled={!d.entries.length}><Icon name="arrow-down-tray" size={14} />Export CSV</button>
                    </div>
                </div>
                {!d.entries.length && <p className="ev-hint">{ev.phase === 'draft' ? 'Open the event to start taking entries.' : 'Nothing yet. Share the entry link to get people in.'}</p>}
                <ul className="ev-table">
                    {list.map(en => {
                        const p = authorOf(d, en);
                        const expanded = open === en.id;
                        return (
                            <li key={en.id} className={expanded ? 'is-open' : ''}>
                                <button type="button" className="ev-table-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : en.id)}>
                                    <span className="ev-table-thumb">{entryImage(ev, en) ? <img src={entryImage(ev, en)} alt="" /> : <Icon name="document-text" size={18} />}</span>
                                    <span className="ev-table-main"><strong>{entryTitle(ev, en, d.people)}</strong><small>{en.user_id ? `@${p?.username || 'unknown'}` : 'Guest'} · {fmtDate(en.created_at)}</small></span>
                                    {en.placement && <span className="ev-place">{placeLabel(en.placement)}</span>}
                                    <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={16} />
                                </button>
                                {expanded && (
                                    <div className="ev-table-detail">
                                        <EntryAnswers ev={ev} d={d} entry={en} />
                                        <div className="ev-form-actions">
                                            {perms.edit && <PlacementPicker entry={en} />}
                                            {perms.entries && <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => removeEntry(en, false)}><Icon name="trash-2" size={14} />Remove entry</button>}
                                        </div>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </section>
            {perms.edit && <ExtraEntries ev={ev} d={d} />}
            {perms.edit && <EntryCodes ev={ev} d={d} />}
        </>
    );
}

/** People allowed a different number of entries than the event's default. */
function ExtraEntries({ ev, d }: { ev: EventRow; d: Detail }) {
    const [name, setName] = useState('');
    const [max, setMax] = useState(ev.max_entries_per_user + 1);
    const [busy, setBusy] = useState(false);
    async function add(e: React.FormEvent) {
        e.preventDefault();
        setBusy(true);
        if (await setEntryLimit(ev.id, name, max)) setName('');
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
            <form className="ev-share-field" onSubmit={add}>
                <input type="text" placeholder="@username" value={name} onChange={e => setName(e.target.value)} aria-label="Username" autoComplete="off" />
                <input type="number" min={1} max={100} value={max} onChange={e => setMax(Number(e.target.value))} aria-label="Entries allowed" className="ev-num" />
                <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !name.trim()}>Set</button>
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
                    {ev.voting === 'none' ? 'This event has no voting: pick winners with a placement.'
                        : `Winners: ${describeWinnerRules(ev.winner_criteria)}, plus anyone you give a placement. ${plural(totalVoters, 'voter')} so far. `}
                    {ev.voting !== 'none' && (ev.live_results ? 'Live results are on, so entrants see these while voting runs.' : 'Only the team sees these until the event ends.')}
                </p>
                {!rows.length && <p className="ev-hint">No entries yet.</p>}
                <ol className="ev-standings">
                    {rows.map(({ entry: en, result }, i) => {
                        const value = community ? Number(result?.votes || 0) : Number(result?.points_percent || 0);
                        const won = winners.has(en.id);
                        return (
                            <li key={en.id} className={won ? 'is-winner' : ''}>
                                <span className="ev-rank">{en.placement ? placeLabel(en.placement) : won ? <Icon name="trophy" size={16} /> : `#${i + 1}`}</span>
                                <span className="ev-standing-main">
                                    <strong>{entryTitle(ev, en, d.people)}{won && <span className="ev-winner-chip">{effectivePhase(ev) === 'ended' ? 'Winner' : 'Winning'}</span>}</strong>
                                    <span className="ev-bar" aria-hidden="true"><span style={{ width: `${(value / max) * 100}%` }} /></span>
                                    {!community && result && <small className="ev-criteria-avgs">{criteriaOf(ev).map(c => `${c.name} ${result.criteria_avg?.[c.name] ?? '-'}/${c.max}`).join(' · ')}</small>}
                                </span>
                                <span className="ev-standing-num">{community ? plural(value, 'vote') : `${value.toFixed(1)}% · ${plural(Number(result?.votes || 0), 'vote')}`}</span>
                                {perms.edit && <PlacementPicker entry={en} />}
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
    useEffect(() => { setText(d.resultsPost || ''); }, [d.resultsPost]);
    const stage = effectivePhase(ev);
    const dirty = text.trim() !== (d.resultsPost || '');
    async function save() { setBusy(true); await saveResultsPost(ev.id, text); setBusy(false); }
    return (
        <section className="ev-block">
            <div className="ev-block-head">
                <h3>Results post</h3>
                <div className="ev-segmented" role="tablist" aria-label="Results post">
                    <button type="button" role="tab" aria-selected={mode === 'write'} className={mode === 'write' ? 'active' : ''} onClick={() => setMode('write')}>Write</button>
                    <button type="button" role="tab" aria-selected={mode === 'preview'} className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>Preview</button>
                </div>
            </div>
            <p className="ev-hint">Shown at the top of the event page once the results are out{ev.results_at && stage !== 'ended' ? ` (${fmtDate(ev.results_at)})` : ''}. Until then only the team can read it.</p>
            {mode === 'write'
                ? <EmojiInput value={text} onChange={setText} rows={10} maxLength={10000} className="ev-about-input" ariaLabel="Results post"
                    placeholder={'## The results are in!\n🥇 **Blazelyn** by @mira\n🥈 **Mossbit** by @kai\n\nThanks to everyone who entered :woogi:'} />
                : <div className="ev-preview-box">{text.trim() ? <RichText text={text} className="ev-rich" /> : <p className="ev-hint">Nothing written yet.</p>}</div>}
            <small className="ev-field-help">Markdown works: # headings, **bold**, *italics*, lists, &gt; quotes, --- lines, ||spoilers||, [links](https://…) and :emojis:.</small>
            <div className="ev-form-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setText(t => (t.trim() ? `${t.trim()}\n\n` : '') + standingsMarkdown(ev, d))} disabled={!d.results}>
                    <Icon name="trophy" size={14} />Insert the winners</button>
                {d.share && <button type="button" className="btn btn-secondary btn-sm" disabled={!text.trim()}
                    onClick={() => openDialog('quote-repost', { item: d.share, text: text.trim().slice(0, 4000) })}><Icon name="megaphone" size={14} />Post it to the feed</button>}
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save results post'}</button>
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

const HELPER_PERMS: Array<[keyof Omit<Helper, 'event_id' | 'user_id'>, string, string]> = [
    ['can_edit', 'Edit', 'Change details, the form, phases, entry limits and winners'],
    ['can_entries', 'Entries', 'See every answer, private ones too, and remove entries'],
    ['can_judge', 'Judge', 'Score entries when judges pick the winners'],
    ['can_results', 'Results', 'See standings, scores and remarks before they are public']
];

function TeamTab({ ev, d }: { ev: EventRow; d: Detail }) {
    const perms = permsFor(ev, d.helpers);
    const [name, setName] = useState('');
    const [grant, setGrant] = useState({ can_edit: false, can_entries: false, can_judge: ev.voting === 'judges', can_results: true });
    const [busy, setBusy] = useState(false);
    const owner = d.people[ev.owner_id];
    async function add(e: React.FormEvent) {
        e.preventDefault();
        setBusy(true);
        if (await addHelper(ev.id, name, grant)) setName('');
        setBusy(false);
    }
    return (
        <section className="ev-block">
            <h3>Team</h3>
            <p className="ev-hint">People you add can open this dashboard. Give each one only what they need.</p>
            <ul className="ev-team">
                <li>
                    <Avatar userId={ev.owner_id} url={owner?.avatar_url} name={personName(owner)} className="ev-avatar" />
                    <span className="ev-team-name"><strong>{personName(owner)}</strong><small>@{owner?.username} · Organizer, can do everything</small></span>
                </li>
                {d.helpers.map(h => {
                    const p = d.people[h.user_id];
                    const self = h.user_id === state.user?.id;
                    return (
                        <li key={h.user_id}>
                            <Avatar userId={h.user_id} url={p?.avatar_url} name={personName(p)} className="ev-avatar" />
                            <span className="ev-team-name"><strong>{personName(p)}</strong><small>@{p?.username}</small></span>
                            <span className="ev-perm-chips">
                                {HELPER_PERMS.map(([k, label, desc]) => (
                                    <label key={k} className={`ev-chip${h[k] ? ' is-on' : ''}`} title={desc}>
                                        <input type="checkbox" checked={h[k]} disabled={!perms.owner} onChange={e => updateHelper(h, { [k]: e.target.checked })} />{label}
                                    </label>
                                ))}
                            </span>
                            {(perms.owner || self) && <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeHelper(h, self && !perms.owner)}>{self && !perms.owner ? 'Leave' : 'Remove'}</button>}
                        </li>
                    );
                })}
            </ul>
            {perms.owner && (
                <form className="ev-add-helper" onSubmit={add}>
                    <h4>Add someone</h4>
                    <div className="ev-share-field">
                        <input type="text" placeholder="@username" value={name} onChange={e => setName(e.target.value)} aria-label="Username" autoComplete="off" />
                        <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !name.trim()}><Icon name="user-plus" size={14} />Add</button>
                    </div>
                    <div className="ev-perm-grid">
                        {HELPER_PERMS.map(([k, label, desc]) => (
                            <label key={k} className="ev-perm-option">
                                <input type="checkbox" checked={grant[k]} onChange={e => setGrant(g => ({ ...g, [k]: e.target.checked }))} />
                                <span><strong>{label}</strong><small>{desc}</small></span>
                            </label>
                        ))}
                    </div>
                </form>
            )}
        </section>
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

function DatePickerDialog({ close, title, value, timeZone, min, onPick }: DialogProps<{ title: string; value: string; timeZone: string; min?: string; onPick: (iso: string, timeZone: string) => void }>) {
    const [zone, setZone] = useState(timeZone);
    const start = zonedParts(value ? Date.parse(value) : Date.now() + 86_400_000, zone);
    const [day, setDay] = useState<{ y: number; mo: number; d: number } | null>(value ? { y: start.y, mo: start.mo, d: start.d } : null);
    const [time, setTime] = useState(value ? `${pad(start.h)}:${pad(start.mi)}` : '12:00');
    const [month, setMonth] = useState({ y: start.y, mo: start.mo });
    const today = zonedParts(Date.now(), zone);
    const first = new Date(Date.UTC(month.y, month.mo, 1)).getUTCDay();
    const days = new Date(Date.UTC(month.y, month.mo + 1, 0)).getUTCDate();
    const shift = (by: number) => setMonth(m => { const t = new Date(Date.UTC(m.y, m.mo + by, 1)); return { y: t.getUTCFullYear(), mo: t.getUTCMonth() }; });
    const picked = day && /^\d{2}:\d{2}$/.test(time) ? zonedToUtc(day.y, day.mo, day.d, Number(time.slice(0, 2)), Number(time.slice(3)), zone) : null;
    const tooEarly = picked && min ? picked.getTime() < Date.parse(min) : false;
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
                    <button type="button" className="ev-icon-btn" onClick={() => shift(-1)} aria-label="Previous month"><Icon name="chevron-left" size={16} /></button>
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
                        return (
                            <button key={d} type="button" className={`ev-cal-day${on ? ' is-on' : ''}${isToday ? ' is-today' : ''}`} aria-pressed={on}
                                aria-label={new Date(Date.UTC(month.y, month.mo, d)).toLocaleDateString([], { dateStyle: 'full', timeZone: 'UTC' })}
                                onClick={() => setDay({ y: month.y, mo: month.mo, d })}>{d}</button>
                        );
                    })}
                </div>
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
                {!picked ? 'Pick a day.' : tooEarly ? `That's before ${fmtDate(min)}, the step before it.` : <>Everyone sees this in their own time zone. For you: <strong>{fmtDate(picked.toISOString())}</strong>.</>}
            </p>
            <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={close}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={!picked} onClick={use}>Set date</button>
            </div>
        </Modal>
    );
}
registerDialog('event-date-picker', DatePickerDialog);

/** A schedule date: a button that opens the picker, shown in the organizer's chosen zone. */
function DateField({ id, label, value, onChange, timeZone, onTimeZone, min, children }: {
    id: string; label: string; value: string; onChange: (iso: string) => void; timeZone: string; onTimeZone: (z: string) => void; min?: string; children?: ReactNode;
}) {
    const open = () => openDialog('event-date-picker', { title: label, value, timeZone, min, onPick: (iso: string, z: string) => { onChange(iso); onTimeZone(z); } });
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
    title: string; tagline: string; description: string; category: string; cover_image: string | null;
    submissions_open_at: string; submissions_close_at: string; voting_open_at: string; voting_close_at: string; results_at: string;
    form: Field[]; votingOn: boolean; mode: VotingMode; votes_per_user: number; max_entries_per_user: number;
    live_results: boolean; show_entries: boolean; public_access: boolean; slug: string; vote_form: Field[];
    vote_display: { fields: string[] | null; author: boolean };
    criteria: Criterion[]; voter_remarks: Remarks; winner: { topn: string | null; toppct: string | null; minscore: string | null };
};

function valuesFrom(event: EventRow | null): EditorValues {
    const wc: WinnerRules = event?.winner_criteria || { top_n: 3 };
    return {
        title: event?.title || '', tagline: event?.tagline || '', description: event?.description || '', category: event?.category || '',
        cover_image: event?.cover_image || null,
        submissions_open_at: event?.submissions_open_at || '', submissions_close_at: event?.submissions_close_at || '',
        voting_open_at: event?.voting_open_at || '', voting_close_at: event?.voting_close_at || '', results_at: event?.results_at || '',
        form: event?.form || PRESETS[0][2], votingOn: (event?.voting || PRESETS[0][3]) !== 'none',
        mode: (event && event.voting !== 'none' ? event.voting : 'ballot') as VotingMode, votes_per_user: event?.votes_per_user || 3,
        max_entries_per_user: event?.max_entries_per_user || 1, live_results: event?.live_results || false, show_entries: event?.show_entries ?? true,
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
        cover_image: f.cover_image,
        submissions_open_at: iso(f.submissions_open_at), submissions_close_at: iso(f.submissions_close_at),
        voting_open_at: votingOn ? iso(f.voting_open_at) : null, voting_close_at: votingOn ? iso(f.voting_close_at) : null,
        results_at: iso(f.results_at), public_access: f.public_access, voter_remarks: f.voter_remarks,
        slug: f.slug.trim() || null,
        vote_display: { fields: f.vote_display.fields ? f.vote_display.fields.filter(id => f.form.some(q => q.id === id)) : null, author: f.vote_display.author },
        vote_form: f.vote_form.map(x => ({ ...x, label: x.label.trim(), help: (x.help || '').trim(), options: hasOptions(x.type) ? (x.options || []).map(o => o.trim()).filter(Boolean) : undefined })),
        form: f.form.map(x => ({ ...x, label: x.label.trim(), help: (x.help || '').trim(), options: hasOptions(x.type) ? (x.options || []).map(o => o.trim()).filter(Boolean) : undefined })),
        voting: votingOn ? f.mode : 'none', votes_per_user: f.votes_per_user, max_entries_per_user: f.max_entries_per_user,
        live_results: f.live_results, show_entries: f.show_entries,
        criteria: criteria.length ? criteria : DEFAULT_CRITERIA, winner_criteria
    };
}

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
    const [sample, setSample] = useState<{ scores: Record<string, number>; remarks: string; answers: Record<string, any> }>({ scores: {}, remarks: '', answers: {} });

    // autosave: what you've typed stays on this device until it's saved, like a post draft
    const pristine = useRef(JSON.stringify(valuesFrom(event)));
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
            try { set({ cover_image: await shrinkImage(cropped, 1600, 580_000) }); }
            catch (e: any) { api.showToast?.(e?.message || 'That image could not be used.', 'error'); }
        });
    }

    async function save() {
        if (f.title.trim().length < 3) { api.showToast?.('Give the event a name (at least 3 characters).', 'warning'); setMode('edit'); return; }
        if (f.slug.trim() && !SLUG_PATTERN.test(f.slug.trim())) { api.showToast?.('The link can use lowercase letters, numbers and dashes, 3 to 48 of them.', 'warning'); setMode('edit'); return; }
        setBusy(true);
        // pristine first: creating navigates to the dashboard, and the autosave must not resurrect the draft
        const before = pristine.current;
        pristine.current = JSON.stringify(f);
        clearEventDraft(eventId);
        const ok = event ? await saveEvent(event.id, rowFrom(f), 'Settings saved.') : !!(await createEvent(rowFrom(f)));
        setBusy(false);
        if (ok) { setSavedAt(null); setNotice(false); }
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
                    <p>{event ? 'Changes go live when you save them.' : 'It starts as a draft only you can see. Open it from its dashboard when it\'s ready.'}</p>
                </div>
                <div className="ev-segmented" role="tablist" aria-label="Editor mode">
                    <button type="button" role="tab" aria-selected={mode === 'edit'} className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}><Icon name="pencil" size={14} />Edit</button>
                    <button type="button" role="tab" aria-selected={mode === 'preview'} className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}><Icon name="eye" size={14} />Preview</button>
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
                    <p className="ev-preview-label"><Icon name="eye" size={14} />Preview: what entrants will see, with the entry form. Nothing here is saved or sent.</p>
                    <EventView ev={previewRow} d={emptyDetail(previewRow)} preview tab={previewTab} onTab={setPreviewTab} />
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
                                {f.cover_image && <button type="button" className="btn btn-secondary btn-sm" onClick={() => set({ cover_image: null })}>Remove</button>}
                            </span>
                            <input id="ev-cover" className="ev-sr" type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { pickCover(e.target.files?.[0]); e.target.value = ''; }} />
                        </div>
                    </div>
                    <div className="ev-field">
                        <span className="ev-field-label">About, rules and prizes</span>
                        <EmojiInput value={f.description} onChange={v => set({ description: v })} rows={9} maxLength={8000} className="ev-about-input" ariaLabel="About, rules and prizes"
                            placeholder={'# New PoA Contest!\nMake a Fakémon for this round\'s PoA theme.\n\n## Rules\n- One entry each, original designs only\n- Keep it SFW\n\n## Prizes\n**1st place** gets featured on the hub'} />
                        <small className="ev-field-help">Markdown works: # headings, **bold**, *italics*, ~~strike~~, - lists, &gt; quotes, `code`, ``` code blocks, --- for a line, ||spoilers|| and [links](https://…). Type : to add an emoji.</small>
                    </div>
                </section>

                <section className="ev-block">
                    <div className="ev-block-head">
                        <h3>What entrants send in</h3>
                        {!event && (
                            <label className="ev-inline-select">Start from
                                <select defaultValue="" onChange={e => { const p = PRESETS.find(x => x[0] === e.target.value); if (p) set({ form: p[2], votingOn: p[3] !== 'none', mode: p[3] === 'none' ? f.mode : p[3] as VotingMode, category: f.category || p[1] }); }}>
                                    <option value="" disabled>Template…</option>
                                    {PRESETS.map(([name]) => <option key={name} value={name}>{name}</option>)}
                                </select>
                            </label>
                        )}
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
                        <DateField id="ev-sclose" label="Entries close" value={f.submissions_close_at} onChange={v => set({ submissions_close_at: v })} timeZone={tz} onTimeZone={setTz} min={f.submissions_open_at} />
                    </div>
                    {f.votingOn && (
                        <div className="ev-two">
                            <DateField id="ev-vopen" label="Voting opens" value={f.voting_open_at} onChange={v => set({ voting_open_at: v })} timeZone={tz} onTimeZone={setTz} min={f.submissions_close_at}>
                                <button type="button" className="ev-link" disabled={!f.submissions_close_at} title={f.submissions_close_at ? undefined : 'Set when entries close first'}
                                    onClick={() => set({ voting_open_at: f.submissions_close_at })}><Icon name="arrow-turn-down-right" size={13} />Start right when entries close</button>
                            </DateField>
                            <DateField id="ev-vclose" label="Voting closes" value={f.voting_close_at} onChange={v => set({ voting_close_at: v })} timeZone={tz} onTimeZone={setTz} min={f.voting_open_at || f.submissions_close_at} />
                        </div>
                    )}
                    <div className="ev-field-half">
                        <DateField id="ev-results" label="Results come out" value={f.results_at} onChange={v => set({ results_at: v })} timeZone={tz} onTimeZone={setTz} min={f.votingOn ? f.voting_close_at : f.submissions_close_at}>
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
                </section>

                <section className="ev-block">
                    <h3>Voting</h3>
                    <Toggle checked={f.votingOn} onChange={v => set({ votingOn: v })} label="This event has voting"
                        desc="Off for sign-ups and anything that doesn't pick winners by vote. You can still give placements by hand." />
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
                    {f.votingOn && (
                        <div className="ev-field">
                            <span className="ev-field-label">Who wins</span>
                            <div className="ev-rules">
                                {winnerRule('topn', 'The top', 'entries', 1000)}
                                {winnerRule('toppct', 'The top', '% of entries', 100)}
                                {winnerRule('minscore', 'Any entry with at least', '% of the possible points', 100)}
                            </div>
                            <small className="ev-field-help">An entry wins if it meets any ticked rule, and anything you give a placement wins too. Nothing ticked means the top 3. Possible points are every voter's maximum for that entry{scored ? ` (voters × ${f.criteria.reduce((n, c) => n + c.max, 0)})` : ' (one vote from each voter)'}.</small>
                        </div>
                    )}
                    {f.votingOn && <Toggle checked={f.live_results} onChange={v => set({ live_results: v })} label="Live results" desc="Let everyone watch the standings while voting runs. Off: they're revealed when the results come out." />}
                    <Toggle checked={f.show_entries} onChange={v => set({ show_entries: v })} label="Show entries while they come in" desc="Off: entries stay hidden until voting starts." />
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
