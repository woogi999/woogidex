import { log } from './log.js';
import { state, api } from './app.js';
import { renderBadgeRow, renderCommentMarkdown } from './data.js';

// ==================== LIVE ROLES ====================
// Roles are DB-driven now (see LIVE_PROFILES_AND_ROLES_SETUP.sql) so staff
// can add/edit them from the admin panel. Cache the table once per session
// rather than re-fetching on every render; falls back to data.js's static
// ROLES (used as seed data) if the fetch ever fails.
let rolesMapCache = null;
async function getRolesMap() {
    if (rolesMapCache) return rolesMapCache;
    try {
        const client = await api.getClient();
        const { data, error } = await client.from('roles').select('*');
        if (error) throw error;
        rolesMapCache = {};
        (data || []).forEach(r => { rolesMapCache[r.key] = { label: r.label, color: r.color, rank: r.rank }; });
    } catch (e) {
        log.error('COMMUNITY', 'Roles fetch failed, using defaults', e);
        rolesMapCache = null;
    }
    return rolesMapCache;
}

// ==================== LIVE AUTHOR INFO ====================
// Published mons / comments still WRITE author_name/author_avatar_url/
// author_role/author_badges at insert time (harmless denormalized columns,
// kept as a fallback for a since-deleted account), but rendering no longer
// trusts them. Instead every fetch batch-loads the current profiles + role +
// badges for whoever's user_ids showed up, so a rename/avatar change/role
// change/badge grant shows up immediately everywhere without needing the
// original row edited. Falls back to the stored snapshot only if the
// author's profile is missing entirely (e.g. deleted account).
async function attachLiveAuthorInfo(rows) {
    if (!rows.length) return rows;
    const client = await api.getClient();
    const userIds = [...new Set(rows.map(r => r.user_id).filter(Boolean))];
    ensureCommunityState().rolesMap = await getRolesMap();
    if (!userIds.length) return rows;

    const [{ data: profiles }, { data: badgeRows }, { data: badgeDefinitions }] = await Promise.all([
        client.from('profiles').select('id, username, display_name, avatar_url, role, display_badges').in('id', userIds),
        client.from('profile_badges').select('user_id, badge_key').in('user_id', userIds),
        client.from('badges').select('key, label, icon, color, description, rank').order('rank', { ascending: false })
    ]);
    if (Array.isArray(badgeDefinitions) && badgeDefinitions.length) api.setBadgeDefinitions?.(badgeDefinitions);

    const profileById = {};
    (profiles || []).forEach(p => { profileById[p.id] = p; });
    const badgesByUser = {};
    (badgeRows || []).forEach(b => { (badgesByUser[b.user_id] ||= []).push(b.badge_key); });

    rows.forEach(row => {
        const p = profileById[row.user_id];
        row.author_name = p ? (p.display_name || p.username || row.author_name) : row.author_name;
        row.author_avatar_url = p ? (p.avatar_url || row.author_avatar_url) : row.author_avatar_url;
        row.author_role = p ? (p.role || 'user') : row.author_role;
        row.author_badges = p ? (Array.isArray(p.display_badges) ? p.display_badges : (badgesByUser[row.user_id] || [])) : row.author_badges;
    });
    return rows;
}

// ==================== STATE ====================
// state.community.* is initialized lazily (see initAuth-style note in auth.js -
// same circular-import concern doesn't apply here since community.js isn't
// imported by app.js's own dependencies before state exists, but we still
// keep it lazy for consistency and to avoid holding stale data across visits).
function ensureCommunityState() {
    if (!state.community) {
        state.community = {
            mons: [],          // feed: array of published-mon rows from Supabase
            loading: false,
            openMonId: null,   // currently open detail page, if any
            openMonRow: null,  // the full row object for the open detail page
            comments: [],        // comments for the currently open mon
            search: '',
            sortBy: 'published',
            sortOrder: 'desc'
        };
    }
    return state.community;
}

// ==================== PUBLISH / UNPUBLISH ====================
// Publishes a snapshot of a Fakemon from the user's own collection. Snapshot
// (not a live link) so edits/deletes in the private collection don't silently
// change what's already posted publicly - republish to update it.
async function publishFakemon(fakemonId) {
    if (!state.user) { api.showToast?.('Sign in to publish to the Community Hub.', 'warning'); return; }
    const mon = state.fakemonDB.find(f => String(f.id) === String(fakemonId));
    if (!mon) { api.showToast?.('Could not find that Fakemon.', 'error'); return; }
    await publishSnapshot(mon);
}

