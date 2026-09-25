// The comment stream, the content filter and the moderation log.

import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../app/components/Icon.tsx';
import { Modal } from '../app/components/Modal.tsx';
import { openDialog, registerDialog, type DialogProps } from '../app/dialogs.tsx';
import { useStore } from '../app/store.ts';
import { ask, can, debounce, getClient, reloads, showToast } from './core.ts';
import { CommentRows, FilterHits, LogRows, PatternPreview, type Comment, type PatternStatus } from './moderation.tsx';
import { deleteComment } from './UsersTab.tsx';
import { ListState } from './ui.tsx';

// ==================== comments ====================
export function CommentsTab() {
    useStore();
    const [search, setSearch] = useState('');
    const [state, setState] = useState<{ loading: boolean; error: string; comments: Comment[] }>({ loading: true, error: '', comments: [] });

    async function load() {
        setState(s => ({ ...s, loading: true, error: '' }));
        try {
            const client = await getClient();
            const { data, error } = await client.rpc('admin_recent_comments', { p_limit: 150, p_search: search.trim() });
            if (error) throw error;
            setState({ loading: false, error: '', comments: data || [] });
        } catch (e: any) {
            setState({ loading: false, error: e.message, comments: [] });
        }
    }
    useEffect(() => { load(); }, [reloads.comments]);

    return (
        <>
            <div className="admin-section-head">
                <h3>Comment stream</h3>
                <button type="button" className="btn btn-secondary btn-sm" onClick={load}><Icon name="refresh-cw" /> Reload</button>
            </div>
            <p className="admin-section-sub">Every comment on the site, newest first: Fakemon comments and profile comments together. Deleting one notifies its author with your reason and records the deletion in the mod log.</p>
            <form className="admin-search-bar" onSubmit={e => { e.preventDefault(); load(); }}>
                <input type="text" placeholder="Search comment text or author" autoComplete="off" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search comments" />
                <button type="submit" className="btn btn-primary"><Icon name="search" /> Search</button>
            </form>
            <div>
                <CommentRows comments={state.comments} loading={state.loading} error={state.error} showAuthor empty="no comments match that"
                    onDelete={can('delete_content') ? deleteComment : undefined} />
            </div>
        </>
    );
}

// ==================== the moderation log ====================
const LOG_PAGE = 60;
const LOG_FILTERS: Array<[string, string]> = [
    ['', 'All actions'], ['warn', 'Warnings'], ['mute', 'Mutes'], ['unmute', 'Unmutes'], ['ban', 'Suspensions'], ['unban', 'Lifted suspensions'],
    ['automod_block', 'Automod blocks'], ['automod_flag', 'Automod flags'], ['delete_comment', 'Comment deletions'], ['purge_comments', 'Comment purges'],
    ['delete_mon', 'Fakemon deletions'], ['purge_mons', 'Fakemon purges'], ['delete_user', 'Account deletions'], ['badge_change', 'Badge changes'],
    ['badge_upsert', 'Badge edits'], ['site_limits_update', 'Limit changes'], ['term_added', 'Filter rules added'], ['term_updated', 'Filter rules edited'],
    ['term_removed', 'Filter rules removed']
];

