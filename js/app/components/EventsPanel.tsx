// The Community Hub's Events panel: every event and its contests, entering
// one of your Fakémon, results, and the voting screen. Data and actions are
// js/features/contests.ts.

import { useEffect, useState, type ReactNode } from 'react';
import { state } from '../../core/app.ts';
import {
    PHASE_STEPS, closeContestVoting, computeWinners, contests, describeWinnerCriteria, effectivePhase, eligibleEntries,
    eventIsLive, findContest, fmtDate, jumpContestVote, loadContestResults, loadEventsView, openContestMonPicker,
    openContestSignIn, phaseLabel, relTime, saveAndNextContestVote, setContestVoteRemarks, setContestVoteScore,
    showContestResults, startContestVoting, submissionImage, submissionPointsPercent, submitContestBallot,
    submitContestEntry, toggleContestDetails, voteComplete, votingWindowOpen, withdrawContestEntry,
    type Contest, type ContestEvent, type Phase
} from '../../features/contests.ts';
import { Icon } from './Icon.tsx';
import { Modal } from './Modal.tsx';
import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { useStore } from '../store.ts';

export function EventsPanel() {
    useStore();
    return (
        <>
            <div className="collection-title-row">
                <div className="collection-title-left"><h2 className="collection-heading">Events and contests</h2></div>
                <div className="collection-header-actions">
                    <button className="btn btn-secondary" type="button" onClick={() => loadEventsView()}><Icon name="refresh-cw" /> Refresh</button>
                </div>
            </div>
            <div className="events-status">{contests.status === 'error' ? 'Could not load events.' : ''}</div>
            {contests.voting ? <VotingView /> : <EventsList />}
        </>
    );
}

function EventsList() {
    if (contests.status === 'loading' && !contests.loaded) return <div className="events-list"><EventsSkeleton /></div>;
    if (contests.status === 'error') return <div className="events-list"><div className="community-empty">{contests.error}</div></div>;
    if (!contests.events.length) {
        return (
            <div className="events-list">
                <div className="events-empty">
                    <Icon name="trophy" />
                    <h4>No contests yet</h4>
                    <p>When a contest opens you will be able to enter one of your Fakémon and vote on everyone else's. Watch this space.</p>
                </div>
            </div>
        );
    }
    // live events first, then the rest in server order
    const ordered = [...contests.events.filter(eventIsLive), ...contests.events.filter(e => !eventIsLive(e))];
    return <div className="events-list">{ordered.map(e => <EventGroup key={e.id} event={e} />)}</div>;
}

function EventsSkeleton() {
    const card = <div className="contest-card skel-card">
        <span className="skel skel-text" style={{ width: '55%', height: 15, marginBottom: 10 }} />
        <span className="skel skel-text" style={{ width: '85%' }} />
        <span className="skel skel-text" style={{ width: '40%' }} />
    </div>;
    return (
        <>
            {[0, 1].map(i => (
                <section className="event-group" key={i}>
                    <div className="event-card-head"><div>
                        <span className="skel skel-text" style={{ width: 180, height: 18, marginBottom: 6 }} />
                        <span className="skel skel-text" style={{ width: 140, height: 11 }} />
                    </div></div>
                    <div className="contest-list">{card}{card}</div>
                </section>
            ))}
        </>
    );
}

function EventGroup({ event: e }: { event: ContestEvent }) {
    const live = eventIsLive(e);
    const list = e.contests || [];
    return (
        <section className={`event-group${live ? ' is-live' : ''}`}>
            <div className="event-card-head">
                <div>
                    <div className="event-group-title-row">
                        <h3>{e.title}</h3>
                        {live && <span className="event-live-pill"><span className="event-live-dot" /> Live now</span>}
                    </div>
                    {e.description && <div className="event-card-description">{e.description}</div>}
                    <div className="event-date"><Icon name="calendar" /> {fmtDate(e.starts_at)} to {fmtDate(e.ends_at)}</div>
                </div>
                <div className="event-group-count">{list.length} contest{list.length === 1 ? '' : 's'}</div>
            </div>
            <div className="contest-list">
                {list.length ? list.map(c => <ContestCard key={c.id} contest={c} />) : <div className="community-empty">No contests in this event yet.</div>}
            </div>
        </section>
    );
}

