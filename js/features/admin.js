import '../core/vendor.js';
import { getClient } from '../core/supabase.js';
import * as mod from './admin-moderation.js';
// ==================== Admin Panel ====================
// Deliberately standalone: doesn't import app.js/auth.js/community.js, which
// assume index.html's DOM. Keeps its own tiny Supabase client + sign-in form.
//
// Security note: checks here are UX only. The real gate is Postgres RLS plus
// the admin_* SECURITY DEFINER RPCs (see BADGES_UNIFIED_SETUP.sql), which
// re-verify staff status and rank server-side regardless of this code.
//
// Model: roles and badges are merged. A "badge" (badges table) carries
// label/icon/color/description/rank/permissions; a user can hold several
// (profile_badges). Effective perms = union of held badges; effective rank
// = max rank among them. No separate role dropdown - badges ARE the role.



// Every capability a badge can carry, in editor order; keys match the can_*
// columns on `badges` and the names public.has_perm() answers to.
const PERMISSIONS = [
    ['delete_content', 'Delete content',   'Remove any comment or published Fakemon'],
    ['purge_content',  'Bulk purge',       'Mass-delete a user\'s comments or Fakemon'],
    ['warn',           'Warn',             'Issue warnings (counts toward auto-escalation)'],
    ['mute',           'Mute',             'Stop an account posting, temporarily or until lifted'],
    ['ban',            'Suspend',          'Suspend an account at the auth layer'],
    ['delete_users',   'Delete accounts',  'Permanently erase an account and everything it posted'],
    ['manage_filter',  'Content filter',   'Add, edit and disable auto-moderator rules'],
    ['view_ips',       'View addresses',   'See sign-in / registration IPs and locations'],
    ['view_log',       'Moderation log',   'Read the full moderation history'],
    ['manage_events',  'Events',           'Create and run events and contests'],
    ['manage_badges',  'Badges',           'Create badges and assign them to users'],
    ['manage_limits',  'Limits',           'Set the site-wide quotas and the per-badge overrides'],
];

const state = {
    me: null,        // { id, name, badgeKeys:[], rank, perms:{...} }
    results: [],      // last user search results, each with .badgeKeys attached
    badges: [],       // live rows from the `badges` table, sorted rank desc
    limits: null,     // the single public.site_limits row
};

function badgesByKey() {
    const map = {};
    state.badges.forEach(b => { map[b.key] = b; });
    return map;
}

async function loadBadges() {
    const client = await getClient();
    const { data, error } = await client.from('badges').select('*').order('rank', { ascending: false });
    if (error) { showToast('Could not load badges: ' + error.message, 'error'); return; }
    state.badges = data || [];
}

function $(id) { return document.getElementById(id); }

// ==================== dark mode ====================
// shares index.html's localStorage key so the preference carries over between pages.
function updateDarkModeIcon(isDark) {
    const icon = $('admin-dark-icon');
    if (icon) icon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}
function loadDarkMode() {
    const isDark = localStorage.getItem('woogidex-dark-mode') === 'true';
    if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    updateDarkModeIcon(isDark);
}
function toggleDarkMode() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('woogidex-dark-mode', 'false');
        updateDarkModeIcon(false);
    } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('woogidex-dark-mode', 'true');
        updateDarkModeIcon(true);
    }
}
loadDarkMode();

