import { getClient } from '../core/supabase.js';
import { dropCachedAvatar, paintAvatarInto } from '../core/avatar.js';
import { frameCount } from '../core/art-shield.js';
import { esc, publicName } from '../core/html.js';
import { log } from '../core/log.js';
import { state, api } from '../core/app.js';
import { renderCommentMarkdown } from '../core/data.js';
import { replaceRoute, currentRoute, routeUrl, emailLinkParams } from '../core/router.js';
import { mountIsland } from '../react/island.jsx';
import { ProfileMons, ProfileComments, BadgePicker, UserHoverCard } from '../react/Profile.jsx';

// ==================== Supabase client ====================
// loaded from CDN as an es module - no npm/bundler needed.
// TODO: replace with your project's values (Supabase dashboard -> project settings -> API).

let authInitPromise = null;


const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;
// domain for accounts with no real email. '.invalid' is a reserved,
// non-routable TLD (RFC 2606) - Supabase accepts it as valid but nothing
// is ever delivered there.
const PLACEHOLDER_EMAIL_DOMAIN = 'users.woogidex.invalid';
const SYNTHETIC_EMAIL_DOMAIN = 'no-email.woogidex.com';

// Captured before the router touches the URL. Needed because Supabase parses
// recovery tokens from the fragment and emits PASSWORD_RECOVERY during client
// construction - before initAuth() registers its onAuthStateChange listener,
// so that event would otherwise go unheard.
const EMAIL_LINK = emailLinkParams();

// Flattens auth.users.user_metadata onto state.user. `username` lives in the
// public `profiles` table instead (see fetchProfile), since it needs
// uniqueness + rate-limit enforcement user_metadata can't provide.
function mapUser(supabaseUser) {
    const meta = supabaseUser.user_metadata || {};
    return {
        id: supabaseUser.id,
        email: supabaseUser.email,
        hasRealEmail: !!supabaseUser.email && !supabaseUser.email.endsWith('@' + PLACEHOLDER_EMAIL_DOMAIN) && !supabaseUser.email.endsWith('@' + SYNTHETIC_EMAIL_DOMAIN),
        tosAcceptedAt: meta.tos_accepted_at || null,
        username: '',
        displayName: meta.display_name || '',
        avatarUrl: meta.avatar_url || '',
        // OAuth-provided display name; only seeds the suggestion in
        // promptUsernameIfMissing, never treated as a username.
        providerName: meta.user_name || meta.preferred_username || meta.full_name || meta.name || ''
    };
}

async function fetchProfile(userId) {
    const client = await getClient();
    const { data, error } = await client.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error) { log.error('AUTH', 'Profile fetch failed', error); return null; }
    return data;
}

async function fetchBadges(userId) {
    const client = await getClient();
    const { data, error } = await client.from('profile_badges').select('badge_key').eq('user_id', userId);
    if (error) { log.error('AUTH', 'Badge fetch failed', error); return []; }
    return (data || []).map(row => row.badge_key);
}

async function refreshBadgeDefinitions() {
    try {
        const client = await getClient();
        const { data, error } = await client.from('badges').select('key, label, icon, color, description, rank').order('rank', { ascending: false });
        if (error) throw error;
        api.setBadgeDefinitions?.(data || []);
        return data || [];
    } catch (e) {
        log.warn('AUTH', 'Could not load live badge definitions; using cached defaults', e);
        return [];
    }
}


// Server-derived permissions, not profiles.role (a copy of the highest
// badge's label) - a renamed staff badge would silently break role-name
// checks.
async function fetchPermissions() {
    try {
        const client = await getClient();
        const { data, error } = await client.rpc('my_permissions');
        if (error) throw error;
        return data || {};
    } catch (e) {
        log.warn('AUTH', 'Could not read permissions', e);
        return {};
    }
}

async function attachProfile(user) {
    if (!user) return user;
    const profile = await fetchProfile(user.id);
    user.username = profile?.username || '';
    user.usernameHistory = profile?.username_history || [];
    user.role = profile?.role || 'user';
    user.badges = await fetchBadges(user.id);
    user.displayBadges = Array.isArray(profile?.display_badges) ? profile.display_badges : [];
    // Set during the deletion grace period; see account-deletion.js. Null otherwise.
    user.deletionRequestedAt = profile?.deletion_requested_at || null;
    user.permissions = await fetchPermissions();
    await refreshBadgeDefinitions();
    return user;
}

// Fire-and-forget login record; IP is read server-side from the request
// headers, never sent by the client. Username sign-ins are already recorded
// by login-with-identifier.
async function recordAuthEvent(kind) {
    try {
        const client = await getClient();
        const { data: { session } } = await client.auth.getSession();
        if (!session) return;
        await client.functions.invoke('record-auth-event', { body: { kind } });
    } catch (e) {
        log.warn('AUTH', 'Could not record auth event', e);
    }
}

// ==================== role / permission helpers ====================
// UI-only checks - real enforcement lives in Supabase RLS policies, so these
// can't be bypassed by editing client JS.
function currentRole() {
    return state.user?.role || 'user';
}

// Falls back to role-name check only if the permissions call failed, so a
// hiccup can't strip a moderator's UI mid-session.
function perms() {
    return state.user?.permissions || null;
}

function isStaff() {
    const p = perms();
    if (p && Object.keys(p).length) return !!p.staff;
    return ['moderator', 'admin', 'developer'].includes(currentRole());
}

function isAdminOrDev() {
    const p = perms();
    if (p && Object.keys(p).length) return !!p.manage_badges;
    return ['admin', 'developer'].includes(currentRole());
}

function canDeleteAnyContent() {
    const p = perms();
    if (p && Object.keys(p).length) return !!p.delete_content;
    return isStaff();
}

// ==================== state ====================
// state.user/authReady are set inside initAuth(), not here at module
// top-level - auth.js and app.js import each other, so touching state here
// would throw before app.js's `state` export initializes.

// ==================== init ====================
// call once on boot; resolves once state.user is known.
function initAuth() {
    if (authInitPromise) return authInitPromise;
    state.user = null;
    state.authReady = false;
    authInitPromise = (async () => {
        const client = await getClient();
        const { data: { session } } = await client.auth.getSession();
        state.user = session?.user ? await attachProfile(mapUser(session.user)) : null;
        state.authReady = true;
        log.info('AUTH', 'Session restored', { loggedIn: !!state.user });
        updateAuthUI();
        // Not awaited - runs opportunistically on page load since there's no
        // server-side scheduler; see the account_deletion migration.
        api.sweepExpiredAccountDeletions?.();
        api.maybeAnnouncePendingDeletion?.();

        // Back from Google/Discord? An OAuth sign-up has no form, so terms
        // acceptance, display name and avatar are collected here - before
        // promptUsernameIfMissing below sees the account.
        if (await api.finishProviderRedirect?.()) updateAuthUI();

        // Say so explicitly - a rejected link landing on an ordinary page
        // would otherwise look like the site is broken.
        if (EMAIL_LINK.errorCode) {
            log.warn('AUTH', 'Email link rejected', EMAIL_LINK);
            const expired = /expired|otp_expired/i.test(EMAIL_LINK.errorCode + ' ' + EMAIL_LINK.errorDescription);
            api.showToast?.(
                expired
                    ? 'That link has expired. Please request a new one.'
                    : 'That link is no longer valid. Please request a new one.',
                'error'
            );
            if (EMAIL_LINK.type === 'recovery' || expired) openForgotPasswordModal();
        } else if (EMAIL_LINK.type === 'recovery' && state.user) {
            // working password-reset link: session is already live, just prompt for the new password.
            openSetNewPasswordModal();
        } else {
            promptUsernameIfMissing();
        }

        client.auth.onAuthStateChange(async (event, session) => {
            log.debug('AUTH', 'Auth state change', { event });
            const wasLoggedIn = !!state.user;
            state.user = session?.user ? await attachProfile(mapUser(session.user)) : null;
            updateAuthUI();

            if (event === 'SIGNED_IN' && !wasLoggedIn) {
                api.showToast?.(`Signed in as ${publicName(state.user)}`, 'success');
                // OAuth sign-ins never touch signUp()/signIn(), so this is
                // their only recording point. The edge function dedupes
                // within the same minute; `wasLoggedIn` keeps a token
                // refresh from counting as a fresh sign-in.
                recordAuthEvent('login');
                promptUsernameIfMissing();
                // last chance to cancel a pending deletion while the owner is confirmed present.
                api.maybeAnnouncePendingDeletion?.();
            }
            if (event === 'SIGNED_OUT') {
                api.showToast?.('Signed out', 'info');
            }
            if (event === 'PASSWORD_RECOVERY') {
                closeAuthModal();
                closeForgotPasswordModal();
                openSetNewPasswordModal();
            }
        });

        return state.user;
    })();
    return authInitPromise;
}