function PhaseProgress({ phase }: { phase: Phase }) {
    if (phase === 'draft' || phase === 'closed') return null;
    const idx = PHASE_STEPS.indexOf(phase);
    return (
        <div className="contest-progress">
            {PHASE_STEPS.map((step, i) => (
                <span key={step} style={{ display: 'contents' }}>
                    {i > 0 && <span className="contest-progress-sep" />}
                    <span className={`contest-progress-step ${i < idx ? 'is-done' : ''} ${i === idx ? 'is-current' : ''}`}>{phaseLabel(step)}</span>
                </span>
            ))}
        </div>
    );
}

function ContestCard({ contest: c }: { contest: Contest }) {
    const phase = effectivePhase(c);
    const open = contests.expanded.has(c.id);
    const maxSubs = c.max_submissions_per_user || 1;
    const mine = state.user ? (c.submissions || []).filter(s => s.user_id === state.user!.id) : [];
    const canSubmit = !!state.user && phase === 'submission' && mine.length < maxSubs;
    const votingOpen = phase === 'voting' && votingWindowOpen(c);
    const canVote = !!state.user && votingOpen && c.submissions?.some(s => s.user_id !== state.user!.id);
    const beforeVoting = phase === 'voting' && !!c.voting_start && !votingOpen && Date.now() < new Date(c.voting_start).getTime();
    const count = c.submissions?.length || 0;
    return (
        <div className="contest-card">
            <div className="contest-card-top">
                <div><h4>{c.title}</h4><div className="contest-description">{c.description || ''}</div></div>
                <span className={`contest-phase contest-phase-${phase}`}>{phaseLabel(phase)}</span>
            </div>
            <PhaseProgress phase={phase} />
            <div className="contest-meta">
                <span><Icon name="images" /> {count} submission{count === 1 ? '' : 's'}</span>
                <span><Icon name="send" /> Submit by {fmtDate(c.submission_deadline)}{phase === 'submission' && c.submission_deadline && <em> ({relTime(c.submission_deadline)})</em>}</span>
                <span><Icon name="star" /> Vote {fmtDate(c.voting_start)} → {fmtDate(c.voting_deadline)}
                    {beforeVoting ? <em> (opens {relTime(c.voting_start)})</em> : phase === 'voting' && c.voting_deadline ? <em> ({relTime(c.voting_deadline)})</em> : null}
                </span>
            </div>
            <div className="contest-card-actions">
                {canSubmit && <button className="btn btn-primary btn-sm" type="button" onClick={() => openContestMonPicker(c.id)}><Icon name="send" /> {mine.length ? 'Submit another' : 'Join & Submit'}</button>}
                {!state.user && phase === 'submission' && <button className="btn btn-primary btn-sm" type="button" onClick={openContestSignIn}><Icon name="log-in" /> Sign in to join</button>}
                {mine.length > 0 && <span className="contest-phase"><Icon name="check" /> {mine.length}{maxSubs > 1 ? `/${maxSubs}` : ''} entered</span>}
                {canVote && <button className="btn btn-primary btn-sm" type="button" onClick={() => startContestVoting(c.id)}><Icon name="star" /> Vote in this contest</button>}
                {!state.user && votingOpen && count > 0 && <button className="btn btn-primary btn-sm" type="button" onClick={openContestSignIn}><Icon name="log-in" /> Sign in to vote</button>}
                {phase === 'results' && <button className="btn btn-secondary btn-sm" type="button" onClick={() => showContestResults(c.id)}><Icon name="trophy" /> Results</button>}
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => toggleContestDetails(c.id)}>
                    <Icon name={open ? 'chevron-up' : 'chevron-down'} /> {open ? 'Hide details' : 'View details'}
                </button>
            </div>
            {open && <ContestDetails contest={c} phase={phase} />}
        </div>
    );
}

