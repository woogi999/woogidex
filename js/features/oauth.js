// Social sign-in (OAuth): "Continue with Google / Discord", plus the Settings
// section that connects the same providers to an existing account.
//
// Notes:
//   1. Provider buttons aren't hardcoded -- enabled providers are read from
//      Supabase's own /auth/v1/settings, so a provider disabled there never
//      renders a button that leads to an error page.
//   2. OAuth sign-up has no checkbox to record Terms acceptance, so consent is
//      the click itself, recorded via a sessionStorage marker on return from
//      the provider -- never stamped on every sign-in, or it would forge
//      acceptance for accounts that predate the Terms.
//   3. Supabase won't remove an account's last identity, and neither do we --
//      disconnecting a sole login method would lock the owner out for good.

import { getClient, SUPABASE_URL, SUPABASE_ANON_KEY } from '../core/supabase.js';
import { state, api } from '../core/app.js';
import { log } from '../core/log.js';

// providers to show, in order. `icon` is inline SVG since lucide has no brand marks.
export const OAUTH_PROVIDERS = [
    {
        id: 'google',
        label: 'Google',
        icon: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.57-5.17 3.57-8.82z"/><path fill="#34A853" d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.86-3a7.2 7.2 0 0 1-10.75-3.78H1.46v3.09A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.33 14.31a7.13 7.13 0 0 1 0-4.62V6.6H1.46a12 12 0 0 0 0 10.8l3.87-3.09z"/><path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.46 6.6l3.87 3.09A7.15 7.15 0 0 1 12 4.75z"/></svg>'
    },
    {
        id: 'discord',
        label: 'Discord',
        icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="#5865F2" aria-hidden="true"><path d="M20.32 4.37A19.8 19.8 0 0 0 15.43 3a13.9 13.9 0 0 0-.63 1.28 18.3 18.3 0 0 0-5.6 0A13.4 13.4 0 0 0 8.56 3a19.7 19.7 0 0 0-4.89 1.37C.56 9 .17 13.53.37 18a19.9 19.9 0 0 0 6 3.03c.48-.66.91-1.36 1.28-2.1a12.9 12.9 0 0 1-2.02-.97c.17-.12.34-.25.5-.38a14.2 14.2 0 0 0 12.11 0c.16.14.33.26.5.38-.64.38-1.32.7-2.02.97.37.74.8 1.44 1.28 2.1a19.9 19.9 0 0 0 6.01-3.03c.24-5.18-.39-9.66-2.69-13.63zM8.02 15.28c-1.18 0-2.15-1.08-2.15-2.4s.95-2.42 2.15-2.42 2.17 1.09 2.15 2.42c0 1.32-.95 2.4-2.15 2.4zm7.96 0c-1.18 0-2.15-1.08-2.15-2.4s.95-2.42 2.15-2.42 2.17 1.09 2.15 2.42c0 1.32-.95 2.4-2.15 2.4z"/></svg>'
    }
];

// sessionStorage, not a module variable -- OAuth round trip is a full navigation, so memory doesn't survive it
const PENDING_KEY = 'woogidex.oauth.pending';

let enabledPromise = null;


// ==================== which providers are on ====================
// GoTrue's /auth/v1/settings (unauthenticated) reports enabled providers as
// an id -> boolean map. Asked once per page load and cached.
async function fetchEnabledProviders() {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
        headers: { apikey: SUPABASE_ANON_KEY }
    });
    if (!res.ok) throw new Error(`settings responded ${res.status}`);
    const body = await res.json();
    const external = body?.external || {};
    return OAUTH_PROVIDERS.filter(p => external[p.id] === true);
}

export function enabledProviders() {
    if (!enabledPromise) {
        enabledPromise = fetchEnabledProviders().catch(e => {
            log.warn('AUTH', 'Could not read which social logins are enabled', e); // render nothing rather than a broken button
            return [];
        });
    }
    return enabledPromise;
}


// ==================== signing in ====================
// Sends the browser to the provider; page is replaced, so "after signing in"
// logic belongs in finishProviderRedirect() on the far side of the round trip.
export async function startProviderRedirect(providerId, { link = false } = {}) {
    const client = await getClient();
    sessionStorage.setItem(PENDING_KEY, providerId);
    // return to the page they left, not the site root (must be in Supabase's redirect allow list)
    const redirectTo = window.location.href.split('#')[0];
    const options = { redirectTo };
    const { error } = link
        ? await client.auth.linkIdentity({ provider: providerId, options })
        : await client.auth.signInWithOAuth({ provider: providerId, options });
    if (error) {
        sessionStorage.removeItem(PENDING_KEY);
        log.error('AUTH', 'Could not start social sign-in', error);
        throw error;
    }
}