// ==================== actions ====================
// creates the auth account and claims the username; if the username is taken
// (race with another signup) the auth account still exists - caller should
// prompt for a new username rather than treat this as a failed signup.
async function signUp(username, password, email, tosAccepted) {
    if (!USERNAME_PATTERN.test(username)) {
        throw new Error('Username must be 3-20 characters: letters, numbers, and underscores only.');
    }
    const client = await getClient();
    const finalEmail = email && email.trim()
        ? email.trim()
        : `${crypto.randomUUID()}@${PLACEHOLDER_EMAIL_DOMAIN}`;

    if (!tosAccepted) throw new Error('You must agree to the Terms of Service to create an account.');
    const { data, error } = await client.auth.signUp({
        email: finalEmail,
        password,
        options: { data: { tos_accepted_at: new Date().toISOString() } }
    });
    if (error) { log.error('AUTH', 'Sign up failed', error); throw error; }
    log.info('AUTH', 'Sign up succeeded', { username });

    // only possible once a session exists (i.e. email confirmation is off or not required).
    if (data.session) {
        try {
            await setUsername(username);
        } catch (usernameError) {
            log.error('AUTH', 'Username claim failed after signup', usernameError);
            throw new Error(`Account created, but "${username}" is already taken. Please choose another username in Edit Profile.`);
        }
        recordAuthEvent('signup');
    }
    return data;
}

// Username logins go through the login-with-identifier edge function rather
// than a client-side email lookup: the old approach returned the real email
// to whoever asked, letting anyone harvest addresses by username. The edge
// function does the lookup and sign-in server-side and never returns the email.
async function signIn(identifier, password) {
    const client = await getClient();
    const trimmed = identifier.trim();

    if (trimmed.includes('@')) {
        const { data, error } = await client.auth.signInWithPassword({ email: trimmed, password });
        if (error) { log.error('AUTH', 'Sign in failed', error); throw new Error('Invalid username or password.'); }
        recordAuthEvent('login');
        return data;
    }

    const { data: result, error: fnError } = await client.functions.invoke('login-with-identifier', {
        body: { identifier: trimmed, password }
    });
    if (fnError || !result?.ok || !result?.session) {
        log.error('AUTH', 'Sign in failed', fnError || result);
        throw new Error(result?.error || 'Invalid username or password.');
    }

    const { data, error: setError } = await client.auth.setSession({
        access_token: result.session.access_token,
        refresh_token: result.session.refresh_token,
    });
    if (setError) { log.error('AUTH', 'Session hydration failed', setError); throw new Error('Invalid username or password.'); }
    return data;
}

async function signOut() {
    const client = await getClient();
    const { error } = await client.auth.signOut();
    if (error) { log.error('AUTH', 'Sign out failed', error); throw error; }
}

async function resetPassword(email) {
    const client = await getClient();
    const { error } = await client.auth.resetPasswordForEmail(email, {
        // not window.location.origin - on GitHub Pages the app lives under /<repo>/, so the bare origin 404s.
        redirectTo: routeUrl('')
    });
    if (error) throw error;
}

// accepts a username or email, like signIn(). Usernames resolve to an email
// server-side so the client never learns the address. Never throws for "no
// such account" - same generic confirmation prevents enumeration.
async function requestPasswordReset(identifier) {
    const trimmed = (identifier || '').trim();
    if (!trimmed) throw new Error('Enter your username or email.');

    if (trimmed.includes('@')) {
        await resetPassword(trimmed);
        return;
    }

    const client = await getClient();
    const { error } = await client.functions.invoke('request-password-reset', {
        // same redirect the email path uses - otherwise the link falls back
        // to the project's Site URL, which may not match where the request came from.
        body: { identifier: trimmed, redirectTo: routeUrl('') }
    });
    if (error) { log.error('AUTH', 'Password reset request failed', error); throw new Error('Something went wrong. Please try again.'); }
}

// called from the PASSWORD_RECOVERY branch below - the recovery session is
// already live (Supabase parses the tokens from the URL fragment), so this
// just sets the new password on top of it.
async function completePasswordReset(newPassword) {
    if (newPassword.length < 6) throw new Error('Password must be at least 6 characters.');
    const client = await getClient();
    const { error } = await client.auth.updateUser({ password: newPassword });
    if (error) { log.error('AUTH', 'Password update failed', error); throw error; }
}

function getCurrentUser() {
    return state.user;
}

function isLoggedIn() {
    return !!state.user;
}

// ==================== username & email ====================
// database (unique index + rate-limit trigger) is the real authority for
// changes; this just surfaces its errors in a friendly way.
// updateDisplayName/uploadAvatar only touch auth.users, so mapUser() always
// resets username to ''. Replacing state.user wholesale with mapUser(data.user)
// was wiping username/usernameHistory from local state after those calls -
// merge instead of replace.
function applySupabaseUser(supabaseUser) {
    const mapped = mapUser(supabaseUser);
    state.user = {
        ...mapped,
        username: state.user?.username || '',
        usernameHistory: state.user?.usernameHistory || [],
        displayBadges: state.user?.displayBadges || []
    };
    return state.user;
}

async function setUsername(username) {
    if (!USERNAME_PATTERN.test(username)) {
        throw new Error('Username must be 3-20 characters: letters, numbers, and underscores only.');
    }
    if (!state.user) throw new Error('You must be signed in.');
    const client = await getClient();
    const { error } = await client.from('profiles').upsert(
        { id: state.user.id, username },
        { onConflict: 'id' }
    );    if (error) {
        if (error.code === '23505') throw new Error('That username is already taken.');
        throw new Error(error.message || 'Could not update username.');
    }
    state.user.username = username;
    // mirror the db trigger's rate-limit bookkeeping locally so the hint updates immediately.
    state.user.usernameHistory = [...(state.user.usernameHistory || []), new Date().toISOString()];
    updateAuthUI();
    return state.user;
}

async function updateEmail(newEmail) {
    if (!state.user) throw new Error('You must be signed in.');
    const email = (newEmail || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Please enter a valid email address.');
    if (state.user.hasRealEmail && email === state.user.email?.toLowerCase()) {
        throw new Error("That's already your current email.");
    }
    const client = await getClient();

    // a malformed existing email can deadlock Supabase's secure-email-change
    // flow (it may require confirming the old address) - repair that case via
    // the narrowly-scoped RPC instead.
    const currentEmail = state.user.email || '';
    const currentLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(currentEmail);
    // synthetic placeholder domains must use the repair RPC instead of the normal email-change flow.
    const currentIsPlaceholder = /@(?:users\.woogidex\.invalid|no-email\.woogidex\.com)$/i.test(currentEmail);

    if (currentIsPlaceholder || (state.user.hasRealEmail && !currentLooksValid)) {
        const { data, error } = await client.rpc('repair_my_invalid_email', { new_email: email });
        if (error) {
            log.error('AUTH', 'Invalid email repair failed', error);
            if (/repair_my_invalid_email|function .* does not exist/i.test(error.message || '')) {
                throw new Error('Email repair is not configured yet. Run supabase-email-repair.sql in your Supabase SQL Editor.');
            }
            throw error;
        }
        if (data !== true) throw new Error('Could not repair the account email.');
        const { data: refreshed, error: refreshError } = await client.auth.refreshSession();
        if (refreshError) throw refreshError;
        if (refreshed?.user) {
            state.user = await attachProfile(mapUser(refreshed.user));
            updateAuthUI();
        }
        return true;
    }

    const { error } = await client.auth.updateUser({ email });
    if (error) { log.error('AUTH', 'Email update failed', error); throw error; }
    return true;
}

// reverts to a placeholder address (same scheme as username-only signups).
// requires a username, since that's then the only way back in. Supabase's
// secure-email-change confirms at the old address first, so state.user.email
// won't update until that's done and the session refreshes.
async function removeEmail() {
    if (!state.user) throw new Error('You must be signed in.');
    if (!state.user.hasRealEmail) throw new Error('This account has no email on file.');
    if (!state.user.username) throw new Error('Set a username first - you need a way to sign in once your email is removed.');

    // don't call auth.updateUser({ email }) here - Supabase treats that as an
    // email change and starts its confirmation flow. Removal goes through the
    // narrowly-scoped RPC instead.
    const client = await getClient();
    const { error } = await client.rpc('remove_my_email');
    if (error) {
        log.error('AUTH', 'Email removal failed', error);
        if (/remove_my_email|function .* does not exist/i.test(error.message || '')) {
            throw new Error('Email removal is not configured yet. Run supabase-remove-email.sql in your Supabase SQL Editor.');
        }
        throw error;
    }

    const { data: refreshed, error: refreshError } = await client.auth.refreshSession();
    if (refreshError) log.warn?.('AUTH', 'Session refresh after email removal failed', refreshError);
    if (refreshed?.user) {
        state.user = await attachProfile(mapUser(refreshed.user));
        updateAuthUI();
    } else {
        state.user.hasRealEmail = false;
        state.user.email = '';
    }
    log.info('AUTH', 'Email removed');
    return true;
}


const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const AVATAR_BUCKET = 'avatars';

// mirrors display_name/avatar_url onto the public `profiles` table, since
// other clients can't read someone else's user_metadata but profiles is
// publicly readable. Best-effort - failures here don't block the metadata update.
async function mirrorToProfile(fields) {
    if (!state.user) return;
    const client = await getClient();
    const { error } = await client.from('profiles').upsert({ id: state.user.id, ...fields }, { onConflict: 'id' });
    if (error) log.error('AUTH', 'Profile mirror failed', error);
    // display name/avatar/bio are all on the profile page, so the cache is now stale.
    else invalidateProfile(state.user.id);
}

async function updateDisplayName(displayName) {
    const client = await getClient();
    const { data, error } = await client.auth.updateUser({ data: { display_name: displayName } });
    if (error) { log.error('AUTH', 'Display name update failed', error); throw error; }
    applySupabaseUser(data.user);
    await mirrorToProfile({ display_name: displayName });
    updateAuthUI();
    return state.user;
}

// A 256px copy of the chosen file, small enough to live in the profile row and
// be read inline with it. Animated avatars are left alone -- drawing one onto a
// canvas keeps a single frame, and a still avatar for an animated upload is
// worse than falling back to the bucket URL, which still animates.
const AVATAR_DATA_PX = 256;

async function smallAvatarDataUri(file) {
    try {
        if (await frameCount(await blobToDataUri(file)) > 1) return null;
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, AVATAR_DATA_PX / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        // browsers that cannot encode webp return a png, which at 256px is
        // still comfortably inside the column's size check
        const uri = canvas.toDataURL('image/webp', 0.82);
        return uri.length <= 262144 ? uri : null;
    } catch (e) {
        log.warn('AUTH', 'Could not make a small avatar; falling back to the bucket URL', e);
        return null;
    }
}

function blobToDataUri(blob) {
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => resolve('');
        reader.readAsDataURL(blob);
    });
}

