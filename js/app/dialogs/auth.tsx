// Sign in, sign up, forgot password, set a new password, change password.
//
// Why these look the way they do: Search Console once reported "Possible
// phishing detected on user login" -- Safe Browsing's credential-harvesting
// heuristic, which looks for password fields that don't look like a real,
// branded login form. So:
//   * these are rendered only while open, so no page's served HTML carries a
//     password field (it used to be in every indexable URL);
//   * each is a real <form> with a submit button;
//   * username/password fields carry name= and autocomplete= pairs, so a
//     password manager fills this site's own credential and never another's;
//   * the site's name is on the dialog, so the form is visibly branded.
// The account logic is js/features/auth.ts.

import { useEffect, useState, type FormEvent } from 'react';
import { api, state } from '../../core/app.ts';
import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Modal } from '../components/Modal.tsx';
import { Icon } from '../components/Icon.tsx';

function Head({ title, close }: { title: string; close?: () => void }) {
    return (
        <div className="modal-header">
            <h3>{title}</h3>
            {close && <button className="modal-close" type="button" onClick={close} aria-label="Close"><Icon name="x" size={20} /></button>}
        </div>
    );
}

function Brand({ children }: { children: React.ReactNode }) {
    return <div className="auth-brand"><img src="assets/woogidex_icon.png" alt="" width={28} height={28} /><span>{children}</span></div>;
}

/** An error, or (ok) a success message in green. */
function Message({ text, ok }: { text: string; ok?: boolean }) {
    return <p className="auth-modal-error" style={ok ? { color: 'var(--success, #22c55e)' } : undefined}>{text}</p>;
}

type Provider = { id: string; label: string; icon: string };

/** "Continue with Google / Discord / ...", for whichever providers are enabled. */
function ProviderButtons({ onError }: { onError: (message: string) => void }) {
    const [providers, setProviders] = useState<Provider[]>([]);
    const [busy, setBusy] = useState('');
    useEffect(() => {
        let live = true;
        // unawaited by the form: the password form must not wait on this to become usable
        api.enabledProviders().then((list: Provider[]) => { if (live) setProviders(list || []); });
        return () => { live = false; };
    }, []);
    if (!providers.length) return null;
    return (
        <div id="auth-oauth">
            <div className="oauth-buttons">
                {providers.map(p => (
                    <button key={p.id} type="button" className="oauth-btn" disabled={busy === p.id} onClick={async () => {
                        setBusy(p.id);
                        try { await api.startProviderRedirect(p.id); }
                        catch (e: any) { setBusy(''); onError(e?.message || 'Could not reach that provider.'); }
                    }}>
                        {/* the providers' own logos, from a constant table in js/features/oauth.ts */}
                        <span className="oauth-btn-icon" dangerouslySetInnerHTML={{ __html: p.icon }} />
                        <span>Continue with {p.label}</span>
                    </button>
                ))}
            </div>
            <p className="oauth-consent">By continuing you agree to our{' '}
                <button type="button" className="inline-link-btn" onClick={() => api.openTermsModal()}>Terms of Service</button> and{' '}
                <button type="button" className="inline-link-btn" onClick={() => api.openPrivacyPage()}>Privacy Policy</button>.</p>
            <div className="oauth-divider"><span>or</span></div>
        </div>
    );
}