function Rules({ contest: c }: { contest: Contest }) {
    if (!c.rules) return null;
    return <div className="contest-rules"><h5><Icon name="scroll-text" /> Rules</h5><p>{c.rules}</p></div>;
}

function Thumb({ data, className }: { data: any; className: string }) {
    const img = submissionImage(data);
    return <div className={className}>{img ? <img src={img} alt={data?.name || ''} /> : <Icon name="image" />}</div>;
}

function ContestDetails({ contest: c, phase }: { contest: Contest; phase: Phase }) {
    if (phase === 'submission') {
        const maxSubs = c.max_submissions_per_user || 1;
        const mine = state.user ? (c.submissions || []).filter(s => s.user_id === state.user!.id) : [];
        return (
            <div className="contest-submit-panel">
                <Rules contest={c} />
                {mine.length > 0 && (
                    <div className="contest-my-entries">
                        <h5>Your entries</h5>
                        {mine.map(s => (
                            <div className="contest-my-entry" key={s.id}>
                                <Thumb data={s.fakemon_data} className="contest-my-entry-thumb" />
                                <span>{s.fakemon_data?.name || 'Unnamed Fakemon'}</span>
                                <button className="btn btn-secondary btn-sm" type="button" onClick={() => withdrawContestEntry(s.id)}><Icon name="x" /> Withdraw</button>
                            </div>
                        ))}
                    </div>
                )}
                {mine.length >= maxSubs
                    ? <p className="contest-description">You've used all {maxSubs} of your entries for this contest. Withdraw one above to submit something different.</p>
                    : <>
                        {maxSubs > 1 && <p className="contest-description">{mine.length}/{maxSubs} entries used.</p>}
                        <div className="contest-panel-actions">
                            <button className="btn btn-primary btn-sm" type="button" onClick={() => openContestMonPicker(c.id)}><Icon name="images" /> Choose a Fakemon to Submit</button>
                        </div>
                    </>}
            </div>
        );
    }
    if (phase === 'voting') {
        const open = votingWindowOpen(c);
        const status = open
            ? `${c.submissions?.length || 0} Fakemon entered · voting closes ${fmtDate(c.voting_deadline)}. Vote on every eligible entry - your voting order is randomized for this session.`
            : (c.voting_start && Date.now() < new Date(c.voting_start).getTime()
                ? `Voting hasn't started yet - it opens ${fmtDate(c.voting_start)} (${relTime(c.voting_start)}).`
                : 'Voting has closed.');
        return <div className="contest-submit-panel"><Rules contest={c} /><h5>{open ? 'Voting is open' : 'Voting'}</h5><p className="contest-description">{status}</p></div>;
    }
    if (phase === 'results') return <><Rules contest={c} /><Results contest={c} /></>;
    return <Rules contest={c} />;
}

