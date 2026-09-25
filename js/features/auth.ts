import { getClient } from '../core/supabase.ts';
import { dropCachedAvatar } from '../core/avatar.ts';
import { frameCount } from '../core/art-shield.ts';
import { esc, publicName } from '../core/html.ts';
import { log } from '../core/log.ts';
import { state, api } from '../core/app.ts';
import { confirmDialog } from '../core/confirm-dialog.ts';
import { renderCommentMarkdown } from '../core/data.ts';
import { navigateRoute, routeUrl, emailLinkParams } from '../core/router.ts';
import { mountIsland } from '../app/island.tsx';
import { UserHoverCard } from '../app/components/profile.tsx';
import { notify } from '../app/store.ts';
import { closeDialog, openDialog } from '../app/dialogs.tsx';

// ==================== Supabase client ====================
// loaded from CDN as an es module - no npm/bundler needed.
// TODO: replace with your project's values (Supabase dashboard -> project settings -> API).

let authInitPromise: any = null;


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
        // an 'email' identity is what signInWithPassword checks against;
        // OAuth-only accounts have none until they set a password.
        hasPassword: (supabaseUser.identities || []).some(i => i.provider === 'email'),
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
        const { data, error } = await client.from('badges').select('key, label, icon, icon_image, color, description, rank').order('rank', { ascending: false });
        if (error) throw error;
        api.setBadgeDefinitions?.(data || []);
        return data || [];
    } catch (e: any) {
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
    } catch (e: any) {
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
    // Set during the deletion grace period; see account-deletion.ts. Null otherwise.
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
    } catch (e: any) {
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
// top-level - auth.ts and app.ts import each other, so touching state here
// would throw before app.ts's `state` export initializes.

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
            // Supabase re-emits here for things that change no identity at all:
            // INITIAL_SESSION right after this listener is registered (initAuth
            // has already painted that same session above), TOKEN_REFRESHED on
            // its refresh timer, and a SIGNED_IN replay whenever the tab regains
            // focus. Each one used to re-run attachProfile() and updateAuthUI(),
            // and updateAuthUI() calls refreshCloudManifest(), which re-renders
            // the whole collection grid -- so the UI visibly rebuilt itself
            // several times on load and again on every tab switch.
            const sameUser = (session?.user?.id || null) === (state.user?.id || null);
            const identityUnchanged = sameUser && ['INITIAL_SESSION', 'TOKEN_REFRESHED', 'SIGNED_IN'].includes(event);
            if (identityUnchanged && state.authReady) {
                log.debug('AUTH', 'Auth state change ignored; same user', { event });
                return;
            }
            state.user = session?.user ? await attachProfile(mapUser(session.user)) : null;
            updateAuthUI();

            if (event === 'SIGNED_IN' && !wasLoggedIn) {
                if (!signupInProgress) api.showToast?.(`Signed in as ${publicName(state.user)}`, 'success');
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
// Set while signUp() runs. client.auth.signUp() emits SIGNED_IN before the
// username below is claimed, so the listener would otherwise see a nameless
// account and ask for the username the form just collected.
let signupInProgress = false;

async function signUp(username, password, email, tosAccepted) {
    if (!USERNAME_PATTERN.test(username)) {
        throw new Error('Username must be 3-20 characters: letters, numbers, and underscores only.');
    }
    signupInProgress = true;
    try {
        return await createAccount(username, password, email, tosAccepted);
    } finally {
        signupInProgress = false;
    }
}

async function createAccount(username, password, email, tosAccepted) {
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
        } catch (usernameError: any) {
            log.error('AUTH', 'Username claim failed after signup', usernameError);
            // the account exists now, so the setup modal is the way forward.
            signupInProgress = false;
            closeAuthModal();
            promptUsernameIfMissing(`Account created, but "${username}" is already taken. Please choose another.`);
            return data;
        }
        api.showToast?.(`Welcome to Woogidex, ${username}!`, 'success');
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
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        // browsers that cannot encode webp return a png, which at 256px is
        // still comfortably inside the column's size check
        const uri = canvas.toDataURL('image/webp', 0.82);
        return uri.length <= 262144 ? uri : null;
    } catch (e: any) {
        log.warn('AUTH', 'Could not make a small avatar; falling back to the bucket URL', e);
        return null;
    }
}