export function ModLogTab() {
    useStore();
    const [filter, setFilter] = useState('');
    const [state, setState] = useState<{ loading: boolean; error: string; entries: any[]; more: boolean }>({ loading: true, error: '', entries: [], more: false });

    async function load(append = false) {
        const offset = append ? state.entries.length : 0;
        if (!append) setState({ loading: true, error: '', entries: [], more: false });
        try {
            const client = await getClient();
            const { data, error } = await client.rpc('admin_moderation_log', { p_user_id: null, p_action: filter, p_limit: LOG_PAGE, p_offset: offset });
            if (error) throw error;
            setState(s => ({ loading: false, error: '', entries: append ? s.entries.concat(data || []) : (data || []), more: data?.length === LOG_PAGE }));
        } catch (e: any) {
            setState(s => ({ ...s, loading: false, error: e.message }));
        }
    }
    useEffect(() => { load(); }, [filter, reloads.log]);

    return (
        <>
            <div className="admin-section-head">
                <h3>Moderation log</h3>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => load()}><Icon name="refresh-cw" /> Reload</button>
            </div>
            <p className="admin-section-sub">Every moderation action on the site, by staff and by the auto-moderator. Append-only, nothing here can be edited or removed from the panel.</p>
            <div className="admin-search-bar">
                <select value={filter} onChange={e => setFilter(e.target.value)} aria-label="Which actions">
                    {LOG_FILTERS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
            </div>
            <div id="admin-log-list"><LogRows entries={state.entries} loading={state.loading} error={state.error} empty="nothing logged yet" /></div>
            {state.more && <div className="admin-log-more"><button type="button" className="btn btn-secondary btn-sm" onClick={() => load(true)}>Load more</button></div>}
        </>
    );
}

// ==================== the content filter ====================
interface Term { id: string; label: string; pattern: string; severity: string; action: string; enabled: boolean; notes?: string | null; }

let terms: Term[] = [];

export function FilterTab() {
    useStore();
    const [state, setState] = useState<{ loading: boolean; error: string }>({ loading: true, error: '' });
    const [, setVersion] = useState(0);
    const canEdit = can('manage_filter');

    async function load() {
        setState({ loading: true, error: '' });
        try {
            const client = await getClient();
            const { data, error } = await client.from('banned_terms').select('*').order('severity', { ascending: true }).order('label', { ascending: true });
            if (error) throw error;
            terms = data || [];
            setState({ loading: false, error: '' });
        } catch (e: any) {
            setState({ loading: false, error: e.message });
        }
    }
    useEffect(() => { load(); }, []);

    // Reuses the upsert RPC rather than a direct update, so toggling is logged
    // like any other blocklist change.
    async function toggle(t: Term) {
        try {
            const client = await getClient();
            const { error } = await client.rpc('admin_upsert_banned_term', {
                p_id: t.id, p_pattern: t.pattern, p_label: t.label, p_severity: t.severity, p_action: t.action, p_enabled: !t.enabled, p_notes: t.notes || ''
            });
            if (error) throw error;
            t.enabled = !t.enabled;
            setVersion(v => v + 1);
        } catch (e: any) {
            showToast(e.message || 'Could not change that rule.', 'error');
        }
    }

    const edit = (t: Term | null) => openDialog('admin-term', { term: t, onSaved: load });

    return (
        <>
            <div className="admin-section-head">
                <h3>Content filter</h3>
                {canEdit && <button type="button" className="btn btn-primary btn-sm" onClick={() => edit(null)}><Icon name="plus" /> Rule</button>}
            </div>
            <p className="admin-section-sub">POSIX regular expressions, matched case-insensitively against every comment, profile and published Fakemon. <strong>Block</strong> refuses the post and counts a strike; <strong>flag</strong> lets it through and records it. Strikes escalate on their own: warning &rarr; 24h mute &rarr; 7d mute &rarr; 30d suspension &rarr; permanent.</p>
            <FilterTester />
            <div>
                {state.loading || state.error || !terms.length
                    ? <ListState loading={state.loading} error={state.error} empty="no rules yet" />
                    : terms.map(t => (
                        <div key={t.id} className={`admin-term-row ${t.enabled ? '' : 'off'}`}>
                            <div>
                                <div className="admin-term-head">
                                    <span>{t.label}</span>
                                    <span className={`admin-hit-pill ${t.action === 'block' ? 'block' : 'flag'}`}>{t.action}</span>
                                    <span className="admin-perm-pill">{t.severity}</span>
                                    {!t.enabled && <span className="admin-perm-pill">disabled</span>}
                                </div>
                                {/* shown verbatim as text, never interpreted as markup */}
                                <code>{t.pattern}</code>
                                {t.notes && <small>{t.notes}</small>}
                            </div>
                            <div className="admin-term-actions">
                                <button type="button" title={t.enabled ? 'Disable' : 'Enable'} disabled={!canEdit} onClick={() => toggle(t)}><Icon name={t.enabled ? 'toggle-right' : 'toggle-left'} /></button>
                                <button type="button" title="Edit" disabled={!canEdit} onClick={() => edit(t)}><Icon name="pencil" /></button>
                            </div>
                        </div>
                    ))}
            </div>
        </>
    );
}