function AuthDialog({ mode: startMode = 'signin', close }: DialogProps<{ mode?: 'signin' | 'signup' }>) {
    const [mode, setMode] = useState<'signin' | 'signup'>(startMode);
    const [identifier, setIdentifier] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [tos, setTos] = useState(false);
    const [message, setMessage] = useState<{ text: string; ok?: boolean }>({ text: '' });
    const [busy, setBusy] = useState(false);
    const signup = mode === 'signup';
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setMessage({ text: '' });
        setBusy(true);
        const result = await api.submitAuthForm({ mode, identifier, email, password, tosAccepted: tos });
        setBusy(false);
        if (result.error) setMessage({ text: result.error });
        else if (result.notice) setMessage({ text: result.notice, ok: true });
    };
    const switchMode = () => { setMode(signup ? 'signin' : 'signup'); setTos(false); setMessage({ text: '' }); };
    return (
        <Modal onClose={close} className="auth-modal">
            {/* the site's name stays in the title: an unbranded credential box is itself a phishing signal */}
            <Head title={signup ? 'Create a Woogidex account' : 'Sign in to Woogidex'} close={close} />
            <div className="modal-body">
                <Message {...message} />
                <ProviderButtons onError={text => setMessage({ text })} />
                <form onSubmit={submit}>
                    <div className="form-group">
                        <label htmlFor="auth-identifier">{signup ? 'Username' : 'Username or Email'}</label>
                        <input type="text" id="auth-identifier" name="username" autoComplete="username" autoFocus
                            placeholder={signup ? 'letters, numbers, underscore only' : 'your username or email'} value={identifier} onChange={e => setIdentifier(e.target.value)} />
                    </div>
                    {signup && <>
                        <div className="form-group">
                            <label htmlFor="auth-email-optional">Email (optional - for account recovery)</label>
                            <input type="email" id="auth-email-optional" name="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />
                        </div>
                        <div className="auth-signup-note">
                            <strong>No account is required to use Woogidex.</strong> You only need an account if you want to use Community features such as uploading, publishing, and interacting with other users.
                        </div>
                    </>}
                    <div className="form-group">
                        <label htmlFor="auth-password">Password</label>
                        <input type="password" id="auth-password" name="password" autoComplete={signup ? 'new-password' : 'current-password'} placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} />
                    </div>
                    {!signup && <a href="#" className="auth-forgot-link" onClick={e => { e.preventDefault(); api.openForgotPasswordModal(); }}>Forgot password?</a>}
                    {signup && (
                        <div className="auth-terms-row">
                            <label className="auth-terms-check">
                                <input type="checkbox" checked={tos} onChange={e => setTos(e.target.checked)} />
                                <span>I agree to the <button type="button" className="inline-link-btn" onClick={e => { e.preventDefault(); e.stopPropagation(); api.openTermsModal(); }}>Terms of Service</button>.</span>
                            </label>
                        </div>
                    )}
                    <button type="submit" className="btn btn-primary auth-submit-btn" disabled={busy}>
                        {busy ? (signup ? 'Signing up…' : 'Signing in…') : (signup ? 'Sign Up' : 'Sign In')}
                    </button>
                </form>
                <a href="#" className="auth-switch-link" onClick={e => { e.preventDefault(); switchMode(); }}>
                    {signup ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
                </a>
            </div>
        </Modal>
    );
}

function ForgotPasswordDialog({ close }: DialogProps) {
    const [identifier, setIdentifier] = useState('');
    const [error, setError] = useState('');
    const [sent, setSent] = useState(false);
    const [busy, setBusy] = useState(false);
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        const problem = await api.submitForgotPasswordForm(identifier);
        setBusy(false);
        if (problem) setError(problem);
        else { setError(''); setSent(true); }
    };
    return (
        <Modal onClose={close} className="auth-modal">
            <Head title="Reset Password" close={close} />
            <div className="modal-body">
                <Brand>Reset your <strong>Woogidex</strong> password</Brand>
                {/* the same message whatever happened, so this can't be used to find out who has an account */}
                {sent
                    ? <Message ok text="If an account matches, we've sent a password reset link to its email address. Don't see it? Check your spam/junk folder." />
                    : <>
                        <Message text={error} />
                        <form onSubmit={submit}>
                            <div className="form-group">
                                <label htmlFor="forgot-password-identifier">Username or Email</label>
                                <input type="text" id="forgot-password-identifier" name="username" autoComplete="username" placeholder="your username or email" autoFocus value={identifier} onChange={e => setIdentifier(e.target.value)} />
                            </div>
                            <button type="submit" className="btn btn-primary auth-submit-btn" disabled={busy}>{busy ? 'Sending…' : 'Send Reset Link'}</button>
                        </form>
                    </>}
                <a href="#" className="auth-switch-link" onClick={e => { e.preventDefault(); close(); api.openAuthModal('signin'); }}>Back to sign in</a>
            </div>
        </Modal>
    );
}