function blobToDataUri(blob): Promise<string> {
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
    // js/core/avatar.ts). The bucket upload above stays as the fallback for
    // anyone who has not been through here since.
    await mirrorToProfile({ avatar_url: bustedUrl, avatar_data: await smallAvatarDataUri(file) });
    dropCachedAvatar(state.user.id);
    updateAuthUI();
    return state.user;
}

// ==================== UI ====================
// Terms modal moved to legal.ts, alongside the /terms page, so both render
// the same terms.md without drifting.

// ==================== account gate ====================
// Reading the hub/profiles/published mons requires an account - the DB
// refuses those tables to anonymous callers (see require_sign_in_for_community
// migration), so this gate exists to explain why instead of showing an empty page.
// Remembers what the visitor wanted so it reopens after sign-in.
let pendingAfterSignIn: any = null;

/**
 * @param reason shown to the visitor; say what they were trying to do
 * @param [resume] re-run once they are signed in
 * @returns true if there is an account and the caller may continue
 */
function requireAccount(reason: string, resume: Function | null = null): boolean {
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
    catch (e: any) { log.error('AUTH', 'Could not reopen the page held over sign-in', e); }
}

// The sign-in, sign-up and password dialogs are js/app/dialogs/auth.tsx. They
// are rendered only while open, so no page's served HTML carries a password
// field (see the note at the top of that file).

function openAuthModal(mode = 'signin') {
    openDialog('auth', { mode: mode === 'signup' ? 'signup' : 'signin' });
}

function closeAuthModal() {
    closeDialog('auth');
}

/**
 * The sign-in / sign-up form's submit.
 * @returns error: what's wrong; notice: an email to confirm; neither: signed in (the dialog is closed)
 */
async function submitAuthForm({ mode = 'signin', identifier = '', email = '', password = '', tosAccepted = false }: { mode?: any; identifier?: any; email?: any; password?: any; tosAccepted?: any }): Promise<{ error?: string, notice?: string }> {
    identifier = String(identifier).trim();
    email = String(email).trim();
    if (!identifier || !password) return { error: 'Username and password are required.' };
    if (mode === 'signup' && !USERNAME_PATTERN.test(identifier)) return { error: 'Username must be 3-20 characters: letters, numbers, and underscores only.' };
    if (password.length < 6) return { error: 'Password must be at least 6 characters.' };
    if (mode === 'signup' && !tosAccepted) return { error: 'Please agree to the Terms of Service.' };
    try {
        if (mode === 'signup') {
            const result = await signUp(identifier, password, email, tosAccepted);
            // email confirmation required by the Supabase project's settings
            if (!result.session) return { notice: "Check your email to confirm your account. Don't see it? Check your spam/junk folder." };
        } else {
            await signIn(identifier, password);
        }
        closeAuthModal();
        await resumeAfterSignIn();
        return {};
    } catch (e: any) {
        return { error: e.message || 'Something went wrong.' };
    }
}

// ==================== forgot / reset password ====================
function openForgotPasswordModal() {
    closeAuthModal();
    openDialog('forgot-password', {});
}

function closeForgotPasswordModal() {
    closeDialog('forgot-password');
}

/**
 * Sends a reset link. The answer is the same whether or not an account
 * matches, so this can't be used to find out who has one.
 * @returns a problem to show, or '' once sent
 */
async function submitForgotPasswordForm(identifier): Promise<string> {
    identifier = String(identifier || '').trim();
    if (!identifier) return 'Enter your username or email.';
    try {
        await requestPasswordReset(identifier);
        return '';
    } catch (e: any) {
        // only throws for things worth surfacing (empty field, real failure)
        // - never "no such account", so this is safe to show as-is.
        return e.message || 'Something went wrong.';
    }
}

function openSetNewPasswordModal() {
    openDialog('set-new-password', {});
}

function closeSetNewPasswordModal() {
    closeDialog('set-new-password');
}

