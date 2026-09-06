// ==================== Staff Panel: Moderation ====================
// Warnings, mutes, suspensions, deletion, bulk purges, comment stream, sign-in
// history, filter blocklist, and the mod log.
//
// Split from admin.js (which stays badges/roles/contests); gets admin.js's
// toast/state/search via install() to avoid a circular import.
//
// No window.prompt()/confirm() - browsers can suppress those and return null
// silently, which looked like "the delete button does nothing". Real in-page
// modal instead.
//
// Nothing here is the real gate: every button calls a SECURITY DEFINER RPC
// that re-checks permission and rank server-side. Hiding a button is just UX.

import { getClient } from '../core/supabase.js';
import { mountIsland, unmountIsland } from '../react/island.jsx';
import {
    StandingPills, ModerationBar, CommentRows, LogRows, SessionsPanel, TermRows,
    IpNeighbours, PatternPreview, FilterTestResult
} from '../react/Moderation.jsx';

let ctx = null;
const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = () => { if (typeof lucide !== 'undefined') lucide.createIcons(); };
const toast = (m, k) => ctx?.showToast?.(m, k);
const can = (perm) => !!ctx?.state?.me?.perms?.[perm];

// The server stores "until a moderator lifts it" as a sentinel far-future date
// rather than a null, so is_muted()/is_banned() stay one comparison.
const isForever = (iso) => !!iso && new Date(iso).getFullYear() >= 9999;
const active = (iso) => !!iso && new Date(iso).getTime() > Date.now();

function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ==================== tabs ====================
let currentTab = 'users';
const lazyTabs = { comments: () => loadRecentComments(), filter: () => loadTerms(), history: () => loadModLog() };
const loadedTabs = new Set();

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('#admin-tabs .admin-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.querySelectorAll('[data-tab-panel]').forEach(p => {
        p.style.display = p.dataset.tabPanel === tab ? 'block' : 'none';
    });
    if (lazyTabs[tab] && !loadedTabs.has(tab)) { loadedTabs.add(tab); lazyTabs[tab](); }
    icons();
}

// Hide the tabs this staff member has no permission for, so nobody is offered
// a view that would just error.
function applyTabPermissions() {
    const gate = { filter: 'manage_filter', history: 'view_log', badges: 'manage_badges',
                   events: 'manage_events', limits: 'manage_limits' };
    let firstVisible = 'users';
    document.querySelectorAll('#admin-tabs .admin-tab').forEach(btn => {
        const need = gate[btn.dataset.tab];
        const ok = !need || can(need);
        btn.style.display = ok ? 'inline-flex' : 'none';
    });
    // 'filter' also opens for anyone who can read the rules, for the tester
    const filterTab = $('admin-tab-filter');
    if (filterTab && !can('manage_filter')) filterTab.style.display = 'inline-flex';
    const addTerm = $('admin-add-term-btn');
    if (addTerm) addTerm.style.display = can('manage_filter') ? 'inline-flex' : 'none';
    switchTab(firstVisible);
}

// ==================== the reason / confirm modal ====================
// One promise-based modal stands in for prompt() and confirm() everywhere.
let pendingAsk = null;   // { resolve }

/**
 * @returns {Promise<{reason:string, amount:number|null}|null>} null when cancelled
 */
function ask({ title, blurb, confirm = 'confirm', durations = null, danger = false, requireReason = true }) {
    $('admin-mod-action-title').textContent = title;
    $('admin-mod-action-blurb').innerHTML = blurb;
    $('admin-mod-action-confirm').textContent = confirm;
    $('admin-mod-reason').value = '';
    $('admin-mod-danger').style.display = danger ? 'flex' : 'none';

    const group = $('admin-mod-duration-group');
    if (durations) {
        group.style.display = 'block';
        $('admin-mod-duration').innerHTML = durations
            .map(([v, label]) => `<option value="${v}">${esc(label)}</option>`).join('');
    } else {
        group.style.display = 'none';
    }
    $('admin-mod-action-modal').classList.add('active');
    $('admin-mod-reason').focus();
    icons();

    return new Promise(resolve => {
        pendingAsk = { resolve, durations, requireReason };
    });
}

function closeModAction() {
    $('admin-mod-action-modal')?.classList.remove('active');
    if (pendingAsk) { pendingAsk.resolve(null); pendingAsk = null; }
}