// runs once after state.user is populated on return from a provider; fills in
// what a password sign-up's form collects but OAuth has nowhere to ask for
export async function finishProviderRedirect() {
    const providerId = sessionStorage.getItem(PENDING_KEY);
    if (!providerId) return false;
    sessionStorage.removeItem(PENDING_KEY);
    if (!state.user) return false;

    try {
        const client = await getClient();
        const { data } = await client.auth.getUser();
        const meta = data?.user?.user_metadata || {};
        const patch = {};

        if (!meta.tos_accepted_at) patch.tos_accepted_at = new Date().toISOString();
        // field names vary by provider; Supabase passes them through unnormalized
        if (!meta.display_name) {
            const name = meta.full_name || meta.name || meta.user_name || '';
            if (name) patch.display_name = String(name).slice(0, 40);
        }
        if (!meta.avatar_url && meta.picture) patch.avatar_url = meta.picture;

        if (Object.keys(patch).length) {
            const { data: updated, error } = await client.auth.updateUser({ data: patch });
            if (error) throw error;
            if (updated?.user) Object.assign(state.user, {
                displayName: updated.user.user_metadata?.display_name || state.user.displayName,
                avatarUrl: updated.user.user_metadata?.avatar_url || state.user.avatarUrl,
                tosAcceptedAt: updated.user.user_metadata?.tos_accepted_at || state.user.tosAcceptedAt
            });
        }

        // user_metadata is readable by its owner and nobody else, so a name and
        // picture that only live there are invisible to every other visitor --
        // which is why a Google account's profile page came up blank-faced and
        // nameless to everyone but its owner. The password signup path mirrors
        // through updateDisplayName(); OAuth had no equivalent until here.
        const mirror = {};
        if (state.user.displayName) mirror.display_name = state.user.displayName;
        if (state.user.avatarUrl) mirror.avatar_url = state.user.avatarUrl;
        if (Object.keys(mirror).length) await api.mirrorToProfile?.(mirror);
    } catch (e) {
        log.warn('AUTH', 'Could not finish setting up the social account', e);
    }
    return true;
}

// suggested username for OAuth accounts (Discord handle / Google address local part),
// trimmed to USERNAME_PATTERN. Only a suggestion -- never claimed silently.
export function suggestedUsername(user = state.user) {
    const raw = user?.providerName || (user?.hasRealEmail ? String(user.email || '').split('@')[0] : '');
    const cleaned = String(raw || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 20);
    return cleaned.length >= 3 ? cleaned : '';
}