// Publishes whatever is currently open in the editor - used by the Share
// dropdown's "Publish to Community" option. Forces an immediate save first
// so the published snapshot matches what's on screen, including a brand new
// Fakemon that hasn't been auto-saved yet.
async function publishCurrentEditorFakemon() {
    if (!state.user) { api.showToast?.('Sign in to publish to the Community Hub.', 'warning'); return; }
    const name = document.getElementById('fakemon-name')?.value.trim();
    if (!name) { api.showToast?.('Please enter a Pokemon name before publishing!', 'error'); return; }
    await api.autoSave?.(true);
    const mon = state.fakemonDB.find(f => String(f.id) === String(state.editingId));
    if (!mon) { api.showToast?.('Could not find that Fakemon.', 'error'); return; }
    await publishSnapshot(mon);
}

async function publishSnapshot(mon, rulesChecked = false) {
    // Show the rules before every Community upload, even after the user has
    // accepted them previously. This makes the upload rules impossible to miss.
    if (!rulesChecked) {
        openCommunityRulesModal({ requireAgreement: true, onAccept: () => publishSnapshot(mon, true) });
        return;
    }
    const client = await api.getClient();

    // Client-side pre-check so the user gets a friendly "come back in Xm"
    // message instead of a raw database error. The Supabase RLS policy
    // (see SUPABASE_SETUP.md) is the real enforcement and can't be bypassed
    // by skipping this check.
    const { data: recent, error: recentError } = await client
        .from('published_mons')
        .select('published_at')
        .eq('user_id', state.user.id)
        .order('published_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (!recentError && recent) {
        const elapsedMs = Date.now() - new Date(recent.published_at).getTime();
        const cooldownMs = 60 * 60 * 1000;
        if (elapsedMs < cooldownMs) {
            const remainingMin = Math.ceil((cooldownMs - elapsedMs) / 60000);
            api.showToast?.(`You can publish again in ${remainingMin} minute${remainingMin === 1 ? '' : 's'}.`, 'warning');
            return;
        }
    }

    const payload = {
        user_id: state.user.id,
        author_name: state.user.displayName || state.user.username || state.user.email,
        author_avatar_url: state.user.avatarUrl || null,
        author_role: state.user.role || 'user',
        author_badges: state.user.badges || [],
        source_fakemon_id: String(mon.id),
        fakemon_data: mon
    };
    const { data: published, error } = await client.from('published_mons').insert(payload).select('id').single();
    if (error) {
        log.error('COMMUNITY', 'Publish failed', error);
        // A 42501/RLS rejection here means the hourly cooldown was hit despite
        // the pre-check above (e.g. published from another tab/device).
        const friendly = /row-level security|permission denied/i.test(error.message)
            ? 'You can only publish once per hour.'
            : ('Publish failed: ' + error.message);
        api.showToast?.(friendly, 'error');
        return;
    }
    const copied = published?.id ? await copyCommunityShareLink(published.id, true) : false;
    api.showToast?.(`${mon.name} published to the Community Hub!${copied ? ' Share link copied.' : ''}`, 'success');
    log.info('COMMUNITY', 'Published', { id: published?.id, name: mon.name });
}


// Pushes the current state of a Fakemon the user already has published back
// up to its existing Community Hub listing (same row, same comments) instead
// of creating a duplicate post. Skips the hourly publish cooldown since this
// is an edit to something already live, not a new upload.
async function updatePublishedMon(publishedId) {
    if (!state.user) { api.showToast?.('Sign in to update your Community Hub listing.', 'warning'); return; }
    const client = await api.getClient();
    const { data: row, error: fetchError } = await client
        .from('published_mons')
        .select('*')
        .eq('id', publishedId)
        .maybeSingle();
    if (fetchError || !row) { api.showToast?.('Could not find that listing.', 'error'); return; }
    if (row.user_id !== state.user.id && !api.isStaff?.()) { api.showToast?.('You can only update your own listings.', 'error'); return; }

    // Prefer whatever's currently open in the editor if it's the same
    // Fakemon (covers "I just tweaked it, now update the listing"); otherwise
    // fall back to the saved copy in the collection.
    const isEditingSameMon = state.editingId && String(state.editingId) === String(row.source_fakemon_id) && !state.isCommunityPreview;
    if (isEditingSameMon) await api.autoSave?.(true);
    const mon = state.fakemonDB.find(f => String(f.id) === String(row.source_fakemon_id));
    if (!mon) { api.showToast?.('Could not find the current version of this Fakemon in your collection.', 'error'); return; }

    const payload = {
        author_name: state.user.displayName || state.user.username || state.user.email,
        author_avatar_url: state.user.avatarUrl || null,
        author_role: state.user.role || 'user',
        author_badges: state.user.badges || [],
        fakemon_data: mon
    };
    const { error } = await client.from('published_mons').update(payload).eq('id', publishedId);
    if (error) {
        log.error('COMMUNITY', 'Update listing failed', error);
        api.showToast?.('Could not update the listing: ' + error.message, 'error');
        return;
    }
    api.showToast?.(`${mon.name}'s Community Hub listing was updated!`, 'success');
    log.info('COMMUNITY', 'Updated published listing', { id: publishedId, name: mon.name });

    const cs = ensureCommunityState();
    const idx = (cs.mons || []).findIndex(m => m.id === publishedId);
    const updatedRow = { ...row, ...payload };
    if (idx !== -1) cs.mons[idx] = updatedRow;
    if (cs.openMonId === publishedId) {
        cs.openMonRow = updatedRow;
        await openMonDetail(publishedId);
    } else {
        renderCommunityGrid();
    }
}