function Results({ contest: c }: { contest: Contest }) {
    useEffect(() => { if (c.results === undefined) loadContestResults(c); }, [c]);
    const header = <h5><Icon name="trophy" /> Final Results</h5>;
    const wrap = (body: ReactNode) => <div className="contest-submit-panel contest-results-panel">{header}{body}</div>;
    if (c.results === undefined || c.results === 'loading') return wrap(<div className="community-loading">Loading results…</div>);
    if (c.results === 'error') {
        return wrap(<div className="community-empty">Could not load results. <button className="btn btn-secondary btn-sm" type="button" onClick={() => loadContestResults(c)}>Retry</button></div>);
    }
    const rows = c.results;
    if (!rows.length) return wrap(<div className="community-empty">No votes were cast in this contest.</div>);
    const totalVoters = c.totalVoters || 0;
    const maxPossible = totalVoters * 20;
    const winners = computeWinners(rows, c.winner_criteria, totalVoters);
    return wrap(
        <>
            <p className="contest-results-criteria">Winners: {describeWinnerCriteria(c.winner_criteria)} · {totalVoters} voter{totalVoters === 1 ? '' : 's'} total</p>
            <div className="contest-results-list">
                {rows.map((r, i) => {
                    const sub = (c.submissions || []).find(s => s.id === r.submission_id);
                    const d = sub?.fakemon_data || {};
                    const won = winners.has(r.submission_id);
                    const points = Math.round((Number(r.avg_competitive) + Number(r.avg_design)) * Number(r.vote_count));
                    return (
                        <div className={`contest-result-row ${won ? 'contest-result-winner' : ''}`} key={r.submission_id}>
                            <div className="contest-result-rank">{won ? <Icon name="trophy" /> : `#${i + 1}`}</div>
                            <Thumb data={d} className="contest-result-avatar" />
                            <div className="contest-result-info">
                                <strong>{d.name || 'Unnamed Fakemon'}{won && <> <span className="contest-result-winner-chip">Winner</span></>}</strong>
                                <span>{r.vote_count} vote{Number(r.vote_count) === 1 ? '' : 's'} · {points}/{maxPossible} pts ({Math.round(submissionPointsPercent(r, totalVoters))}%)</span>
                            </div>
                            <div className="contest-result-scores">
                                <span>Competitive <b>{r.avg_competitive}</b></span>
                                <span>Design <b>{r.avg_design}</b></span>
                                <span className="contest-result-total">Total <b>{(Number(r.avg_competitive) + Number(r.avg_design)).toFixed(2)}</b></span>
                            </div>
                        </div>
                    );
                })}
            </div>
        </>
    );
}

function Stars({ kind, value }: { kind: 'competitive' | 'design'; value: number }) {
    return (
        <div className="contest-stars">
            {Array.from({ length: 10 }, (_, i) => (
                <button key={i} type="button" className={`contest-star ${i < value ? 'active' : ''}`} onClick={() => setContestVoteScore(kind, i + 1)} aria-label={`${i + 1} out of 10`}>
                    <Icon name="star" />
                </button>
            ))}
        </div>
    );
}

function VotingView() {
    const v = contests.voting!;
    const contest = findContest(v.contestId);
    if (!contest) return null;
    const eligible = eligibleEntries(contest);
    const current = eligible.find(s => s.id === v.order[v.index]);
    const done = v.order.filter(id => voteComplete(v, id)).length;
    const allDone = done === v.order.length;
    const d = current?.fakemon_data || {};
    const comp = current ? v.scores[`${current.id}:competitive`] || 0 : 0;
    const design = current ? v.scores[`${current.id}:design`] || 0 : 0;
    return (
        <div className="contest-voting-view" style={{ display: 'block' }}>
            <div className="events-hero">
                <div>
                    <div className="events-kicker">Voting</div>
                    <h2>{contest.title}</h2>
                    <p>{done} of {v.order.length} entries completed. Finish every entry, then submit your ballot.</p>
                </div>
                <button className="btn btn-secondary btn-sm" type="button" onClick={closeContestVoting}>Back to events</button>
            </div>
            <div className="contest-voting-layout">
                <aside className="contest-vote-queue panel">
                    <h4>Entries</h4>
                    {v.order.map((id, i) => {
                        const s = eligible.find(x => x.id === id);
                        return (
                            <button key={id} type="button" className={`contest-vote-queue-item ${voteComplete(v, id) ? 'is-done' : ''} ${i === v.index ? 'is-current' : ''}`} onClick={() => jumpContestVote(i)}>
                                <span>{i + 1}</span><strong>{s?.fakemon_data?.name || 'Unnamed'}</strong>{voteComplete(v, id) && <Icon name="check" />}
                            </button>
                        );
                    })}
                </aside>
                <main>
                    {current ? (
                        <div className="contest-vote-current-card">
                            <div className="contest-vote-mon-preview">
                                {submissionImage(d)
                                    ? <img src={submissionImage(d)} alt={d.name || 'Fakemon'} />
                                    : <div className="contest-vote-mon-placeholder"><Icon name="image" /></div>}
                                <div>
                                    <div className="events-kicker">ENTRY {v.index + 1} OF {v.order.length}</div>
                                    <h3>{d.name || 'Unnamed Fakemon'}</h3>
                                    <p>{d.description || ''}</p>
                                </div>
                            </div>
                            <div className="contest-rating-grid">
                                <div className="contest-rating-box"><div className="contest-rating-label">Competitive Score</div><Stars kind="competitive" value={comp} /><strong>{comp || '-'} / 10</strong></div>
                                <div className="contest-rating-box"><div className="contest-rating-label">Design Score</div><Stars kind="design" value={design} /><strong>{design || '-'} / 10</strong></div>
                            </div>
                            <textarea className="contest-remarks" placeholder="Remarks (optional)" value={v.remarks[current.id] || ''} onChange={e => setContestVoteRemarks(e.target.value)} />
                            <div className="contest-vote-navigation">
                                <button className="btn btn-secondary btn-sm" type="button" onClick={() => jumpContestVote(Math.max(0, v.index - 1))} disabled={v.index === 0}>Previous</button>
                                <button className="btn btn-primary" type="button" onClick={saveAndNextContestVote}>{v.index === v.order.length - 1 ? 'Finish this entry' : 'Save & Next'}</button>
                            </div>
                        </div>
                    ) : <div className="community-empty">No entry selected.</div>}
                    <div className="contest-final-submit panel">
                        <div>
                            <strong>{allDone ? 'All entries rated!' : 'Keep going'}</strong>
                            <p>{allDone ? 'Your ratings are ready to be submitted to the contest.' : 'Each entry needs both scores before you can submit.'}</p>
                        </div>
                        <button className="btn btn-primary" type="button" onClick={submitContestBallot} disabled={!allDone}><Icon name="send" /> Submit all votes</button>
                    </div>
                </main>
            </div>
        </div>
    );
}