function showToast(msg, kind) {
    const el = $('admin-toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'admin-toast admin-toast-' + (kind || 'info');
    el.style.display = 'block';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

function icons() { if (typeof lucide !== 'undefined') lucide.createIcons(); }

// ==================== Sign In / Out ====================
// mirrors js/auth.js's signIn (duplicated since this file stays standalone).
async function signIn(identifier, password) {
    const client = await getClient();
    const trimmed = identifier.trim();

    if (trimmed.includes('@')) {
        const { error } = await client.auth.signInWithPassword({ email: trimmed, password });
        if (error) throw new Error('Invalid username or password.');
        return;
    }

    const { data: result, error: fnError } = await client.functions.invoke('login-with-identifier', {
        body: { identifier: trimmed, password }
    });
    if (fnError || !result?.ok || !result?.session) {
        throw new Error(result?.error || 'Invalid username or password.');
    }

    const { error: setError } = await client.auth.setSession({
        access_token: result.session.access_token,
        refresh_token: result.session.refresh_token,
    });
    if (setError) throw new Error('Invalid username or password.');
}

async function handleSignInSubmit(e) {
    e.preventDefault();
    const errorEl = $('admin-signin-error');
    const btn = $('admin-signin-btn');
    errorEl.textContent = '';
    btn.disabled = true;
    try {
        await signIn($('admin-signin-identifier').value, $('admin-signin-password').value);
        await init();
    } catch (err) {
        errorEl.textContent = err.message || 'Sign in failed.';
    } finally {
        btn.disabled = false;
    }
}

async function signOut() {
    const client = await getClient();
    await client.auth.signOut();
    renderGate('signedOut');
}

// ==================== Gate ====================
async function init() {
    const client = await getClient();
    const { data: { session } } = await client.auth.getSession();

    if (!session?.user) {
        renderGate('signedOut');
        return;
    }

    await loadBadges();

    const { data: myProfile } = await client.from('profiles').select('username, display_name').eq('id', session.user.id).maybeSingle();
    const { data: myBadgeRows } = await client.from('profile_badges').select('badge_key').eq('user_id', session.user.id);
    const myKeys = (myBadgeRows || []).map(r => r.badge_key);

    // Perms come from the server, not the badge rows read above, so the panel
    // can't disagree with the RPCs about what this account may do.
    const { data: perms } = await client.rpc('my_permissions');
    if (!perms?.staff) {
        renderGate('forbidden');
        return;
    }

    state.me = {
        id: session.user.id,
        name: publicName(myProfile),
        badgeKeys: myKeys,
        rank: perms.rank || 0,
        perms,
        // kept for the few older call sites that still read these names
        canManageBadges: !!perms.manage_badges,
        canDeleteAny: !!perms.delete_content,
    };

    $('admin-whoami-name').textContent = state.me.name;
    renderGate('ok');
    // admin-moderation.js owns Users/Comments/Filter/Mod Log; gets helpers
    // passed in rather than importing back, to avoid a module cycle.
    mod.install({ state, showToast, runSearch });
    renderBadgesPanel();
    if (!state.me.perms.manage_events) {
        const evTab = $('admin-tab-events');
        if (evTab) evTab.style.display = 'none';
    }
    $('admin-search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
    runSearch();
    if (state.me.perms.manage_events) loadContestAdmin();
    if (state.me.perms.manage_limits) loadSiteLimits();
}

function renderGate(mode) {
    $('admin-gate-signedout').style.display = mode === 'signedOut' ? 'block' : 'none';
    $('admin-gate-forbidden').style.display = mode === 'forbidden' ? 'block' : 'none';
    $('admin-panel').style.display = mode === 'ok' ? 'block' : 'none';
    $('admin-signed-in-actions').style.display = mode === 'ok' ? 'inline' : 'none';
    $('admin-signout-btn').style.display = mode === 'signedOut' ? 'none' : 'inline-flex';
    icons();
}

// ==================== Badges Panel ====================
function renderBadgesPanel() {
    const section = $('admin-badges-section');
    const tab = $('admin-tab-badges');
    // must hide the tab button too, or the tab switcher shows the section right back.
    if (!state.me.perms.manage_badges) {
        section.style.display = 'none';
        if (tab) tab.style.display = 'none';
        return;
    }

    const cards = state.badges.map(b => {
        // only capabilities actually granted, so a cosmetic badge reads as cosmetic.
        const perms = PERMISSIONS
            .filter(([key]) => b['can_' + key])
            .map(([, label]) => `<span class="admin-perm-pill on">${escapeHtml(label)}</span>`)
            .join('') || '<span class="admin-perm-pill">cosmetic</span>';
        const locked = b.rank >= state.me.rank;
        return `
            <div class="admin-badge-card">
                <div class="admin-badge-card-top">
                    <div class="admin-badge-icon-chip" style="background:${escapeHtml(b.color)}22;color:${escapeHtml(b.color)};">
                        <i data-lucide="${escapeHtml(b.icon || 'star')}"></i>
                    </div>
                    <div>
                        <div class="admin-badge-card-title">${escapeHtml(b.label)}</div>
                        <div class="admin-badge-card-rank">rank ${b.rank}</div>
                    </div>
                </div>
                ${b.description ? `<div class="admin-badge-card-desc">${escapeHtml(b.description)}</div>` : ''}
                <div class="admin-badge-card-perms">${perms}</div>
                <div class="admin-badge-card-actions">
                    <button type="button" onclick="window.adminEditBadge('${b.key}')" ${locked ? 'disabled title="Rank too high to edit"' : ''}>
                        <i data-lucide="pencil"></i> edit
                    </button>
                </div>
            </div>`;
    }).join('');

    $('admin-badges-grid').innerHTML = cards + `
        <button type="button" class="admin-add-badge-card" onclick="window.adminAddBadge()">
            <i data-lucide="plus-circle"></i> new badge
        </button>`;
    icons();
}

// Checkboxes generated from PERMISSIONS instead of hardcoded HTML, so a new
// capability is a one-line change here plus the has_perm() CASE.
function renderBadgePermissionInputs(badge) {
    $('admin-badge-perms').innerHTML = PERMISSIONS.map(([key, label, help]) => `
        <label class="admin-checkbox-row" title="${escapeHtml(help)}">
            <input type="checkbox" data-perm="${key}" ${badge && badge['can_' + key] ? 'checked' : ''}>
            <span>${escapeHtml(label)}<small>${escapeHtml(help)}</small></span>
        </label>`).join('');
}

function openBadgeForm(existingKey) {
    const b = existingKey ? badgesByKey()[existingKey] : null;
    $('admin-badge-form-title').textContent = b ? `edit "${b.label}"` : 'new badge';
    $('admin-badge-key').value = b ? b.key : '';
    $('admin-badge-key').disabled = !!b; // key is the primary key - don't allow renaming it
    $('admin-badge-label').value = b ? b.label : '';
    $('admin-badge-icon').value = b ? b.icon : 'star';
    $('admin-badge-color').value = b ? b.color : '#6b7280';
    $('admin-badge-description').value = b ? (b.description || '') : '';
    $('admin-badge-rank').value = b ? b.rank : 0;
    renderBadgePermissionInputs(b);
    // Empty means "inherit" (null); `|| ''` would wrongly blank a real 0 too.
    const num = v => (v === null || v === undefined ? '' : String(v));
    $('admin-badge-limit-items').value = num(b?.limit_cloud_items);
    $('admin-badge-limit-uploads').value = num(b?.limit_community_uploads);
    $('admin-badge-limit-cooldown').value = num(b?.limit_publish_cooldown_seconds);
    $('admin-badge-limit-auto').checked = !!b?.can_auto_backup;
    // Read-only (not hidden) without manage_limits: viewing is fine, editing is gated.
    const mayEditLimits = !!state.me.perms.manage_limits;
    ['items', 'uploads', 'cooldown'].forEach(k => { $('admin-badge-limit-' + k).disabled = !mayEditLimits; });
    $('admin-badge-limit-auto').disabled = !mayEditLimits;

    $('admin-badge-delete-btn').style.display = b ? 'inline-flex' : 'none';
    $('admin-badge-form-modal').dataset.editingKey = existingKey || '';
    previewBadgeIcon();
    $('admin-badge-form-modal').classList.add('active');
}

function closeBadgeForm() {
    $('admin-badge-form-modal').classList.remove('active');
}

function previewBadgeIcon() {
    const i = $('admin-badge-icon-preview-i');
    const wrap = $('admin-badge-icon-preview');
    const name = $('admin-badge-icon').value.trim() || 'star';
    const color = $('admin-badge-color').value;
    i.setAttribute('data-lucide', name);
    wrap.style.background = color + '22';
    wrap.style.color = color;
    icons();
}

async function submitBadgeForm(event) {
    event.preventDefault();
    const client = await getClient();
    const key = $('admin-badge-key').value.trim().toLowerCase();
    if (!/^[a-z0-9_]{2,24}$/.test(key)) {
        showToast('Badge key must be 2-24 lowercase letters/numbers/underscores.', 'error');
        return;
    }
    const rank = parseInt($('admin-badge-rank').value, 10) || 0;
    if (rank >= state.me.rank) {
        showToast(`Rank must be lower than your own rank (${state.me.rank}).`, 'error');
        return;
    }
    const perms = {};
    $('admin-badge-perms').querySelectorAll('input[data-perm]').forEach(input => {
        perms[input.dataset.perm] = input.checked;
    });
    // Empty stays null ("inherit site default") - coercing to 0 would silently cap holders at nothing.
    const limitField = id => {
        const raw = $(id).value.trim();
        return raw === '' ? null : parseInt(raw, 10);
    };
    const payload = {
        p_key: key,
        p_label: $('admin-badge-label').value.trim() || key,
        p_icon: $('admin-badge-icon').value.trim() || 'star',
        p_color: $('admin-badge-color').value,
        p_description: $('admin-badge-description').value.trim(),
        p_rank: rank,
        p_perms: perms,
        p_limits: {
            cloud_items: limitField('admin-badge-limit-items'),
            community_uploads: limitField('admin-badge-limit-uploads'),
            publish_cooldown_seconds: limitField('admin-badge-limit-cooldown'),
            auto_backup: $('admin-badge-limit-auto').checked,
        },
    };
    // SECURITY DEFINER RPC - re-checks manage_badges, manage_limits, and rank server-side.
    const { error } = await client.rpc('admin_upsert_badge_v3', payload);
    if (error) {
        showToast('Could not save badge: ' + error.message, 'error');
        return;
    }
    showToast('Badge saved', 'success');
    closeBadgeForm();
    await loadBadges();
    renderBadgesPanel();
    renderResults(); // refresh badge checkboxes/labels with new data
}

async function deleteBadge() {
    const key = $('admin-badge-form-modal').dataset.editingKey;
    if (!key) return;
    const label = badgesByKey()[key]?.label || key;
    closeBadgeForm();
    const answer = await mod.ask({
        title: 'delete badge',
        blurb: `Delete <strong>${escapeHtml(label)}</strong>. This removes it from every user who holds it, along with any permissions it granted them.`,
        confirm: 'delete badge', requireReason: false, danger: true
    });
    if (!answer) return;
    const client = await getClient();
    const { error } = await client.rpc('admin_delete_badge', { p_key: key });
    if (error) {
        showToast('Could not delete: ' + error.message, 'error');
        return;
    }
    showToast('Badge deleted', 'success');
    closeBadgeForm();
    await loadBadges();
    renderBadgesPanel();
    runSearch();
}

// ==================== Limits Panel ====================
// Site-wide defaults; per-badge overrides live in the badge editor instead.
// Enforced in Postgres (enforce_collection_quota(), published_mons_enforce_cooldown()
// via effective_limits()), so this is advisory here regardless of what loads this page.
async function loadSiteLimits() {
    const client = await getClient();
    const { data, error } = await client.from('site_limits').select('*').maybeSingle();
    if (error) { showToast('Could not load limits: ' + error.message, 'error'); return; }
    state.limits = data || null;
    renderLimitsPanel();
}

function renderLimitsPanel() {
    if (!state.limits) return;
    const l = state.limits;
    $('admin-limit-cloud-items').value = l.cloud_items;
    // Stored in bytes, shown in MB: nobody wants to type 5242880.
    $('admin-limit-cloud-mb').value = Math.round((Number(l.cloud_bytes) / 1048576) * 10) / 10;
    $('admin-limit-uploads').value = l.community_uploads;
    $('admin-limit-cooldown').value = l.publish_cooldown_seconds;
    $('admin-limit-auto-backup').checked = !!l.auto_backup_enabled;
}

async function submitLimits(event) {
    event.preventDefault();
    const items = parseInt($('admin-limit-cloud-items').value, 10);
    const mb = parseFloat($('admin-limit-cloud-mb').value);
    const uploads = parseInt($('admin-limit-uploads').value, 10);
    const cooldown = parseInt($('admin-limit-cooldown').value, 10);

    // -1 means unlimited; any other negative would pass this check but confuse the trigger.
    if (!Number.isFinite(items) || items < -1) return showToast('Cloud backup items must be -1 or higher.', 'error');
    if (!Number.isFinite(uploads) || uploads < -1) return showToast('Community uploads must be -1 or higher.', 'error');
    if (!Number.isFinite(cooldown) || cooldown < 0) return showToast('Cooldown cannot be negative.', 'error');
    if (!Number.isFinite(mb) || mb <= 0) return showToast('Backup size must be greater than zero.', 'error');

    const client = await getClient();
    const { error } = await client.rpc('admin_set_site_limits', {
        p_cloud_items: items,
        p_cloud_bytes: Math.round(mb * 1048576),
        p_community_uploads: uploads,
        p_publish_cooldown_seconds: cooldown,
        p_auto_backup_enabled: $('admin-limit-auto-backup').checked,
    });
    if (error) { showToast('Could not save limits: ' + error.message, 'error'); return; }
    showToast('Limits saved', 'success');
    await loadSiteLimits();
}

// ==================== Search / Users ====================
async function runSearch() {
    const client = await getClient();
    const q = $('admin-search-input').value.trim();
    const resultsEl = $('admin-results');
    resultsEl.innerHTML = '<div class="admin-empty">Loading…</div>';

    // SECURITY DEFINER RPC - only way to get email/account data since auth.users
    // is never client-readable, even for staff.
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

    state.results = users.map(u => ({ ...u, badgeKeys: badgesByUser[u.id] || [] }));
    renderResults();
}

function fmtDate(iso) {
    if (!iso) return '-';
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function userRank(badgeKeys) {
    const map = badgesByKey();
    return badgeKeys.reduce((m, k) => Math.max(m, map[k]?.rank ?? 0), 0);
}

function renderResults() {
    const resultsEl = $('admin-results');

    resultsEl.innerHTML = state.results.map(u => {
        const isSelf = u.id === state.me.id;
        const targetRank = Number.isFinite(u.rank) ? u.rank : userRank(u.badgeKeys);
        // Self-editing allowed; only equal/higher-rank other users stay locked.
        const rowLocked = !state.me.perms.manage_badges || (!isSelf && targetRank >= state.me.rank);

        const rowBadges = u.badgeKeys.map(k => {
            const b = badgesByKey()[k];
            if (!b) return '';
            return b.rank > 0
                ? `<span class="role-tag" style="color:${escapeHtml(b.color)};border-color:${escapeHtml(b.color)};">${escapeHtml(b.label)}</span>`
                : `<i data-lucide="${escapeHtml(b.icon || 'star')}" class="profile-badge" title="${escapeHtml(b.label)}" style="width:14px;height:14px;color:${escapeHtml(b.color)};"></i>`;
        }).join('');

        const badgeChecks = state.badges.map(b => {
            const checked = u.badgeKeys.includes(b.key) ? 'checked' : '';
            // assignable only by someone strictly higher rank (mirrors server check).
            const disabled = rowLocked || b.rank >= state.me.rank;
            return `
                <label class="admin-badge-check ${disabled ? 'locked' : ''}" title="${escapeHtml(b.description || b.label)}">
                    <input type="checkbox" data-badge="${b.key}" ${checked} ${disabled ? 'disabled' : ''}
                        onchange="window.adminBadgeCheckboxChanged('${u.id}')">
                    <i data-lucide="${escapeHtml(b.icon || 'star')}" style="color:${escapeHtml(b.color)};"></i>
                    <span>${escapeHtml(b.label)}</span>
                </label>`;
        }).join('');

        return `
            <div class="admin-user-row" id="admin-user-row-${u.id}">
                <div class="admin-user-head">
                    <strong>${escapeHtml(u.display_name || u.username || '(no username)')}</strong>
                    ${u.display_name && u.username ? `<span class="admin-user-handle">@${escapeHtml(u.username)}</span>` : ''}
                    ${rowBadges}
                    ${isSelf ? '<span class="admin-you-tag">you</span>' : ''}
                    ${mod.standingPills(u)}
                </div>
                <div class="admin-user-meta">
                    <span>${escapeHtml(u.email || 'no email on file')}</span>
                    <span>Joined ${fmtDate(u.created_at)}</span>
                    <span>Last seen ${fmtDate(u.last_sign_in_at)}</span>
                    <span>${u.published_count ?? 0} published</span>
                </div>
                <div>
                    <span class="admin-badge-select-label">Badges</span>
                    <div class="admin-badge-select-grid" data-user="${u.id}">${badgeChecks}</div>
                    ${!rowLocked ? `<button type="button" class="btn btn-secondary btn-sm" style="margin-top:10px;display:none;" id="admin-save-badges-${u.id}" onclick="window.adminSaveBadges('${u.id}')">
                        <i data-lucide="check" style="width:14px;height:14px;"></i> Save badges
                    </button>` : ''}
                </div>
                ${u.published_count > 0 ? `
                <div class="admin-mons-toggle">
                    <button type="button" onclick="window.adminToggleMonsList(this, '${u.id}')">
                        <i data-lucide="chevron-right"></i> View published mons (${u.published_count})
                    </button>
                    <div class="admin-mons-list" id="admin-mons-${u.id}" style="display:none;"></div>
                </div>` : ''}
                ${mod.moderationBar(u, isSelf || targetRank >= state.me.rank)}
            </div>`;
    }).join('');
    icons();
    // Standing pills / moderation bar are React islands - mount after containers are in the DOM.
    mod.mountUserRowIslands();
}

function badgeCheckboxChanged(userId) {
    const btn = $('admin-save-badges-' + userId);
    if (btn) btn.style.display = 'inline-flex';
}

async function saveBadges(userId) {
    const client = await getClient();
    const grid = document.querySelector(`.admin-badge-select-grid[data-user="${userId}"]`);
    const btn = $('admin-save-badges-' + userId);
    const checked = [...grid.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.dataset.badge);

    if (btn) { btn.disabled = true; }

    // SECURITY DEFINER RPC - re-checks can_manage_badges and rank hierarchy server-side.
    const { error } = await client.rpc('admin_set_user_badges', { target_user_id: userId, new_badge_keys: checked });

    if (error) {
        showToast('Could not update badges: ' + error.message, 'error');
        if (btn) btn.disabled = false;
        return;
    }
    showToast('Badges updated', 'success');
    const entry = state.results.find(u => u.id === userId);
    if (entry) entry.badgeKeys = checked;
    if (btn) btn.style.display = 'none';
    renderResults();
}

// ==================== Published Mons ====================
async function toggleMonsList(btn, userId) {
    const listEl = $('admin-mons-' + userId);
    const icon = btn.querySelector('i');
    const isOpen = listEl.style.display === 'block';

    if (isOpen) {
        listEl.style.display = 'none';
        if (icon) icon.setAttribute('data-lucide', 'chevron-right');
        icons();
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
        icons();
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
    icons();
}

async function deleteMon(monId, userId) {
    const answer = await mod.ask({
        title: 'remove published fakemon',
        blurb: 'Removes this listing from the Community Hub. The owner is notified with your reason.',
        confirm: 'remove'
    });
    if (!answer) return;
    const reason = answer.reason;
    const client = await getClient();
    // SECURITY DEFINER RPC - checks my_can_delete_any(), deletes, and notifies the owner.
    const { error } = await client.rpc('admin_delete_published_mon', { mon_id: monId, p_reason: reason.trim() });
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

// ==================== Events / Contests ====================
const contestAdmin = { events: [], contests: [] };
const toInputDate = v => v ? new Date(v).toISOString().slice(0,16) : '';
const fromInputDate = id => { const v=$(id)?.value; return v ? new Date(v).toISOString() : null; };
async function loadContestAdmin() {
    const client=await getClient();
    const [{data:events,error:e1},{data:contests,error:e2}] = await Promise.all([
        client.from('contest_events').select('*').order('starts_at',{ascending:false}),
        client.from('contests').select('*').order('created_at',{ascending:false})
    ]);
    if(e1||e2){ showToast((e1||e2).message,'error'); return; }
    contestAdmin.events=events||[]; contestAdmin.contests=contests||[]; renderContestAdmin();
}
function renderContestAdmin(){
    const el=$('admin-events-list'); if(!el) return;
    el.innerHTML = contestAdmin.events.length ? contestAdmin.events.map(e=>`<div class="admin-contest-event"><div class="admin-section-head"><div><strong>${escapeHtml(e.title)}</strong><div class="admin-section-sub">${escapeHtml(e.description||'')} · ${fmtDate(e.starts_at)} → ${fmtDate(e.ends_at)}</div></div><div style="display:flex;gap:6px"><button class="btn btn-secondary btn-sm" onclick="window.adminEditEvent('${e.id}')">Edit</button><button class="btn btn-primary btn-sm" onclick="window.adminAddContest('${e.id}')">Add contest</button><button class="btn btn-danger btn-sm" onclick="window.adminDeleteEvent('${e.id}')">Delete event</button></div></div><div>${contestAdmin.contests.filter(c=>c.event_id===e.id).map(renderContestAdminRow).join('')||'<div class="admin-empty">No contests yet.</div>'}</div></div>`).join('') : '<div class="admin-empty">No events yet.</div>';
    icons();
}
function describeWinnerCriteria(wc){
    wc = wc || {};
    const parts = [];
    if (wc.top_n) parts.push(`top ${wc.top_n}`);
    if (wc.top_percent) parts.push(`top ${wc.top_percent}%`);
    if (wc.min_score_percent) parts.push(`≥${wc.min_score_percent}% score`);
    return parts.length ? parts.join(' or ') : 'top 3 (default)';
}
function renderContestAdminRow(c){
    const maxSubs = c.max_submissions_per_user || 1;
    return `<div class="admin-contest-row"><div><strong>${escapeHtml(c.title)}</strong><div class="admin-section-sub">Phase: ${escapeHtml(c.phase)} · submissions ${fmtDate(c.submission_deadline)} · voting ${fmtDate(c.voting_start)} → ${fmtDate(c.voting_deadline)}</div><div class="admin-section-sub">Max ${maxSubs} submission${maxSubs===1?'':'s'} per user · Winners: ${escapeHtml(describeWinnerCriteria(c.winner_criteria))}</div></div><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-secondary btn-sm" onclick="window.adminEditContest('${c.id}')">Edit</button><button class="btn btn-secondary btn-sm" onclick="window.adminViewContestSubmissions('${c.id}')">View submissions</button><button class="btn btn-secondary btn-sm" onclick="window.adminViewContestVotes('${c.id}')">View voters</button><button class="btn btn-danger btn-sm" onclick="window.adminDeleteContest('${c.id}')">Delete contest</button></div></div>`;
}
function openEventForm(id){ const e=id?contestAdmin.events.find(x=>x.id===id):null; $('admin-event-form-title').textContent=e?'Edit Event':'Create Event'; $('admin-event-id').value=e?.id||''; $('admin-event-title').value=e?.title||''; $('admin-event-description').value=e?.description||''; $('admin-event-starts').value=toInputDate(e?.starts_at); $('admin-event-ends').value=toInputDate(e?.ends_at); $('admin-event-form-modal').classList.add('active'); }
function closeEventForm(){ $('admin-event-form-modal')?.classList.remove('active'); }
async function deleteEvent(id){
    const eventRow=contestAdmin.events.find(e=>e.id===id);
    if(!eventRow) return;
    if(!await mod.ask({ title:'delete event',
        blurb:`Delete <strong>${escapeHtml(eventRow.title)}</strong> and every contest inside it, along with their submissions and votes.`,
        confirm:'delete event', requireReason:false, danger:true })) return;
    const client=await getClient();
    const child=contestAdmin.contests.filter(c=>c.event_id===id);
    for(const c of child){
        const {error:v}=await client.from('contest_votes').delete().eq('contest_id',c.id);
        if(v){ showToast(v.message,'error'); return; }
        const {error:s}=await client.from('contest_submissions').delete().eq('contest_id',c.id);
        if(s){ showToast(s.message,'error'); return; }
        const {error:cErr}=await client.from('contests').delete().eq('id',c.id);
        if(cErr){ showToast(cErr.message,'error'); return; }
    }
    const {error}=await client.from('contest_events').delete().eq('id',id);
    if(error){ showToast(error.message,'error'); return; }
    showToast('Event deleted','success');
    await loadContestAdmin();
}

async function deleteContest(id){
    const contestRow=contestAdmin.contests.find(c=>c.id===id);
    if(!contestRow) return;
    if(!await mod.ask({ title:'delete contest',
        blurb:`Delete <strong>${escapeHtml(contestRow.title)}</strong> and every submission and vote in it.`,
        confirm:'delete contest', requireReason:false, danger:true })) return;
    const client=await getClient();
    let r=await client.from('contest_votes').delete().eq('contest_id',id);
    if(r.error){ showToast(r.error.message,'error'); return; }
    r=await client.from('contest_submissions').delete().eq('contest_id',id);
    if(r.error){ showToast(r.error.message,'error'); return; }
    r=await client.from('contests').delete().eq('id',id);
    if(r.error){ showToast(r.error.message,'error'); return; }
    showToast('Contest deleted','success');
    await loadContestAdmin();
}

async function submitEventForm(ev){ ev.preventDefault(); const client=await getClient(); const id=$('admin-event-id').value; const payload={title:$('admin-event-title').value.trim(),description:$('admin-event-description').value.trim(),starts_at:fromInputDate('admin-event-starts'),ends_at:fromInputDate('admin-event-ends'),created_by:state.me.id}; const {error}=id?await client.from('contest_events').update(payload).eq('id',id):await client.from('contest_events').insert(payload); if(error)return showToast(error.message,'error'); closeEventForm(); await loadContestAdmin(); showToast('Event saved','success'); }
function wcField(idBase, value){
    const enabled = value !== null && value !== undefined;
    $(`admin-contest-wc-${idBase}-enabled`).checked = enabled;
    $(`admin-contest-wc-${idBase}`).value = enabled ? value : '';
    $(`admin-contest-wc-${idBase}`).disabled = !enabled;
}
function toggleWcField(idBase){
    const enabled = $(`admin-contest-wc-${idBase}-enabled`).checked;
    const input = $(`admin-contest-wc-${idBase}`);
    input.disabled = !enabled;
    if (enabled && !input.value) input.focus();
}
function openContestForm(id,eventId){ const c=id?contestAdmin.contests.find(x=>x.id===id):null; $('admin-contest-form-title').textContent=c?'Edit Contest':'Create Contest'; $('admin-contest-id').value=c?.id||''; $('admin-contest-event-id').innerHTML=contestAdmin.events.map(e=>`<option value="${e.id}">${escapeHtml(e.title)}</option>`).join(''); $('admin-contest-event-id').value=c?.event_id||eventId||''; $('admin-contest-title').value=c?.title||''; $('admin-contest-description').value=c?.description||''; $('admin-contest-rules').value=c?.rules||''; $('admin-contest-submission-deadline').value=toInputDate(c?.submission_deadline); $('admin-contest-voting-start').value=toInputDate(c?.voting_start); $('admin-contest-voting-deadline').value=toInputDate(c?.voting_deadline); $('admin-contest-results-at').value=toInputDate(c?.results_at); $('admin-contest-phase').value=c?.phase||'draft'; $('admin-contest-max-subs').value=c?.max_submissions_per_user||1; const wc=c?.winner_criteria||{top_n:3}; wcField('topn',wc.top_n??null); wcField('toppct',wc.top_percent??null); wcField('minscore',wc.min_score_percent??null); $('admin-contest-form-modal').classList.add('active'); }
function closeContestForm(){ $('admin-contest-form-modal')?.classList.remove('active'); }
async function submitContestForm(ev){
    ev.preventDefault();
    const client=await getClient();
    const id=$('admin-contest-id').value;
    const winner_criteria={};
    if($('admin-contest-wc-topn-enabled').checked && $('admin-contest-wc-topn').value) winner_criteria.top_n=parseInt($('admin-contest-wc-topn').value,10);
    if($('admin-contest-wc-toppct-enabled').checked && $('admin-contest-wc-toppct').value) winner_criteria.top_percent=parseInt($('admin-contest-wc-toppct').value,10);
    if($('admin-contest-wc-minscore-enabled').checked && $('admin-contest-wc-minscore').value) winner_criteria.min_score_percent=parseInt($('admin-contest-wc-minscore').value,10);
    if(!Object.keys(winner_criteria).length) winner_criteria.top_n=3;
    const maxSubs=Math.max(1,parseInt($('admin-contest-max-subs').value,10)||1);
    const payload={event_id:$('admin-contest-event-id').value,title:$('admin-contest-title').value.trim(),description:$('admin-contest-description').value.trim(),rules:$('admin-contest-rules').value.trim(),created_by:state.me.id,submission_deadline:fromInputDate('admin-contest-submission-deadline'),voting_start:fromInputDate('admin-contest-voting-start'),voting_deadline:fromInputDate('admin-contest-voting-deadline'),results_at:fromInputDate('admin-contest-results-at'),phase:$('admin-contest-phase').value,max_submissions_per_user:maxSubs,winner_criteria};
    const {error}=id?await client.from('contests').update(payload).eq('id',id):await client.from('contests').insert(payload);
    if(error)return showToast(error.message,'error');
    closeContestForm(); await loadContestAdmin(); showToast('Contest saved','success');
}
async function forcePhase(){
    const id=$('admin-contest-id').value;
    if(!id) return showToast('Save the contest once first, then you can force its phase.','warning');
    const phase=$('admin-contest-phase').value;
    if(!await mod.ask({ title:'force phase',
        blurb:`Move this contest straight to <strong>${escapeHtml(phase)}</strong>, overriding normal automatic progression. Takes effect immediately.`,
        confirm:'force phase', requireReason:false })) return;
    const client=await getClient();
    const {error}=await client.from('contests').update({phase}).eq('id',id);
    if(error) return showToast(error.message,'error');
    showToast(`Phase forced to ${phase}`,'success');
    await loadContestAdmin();
}
let adminVotersState = { contestId:null, contestTitle:'', voters:[] };
async function viewContestVotes(contestId){
    const contest = contestAdmin.contests.find(c=>c.id===contestId);
    const modal=$('admin-voters-modal'); if(!modal)return;
    adminVotersState={contestId,contestTitle:contest?.title||'Contest',voters:[]};
    $('admin-voters-modal-title').textContent=`Voters - ${contest?.title||'Contest'}`;
    $('admin-voters-summary').textContent='Loading…'; $('admin-voters-modal-list').innerHTML='<div class="admin-empty">Loading voter responses…</div>';
    modal.classList.add('active');
    try{
        const client=await getClient();
        const {data:sessions,error:se}=await client.from('contest_vote_sessions').select('id,voter_id,submitted_at').eq('contest_id',contestId).order('submitted_at',{ascending:false});
        if(se)throw se;
        const ids=(sessions||[]).map(x=>x.voter_id);
        const {data:profiles,error:pe}=ids.length?await client.from('profiles').select('id,username,display_name').in('id',ids):{data:[],error:null};
        if(pe)throw pe;
        const pm=Object.fromEntries((profiles||[]).map(p=>[p.id,p]));
        const {data:votes,error:ve}=ids.length?await client.from('contest_votes').select('id,voter_id,submission_id,competitive_score,design_score,remarks,created_at').eq('contest_id',contestId).order('created_at',{ascending:true}):{data:[],error:null};
        if(ve)throw ve;
        const vm={}; (votes||[]).forEach(v=>(vm[v.voter_id]??=[]).push(v));
        adminVotersState.voters=(sessions||[]).map(s=>({voter_id:s.voter_id,submitted_at:s.submitted_at,profile:pm[s.voter_id]||null,responses:vm[s.voter_id]||[]}));
        $('admin-voters-summary').textContent=`${adminVotersState.voters.length} completed voter${adminVotersState.voters.length===1?'':'s'}`;
        $('admin-voters-modal-list').innerHTML=adminVotersState.voters.length?adminVotersState.voters.map((v,i)=>`<button type="button" class="admin-voter-card" onclick="window.adminOpenVoterResponse(${i})"><span class="admin-voter-avatar">${escapeHtml((v.profile?.display_name||v.profile?.username||'?').slice(0,1).toUpperCase())}</span><span><strong>${escapeHtml(v.profile?.display_name||v.profile?.username||v.voter_id)}</strong><small>@${escapeHtml(v.profile?.username||'unknown')} · submitted ${fmtDate(v.submitted_at)}</small></span><i data-lucide="chevron-right"></i></button>`).join(''):'<div class="admin-empty">No completed ballots yet.</div>';
        if(typeof lucide!=='undefined')lucide.createIcons();
    }catch(e){$('admin-voters-summary').textContent='Could not load voters';$('admin-voters-modal-list').innerHTML=`<div class="admin-empty">${escapeHtml(e.message||e)}</div>`;}
}
function closeVotersModal(){ $('admin-voters-modal')?.classList.remove('active'); }
function openVoterResponse(index){
    const v=adminVotersState.voters[index]; if(!v)return;
    const list=$('admin-voters-modal-list');
    const name=v.profile?.display_name||v.profile?.username||v.voter_id;
    list.innerHTML=`<div class="admin-voter-detail-head"><button class="btn btn-secondary btn-sm" onclick="window.adminRenderVoterList()"><i data-lucide="arrow-left"></i> Back</button><div><strong>${escapeHtml(name)}</strong><small>@${escapeHtml(v.profile?.username||'unknown')} · ${fmtDate(v.submitted_at)}</small></div></div><div class="admin-response-list">${v.responses.map((r,i)=>`<div class="admin-response-row"><div><strong>Response ${i+1}</strong><small>${escapeHtml(r.submission_id)}</small></div><div class="admin-response-scores"><span>Competitive <b>${r.competitive_score}/10</b></span><span>Design <b>${r.design_score}/10</b></span></div><p>${escapeHtml(r.remarks||'No remarks')}</p></div>`).join('')}</div>`;
    if(typeof lucide!=='undefined')lucide.createIcons();
}
function renderVoterList(){
    const list=$('admin-voters-modal-list');
    list.innerHTML=adminVotersState.voters.map((v,i)=>`<button type="button" class="admin-voter-card" onclick="window.adminOpenVoterResponse(${i})"><span class="admin-voter-avatar">${escapeHtml((v.profile?.display_name||v.profile?.username||'?').slice(0,1).toUpperCase())}</span><span><strong>${escapeHtml(v.profile?.display_name||v.profile?.username||v.voter_id)}</strong><small>@${escapeHtml(v.profile?.username||'unknown')} · submitted ${fmtDate(v.submitted_at)}</small></span><i data-lucide="chevron-right"></i></button>`).join('')||'<div class="admin-empty">No completed ballots yet.</div>';
    if(typeof lucide!=='undefined')lucide.createIcons();
}
let adminSubmissionsState = { contestId:null, contestTitle:'', submissions:[] };
const submissionImage = d => d?.artwork || d?.image || d?.sprite || '';
async function viewContestSubmissions(contestId){
    const contest = contestAdmin.contests.find(c=>c.id===contestId);
    const modal=$('admin-submissions-modal'); if(!modal)return;
    adminSubmissionsState={contestId,contestTitle:contest?.title||'Contest',submissions:[]};
    $('admin-submissions-modal-title').textContent=`Submissions - ${contest?.title||'Contest'}`;
    $('admin-submissions-summary').textContent='Loading…';
    $('admin-submissions-modal-list').innerHTML='<div class="admin-empty">Loading submissions…</div>';
    modal.classList.add('active');
    try{
        const client=await getClient();
        const {data:subs,error:se}=await client.from('contest_submissions').select('id,user_id,fakemon_data,submitted_at').eq('contest_id',contestId).order('submitted_at',{ascending:false});
        if(se)throw se;
        const ids=[...new Set((subs||[]).map(s=>s.user_id))];
        const {data:profiles,error:pe}=ids.length?await client.from('profiles').select('id,username,display_name').in('id',ids):{data:[],error:null};
        if(pe)throw pe;
        const pm=Object.fromEntries((profiles||[]).map(p=>[p.id,p]));
        adminSubmissionsState.submissions=(subs||[]).map(s=>({...s,profile:pm[s.user_id]||null}));
        $('admin-submissions-summary').textContent=`${adminSubmissionsState.submissions.length} submission${adminSubmissionsState.submissions.length===1?'':'s'}`;
        renderSubmissionsList();
    }catch(e){$('admin-submissions-summary').textContent='Could not load submissions';$('admin-submissions-modal-list').innerHTML=`<div class="admin-empty">${escapeHtml(e.message||e)}</div>`;}
}
function renderSubmissionsList(){
    const list=$('admin-submissions-modal-list'); if(!list)return;
    list.innerHTML=adminSubmissionsState.submissions.length?adminSubmissionsState.submissions.map(s=>{
        const d=s.fakemon_data||{}; const img=submissionImage(d);
        const name=s.profile?.display_name||s.profile?.username||s.user_id;
        return `<div class="admin-submission-row">
          <div class="admin-submission-thumb">${img?`<img src="${escapeHtml(img)}" alt="">`:'<i data-lucide="image"></i>'}</div>
          <div class="admin-submission-info"><strong>${escapeHtml(d.name||'Unnamed Fakemon')}</strong><small>by ${escapeHtml(name)}${s.profile?.username?` (@${escapeHtml(s.profile.username)})`:''} · ${fmtDate(s.submitted_at)}</small></div>
          <button class="btn btn-danger btn-sm" type="button" onclick="window.adminDeleteSubmission('${s.id}')"><i data-lucide="trash-2"></i></button>
        </div>`;
    }).join('') : '<div class="admin-empty">No submissions yet.</div>';
    if(typeof lucide!=='undefined')lucide.createIcons();
}
async function deleteSubmission(id){
    const answer = await mod.ask({ title:'remove submission',
        blurb:'Removes this entry from the contest, along with any votes cast on it. The entrant is notified with your reason.',
        confirm:'remove entry' });
    if(!answer) return;
    const client=await getClient();
    const {error}=await client.rpc('admin_delete_contest_submission',{p_submission_id:id,p_reason:answer.reason});
    if(error){ showToast(error.message,'error'); return; }
    adminSubmissionsState.submissions=adminSubmissionsState.submissions.filter(s=>s.id!==id);
    $('admin-submissions-summary').textContent=`${adminSubmissionsState.submissions.length} submission${adminSubmissionsState.submissions.length===1?'':'s'}`;
    renderSubmissionsList();
    showToast('Submission removed','success');
}
function closeSubmissionsModal(){ $('admin-submissions-modal')?.classList.remove('active'); }

function exportVotersJson(){
    const payload={contest_id:adminVotersState.contestId,contest_title:adminVotersState.contestTitle,exported_at:new Date().toISOString(),voters:adminVotersState.voters.map(v=>({voter_id:v.voter_id,username:v.profile?.username||null,display_name:v.profile?.display_name||null,submitted_at:v.submitted_at,responses:v.responses.map(r=>({submission_id:r.submission_id,competitive_score:r.competitive_score,design_score:r.design_score,remarks:r.remarks||'',created_at:r.created_at}))}))};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`contest-${adminVotersState.contestId}-voters.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
import { esc as escapeHtml, publicName } from '../core/html.js';

// Exposed for inline onclick/onchange handlers (matches the rest of the site's pattern).
window.adminBadgeCheckboxChanged = badgeCheckboxChanged;
window.adminSaveBadges = saveBadges;
window.adminToggleMonsList = toggleMonsList;
window.adminDeleteMon = deleteMon;
window.adminRunSearch = runSearch;
window.adminEditBadge = (key) => openBadgeForm(key);
window.adminAddBadge = () => openBadgeForm(null);
window.adminCloseBadgeForm = closeBadgeForm;
window.adminSubmitBadgeForm = submitBadgeForm;
window.adminSubmitLimits = submitLimits;
window.adminDeleteBadge = deleteBadge;
window.adminPreviewBadgeIcon = previewBadgeIcon;
window.adminSignOut = signOut;
window.adminAddEvent = () => openEventForm(null);
window.adminEditEvent = openEventForm;
window.adminCloseEventForm = closeEventForm;
window.adminSubmitEventForm = submitEventForm;
window.adminAddContest = (eventId) => openContestForm(null,eventId);
window.adminEditContest = (id) => openContestForm(id);
window.adminCloseContestForm = closeContestForm;
window.adminSubmitContestForm = submitContestForm;
window.adminViewContestVotes = viewContestVotes;
window.adminCloseVotersModal = closeVotersModal;
window.adminOpenVoterResponse = openVoterResponse;
window.adminRenderVoterList = renderVoterList;
window.adminExportVotersJson = exportVotersJson;
window.adminDeleteEvent = deleteEvent;
window.adminDeleteContest = deleteContest;
window.adminToggleWcField = toggleWcField;
window.adminForcePhase = forcePhase;
window.adminToggleDarkMode = toggleDarkMode;
window.adminViewContestSubmissions = viewContestSubmissions;
window.adminCloseSubmissionsModal = closeSubmissionsModal;
window.adminDeleteSubmission = deleteSubmission;

$('admin-signin-form').addEventListener('submit', handleSignInSubmit);
init();