// uploads to avatars/<user_id>/avatar.<ext> (upsert), then stores the public URL on user metadata.
async function uploadAvatar(file) {
    if (!file) return null;
    if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.');
    if (file.size > AVATAR_MAX_BYTES) throw new Error('Image must be 2MB or smaller.');
    if (!state.user) throw new Error('You must be signed in.');

    const client = await getClient();
    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
    const path = `${state.user.id}/avatar.${ext}`;

    const { error: uploadError } = await client.storage
        .from(AVATAR_BUCKET)
        .upload(path, file, { upsert: true, cacheControl: '3600' });
    if (uploadError) { log.error('AUTH', 'Avatar upload failed', uploadError); throw uploadError; }

    const { data: { publicUrl } } = client.storage.from(AVATAR_BUCKET).getPublicUrl(path);
    // cache-bust so the new image shows immediately.
    const bustedUrl = `${publicUrl}?t=${Date.now()}`;

    const { data, error } = await client.auth.updateUser({ data: { avatar_url: bustedUrl } });
    if (error) { log.error('AUTH', 'Avatar URL save failed', error); throw error; }
    applySupabaseUser(data.user);
    // avatar_data is the copy everything actually renders: small, in the row,
    // and served masked so an avatar is not a plain image request any more (see
    // js/core/avatar.js). The bucket upload above stays as the fallback for
    // anyone who has not been through here since.
    await mirrorToProfile({ avatar_url: bustedUrl, avatar_data: await smallAvatarDataUri(file) });
    dropCachedAvatar(state.user.id);
    updateAuthUI();
    return state.user;
}

// ==================== UI ====================
// Terms modal moved to legal.js, alongside the /terms page, so both render
// the same terms.md without drifting.

// ==================== account gate ====================
// Reading the hub/profiles/published mons requires an account - the DB
// refuses those tables to anonymous callers (see require_sign_in_for_community
// migration), so this gate exists to explain why instead of showing an empty page.
// Remembers what the visitor wanted so it reopens after sign-in.
let pendingAfterSignIn = null;

/**
 * @param {string} reason shown to the visitor; say what they were trying to do
 * @param {Function} [resume] re-run once they are signed in
 * @returns {boolean} true if there is an account and the caller may continue
 */
function requireAccount(reason, resume = null) {
    if (state.user) return true;
    pendingAfterSignIn = typeof resume === 'function' ? resume : null;
    api.showToast?.(reason, 'info');
    openAuthModal('signin');
    return false;
}

async function resumeAfterSignIn() {
    const resume = pendingAfterSignIn;
    pendingAfterSignIn = null;
    if (!resume) return;
    try { await resume(); }
    catch (e) { log.error('AUTH', 'Could not reopen the page held over sign-in', e); }
}

function openAuthModal(mode = 'signin') {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    document.getElementById('auth-modal-error').textContent = '';
    document.getElementById('auth-identifier').value = '';
    document.getElementById('auth-email-optional').value = '';
    document.getElementById('auth-password').value = '';
    setAuthMode(mode);
    // unawaited - the password form must not wait on a network answer to become usable.
    api.renderAuthProviderButtons?.();
    modal.classList.add('active');
}

function closeAuthModal() {
    document.getElementById('auth-modal')?.classList.remove('active');
}

function setAuthMode(mode) {
    const title = document.getElementById('auth-modal-title');
    const submitBtn = document.getElementById('auth-submit-btn');
    const switchLink = document.getElementById('auth-switch-link');
    const modal = document.getElementById('auth-modal');
    const identifierLabel = document.getElementById('auth-identifier-label');
    const identifierInput = document.getElementById('auth-identifier');
    const emailRow = document.getElementById('auth-email-optional-row');
    const termsRow = document.getElementById('auth-terms-row');
    const signupNote = document.getElementById('auth-signup-note');
    const forgotLink = document.getElementById('auth-forgot-link');
    modal.dataset.mode = mode;
    if (mode === 'signup') {
        title.textContent = 'Create Account';
        submitBtn.textContent = 'Sign Up';
        switchLink.textContent = 'Already have an account? Sign in';
        identifierLabel.textContent = 'Username';
        identifierInput.placeholder = 'letters, numbers, underscore only';
        identifierInput.autocomplete = 'username';
        emailRow.style.display = 'block';
        termsRow.style.display = 'block';
        if (signupNote) signupNote.style.display = 'block';
        if (forgotLink) forgotLink.style.display = 'none';
    } else {
        title.textContent = 'Sign In';
        submitBtn.textContent = 'Sign In';
        switchLink.textContent = "Don't have an account? Sign up";
        identifierLabel.textContent = 'Username or Email';
        identifierInput.placeholder = 'your username or email';
        identifierInput.autocomplete = 'username';
        emailRow.style.display = 'none';
        termsRow.style.display = 'none';
        if (signupNote) signupNote.style.display = 'none';
        if (forgotLink) forgotLink.style.display = 'block';
        const termsCheckbox = document.getElementById('auth-terms-checkbox');
        if (termsCheckbox) termsCheckbox.checked = false;
    }
}

function toggleAuthMode() {
    const modal = document.getElementById('auth-modal');
    setAuthMode(modal.dataset.mode === 'signup' ? 'signin' : 'signup');
}

async function submitAuthForm() {
    const modal = document.getElementById('auth-modal');
    const mode = modal.dataset.mode;
    const identifier = document.getElementById('auth-identifier').value.trim();
    const email = document.getElementById('auth-email-optional').value.trim();
    const password = document.getElementById('auth-password').value;
    const tosAccepted = document.getElementById('auth-terms-checkbox')?.checked === true;
    const errorEl = document.getElementById('auth-modal-error');
    const submitBtn = document.getElementById('auth-submit-btn');
    errorEl.textContent = '';
    errorEl.style.color = '';

    if (!identifier || !password) { errorEl.textContent = `Username and password are required.`; return; }
    if (mode === 'signup' && !USERNAME_PATTERN.test(identifier)) {
        errorEl.textContent = 'Username must be 3-20 characters: letters, numbers, and underscores only.';
        return;
    }
    if (password.length < 6) { errorEl.textContent = 'Password must be at least 6 characters.'; return; }
    if (mode === 'signup' && !tosAccepted) { errorEl.textContent = 'Please agree to the Terms of Service.'; return; }

    submitBtn.disabled = true;
    submitBtn.textContent = mode === 'signup' ? 'Signing up…' : 'Signing in…';
    try {
        if (mode === 'signup') {
            const result = await signUp(identifier, password, email, tosAccepted);
            if (!result.session) {
                // email confirmation required by your Supabase project settings.
                errorEl.style.color = 'var(--success, #22c55e)';
                errorEl.textContent = "Check your email to confirm your account. Don't see it? Check your spam/junk folder.";
                submitBtn.disabled = false;
                submitBtn.textContent = 'Sign Up';
                return;
            }
        } else {
            await signIn(identifier, password);
        }
        closeAuthModal();
        await resumeAfterSignIn();
    } catch (e) {
        errorEl.style.color = '';
        errorEl.textContent = e.message || 'Something went wrong.';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = mode === 'signup' ? 'Sign Up' : 'Sign In';
    }
}

