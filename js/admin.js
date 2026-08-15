// ==================== ADMIN PANEL ====================
// Deliberately standalone: does NOT import app.js/auth.js/community.js,
// since those are wired to index.html's specific DOM and to each other in
// ways that assume the main site's page structure. This file keeps its own
// tiny Supabase client instead.
//
// SECURITY NOTE: every check in this file is a UX convenience, not the real
// gate. The real gate is Postgres RLS + the admin_set_user_role() RPC
// (see ADMIN_PANEL_SETUP.sql), which independently re-verify staff status
// and rank on every request no matter what this client-side code does or
// doesn't check. Treat this file as "hide the panel from people who
// shouldn't see it", not "the thing standing between users and the data".

import { ROLES, BADGES, roleAtLeast } from './data.js';

const SUPABASE_URL = 'https://qstbascfeolkyxtrqqwv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_B4jEJ--w0XFsgXDmQeJREA_xH1GRBsf';

let supabase = null;
async function getClient() {
    if (supabase) return supabase;
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true }
    });
    return supabase;
}

const state = {
    me: null,        // { id, role }
    results: [],      // last search results, each with .role and .badges attached
};

function $(id) { return document.getElementById(id); }

function showToast(msg, kind) {
    const el = $('admin-toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'admin-toast admin-toast-' + (kind || 'info');
    el.style.display = 'block';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

// ==================== GATE ====================
async function init() {
    const client = await getClient();
    const { data: { session } } = await client.auth.getSession();

    if (!session?.user) {
        renderGate('signedOut');
        return;
    }

    const { data: profile, error } = await client
        .from('profiles')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle();

    if (error || !profile || !['moderator', 'admin', 'developer'].includes(profile.role)) {
        renderGate('forbidden');
        return;
    }

    state.me = { id: session.user.id, role: profile.role };
    renderGate('ok');
    buildBadgeCheckboxTemplate();
    $('admin-search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
    // Show a starting page of users so the panel isn't empty on load.
    runSearch();
}

function renderGate(mode) {
    $('admin-gate-signedout').style.display = mode === 'signedOut' ? 'block' : 'none';
    $('admin-gate-forbidden').style.display = mode === 'forbidden' ? 'block' : 'none';
    $('admin-panel').style.display = mode === 'ok' ? 'block' : 'none';
}

// ==================== SEARCH ====================
async function runSearch() {
    const client = await getClient();
    const q = $('admin-search-input').value.trim();
    const resultsEl = $('admin-results');
    resultsEl.innerHTML = '<div class="admin-empty">Loading…</div>';

    let query = client.from('profiles').select('id, username, role').order('username', { ascending: true }).limit(30);
    if (q) query = query.ilike('username', `%${q}%`);
    const { data: profiles, error } = await query;

    if (error) {
        resultsEl.innerHTML = `<div class="admin-empty admin-error">Search failed: ${escapeHtml(error.message)}</div>`;
        return;
    }
    if (!profiles || !profiles.length) {
        resultsEl.innerHTML = '<div class="admin-empty">No matching users.</div>';
        return;
    }

    // Batch-fetch badges for everyone in this page of results.
    const ids = profiles.map(p => p.id);
    const { data: badgeRows } = await client.from('profile_badges').select('user_id, badge_key').in('user_id', ids);
    const badgesByUser = {};
    (badgeRows || []).forEach(row => {
        (badgesByUser[row.user_id] ||= []).push(row.badge_key);
    });

    state.results = profiles.map(p => ({ ...p, badges: badgesByUser[p.id] || [] }));
    renderResults();
}

function renderResults() {
    const resultsEl = $('admin-results');
    const myRank = ROLES[state.me.role]?.rank ?? 0;
    const canManageRoles = ROLES[state.me.role]?.canManageRoles;

    resultsEl.innerHTML = state.results.map(u => {
        const targetRank = ROLES[u.role]?.rank ?? 0;
        const isSelf = u.id === state.me.id;
        // Can't act on someone who outranks you, and role dropdown options
        // are capped at your own rank — mirrors admin_set_user_role()'s
        // server-side check, so the UI won't offer something the DB would
        // just reject anyway.
        const roleLocked = !canManageRoles || targetRank > myRank || isSelf;
        const roleOptions = Object.entries(ROLES)
            .filter(([, r]) => r.rank <= myRank)
            .map(([key, r]) => `<option value="${key}" ${key === u.role ? 'selected' : ''}>${r.label}</option>`)
            .join('');

        const badgeChecks = Object.entries(BADGES).map(([key, b]) => {
            const checked = u.badges.includes(key) ? 'checked' : '';
            return `
                <label class="admin-badge-check" title="${escapeHtml(b.tooltip)}">
                    <input type="checkbox" data-user="${u.id}" data-badge="${key}" ${checked}
                        onchange="window.adminToggleBadge(this)">
                    <span>${b.icon} ${b.label}</span>
                </label>`;
        }).join('');

        return `
            <div class="admin-user-row">
                <div class="admin-user-head">
                    <strong>${escapeHtml(u.username || '(no username)')}</strong>
                    ${isSelf ? '<span class="admin-you-tag">you</span>' : ''}
                </div>
                <div class="admin-user-controls">
                    <label class="admin-field-label">Role
                        <select data-user="${u.id}" data-prev-role="${u.role}" ${roleLocked ? 'disabled' : ''}
                            onchange="window.adminChangeRole(this)">
                            ${roleOptions}
                        </select>
                    </label>
                    <div class="admin-badge-grid">${badgeChecks}</div>
                </div>
            </div>`;
    }).join('');
}

function buildBadgeCheckboxTemplate() {
    // no-op placeholder kept for clarity/extensibility; badges are built
    // per-row in renderResults() since availability depends on the row.
}

// ==================== ACTIONS ====================
async function adminChangeRole(selectEl) {
    const client = await getClient();
    const targetId = selectEl.dataset.user;
    const prevRole = selectEl.dataset.prevRole;
    const newRole = selectEl.value;
    selectEl.disabled = true;

    const { error } = await client.rpc('admin_set_user_role', { target_user_id: targetId, new_role: newRole });

    if (error) {
        showToast('Could not change role: ' + error.message, 'error');
        selectEl.value = prevRole; // revert visually
    } else {
        selectEl.dataset.prevRole = newRole;
        showToast('Role updated to ' + (ROLES[newRole]?.label || newRole), 'success');
    }
    selectEl.disabled = false;
}

async function adminToggleBadge(checkboxEl) {
    const client = await getClient();
    const targetId = checkboxEl.dataset.user;
    const badgeKey = checkboxEl.dataset.badge;
    checkboxEl.disabled = true;

    let error;
    if (checkboxEl.checked) {
        ({ error } = await client.from('profile_badges').insert({
            user_id: targetId, badge_key: badgeKey, granted_by: state.me.id
        }));
    } else {
        ({ error } = await client.from('profile_badges').delete().eq('user_id', targetId).eq('badge_key', badgeKey));
    }

    if (error) {
        showToast('Could not update badge: ' + error.message, 'error');
        checkboxEl.checked = !checkboxEl.checked; // revert
    } else {
        showToast(checkboxEl.checked ? 'Badge granted' : 'Badge removed', 'success');
    }
    checkboxEl.disabled = false;
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// Exposed for inline onclick/onchange handlers (matches the rest of the site's pattern).
window.adminChangeRole = adminChangeRole;
window.adminToggleBadge = adminToggleBadge;
window.adminRunSearch = runSearch;

init();
