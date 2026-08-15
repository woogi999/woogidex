import { log } from './log.js';
import { state, api } from './app.js';

// ==================== SUPABASE CLIENT ====================
// Loaded from CDN as an ES module — no npm/bundler needed.
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

// Supabase's auth.users row carries our custom fields inside user_metadata
// (set via auth.updateUser({ data: {...} })). Flatten that onto state.user so
// the rest of the app can just read state.user.displayName / .avatarUrl.
function mapUser(supabaseUser) {
    const meta = supabaseUser.user_metadata || {};
    return {
        id: supabaseUser.id,
        email: supabaseUser.email,
        displayName: meta.display_name || '',
        avatarUrl: meta.avatar_url || ''
    };
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
        state.user = session?.user ? mapUser(session.user) : null;
        state.authReady = true;
        log.info('AUTH', 'Session restored', { loggedIn: !!state.user });
        updateAuthUI();

        client.auth.onAuthStateChange(async (event, session) => {
            log.debug('AUTH', 'Auth state change', { event });
            const wasLoggedIn = !!state.user;
            state.user = session?.user ? mapUser(session.user) : null;
            updateAuthUI();

            if (event === 'SIGNED_IN' && !wasLoggedIn) {
                // Pull this user's cloud collection and merge it into the local one.
                await api.pullFromCloud?.();
                api.renderCollection?.();
                api.showToast?.(`Signed in as ${state.user.email}`, 'success');
            }
            if (event === 'SIGNED_OUT') {
                api.renderCollection?.();
                api.showToast?.('Signed out', 'info');
            }
        });

        return state.user;
    })();
    return authInitPromise;
}

// ==================== ACTIONS ====================
async function signUp(email, password) {
    const client = await getClient();
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) { log.error('AUTH', 'Sign up failed', error); throw error; }
    log.info('AUTH', 'Sign up succeeded', { email });
    return data;
}

async function signIn(email, password) {
    const client = await getClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) { log.error('AUTH', 'Sign in failed', error); throw error; }
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

// ==================== PROFILE (display name + avatar) ====================
const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const AVATAR_BUCKET = 'avatars';

async function updateDisplayName(displayName) {
    const client = await getClient();
    const { data, error } = await client.auth.updateUser({ data: { display_name: displayName } });
    if (error) { log.error('AUTH', 'Display name update failed', error); throw error; }
    state.user = mapUser(data.user);
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
    state.user = mapUser(data.user);
    updateAuthUI();
    return state.user;
}

// ==================== UI ====================
function openAuthModal(mode = 'signin') {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    document.getElementById('auth-modal-error').textContent = '';
    document.getElementById('auth-email').value = '';
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
    modal.dataset.mode = mode;
    if (mode === 'signup') {
        title.textContent = 'Create Account';
        submitBtn.textContent = 'Sign Up';
        switchLink.textContent = 'Already have an account? Sign in';
    } else {
        title.textContent = 'Sign In';
        submitBtn.textContent = 'Sign In';
        switchLink.textContent = "Don't have an account? Sign up";
    }
}

function toggleAuthMode() {
    const modal = document.getElementById('auth-modal');
    setAuthMode(modal.dataset.mode === 'signup' ? 'signin' : 'signup');
}

async function submitAuthForm() {
    const modal = document.getElementById('auth-modal');
    const mode = modal.dataset.mode;
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const errorEl = document.getElementById('auth-modal-error');
    const submitBtn = document.getElementById('auth-submit-btn');
    errorEl.textContent = '';

    if (!email || !password) { errorEl.textContent = 'Email and password are required.'; return; }
    if (password.length < 6) { errorEl.textContent = 'Password must be at least 6 characters.'; return; }

    submitBtn.disabled = true;
    submitBtn.textContent = mode === 'signup' ? 'Signing up…' : 'Signing in…';
    try {
        if (mode === 'signup') {
            const result = await signUp(email, password);
            if (!result.session) {
                // Email confirmation required by your Supabase project settings.
                errorEl.style.color = 'var(--success, #22c55e)';
                errorEl.textContent = 'Check your email to confirm your account.';
                submitBtn.disabled = false;
                submitBtn.textContent = 'Sign Up';
                return;
            }
        } else {
            await signIn(email, password);
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
    modal.classList.add('active');
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
    if (file.size > AVATAR_MAX_BYTES) { errorEl.textContent = `Image is ${(file.size / 1024 / 1024).toFixed(1)}MB — max is 2MB.`; input.value = ''; return; }
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

function updateAuthUI() {
    const signedOutEl = document.getElementById('auth-signed-out');
    const signedInEl = document.getElementById('auth-signed-in');
    const nameEl = document.getElementById('auth-user-name');
    const avatarImg = document.getElementById('auth-avatar-img');
    const avatarFallback = document.getElementById('auth-avatar-fallback');
    if (!signedOutEl || !signedInEl) return;
    if (state.user) {
        signedOutEl.style.display = 'none';
        signedInEl.style.display = 'flex';
        if (nameEl) nameEl.textContent = state.user.displayName || state.user.email;
        if (avatarImg && avatarFallback) {
            if (state.user.avatarUrl) {
                avatarImg.src = state.user.avatarUrl;
                avatarImg.style.display = 'block';
                avatarFallback.style.display = 'none';
            } else {
                avatarImg.style.display = 'none';
                avatarFallback.style.display = 'flex';
                avatarFallback.textContent = (state.user.displayName || state.user.email || '?').charAt(0).toUpperCase();
            }
        }
    } else {
        signedOutEl.style.display = 'flex';
        signedInEl.style.display = 'none';
    }
}

export {
    initAuth, getClient, signUp, signIn, signOut, resetPassword,
    getCurrentUser, isLoggedIn, updateDisplayName, uploadAvatar,
    openAuthModal, closeAuthModal, toggleAuthMode, submitAuthForm,
    openProfileModal, closeProfileModal, onProfileAvatarFileChosen, submitProfileForm,
    handleSignOutClick, updateAuthUI
};