// Wrapper for the detail page's "Update Listing" button - inline onclick
// handlers only have access to functions on `api`/`window`, not module-scoped `state`.
function updateOpenCommunityMon() {
    const cs = ensureCommunityState();
    if (cs.openMonId) updatePublishedMon(cs.openMonId);
}

async function openPublishedMonById(publishedId, options = {}) {
    const client = await api.getClient();
    const { data, error } = await client.from('published_mons').select('*').eq('id', publishedId).maybeSingle();
    if (error || !data) { api.showToast?.('Could not load that Fakemon.', 'error'); return false; }
    const cs = ensureCommunityState();
    cs.mons = [data, ...(cs.mons || []).filter(x => x.id !== data.id)];
    await attachLiveAuthorInfo(cs.mons);
    await openMonDetail(publishedId, options);
    return true;
}

// Owners "unpublish" their own mon; staff can remove ANY mon as a moderation
// action (RLS on published_mons allows is_staff() to delete any row - see
// SUPABASE_SETUP.md). Same eq('user_id', ...) guard logic as deleteComment.
async function unpublishMon(publishedId, event) {
    if (event) event.stopPropagation();
    if (!state.user) return;
    const client = await api.getClient();
    let query = client.from('published_mons').delete().eq('id', publishedId);
    if (!api.isStaff?.()) query = query.eq('user_id', state.user.id);
    const { error } = await query;
    if (error) { log.error('COMMUNITY', 'Unpublish failed', error); api.showToast?.('Could not unpublish: ' + error.message, 'error'); return; }
    api.showToast?.(api.isStaff?.() ? 'Removed by staff' : 'Removed from Community Hub', 'info');
    const cs = ensureCommunityState();
    if (cs.openMonId === publishedId) {
        // We were viewing the mon we just unpublished - return to the grid
        // instead of leaving a blank screen. openCommunityHub() reads and
        // clears isCommunityPreview itself; don't touch it here.
        cs.openMonId = null;
        cs.openMonRow = null;
        document.getElementById('community-detail-view').style.display = 'none';
        await openCommunityHub();
        return;
    }
    await fetchCommunityFeed();
    renderCommunityGrid();
}

// Wrapper for the detail page's Unpublish button - inline onclick handlers
// only have access to functions on `api`/`window`, not module-scoped `state`.
function unpublishOpenCommunityMon() {
    const cs = ensureCommunityState();
    if (cs.openMonId) unpublishMon(cs.openMonId);
}
// ==================== COMMUNITY SHARE ROUTES ====================
const COMMUNITY_HASH_PREFIX = '#community/';

function communityShareUrl(publishedId) {
    return `${window.location.href.split('#')[0]}${COMMUNITY_HASH_PREFIX}${encodeURIComponent(String(publishedId))}`;
}

function copyOpenCommunityShareLink() { return copyCommunityShareLink(ensureCommunityState().openMonId); }

async function copyCommunityShareLink(publishedId, silent = false) {
    if (!publishedId) return false;
    const url = communityShareUrl(publishedId);
    try {
        await navigator.clipboard.writeText(url);
        if (!silent) api.showToast?.('Community share link copied!', 'success');
        return true;
    } catch (_) {
        if (!silent) window.prompt('Copy this Community share link:', url);
        return false;
    }
}

