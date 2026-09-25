// Events & contests: create events, add contests, control the current phase,
// set deadlines, and inspect submissions and who has voted.

import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../app/components/Icon.tsx';
import { Modal } from '../app/components/Modal.tsx';
import { openDialog, registerDialog, type DialogProps } from '../app/dialogs.tsx';
import { useStore } from '../app/store.ts';
import { admin, ask, fmtDate, getClient, reload, reloads, showToast } from './core.ts';
import { ListState } from './ui.tsx';

interface EventRow { id: string; title: string; description?: string; starts_at?: string; ends_at?: string; }
interface Contest {
    id: string; event_id: string; title: string; description?: string; rules?: string; phase: string;
    submission_deadline?: string; voting_start?: string; voting_deadline?: string; results_at?: string;
    max_submissions_per_user?: number; winner_criteria?: { top_n?: number; top_percent?: number; min_score_percent?: number };
}

const data = { events: [] as EventRow[], contests: [] as Contest[] };

const toInputDate = (v?: string | null) => (v ? new Date(v).toISOString().slice(0, 16) : '');
const fromInputDate = (v: string) => (v ? new Date(v).toISOString() : null);

function describeWinnerCriteria(wc: Contest['winner_criteria'] = {}) {
    const parts: string[] = [];
    if (wc.top_n) parts.push(`top ${wc.top_n}`);
    if (wc.top_percent) parts.push(`top ${wc.top_percent}%`);
    if (wc.min_score_percent) parts.push(`≥${wc.min_score_percent}% score`);
    return parts.length ? parts.join(' or ') : 'top 3 (default)';
}

