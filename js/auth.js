import { log } from './log.js';
import { state, api } from './app.js';

// ==================== SUPABASE CLIENT ====================
// Loaded from CDN as an ES module - no npm/bundler needed.
// TODO: replace with your project's values (Supabase dashboard -> Project Settings -> API).
const SUPABASE_URL = 'https://qstbascfeolkyxtrqqwv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_B4jEJ--w0XFsgXDmQeJREA_xH1GRBsf';

let supabase = null;
let authInitPromise = null;

async function getClient() {
    if (supabase) return supabase;
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true }
    });
    return supabase;
}

// Username rules: letters, numbers, underscore only, 3-20 chars.
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;
// Domain used for accounts created without a real email. ".invalid" is a
// reserved, non-routable TLD (RFC 2606) - Supabase still accepts it as a
// syntactically valid address for password auth, but nothing will ever be
// delivered there. Turn OFF "Confirm email" in your Supabase project if you
// want optional email to actually work (see SUPABASE_SETUP.md).
const PLACEHOLDER_EMAIL_DOMAIN = 'users.woogidex.invalid';
const SYNTHETIC_EMAIL_DOMAIN = 'no-email.woogidex.com';

// Supabase's auth.users row carries our custom fields inside user_metadata
// (set via auth.updateUser({ data: {...} })). Flatten that onto state.user so
// the rest of the app can just read state.user.displayName / .avatarUrl.
// `username` is NOT stored here - it lives in the public `profiles` table
// (see fetchProfile) since it needs uniqueness + rate-limit enforcement that
// user_metadata can't provide.
function mapUser(supabaseUser) {
    const meta = supabaseUser.user_metadata || {};
    return {
        id: supabaseUser.id,
        email: supabaseUser.email,
        hasRealEmail: !!supabaseUser.email && !supabaseUser.email.endsWith('@' + PLACEHOLDER_EMAIL_DOMAIN) && !supabaseUser.email.endsWith('@' + SYNTHETIC_EMAIL_DOMAIN),
        tosAcceptedAt: meta.tos_accepted_at || null,
        username: '',
        displayName: meta.display_name || '',
        avatarUrl: meta.avatar_url || ''
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

async function attachProfile(user) {
    if (!user) return user;
    const profile = await fetchProfile(user.id);
    user.username = profile?.username || '';
    user.usernameHistory = profile?.username_history || [];
    user.role = profile?.role || 'user';
    user.badges = await fetchBadges(user.id);
    return user;
}

// ==================== ROLE / PERMISSION HELPERS ====================
// Thin wrappers around state.user.role so the rest of the app never has to
// think about the profiles.role string directly. Client-side checks are for
// UI only (hide/show buttons) - the actual enforcement lives in Supabase RLS
// policies, so a user can never truly bypass this by editing JS.
function currentRole() {
    return state.user?.role || 'user';
}

function isStaff() {
    return ['moderator', 'admin', 'developer'].includes(currentRole());
}

function isAdminOrDev() {
    return ['admin', 'developer'].includes(currentRole());
}

function canDeleteAnyContent() {
    return isStaff();
}

// ==================== STATE ====================
// state.user and state.authReady are initialized inside initAuth() rather than
// here at module top-level. auth.js and app.js import each other (app.js needs
// initAuth/openAuthModal/etc, auth.js needs the shared state/api objects), so
// when app.js's import of auth.js runs, auth.js executes before app.js has
// reached its `export const state = {...}` line. Touching `state.user` here
// at top-level would throw "Cannot access 'state' before initialization".

// ==================== INIT ====================
// Call once on boot. Resolves after the initial session is known and
// `state.user` is populated (or confirmed null).
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
        promptUsernameIfMissing();

        client.auth.onAuthStateChange(async (event, session) => {
            log.debug('AUTH', 'Auth state change', { event });
            const wasLoggedIn = !!state.user;
            state.user = session?.user ? await attachProfile(mapUser(session.user)) : null;
            updateAuthUI();

            if (event === 'SIGNED_IN' && !wasLoggedIn) {
                api.showToast?.(`Signed in as ${state.user.username || state.user.email}`, 'success');
                promptUsernameIfMissing();
            }
            if (event === 'SIGNED_OUT') {
                api.showToast?.('Signed out', 'info');
            }
        });

        return state.user;
    })();
    return authInitPromise;
}