/** @returns a problem to show, or '' once the new password is set */
async function submitSetNewPasswordForm(password = '', confirm = ''): Promise<string> {
    if (password.length < 6) return 'Password must be at least 6 characters.';
    if (password !== confirm) return 'Passwords do not match.';
    try {
        await completePasswordReset(password);
        closeSetNewPasswordModal();
        api.showToast?.('Password updated.', 'success');
        return '';
    } catch (e: any) {
        return e.message || 'Something went wrong.';
    }
}

// ==================== change password (signed in) ====================
function openChangePasswordModal() {
    if (!state.user) { openAuthModal('signin'); return; }
    openDialog('change-password', {});
}

function closeChangePasswordModal() {
    closeDialog('change-password');
}

/**
 * Accounts that only ever signed in through Google/Discord/GitHub have no
 * password to confirm, so current is only asked of the others.
 * @returns a problem to show, or '' once updated
 */
async function submitChangePasswordForm({ current = '', password = '', confirm = '' }: { current?: any; password?: any; confirm?: any }): Promise<string> {
    const needsCurrent = state.user?.hasPassword !== false;
    if (!state.user) return 'Sign in first.';
    if (needsCurrent && !current) return 'Enter your current password.';
    if (password.length < 6) return 'New password must be at least 6 characters.';
    if (password !== confirm) return 'New passwords do not match.';
    if (needsCurrent && password === current) return 'That is already your password.';
    try {
        const client = await getClient();
        if (needsCurrent) {
            // Supabase's updateUser() doesn't ask for the old password, so an
            // unattended signed-in tab could otherwise lock its owner out.
            const { error } = await client.auth.signInWithPassword({ email: state.user.email, password: current });
            if (error) throw new Error('Your current password is incorrect.');
        }
        await completePasswordReset(password);
        state.user.hasPassword = true;
        closeChangePasswordModal();
        api.showToast?.('Password updated.', 'success');
        return '';
    } catch (e: any) {
        return e.message || 'Could not update your password.';
    }
}

async function handleSignOutClick() {
    try {
        await signOut();
    } catch (e: any) {
        api.showToast?.('Sign out failed: ' + e.message, 'error');
    }
}

async function showProfileView(userId: any = null, options: Record<string, any> = {}) {
    if (!userId) {
        if (!state.user) { openAuthModal('signin'); return; }
        userId = state.user.id;
    }
    if (document.getElementById('editor-view')?.style.display !== 'none' && userId === state.user?.id) {
        await api.autoSave?.(true);
    }
    state.isCommunityPreview = false;
    const view = api.activateTopLevelView?.('profile-view');
    if (!view) return;
    state.profilePageUser = null;
    state.profilePageEditing = false;
    renderProfileLoading();
    try {
        await loadPublicProfile(userId);
        // Settings' "Edit Profile" opens straight into editing your own
        state.profilePageEditing = !!options.edit && !!state.user && state.profilePageUser?.id === state.user.id;
        renderProfilePage();
        if (state.profilePageEditing) api.updateConnectedAccountsUI?.();
        const username = state.profilePageUser?.username;
        if (username) navigateRoute(`profile/${encodeURIComponent(username)}`);
        document.title = `${state.profilePageUser?.display_name || username || 'Profile'} · Woogidex`;
    } catch (e: any) {
        log.error('AUTH', 'Profile page failed to load', e);
        renderProfileError(e?.message || 'Could not load this profile.');
        api.showToast?.('Could not load that profile.', 'error');
    }
}

// Called from everywhere that hides #profile-view. The page opened next sets
// its own address as a new history entry, so the profile's stays behind for
// Back; nothing needs clearing here any more.
function exitProfileRoute() {}

function openProfileModal() { return showProfileView(); }
function closeProfileModal() { api.showCollection?.(); }

// The page itself is js/app/pages/ProfilePage.tsx: these set what it shows.
function renderProfileLoading() {
    state.profilePageStatus = 'loading';
    state.profilePageError = '';
    notify();
}

// a profile link to nobody: the page says so instead of loading forever
function showProfileNotFound() {
    api.activateTopLevelView?.('profile-view');
    renderProfileError('Nobody on Woogidex goes by that name. The link may be mistyped, or they changed their username.');
}