// Runs the real server-side scan rather than a JS re-implementation, since
// Postgres regex (\m, \M, \y) has no JS equivalent - a disagreeing tester
// would be worse than none.
function FilterTester() {
    const [text, setText] = useState('');
    const [result, setResult] = useState<{ hits: any[] | null; error: string }>({ hits: null, error: '' });
    const [test] = useState(() => debounce(async (text: string) => {
        if (!text.trim()) { setResult({ hits: null, error: '' }); return; }
        try {
            const client = await getClient();
            const { data, error } = await client.rpc('admin_test_content', { p_text: text });
            if (error) throw error;
            setResult({ hits: data || [], error: '' });
        } catch (e: any) {
            setResult({ hits: null, error: e.message });
        }
    }, 350));
    return (
        <div className="admin-filter-tester">
            <label htmlFor="admin-filter-test-input">Test a phrase against the live rules</label>
            <div className="admin-search-bar">
                <input id="admin-filter-test-input" type="text" placeholder="Paste something a user might write" value={text} onChange={e => { setText(e.target.value); test(e.target.value); }} />
            </div>
            <div className="admin-filter-test-result">
                {result.error ? <span className="admin-error">{result.error}</span> : result.hits && <FilterHits hits={result.hits} />}
            </div>
        </div>
    );
}