function SetNewPasswordDialog(_: DialogProps) {
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(await api.submitSetNewPasswordForm(password, confirm));
        setBusy(false);
    };
    // no way out: arriving from a reset link, the only thing left to do is set it
    return (
        <Modal onClose={() => {}} className="auth-modal" dismissible={false}>
            <Head title="Set New Password" />
            <div className="modal-body">
                <Brand>Set a new <strong>Woogidex</strong> password</Brand>
                <Message text={error} />
                <form onSubmit={submit}>
                    {/* without a username field the two new-password boxes are unpaired, which password managers and the heuristic both mind */}
                    <input type="text" name="username" autoComplete="username" hidden aria-hidden="true" tabIndex={-1} readOnly value={state.user?.username || ''} />
                    <div className="form-group">
                        <label htmlFor="set-new-password">New Password</label>
                        <input type="password" id="set-new-password" name="new-password" autoComplete="new-password" placeholder="••••••••" autoFocus value={password} onChange={e => setPassword(e.target.value)} />
                    </div>
                    <div className="form-group">
                        <label htmlFor="set-new-password-confirm">Confirm Password</label>
                        <input type="password" id="set-new-password-confirm" name="confirm-password" autoComplete="new-password" placeholder="••••••••" value={confirm} onChange={e => setConfirm(e.target.value)} />
                    </div>
                    <button type="submit" className="btn btn-primary auth-submit-btn" disabled={busy}>{busy ? 'Saving…' : 'Set Password'}</button>
                </form>
            </div>
        </Modal>
    );
}

function ChangePasswordDialog({ close }: DialogProps) {
    const needsCurrent = state.user?.hasPassword !== false;
    const [current, setCurrent] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(await api.submitChangePasswordForm({ current, password, confirm }));
        setBusy(false);
    };
    return (
        <Modal onClose={close} className="auth-modal">
            <Head title={needsCurrent ? 'Change Password' : 'Set a Password'} close={close} />
            <div className="modal-body">
                <Message text={error} />
                <form onSubmit={submit}>
                    <input type="text" name="username" autoComplete="username" hidden aria-hidden="true" tabIndex={-1} readOnly value={state.user?.username || ''} />
                    {/* an account that only ever signed in through a provider has no password to confirm */}
                    {needsCurrent && (
                        <div className="form-group">
                            <label htmlFor="change-password-current">Current Password</label>
                            <input type="password" id="change-password-current" name="current-password" autoComplete="current-password" placeholder="••••••••" autoFocus value={current} onChange={e => setCurrent(e.target.value)} />
                        </div>
                    )}
                    <div className="form-group">
                        <label htmlFor="change-password-new">New Password</label>
                        <input type="password" id="change-password-new" name="new-password" autoComplete="new-password" placeholder="At least 6 characters" autoFocus={!needsCurrent} value={password} onChange={e => setPassword(e.target.value)} />
                    </div>
                    <div className="form-group">
                        <label htmlFor="change-password-confirm">Confirm New Password</label>
                        <input type="password" id="change-password-confirm" name="confirm-password" autoComplete="new-password" placeholder="••••••••" value={confirm} onChange={e => setConfirm(e.target.value)} />
                    </div>
                    <button type="submit" className="btn btn-primary auth-submit-btn" disabled={busy}>{busy ? 'Saving…' : 'Update Password'}</button>
                </form>
            </div>
        </Modal>
    );
}

registerDialog('auth', AuthDialog);
registerDialog('forgot-password', ForgotPasswordDialog);
registerDialog('set-new-password', SetNewPasswordDialog);
registerDialog('change-password', ChangePasswordDialog);
