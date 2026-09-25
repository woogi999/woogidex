// Feedback & bug reports. Reads public.feedback (RLS lets holders of
// manage_feedback see every row) and writes back only the status and the
// reply; the feedback_guard trigger stamps who handled it and refuses to let
// an update touch what the user wrote. The reporter reads status and reply in
// "My reports" on the site (js/app/dialogs/feedback.tsx).

import { useEffect, useState } from 'react';
import { Icon } from '../app/components/Icon.tsx';
import { useStore } from '../app/store.ts';
import { publicName } from '../core/html.ts';
import { admin, ask, getClient, notify, showToast } from './core.ts';
import { ListState } from './ui.tsx';

export const STATUSES: Array<[string, string]> = [
    ['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['wont_fix', "Won't fix"], ['duplicate', 'Duplicate']
];
const STATUS_LABEL = Object.fromEntries(STATUSES);
const KIND: Record<string, { label: string; icon: string }> = {
    bug: { label: 'Bug', icon: 'bug' },
    feedback: { label: 'Feedback', icon: 'message-square' },
    idea: { label: 'Idea', icon: 'lightbulb' }
};

interface Report {
    id: string; user_id: string; kind: string; title: string; body: string; status: string; staff_note?: string | null;
    page?: string; user_agent?: string; handled_by?: string | null; created_at: string;
}

const names: Record<string, { name: string; username: string }> = {};

// the number on the Feedback tab
let openCount = 0;
export function feedbackOpenCount() { return openCount; }
export async function refreshOpenCount() {
    const client = await getClient();
    const { count } = await client.from('feedback').select('id', { count: 'exact', head: true }).eq('status', 'open');
    openCount = count || 0;
    notify();
}

function fmt(iso: string) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function FeedbackTab() {
    useStore();
    const [status, setStatus] = useState('active');
    const [kind, setKind] = useState('');
    const [search, setSearch] = useState('');
    const [state, setState] = useState<{ loading: boolean; error: string; rows: Report[] }>({ loading: true, error: '', rows: [] });

    async function load() {
        setState(s => ({ ...s, loading: true, error: '' }));
        const client = await getClient();
        let query = client.from('feedback').select('*').order('created_at', { ascending: false }).limit(200);
        if (status === 'active') query = query.in('status', ['open', 'in_progress']);
        else if (status) query = query.eq('status', status);
        if (kind) query = query.eq('kind', kind);
        const { data, error } = await query;
        if (error) { setState({ loading: false, error: 'Could not load reports: ' + error.message, rows: [] }); return; }
        const rows: Report[] = data || [];
        const ids = [...new Set(rows.flatMap(r => [r.user_id, r.handled_by]).filter(Boolean) as string[])].filter(id => !names[id]);
        if (ids.length) {
            const { data: profiles } = await client.from('profiles').select('id, username, display_name').in('id', ids);
            (profiles || []).forEach((p: any) => { names[p.id] = { name: publicName(p), username: p.username || '' }; });
        }
        setState({ loading: false, error: '', rows });
        refreshOpenCount();
    }
    useEffect(() => { load(); }, [status, kind]);

    const q = search.trim().toLowerCase();
    const shown = q
        ? state.rows.filter(r => `${r.title} ${r.body} ${names[r.user_id]?.name || ''} ${names[r.user_id]?.username || ''}`.toLowerCase().includes(q))
        : state.rows;

    const replace = (row: Report) => setState(s => ({ ...s, rows: s.rows.map(r => (r.id === row.id ? row : r)) }));
    const drop = (id: string) => setState(s => ({ ...s, rows: s.rows.filter(r => r.id !== id) }));

    return (
        <>
            <div className="admin-section-head">
                <h3>Feedback &amp; bug reports</h3>
                <button type="button" className="btn btn-secondary btn-sm" onClick={load}><Icon name="refresh-cw" /> Reload</button>
            </div>
            <p className="admin-section-sub">What signed-in users sent from the site's Feedback button, newest first. The reporter sees the status and your reply under "My reports", so write the reply for them.</p>
            <div className="admin-search-bar">
                <input type="text" placeholder="Search titles and text" autoComplete="off" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search reports" />
                <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
                    <option value="active">Open &amp; in progress</option>
                    <option value="">Every status</option>
                    {STATUSES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
                <select value={kind} onChange={e => setKind(e.target.value)} aria-label="Kind">
                    <option value="">Every kind</option>
                    <option value="bug">Bug reports</option>
                    <option value="feedback">Feedback</option>
                    <option value="idea">Ideas</option>
                </select>
            </div>
            <div>
                {state.loading || state.error || !shown.length
                    ? <ListState loading={state.loading} error={state.error}
                        empty={state.rows.length ? 'No report matches that search.' : 'Nothing here. Reports people send show up in this list.'} />
                    : shown.map(r => <ReportCard key={r.id} report={r} onSaved={replace} onDeleted={drop} />)}
            </div>
        </>
    );
}

function ReportCard({ report: r, onSaved, onDeleted }: { report: Report; onSaved: (r: Report) => void; onDeleted: (id: string) => void }) {
    const [status, setStatus] = useState(r.status);
    const [note, setNote] = useState(r.staff_note || '');
    const who = names[r.user_id];
    const kind = KIND[r.kind] || KIND.feedback;
    const closed = ['resolved', 'wont_fix', 'duplicate'].includes(r.status);
    const handler = r.handled_by ? names[r.handled_by]?.name : '';

    async function save() {
        const client = await getClient();
        const { data, error } = await client.from('feedback').update({ status, staff_note: note.trim() }).eq('id', r.id).select().maybeSingle();
        if (error) { showToast('Could not save: ' + error.message, 'error'); return; }
        if (data) {
            if (data.handled_by && !names[data.handled_by] && admin.me) names[data.handled_by] = { name: admin.me.name, username: '' };
            onSaved(data);
        }
        showToast('Report updated', 'success');
        refreshOpenCount();
    }

    async function remove() {
        const answer = await ask({
            title: 'Delete report',
            blurb: <>Delete <strong>{r.title || 'this report'}</strong>? The reporter won't see it under My reports any more. Mark it resolved instead to keep the record.</>,
            confirm: 'Delete report', requireReason: false, danger: true
        });
        if (!answer) return;
        const client = await getClient();
        const { error } = await client.from('feedback').delete().eq('id', r.id);
        if (error) { showToast('Could not delete: ' + error.message, 'error'); return; }
        onDeleted(r.id);
        showToast('Report deleted', 'success');
        refreshOpenCount();
    }

    return (
        <article className={`admin-feedback-card${closed ? ' is-closed' : ''}`}>
            <div className="admin-feedback-head">
                <div style={{ minWidth: 0 }}>
                    <div className="admin-feedback-title">{r.title}</div>
                    <div className="admin-feedback-meta">
                        <span className={`admin-feedback-kind ${r.kind}`}><Icon name={kind.icon} />{kind.label}</span>
                        <span className={`admin-feedback-status ${r.status}`}>{STATUS_LABEL[r.status] || r.status}</span>
                        <span>from <strong>{who?.name || 'a deleted account'}</strong>{who?.username ? ` @${who.username}` : ''}</span>
                        <span>{fmt(r.created_at)}</span>
                        {handler && <span>handled by {handler}</span>}
                    </div>
                </div>
            </div>
            <p className="admin-feedback-body">{r.body}</p>
            {(r.page || r.user_agent) && (
                <div className="admin-feedback-context">
                    {r.page && <>Page: <code>{r.page}</code></>}{r.page && r.user_agent ? ' · ' : ''}{r.user_agent}
                </div>
            )}
            <div className="admin-feedback-triage">
                <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
                    {STATUSES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
                <textarea rows={1} maxLength={2000} placeholder="Reply to the reporter (optional)" value={note} onChange={e => setNote(e.target.value)} aria-label="Reply" />
                <div className="admin-feedback-actions">
                    <button type="button" className="btn btn-primary btn-sm" onClick={save}><Icon name="check" /> Save</button>
                    <button type="button" className="btn btn-sm btn-danger-ghost" onClick={remove} title="Delete report" aria-label="Delete report"><Icon name="trash-2" /></button>
                </div>
            </div>
        </article>
    );
}