function submitModAction(event) {
    event.preventDefault();
    if (!pendingAsk) return;
    const reason = $('admin-mod-reason').value.trim();
    if (pendingAsk.requireReason && !reason) {
        toast('Give a reason - the user sees it, and it goes in the log.', 'error');
        return;
    }
    const amount = pendingAsk.durations ? parseInt($('admin-mod-duration').value, 10) : null;
    const { resolve } = pendingAsk;
    pendingAsk = null;
    $('admin-mod-action-modal')?.classList.remove('active');
    resolve({ reason, amount });
}

// ==================== per-user standing + actions ====================
// admin.js still gets markup back for each row, but now it's an empty React
// island container; the data is stashed until the row is actually in the
// document, since a React root can't be created against a missing element.
//
// admin.js calls mountUserRowIslands() once, after it assigns the list.
const pendingUserRows = new Map();   // user id -> { user, locked }

function stashUserRow(user, patch) {
    pendingUserRows.set(user.id, { user, ...(pendingUserRows.get(user.id) || {}), ...patch });
}

function standingPills(user) {
    stashUserRow(user, {});
    // display:contents keeps the pills as direct flex items of .admin-user-head,
    // so the row's gap falls between pills instead of around the whole group.
    return `<span id="admin-standing-${user.id}" style="display:contents"></span>`;
}

// `locked` means the rank rule would refuse this target no matter the
// permission, so those buttons are disabled rather than offered and rejected.
function moderationBar(user, locked) {
    stashUserRow(user, { locked: !!locked });
    return `<div id="admin-mod-bar-${user.id}"></div><div class="admin-drawer" id="admin-drawer-${user.id}"></div>`;
}

/** Fills in every user row's islands. Safe to call when there are none. */
function mountUserRowIslands() {
    const perms = ctx?.state?.me?.perms || {};
    for (const [id, { user, locked }] of pendingUserRows) {
        mountIsland(`admin-standing-${id}`, StandingPills, { user });
        mountIsland(`admin-mod-bar-${id}`, ModerationBar, { user, perms, locked: !!locked });
    }
    pendingUserRows.clear();
}

// ---------- drawers ----------
// One slot per user, so opening History replaces Comments rather than stacking
// two long lists. Each drawer renders loading, then data or error.
async function openDrawer(userId, kind, load, Component, props = {}) {
    const el = $('admin-drawer-' + userId);
    if (!el) return;

    // Same button again closes the drawer; unmount first so the root isn't
    // stranded on an emptied element.
    if (el.dataset.kind === kind && el.innerHTML.trim()) {
        unmountIsland(el);
        el.innerHTML = '';
        el.dataset.kind = '';
        return;
    }

    el.dataset.kind = kind;
    mountIsland(el, Component, { ...props, loading: true });
    try {
        mountIsland(el, Component, { ...props, ...(await load()) });
    } catch (e) {
        mountIsland(el, Component, { ...props, error: e.message || 'Could not load that.' });
    }
}

async function toggleUserComments(btn, userId) {
    await openDrawer(userId, 'comments', async () => {
        const client = await getClient();
        const { data, error } = await client.rpc('admin_user_comments', { p_user_id: userId, p_limit: 200 });
        if (error) throw error;
        return { comments: data || [] };
    }, CommentRows, {
        canDelete: can('delete_content'),
        empty: 'this account has not commented anywhere'
    });
}

async function toggleUserHistory(btn, userId) {
    await openDrawer(userId, 'history', async () => {
        const client = await getClient();
        const { data, error } = await client.rpc('admin_moderation_log', { p_user_id: userId, p_action: '', p_limit: 100, p_offset: 0 });
        if (error) throw error;
        return { entries: data || [] };
    }, LogRows, { empty: 'nothing on record for this account' });
}

// ---------- sessions / addresses ----------
async function loadSessions(userId) {
    const client = await getClient();
    const { data, error } = await client.rpc('admin_user_auth_events', { p_user_id: userId, p_limit: 100 });
    if (error) throw error;
    return { rows: data || [], userId };
}

async function toggleUserSessions(btn, userId) {
    await openDrawer(userId, 'sessions', () => loadSessions(userId), SessionsPanel, { userId });
}

// Geolocation is on demand only - an address leaves the project only when
// staff is actually investigating that account.
async function resolveLocations(userId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'resolving'; }
    try {
        const client = await getClient();
        const { data, error } = await client.functions.invoke('admin-ip-lookup', { body: { user_id: userId } });
        if (error) throw error;
        toast(`Resolved ${data?.resolved ?? 0} address${data?.resolved === 1 ? '' : 'es'}`, 'success');
        const el = $('admin-drawer-' + userId);
        if (el) mountIsland(el, SessionsPanel, { userId, ...(await loadSessions(userId)) });
    } catch (e) {
        toast(e.message || 'Location lookup failed.', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'resolve locations'; }
    }
}

