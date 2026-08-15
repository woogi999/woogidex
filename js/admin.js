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

import { ROLES, BADGES, renderBadgeRow, roleAtLeast } from './data.js';

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

    // admin_search_users is a SECURITY DEFINER RPC (see BADGES_EVERYWHERE_SETUP.sql)
    // — it's the only way to get email/account data, since auth.users is never
    // client-readable directly, even for staff.
    const { data: users, error } = await client.rpc('admin_search_users', { search_query: q });

    if (error) {
        resultsEl.innerHTML = `<div class="admin-empty admin-error">Search failed: ${escapeHtml(error.message)}</div>`;
        return;
    }
    if (!users || !users.length) {
        resultsEl.innerHTML = '<div class="admin-empty">No matching users.</div>';
        return;
    }

    const ids = users.map(u => u.id);
    const { data: badgeRows } = await client.from('profile_badges').select('user_id, badge_key').in('user_id', ids);
    const badgesByUser = {};
    (badgeRows || []).forEach(row => {
        (badgesByUser[row.user_id] ||= []).push(row.badge_key);
    });

    state.results = users.map(u => ({ ...u, badges: badgesByUser[u.id] || [] }));
    renderResults();
}

function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderResults() {
    const resultsEl = $('admin-results');
    const myRank = ROLES[state.me.role]?.rank ?? 0;
    const canManageRoles = ROLES[state.me.role]?.canManageRoles;

    resultsEl.innerHTML = state.results.map(u => {
        const targetRank = ROLES[u.role]?.rank ?? 0;
        const isSelf = u.id === state.me.id;
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
                    <span>${b.label}</span>
                </label>`;
        }).join('');

        return `
            <div class="admin-user-row">
                <div class="admin-user-head">
                    <strong>${escapeHtml(u.username || '(no username)')}</strong>
                    ${renderBadgeRow(u.badges, 14)}
                    ${isSelf ? '<span class="admin-you-tag">you</span>' : ''}
                </div>
                <div class="admin-user-meta">
                    <span>${escapeHtml(u.email || 'no email on file')}</span>
                    <span>Joined ${fmtDate(u.created_at)}</span>
                    <span>Last seen ${fmtDate(u.last_sign_in_at)}</span>
                    <span>${u.published_count ?? 0} published</span>
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
                ${u.published_count > 0 ? `
                <div class="admin-mons-toggle">
                    <button type="button" onclick="window.adminToggleMonsList(this, '${u.id}')">
                        <i data-lucide="chevron-right"></i> View published mons (${u.published_count})
                    </button>
                    <div class="admin-mons-list" id="admin-mons-${u.id}" style="display:none;"></div>
                </div>` : ''}
            </div>`;
    }).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function toggleMonsList(btn, userId) {
    const listEl = $('admin-mons-' + userId);
    const icon = btn.querySelector('i');
    const isOpen = listEl.style.display !== 'none';

    if (isOpen) {
        listEl.style.display = 'none';
        if (icon) icon.setAttribute('data-lucide', 'chevron-right');
        if (typeof lucide !== 'undefined') lucide.createIcons();
        return;
    }

    listEl.style.display = 'block';
    if (icon) icon.setAttribute('data-lucide', 'chevron-down');
    listEl.innerHTML = '<div class="admin-empty">Loading…</div>';

    const client = await getClient();
    const { data: mons, error } = await client
        .from('published_mons')
        .select('id, fakemon_data, published_at')
        .eq('user_id', userId)
        .order('published_at', { ascending: false });

    if (error) {
        listEl.innerHTML = `<div class="admin-empty admin-error">${escapeHtml(error.message)}</div>`;
        return;
    }
    if (!mons || !mons.length) {
        listEl.innerHTML = '<div class="admin-empty">No published mons.</div>';
        if (typeof lucide !== 'undefined') lucide.createIcons();
        return;
    }

    listEl.innerHTML = mons.map(m => `
        <div class="admin-mon-row" id="admin-mon-row-${m.id}">
            <span>${escapeHtml(m.fakemon_data?.name || 'Unnamed')}</span>
            <span class="admin-mon-date">${fmtDate(m.published_at)}</span>
            <button type="button" class="admin-mon-delete" onclick="window.adminDeleteMon('${m.id}', '${userId}')" title="Delete this published mon">
                <i data-lucide="trash-2"></i>
            </button>
        </div>
    `).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function deleteMon(monId, userId) {
    if (!confirm('Remove this published Fakemon from the Community Hub? This cannot be undone.')) return;
    const client = await getClient();
    // admin_delete_published_mon is a SECURITY DEFINER RPC (see
    // BADGES_EVERYWHERE_SETUP.sql) — real enforcement is still the
    // published_mons DELETE RLS policy staff already satisfy directly.
    const { error } = await client.rpc('admin_delete_published_mon', { mon_id: monId });
    if (error) {
        showToast('Could not delete: ' + error.message, 'error');
        return;
    }
    showToast('Published mon removed', 'success');
    const row = $('admin-mon-row-' + monId);
    if (row) row.remove();
    // Keep the visible "N published" count roughly in sync without a full re-search.
    const userEntry = state.results.find(u => u.id === userId);
    if (userEntry) userEntry.published_count = Math.max(0, (userEntry.published_count || 1) - 1);
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
window.adminToggleMonsList = toggleMonsList;
window.adminDeleteMon = deleteMon;
window.adminRunSearch = runSearch;

init();