// ==================== ACTIONS ====================
// Creates the auth account (with a real or placeholder email) and claims the
// username in the public `profiles` table. If the username turns out to be
// taken (race with another signup), the auth account still exists - the
// caller should prompt the user to pick a different username via
// updateUsername() rather than treat this as a total signup failure.
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

    // Claim the username. Only possible once a session exists (i.e. email
    // confirmation is off in the Supabase project, or wasn't required).
    if (data.session) {
        try {
            await setUsername(username);
        } catch (usernameError) {
            log.error('AUTH', 'Username claim failed after signup', usernameError);
            throw new Error(`Account created, but "${username}" is already taken. Please choose another username in Edit Profile.`);
        }
    }
    return data;
}

// Resolves a username to its account's email via a security-definer RPC
// (profiles.username is public, but auth.users.email is not - the RPC is the
// one narrow, deliberate exception). Falls back to treating the identifier
// as an email directly if it contains "@".
async function signIn(identifier, password) {
    const client = await getClient();
    let email = identifier.trim();
    if (!email.includes('@')) {
        const { data: resolvedEmail, error: rpcError } = await client.rpc('email_for_username', { input_username: email });
        if (rpcError) { log.error('AUTH', 'Username lookup failed', rpcError); throw new Error('Invalid username or password.'); }
        if (!resolvedEmail) throw new Error('Invalid username or password.');
        email = resolvedEmail;
    }
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) { log.error('AUTH', 'Sign in failed', error); throw new Error('Invalid username or password.'); }
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
        redirectTo: window.location.origin
    });
    if (error) throw error;
}

function getCurrentUser() {
    return state.user;
}

function isLoggedIn() {
    return !!state.user;
}

// ==================== USERNAME & EMAIL ====================
// Used both for the initial claim during signup and for later changes - the
// database (unique index + rate-limit trigger, see SUPABASE_SETUP.md) is the
// real authority; this just surfaces its errors in a friendly way.
// updateDisplayName/uploadAvatar only touch auth.users (via updateUser), never
// the profiles table - but mapUser() always sets username to ''. Replacing
// state.user wholesale with mapUser(data.user) after those calls was wiping
// the username/usernameHistory back out of local state (the DB row was still
// fine, but the profile modal would then render an empty username field,
// looking like the save never happened). Merge instead of replace.
function applySupabaseUser(supabaseUser) {
    const mapped = mapUser(supabaseUser);
    state.user = {
        ...mapped,
        username: state.user?.username || '',
        usernameHistory: state.user?.usernameHistory || []
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
    // Mirror the DB trigger's rate-limit bookkeeping locally so the "N changes
    // left this week" hint is correct immediately, without waiting on a re-fetch.
    state.user.usernameHistory = [...(state.user.usernameHistory || []), new Date().toISOString()];
    updateAuthUI();
    return state.user;
}

async function updateEmail(newEmail) {
    if (!state.user) throw new Error('You must be signed in.');
    const email = (newEmail || '').trim();
    if (!email || !email.includes('@')) throw new Error('Please enter a valid email address.');
    if (state.user.hasRealEmail && email.toLowerCase() === state.user.email?.toLowerCase()) {
        throw new Error('That\'s already your current email.');
    }
    const client = await getClient();
    const { error } = await client.auth.updateUser({ email });
    if (error) { log.error('AUTH', 'Email update failed', error); throw error; }
    // Supabase typically requires confirming the new address before it takes
    // effect - state.user.email won't reflect it until that happens and the
    // session refreshes.
    return true;
}

// Reverts the account to a random, non-routable placeholder address (same
// scheme used for username-only signups - see PLACEHOLDER_EMAIL_DOMAIN).
// Requires a username, since without a real email that's the only way back
// in. Supabase's default "secure email change" setting sends a confirmation
// to the *old* real address before this takes effect; state.user.email won't
// update until that's confirmed and the session refreshes.
async function removeEmail() {
    if (!state.user) throw new Error('You must be signed in.');
    if (!state.user.hasRealEmail) throw new Error('This account has no email on file.');
    if (!state.user.username) throw new Error('Set a username first - you need a way to sign in once your email is removed.');

    // Do not call auth.updateUser({ email: ... }) here. Supabase treats that as
    // an email change, validates the destination address, and can start the
    // secure-email-change confirmation flow. Removing an email is intentionally
    // handled by the narrowly scoped authenticated SQL RPC instead.
    const client = await getClient();
    const { error } = await client.rpc('remove_my_email');
    if (error) {
        log.error('AUTH', 'Email removal failed', error);
        if (/remove_my_email|function .* does not exist/i.test(error.message || '')) {
            throw new Error('Email removal is not configured yet. Run supabase-remove-email.sql in your Supabase SQL Editor.');
        }
        throw error;
    }

    // Refresh the local auth user so the profile immediately reflects that it
    // no longer has a real email address.
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

// Mirrors display_name/avatar_url from auth.users.user_metadata onto the
// public `profiles` table. Necessary because other users' clients can never
// read someone else's user_metadata (no RLS-bypassable public API for that),
// but profiles IS publicly readable — so profiles is what community.js's
// live author lookups actually join against. Best-effort: failures here
// don't block the metadata update itself from succeeding.
async function mirrorToProfile(fields) {
    if (!state.user) return;
    const client = await getClient();
    const { error } = await client.from('profiles').upsert({ id: state.user.id, ...fields }, { onConflict: 'id' });
    if (error) log.error('AUTH', 'Profile mirror failed', error);
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

// Uploads a new avatar image to the user's private folder in the "avatars"
// bucket (avatars/<user_id>/avatar.<ext>), then stores its public URL on the
// user's metadata. Overwrites any previous avatar for that user (upsert).
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
    // Cache-bust so the new image shows immediately instead of a stale cached one.
    const bustedUrl = `${publicUrl}?t=${Date.now()}`;

    const { data, error } = await client.auth.updateUser({ data: { avatar_url: bustedUrl } });
    if (error) { log.error('AUTH', 'Avatar URL save failed', error); throw error; }
    applySupabaseUser(data.user);
    await mirrorToProfile({ avatar_url: bustedUrl });
    updateAuthUI();
    return state.user;
}

// ==================== UI ====================
// ==================== POLICY MODALS ====================
function openTermsModal() { document.getElementById('terms-modal')?.classList.add('active'); }
function closeTermsModal() { document.getElementById('terms-modal')?.classList.remove('active'); }

function openAuthModal(mode = 'signin') {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    document.getElementById('auth-modal-error').textContent = '';
    document.getElementById('auth-identifier').value = '';
    document.getElementById('auth-email-optional').value = '';
    document.getElementById('auth-password').value = '';
    setAuthMode(mode);
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
                // Email confirmation required by your Supabase project settings.
                errorEl.style.color = 'var(--success, #22c55e)';
                errorEl.textContent = 'Check your email to confirm your account.';
                submitBtn.disabled = false;
                submitBtn.textContent = 'Sign Up';
                return;
            }
        } else {
            await signIn(identifier, password);
        }
        closeAuthModal();
    } catch (e) {
        errorEl.style.color = '';
        errorEl.textContent = e.message || 'Something went wrong.';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = mode === 'signup' ? 'Sign Up' : 'Sign In';
    }
}