async function showIpNeighbours(ip) {
    if (!ip || ip === 'unknown') return;
    $('admin-ip-modal-title').textContent = ip;
    const list = $('admin-ip-modal-list');
    if (!list) return;
    mountIsland(list, IpNeighbours, { loading: true });
    $('admin-ip-modal').classList.add('active');
    try {
        const client = await getClient();
        const { data, error } = await client.rpc('admin_ip_neighbours', { p_ip: ip });
        if (error) throw error;
        mountIsland(list, IpNeighbours, { rows: data || [] });
    } catch (e) {
        mountIsland(list, IpNeighbours, { error: e.message });
    }
}
const closeIpModal = () => $('admin-ip-modal')?.classList.remove('active');

// ==================== moderation actions ====================
const ACTIONS = {
    warn: {
        title: 'issue a warning', confirm: 'send warning', durations: null,
        blurb: 'The user gets a notification with your reason. Warnings count toward the automatic escalation ladder, so a second offence lands a mute.',
        rpc: (id, reason) => ['admin_warn_user', { p_user_id: id, p_reason: reason }]
    },
    mute: {
        title: 'mute this account', confirm: 'apply mute',
        durations: [[60, '1 hour'], [360, '6 hours'], [1440, '24 hours'], [10080, '7 days'], [43200, '30 days'], [0, 'until lifted']],
        blurb: 'A muted account can still sign in and browse, but cannot comment, publish or update a listing.',
        rpc: (id, reason, mins) => ['admin_mute_user', { p_user_id: id, p_minutes: mins, p_reason: reason }]
    },
    unmute: {
        title: 'lift this mute', confirm: 'unmute', durations: null, requireReason: false,
        blurb: 'The account can post again immediately. The original mute stays in the log.',
        rpc: (id, reason) => ['admin_unmute_user', { p_user_id: id, p_reason: reason }]
    },
    ban: {
        title: 'suspend this account', confirm: 'suspend',
        durations: [[1, '1 day'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'permanent']],
        blurb: 'A suspension is enforced at the auth layer as well as in the app, so the account cannot get a session at all until it expires.',
        rpc: (id, reason, days) => ['admin_ban_user', { p_user_id: id, p_days: days, p_reason: reason }]
    },
    unban: {
        title: 'lift this suspension', confirm: 'lift suspension', durations: null, requireReason: false,
        blurb: 'The account can sign in again immediately.',
        rpc: (id, reason) => ['admin_unban_user', { p_user_id: id, p_reason: reason }]
    },
    delete_user: {
        title: 'delete this account', confirm: 'delete permanently', durations: null, danger: true,
        blurb: 'Use a suspension unless the account has to be gone entirely.',
        rpc: (id, reason) => ['admin_delete_user', { p_user_id: id, p_reason: reason }]
    }
};

async function modAction(kind, userId) {
    const spec = ACTIONS[kind];
    if (!spec) return;
    const user = ctx.state.results.find(u => u.id === userId);
    const who = user ? `<strong>${esc(user.display_name || user.username || 'this account')}</strong>: ` : '';

    const answer = await ask({
        title: spec.title,
        blurb: who + esc(spec.blurb),
        confirm: spec.confirm,
        durations: spec.durations,
        danger: spec.danger,
        requireReason: spec.requireReason !== false
    });
    if (!answer) return;

    try {
        const client = await getClient();
        const [fn, args] = spec.rpc(userId, answer.reason, answer.amount);
        const { error } = await client.rpc(fn, args);
        if (error) throw error;
        toast(`${spec.title}: done`, 'success');
        // standing pills and available buttons both change - re-run the search
        // rather than patching the row by hand.
        await ctx.runSearch();
        if (loadedTabs.has('history')) loadModLog();
    } catch (e) {
        toast(e.message || 'That action failed.', 'error');
    }
}

// ==================== purge ====================
let purgeTarget = null;