function exitCommunityRoute() {
    if ((window.location.hash || '').startsWith(COMMUNITY_HASH_PREFIX)) {
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
}

async function handleCommunityHashRoute() {
    const hash = window.location.hash || '';
    if (!hash.startsWith(COMMUNITY_HASH_PREFIX)) return false;
    const publishedId = decodeURIComponent(hash.slice(COMMUNITY_HASH_PREFIX.length)).trim();
    if (!publishedId) return false;
    return await openPublishedMonById(publishedId, { preserveHash: true });
}

// ==================== FEED ====================
async function fetchCommunityFeed() {
    const cs = ensureCommunityState();
    cs.loading = true;
    try {
        const client = await api.getClient();
        const { data, error } = await client
            .from('published_mons')
            .select('*')
            .order('published_at', { ascending: false })
            .limit(100);
        if (error) throw error;
        cs.mons = await attachLiveAuthorInfo(data || []);
        log.info('COMMUNITY', 'Feed loaded', { count: cs.mons.length });
    } catch (e) {
        log.error('COMMUNITY', 'Feed load failed', e);
        api.showToast?.('Could not load the Community Hub.', 'error');
        cs.mons = [];
    } finally {
        cs.loading = false;
    }
}

// ==================== COMMENTS ====================
async function fetchComments(publishedId) {
    const cs = ensureCommunityState();
    try {
        const client = await api.getClient();
        const { data, error } = await client
            .from('mon_comments')
            .select('*')
            .eq('mon_id', publishedId)
            .order('created_at', { ascending: true });
        if (error) throw error;
        cs.comments = await attachLiveAuthorInfo(data || []);
    } catch (e) {
        log.error('COMMUNITY', 'Comments load failed', e);
        cs.comments = [];
    }
}

async function postComment(publishedId, body) {
    if (!state.user) { api.showToast?.('Sign in to comment.', 'warning'); return; }
    const text = body.trim();
    if (!text) return;
    if (text.length > 1000) { api.showToast?.('Comments are limited to 1000 characters.', 'warning'); return; }

    const client = await api.getClient();
    const payload = {
        mon_id: publishedId,
        user_id: state.user.id,
        author_name: state.user.displayName || state.user.username || state.user.email,
        author_avatar_url: state.user.avatarUrl || null,
        author_role: state.user.role || 'user',
        author_badges: state.user.badges || [],
        body: text
    };
    const { error } = await client.from('mon_comments').insert(payload);
    if (error) { log.error('COMMUNITY', 'Comment failed', error); api.showToast?.('Comment failed: ' + error.message, 'error'); return; }
    await fetchComments(publishedId);
    renderMonComments();

    // Let the mon's owner know someone commented, unless they're commenting
    // on their own mon. openMonRow is set whenever the comment box is
    // visible (it only shows on the detail page), so it's a reliable source
    // for who owns this mon without an extra fetch.
    const cs = ensureCommunityState();
    const ownerRow = cs.openMonId === publishedId ? cs.openMonRow : null;
    if (ownerRow) {
        api.createNotification?.({
            userId: ownerRow.user_id,
            actorId: state.user.id,
            actorName: payload.author_name,
            actorAvatarUrl: payload.author_avatar_url,
            type: 'mon_comment',
            targetId: publishedId,
            targetName: (ownerRow.fakemon_data || {}).name || 'your Fakemon',
            preview: text
        });
    }
}

// Staff (moderator/admin/developer) can delete any comment; everyone else
// only their own. The .eq('user_id', ...) guard is dropped for staff since
// RLS on mon_comments already allows is_staff() to delete any row - trying
// to also filter by user_id here would just make staff deletes silently
// no-op on comments they don't own.
async function deleteComment(commentId, publishedId) {
    if (!state.user) return;
    const client = await api.getClient();
    let query = client.from('mon_comments').delete().eq('id', commentId);
    if (!api.isStaff?.()) query = query.eq('user_id', state.user.id);
    const { error } = await query;
    if (error) { api.showToast?.('Could not delete comment: ' + error.message, 'error'); return; }
    await fetchComments(publishedId);
    renderMonComments();
}

// ==================== UI: hub view ====================
// ==================== COMMUNITY RULES ====================
const COMMUNITY_RULES_KEY = 'woogidex-community-rules-v2';
let communityRulesPendingAction = null;

function hasAcceptedCommunityRules() {
    return localStorage.getItem(COMMUNITY_RULES_KEY) === 'accepted';
}

function openCommunityRulesModal({ requireAgreement = false, onAccept = null } = {}) {
    communityRulesPendingAction = typeof onAccept === 'function' ? onAccept : null;
    const row = document.getElementById('community-rules-agree-row');
    const checkbox = document.getElementById('community-rules-checkbox');
    const title = document.getElementById('community-rules-title');
    if (title) title.textContent = requireAgreement ? 'Community Rules Before Publishing' : 'Community Rules';
    if (row) row.style.display = requireAgreement ? 'flex' : 'flex';
    if (checkbox) checkbox.checked = false;
    document.getElementById('community-rules-modal')?.classList.add('active');
}

function closeCommunityRulesModal() {
    document.getElementById('community-rules-modal')?.classList.remove('active');
    communityRulesPendingAction = null;
}

function acceptCommunityRules() {
    const checkbox = document.getElementById('community-rules-checkbox');
    if (!checkbox?.checked) {
        api.showToast?.('Please agree to the Community Rules first.', 'warning');
        return;
    }
    localStorage.setItem(COMMUNITY_RULES_KEY, 'accepted');
    const action = communityRulesPendingAction;
    communityRulesPendingAction = null;
    document.getElementById('community-rules-modal')?.classList.remove('active');
    if (action) action();
}

async function openCommunityHub() {
    exitCommunityRoute();
    // Leaving a community-mon preview is a navigation action, not an editor
    // save - mirrors how showCollection() treats leaving a shared-link
    // preview. Without this guard, the editor DOM still holds whatever
    // community Fakemon was last previewed, and force-saving it here would
    // silently import it into the user's own collection.
    const wasCommunityPreview = !!state.isCommunityPreview;
    state.isCommunityPreview = false;

    // Community pages are never an editor session. If we are leaving a preview,
    // discard the preview-only editor identity so it cannot become a real save
    // target later. Only a genuinely visible editor gets a navigation autosave.
    if (wasCommunityPreview) {
        if (state.autoSaveTimer) {
            clearTimeout(state.autoSaveTimer);
            state.autoSaveTimer = null;
        }
        state.editingId = null;
    } else if (document.getElementById('editor-view')?.style.display !== 'none') {
        await api.autoSave?.(true);
    }

    closeCommunityExportMenu();
    api.exitProfileRoute?.();

    document.getElementById('profile-view') && (document.getElementById('profile-view').style.display = 'none');
    document.getElementById('editor-view') && (document.getElementById('editor-view').style.display = 'none');
    document.getElementById('collection-view') && (document.getElementById('collection-view').style.display = 'none');
    document.getElementById('community-detail-view') && (document.getElementById('community-detail-view').style.display = 'none');
    document.getElementById('community-view').style.display = 'block';

    if (!hasAcceptedCommunityRules()) {
        openCommunityRulesModal({ requireAgreement: false });
    }

    const grid = document.getElementById('community-grid');
    grid.innerHTML = '<div class="community-loading">Loading Community Hub…</div>';

    // Guard against a slower, earlier fetch resolving after a newer one and
    // clobbering the grid with stale data (e.g. rapid back-and-forth clicks).
    const cs = ensureCommunityState();
    const requestToken = Symbol('community-fetch');
    cs.latestFetchToken = requestToken;
    await fetchCommunityFeed();
    if (cs.latestFetchToken === requestToken) renderCommunityGrid();
}

function closeCommunityHub() {
    document.getElementById('community-view').style.display = 'none';
    api.showCollection?.();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
}

const COMMUNITY_SORT_KEY = 'woogidex.community.sort.v1';

function getCommunityPrefs() {
    const cs = ensureCommunityState();
    try {
        const saved = JSON.parse(localStorage.getItem(COMMUNITY_SORT_KEY) || 'null');
        if (saved) {
            cs.sortBy = ['published','name','author','number'].includes(saved.sortBy) ? saved.sortBy : 'published';
            cs.sortOrder = saved.sortOrder === 'asc' ? 'asc' : 'desc';
        }
    } catch {}
    return { sortBy: cs.sortBy || 'published', sortOrder: cs.sortOrder === 'asc' ? 'asc' : 'desc' };
}

function applyCommunityPrefsToUI() {
    const prefs = getCommunityPrefs();
    const by = document.getElementById('community-sort-by');
    const order = document.getElementById('community-sort-order');
    const search = document.getElementById('community-search-input');
    if (by) by.value = prefs.sortBy;
    if (order) order.value = prefs.sortOrder;
    const cs = ensureCommunityState();
    if (search) search.value = cs.search || '';
    return prefs;
}

function changeCommunitySort() {
    const cs = ensureCommunityState();
    cs.sortBy = document.getElementById('community-sort-by')?.value || 'published';
    cs.sortOrder = document.getElementById('community-sort-order')?.value === 'asc' ? 'asc' : 'desc';
    try { localStorage.setItem(COMMUNITY_SORT_KEY, JSON.stringify({ sortBy: cs.sortBy, sortOrder: cs.sortOrder })); } catch {}
    renderCommunityGrid();
}

function filterCommunity() {
    const cs = ensureCommunityState();
    cs.search = (document.getElementById('community-search-input')?.value || '').trim().toLowerCase();
    renderCommunityGrid();
}

function getCommunityDexNumber(mon) {
    const n = parseInt(String(mon?.number || '').replace(/^#/, ''), 10);
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function renderCommunityGrid() {
    const cs = ensureCommunityState();
    const grid = document.getElementById('community-grid');
    if (!grid) return;
    applyCommunityPrefsToUI();
    if (cs.loading) { grid.innerHTML = '<div class="community-loading">Loading Community Hub…</div>'; return; }

    const search = cs.search || '';
    let mons = (cs.mons || []).filter(row => {
        if (!search) return true;
        const mon = row.fakemon_data || {};
        const text = `${mon.name || ''} ${mon.species || ''} ${mon.type1 || ''} ${mon.type2 || ''} ${row.author_name || ''}`;
        return text.toLowerCase().includes(search);
    });

    const prefs = getCommunityPrefs();
    const dir = prefs.sortOrder === 'asc' ? 1 : -1;
    mons.sort((a, b) => {
        const am = a.fakemon_data || {}, bm = b.fakemon_data || {};
        let result = 0;
        if (prefs.sortBy === 'name') result = String(am.name || '').localeCompare(String(bm.name || ''));
        else if (prefs.sortBy === 'author') result = String(a.author_name || '').localeCompare(String(b.author_name || ''));
        else if (prefs.sortBy === 'number') result = getCommunityDexNumber(am) - getCommunityDexNumber(bm);
        else result = new Date(a.published_at || 0).getTime() - new Date(b.published_at || 0).getTime();
        if (result === 0) result = String(am.name || '').localeCompare(String(bm.name || ''));
        return result * dir;
    });

    if (!mons.length) {
        grid.innerHTML = search
            ? '<div class="community-empty">No Fakemon matched your search.</div>'
            : '<div class="community-empty">Nobody has published a Fakemon yet - be the first!</div>';
        return;
    }

    grid.innerHTML = mons.map(row => {
        const mon = row.fakemon_data || {};
        const type1Class = mon.type1 ? `type-${mon.type1.toLowerCase()}` : '';
        const type2Class = mon.type2 ? `type-${mon.type2.toLowerCase()}` : '';
        const isMine = state.user && row.user_id === state.user.id;
        const canDelete = isMine || api.isStaff?.();
        return `
            <div class="collection-card community-card" onclick="openMonDetail('${row.id}')">
                ${canDelete ? `<button class="card-delete-btn community-unpublish-btn" onclick="unpublishMon('${row.id}', event); event.stopPropagation();" title="${isMine ? 'Unpublish' : 'Remove (staff)'}"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>` : ''}
                <div class="card-art">${mon.artwork ? `<img src="${mon.artwork}" alt="${escapeHtml(mon.name)}" draggable="false">` : '<span class="placeholder">ART</span>'}</div>
                <div class="card-name">${escapeHtml(mon.name)}</div>
                <div class="card-types">
                    ${mon.type1 ? `<span class="type-badge ${type1Class}">${mon.type1}</span>` : ''}
                    ${mon.type2 ? `<span class="type-badge ${type2Class}">${mon.type2}</span>` : ''}
                </div>
                <div class="community-card-author">
                    ${row.author_avatar_url ? `<img class="community-mini-avatar" src="${row.author_avatar_url}" alt="">` : `<span class="community-mini-avatar community-mini-avatar-fallback">${escapeHtml((row.author_name || '?').charAt(0).toUpperCase())}</span>`}
                    <span class="community-author-link" onclick="event.stopPropagation(); showUserProfile('${row.user_id}')">${escapeHtml(row.author_name)}</span>
                    ${renderBadgeRow(row.author_badges, 13)}
                </div>
            </div>
        `;
    }).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ==================== UI: detail page ("warp" like the Share page) ====================
async function openMonDetail(publishedId, options = {}) {
    const cs = ensureCommunityState();
    const row = cs.mons.find(m => m.id === publishedId);
    if (!row) return;
    closeCommunityExportMenu();
    cs.openMonId = publishedId;
    cs.openMonRow = row;
    if (!options.preserveHash) history.replaceState(null, '', communityShareUrl(publishedId));
    const mon = row.fakemon_data || {};

    // Cancel any pending editor autosave so switching into this read-only
    // preview can never commit as a new collection entry, and mark this as
    // a non-editable route the same way the Share page does.
    if (state.autoSaveTimer) { clearTimeout(state.autoSaveTimer); state.autoSaveTimer = null; }
    state.isCommunityPreview = true;
    state.editingId = null;
    api.loadFakemonIntoEditor(mon);
    api.updatePreview?.();

    const source = document.getElementById('pokedex-board-container');
    const target = document.getElementById('community-detail-board');
    if (source && target) {
        target.innerHTML = source.innerHTML.replace(/id="pokedex-board-export"/g, 'id="pokedex-board-community"');
        const shinyToggle = target.querySelector('#board-artwork-shiny-toggle');
        if (shinyToggle) {
            shinyToggle.setAttribute('onclick', 'toggleCommunityPreviewArtworkMode(event)');
            shinyToggle.removeAttribute('id');
        }
        // Community detail is a read-only copy of the editor preview. Keep its
        // artwork toggle independent from the hidden editor board so clicks
        // always update the board the user is actually looking at.
        setCommunityPreviewArtworkMode(state.previewArtworkMode || 'normal');
    }

    api.exitProfileRoute?.();
    document.getElementById('profile-view') && (document.getElementById('profile-view').style.display = 'none');
    document.getElementById('editor-view') && (document.getElementById('editor-view').style.display = 'none');
    document.getElementById('collection-view') && (document.getElementById('collection-view').style.display = 'none');
    document.getElementById('community-view').style.display = 'none';
    document.getElementById('community-detail-view').style.display = 'block';

    document.getElementById('community-detail-title').textContent = mon.name || 'Fakemon';
    document.getElementById('community-detail-author').innerHTML = `
        ${row.author_avatar_url ? `<img class="community-mini-avatar" src="${row.author_avatar_url}" alt="">` : `<span class="community-mini-avatar community-mini-avatar-fallback">${escapeHtml((row.author_name || '?').charAt(0).toUpperCase())}</span>`}
        <span class="community-author-link" onclick="event.stopPropagation(); showUserProfile('${row.user_id}')">Published by ${escapeHtml(row.author_name)}</span>
        ${renderBadgeRow(row.author_badges, 13)}
    `;

    const isMine = state.user && row.user_id === state.user.id;
    const canDelete = isMine || api.isStaff?.();
    const unpublishBtn = document.getElementById('community-detail-unpublish-btn');
    unpublishBtn.style.display = canDelete ? 'inline-flex' : 'none';
    unpublishBtn.title = isMine ? 'Unpublish' : 'Remove (staff)';
    const updateBtn = document.getElementById('community-detail-update-btn');
    if (updateBtn) updateBtn.style.display = isMine ? 'inline-flex' : 'none';

    document.getElementById('mon-detail-comment-box').style.display = state.user ? 'flex' : 'none';
    document.getElementById('mon-detail-comment-signin-hint').style.display = state.user ? 'none' : 'block';
    document.getElementById('mon-detail-comment-input').value = '';

    document.getElementById('mon-detail-comments').innerHTML = '<div class="community-loading">Loading comments…</div>';
    if (typeof lucide !== 'undefined') lucide.createIcons();

    await fetchComments(publishedId);
    renderMonComments();
}

function setCommunityPreviewArtworkMode(mode) {
    const target = document.getElementById('community-detail-board');
    if (!target) return;
    state.previewArtworkMode = mode === 'shiny' && state.shinyArtworkData ? 'shiny' : 'normal';
    const active = state.previewArtworkMode === 'shiny';
    const toggle = target.querySelector('.board-artwork-shiny-toggle');
    if (toggle) {
        toggle.classList.toggle('active', active);
        toggle.setAttribute('aria-pressed', active ? 'true' : 'false');
        toggle.title = active ? 'Show normal artwork' : 'Show shiny artwork';
        toggle.setAttribute('aria-label', active ? 'Show normal artwork' : 'Show shiny artwork');
    }
    const image = target.querySelector('#board-artwork-image');
    if (image) {
        const artwork = active ? state.shinyArtworkData : state.artworkData;
        const name = state.community?.openMonRow?.fakemon_data?.name || 'Fakemon';
        image.innerHTML = artwork ? `<img src="${artwork}" alt="${escapeHtml(name)}${active ? ' shiny' : ''} artwork">` : `<span class="placeholder">${active ? 'SHINY' : 'ART'}</span>`;
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function toggleCommunityPreviewArtworkMode(event) {
    event?.preventDefault();
    event?.stopPropagation();
    setCommunityPreviewArtworkMode(state.previewArtworkMode === 'shiny' ? 'normal' : 'shiny');
}

window.setCommunityPreviewArtworkMode = setCommunityPreviewArtworkMode;
window.toggleCommunityPreviewArtworkMode = toggleCommunityPreviewArtworkMode;

function closeMonDetail() {
    exitCommunityRoute();
    const cs = ensureCommunityState();
    cs.openMonId = null;
    cs.openMonRow = null;
    document.getElementById('community-detail-view').style.display = 'none';
    openCommunityHub();
}

// Imports the currently open community Fakemon into the signed-in user's
// own collection as a new, independent entry (same pattern as importing a
// shared-link Fakemon).
async function importCommunityMonToCollection() {
    const cs = ensureCommunityState();
    const row = cs.openMonRow;
    if (!row) return;
    const mon = row.fakemon_data || {};
    const copy = JSON.parse(JSON.stringify(mon));
    copy.id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    copy.folderId = null;
    copy.pinned = false;
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    state.fakemonDB = Array.isArray(state.fakemonDB) ? state.fakemonDB : [];
    state.fakemonDB.push(copy);
    await api.saveToStorage();
    api.showToast?.(`${copy.name} imported into your collection!`, 'success');
}

function toggleCommunityExportMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('community-export-as-menu');
    if (!menu) return;
    menu.style.display = menu.style.display === 'none' || !menu.style.display ? 'block' : 'none';
}

function closeCommunityExportMenu() {
    const menu = document.getElementById('community-export-as-menu');
    if (menu) menu.style.display = 'none';
}

document.addEventListener('click', (event) => {
    if (!event.target.closest('.export-as-wrap')) closeCommunityExportMenu();
});

function renderMonComments() {
    const cs = ensureCommunityState();
    const container = document.getElementById('mon-detail-comments');
    if (!container) return;
    if (!cs.comments.length) { container.innerHTML = '<div class="community-empty">No comments yet.</div>'; return; }
    container.innerHTML = cs.comments.map(c => {
        const mine = state.user && c.user_id === state.user.id;
        const canDelete = mine || api.isStaff?.();
        return `
            <div class="mon-comment">
                <div class="mon-comment-header">
                    ${c.author_avatar_url ? `<img class="community-mini-avatar" src="${c.author_avatar_url}" alt="">` : `<span class="community-mini-avatar community-mini-avatar-fallback">${escapeHtml((c.author_name || '?').charAt(0).toUpperCase())}</span>`}
                    <span class="mon-comment-author community-author-link" onclick="event.stopPropagation(); showUserProfile('${c.user_id}')">${escapeHtml(c.author_name)}</span>
                    ${renderBadgeRow(c.author_badges, 12)}
                    <span class="mon-comment-time">${new Date(c.created_at).toLocaleString()}</span>
                    ${canDelete ? `<button class="mon-comment-delete" onclick="deleteComment('${c.id}', '${cs.openMonId}')" title="${mine ? 'Delete' : 'Remove (staff)'}"><i data-lucide="trash-2" style="width:12px;height:12px;"></i></button>` : ''}
                </div>
                <div class="mon-comment-body">${renderCommentMarkdown(c.body)}</div>
            </div>
        `;
    }).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function submitMonComment() {
    const cs = ensureCommunityState();
    const input = document.getElementById('mon-detail-comment-input');
    if (!cs.openMonId || !input) return;
    await postComment(cs.openMonId, input.value);
    input.value = '';
}

export {
    publishFakemon, publishCurrentEditorFakemon, unpublishMon, unpublishOpenCommunityMon, updatePublishedMon, updateOpenCommunityMon, fetchCommunityFeed,
    fetchComments, postComment, deleteComment,
    openCommunityHub, closeCommunityHub, renderCommunityGrid, filterCommunity, changeCommunitySort, openCommunityRulesModal, closeCommunityRulesModal, acceptCommunityRules,
    openMonDetail, openPublishedMonById, closeMonDetail, renderMonComments, submitMonComment, handleCommunityHashRoute, exitCommunityRoute, copyCommunityShareLink, copyOpenCommunityShareLink,
    importCommunityMonToCollection, toggleCommunityExportMenu, closeCommunityExportMenu,
};