function TermDialog({ close, term, onSaved }: DialogProps<{ term: Term | null; onSaved: () => void }>) {
    const [f, setF] = useState({
        label: term?.label || '', pattern: term?.pattern || '', severity: term?.severity || 'severe', action: term?.action || 'block',
        notes: term?.notes || '', enabled: term ? !!term.enabled : true
    });
    const set = (patch: Partial<typeof f>) => setF(v => ({ ...v, ...patch }));
    const [phrase, setPhrase] = useState('');
    const [preview, setPreview] = useState<{ status: PatternStatus; detail: string }>({ status: '', detail: '' });

    // Runs the in-progress (unsaved) pattern through Postgres directly, which
    // also catches a malformed regex before Save does.
    const [check] = useState(() => debounce(async (pattern: string, phrase: string) => {
        if (!pattern.trim()) { setPreview({ status: '', detail: '' }); return; }
        try {
            const client = await getClient();
            const { data, error } = await client.rpc('admin_test_pattern', { p_pattern: pattern.trim(), p_text: phrase });
            if (error) throw error;
            if (!data?.valid) setPreview({ status: 'invalid', detail: data?.error || '' });
            else if (!phrase.trim()) setPreview({ status: 'valid', detail: '' });
            else setPreview({ status: data.match ? 'match' : 'no-match', detail: '' });
        } catch (e: any) {
            setPreview({ status: 'error', detail: e.message });
        }
    }, 350));
    useEffect(() => { check(f.pattern, phrase); }, [f.pattern, phrase]);

    async function submit(e: FormEvent) {
        e.preventDefault();
        try {
            const client = await getClient();
            const { error } = await client.rpc('admin_upsert_banned_term', {
                p_id: term?.id || null, p_pattern: f.pattern.trim(), p_label: f.label.trim(), p_severity: f.severity,
                p_action: f.action, p_enabled: f.enabled, p_notes: f.notes.trim()
            });
            if (error) throw error;
            close();
            onSaved();
            showToast('Filter rule saved', 'success');
        } catch (err: any) {
            showToast(err.message || 'Could not save that rule.', 'error');
        }
    }

    async function remove() {
        if (!term) return;
        close();
        const answer = await ask({
            title: 'Delete filter rule', blurb: <>Remove <strong>{term.label}</strong> from the blocklist. Posts matching it will stop being caught.</>,
            confirm: 'Delete rule', requireReason: false
        });
        if (!answer) return;
        try {
            const client = await getClient();
            const { error } = await client.rpc('admin_delete_banned_term', { p_id: term.id });
            if (error) throw error;
            onSaved();
            showToast('Filter rule deleted', 'success');
        } catch (err: any) {
            showToast(err.message || 'Could not delete that rule.', 'error');
        }
    }

    return (
        <Modal onClose={close} title={term ? 'Edit filter rule' : 'New filter rule'} labelledBy="admin-term-title">
            <form onSubmit={submit}>
                <div className="form-group">
                    <label htmlFor="admin-term-label">What is it</label>
                    <input id="admin-term-label" type="text" placeholder="E.g. Homophobic slur" required value={f.label} onChange={e => set({ label: e.target.value })} />
                </div>
                <div className="form-group">
                    <label htmlFor="admin-term-pattern">Pattern</label>
                    <textarea id="admin-term-pattern" rows={2} spellCheck={false} required placeholder="\myourword\M" value={f.pattern} onChange={e => set({ pattern: e.target.value })} />
                    <p className="admin-section-sub" style={{ margin: '6px 0 0' }}>Use <code>\m</code> / <code>\M</code> for word start/end so <em>class</em> doesn't trip an <em>ass</em> rule, and <code>[\W_]{'{0,3}'}</code> between letters to catch <em>s p a c e d</em> evasion.</p>
                </div>
                <div className="admin-modal-row">
                    <div className="form-group">
                        <label htmlFor="admin-term-severity">Severity</label>
                        <select id="admin-term-severity" value={f.severity} onChange={e => set({ severity: e.target.value })}>
                            <option value="severe">Severe (slurs)</option>
                            <option value="moderate">Moderate</option>
                            <option value="mild">Mild</option>
                        </select>
                    </div>
                    <div className="form-group">
                        <label htmlFor="admin-term-action">Action</label>
                        <select id="admin-term-action" value={f.action} onChange={e => set({ action: e.target.value })}>
                            <option value="block">Block + strike</option>
                            <option value="flag">Allow, log for review</option>
                        </select>
                    </div>
                </div>
                <div className="form-group">
                    <label htmlFor="admin-term-notes">Notes <span>(staff only)</span></label>
                    <input id="admin-term-notes" type="text" placeholder="E.g. false positive on 'chink in the armor'" value={f.notes} onChange={e => set({ notes: e.target.value })} />
                </div>
                <label className="admin-checkbox-row"><input type="checkbox" checked={f.enabled} onChange={e => set({ enabled: e.target.checked })} /> Rule is active</label>
                <div className="form-group">
                    <label htmlFor="admin-term-preview-input">Test this pattern</label>
                    <input id="admin-term-preview-input" type="text" placeholder="Type a phrase" value={phrase} onChange={e => setPhrase(e.target.value)} />
                    <div className="admin-filter-test-result"><PatternPreview status={preview.status} detail={preview.detail} /></div>
                </div>
                <div className="admin-modal-actions">
                    {term && <button type="button" className="btn btn-danger-ghost" style={{ marginRight: 'auto' }} onClick={remove}>Delete</button>}
                    <button type="button" className="btn btn-secondary" onClick={close}>Cancel</button>
                    <button type="submit" className="btn btn-primary">Save rule</button>
                </div>
            </form>
        </Modal>
    );
}
registerDialog('admin-term', TermDialog);