function renderProfileError(message) {
    state.profilePageStatus = 'error';
    state.profilePageError = message || 'Could not load this profile.';
    notify();
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
 * @param [userId] omit to clear every cached profile
 */
function invalidateProfile(userId: string) {
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
        profile = fallback.data ? { ...fallback.data, bio: '', display_badges: [] as any[] } : null;
        profileError = fallback.error;
    }
    if (profileError) throw profileError;
    if (!profile) throw new Error('Profile not found.');

    // loaded independently - a problem with comments must never block the header/gallery from rendering.
    let mons: any[] = [];
    let comments: any[] = [];
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
        else mons = (result.data || []).map(({ name, type1, type2, ...rest }: any) => ({ ...rest, fakemon_data: { name, type1, type2 } }));
    } catch (e: any) {
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
    } catch (e: any) {
        console.warn('Could not load profile comments:', e);
    }

    const ids = [...new Set(comments.map(c => c.user_id).filter(Boolean))];
    let authors: Record<string, any> = {};
    if (ids.length) {
        try {
            const result = await withProfileTimeout(
                client.from('profiles')
                    .select('id, username, display_name, avatar_url, role, display_badges')
                    .in('id', ids),
                'Comment authors request'
            );
            (result.data || []).forEach(x => { authors[x.id] = x; });
        } catch (e: any) {
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
    notify();
    // Connected Accounts is on the edit page too; make sure it's current
    api.updateConnectedAccountsUI?.();
}

function cancelEditOwnProfile() {
    state.profilePageEditing = false;
    notify();
}

function renderProfilePage() {
    const profile = state.profilePageUser;
    if (!profile) return;
    state.profilePageStatus = 'ready';
    if (!state.profilePageEditing) api.setPageTitle?.(`${profile.display_name || profile.username || 'Profile'}'s Profile`);
    notify();
}

/**
 * Posts a comment on the open profile.
 * @param text
 * @returns '' when posted, otherwise what went wrong
 */
async function submitProfileComment(text: string): Promise<string> {
    if (!state.user || !state.profilePageUser) { openAuthModal('signin'); return 'Sign in to comment.'; }
    const body = String(text || '').trim();
    if (!body) return '';
    if (body.length > 1000) return 'Comments are limited to 1000 characters.';

    // blocklist scan + mute/ban check before the write, so a refusal is
    // explained here rather than surfacing as a raw Postgres error.
    if (!(await api.guardContent?.(body, 'profile comment') ?? true)) return 'That comment can’t be posted.';

    const client = await getClient();
    const { error } = await client.from('profile_comments').insert({ profile_id: state.profilePageUser.id, user_id: state.user.id, body });
    if (error) return api.friendlyModerationError?.(error) || error.message || 'Could not post comment.';
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
        preview: body
    });
    return '';
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


// ==================== user hover card ====================
let userHoverCardEl: any = null;
let userHoverTimer: any = null;
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
    } catch (e: any) {
        if (requestId !== userHoverRequest) return;
        // preview just doesn't appear on failure - nothing worth surfacing.
        card.style.display = 'none';
    }
}

document.addEventListener('mouseover', event => {
    const anchor = (event.target as Element).closest<HTMLElement>('.community-author-link, .mon-comment-author, .profile-comment-header');
    if (!anchor || !anchor.closest('body') || anchor.contains(event.relatedTarget as Node | null)) return;
    const match = anchor.getAttribute('onclick')?.match(/showUserProfile\('([^']+)'\)/);
    const userId = match?.[1] || anchor.closest<HTMLElement>('[data-user-id]')?.dataset.userId;
    if (!userId) return;
    clearTimeout(userHoverTimer);
    userHoverTimer = setTimeout(() => showUserHoverCard(userId, anchor), 250);
});

