import { log } from './log.js';
import { state, api } from './app.js';
import { renderCommentMarkdown } from './data.js';

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


async function attachProfile(user) {
    if (!user) return user;
    const profile = await fetchProfile(user.id);
    user.username = profile?.username || '';
    user.usernameHistory = profile?.username_history || [];
    user.role = profile?.role || 'user';
    user.badges = await fetchBadges(user.id);
    user.displayBadges = Array.isArray(profile?.display_badges) ? profile.display_badges : [];
    await refreshBadgeDefinitions();
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
    // Mirror the DB trigger's rate-limit bookkeeping locally so the "N changes
    // left this week" hint is correct immediately, without waiting on a re-fetch.
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

    // A malformed existing email can deadlock Supabase's normal secure-email-change
    // flow because it may require confirmation at the old address. Repair only that
    // special case through the authenticated, narrowly scoped SQL RPC.
    const currentEmail = state.user.email || '';
    const currentLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(currentEmail);
    // Both domains are synthetic/non-user email addresses. They must use the
    // direct repair RPC instead of Supabase's normal email-change flow.
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
    ['editor-view','collection-view','community-view','community-detail-view','events-view'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    const view = document.getElementById('profile-view');
    if (!view) return;
    view.style.display = 'block';
    state.profilePageUser = null;
    state.profilePageEditing = false;
    renderProfileLoading();
    try {
        await loadPublicProfile(userId);
        renderProfilePage();
        if (typeof lucide !== 'undefined') lucide.createIcons();
        closeSidebar?.();
        const username = state.profilePageUser?.username;
        if (username) history.replaceState(null, '', `${window.location.pathname}${window.location.search}#profile/${encodeURIComponent(username)}`);
        document.title = `${state.profilePageUser?.display_name || username || 'Profile'} · Woogidex`;
    } catch (e) {
        log.error('AUTH', 'Profile page failed to load', e);
        renderProfileError(e?.message || 'Could not load this profile.');
        api.showToast?.('Could not load that profile.', 'error');
    }
}

// Leaving the profile page (to Collection, Community Hub, the Editor, etc.)
// should drop the #profile/username hash so the address bar matches what's
// actually on screen. Without this, reloading or sharing the URL after
// navigating away would drop the visitor right back on a profile they'd
// already left. Called from every place that hides #profile-view.
function exitProfileRoute() {
    if ((window.location.hash || '').startsWith('#profile/')) {
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
}

function openProfileModal() { return showProfileView(); }
function closeProfileModal() { api.showCollection?.(); }

function getProfileStateEl(id) {
    return document.getElementById(id);
}

// Mirrors .profile-mon-card's real markup so it swaps to real cards
// without any layout shift.
function profileMonCardSkeleton() {
    return `
        <div class="profile-mon-card skel-card">
            <div class="profile-mon-art skel"></div>
            <strong class="skel skel-text" style="margin:10px 12px 5px;width:70%;"></strong>
            <div class="card-types">
                <span class="skel skel-pill"></span>
                <span class="skel skel-pill"></span>
            </div>
        </div>
    `;
}

// Mirrors .profile-comment's real markup.
function profileCommentSkeleton() {
    return `
        <div class="profile-comment skel-card">
            <div class="profile-comment-header">
                <span class="community-mini-avatar skel skel-circle"></span>
                <strong class="skel skel-text" style="width:90px;"></strong>
            </div>
            <div class="profile-comment-body">
                <span class="skel skel-text" style="width:95%;"></span>
                <span class="skel skel-text" style="width:65%;"></span>
            </div>
        </div>
    `;
}

function renderProfileLoading() {
    const view = document.getElementById('profile-view');
    const publicEl = document.getElementById('profile-public-content');
    const editEl = document.getElementById('profile-edit-content');
    if (!view) return;
    getProfileStateEl('profile-loading-state')?.remove();
    getProfileStateEl('profile-load-error-state')?.remove();
    if (editEl) editEl.style.display = 'none';
    // Keep the public layout visible and populate it with skeletons that
    // mirror the real elements in shape and position, rather than hiding
    // everything behind a loading message - this is what makes the
    // skeleton -> real-content swap feel seamless instead of a jump-cut.
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

    const grid = document.getElementById('profile-mons-grid');
    if (grid) grid.innerHTML = Array.from({ length: 4 }, profileMonCardSkeleton).join('');
    const list = document.getElementById('profile-comments-list');
    if (list) list.innerHTML = Array.from({ length: 3 }, profileCommentSkeleton).join('');
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


async function loadPublicProfile(userId) {
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

    // Load the two optional public sections independently. A problem with the
    // comments table must never prevent the profile header or Fakemon gallery
    // from rendering.
    let mons = [];
    let comments = [];
    try {
        // Same egress fix as the Community Hub feed: the gallery grid only
        // renders name/types/artwork thumbnail, so don't pull the full
        // fakemon_data blob (shiny artwork, cry audio, learnset, sample
        // sets, evolution graph) for up to 100 rows on every profile view.
        // Clicking a card calls openPublishedMonById(), which fetches the
        // full row for that one mon.
        const result = await withProfileTimeout(
            client.from('published_mons')
                .select('id, user_id, published_at, fakemon_data->>name, fakemon_data->>type1, fakemon_data->>type2, fakemon_data->>artwork')
                .eq('user_id', userId)
                .order('published_at', { ascending: false })
                .limit(100),
            'Published Fakemon request'
        );
        if (result.error) console.warn('Could not load published mons:', result.error);
        else mons = (result.data || []).map(({ name, type1, type2, artwork, ...rest }) => ({ ...rest, fakemon_data: { name, type1, type2, artwork } }));
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
    if (avatar) { avatar.src = profile.avatar_url || ''; avatar.style.display = profile.avatar_url ? 'block' : 'none'; }
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
    const grid = document.getElementById('profile-mons-grid');
    if (!grid || !state.profilePageUser) return;
    const mons = state.profilePageUser.mons || [];
    if (!mons.length) { grid.innerHTML = '<div class="profile-empty">No published Fakemon yet.</div>'; return; }
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    grid.innerHTML = mons.map(row => {
        const mon = row.fakemon_data || {};
        const t1 = mon.type1 ? `type-${String(mon.type1).toLowerCase()}` : '';
        const t2 = mon.type2 ? `type-${String(mon.type2).toLowerCase()}` : '';
        return `<button type="button" class="profile-mon-card" onclick="openPublishedMonById('${row.id}')">
            <div class="profile-mon-art">${mon.artwork ? `<img src="${esc(mon.artwork)}" alt="${esc(mon.name)}" draggable="false">` : '<img class="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork" draggable="false">'}</div>
            <strong>${esc(mon.name || 'Fakemon')}</strong>
            <div class="card-types">${mon.type1 ? `<span class="type-badge ${t1}">${esc(mon.type1)}</span>` : ''}${mon.type2 ? `<span class="type-badge ${t2}">${esc(mon.type2)}</span>` : ''}</div>
        </button>`;
    }).join('');
}

async function submitProfileComment() {
    if (!state.user || !state.profilePageUser) { openAuthModal('signin'); return; }
    const input = document.getElementById('profile-comment-input');
    const errorEl = document.getElementById('profile-comment-error');
    const text = input?.value.trim() || '';
    if (!text) return;
    if (text.length > 1000) { if (errorEl) errorEl.textContent = 'Comments are limited to 1000 characters.'; return; }
    if (errorEl) errorEl.textContent = '';
    const client = await getClient();
    const { error } = await client.from('profile_comments').insert({ profile_id: state.profilePageUser.id, user_id: state.user.id, body: text });
    if (error) { if (errorEl) errorEl.textContent = error.message || 'Could not post comment.'; return; }
    input.value = '';
    await loadPublicProfile(state.profilePageUser.id);
    renderProfilePage();

    api.createNotification?.({
        userId: state.profilePageUser.id,
        actorId: state.user.id,
        actorName: state.user.displayName || state.user.username || state.user.email,
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
    await loadPublicProfile(state.profilePageUser.id);
    renderProfilePage();
}

function renderProfileComments() {
    const list = document.getElementById('profile-comments-list');
    const inputBox = document.getElementById('profile-comment-box');
    const hint = document.getElementById('profile-comment-signin-hint');
    if (!list || !state.profilePageUser) return;
    if (inputBox) inputBox.style.display = state.user ? 'flex' : 'none';
    if (hint) hint.style.display = state.user ? 'none' : 'block';
    const comments = state.profilePageUser.comments || [];
    if (!comments.length) { list.innerHTML = '<div class="profile-empty">No comments yet. Be the first to say hello!</div>'; return; }
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    list.innerHTML = comments.map(c => {
        const a = c.author || {};
        const name = a.display_name || a.username || 'User';
        const mine = state.user && c.user_id === state.user.id;
        const canDelete = mine || isStaff();
        const badgeKeys = Array.isArray(a.display_badges) ? a.display_badges : [];
        return `<div class="profile-comment">
            <div class="profile-comment-header" onclick="showUserProfile('${c.user_id}')" title="View profile">
                ${a.avatar_url ? `<img class="community-mini-avatar" src="${esc(a.avatar_url)}" alt="">` : `<span class="community-mini-avatar community-mini-avatar-fallback">${esc(name.charAt(0).toUpperCase())}</span>`}
                <strong>${esc(name)}</strong>
                ${api.renderBadgeRow ? api.renderBadgeRow(badgeKeys, 12) : ''}
                <span class="profile-comment-time">${new Date(c.created_at).toLocaleString()}</span>
                ${canDelete ? `<button type="button" class="mon-comment-delete" onclick="event.stopPropagation(); deleteProfileComment('${c.id}')" title="Delete"><i data-lucide="trash-2" style="width:12px;height:12px;"></i></button>` : ''}
            </div>
            <div class="profile-comment-body">${renderCommentMarkdown(c.body)}</div>
        </div>`;
    }).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}


// ==================== USER HOVER CARD ====================
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
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const name = profile.display_name || profile.username || 'Trainer';
    const initial = esc(name.charAt(0).toUpperCase());
    const badges = Array.isArray(profile.display_badges) ? profile.display_badges : [];
    card.innerHTML = `
        <div class="user-hover-card-accent"></div>
        <div class="user-hover-card-top">
            <div class="user-hover-card-avatar">${profile.avatar_url ? `<img src="${esc(profile.avatar_url)}" alt="">` : `<span>${initial}</span>`}</div>
            <div class="user-hover-card-identity">
                <div class="user-hover-card-label">TRAINER CARD</div>
                <strong>${esc(name)}</strong>
                <span>@${esc(profile.username || '')}</span>
            </div>
        </div>
        <div class="user-hover-card-badges">${badges.length && api.renderBadgeRow ? api.renderBadgeRow(badges, 15) : ''}</div>
        ${profile.bio ? `<div class="user-hover-card-bio">${esc(profile.bio)}</div>` : ''}
        ${profile.created_at ? `<div class="user-hover-card-joined">Joined ${new Date(profile.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })}</div>` : ''}
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function userHoverCardSkeleton() {
    return `
        <div class="user-hover-card-accent"></div>
        <div class="user-hover-card-top">
            <div class="user-hover-card-avatar skel skel-circle"></div>
            <div class="user-hover-card-identity">
                <div class="user-hover-card-label">TRAINER CARD</div>
                <strong class="skel skel-text" style="width:110px;height:16px;"></strong>
                <span class="skel skel-text" style="width:70px;margin-top:4px;"></span>
            </div>
        </div>
        <div class="user-hover-card-bio">
            <span class="skel skel-text" style="width:100%;"></span>
            <span class="skel skel-text" style="width:80%;"></span>
        </div>
    `;
}

async function showUserHoverCard(userId, anchor) {
    if (!userId || !anchor) return;
    clearTimeout(userHoverTimer);
    const requestId = ++userHoverRequest;
    const card = ensureUserHoverCard();
    card.innerHTML = userHoverCardSkeleton();
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
        card.innerHTML = '';
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
    try {
        const client = await getClient();
        const value = String(userIdOrUsername || '').trim();
        if (!value) { api.showToast?.('Profile not found.', 'error'); return; }

        // `profiles.id` is a UUID. Never send a username such as "Woogi"
        // through an `eq('id', ...)` filter: PostgREST rejects that request
        // with HTTP 400 before we ever get a chance to fall back to username.
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

async function handleProfileHashRoute() {
    const hash = window.location.hash || '';
    if (!hash.startsWith('#profile/')) return false;
    const username = decodeURIComponent(hash.slice('#profile/'.length));
    if (!username) return false;
    await showUserProfile(username);
    return true;
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
    const list = document.getElementById('profile-badges-list');
    const count = document.getElementById('profile-badge-count');
    if (!list || !state.user) return;
    const owned = Array.isArray(state.user.badges) ? state.user.badges : [];
    const selected = new Set((Array.isArray(state.user.displayBadges) ? state.user.displayBadges : owned).filter(key => owned.includes(key)));
    if (count) count.textContent = `${selected.size} of ${owned.length} shown`;
    if (!owned.length) {
        list.innerHTML = '<div class="profile-badges-empty">You do not have any badges yet.</div>';
        return;
    }
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    list.innerHTML = owned.map(key => {
        const b = api.BADGES?.[key];
        if (!b) return '';
        const checked = selected.has(key) ? ' checked' : '';
        return `<label class="profile-badge-option">
            <input type="checkbox" data-badge="${esc(key)}"${checked}>
            <span class="profile-badge-option-icon"><i data-lucide="${esc(b.icon || 'star')}" style="color:${esc(b.color || 'var(--accent)')};"></i></span>
            <span class="profile-badge-option-copy"><strong>${esc(b.label || key)}</strong><small>${esc(b.tooltip || '')}</small></span>
        </label>`;
    }).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
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
        if (file) await uploadAvatar(file);
        await updateDisplayName(displayName);
        const bio = document.getElementById('profile-bio')?.value.trim() || '';
        const client = await getClient();
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
    const sidebarProfile = document.getElementById('sidebar-profile');
    const sidebarProfileName = document.getElementById('sidebar-profile-name');
    const sidebarProfileUsername = document.getElementById('sidebar-profile-username');
    const sidebarAvatarImg = document.getElementById('sidebar-profile-avatar-img');
    const sidebarAvatarFallback = document.getElementById('sidebar-profile-avatar-fallback');
    const sidebarAuthBtn = document.getElementById('sidebar-auth-btn');
    // The header no longer has sign-in/profile controls (replaced by the
    // notifications bell) - sidebarAuthBtn/sidebarProfile below are the real
    // source of truth now. signedOutEl/signedInEl are kept optional so this
    // still works if a page (e.g. admin.html) still has them.
    api.refreshNotifications?.();
    if (state.user) {
        if (signedOutEl) signedOutEl.style.display = 'none';
        if (signedInEl) signedInEl.style.display = 'flex';
        if (nameEl) nameEl.textContent = state.user.displayName || state.user.username || state.user.email;
        if (sidebarProfile) sidebarProfile.style.display = 'block';
        if (sidebarProfileName) {
            const nameText = state.user.displayName || state.user.username || 'Profile';
            const nameSafe = nameText.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
            sidebarProfileName.innerHTML = `${nameSafe}` + (api.renderBadgeRow ? api.renderBadgeRow(state.user.displayBadges || [], 12) : '');
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
        if (signedOutEl) signedOutEl.style.display = 'flex';
        if (signedInEl) signedInEl.style.display = 'none';
        if (sidebarProfile) sidebarProfile.style.display = 'none';
        if (sidebarAuthBtn) { sidebarAuthBtn.innerHTML = '<i data-lucide="log-in"></i><span>Sign In</span>'; sidebarAuthBtn.onclick = () => { openAuthModal('signin'); closeSidebar(); }; }
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
}

// Accounts can end up without a username - e.g. an old account created before
// usernames were required, or a signup where the username claim failed (see
// signUp's catch block, which still leaves the auth account logged in). Nudge
// those users into the profile page, focused on the username field, right
// after we know who's signed in.
function promptUsernameIfMissing() {
    if (!state.user || state.user.username) return;
    api.showToast?.('Please choose a username to finish setting up your account.', 'warning');
    showProfileView();
    // Give the profile page a tick to render before focusing/scrolling to the field.
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
    showProfileView, showUserProfile, handleProfileHashRoute, exitProfileRoute, editOwnProfile, cancelEditOwnProfile, openProfileModal, closeProfileModal, onProfileAvatarFileChosen, submitProfileForm, renderProfilePage, submitDisplayedBadges, submitProfileComment, deleteProfileComment,
    submitUsernameForm, submitEmailForm, submitRemoveEmail,
    handleSignOutClick, updateAuthUI, promptUsernameIfMissing,
    fetchBadges, currentRole, isStaff, isAdminOrDev, canDeleteAnyContent
};