// ==================== the buttons in the sign-in modal ====================
export async function renderAuthProviderButtons() {
    const wrap = document.getElementById('auth-oauth');
    if (!wrap) return;
    const providers = await enabledProviders();
    if (!providers.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
    wrap.style.display = 'block';
    wrap.innerHTML = `
        <div class="oauth-buttons">
            ${providers.map(p => `
                <button type="button" class="oauth-btn" data-provider="${p.id}">
                    ${p.icon}<span>Continue with ${p.label}</span>
                </button>`).join('')}
        </div>
        <p class="oauth-consent">By continuing you agree to our
            <button type="button" class="inline-link-btn" data-oauth-terms>Terms of Service</button> and
            <button type="button" class="inline-link-btn" data-oauth-privacy>Privacy Policy</button>.</p>
        <div class="oauth-divider"><span>or</span></div>`;

    wrap.onclick = async event => {
        if (event.target.closest('[data-oauth-terms]')) return api.openTermsModal?.();
        if (event.target.closest('[data-oauth-privacy]')) return api.openPrivacyPage?.();
        const btn = event.target.closest('.oauth-btn');
        if (!btn) return;
        btn.disabled = true;
        try {
            await startProviderRedirect(btn.dataset.provider);
        } catch (e) {
            btn.disabled = false;
            const errorEl = document.getElementById('auth-modal-error');
            if (errorEl) errorEl.textContent = e.message || 'Could not reach that provider.';
        }
    };
}


// ==================== Settings -> Connected accounts ====================
async function myIdentities() {
    const client = await getClient();
    const { data, error } = await client.auth.getUserIdentities();
    if (error) { log.warn('AUTH', 'Could not list connected accounts', error); return []; }
    return data?.identities || [];
}

// Updates every mounted `.connected-accounts-group` at once (Settings page and
// the profile-edit Account card both have one, since all pages' markup is
// mounted at boot) so the two stay in sync from one call.
export async function updateConnectedAccountsUI() {
    const groups = [...document.querySelectorAll('.connected-accounts-group')];
    if (!groups.length) return;
    const providers = await enabledProviders();
    if (!state.user || !providers.length) {
        groups.forEach(g => { g.style.display = 'none'; });
        return;
    }

    const identities = await myIdentities();
    // includes the password account's 'email' identity, so this decides whether disconnecting is safe
    const total = identities.length;

    const rowsHtml = providers.map(p => {
        const linked = identities.some(i => i.provider === p.id);
        const last = linked && total < 2;
        return `
            <div class="settings-row settings-row-static connected-account-row${linked ? ' is-connected' : ''}">
                <span class="connected-account-icon" aria-hidden="true">${p.icon}</span>
                <span class="settings-row-text">
                    <span class="settings-label">${p.label}${linked ? ' <span class="connected-account-check" title="Connected">&check;</span>' : ''}</span>
                    <span class="settings-desc">${linked
                        ? (last
                            ? 'Connected. This is the only way into your account, so it cannot be disconnected.'
                            : 'Connected. You can sign in with ' + p.label + '.')
                        : 'Not connected. Connect it to sign in with ' + p.label + ' as well as your password.'}</span>
                </span>
                <button type="button" class="btn btn-sm ${linked ? 'btn-secondary' : 'btn-primary'}"
                        data-connect="${p.id}" data-linked="${linked ? '1' : ''}" ${last ? 'disabled' : ''}>
                    ${linked ? 'Disconnect' : 'Connect'}
                </button>
            </div>`;
    }).join('');

    const onListClick = async event => {
        const btn = event.target.closest('[data-connect]');
        if (!btn || btn.disabled) return;
        const id = btn.dataset.connect;
        // all mounted copies of this button must enter loading state together, or they'd disagree
        const twins = document.querySelectorAll(`[data-connect="${id}"]`);
        twins.forEach(b => { b.disabled = true; });
        try {
            if (btn.dataset.linked) await disconnectProvider(id);
            else await startProviderRedirect(id, { link: true });
        } catch (e) {
            api.showToast?.(e.message || 'That did not work.', 'error');
            twins.forEach(b => { b.disabled = false; });
        }
    };

    for (const group of groups) {
        group.style.display = '';
        const list = group.querySelector('.connected-accounts-list');
        if (!list) continue;
        list.innerHTML = rowsHtml;
        list.onclick = onListClick;
    }
}

// small connected-provider badges on a user's public profile (auth.js's
// renderProfilePage()). Only for the signed-in user's own profile -- Supabase's
// SDK can only list your own linked identities, not another user's.
export async function renderConnectedBadgesHtml() {
    if (!state.user) return '';
    const providers = await enabledProviders();
    if (!providers.length) return '';
    const identities = await myIdentities();
    const linked = providers.filter(p => identities.some(i => i.provider === p.id));
    if (!linked.length) return '';
    const badges = linked.map(p =>
        `<span class="profile-connected-badge" title="Connected with ${p.label}" aria-label="Connected with ${p.label}">${p.icon}</span>`
    ).join('');
    return `<span class="profile-connected-row">${badges}</span>`;
}

export async function disconnectProvider(providerId) {
    const identities = await myIdentities();
    if (identities.length < 2) {
        throw new Error('This is the only way into your account. Set a password or connect another account first.');
    }
    const identity = identities.find(i => i.provider === providerId);
    if (!identity) throw new Error('That account is not connected.');
    const client = await getClient();
    const { error } = await client.auth.unlinkIdentity(identity);
    if (error) { log.error('AUTH', 'Could not disconnect account', error); throw error; }
    log.info('AUTH', 'Disconnected provider', { providerId });
    api.showToast?.('Disconnected.', 'success');
    await updateConnectedAccountsUI();
}