function openPurge(userId) {
    const user = ctx.state.results.find(u => u.id === userId);
    purgeTarget = userId;
    $('admin-purge-blurb').innerHTML =
        `Bulk-remove content posted by <strong>${esc(user?.display_name || user?.username || 'this account')}</strong>. ` +
        `The author gets one notification with your reason, and the purge is recorded in the mod log with the exact count.`;
    $('admin-purge-reason').value = '';
    $('admin-purge-what').value = 'all';
    $('admin-purge-window').value = '24';
    $('admin-purge-count').innerHTML = '&nbsp;';
    $('admin-purge-modal').classList.add('active');
    previewPurge();
    icons();
}
const closePurge = () => { $('admin-purge-modal')?.classList.remove('active'); purgeTarget = null; };

// Shows the exact number of rows the current selection would delete, so nobody
// confirms a purge blind.
const previewPurge = debounce(async () => {
    if (!purgeTarget) return;
    const what = $('admin-purge-what').value;
    const hours = parseInt($('admin-purge-window').value, 10);
    const out = $('admin-purge-count');
    out.innerHTML = 'counting&hellip;';
    try {
        const client = await getClient();
        if (what === 'mons') {
            // no dedicated count RPC for mons; the list RPC is cheap enough
            const { data, error } = await client.rpc('admin_user_mons', { p_user_id: purgeTarget });
            if (error) throw error;
            const cutoff = hours > 0 ? Date.now() - hours * 3600_000 : -Infinity;
            const n = (data || []).filter(m => new Date(m.published_at).getTime() >= cutoff).length;
            out.innerHTML = `This will delete <strong>${n}</strong> published Fakemon.`;
        } else {
            const { data, error } = await client.rpc('admin_count_user_comments', {
                p_user_id: purgeTarget, p_hours: hours, p_kind: what
            });
            if (error) throw error;
            out.innerHTML = `This will delete <strong>${data ?? 0}</strong> comment${data === 1 ? '' : 's'}.`;
        }
    } catch (e) {
        out.innerHTML = `<span class="admin-error">${esc(e.message)}</span>`;
    }
}, 200);

async function submitPurge(event) {
    event.preventDefault();
    if (!purgeTarget) return;
    const what = $('admin-purge-what').value;
    const hours = parseInt($('admin-purge-window').value, 10);
    const reason = $('admin-purge-reason').value.trim();
    if (!reason) { toast('Give a reason - the user sees it, and it goes in the log.', 'error'); return; }

    const btn = $('admin-purge-confirm');
    btn.disabled = true;
    try {
        const client = await getClient();
        const [fn, args] = what === 'mons'
            ? ['admin_purge_user_mons', { p_user_id: purgeTarget, p_hours: hours, p_reason: reason }]
            : ['admin_purge_user_comments', { p_user_id: purgeTarget, p_hours: hours, p_kind: what, p_reason: reason }];
        const { data, error } = await client.rpc(fn, args);
        if (error) throw error;
        toast(`Purged ${data ?? 0} item${data === 1 ? '' : 's'}`, 'success');
        closePurge();
        await ctx.runSearch();
        if (loadedTabs.has('history')) loadModLog();
        if (loadedTabs.has('comments')) loadRecentComments();
    } catch (e) {
        toast(e.message || 'Purge failed.', 'error');
    } finally {
        btn.disabled = false;
    }
}

// ==================== comments ====================
async function deleteComment(commentId, kind) {
    const answer = await ask({
        title: 'delete comment',
        blurb: 'The author is notified with your reason, and the deletion is recorded in the mod log.',
        confirm: 'delete'
    });
    if (!answer) return;
    try {
        const client = await getClient();
        const { error } = await client.rpc('admin_delete_comment', {
            p_comment_id: commentId, p_kind: kind, p_reason: answer.reason
        });
        if (error) throw error;
        // Row is React's now - remove it by re-rendering without it, not by
        // touching the DOM node directly.
        refreshCommentViews();
        toast('Comment deleted', 'success');
        if (loadedTabs.has('history')) loadModLog();
    } catch (e) {
        toast(e.message || 'Could not delete that comment.', 'error');
    }
}

async function loadRecentComments() {
    const list = $('admin-comments-list');
    if (!list) return;
    const props = { showAuthor: true, canDelete: can('delete_content'), empty: 'no comments match that' };
    mountIsland(list, CommentRows, { ...props, loading: true });
    try {
        const client = await getClient();
        const { data, error } = await client.rpc('admin_recent_comments', {
            p_limit: 150, p_search: ($('admin-comment-search')?.value || '').trim()
        });
        if (error) throw error;
        mountIsland(list, CommentRows, { ...props, comments: data || [] });
    } catch (e) {
        mountIsland(list, CommentRows, { ...props, error: e.message });
    }
}