document.addEventListener('mouseout', event => {
    const anchor = (event.target as Element).closest<HTMLElement>('.community-author-link, .mon-comment-author, .profile-comment-header');
    if (!anchor || anchor.contains(event.relatedTarget as Node | null)) return;
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
        if (!value) { showProfileNotFound(); return; }

        // profiles.id is a UUID - a username through eq('id', ...) gets
        // rejected by PostgREST with a 400 before we can fall back.
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
        let targetId: any = null;

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
                // any case, so /profile/woogi finds Woogi; _ and % are LIKE wildcards, so escaped
                .ilike('username', value.replace(/[\\%_]/g, '\\$&'))
                .limit(1)
                .maybeSingle();
            if (usernameError) throw usernameError;
            targetId = byUsername?.id || null;
        }

        if (!targetId) { showProfileNotFound(); return; }
        await showProfileView(targetId);
    } catch (e: any) {
        log.error('AUTH', 'Profile page failed to load', e);
        api.showToast?.('Could not load that profile.', 'error');
    }
}

/**
 * Opens the profile a /profile/<username> URL names. The caller has already
 * parsed the route, so this takes the username rather than reading the URL.
 * @param username
 * @returns whether it opened
 */
async function handleProfileRoute(username: string): Promise<boolean> {
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

/** Why an avatar file can't be used, or '' when it can. */
function avatarFileProblem(file) {
    if (!file) return '';
    if (!file.type.startsWith('image/')) return 'Please choose an image file.';
    if (file.size > AVATAR_MAX_BYTES) return `Image is ${(file.size / 1024 / 1024).toFixed(1)}MB - max is 2MB.`;
    return '';
}

/** Saves which of your badges show beside your name. Throws on failure. */
async function saveDisplayedBadges(keys) {
    if (!state.user) return;
    const owned = new Set(state.user.badges || []);
    const valid = (keys || []).filter(key => owned.has(key));
    const client = await getClient();
    const { error } = await client.from('profiles').upsert({ id: state.user.id, display_badges: valid }, { onConflict: 'id' });
    if (error) throw error;
    state.user.displayBadges = valid;
    invalidateProfile(state.user.id);
    updateAuthUI();
    notify();
    api.showToast?.('Badge display updated', 'success');
}

/**
 * Saves your display name, bio and (optionally) a new avatar. Throws on failure.
 * @returns false when the content filter refused it
 */
async function saveProfileDetails({ displayName = '', bio = '', file = null }: { displayName?: any; bio?: any; file?: any } = {}): Promise<boolean> {
    // a display name and a bio are as public as a comment, so they go through the same filter
    if (!(await api.guardContent?.(`${displayName} ${bio}`, 'profile') ?? true)) return false;
    if (file) await uploadAvatar(file);
    await updateDisplayName(displayName);
    const client = await getClient();
    const me = state.user!;
    invalidateProfile(me.id);
    const { error } = await client.from('profiles').upsert({ id: me.id, bio }, { onConflict: 'id' });
    if (error) throw error;
    state.profilePageEditing = false;
    await loadPublicProfile(me.id);
    api.showToast?.('Profile updated', 'success');
    renderProfilePage();
    return true;
}

/** Changes your username. Throws with the reason on failure. */
async function saveUsername(username) {
    await setUsername(String(username || '').trim());
    invalidateProfile(state.user!.id);
    renderProfilePage();
}

/** Sets or changes your account email. Throws on failure. */
async function saveEmail(email) {
    await updateEmail(String(email || '').trim());
}

/**
 * Removes your email after asking. Throws on failure.
 * @returns false when cancelled
 */
async function removeAccountEmail(): Promise<boolean> {
    if (!state.user?.username) throw new Error('Set a username first - you need a way to sign in once your email is removed.');
    if (!await confirmDialog({ title: 'Remove your email?', message: 'You will only be able to sign in with your username afterward.', confirmLabel: 'Remove email' })) return false;
    await removeEmail();
    return true;
}

// The header's account button and menu are js/app/shell/AccountMenu.tsx.
// admin.html still has its own signed-in/out widgets, filled in here.
function updateAuthUI() {
    const signedOutEl = document.getElementById('auth-signed-out');
    const signedInEl = document.getElementById('auth-signed-in');
    const nameEl = document.getElementById('auth-user-name');
    const avatarImg = document.getElementById('auth-avatar-img') as HTMLImageElement | null;
    const avatarFallback = document.getElementById('auth-avatar-fallback');
    api.refreshNotifications?.();
    // re-read whenever the signed-in user changes (including sign-out, which
    // must clear it), since the cloud-backup badge depends on it.
    api.refreshCloudManifest?.();
    if (!state.user) accountMenuOpen = false;
    notify();
    if (signedOutEl) signedOutEl.style.display = state.user ? 'none' : 'flex';
    if (signedInEl) signedInEl.style.display = state.user ? 'flex' : 'none';
    if (!state.user) return;
    if (nameEl) nameEl.textContent = publicName(state.user);
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
}

// ==================== header account menu ====================
let accountMenuOpen = false;

export function isAccountMenuOpen() { return accountMenuOpen; }

function toggleHeaderProfilePopover(event) {
    event?.stopPropagation();
    accountMenuOpen = !accountMenuOpen;
    notify();
}

function closeHeaderProfilePopover() {
    if (!accountMenuOpen) return;
    accountMenuOpen = false;
    notify();
}

// ==================== first-run setup ====================
// An account can arrive without a username two ways: a failed claim during a
// password signup (see signUp's catch block), or -- far more often -- a
// Google/Discord sign-in, which has no form to ask on. Those accounts used to
// be dropped onto the profile page with a toast, which is easy to walk away
// from; the result was OAuth users wandering the site with no username at all
// and whatever name the provider sent, if any.
//
// This asks for both up front instead, in a modal with no way out. Both fields
// are collected together because they are the same decision, and because
// display_name has to be written through mirrorToProfile() for anyone else to
// see it -- which OAuth's metadata-only setup never did.
function promptUsernameIfMissing(error = '') {
    if (!state.user || state.user.username || signupInProgress) return;
    // OAuth sign-ins bring a handle and a name along; offering them as a
    // starting point saves a naming decision under pressure.
    openDialog('account-setup', {
        error,
        username: api.suggestedUsername?.() || '',
        displayName: state.user.displayName || state.user.providerName || ''
    });
}

function closeAccountSetupModal() {
    closeDialog('account-setup');
}

/**
 * The account setup dialog's Continue.
 * @returns a problem to show, or '' once both are saved
 */
async function submitAccountSetup({ username = '', displayName = '' }: { username?: any; displayName?: any }): Promise<string> {
    username = String(username).trim();
    displayName = String(displayName).trim();
    if (!USERNAME_PATTERN.test(username)) return 'Username must be 3-20 characters: letters, numbers, and underscores only.';
    if (!displayName) return 'Please enter a display name.';
    try {
        // username first: it is the one that can be refused (taken, or rate
        // limited), and a display name saved against a half-made account would
        // have to be undone.
        await setUsername(username);
        await updateDisplayName(displayName);
        invalidateProfile(state.user!.id);
        api.showToast?.(`You're all set, ${displayName}.`, 'success');
        return '';
    } catch (e: any) {
        return e.message || 'Could not save that.';
    }
}

export {
    initAuth, getClient, signUp, signIn, signOut, resetPassword, requestPasswordReset, completePasswordReset,
    getCurrentUser, isLoggedIn, updateDisplayName, uploadAvatar,
    setUsername, updateEmail, removeEmail, fetchProfile, mirrorToProfile,
    openAuthModal, closeAuthModal, submitAuthForm,
    openForgotPasswordModal, closeForgotPasswordModal, submitForgotPasswordForm,
    openSetNewPasswordModal, closeSetNewPasswordModal, submitSetNewPasswordForm,
    openChangePasswordModal, closeChangePasswordModal, submitChangePasswordForm,
    requireAccount, invalidateProfile,
    showProfileView, showUserProfile, handleProfileRoute, exitProfileRoute, editOwnProfile, cancelEditOwnProfile, openProfileModal, closeProfileModal, renderProfilePage, renderProfileLoading, submitProfileComment, deleteProfileComment,
    saveProfileDetails, saveUsername, saveEmail, removeAccountEmail, saveDisplayedBadges, avatarFileProblem, usernameChangesRemainingText,
    handleSignOutClick, updateAuthUI, promptUsernameIfMissing, submitAccountSetup, closeAccountSetupModal,
    toggleHeaderProfilePopover, closeHeaderProfilePopover,
    fetchBadges, currentRole, isStaff, isAdminOrDev, canDeleteAnyContent,
    fetchPermissions, recordAuthEvent
};