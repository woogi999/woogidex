// Which social sign-ins (Google, Discord...) are connected to this account,
// with Connect / Disconnect. Only providers the project has switched on show.

import { useEffect, useState, type ReactNode } from 'react';
import { api, state } from '../../core/app.ts';
import {
    disconnectProvider, enabledProviders, getConnectionsVersion, myIdentities, startProviderRedirect
} from '../../features/oauth.ts';
import { useStore } from '../store.ts';

interface Provider { id: string; label: string; icon: string; }
interface Loaded { providers: Provider[]; linked: Set<string>; total: number; }

/** Loads the providers and this account's identities; null until both arrive. */
function useConnections(): Loaded | null {
    useStore();
    const version = getConnectionsVersion();
    const userId = state.user?.id;
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    useEffect(() => {
        if (!userId) { setLoaded(null); return; }
        let live = true;
        Promise.all([enabledProviders(), myIdentities()]).then(([providers, identities]) => {
            if (!live) return;
            setLoaded({
                providers,
                linked: new Set(identities.map((i: any) => i.provider)),
                // includes the password account's 'email' identity: decides whether disconnecting is safe
                total: identities.length
            });
        });
        return () => { live = false; };
    }, [userId, version]);
    return loaded;
}

/** heading replaces the Settings-style group title (the profile page has its own) */
export function ConnectedAccounts({ className = 'settings-group', heading }: { className?: string; heading?: ReactNode }) {
    const loaded = useConnections();
    const [busy, setBusy] = useState('');
    if (!state.user || !loaded || !loaded.providers.length) return null;

    async function toggle(provider: Provider, linked: boolean) {
        setBusy(provider.id);
        try {
            if (linked) await disconnectProvider(provider.id);
            else await startProviderRedirect(provider.id, { link: true });
        } catch (e: any) {
            api.showToast?.(e?.message || 'That did not work.', 'error');
        } finally {
            setBusy('');
        }
    }

    return (
        <div className={`${className} connected-accounts-group`} data-react="">
            {heading ?? <div className="settings-group-title"><span>Connected Accounts</span></div>}
            <div className="connected-accounts-list">
                {loaded.providers.map(p => {
                    const linked = loaded.linked.has(p.id);
                    const last = linked && loaded.total < 2;
                    return (
                        <div key={p.id} className={`settings-row settings-row-static connected-account-row${linked ? ' is-connected' : ''}`}>
                            {/* brand marks: our own inline SVG constants */}
                            <span className="connected-account-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: p.icon }} />
                            <span className="settings-row-text">
                                <span className="settings-label">
                                    {p.label}{linked && <> <span className="connected-account-check" title="Connected">✓</span></>}
                                </span>
                                <span className="settings-desc">
                                    {linked
                                        ? (last
                                            ? 'Connected. This is the only way into your account, so it cannot be disconnected.'
                                            : `Connected. You can sign in with ${p.label}.`)
                                        : `Not connected. Connect it to sign in with ${p.label} as well as your password.`}
                                </span>
                            </span>
                            <button type="button" className={`btn btn-sm ${linked ? 'btn-secondary' : 'btn-primary'}`}
                                disabled={last || busy === p.id} onClick={() => toggle(p, linked)}>
                                {linked ? 'Disconnect' : 'Connect'}
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