// Re-renders whichever comment lists are on screen after a deletion.
function refreshCommentViews() {
    if (loadedTabs.has('comments')) loadRecentComments();
    document.querySelectorAll('.admin-drawer[data-kind="comments"]').forEach(el => {
        const userId = el.id.replace('admin-drawer-', '');
        el.dataset.kind = '';        // so the call below reloads rather than closes
        toggleUserComments(null, userId);
    });
}

// ==================== the moderation log ====================
// Log row is a React component (js/react/Moderation.jsx); icon/verb vocabulary
// lives in js/features/moderation-model.js.
const LOG_PAGE = 60;
let logOffset = 0;
let logEntries = [];

async function loadModLog(append = false) {
    const list = $('admin-log-list');
    if (!list) return;
    logOffset = append ? logOffset + LOG_PAGE : 0;
    if (!append) {
        logEntries = [];
        mountIsland(list, LogRows, { loading: true });
    }
    try {
        const client = await getClient();
        const { data, error } = await client.rpc('admin_moderation_log', {
            p_user_id: null, p_action: $('admin-log-filter')?.value || '',
            p_limit: LOG_PAGE, p_offset: logOffset
        });
        if (error) throw error;
        // Accumulate pages in one array so React appends the new page, instead
        // of the old insertAdjacentHTML that built markup nothing owned.
        logEntries = append ? logEntries.concat(data || []) : (data || []);
        mountIsland(list, LogRows, { entries: logEntries, empty: 'nothing logged yet' });
        const more = $('admin-log-more-btn');
        if (more) more.style.display = (data?.length === LOG_PAGE) ? 'inline-flex' : 'none';
    } catch (e) {
        mountIsland(list, LogRows, { entries: logEntries, error: e.message });
    }
}
const loadMoreModLog = () => loadModLog(true);

// ==================== content filter ====================
let terms = [];

async function loadTerms() {
    const list = $('admin-terms-list');
    if (!list) return;
    mountIsland(list, TermRows, { loading: true });
    try {
        const client = await getClient();
        const { data, error } = await client.from('banned_terms').select('*')
            .order('severity', { ascending: true }).order('label', { ascending: true });
        if (error) throw error;
        terms = data || [];
        renderTerms();
    } catch (e) {
        mountIsland(list, TermRows, { error: e.message });
    }
}

function renderTerms() {
    const list = $('admin-terms-list');
    if (!list) return;
    mountIsland(list, TermRows, { terms, canEdit: can('manage_filter') });
}

function openTermForm(id) {
    const t = id ? terms.find(x => x.id === id) : null;
    $('admin-term-form-title').textContent = t ? 'edit filter rule' : 'new filter rule';
    $('admin-term-id').value = t?.id || '';
    $('admin-term-label').value = t?.label || '';
    $('admin-term-pattern').value = t?.pattern || '';
    $('admin-term-severity').value = t?.severity || 'severe';
    $('admin-term-action').value = t?.action || 'block';
    $('admin-term-notes').value = t?.notes || '';
    $('admin-term-enabled').checked = t ? !!t.enabled : true;
    $('admin-term-preview-input').value = '';
    mountIsland('admin-term-preview-result', PatternPreview, {});
    $('admin-term-delete-btn').style.display = t ? 'inline-flex' : 'none';
    $('admin-term-form-modal').classList.add('active');
    icons();
}
const closeTermForm = () => $('admin-term-form-modal')?.classList.remove('active');

async function submitTermForm(event) {
    event.preventDefault();
    const id = $('admin-term-id').value || null;
    try {
        const client = await getClient();
        const { error } = await client.rpc('admin_upsert_banned_term', {
            p_id: id,
            p_pattern: $('admin-term-pattern').value.trim(),
            p_label: $('admin-term-label').value.trim(),
            p_severity: $('admin-term-severity').value,
            p_action: $('admin-term-action').value,
            p_enabled: $('admin-term-enabled').checked,
            p_notes: $('admin-term-notes').value.trim()
        });
        if (error) throw error;
        closeTermForm();
        await loadTerms();
        toast('Filter rule saved', 'success');
    } catch (e) {
        toast(e.message || 'Could not save that rule.', 'error');
    }
}

