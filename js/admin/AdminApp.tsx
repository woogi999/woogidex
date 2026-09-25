// The staff panel (admin.html): its header, the sign-in gate, and the tabs.
// Tabs a staff member has no permission for aren't offered at all, so nobody
// is shown a view that would only error. Each tab loads on its first visit and
// then stays mounted, keeping its searches and scroll while you look elsewhere.

import { Fragment, useEffect, useState, type ComponentType, type FormEvent } from 'react';
import { Icon } from '../app/components/Icon.tsx';
import { useStore } from '../app/store.ts';
import { admin, can, isDark, signIn, signOut, toggleDarkMode } from './core.ts';
import { UsersTab } from './UsersTab.tsx';
import { CommentsTab, FilterTab, ModLogTab } from './ModerationTabs.tsx';
import { FeedbackTab, feedbackOpenCount, refreshOpenCount } from './FeedbackTab.tsx';
import { BadgesTab, LimitsTab } from './SiteTabs.tsx';
import { EventsTab } from './EventsTab.tsx';
import { Toast } from './ui.tsx';

type TabKey = 'users' | 'comments' | 'filter' | 'history' | 'feedback' | 'badges' | 'events' | 'limits';

const TABS: Array<{ key: TabKey; label: string; icon: string; group: 'Moderation' | 'Site'; needs?: string; Page: ComponentType }> = [
    { key: 'users', label: 'Users', icon: 'users', group: 'Moderation', Page: UsersTab },
    { key: 'comments', label: 'Comments', icon: 'message-square', group: 'Moderation', Page: CommentsTab },
    // open to every staff member, for the tester; editing the rules needs manage_filter
    { key: 'filter', label: 'Filter', icon: 'filter', group: 'Moderation', Page: FilterTab },
    { key: 'history', label: 'Mod log', icon: 'scroll-text', group: 'Moderation', needs: 'view_log', Page: ModLogTab },
    { key: 'feedback', label: 'Feedback', icon: 'message-circle-warning', group: 'Moderation', needs: 'manage_feedback', Page: FeedbackTab },
    { key: 'badges', label: 'Badges', icon: 'award', group: 'Site', needs: 'manage_badges', Page: BadgesTab },
    { key: 'events', label: 'Events', icon: 'calendar-days', group: 'Site', needs: 'manage_events', Page: EventsTab },
    { key: 'limits', label: 'Limits', icon: 'gauge', group: 'Site', needs: 'manage_limits', Page: LimitsTab }
];

export function AdminApp() {
    useStore();
    const signedIn = admin.gate === 'ok' || admin.gate === 'forbidden';
    return (
        <>
            <header className="term-header">
                <div className="term-brand">
                    <a href="index.html" className="logo-button" aria-label="Back to Woogidex" title="Back to Woogidex"><img src="assets/woogidex_icon.png" alt="Woogidex" /></a>
                    <span className="term-brand-divider" aria-hidden="true" />
                    <span id="term-build"><Icon name="shield" /> Staff panel</span>
                </div>
                <div className="term-header-actions">
                    {admin.gate === 'ok' && <span className="term-whoami"><Icon name="user-round" /><b>{admin.me?.name}</b></span>}
                    <button className="icon-btn" type="button" onClick={toggleDarkMode} aria-label="Toggle dark mode" title="Toggle dark mode">
                        <Icon name={isDark() ? 'sun' : 'moon'} />
                    </button>
                    <a href="index.html" className="btn btn-secondary btn-sm"><Icon name="arrow-left" /><span className="term-hide-sm">Back to site</span></a>
                    {signedIn && <button className="btn btn-secondary btn-sm" type="button" onClick={signOut}><Icon name="log-out" /><span className="term-hide-sm">Sign out</span></button>}
                </div>
            </header>
            <div className="term-shell">
                {admin.gate === 'signedOut' && <SignInGate />}
                {admin.gate === 'forbidden' && (
                    <div className="admin-gate-wrap">
                        <div className="panel">
                            <div className="admin-gate-msg">
                                <span className="admin-gate-icon is-danger"><Icon name="shield-x" /></span>
                                <strong>No staff access</strong>
                                <p>This account doesn't hold any staff permissions.</p>
                            </div>
                            <button className="btn btn-secondary btn-block" type="button" onClick={signOut}>Sign out</button>
                        </div>
                    </div>
                )}
                {admin.gate === 'ok' && <Panel />}
            </div>
            <Toast />
        </>
    );
}

function SignInGate() {
    const [identifier, setIdentifier] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    async function submit(e: FormEvent) {
        e.preventDefault();
        setError('');
        setBusy(true);
        try { await signIn(identifier, password); }
        catch (err: any) { setError(err.message || 'Sign in failed.'); }
        finally { setBusy(false); }
    }
    return (
        <div className="admin-gate-wrap">
            <div className="panel">
                <div className="admin-gate-msg">
                    <span className="admin-gate-icon"><Icon name="shield" /></span>
                    <strong>Staff sign in</strong>
                    <p>Sign in with a staff account to continue.</p>
                </div>
                <p className="auth-modal-error">{error}</p>
                <form onSubmit={submit}>
                    <div className="form-group">
                        <label htmlFor="admin-signin-identifier">Username or email</label>
                        <input type="text" id="admin-signin-identifier" name="username" autoComplete="username" placeholder="Username or email" value={identifier} onChange={e => setIdentifier(e.target.value)} />
                    </div>
                    <div className="form-group">
                        <label htmlFor="admin-signin-password">Password</label>
                        <input type="password" id="admin-signin-password" name="password" autoComplete="current-password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} />
                    </div>
                    <button type="submit" className="btn btn-primary btn-block" disabled={busy}>Sign in</button>
                </form>
            </div>
        </div>
    );
}

function Panel() {
    const tabs = TABS.filter(t => !t.needs || can(t.needs));
    const [current, setCurrent] = useState<TabKey>('users');
    const [visited, setVisited] = useState<Set<TabKey>>(() => new Set(['users']));
    const open = (key: TabKey) => { setCurrent(key); setVisited(v => (v.has(key) ? v : new Set(v).add(key))); };
    useEffect(() => { if (can('manage_feedback')) refreshOpenCount(); }, []);
    const openReports = feedbackOpenCount();

    return (
        <div className="admin-layout">
            <nav className="admin-tabs" role="tablist" aria-label="Staff sections">
                {(['Moderation', 'Site'] as const).map(group => {
                    const inGroup = tabs.filter(t => t.group === group);
                    if (!inGroup.length) return null;
                    return (
                        <Fragment key={group}>
                            <span className="admin-tabs-label">{group}</span>
                            {inGroup.map(t => (
                                <button key={t.key} type="button" role="tab" className={`admin-tab${current === t.key ? ' active' : ''}`}
                                    aria-selected={current === t.key} aria-current={current === t.key ? 'page' : undefined} onClick={() => open(t.key)}>
                                    <Icon name={t.icon} /><span>{t.label}</span>
                                    {t.key === 'feedback' && openReports > 0 && <span className="admin-tab-count">{openReports > 99 ? '99+' : openReports}</span>}
                                </button>
                            ))}
                        </Fragment>
                    );
                })}
            </nav>
            <main className="admin-main">
                {tabs.filter(t => visited.has(t.key)).map(({ key, Page }) => (
                    <div key={key} className="admin-section" style={{ display: current === key ? 'block' : 'none' }}><Page /></div>
                ))}
            </main>
        </div>
    );
}