// ==================== forgot / reset password ====================
function openForgotPasswordModal() {
    closeAuthModal();
    const modal = document.getElementById('forgot-password-modal');
    if (!modal) return;
    const errorEl = document.getElementById('forgot-password-error');
    const identifierEl = document.getElementById('forgot-password-identifier');
    const form = document.getElementById('forgot-password-form');
    if (errorEl) { errorEl.textContent = ''; errorEl.style.color = ''; }
    if (identifierEl) identifierEl.value = '';
    if (form) form.style.display = 'block';
    modal.classList.add('active');
}

function closeForgotPasswordModal() {
    document.getElementById('forgot-password-modal')?.classList.remove('active');
}

async function submitForgotPasswordForm() {
    const identifier = document.getElementById('forgot-password-identifier')?.value.trim();
    const errorEl = document.getElementById('forgot-password-error');
    const submitBtn = document.getElementById('forgot-password-submit-btn');
    const form = document.getElementById('forgot-password-form');
    if (errorEl) { errorEl.textContent = ''; errorEl.style.color = ''; }
    if (!identifier) { if (errorEl) errorEl.textContent = 'Enter your username or email.'; return; }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending…'; }
    try {
        await requestPasswordReset(identifier);
    } catch (e) {
        // only throws for things worth surfacing (empty field, real failure)
        // - never "no such account", so this is safe to show as-is.
        if (errorEl) errorEl.textContent = e.message || 'Something went wrong.';
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Send Reset Link'; }
        return;
    }
    // same message regardless of outcome, so this can't be used to enumerate accounts.
    if (form) form.style.display = 'none';
    if (errorEl) {
        errorEl.style.color = 'var(--success, #22c55e)';
        errorEl.textContent = "If an account matches, we've sent a password reset link to its email address. Don't see it? Check your spam/junk folder.";
    }
}

function openSetNewPasswordModal() {
    const modal = document.getElementById('set-new-password-modal');
    if (!modal) return;
    document.getElementById('set-new-password-error').textContent = '';
    document.getElementById('set-new-password').value = '';
    document.getElementById('set-new-password-confirm').value = '';
    modal.classList.add('active');
}

function closeSetNewPasswordModal() {
    document.getElementById('set-new-password-modal')?.classList.remove('active');
}

async function submitSetNewPasswordForm() {
    const password = document.getElementById('set-new-password')?.value || '';
    const confirm = document.getElementById('set-new-password-confirm')?.value || '';
    const errorEl = document.getElementById('set-new-password-error');
    const submitBtn = document.getElementById('set-new-password-submit-btn');
    if (errorEl) errorEl.textContent = '';

    if (password.length < 6) { if (errorEl) errorEl.textContent = 'Password must be at least 6 characters.'; return; }
    if (password !== confirm) { if (errorEl) errorEl.textContent = 'Passwords do not match.'; return; }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }
    try {
        await completePasswordReset(password);
        closeSetNewPasswordModal();
        api.showToast?.('Password updated.', 'success');
    } catch (e) {
        if (errorEl) errorEl.textContent = e.message || 'Something went wrong.';
    } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Set Password'; }
    }
}

async function handleSignOutClick() {
    try {
        await signOut();
    } catch (e) {
        api.showToast?.('Sign out failed: ' + e.message, 'error');
    }
}

async function showProfileView(userId = null, options = {}) {
    if (!userId) {
        if (!state.user) { openAuthModal('signin'); return; }
        userId = state.user.id;
    }
    if (document.getElementById('editor-view')?.style.display !== 'none' && userId === state.user?.id) {
        await api.autoSave?.(true);
    }
    state.isCommunityPreview = false;
    api.exitCommunityRoute?.();
    const view = api.activateTopLevelView?.('profile-view');
    if (!view) return;
    state.profilePageUser = null;
    state.profilePageEditing = false;
    renderProfileLoading();
    try {
        await loadPublicProfile(userId);
        renderProfilePage();
        if (typeof lucide !== 'undefined') lucide.createIcons();
        closeSidebar?.();
        const username = state.profilePageUser?.username;
        if (username) replaceRoute(`profile/${encodeURIComponent(username)}`);
        document.title = `${state.profilePageUser?.display_name || username || 'Profile'} · Woogidex`;
    } catch (e) {
        log.error('AUTH', 'Profile page failed to load', e);
        renderProfileError(e?.message || 'Could not load this profile.');
        api.showToast?.('Could not load that profile.', 'error');
    }
}

// clears the /profile/<username> path when leaving the page, so reloading or
// sharing the URL doesn't land back on a profile already left. Called from
// everywhere that hides #profile-view.
function exitProfileRoute() {
    if (currentRoute().name === 'profile') replaceRoute('');
}

function openProfileModal() { return showProfileView(); }
function closeProfileModal() { api.showCollection?.(); }

function getProfileStateEl(id) {
    return document.getElementById(id);
}

// Profile lists are React islands; skeletons live in the same components as
// real content so they can't drift in shape.

function renderProfileLoading() {
    const view = document.getElementById('profile-view');
    const publicEl = document.getElementById('profile-public-content');
    const editEl = document.getElementById('profile-edit-content');
    if (!view) return;
    getProfileStateEl('profile-loading-state')?.remove();
    getProfileStateEl('profile-load-error-state')?.remove();
    if (editEl) editEl.style.display = 'none';
    // skeletons mirror the real elements' shape/position instead of a
    // loading message, so the swap to real content feels seamless.
    if (publicEl) publicEl.style.display = 'block';
    const editBtn = document.getElementById('profile-edit-btn');
    if (editBtn) editBtn.style.display = 'none';

    const avatar = document.getElementById('profile-public-avatar');
    const fallback = document.getElementById('profile-public-avatar-fallback');
    if (avatar) avatar.style.display = 'none';
    if (fallback) { fallback.textContent = ''; fallback.style.display = 'flex'; fallback.classList.add('skel', 'skel-circle'); }
    const heading = document.getElementById('profile-page-display-heading');
    if (heading) { heading.textContent = ''; heading.classList.add('skel', 'skel-text'); heading.style.width = '160px'; }
    const handle = document.getElementById('profile-page-handle');
    if (handle) { handle.textContent = ''; handle.classList.add('skel', 'skel-text'); handle.style.width = '100px'; }
    const bio = document.getElementById('profile-public-bio');
    if (bio) { bio.textContent = ''; bio.classList.add('skel', 'skel-text'); bio.style.width = '55%'; }
    const badges = document.getElementById('profile-public-badges');
    if (badges) { badges.innerHTML = '<span class="skel skel-pill" style="width:70px;"></span>'; badges.style.display = 'flex'; badges.classList.add('skel-card'); }
    const joined = document.getElementById('profile-public-joined');
    if (joined) { joined.textContent = ''; joined.classList.add('skel', 'skel-text'); joined.style.width = '90px'; joined.style.display = 'inline-block'; }
    const monsCount = document.getElementById('profile-mons-count');
    if (monsCount) { monsCount.textContent = ''; monsCount.classList.add('skel', 'skel-text'); monsCount.style.width = '46px'; monsCount.style.display = 'inline-block'; }

    mountIsland('profile-mons-grid', ProfileMons, { loading: true });
    mountIsland('profile-comments-list', ProfileComments, { loading: true });
    const inputBox = document.getElementById('profile-comment-box');
    if (inputBox) inputBox.style.display = 'none';
    const hint = document.getElementById('profile-comment-signin-hint');
    if (hint) hint.style.display = 'none';
}

