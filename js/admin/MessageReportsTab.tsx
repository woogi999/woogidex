// Reported private messages. Messages are end-to-end encrypted, so the
// server can't show them to anyone -- including here. When someone reports a
// message, their browser hands over that message's own key (and the keys of
// the ten before it, for context); admin_message_reports() returns the
// ciphertext and those keys, and this page opens them in your browser. Only
// the reported messages can be read this way, never the rest of the chat.

import { useEffect, useState } from 'react';
import { Icon } from '../app/components/Icon.tsx';
import { useStore } from '../app/store.ts';
import { renderCommentMarkdown } from '../core/data.ts';
import { publicName } from '../core/html.ts';
import { openFile, openMessageWithKey } from '../features/messaging-crypto.ts';
import { getClient, showToast } from './core.ts';
import { ListState } from './ui.tsx';

interface ReportedMessage { id: string; sender_id: string | null; created_at: string; deleted_at: string | null; ciphertext: string; iv: string; attachment_paths: string[]; sender?: any; }
interface MessageReport {
    id: string; status: string; reason: string; staff_note: string; created_at: string; handled_at: string | null;
    conversation_id: string | null; disclosed_keys: Record<string, string>;
    reporter?: any; reported?: any; messages: ReportedMessage[];
}

function fmt(iso: string) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function MessageReportsTab() {
    useStore();
    const [status, setStatus] = useState('open');
    const [state, setState] = useState<{ loading: boolean; error: string; rows: MessageReport[] }>({ loading: true, error: '', rows: [] });

    async function load() {
        setState(s => ({ ...s, loading: true, error: '' }));
        const client = await getClient();
        const { data, error } = await client.rpc('admin_message_reports', { p_status: status, p_limit: 100 });
        if (error) { setState({ loading: false, error: 'Could not load reports: ' + error.message, rows: [] }); return; }
        setState({ loading: false, error: '', rows: data || [] });
    }
    useEffect(() => { load(); }, [status]);

    return (
        <>
            <div className="admin-section-head">
                <h3>Reported messages</h3>
                <button type="button" className="btn btn-secondary btn-sm" onClick={load}><Icon name="refresh-cw" /> Reload</button>
            </div>
            <p className="admin-section-sub">
                Private messages are end-to-end encrypted. You can only read the ones someone reported: the reported message and up to ten before it, opened here with the keys the reporter's browser handed over. Act on the person through the Users tab.
            </p>
            <div className="admin-search-bar">
                <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
                    <option value="open">Open</option>
                    <option value="actioned">Actioned</option>
                    <option value="dismissed">Dismissed</option>
                    <option value="all">Everything</option>
                </select>
            </div>
            <div>
                {state.loading || state.error || !state.rows.length
                    ? <ListState loading={state.loading} error={state.error} empty="No reported messages." />
                    : state.rows.map(r => <MessageReportCard key={r.id} report={r} onChanged={load} />)}
            </div>
        </>
    );
}

function MessageReportCard({ report: r, onChanged }: { report: MessageReport; onChanged: () => void }) {
    const [opened, setOpened] = useState<Record<string, { text: string; attachments: any[] } | { error: string }>>({});
    const [note, setNote] = useState(r.staff_note || '');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let live = true;
        (async () => {
            const out: typeof opened = {};
            for (const m of r.messages) {
                const key = r.disclosed_keys?.[m.id];
                if (!key || !m.ciphertext || !r.conversation_id) { out[m.id] = { error: m.ciphertext ? 'No key was shared for this one.' : 'Deleted before it was reported.' }; continue; }
                try {
                    const payload = await openMessageWithKey(m, key, r.conversation_id);
                    out[m.id] = { text: String(payload?.text || ''), attachments: payload?.attachments || [] };
                } catch {
                    // the key doesn't open this ciphertext: the report doesn't match what was sent
                    out[m.id] = { error: 'The shared key doesn’t open this message (the report may have been tampered with).' };
                }
            }
            if (live) setOpened(out);
        })();
        return () => { live = false; };
    }, [r.id]);

    async function resolve(next: string) {
        setBusy(true);
        const client = await getClient();
        const { error } = await client.rpc('admin_resolve_message_report', { p_report: r.id, p_status: next, p_note: note });
        setBusy(false);
        if (error) { showToast('Could not save: ' + error.message, 'error'); return; }
        showToast('Saved.', 'success');
        onChanged();
    }

    async function openAttachment(a: any) {
        try {
            const client = await getClient();
            const { data, error } = await client.storage.from('chat-files').download(a.path);
            if (error || !data) throw error || new Error('missing');
            const plain = await openFile(await data.arrayBuffer(), a.key, a.iv, r.conversation_id!);
            window.open(URL.createObjectURL(new Blob([plain], { type: a.mime || 'application/octet-stream' })), '_blank', 'noopener');
        } catch {
            showToast('That file isn’t available any more.', 'error');
        }
    }

    const reportedId = r.reported?.id;
    return (
        <div className="admin-card msg-report">
            <div className="msg-report-head">
                <span className={`msg-report-status is-${r.status}`}>{r.status}</span>
                <span>Reported by <b>{r.reporter ? publicName(r.reporter) : 'a deleted account'}</b>{r.reported && <> about <b>{publicName(r.reported)}</b> (@{r.reported.username})</>}</span>
                <span className="msg-report-time">{fmt(r.created_at)}</span>
            </div>
            {r.reason && <p className="msg-report-reason">“{r.reason}”</p>}
            <div className="msg-report-thread">
                {r.messages.map(m => {
                    const o = opened[m.id];
                    return (
                        <div key={m.id} className={`msg-report-line${m.sender_id === reportedId ? ' is-reported' : ''}`}>
                            <div className="msg-report-meta"><b>{m.sender ? publicName(m.sender) : 'deleted account'}</b> · {fmt(m.created_at)}{m.deleted_at && ' · deleted by sender'}</div>
                            {!o ? <div className="msg-report-body">Opening…</div>
                                : 'error' in o ? <div className="msg-report-body admin-error">{o.error}</div>
                                : (
                                    <>
                                        {o.text && <div className="msg-report-body" dangerouslySetInnerHTML={{ __html: renderCommentMarkdown(o.text) }} />}
                                        {o.attachments.map((a: any) => (
                                            <button key={a.path} type="button" className="btn btn-secondary btn-sm" onClick={() => openAttachment(a)}>
                                                <Icon name="paperclip" /> {a.kind}: {a.name}
                                            </button>
                                        ))}
                                    </>
                                )}
                        </div>
                    );
                })}
            </div>
            <textarea rows={2} placeholder="Staff note (only staff see this)" value={note} onChange={e => setNote(e.target.value)} />
            <div className="msg-report-actions">
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => resolve('dismissed')}>Dismiss</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => resolve('actioned')}>Mark actioned</button>
                {r.status !== 'open' && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => resolve('open')}>Reopen</button>}
            </div>
        </div>
    );
}