async function deleteTerm() {
    const id = $('admin-term-id').value;
    if (!id) return;
    const label = terms.find(t => t.id === id)?.label || 'this rule';
    closeTermForm();
    const answer = await ask({
        title: 'delete filter rule',
        blurb: `Remove <strong>${esc(label)}</strong> from the blocklist. Posts matching it will stop being caught.`,
        confirm: 'delete rule', requireReason: false, danger: false
    });
    if (!answer) return;
    try {
        const client = await getClient();
        const { error } = await client.rpc('admin_delete_banned_term', { p_id: id });
        if (error) throw error;
        await loadTerms();
        toast('Filter rule deleted', 'success');
    } catch (e) {
        toast(e.message || 'Could not delete that rule.', 'error');
    }
}

// Reuses the upsert RPC rather than a direct update, so toggling is logged
// like any other blocklist change.
async function toggleTerm(id) {
    const t = terms.find(x => x.id === id);
    if (!t) return;
    try {
        const client = await getClient();
        const { error } = await client.rpc('admin_upsert_banned_term', {
            p_id: t.id, p_pattern: t.pattern, p_label: t.label, p_severity: t.severity,
            p_action: t.action, p_enabled: !t.enabled, p_notes: t.notes || ''
        });
        if (error) throw error;
        t.enabled = !t.enabled;
        renderTerms();
    } catch (e) {
        toast(e.message || 'Could not change that rule.', 'error');
    }
}

// ---------- testers ----------
// Runs the real server-side scan rather than a JS re-implementation, since
// Postgres regex (\m, \M, \y) has no JS equivalent - a disagreeing tester
// would be worse than none.
const testFilter = debounce(async () => {
    const el = $('admin-filter-test-result');
    const text = $('admin-filter-test-input')?.value || '';
    if (!el) return;
    if (!text.trim()) { mountIsland(el, FilterTestResult, {}); return; }
    try {
        const client = await getClient();
        const { data, error } = await client.rpc('admin_test_content', { p_text: text });
        if (error) throw error;
        mountIsland(el, FilterTestResult, { hits: data || [] });
    } catch (e) {
        mountIsland(el, FilterTestResult, { error: e.message });
    }
}, 350);

// Runs the in-progress (unsaved) pattern through Postgres directly, which
// also catches a malformed regex before Save does.
const previewTerm = debounce(async () => {
    const el = $('admin-term-preview-result');
    if (!el) return;
    const pattern = $('admin-term-pattern')?.value.trim() || '';
    const phrase = $('admin-term-preview-input')?.value || '';
    if (!pattern) { mountIsland(el, PatternPreview, {}); return; }
    try {
        const client = await getClient();
        const { data, error } = await client.rpc('admin_test_pattern', { p_pattern: pattern, p_text: phrase });
        if (error) throw error;
        if (!data?.valid) mountIsland(el, PatternPreview, { status: 'invalid', detail: data?.error || '' });
        else if (!phrase.trim()) mountIsland(el, PatternPreview, { status: 'valid' });
        else mountIsland(el, PatternPreview, { status: data.match ? 'match' : 'no-match' });
    } catch (e) {
        mountIsland(el, PatternPreview, { status: 'error', detail: e.message });
    }
}, 350);

// ==================== install ====================
function install(context) {
    ctx = context;
    Object.assign(window, {
        adminSwitchTab: switchTab,
        adminToggleUserComments: toggleUserComments,
        adminToggleUserHistory: toggleUserHistory,
        adminToggleUserSessions: toggleUserSessions,
        adminResolveLocations: resolveLocations,
        adminShowIpNeighbours: showIpNeighbours,
        adminCloseIpModal: closeIpModal,
        adminModAction: modAction,
        adminCloseModAction: closeModAction,
        adminSubmitModAction: submitModAction,
        adminOpenPurge: openPurge,
        adminClosePurge: closePurge,
        adminPreviewPurge: previewPurge,
        adminSubmitPurge: submitPurge,
        adminDeleteComment: deleteComment,
        adminLoadRecentComments: loadRecentComments,
        adminLoadModLog: () => loadModLog(false),
        adminLoadMoreModLog: loadMoreModLog,
        adminAddTerm: () => openTermForm(null),
        adminEditTerm: openTermForm,
        adminCloseTermForm: closeTermForm,
        adminSubmitTermForm: submitTermForm,
        adminDeleteTerm: deleteTerm,
        adminToggleTerm: toggleTerm,
        adminTestTermDebounced: testFilter,
        adminPreviewTerm: previewTerm
    });
    applyTabPermissions();
}

export { install, standingPills, moderationBar, mountUserRowIslands, switchTab, ask, can };
