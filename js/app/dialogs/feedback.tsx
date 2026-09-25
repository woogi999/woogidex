// "Feedback & bug reports", from the account menu: send a report, or follow
// the ones you sent under My reports. Sending and loading: js/features/feedback.ts.

import { useEffect, useState, type FormEvent } from 'react';
import { api, state } from '../../core/app.ts';
import { BODY_MAX, KINDS, STATUS, TITLE_MAX, loadMyFeedback, sendFeedback } from '../../features/feedback.ts';
import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Modal } from '../components/Modal.tsx';
import { Icon } from '../components/Icon.tsx';

type Tab = 'send' | 'mine';

const PLACEHOLDER: Record<string, string> = {
    bug: 'What happened, and what did you expect to happen? Steps to make it happen again help a lot.',
    idea: 'Describe the idea and what it would help you do.',
    feedback: 'What’s on your mind?'
};

function FeedbackDialog({ close, tab: initialTab = 'send' }: DialogProps<{ tab?: Tab }>) {
    const [tab, setTab] = useState<Tab>(initialTab);
    return (
        <Modal onClose={close} className="feedback-modal" overlayClassName="feedback-overlay" labelledBy="feedback-title">
            <div className="modal-header">
                <h3 id="feedback-title">Feedback &amp; bug reports</h3>
                <button className="modal-close" type="button" onClick={close} aria-label="Close"><Icon name="x" size={20} /></button>
            </div>
            <div className="modal-body">
                {!state.user ? (
                    <div className="feedback-signin">
                        <span className="feedback-signin-icon"><Icon name="message-circle-warning" /></span>
                        <strong>Sign in to send feedback</strong>
                        <p>You need an account to send a bug report, feedback or an idea. It lets us reply to you, and you can follow what happens to it under My reports.</p>
                        <button type="button" className="btn btn-primary" onClick={() => { close(); api.openAuthModal('signin'); }}>Sign in</button>
                        <button type="button" className="btn btn-secondary" onClick={() => { close(); api.openAuthModal('signup'); }}>Create an account</button>
                    </div>
                ) : (
                    <>
                        <div className="tabs feedback-tabs" role="tablist">
                            <button type="button" className={`tab${tab === 'send' ? ' active' : ''}`} role="tab" aria-selected={tab === 'send'} onClick={() => setTab('send')}>Send a report</button>
                            <button type="button" className={`tab${tab === 'mine' ? ' active' : ''}`} role="tab" aria-selected={tab === 'mine'} onClick={() => setTab('mine')}>My reports</button>
                        </div>
                        {tab === 'send' ? <SendForm close={close} onSent={() => setTab('mine')} /> : <MyReports onSend={() => setTab('send')} />}
                    </>
                )}
            </div>
        </Modal>
    );
}

function SendForm({ close, onSent }: { close: () => void; onSent: () => void }) {
    const [kind, setKind] = useState('bug');
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [withContext, setWithContext] = useState(true);
    const [error, setError] = useState('');
    const [sending, setSending] = useState(false);
    const hint = KINDS.find(k => k.key === kind)?.hint || '';

    async function submit(e: FormEvent) {
        e.preventDefault();
        if (sending) return;
        setSending(true);
        const problem = await sendFeedback({ kind, title, body, withContext });
        setSending(false);
        setError(problem);
        if (!problem) onSent();
    }

    return (
        <form onSubmit={submit}>
            <div className="feedback-kinds" role="radiogroup" aria-label="What kind of report">
                {KINDS.map(k => (
                    <button key={k.key} type="button" className={`feedback-kind${k.key === kind ? ' active' : ''}`} role="radio" aria-checked={k.key === kind} onClick={() => setKind(k.key)}>
                        <Icon name={k.icon} /><span>{k.label}</span>
                    </button>
                ))}
            </div>
            <p className="feedback-hint">{hint}</p>
            <div className="form-group">
                <label htmlFor="feedback-report-title">Title</label>
                <input type="text" id="feedback-report-title" maxLength={TITLE_MAX} placeholder="A short summary" autoComplete="off" required autoFocus
                    value={title} onChange={e => setTitle(e.target.value)} />
            </div>
            <div className="form-group">
                <label htmlFor="feedback-report-body">Details <span className="feedback-count">{body.length}/{BODY_MAX}</span></label>
                <textarea id="feedback-report-body" rows={6} maxLength={BODY_MAX} required placeholder={PLACEHOLDER[kind]}
                    value={body} onChange={e => setBody(e.target.value)} />
            </div>
            <label className="feedback-check">
                <input type="checkbox" checked={withContext} onChange={e => setWithContext(e.target.checked)} />
                <span>Include the page I’m on and my browser<small>Helps us reproduce a bug. Nothing else about your device is sent.</small></span>
            </label>
            <p className="auth-modal-error">{error}</p>
            <div className="feedback-actions">
                <button type="button" className="btn btn-secondary" onClick={close}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={sending}><Icon name="send" /> Send</button>
            </div>
        </form>
    );
}

type Report = Awaited<ReturnType<typeof loadMyFeedback>>['rows'][number];

function MyReports({ onSend }: { onSend: () => void }) {
    const [result, setResult] = useState<{ rows: Report[]; error: string } | null>(null);
    useEffect(() => {
        let live = true;
        loadMyFeedback().then(r => { if (live) setResult(r); });
        return () => { live = false; };
    }, []);

    if (!result) return <div className="feedback-empty">Loading your reports…</div>;
    if (result.error) return <div className="feedback-empty">Your reports could not be loaded: {result.error}</div>;
    if (!result.rows.length) {
        return (
            <div className="feedback-empty">You haven’t sent any reports yet.<br />
                <button type="button" className="btn btn-secondary btn-sm" onClick={onSend}>Send one</button>
            </div>
        );
    }
    return (
        <div className="feedback-list">
            {result.rows.map(r => {
                const k = KINDS.find(x => x.key === r.kind) || KINDS[1];
                return (
                    <article className="feedback-item" key={r.id}>
                        <div className="feedback-item-head">
                            <span className={`feedback-item-kind ${r.kind}`} title={k.label}><Icon name={k.icon} /></span>
                            <strong>{r.title}</strong>
                            <span className={`feedback-status ${r.status}`}>{(STATUS as Record<string, string>)[r.status] || r.status}</span>
                        </div>
                        <p className="feedback-item-body">{r.body}</p>
                        {r.staff_note && (
                            <div className="feedback-reply"><Icon name="shield-check" /><div><small>Reply from the Woogidex team</small>{r.staff_note}</div></div>
                        )}
                        <small className="feedback-item-date">Sent {new Date(r.created_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}</small>
                    </article>
                );
            })}
        </div>
    );
}

registerDialog('feedback', FeedbackDialog);