async function handleSignOutClick() {
    try {
        await signOut();
    } catch (e) {
        api.showToast?.('Sign out failed: ' + e.message, 'error');
    }
}

function openProfileModal() {
    const modal = document.getElementById('profile-modal');
    if (!modal || !state.user) return;
    document.getElementById('profile-modal-error').textContent = '';
    document.getElementById('profile-display-name').value = state.user.displayName || '';
    document.getElementById('profile-avatar-file').value = '';
    setProfilePreview(state.user.avatarUrl);

    document.getElementById('profile-username-error').textContent = '';
    document.getElementById('profile-username').value = state.user.username || '';
    document.getElementById('profile-username-hint').textContent = usernameChangesRemainingText(state.user.usernameHistory);

    document.getElementById('profile-email-error').textContent = '';
    document.getElementById('profile-email').value = state.user.hasRealEmail ? state.user.email : '';
    document.getElementById('profile-email').placeholder = state.user.hasRealEmail ? '' : 'No email on file - add one for account recovery';
    const removeBtn = document.getElementById('profile-email-remove-btn');
    if (removeBtn) removeBtn.style.display = state.user.hasRealEmail ? 'inline-block' : 'none';

    modal.classList.add('active');
}

// Best-effort client-side estimate of remaining username changes this week,
// purely for UX - the database trigger is the real enforcement (see setUsername).
function usernameChangesRemainingText(history) {
    const recent = (history || []).filter(t => Date.now() - new Date(t).getTime() < 7 * 24 * 60 * 60 * 1000);
    const remaining = Math.max(0, 2 - recent.length);
    return remaining > 0
        ? `${remaining} username change${remaining === 1 ? '' : 's'} left this week.`
        : 'No username changes left this week.';
}