// ==================== which Fakémon to enter ====================

function ContestPickerDialog({ close, contestId }: DialogProps<{ contestId: string }>) {
    const [query, setQuery] = useState('');
    const c = findContest(contestId);
    if (!c) return null;
    const entered = new Set((c.submissions || []).filter(s => s.user_id === state.user?.id).map(s => s.source_fakemon_id));
    const q = query.trim().toLowerCase();
    const options = (state.fakemonDB || [])
        .filter(m => !m.pendingVanilla && !entered.has(String(m.id)))
        .filter(m => !q || (m.name || '').toLowerCase().includes(q) || (m.type1 || '').toLowerCase().includes(q) || (m.type2 || '').toLowerCase().includes(q));
    return (
        <Modal onClose={close} className="contest-mon-picker-modal-box" title={`Choose a Fakemon - ${c.title}`}>
            <div className="search-bar">
                <input type="text" placeholder="Search your Fakemon..." value={query} onChange={e => setQuery(e.target.value)} autoFocus />
            </div>
            {options.length ? (
                <div className="collection-grid contest-mon-picker-grid" style={{ display: 'grid' }}>
                    {options.map(m => (
                        <div className="collection-card" key={m.id} onClick={() => { close(); submitContestEntry(contestId, m); }}>
                            <div className="card-art">
                                {m.artwork ? <img src={m.artwork} alt={m.name} draggable={false} /> : <img className="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork" draggable={false} />}
                            </div>
                            <div className="card-number">{m.number || '#???'}</div>
                            <div className="card-name">{m.name || 'Unnamed'}</div>
                            <div className="card-types">
                                {m.type1 && <span className={`type-badge type-${m.type1.toLowerCase()}`}>{m.type1}</span>}
                                {m.type2 && <span className={`type-badge type-${m.type2.toLowerCase()}`}>{m.type2}</span>}
                            </div>
                        </div>
                    ))}
                </div>
            ) : <div className="community-empty">No Fakemon match your search.</div>}
        </Modal>
    );
}

registerDialog('contest-picker', ContestPickerDialog);