function renderProfileError(message) {
    const view = document.getElementById('profile-view');
    const publicEl = document.getElementById('profile-public-content');
    const editEl = document.getElementById('profile-edit-content');
    const editBtn = document.getElementById('profile-edit-btn');
    if (!view) return;
    if (publicEl) publicEl.style.display = 'none';
    if (editEl) editEl.style.display = 'none';
    getProfileStateEl('profile-loading-state')?.remove();
    let errorEl = getProfileStateEl('profile-load-error-state');
    if (!errorEl) {
        errorEl = document.createElement('div');
        errorEl.id = 'profile-load-error-state';
        errorEl.className = 'profile-loading profile-load-error';
        view.appendChild(errorEl);
    }
    errorEl.innerHTML = `<strong>Couldn’t load this profile.</strong><span>${escapeHtml(message)}</span><button type="button" class="btn btn-secondary btn-sm" onclick="showProfileView()">Try Again</button>`;
    errorEl.style.display = 'flex';
    if (editBtn) editBtn.style.display = 'none';
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function withProfileTimeout(promise, label, ms = 8000) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out. Please try again.`)), ms);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}


// caches the four profile queries for a minute, so hopping back and forth
// between the hub and a profile doesn't re-run them all every time.
const PROFILE_MAX_AGE_MS = 60000;
const profileCache = new Map();     // user id -> { at:number, value:object }

/**
 * Drops a cached profile so the next open goes back to the server. Call after
 * anything that changes what a profile page shows.
 * @param {string} [userId] omit to clear every cached profile
 */
function invalidateProfile(userId) {
    if (userId) profileCache.delete(String(userId));
    else profileCache.clear();
}

async function loadPublicProfile(userId) {
    const key = String(userId);
    const cached = profileCache.get(key);
    if (cached && Date.now() - cached.at < PROFILE_MAX_AGE_MS) {
        log.debug('AUTH', 'Profile still fresh; not re-fetching', { userId: key });
        state.profilePageUser = cached.value;
        return state.profilePageUser;
    }
    const client = await getClient();
    await refreshBadgeDefinitions();

    let { data: profile, error: profileError } = await withProfileTimeout(
        client.from('profiles')
            .select('id, username, display_name, avatar_url, role, bio, display_badges, created_at')
            .eq('id', userId)
            .maybeSingle(),
        'Profile request'
    );

    if (profileError && /bio|display_badges|column .* does not exist/i.test(profileError.message || '')) {
        const fallback = await withProfileTimeout(
            client.from('profiles')
                .select('id, username, display_name, avatar_url, role, created_at')
                .eq('id', userId)
                .maybeSingle(),
            'Profile request'
        );
        profile = fallback.data ? { ...fallback.data, bio: '', display_badges: [] } : null;
        profileError = fallback.error;
    }
    if (profileError) throw profileError;
    if (!profile) throw new Error('Profile not found.');

    // loaded independently - a problem with comments must never block the header/gallery from rendering.
    let mons = [];
    let comments = [];
    try {
        // same egress fix as the hub feed: skip the full fakemon_data blob and
        // `artwork` (~176kB base64 each, ~17MB for a 100-mon gallery). The
        // thumbnail used to come through here too; it is an image, and an image
        // in this response is an image in the network panel, so every card now
        // takes the hub's lazy on-scroll path and gets a masked one.
        const result = await withProfileTimeout(
            client.from('published_mons')
                .select('id, user_id, published_at, fakemon_data->>name, fakemon_data->>type1, fakemon_data->>type2')
                .eq('user_id', userId)
                .order('published_at', { ascending: false })
                .limit(100),
            'Published Fakemon request'
        );
        if (result.error) console.warn('Could not load published mons:', result.error);
        else mons = (result.data || []).map(({ name, type1, type2, ...rest }) => ({ ...rest, fakemon_data: { name, type1, type2 } }));
    } catch (e) {
        console.warn('Could not load published mons:', e);
    }

    try {
        const result = await withProfileTimeout(
            client.from('profile_comments')
                .select('id, profile_id, user_id, body, created_at')
                .eq('profile_id', userId)
                .order('created_at', { ascending: true })
                .limit(200),
            'Profile comments request'
        );
        if (result.error) console.warn('Could not load profile comments:', result.error);
        else comments = result.data || [];
    } catch (e) {
        console.warn('Could not load profile comments:', e);
    }

    const ids = [...new Set(comments.map(c => c.user_id).filter(Boolean))];
    let authors = {};
    if (ids.length) {
        try {
            const result = await withProfileTimeout(
                client.from('profiles')
                    .select('id, username, display_name, avatar_url, role, display_badges')
                    .in('id', ids),
                'Comment authors request'
            );
            (result.data || []).forEach(x => { authors[x.id] = x; });
        } catch (e) {
            console.warn('Could not load comment authors:', e);
        }
    }

    state.profilePageUser = {
        ...profile,
        mons,
        comments: comments.map(c => ({ ...c, author: authors[c.user_id] || null }))
    };
    profileCache.set(key, { at: Date.now(), value: state.profilePageUser });
    return state.profilePageUser;
}

function editOwnProfile() {
    if (!state.user || state.profilePageUser?.id !== state.user.id) return;
    state.profilePageEditing = true;
    const editEl = document.getElementById('profile-edit-content');
    const publicEl = document.getElementById('profile-public-content');
    if (publicEl) publicEl.style.display = 'none';
    if (editEl) editEl.style.display = 'block';
    const editBtn = document.getElementById('profile-edit-btn');
    const backBtn = document.getElementById('profile-back-btn');
    const cancelBtn = document.getElementById('profile-edit-cancel-btn');
    const saveBtn = document.getElementById('profile-edit-save-btn');
    if (editBtn) editBtn.style.display = 'none';
    if (backBtn) backBtn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
    if (saveBtn) saveBtn.style.display = 'inline-flex';
    renderProfileEditForm();
    // refreshes every mounted Connected Accounts panel (see oauth.js), so
    // this stays current even if Settings was never opened this session.
    api.updateConnectedAccountsUI?.();
    document.getElementById('profile-display-name')?.focus();
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function cancelEditOwnProfile() {
    state.profilePageEditing = false;
    const backBtn = document.getElementById('profile-back-btn');
    const cancelBtn = document.getElementById('profile-edit-cancel-btn');
    const saveBtn = document.getElementById('profile-edit-save-btn');
    if (backBtn) backBtn.style.display = 'inline-flex';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (saveBtn) saveBtn.style.display = 'none';
    renderProfilePage();
}

function renderProfilePage() {
    const profile = state.profilePageUser;
    if (!profile) return;
    document.getElementById('profile-loading-state')?.remove();
    document.getElementById('profile-load-error-state')?.remove();
    const isOwn = !!state.user && state.user.id === profile.id;
    const publicEl = document.getElementById('profile-public-content');
    const editEl = document.getElementById('profile-edit-content');
    const editBtn = document.getElementById('profile-edit-btn');
    const backBtn = document.getElementById('profile-back-btn');
    const cancelBtn = document.getElementById('profile-edit-cancel-btn');
    const saveBtn = document.getElementById('profile-edit-save-btn');
    if (editBtn) editBtn.style.display = isOwn && !state.profilePageEditing ? 'inline-flex' : 'none';
    if (backBtn) backBtn.style.display = state.profilePageEditing ? 'none' : 'inline-flex';
    if (cancelBtn) cancelBtn.style.display = state.profilePageEditing ? 'inline-flex' : 'none';
    if (saveBtn) saveBtn.style.display = state.profilePageEditing ? 'inline-flex' : 'none';
    if (state.profilePageEditing && isOwn) {
        if (publicEl) publicEl.style.display = 'none';
        if (editEl) editEl.style.display = 'block';
        renderProfileEditForm();
        return;
    }
    if (publicEl) publicEl.style.display = 'block';
    if (editEl) editEl.style.display = 'none';

    const displayName = profile.display_name || profile.username || 'Profile';
    api.setPageTitle?.(`${displayName}'s Profile`);
    const heading = document.getElementById('profile-page-display-heading');
    const handle = document.getElementById('profile-page-handle');
    if (heading) { heading.classList.remove('skel', 'skel-text'); heading.style.width = ''; heading.textContent = displayName; }
    if (handle) { handle.classList.remove('skel', 'skel-text'); handle.style.width = ''; handle.textContent = profile.username ? '@' + profile.username : ''; }
    const avatar = document.getElementById('profile-public-avatar');
    const fallback = document.getElementById('profile-public-avatar-fallback');
    if (avatar) { paintAvatarInto(avatar.parentElement, profile.id, profile.avatar_url || ''); avatar.style.display = profile.avatar_url ? 'block' : 'none'; }
    if (fallback) { fallback.classList.remove('skel', 'skel-circle'); fallback.textContent = displayName.charAt(0).toUpperCase(); fallback.style.display = profile.avatar_url ? 'none' : 'flex'; }
    const bio = document.getElementById('profile-public-bio');
    if (bio) { bio.classList.remove('skel', 'skel-text'); bio.style.width = ''; bio.textContent = profile.bio || 'No bio yet.'; }
    const badges = document.getElementById('profile-public-badges');
    if (badges) {
        badges.classList.remove('skel-card');
        const hasBadges = Array.isArray(profile.display_badges) && profile.display_badges.length;
        badges.innerHTML = hasBadges && api.renderBadgeRow ? api.renderBadgeRow(profile.display_badges, 18) : '';
        badges.style.display = hasBadges ? 'flex' : 'none';
    }
    const joined = document.getElementById('profile-public-joined');
    if (joined) {
        joined.classList.remove('skel', 'skel-text');
        joined.style.width = '';
        joined.style.display = '';
        joined.textContent = profile.created_at ? `Joined ${new Date(profile.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })}` : '';
    }
    // connected-provider row: only populated on your own profile, since
    // Supabase's SDK can list your own linked identities but not anyone else's.
    const connected = document.getElementById('profile-connected-badges');
    if (connected) {
        if (isOwn) {
            api.renderConnectedBadgesHtml?.().then(html => {
                // re-check the element exists - the page may have re-rendered
                // or navigated away before this async call resolves.
                const el = document.getElementById('profile-connected-badges');
                if (!el) return;
                el.innerHTML = html;
                el.style.display = html ? 'flex' : 'none';
                if (typeof lucide !== 'undefined') lucide.createIcons();
            });
        } else {
            connected.style.display = 'none';
            connected.innerHTML = '';
        }
    }
    const monsCount = document.getElementById('profile-mons-count');
    if (monsCount) {
        monsCount.classList.remove('skel', 'skel-text');
        monsCount.style.width = '';
        monsCount.style.display = '';
        monsCount.textContent = `${profile.mons.length} ${profile.mons.length === 1 ? 'mon' : 'mons'}`;
    }
    renderPublicProfileMons();
    renderProfileComments();
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderProfileEditForm() {
    const profile = state.profilePageUser;
    if (!profile || !state.user || state.user.id !== profile.id) return;
    const heading = document.getElementById('profile-page-display-heading');
    const handle = document.getElementById('profile-page-handle');
    if (heading) heading.textContent = profile.display_name || profile.username || 'Profile';
    if (handle) handle.textContent = profile.username ? '@' + profile.username : 'Choose a username';
    const nameInput = document.getElementById('profile-display-name');
    if (nameInput) nameInput.value = state.user.displayName || '';
    const bioInput = document.getElementById('profile-bio');
    if (bioInput) bioInput.value = profile.bio || '';
    const avatarInput = document.getElementById('profile-avatar-file');
    if (avatarInput) avatarInput.value = '';
    setProfilePreview(state.user.avatarUrl);
    const usernameInput = document.getElementById('profile-username');
    if (usernameInput) usernameInput.value = state.user.username || '';
    const usernameHint = document.getElementById('profile-username-hint');
    if (usernameHint) usernameHint.textContent = usernameChangesRemainingText(state.user.usernameHistory);
    const emailInput = document.getElementById('profile-email');
    if (emailInput) {
        emailInput.value = state.user.hasRealEmail ? state.user.email : '';
        emailInput.placeholder = state.user.hasRealEmail ? '' : 'No email on file - add one for account recovery';
    }
    const removeBtn = document.getElementById('profile-email-remove-btn');
    if (removeBtn) removeBtn.style.display = state.user.hasRealEmail ? 'inline-block' : 'none';
    renderProfileBadgeSelection();
}

function renderPublicProfileMons() {
    if (!state.profilePageUser) return;
    mountIsland('profile-mons-grid', ProfileMons, {
        mons: state.profilePageUser.mons || [],
        // shared with the community module on purpose - the same Fakemon row shouldn't be fetched twice.
        requestArtwork: api.requestCardArtwork
    });
}

async function submitProfileComment() {
    if (!state.user || !state.profilePageUser) { openAuthModal('signin'); return; }
    const input = document.getElementById('profile-comment-input');
    const errorEl = document.getElementById('profile-comment-error');
    const text = input?.value.trim() || '';
    if (!text) return;
    if (text.length > 1000) { if (errorEl) errorEl.textContent = 'Comments are limited to 1000 characters.'; return; }
    if (errorEl) errorEl.textContent = '';

    // blocklist scan + mute/ban check before the write, so a refusal is
    // explained here rather than surfacing as a raw Postgres error.
    if (!(await api.guardContent?.(text, 'profile comment') ?? true)) return;

    const client = await getClient();
    const { error } = await client.from('profile_comments').insert({ profile_id: state.profilePageUser.id, user_id: state.user.id, body: text });
    if (error) {
        const friendly = api.friendlyModerationError?.(error);
        if (errorEl) errorEl.textContent = friendly || error.message || 'Could not post comment.';
        return;
    }
    input.value = '';
    invalidateProfile(state.profilePageUser.id);
    await loadPublicProfile(state.profilePageUser.id);
    renderProfilePage();

    api.createNotification?.({
        userId: state.profilePageUser.id,
        actorId: state.user.id,
        actorName: publicName(state.user),
        actorAvatarUrl: state.user.avatarUrl || null,
        type: 'profile_comment',
        targetId: state.profilePageUser.id,
        preview: text
    });
}

async function deleteProfileComment(commentId) {
    if (!state.user) return;
    const client = await getClient();
    let query = client.from('profile_comments').delete().eq('id', commentId);
    if (!isStaff()) query = query.eq('user_id', state.user.id);
    const { error } = await query;
    if (error) { api.showToast?.('Could not delete comment: ' + error.message, 'error'); return; }
    invalidateProfile(state.profilePageUser.id);
    await loadPublicProfile(state.profilePageUser.id);
    renderProfilePage();
}

function renderProfileComments() {
    const inputBox = document.getElementById('profile-comment-box');
    const hint = document.getElementById('profile-comment-signin-hint');
    if (!state.profilePageUser) return;
    if (inputBox) inputBox.style.display = state.user ? 'flex' : 'none';
    if (hint) hint.style.display = state.user ? 'none' : 'block';
    mountIsland('profile-comments-list', ProfileComments, {
        comments: state.profilePageUser.comments || [],
        viewerId: state.user?.id || null,
        viewerIsStaff: isStaff()
    });
}


// ==================== user hover card ====================
let userHoverCardEl = null;
let userHoverTimer = null;
let userHoverRequest = 0;

function ensureUserHoverCard() {
    if (userHoverCardEl) return userHoverCardEl;
    userHoverCardEl = document.createElement('div');
    userHoverCardEl.id = 'user-hover-card';
    userHoverCardEl.className = 'user-hover-card';
    userHoverCardEl.style.display = 'none';
    document.body.appendChild(userHoverCardEl);
    userHoverCardEl.addEventListener('mouseenter', () => clearTimeout(userHoverTimer));
    userHoverCardEl.addEventListener('mouseleave', scheduleHideUserHoverCard);
    return userHoverCardEl;
}

function scheduleHideUserHoverCard() {
    clearTimeout(userHoverTimer);
    userHoverTimer = setTimeout(() => {
        if (userHoverCardEl) userHoverCardEl.style.display = 'none';
    }, 120);
}

function positionUserHoverCard(anchor) {
    const card = ensureUserHoverCard();
    const rect = anchor.getBoundingClientRect();
    const gap = 10;
    card.style.display = 'block';
    card.style.visibility = 'hidden';
    const width = card.offsetWidth || 300;
    const height = card.offsetHeight || 180;
    let left = rect.left;
    let top = rect.bottom + gap;
    if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
    if (left < 12) left = 12;
    if (top + height > window.innerHeight - 12) top = rect.top - height - gap;
    if (top < 12) top = 12;
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.visibility = 'visible';
}

function renderUserHoverCard(profile) {
    const card = ensureUserHoverCard();
    mountIsland(card, UserHoverCard, { profile });
}

async function showUserHoverCard(userId, anchor) {
    if (!userId || !anchor) return;
    clearTimeout(userHoverTimer);
    const requestId = ++userHoverRequest;
    const card = ensureUserHoverCard();
    mountIsland(card, UserHoverCard, { loading: true });
    positionUserHoverCard(anchor);
    try {
        const client = await getClient();
        let { data: profile, error } = await client
            .from('profiles')
            .select('id, username, display_name, avatar_url, bio, created_at, display_badges')
            .eq('id', userId)
            .maybeSingle();
        if (error) throw error;
        if (!profile || requestId !== userHoverRequest) return;
        renderUserHoverCard(profile);
        positionUserHoverCard(anchor);
    } catch (e) {
        if (requestId !== userHoverRequest) return;
        // preview just doesn't appear on failure - nothing worth surfacing.
        card.style.display = 'none';
    }
}

document.addEventListener('mouseover', event => {
    const anchor = event.target.closest('.community-author-link, .mon-comment-author, .profile-comment-header');
    if (!anchor || !anchor.closest('body') || anchor.contains(event.relatedTarget)) return;
    const match = anchor.getAttribute('onclick')?.match(/showUserProfile\('([^']+)'\)/);
    const userId = match?.[1] || anchor.closest('[data-user-id]')?.dataset.userId;
    if (!userId) return;
    clearTimeout(userHoverTimer);
    userHoverTimer = setTimeout(() => showUserHoverCard(userId, anchor), 250);
});

document.addEventListener('mouseout', event => {
    const anchor = event.target.closest('.community-author-link, .mon-comment-author, .profile-comment-header');
    if (!anchor || anchor.contains(event.relatedTarget)) return;
    scheduleHideUserHoverCard();
});

document.addEventListener('scroll', () => {
    if (userHoverCardEl && userHoverCardEl.style.display !== 'none') userHoverCardEl.style.display = 'none';
}, true);

async function showUserProfile(userIdOrUsername) {
    // same wall as the hub - an anonymous read returns nothing, which would misleadingly show as "not found".
    if (!api.requireAccount?.('Sign in to view profiles.',
        () => showUserProfile(userIdOrUsername))) return;
    try {
        const client = await getClient();
        const value = String(userIdOrUsername || '').trim();
        if (!value) { api.showToast?.('Profile not found.', 'error'); return; }

        // profiles.id is a UUID - a username through eq('id', ...) gets
        // rejected by PostgREST with a 400 before we can fall back.
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
        let targetId = null;

        if (isUuid) {
            const { data: byId, error: idError } = await client
                .from('profiles')
                .select('id')
                .eq('id', value)
                .maybeSingle();
            if (idError) throw idError;
            targetId = byId?.id || null;
        }

        if (!targetId) {
            const { data: byUsername, error: usernameError } = await client
                .from('profiles')
                .select('id')
                .eq('username', value)
                .maybeSingle();
            if (usernameError) throw usernameError;
            targetId = byUsername?.id || null;
        }

        if (!targetId) { api.showToast?.('Profile not found.', 'error'); return; }
        await showProfileView(targetId);
    } catch (e) {
        log.error('AUTH', 'Profile page failed to load', e);
        api.showToast?.('Could not load that profile.', 'error');
    }
}

/**
 * Opens the profile a /profile/<username> URL names. The caller has already
 * parsed the route, so this takes the username rather than reading the URL.
 * @param {string} username
 * @returns {Promise<boolean>} whether it opened
 */
async function handleProfileRoute(username) {
    const name = String(username || '').trim();
    if (!name) return false;
    await showUserProfile(name);
    return true;
}

// client-side estimate only, for UX - the db trigger is the real enforcement (see setUsername).
function usernameChangesRemainingText(history) {
    const recent = (history || []).filter(t => Date.now() - new Date(t).getTime() < 7 * 24 * 60 * 60 * 1000);
    const remaining = Math.max(0, 2 - recent.length);
    return remaining > 0
        ? `${remaining} username change${remaining === 1 ? '' : 's'} left this week.`
        : 'No username changes left this week.';
}


function setProfilePreview(url) {
    const img = document.getElementById('profile-avatar-preview');
    const placeholder = document.getElementById('profile-avatar-placeholder');
    if (!img) return;
    if (url) {
        img.src = url;
        img.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
    } else {
        img.style.display = 'none';
        if (placeholder) placeholder.style.display = 'flex';
    }
}

function onProfileAvatarFileChosen(input) {
    const file = input.files?.[0];
    const errorEl = document.getElementById('profile-modal-error');
    errorEl.textContent = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { errorEl.textContent = 'Please choose an image file.'; input.value = ''; return; }
    if (file.size > AVATAR_MAX_BYTES) { errorEl.textContent = `Image is ${(file.size / 1024 / 1024).toFixed(1)}MB - max is 2MB.`; input.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => setProfilePreview(reader.result);
    reader.readAsDataURL(file);
}

function renderProfileBadgeSelection() {
    const count = document.getElementById('profile-badge-count');
    if (!state.user) return;
    const owned = Array.isArray(state.user.badges) ? state.user.badges : [];
    // drops any selected badge no longer owned, so a revoked badge can't linger.
    const selected = (Array.isArray(state.user.displayBadges) ? state.user.displayBadges : owned)
        .filter(key => owned.includes(key));
    if (count) count.textContent = `${selected.length} of ${owned.length} shown`;
    mountIsland('profile-badges-list', BadgePicker, { owned, selected });
}

async function submitDisplayedBadges() {
    const errorEl = document.getElementById('profile-badges-error');
    const btn = document.getElementById('profile-badges-submit-btn');
    if (!state.user) return;
    const checked = [...document.querySelectorAll('#profile-badges-list input[type="checkbox"]:checked')].map(el => el.dataset.badge);
    if (errorEl) { errorEl.textContent = ''; errorEl.style.color = ''; }
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        const client = await getClient();
        const owned = new Set(state.user.badges || []);
        const valid = checked.filter(key => owned.has(key));
        const { error } = await client.from('profiles').upsert(
            { id: state.user.id, display_badges: valid },
            { onConflict: 'id' }
        );
        if (error) throw error;
        state.user.displayBadges = valid;
        invalidateProfile(state.user.id);
        renderProfileBadgeSelection();
        updateAuthUI();
        if (errorEl) { errorEl.style.color = 'var(--success, #22c55e)'; errorEl.textContent = 'Badge display updated.'; }
        api.showToast?.('Badge display updated', 'success');
    } catch (e) {
        if (errorEl) errorEl.textContent = e.message || 'Could not update badge display.';
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Save Badge Display'; }
    }
}

async function submitProfileForm() {
    const errorEl = document.getElementById('profile-modal-error');
    const submitBtn = document.getElementById('profile-submit-btn');
    const displayName = document.getElementById('profile-display-name').value.trim();
    const fileInput = document.getElementById('profile-avatar-file');
    const file = fileInput.files?.[0] || null;
    errorEl.textContent = '';

    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';
    const headerSaveBtn = document.getElementById('profile-edit-save-btn');
    if (headerSaveBtn) { headerSaveBtn.disabled = true; headerSaveBtn.textContent = 'Saving…'; }
    try {
        const bio = document.getElementById('profile-bio')?.value.trim() || '';
        // a display name and a bio are as public as a comment, so they go
        // through the same filter.
        if (!(await api.guardContent?.(`${displayName} ${bio}`, 'profile') ?? true)) return;
        if (file) await uploadAvatar(file);
        await updateDisplayName(displayName);
        const client = await getClient();
        invalidateProfile(state.user.id);
        const { error: bioError } = await client.from('profiles').upsert({ id: state.user.id, bio }, { onConflict: 'id' });
        if (bioError) throw bioError;
        state.profilePageEditing = false;
        await loadPublicProfile(state.user.id);
        api.showToast?.('Profile updated', 'success');
        renderProfilePage();
    } catch (e) {
        errorEl.textContent = e.message || 'Something went wrong.';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save Profile';
        const headerSaveBtn = document.getElementById('profile-edit-save-btn');
        if (headerSaveBtn) { headerSaveBtn.disabled = false; headerSaveBtn.innerHTML = '<i data-lucide="save"></i> Save Profile'; if (typeof lucide !== 'undefined') lucide.createIcons(); }
    }
}

async function submitUsernameForm() {
    const errorEl = document.getElementById('profile-username-error');
    const submitBtn = document.getElementById('profile-username-submit-btn');
    const username = document.getElementById('profile-username').value.trim();
    errorEl.textContent = '';
    errorEl.style.color = '';

    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';
    try {
        await setUsername(username);
        invalidateProfile(state.user.id);
        document.getElementById('profile-username-hint').textContent = usernameChangesRemainingText(state.user.usernameHistory);
        renderProfilePage();
        errorEl.style.color = 'var(--success, #22c55e)';
        errorEl.textContent = 'Username updated.';
    } catch (e) {
        errorEl.textContent = e.message || 'Could not update username.';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save Username';
    }
}

async function submitEmailForm() {
    const errorEl = document.getElementById('profile-email-error');
    const submitBtn = document.getElementById('profile-email-submit-btn');
    const email = document.getElementById('profile-email').value.trim();
    errorEl.textContent = '';
    errorEl.style.color = '';

    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';
    try {
        await updateEmail(email);
        errorEl.style.color = 'var(--success, #22c55e)';
        errorEl.textContent = 'Email updated. If confirmation is required, check your inbox.';
    } catch (e) {
        errorEl.textContent = e.message || 'Could not update email.';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save Email';
    }
}

async function submitRemoveEmail() {
    const errorEl = document.getElementById('profile-email-error');
    const removeBtn = document.getElementById('profile-email-remove-btn');
    errorEl.textContent = '';
    errorEl.style.color = '';

    if (!state.user?.username) {
        errorEl.textContent = 'Set a username first - you need a way to sign in once your email is removed.';
        return;
    }
    if (!confirm('Remove the email from this account? You will only be able to sign in with your username afterward.')) return;

    removeBtn.disabled = true;
    removeBtn.textContent = 'Removing…';
    try {
        await removeEmail();
        errorEl.style.color = 'var(--success, #22c55e)';
        errorEl.textContent = 'Check your current inbox to confirm removal - it takes effect once confirmed.';
    } catch (e) {
        errorEl.textContent = e.message || 'Could not remove email.';
    } finally {
        removeBtn.disabled = false;
        removeBtn.textContent = 'Remove Email';
    }
}

function updateAuthUI() {
    const signedOutEl = document.getElementById('auth-signed-out');
    const signedInEl = document.getElementById('auth-signed-in');
    const nameEl = document.getElementById('auth-user-name');
    const avatarImg = document.getElementById('auth-avatar-img');
    const avatarFallback = document.getElementById('auth-avatar-fallback');
    const sidebarAuthBtn = document.getElementById('sidebar-auth-btn');
    const headerSigninBtn = document.getElementById('header-signin-btn');
    const headerProfileWrap = document.getElementById('header-profile-wrap');
    const headerAvatarImg = document.getElementById('header-profile-avatar-img');
    const headerAvatarFallback = document.getElementById('header-profile-avatar-fallback');
    const popoverName = document.getElementById('header-profile-popover-name');
    const popoverUsername = document.getElementById('header-profile-popover-username');
    const popoverAvatarImg = document.getElementById('header-profile-popover-avatar-img');
    const popoverAvatarFallback = document.getElementById('header-profile-popover-avatar-fallback');
    // header avatar+popover is now the source of truth for sign-in controls
    // (previously a sidebar widget); signedOutEl/signedInEl stay optional for
    // pages like admin.html that still have them.
    api.refreshNotifications?.();
    // re-read whenever the signed-in user changes (including sign-out, which
    // must clear it), since the cloud-backup badge depends on it.
    api.refreshCloudManifest?.();
    if (state.user) {
        if (signedOutEl) signedOutEl.style.display = 'none';
        if (signedInEl) signedInEl.style.display = 'flex';
        if (nameEl) nameEl.textContent = publicName(state.user);
        if (headerSigninBtn) headerSigninBtn.style.display = 'none';
        if (headerProfileWrap) headerProfileWrap.style.display = '';
        const initial = (state.user.displayName || state.user.username || '?').charAt(0).toUpperCase();
        if (headerAvatarImg && headerAvatarFallback) {
            if (state.user.avatarUrl) { paintAvatarInto(headerAvatarImg.parentElement, state.user.id, state.user.avatarUrl); headerAvatarImg.style.display = 'block'; headerAvatarFallback.style.display = 'none'; }
            else { headerAvatarImg.style.display = 'none'; headerAvatarFallback.style.display = 'flex'; headerAvatarFallback.textContent = initial; }
        }
        if (popoverAvatarImg && popoverAvatarFallback) {
            if (state.user.avatarUrl) { paintAvatarInto(popoverAvatarImg.parentElement, state.user.id, state.user.avatarUrl); popoverAvatarImg.style.display = 'block'; popoverAvatarFallback.style.display = 'none'; }
            else { popoverAvatarImg.style.display = 'none'; popoverAvatarFallback.style.display = 'flex'; popoverAvatarFallback.textContent = initial; }
        }
        if (popoverName) {
            const nameText = state.user.displayName || state.user.username || 'Profile';
            const nameSafe = esc(nameText);
            popoverName.innerHTML = `${nameSafe}` + (api.renderBadgeRow ? api.renderBadgeRow(state.user.displayBadges || [], 12) : '');
        }
        if (popoverUsername) popoverUsername.textContent = state.user.username ? '@' + state.user.username : 'Edit profile';
        if (sidebarAuthBtn) { sidebarAuthBtn.innerHTML = '<i data-lucide="log-out"></i><span>Sign Out</span>'; sidebarAuthBtn.onclick = () => { handleSignOutClick(); closeSidebar(); }; }
        if (typeof lucide !== 'undefined') lucide.createIcons();
        if (avatarImg && avatarFallback) {
            if (state.user.avatarUrl) {
                avatarImg.src = state.user.avatarUrl;
                avatarImg.style.display = 'block';
                avatarFallback.style.display = 'none';
            } else {
                avatarImg.style.display = 'none';
                avatarFallback.style.display = 'flex';
                avatarFallback.textContent = publicName(state.user).charAt(0).toUpperCase();
            }
        }
    } else {
        if (signedOutEl) signedOutEl.style.display = 'flex';
        if (signedInEl) signedInEl.style.display = 'none';
        if (headerProfileWrap) { headerProfileWrap.style.display = 'none'; closeHeaderProfilePopover(); }
        if (headerSigninBtn) headerSigninBtn.style.display = '';
        if (sidebarAuthBtn) { sidebarAuthBtn.innerHTML = '<i data-lucide="log-in"></i><span>Sign In</span>'; sidebarAuthBtn.onclick = () => { openAuthModal('signin'); closeSidebar(); }; }
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
}

// ==================== header account popover ====================
// same show/hide-on-outside-click pattern as the notifications bell panel.
function closeHeaderProfilePopoverOnOutsideClick(e) {
    const wrap = document.getElementById('header-profile-wrap');
    if (wrap && !wrap.contains(e.target)) closeHeaderProfilePopover();
}

function toggleHeaderProfilePopover(event) {
    event?.stopPropagation();
    const btn = document.getElementById('header-profile-btn');
    const popover = document.getElementById('header-profile-popover');
    if (!popover || !btn) return;
    const open = popover.style.display === 'none' || !popover.style.display;
    popover.style.display = open ? 'block' : 'none';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
        document.addEventListener('click', closeHeaderProfilePopoverOnOutsideClick);
        if (typeof lucide !== 'undefined') lucide.createIcons();
    } else {
        document.removeEventListener('click', closeHeaderProfilePopoverOnOutsideClick);
    }
}

function closeHeaderProfilePopover() {
    const btn = document.getElementById('header-profile-btn');
    const popover = document.getElementById('header-profile-popover');
    if (popover) popover.style.display = 'none';
    btn?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', closeHeaderProfilePopoverOnOutsideClick);
}

// accounts can lack a username (pre-username-requirement accounts, or a
// failed claim during signup - see signUp's catch block); nudge them to the
// profile page's username field once signed in.
function promptUsernameIfMissing() {
    if (!state.user || state.user.username) return;
    api.showToast?.('Please choose a username to finish setting up your account.', 'warning');
    showProfileView();
    // give the profile page a tick to render before focusing/scrolling to the field.
    setTimeout(() => {
        const errorEl = document.getElementById('profile-username-error');
        if (errorEl) {
            errorEl.style.color = 'var(--warning, #eab308)';
            errorEl.textContent = 'Choose a username to finish setting up your account.';
        }
        // OAuth sign-ins bring a handle along; offering it as a starting point saves a naming decision under pressure.
        const field = document.getElementById('profile-username');
        const suggestion = api.suggestedUsername?.();
        if (field && !field.value && suggestion) field.value = suggestion;
        field?.focus();
    }, 0);
}

export {
    initAuth, getClient, signUp, signIn, signOut, resetPassword, requestPasswordReset, completePasswordReset,
    getCurrentUser, isLoggedIn, updateDisplayName, uploadAvatar,
    setUsername, updateEmail, removeEmail, fetchProfile,
    openAuthModal, closeAuthModal, toggleAuthMode, submitAuthForm,
    openForgotPasswordModal, closeForgotPasswordModal, submitForgotPasswordForm,
    openSetNewPasswordModal, closeSetNewPasswordModal, submitSetNewPasswordForm,
    requireAccount, invalidateProfile,
    showProfileView, showUserProfile, handleProfileRoute, exitProfileRoute, editOwnProfile, cancelEditOwnProfile, openProfileModal, closeProfileModal, onProfileAvatarFileChosen, submitProfileForm, renderProfilePage, renderProfileLoading, submitDisplayedBadges, submitProfileComment, deleteProfileComment,
    submitUsernameForm, submitEmailForm, submitRemoveEmail,
    handleSignOutClick, updateAuthUI, promptUsernameIfMissing,
    toggleHeaderProfilePopover, closeHeaderProfilePopover,
    fetchBadges, currentRole, isStaff, isAdminOrDev, canDeleteAnyContent,
    fetchPermissions, recordAuthEvent
};