export function EventsTab() {
    useStore();
    const [state, setState] = useState({ loading: true, error: '' });

    async function load() {
        const client = await getClient();
        const [{ data: events, error: e1 }, { data: contests, error: e2 }] = await Promise.all([
            client.from('contest_events').select('*').order('starts_at', { ascending: false }),
            client.from('contests').select('*').order('created_at', { ascending: false })
        ]);
        if (e1 || e2) { setState({ loading: false, error: (e1 || e2)!.message }); return; }
        data.events = events || [];
        data.contests = contests || [];
        setState({ loading: false, error: '' });
    }
    useEffect(() => { load(); }, [reloads.contests]);

    async function deleteEvent(e: EventRow) {
        if (!await ask({ title: 'Delete event', blurb: <>Delete <strong>{e.title}</strong> and every contest inside it, along with their submissions and votes.</>, confirm: 'Delete event', requireReason: false, danger: true })) return;
        const client = await getClient();
        for (const c of data.contests.filter(c => c.event_id === e.id)) {
            if (!await deleteContestRows(c.id)) return;
        }
        const { error } = await client.from('contest_events').delete().eq('id', e.id);
        if (error) { showToast(error.message, 'error'); return; }
        showToast('Event deleted', 'success');
        reload('contests');
    }

    async function deleteContest(c: Contest) {
        if (!await ask({ title: 'Delete contest', blurb: <>Delete <strong>{c.title}</strong> and every submission and vote in it.</>, confirm: 'Delete contest', requireReason: false, danger: true })) return;
        if (!await deleteContestRows(c.id)) return;
        showToast('Contest deleted', 'success');
        reload('contests');
    }

    return (
        <>
            <div className="admin-section-head">
                <h3>Events &amp; contests</h3>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => openDialog('admin-event', { event: null })}><Icon name="plus" /> Event</button>
            </div>
            <p className="admin-section-sub">Create events, add contests, control the current phase, set deadlines, and inspect who has voted.</p>
            <div>
                {state.loading || state.error || !data.events.length ? <ListState loading={state.loading} error={state.error} empty="No events yet." /> : data.events.map(e => {
                    const contests = data.contests.filter(c => c.event_id === e.id);
                    return (
                        <div className="admin-contest-event" key={e.id}>
                            <div className="admin-section-head">
                                <div>
                                    <strong>{e.title}</strong>
                                    <div className="admin-section-sub">{e.description || ''} · {fmtDate(e.starts_at)} → {fmtDate(e.ends_at)}</div>
                                </div>
                                <div style={{ display: 'flex', gap: 6 }}>
                                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => openDialog('admin-event', { event: e })}>Edit</button>
                                    <button className="btn btn-primary btn-sm" type="button" onClick={() => openDialog('admin-contest', { contest: null, eventId: e.id })}>Add contest</button>
                                    <button className="btn btn-danger btn-sm" type="button" onClick={() => deleteEvent(e)}>Delete event</button>
                                </div>
                            </div>
                            <div>
                                {!contests.length ? <div className="admin-empty">No contests yet.</div> : contests.map(c => {
                                    const maxSubs = c.max_submissions_per_user || 1;
                                    return (
                                        <div className="admin-contest-row" key={c.id}>
                                            <div>
                                                <strong>{c.title}</strong>
                                                <div className="admin-section-sub">Phase: {c.phase} · submissions {fmtDate(c.submission_deadline)} · voting {fmtDate(c.voting_start)} → {fmtDate(c.voting_deadline)}</div>
                                                <div className="admin-section-sub">Max {maxSubs} submission{maxSubs === 1 ? '' : 's'} per user · Winners: {describeWinnerCriteria(c.winner_criteria)}</div>
                                            </div>
                                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                                <button className="btn btn-secondary btn-sm" type="button" onClick={() => openDialog('admin-contest', { contest: c, eventId: c.event_id })}>Edit</button>
                                                <button className="btn btn-secondary btn-sm" type="button" onClick={() => openDialog('admin-submissions', { contest: c })}>View submissions</button>
                                                <button className="btn btn-secondary btn-sm" type="button" onClick={() => openDialog('admin-voters', { contest: c })}>View voters</button>
                                                <button className="btn btn-danger btn-sm" type="button" onClick={() => deleteContest(c)}>Delete contest</button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
        </>
    );
}

/** A contest's votes, entries and row, in that order (each refers to the one after). */
async function deleteContestRows(id: string): Promise<boolean> {
    const client = await getClient();
    for (const table of ['contest_votes', 'contest_submissions']) {
        const { error } = await client.from(table).delete().eq('contest_id', id);
        if (error) { showToast(error.message, 'error'); return false; }
    }
    const { error } = await client.from('contests').delete().eq('id', id);
    if (error) { showToast(error.message, 'error'); return false; }
    return true;
}

// ---- event editor ----
function EventDialog({ close, event: e }: DialogProps<{ event: EventRow | null }>) {
    const [f, setF] = useState({ title: e?.title || '', description: e?.description || '', starts: toInputDate(e?.starts_at), ends: toInputDate(e?.ends_at) });
    const set = (patch: Partial<typeof f>) => setF(v => ({ ...v, ...patch }));
    async function submit(ev: FormEvent) {
        ev.preventDefault();
        const client = await getClient();
        const payload = { title: f.title.trim(), description: f.description.trim(), starts_at: fromInputDate(f.starts), ends_at: fromInputDate(f.ends), created_by: admin.me!.id };
        const { error } = e ? await client.from('contest_events').update(payload).eq('id', e.id) : await client.from('contest_events').insert(payload);
        if (error) { showToast(error.message, 'error'); return; }
        close();
        reload('contests');
        showToast('Event saved', 'success');
    }
    return (
        <Modal onClose={close} title={e ? 'Edit Event' : 'Create Event'} labelledBy="admin-event-title">
            <form onSubmit={submit}>
                <div className="form-group"><label htmlFor="admin-event-title-input">Title</label><input id="admin-event-title-input" required value={f.title} onChange={x => set({ title: x.target.value })} /></div>
                <div className="form-group"><label htmlFor="admin-event-description">Description</label><textarea id="admin-event-description" rows={3} value={f.description} onChange={x => set({ description: x.target.value })} /></div>
                <div className="admin-modal-row">
                    <div className="form-group"><label htmlFor="admin-event-starts">Starts</label><input id="admin-event-starts" type="datetime-local" value={f.starts} onChange={x => set({ starts: x.target.value })} /></div>
                    <div className="form-group"><label htmlFor="admin-event-ends">Ends</label><input id="admin-event-ends" type="datetime-local" value={f.ends} onChange={x => set({ ends: x.target.value })} /></div>
                </div>
                <div className="admin-modal-actions"><button type="button" className="btn btn-secondary" onClick={close}>Cancel</button><button type="submit" className="btn btn-primary">Save event</button></div>
            </form>
        </Modal>
    );
}
registerDialog('admin-event', EventDialog);

// ---- contest editor ----
const PHASES = ['draft', 'submission', 'voting', 'results', 'closed'];

function ContestDialog({ close, contest: c, eventId }: DialogProps<{ contest: Contest | null; eventId: string }>) {
    const wc = c?.winner_criteria || { top_n: 3 };
    const [f, setF] = useState({
        eventId: c?.event_id || eventId || '', title: c?.title || '', description: c?.description || '', rules: c?.rules || '',
        submissionDeadline: toInputDate(c?.submission_deadline), votingStart: toInputDate(c?.voting_start),
        votingDeadline: toInputDate(c?.voting_deadline), resultsAt: toInputDate(c?.results_at),
        phase: c?.phase || 'draft', maxSubs: String(c?.max_submissions_per_user || 1),
        topn: wc.top_n != null ? String(wc.top_n) : null as string | null,
        toppct: wc.top_percent != null ? String(wc.top_percent) : null as string | null,
        minscore: wc.min_score_percent != null ? String(wc.min_score_percent) : null as string | null
    });
    const set = (patch: Partial<typeof f>) => setF(v => ({ ...v, ...patch }));

    async function submit(ev: FormEvent) {
        ev.preventDefault();
        const winner_criteria: Record<string, number> = {};
        if (f.topn) winner_criteria.top_n = parseInt(f.topn, 10);
        if (f.toppct) winner_criteria.top_percent = parseInt(f.toppct, 10);
        if (f.minscore) winner_criteria.min_score_percent = parseInt(f.minscore, 10);
        if (!Object.keys(winner_criteria).length) winner_criteria.top_n = 3;
        const payload = {
            event_id: f.eventId, title: f.title.trim(), description: f.description.trim(), rules: f.rules.trim(), created_by: admin.me!.id,
            submission_deadline: fromInputDate(f.submissionDeadline), voting_start: fromInputDate(f.votingStart),
            voting_deadline: fromInputDate(f.votingDeadline), results_at: fromInputDate(f.resultsAt), phase: f.phase,
            max_submissions_per_user: Math.max(1, parseInt(f.maxSubs, 10) || 1), winner_criteria
        };
        const client = await getClient();
        const { error } = c ? await client.from('contests').update(payload).eq('id', c.id) : await client.from('contests').insert(payload);
        if (error) { showToast(error.message, 'error'); return; }
        close();
        reload('contests');
        showToast('Contest saved', 'success');
    }

    async function forcePhase() {
        if (!c) { showToast('Save the contest once first, then you can force its phase.', 'warning'); return; }
        if (!await ask({ title: 'Force phase', blurb: <>Move this contest straight to <strong>{f.phase}</strong>, overriding normal automatic progression. Takes effect immediately.</>, confirm: 'Force phase', requireReason: false })) return;
        const client = await getClient();
        const { error } = await client.from('contests').update({ phase: f.phase }).eq('id', c.id);
        if (error) { showToast(error.message, 'error'); return; }
        showToast(`Phase forced to ${f.phase}`, 'success');
        reload('contests');
    }

    // one winner rule: a tick that enables its number
    const criterion = (k: 'topn' | 'toppct' | 'minscore', before: string, after: string, max?: number) => (
        <label className="admin-checkbox-row">
            <input type="checkbox" checked={f[k] !== null} onChange={e => set({ [k]: e.target.checked ? '' : null })} /> {before}{' '}
            <input type="number" min={1} max={max} step={1} className="admin-wc-num" disabled={f[k] === null} value={f[k] ?? ''} onChange={e => set({ [k]: e.target.value })} /> {after}
        </label>
    );

    const date = (k: 'submissionDeadline' | 'votingStart' | 'votingDeadline' | 'resultsAt', label: string) => (
        <div className="form-group"><label htmlFor={`admin-contest-${k}`}>{label}</label><input id={`admin-contest-${k}`} type="datetime-local" value={f[k]} onChange={e => set({ [k]: e.target.value })} /></div>
    );

    return (
        <Modal onClose={close} title={c ? 'Edit Contest' : 'Create Contest'} className="modal-wide" labelledBy="admin-contest-title">
            <form onSubmit={submit}>
                <div className="form-group">
                    <label htmlFor="admin-contest-event">Event</label>
                    <select id="admin-contest-event" required value={f.eventId} onChange={e => set({ eventId: e.target.value })}>
                        {data.events.map(e => <option key={e.id} value={e.id}>{e.title}</option>)}
                    </select>
                </div>
                <div className="form-group"><label htmlFor="admin-contest-title-input">Contest title</label><input id="admin-contest-title-input" required value={f.title} onChange={e => set({ title: e.target.value })} /></div>
                <div className="form-group"><label htmlFor="admin-contest-description">Description</label><textarea id="admin-contest-description" rows={3} value={f.description} onChange={e => set({ description: e.target.value })} /></div>
                <div className="form-group"><label htmlFor="admin-contest-rules">Rules</label><textarea id="admin-contest-rules" rows={4} placeholder="E.g. one entry must be an original design, no reused sprites, keep it SFW" value={f.rules} onChange={e => set({ rules: e.target.value })} /></div>
                <div className="admin-modal-row">{date('submissionDeadline', 'Submission deadline')}{date('votingStart', 'Voting starts')}</div>
                <div className="admin-modal-row">{date('votingDeadline', 'Voting deadline')}{date('resultsAt', 'Results time')}</div>
                <div className="admin-modal-row">
                    <div className="form-group">
                        <label htmlFor="admin-contest-phase">Phase</label>
                        <div className="admin-phase-row">
                            <select id="admin-contest-phase" value={f.phase} onChange={e => set({ phase: e.target.value })}>
                                {PHASES.map(p => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
                            </select>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={forcePhase} title="Immediately set the contest to this phase">Force</button>
                        </div>
                    </div>
                    <div className="form-group"><label htmlFor="admin-contest-max-subs">Max submissions per user</label><input id="admin-contest-max-subs" type="number" min={1} step={1} value={f.maxSubs} onChange={e => set({ maxSubs: e.target.value })} /></div>
                </div>
                <div className="form-group">
                    <label>Winner criteria</label>
                    <div className="admin-winner-criteria">
                        {criterion('topn', 'Top', 'submissions')}
                        {criterion('toppct', 'Top', '% of submissions', 100)}
                        {criterion('minscore', 'Any submission scoring at least', '% of possible points', 100)}
                    </div>
                    <p className="admin-section-sub" style={{ margin: '6px 0 0' }}>A submission wins if it meets any checked criterion. Leave everything unchecked to default to top 3. The percentage is that entry's competitive+design points across every voter, out of (voter count &times; 20).</p>
                </div>
                <div className="admin-modal-actions"><button type="button" className="btn btn-secondary" onClick={close}>Cancel</button><button type="submit" className="btn btn-primary">Save contest</button></div>
            </form>
        </Modal>
    );
}
registerDialog('admin-contest', ContestDialog);

// ---- voters ----
interface Voter { voter_id: string; submitted_at: string; profile: { username?: string; display_name?: string } | null; responses: any[]; }

function VotersDialog({ close, contest }: DialogProps<{ contest: Contest }>) {
    const [state, setState] = useState<{ loading: boolean; error: string; voters: Voter[] }>({ loading: true, error: '', voters: [] });
    const [open, setOpen] = useState<number | null>(null);
    useEffect(() => {
        (async () => {
            try {
                const client = await getClient();
                const { data: sessions, error: se } = await client.from('contest_vote_sessions').select('id,voter_id,submitted_at').eq('contest_id', contest.id).order('submitted_at', { ascending: false });
                if (se) throw se;
                const ids = (sessions || []).map((x: any) => x.voter_id);
                const { data: profiles, error: pe } = ids.length ? await client.from('profiles').select('id,username,display_name').in('id', ids) : { data: [], error: null };
                if (pe) throw pe;
                const pm = Object.fromEntries((profiles || []).map((p: any) => [p.id, p]));
                const { data: votes, error: ve } = ids.length
                    ? await client.from('contest_votes').select('id,voter_id,submission_id,competitive_score,design_score,remarks,created_at').eq('contest_id', contest.id).order('created_at', { ascending: true })
                    : { data: [], error: null };
                if (ve) throw ve;
                const vm: Record<string, any[]> = {};
                (votes || []).forEach((v: any) => (vm[v.voter_id] ??= []).push(v));
                setState({ loading: false, error: '', voters: (sessions || []).map((s: any) => ({ voter_id: s.voter_id, submitted_at: s.submitted_at, profile: pm[s.voter_id] || null, responses: vm[s.voter_id] || [] })) });
            } catch (e: any) {
                setState({ loading: false, error: e.message || String(e), voters: [] });
            }
        })();
    }, [contest.id]);

    function exportJson() {
        const payload = {
            contest_id: contest.id, contest_title: contest.title, exported_at: new Date().toISOString(),
            voters: state.voters.map(v => ({
                voter_id: v.voter_id, username: v.profile?.username || null, display_name: v.profile?.display_name || null, submitted_at: v.submitted_at,
                responses: v.responses.map(r => ({ submission_id: r.submission_id, competitive_score: r.competitive_score, design_score: r.design_score, remarks: r.remarks || '', created_at: r.created_at }))
            }))
        };
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
        a.download = `contest-${contest.id}-voters.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    const name = (v: Voter) => v.profile?.display_name || v.profile?.username || v.voter_id;
    const voter = open !== null ? state.voters[open] : null;
    return (
        <Modal onClose={close} title={`Voters - ${contest.title}`} className="modal-wide admin-voters-modal" labelledBy="admin-voters-title">
            <div className="admin-voters-toolbar">
                <span>{state.loading ? 'Loading…' : state.error ? 'Could not load voters' : `${state.voters.length} completed voter${state.voters.length === 1 ? '' : 's'}`}</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={exportJson} disabled={state.loading}>Export JSON</button>
            </div>
            <div className="admin-voters-modal-list">
                {state.loading || state.error || !state.voters.length ? <ListState loading={state.loading} error={state.error} empty="No completed ballots yet." />
                    : voter ? (
                        <>
                            <div className="admin-voter-detail-head">
                                <button className="btn btn-secondary btn-sm" type="button" onClick={() => setOpen(null)}><Icon name="arrow-left" /> Back</button>
                                <div><strong>{name(voter)}</strong><small>@{voter.profile?.username || 'unknown'} · {fmtDate(voter.submitted_at)}</small></div>
                            </div>
                            <div className="admin-response-list">
                                {voter.responses.map((r, i) => (
                                    <div className="admin-response-row" key={r.id || i}>
                                        <div><strong>Response {i + 1}</strong><small>{r.submission_id}</small></div>
                                        <div className="admin-response-scores"><span>Competitive <b>{r.competitive_score}/10</b></span><span>Design <b>{r.design_score}/10</b></span></div>
                                        <p>{r.remarks || 'No remarks'}</p>
                                    </div>
                                ))}
                            </div>
                        </>
                    ) : state.voters.map((v, i) => (
                        <button type="button" className="admin-voter-card" key={v.voter_id} onClick={() => setOpen(i)}>
                            <span className="admin-voter-avatar">{String(v.profile?.display_name || v.profile?.username || '?').slice(0, 1).toUpperCase()}</span>
                            <span><strong>{name(v)}</strong><small>@{v.profile?.username || 'unknown'} · submitted {fmtDate(v.submitted_at)}</small></span>
                            <Icon name="chevron-right" />
                        </button>
                    ))}
            </div>
        </Modal>
    );
}
registerDialog('admin-voters', VotersDialog);

// ---- submissions ----
const submissionImage = (d: any) => d?.artwork || d?.image || d?.sprite || '';

function SubmissionsDialog({ close, contest }: DialogProps<{ contest: Contest }>) {
    const [state, setState] = useState<{ loading: boolean; error: string; subs: any[] }>({ loading: true, error: '', subs: [] });
    useEffect(() => {
        (async () => {
            try {
                const client = await getClient();
                const { data: subs, error: se } = await client.from('contest_submissions').select('id,user_id,fakemon_data,submitted_at').eq('contest_id', contest.id).order('submitted_at', { ascending: false });
                if (se) throw se;
                const ids = [...new Set((subs || []).map((s: any) => s.user_id))];
                const { data: profiles, error: pe } = ids.length ? await client.from('profiles').select('id,username,display_name').in('id', ids) : { data: [], error: null };
                if (pe) throw pe;
                const pm = Object.fromEntries((profiles || []).map((p: any) => [p.id, p]));
                setState({ loading: false, error: '', subs: (subs || []).map((s: any) => ({ ...s, profile: pm[s.user_id] || null })) });
            } catch (e: any) {
                setState({ loading: false, error: e.message || String(e), subs: [] });
            }
        })();
    }, [contest.id]);

    async function remove(id: string) {
        const answer = await ask({ title: 'Remove submission', blurb: 'Removes this entry from the contest, along with any votes cast on it. The entrant is notified with your reason.', confirm: 'Remove entry' });
        if (!answer) return;
        const client = await getClient();
        const { error } = await client.rpc('admin_delete_contest_submission', { p_submission_id: id, p_reason: answer.reason });
        if (error) { showToast(error.message, 'error'); return; }
        setState(s => ({ ...s, subs: s.subs.filter(x => x.id !== id) }));
        showToast('Submission removed', 'success');
    }

    return (
        <Modal onClose={close} title={`Submissions - ${contest.title}`} className="modal-wide admin-voters-modal" labelledBy="admin-submissions-title">
            <div className="admin-voters-toolbar">
                <span>{state.loading ? 'Loading…' : state.error ? 'Could not load submissions' : `${state.subs.length} submission${state.subs.length === 1 ? '' : 's'}`}</span>
            </div>
            <div className="admin-voters-modal-list">
                {state.loading || state.error || !state.subs.length ? <ListState loading={state.loading} error={state.error} empty="No submissions yet." /> : state.subs.map(s => {
                    const d = s.fakemon_data || {};
                    const img = submissionImage(d);
                    return (
                        <div className="admin-submission-row" key={s.id}>
                            <div className="admin-submission-thumb">{img ? <img src={img} alt="" /> : <Icon name="image" />}</div>
                            <div className="admin-submission-info">
                                <strong>{d.name || 'Unnamed Fakemon'}</strong>
                                <small>by {s.profile?.display_name || s.profile?.username || s.user_id}{s.profile?.username ? ` (@${s.profile.username})` : ''} · {fmtDate(s.submitted_at)}</small>
                            </div>
                            <button className="btn btn-danger btn-sm" type="button" onClick={() => remove(s.id)} aria-label="Remove entry"><Icon name="trash-2" /></button>
                        </div>
                    );
                })}
            </div>
        </Modal>
    );
}
registerDialog('admin-submissions', SubmissionsDialog);
