// Account and safety dialogs: finishing account setup, the Terms (read
// during sign-up), scheduling account deletion and its sign-in notice, the
// site-move notice, and the collection health warnings with lost-Fakémon
// recovery. The logic is in js/features/{auth,legal,account-deletion,
// site-notice,recovery}.js.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../../core/app.ts';
import { LEGAL_DOCS, loadLegalDoc, type LegalKey } from '../../features/legal.ts';
import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Modal } from '../components/Modal.tsx';
import { Icon } from '../components/Icon.tsx';

/** The policy-style dialog these share: title, body, and an action row. */
function PolicyDialog({ title, close, children, dismissible = true }: { title: string; close: () => void; children: ReactNode; dismissible?: boolean }) {
    return (
        <Modal onClose={close} className="policy-modal" dismissible={dismissible}>
            <div className="modal-header">
                <div><h3>{title}</h3></div>
                {dismissible && <button className="modal-close" type="button" onClick={close} aria-label="Close"><Icon name="x" size={20} /></button>}
            </div>
            <div className="modal-body policy-body">{children}</div>
        </Modal>
    );
}

// ---- finishing an account that has no username yet (OAuth sign-ins) ----

function AccountSetupDialog({ error: startError = '', username: startName = '', displayName: startDisplay = '', close }: DialogProps<{ error?: string; username?: string; displayName?: string }>) {
    const [username, setUsername] = useState(startName);
    const [displayName, setDisplayName] = useState(startDisplay);
    const [error, setError] = useState(startError);
    const [busy, setBusy] = useState(false);
    const submit = async () => {
        setBusy(true);
        const problem = await api.submitAccountSetup({ username, displayName });
        setBusy(false);
        if (problem) setError(problem);
        else close();
    };
    // no way out: an account without a username can't be signed into again or linked to
    return (
        <Modal onClose={() => {}} className="auth-modal" dismissible={false}>
            <div className="modal-header"><h3>Finish setting up your account</h3></div>
            <div className="modal-body">
                <p className="auth-modal-note">Pick how you'll appear around Woogidex. You can change both of these later in Edit Profile.</p>
                <p className="auth-modal-error">{error}</p>
                <div className="form-group">
                    <label htmlFor="account-setup-username">Username</label>
                    <input type="text" id="account-setup-username" maxLength={20} autoComplete="username" placeholder="letters, numbers, underscore only" autoFocus
                        value={username} onChange={e => setUsername(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
                    <div className="profile-field-hint">3-20 characters. This is how people find you, and how you sign in.</div>
                </div>
                <div className="form-group">
                    <label htmlFor="account-setup-display-name">Display Name</label>
                    <input type="text" id="account-setup-display-name" maxLength={40} placeholder="e.g., AshK"
                        value={displayName} onChange={e => setDisplayName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
                    <div className="profile-field-hint">Shown on your Fakémon, comments, and profile.</div>
                </div>
                <button className="btn btn-primary auth-submit-btn" type="button" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Continue'}</button>
            </div>
        </Modal>
    );
}

// ---- the Terms, over the sign-up form ----

function TermsDialog({ close }: DialogProps) {
    const [doc, setDoc] = useState<{ key: LegalKey; anchor: string }>({ key: 'terms', anchor: '' });
    const [html, setHtml] = useState<string | null>(null);
    const body = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let live = true;
        setHtml(null);
        loadLegalDoc(doc.key).then(h => { if (live) setHtml(h); });
        return () => { live = false; };
    }, [doc.key]);
    useEffect(() => {
        if (html === null) return;
        body.current?.closest('.modal-body')?.scrollTo({ top: 0 });
        if (doc.anchor) body.current?.querySelector(`[id="${CSS.escape(doc.anchor)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, [html, doc]);
    // links stay inside the dialog: leaving would lose the half-filled sign-up form
    const onClick = (event: React.MouseEvent) => {
        const link = (event.target as HTMLElement).closest?.('a[data-legal-link]');
        if (!link) return;
        event.preventDefault();
        const [path, anchor = ''] = (link.getAttribute('data-legal-link') || '').split('#');
        if (!path) body.current?.querySelector(`[id="${CSS.escape(anchor)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else if (path === 'terms' || path === 'privacy') setDoc({ key: path, anchor });
    };
    return (
        <PolicyDialog title={LEGAL_DOCS[doc.key].title} close={close}>
            {html === null
                ? <div className="legal-doc"><p className="legal-loading">Loading…</p></div>
                : <div className="legal-doc" ref={body} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />}
            <div className="policy-actions">
                <button type="button" className="btn btn-primary" onClick={close}>Got it</button>
            </div>
        </PolicyDialog>
    );
}

// ---- account deletion ----

function DeleteAccountDialog({ when, close }: DialogProps<{ when: string }>) {
    const [understood, setUnderstood] = useState(false);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const confirm = async () => {
        if (!understood) { setError('Please confirm that you understand what happens next.'); return; }
        setBusy(true);
        const problem = await api.confirmDeleteAccount();
        setBusy(false);
        if (problem) setError(problem);
    };
    return (
        <PolicyDialog title="Delete Your Account" close={close}>
            <p>Your account will be permanently deleted on <strong>{when}</strong>. Until then nothing is lost, and you can call it off from <strong>Settings → Account</strong> at any point.</p>
            <p>After that date these are gone for good and cannot be recovered:</p>
            <ul>
                <li>Your profile, username, display name, avatar and bio.</li>
                <li>The Fakémon synced to your account, and your published listings.</li>
                <li>Your comments, likes, notifications and battle records.</li>
            </ul>
            <p><strong>Export your collection first</strong> if you want to keep it. <em>Collection → Export</em> downloads the whole thing as a file you can import again later.</p>
            <div className="policy-actions">
                <div className="policy-check-row">
                    <label className="auth-terms-check">
                        <input type="checkbox" checked={understood} onChange={e => setUnderstood(e.target.checked)} autoComplete="off" />
                        <span>I understand that this permanently deletes my account and everything on it.</span>
                    </label>
                </div>
                <p className="auth-modal-error">{error}</p>
                <div className="delete-account-buttons">
                    <button type="button" className="btn btn-secondary" onClick={close}>Keep My Account</button>
                    <button type="button" className="btn btn-danger" disabled={busy} onClick={confirm}><Icon name="trash-2" size={14} /> Schedule Deletion</button>
                </div>
            </div>
        </PolicyDialog>
    );
}

function DeletionNoticeDialog({ when, close }: DialogProps<{ when: string }>) {
    return (
        <PolicyDialog title="Your Account Is Scheduled for Deletion" close={close}>
            <p>You asked us to delete this account. It will be permanently deleted on <strong>{when}</strong>, along with your collection, published Fakémon, comments and everything else on it.</p>
            <p>If that was not what you meant, you can stop it right now. Otherwise there is nothing to do, and if you want a copy of your Fakémon, export it from <em>Collection → Export</em> before the date above.</p>
            <div className="policy-actions">
                <div className="delete-account-buttons">
                    <button type="button" className="btn btn-secondary" onClick={close}>Leave It Scheduled</button>
                    <button type="button" className="btn btn-primary" onClick={() => api.cancelAccountDeletion()}><Icon name="rotate-ccw" size={14} /> Cancel Deletion</button>
                </div>
            </div>
        </PolicyDialog>
    );
}

// ---- the site's move to a new address ----

function SiteTransferDialog(_: DialogProps) {
    const [neverShow, setNeverShow] = useState(false);
    const done = () => api.closeSiteTransferNotice(neverShow);
    return (
        <PolicyDialog title="We're Moving to dex.woogi.xyz" close={done}>
            <p>Woogidex is moving to a new address: <span className="site-transfer-url">dex.woogi.xyz</span>. Your collection is saved in this browser only, so it will not follow you to the new site automatically. You'll need to bring it over yourself.</p>
            <ol className="site-transfer-steps">
                <li>On this site's Collection page, click <strong>Export Collection</strong> and choose <strong>Export as JSON</strong> to download a backup file.</li>
                <li>Go to <span className="site-transfer-url">dex.woogi.xyz</span> and sign in (or create an account).</li>
                <li>On its Collection page, click <strong>Import</strong> and choose the file you just downloaded.</li>
            </ol>
            <p>That brings over every Fakémon with its artwork and movesets, plus your custom moves, abilities, and items. Folders and battle teams don't travel with it, so you'll need to rebuild those on the new site.</p>
            <div className="policy-actions">
                <div className="policy-check-row">
                    <label className="auth-terms-check">
                        <input type="checkbox" checked={neverShow} onChange={e => setNeverShow(e.target.checked)} autoComplete="off" />
                        <span>Don't show this again</span>
                    </label>
                </div>
                <button type="button" className="btn btn-primary" onClick={done}>Got it</button>
            </div>
        </PolicyDialog>
    );
}

// ---- "something is wrong with your collection" ----

const WARNINGS: Record<string, { title: string; body: ReactNode }> = {
    'load-failed': {
        title: 'Your Collection Did Not Load',
        body: <>
            <p><strong>Your Fakémon have not been deleted.</strong> We could not open the place they are stored, which is usually a temporary browser problem rather than lost data.</p>
            <p><strong>Please reload the page before doing anything else.</strong> Until you do, saving is switched off on purpose: creating or editing a Fakémon now could write over the collection that is still sitting there.</p>
        </>
    },
    wiped: {
        title: 'Your Collection Looks Empty',
        body: <>
            <p><strong>Do not create anything yet.</strong> Your collection came up empty, but this device has a record of Fakémon being here, so they have most likely gone missing rather than been deleted.</p>
            <p>Reload the page first — an empty collection is very often just a browser hiccup, and a reload fixes it. If it is still empty afterwards, use <em>Check for lost Fakémon</em> to restore them from a backup copy.</p>
            <p>Saving is switched off until then, because a new Fakémon saved now could take the place of the ones we can still get back.</p>
        </>
    },
    'stale-tab': {
        title: 'This Tab Is Out Of Date',
        body: <>
            <p>Your collection was changed in another tab or window, so what this tab is showing is older than what is actually saved.</p>
            <p><strong>Reload this page to catch up.</strong> Saving from here is switched off, because writing this tab's older copy back would undo the changes the other tab made.</p>
        </>
    }
};

function CollectionWarningDialog({ kind, close }: DialogProps<{ kind: string }>) {
    const w = WARNINGS[kind] || WARNINGS['load-failed'];
    return (
        <PolicyDialog title={w.title} close={close}>
            {w.body}
            <div className="policy-actions">
                <button type="button" className="btn btn-primary" onClick={() => location.reload()}><Icon name="rotate-cw" size={14} /> Reload the Page</button>
                {/* only the "looks wiped" case has anywhere else to go */}
                {kind === 'wiped' && <>
                    <button type="button" className="btn btn-secondary" onClick={() => api.checkForLostFakemonFromWarning()}>Check for Lost Fakémon</button>
                    <button type="button" className="btn btn-secondary" onClick={() => api.confirmCollectionIsEmpty()}>I Deleted Them Myself</button>
                </>}
            </div>
        </PolicyDialog>
    );
}

type Candidate = { id: string; name: string; species: string; artwork: string; source: string };

function LostFakemonDialog({ candidates }: DialogProps<{ candidates: Candidate[] }>) {
    const [selected, setSelected] = useState(() => new Set(candidates.map(c => c.id)));
    const toggle = (id: string) => setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    return (
        <PolicyDialog title="We Found Some Lost Fakémon" close={() => api.closeRecoveryModal()}>
            <p>A bug used to be able to make Fakémon disappear from your collection. We fixed it, and found copies of some of yours that never made it back in. Uncheck any you don't want, then restore the rest.</p>
            <div className="recovery-list">
                {!candidates.length ? <p className="recovery-empty">Nothing left to recover.</p> : candidates.map(m => (
                    <label className="recovery-row" key={m.id}>
                        <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
                        {m.artwork ? <img className="recovery-thumb" src={m.artwork} alt="" /> : <span className="recovery-thumb recovery-thumb-empty"><Icon name="help-circle" /></span>}
                        <span className="recovery-row-text"><strong>{m.name}</strong>{[m.species, m.source].filter(Boolean).map(b => <span key={b}> · {b}</span>)}</span>
                    </label>
                ))}
            </div>
            <div className="policy-actions">
                <button type="button" className="btn btn-secondary" onClick={() => api.closeRecoveryModal()}>Not Now</button>
                <button type="button" className="btn btn-primary" onClick={() => api.restoreSelectedFakemon([...selected])}><Icon name="rotate-ccw" size={14} /> Restore Selected</button>
            </div>
        </PolicyDialog>
    );
}

function DuplicateFakemonDialog({ pairs: startPairs }: DialogProps<{ pairs: Array<{ recoveredId: string; name: string }> }>) {
    const [pairs, setPairs] = useState(startPairs);
    const remove = async (id: string) => {
        await api.deleteRecoveredDuplicate(id);
        const next = pairs.filter(p => p.recoveredId !== id);
        setPairs(next);
        if (!next.length) api.closeDuplicateModal();
    };
    return (
        <PolicyDialog title="Possible Duplicates" close={() => api.closeDuplicateModal()}>
            <p>Some restored Fakémon share a name with one already in your collection, most likely because you recreated it by hand after it went missing. Check both and delete whichever copy you don't want.</p>
            <div>
                {pairs.map(p => (
                    <div className="recovery-dupe-row" key={p.recoveredId}>
                        <span><strong>{p.name}</strong> now exists twice in your collection.</span>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => remove(p.recoveredId)}>Delete the Recovered Copy</button>
                    </div>
                ))}
            </div>
            <div className="policy-actions">
                <button type="button" className="btn btn-primary" onClick={() => api.closeDuplicateModal()}>Done</button>
            </div>
        </PolicyDialog>
    );
}

registerDialog('account-setup', AccountSetupDialog);
registerDialog('terms', TermsDialog);
registerDialog('delete-account', DeleteAccountDialog);
registerDialog('account-deletion-notice', DeletionNoticeDialog);
registerDialog('site-transfer', SiteTransferDialog);
registerDialog('collection-warning', CollectionWarningDialog);
registerDialog('lost-fakemon', LostFakemonDialog);
registerDialog('duplicate-fakemon', DuplicateFakemonDialog);