function closeProfileModal() {
    document.getElementById('profile-modal')?.classList.remove('active');
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

async function submitProfileForm() {
    const errorEl = document.getElementById('profile-modal-error');
    const submitBtn = document.getElementById('profile-submit-btn');
    const displayName = document.getElementById('profile-display-name').value.trim();
    const fileInput = document.getElementById('profile-avatar-file');
    const file = fileInput.files?.[0] || null;
    errorEl.textContent = '';

    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';
    try {
        if (file) await uploadAvatar(file);
        await updateDisplayName(displayName);
        api.showToast?.('Profile updated', 'success');
        closeProfileModal();
    } catch (e) {
        errorEl.textContent = e.message || 'Something went wrong.';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save Profile';
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
        document.getElementById('profile-username-hint').textContent = usernameChangesRemainingText(state.user.usernameHistory);
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
        errorEl.textContent = 'Check your inbox to confirm the new email address.';
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
    const sidebarProfile = document.getElementById('sidebar-profile');
    const sidebarProfileName = document.getElementById('sidebar-profile-name');
    const sidebarProfileUsername = document.getElementById('sidebar-profile-username');
    const sidebarAvatarImg = document.getElementById('sidebar-profile-avatar-img');
    const sidebarAvatarFallback = document.getElementById('sidebar-profile-avatar-fallback');
    const sidebarAuthBtn = document.getElementById('sidebar-auth-btn');
    if (!signedOutEl || !signedInEl) return;
    if (state.user) {
        signedOutEl.style.display = 'none';
        signedInEl.style.display = 'flex';
        if (nameEl) nameEl.textContent = state.user.displayName || state.user.username || state.user.email;
        if (sidebarProfile) sidebarProfile.style.display = 'block';
        if (sidebarProfileName) {
            const nameText = state.user.displayName || state.user.username || 'Profile';
            const nameSafe = nameText.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
            sidebarProfileName.innerHTML = `${nameSafe}` + (api.renderBadgeRow ? api.renderBadgeRow(state.user.badges, 12) : '');
        }
        if (sidebarProfileUsername) sidebarProfileUsername.textContent = state.user.username ? '@' + state.user.username : 'Edit profile';
        if (sidebarAvatarImg && sidebarAvatarFallback) {
            if (state.user.avatarUrl) { sidebarAvatarImg.src = state.user.avatarUrl; sidebarAvatarImg.style.display = 'block'; sidebarAvatarFallback.style.display = 'none'; }
            else { sidebarAvatarImg.style.display = 'none'; sidebarAvatarFallback.style.display = 'flex'; sidebarAvatarFallback.textContent = (state.user.displayName || state.user.username || '?').charAt(0).toUpperCase(); }
        }
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
                avatarFallback.textContent = (state.user.displayName || state.user.username || state.user.email || '?').charAt(0).toUpperCase();
            }
        }
    } else {
        signedOutEl.style.display = 'flex';
        signedInEl.style.display = 'none';
        if (sidebarProfile) sidebarProfile.style.display = 'none';
        if (sidebarAuthBtn) { sidebarAuthBtn.innerHTML = '<i data-lucide="log-in"></i><span>Sign In</span>'; sidebarAuthBtn.onclick = () => { openAuthModal('signin'); closeSidebar(); }; }
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
}

// Accounts can end up without a username - e.g. an old account created before
// usernames were required, or a signup where the username claim failed (see
// signUp's catch block, which still leaves the auth account logged in). Nudge
// those users into the profile modal, focused on the username field, right
// after we know who's signed in.
function promptUsernameIfMissing() {
    if (!state.user || state.user.username) return;
    api.showToast?.('Please choose a username to finish setting up your account.', 'warning');
    openProfileModal();
    // Give the modal a tick to render before focusing/scrolling to the field.
    setTimeout(() => {
        const errorEl = document.getElementById('profile-username-error');
        if (errorEl) {
            errorEl.style.color = 'var(--warning, #eab308)';
            errorEl.textContent = 'Choose a username to finish setting up your account.';
        }
        document.getElementById('profile-username')?.focus();
    }, 0);
}

export {
    initAuth, getClient, signUp, signIn, signOut, resetPassword,
    getCurrentUser, isLoggedIn, updateDisplayName, uploadAvatar,
    setUsername, updateEmail, removeEmail, fetchProfile,
    openAuthModal, closeAuthModal, toggleAuthMode, submitAuthForm, openTermsModal, closeTermsModal,
    openProfileModal, closeProfileModal, onProfileAvatarFileChosen, submitProfileForm,
    submitUsernameForm, submitEmailForm, submitRemoveEmail,
    handleSignOutClick, updateAuthUI, promptUsernameIfMissing,
    fetchBadges, currentRole, isStaff, isAdminOrDev, canDeleteAnyContent
};