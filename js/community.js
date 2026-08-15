import { log } from './log.js';
import { state, api } from './app.js';
import { renderBadge, renderRoleTag } from './data.js';

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
        source_fakemon_id: String(mon.id),
        fakemon_data: mon
    };
    const { error } = await client.from('published_mons').insert(payload);
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
    api.showToast?.(`${mon.name} published to the Community Hub!`, 'success');
    log.info('COMMUNITY', 'Published', { id: mon.id, name: mon.name });
}

function toggleShareMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('share-menu');
    if (!menu) return;
    menu.style.display = menu.style.display === 'none' || !menu.style.display ? 'block' : 'none';
}

function closeShareMenu() {
    const menu = document.getElementById('share-menu');
    if (menu) menu.style.display = 'none';
}

document.addEventListener('click', (event) => {
    if (!event.target.closest('.export-as-wrap')) closeShareMenu();
});

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
        cs.mons = data || [];
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
        cs.comments = data || [];
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
        body: text
    };
    const { error } = await client.from('mon_comments').insert(payload);
    if (error) { log.error('COMMUNITY', 'Comment failed', error); api.showToast?.('Comment failed: ' + error.message, 'error'); return; }
    await fetchComments(publishedId);
    renderMonComments();
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

    closeShareMenu();
    closeCommunityExportMenu();

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
                ${canDelete ? `<button class="card-delete-btn community-unpublish-btn" onclick="unpublishMon('${row.id}', event); event.stopPropagation();" title="${isMine ? 'Unpublish' : 'Remove (staff)'}"><i data-lucide="x" style="width:14px;height:14px;"></i></button>` : ''}
                <div class="card-art">${mon.artwork ? `<img src="${mon.artwork}" alt="${escapeHtml(mon.name)}" draggable="false">` : '<span class="placeholder">ART</span>'}</div>
                <div class="card-name">${escapeHtml(mon.name)}</div>
                <div class="card-types">
                    ${mon.type1 ? `<span class="type-badge ${type1Class}">${mon.type1}</span>` : ''}
                    ${mon.type2 ? `<span class="type-badge ${type2Class}">${mon.type2}</span>` : ''}
                </div>
                <div class="community-card-author">
                    ${row.author_avatar_url ? `<img class="community-mini-avatar" src="${row.author_avatar_url}" alt="">` : `<span class="community-mini-avatar community-mini-avatar-fallback">${escapeHtml((row.author_name || '?').charAt(0).toUpperCase())}</span>`}
                    <span>${escapeHtml(row.author_name)}</span>
                    ${renderRoleTag(row.author_role)}
                </div>
            </div>
        `;
    }).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ==================== UI: detail page ("warp" like the Share page) ====================
async function openMonDetail(publishedId) {
    const cs = ensureCommunityState();
    const row = cs.mons.find(m => m.id === publishedId);
    if (!row) return;
    closeShareMenu();
    closeCommunityExportMenu();
    cs.openMonId = publishedId;
    cs.openMonRow = row;
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

    document.getElementById('editor-view') && (document.getElementById('editor-view').style.display = 'none');
    document.getElementById('collection-view') && (document.getElementById('collection-view').style.display = 'none');
    document.getElementById('community-view').style.display = 'none';
    document.getElementById('community-detail-view').style.display = 'block';

    document.getElementById('community-detail-title').textContent = mon.name || 'Fakemon';
    document.getElementById('community-detail-author').innerHTML = `
        ${row.author_avatar_url ? `<img class="community-mini-avatar" src="${row.author_avatar_url}" alt="">` : `<span class="community-mini-avatar community-mini-avatar-fallback">${escapeHtml((row.author_name || '?').charAt(0).toUpperCase())}</span>`}
        <span>Published by ${escapeHtml(row.author_name)}</span>
        ${renderRoleTag(row.author_role)}
    `;

    const isMine = state.user && row.user_id === state.user.id;
    const canDelete = isMine || api.isStaff?.();
    const unpublishBtn = document.getElementById('community-detail-unpublish-btn');
    unpublishBtn.style.display = canDelete ? 'inline-flex' : 'none';
    unpublishBtn.title = isMine ? 'Unpublish' : 'Remove (staff)';

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
                    <span class="mon-comment-author">${escapeHtml(c.author_name)}</span>
                    ${renderRoleTag(c.author_role)}
                    <span class="mon-comment-time">${new Date(c.created_at).toLocaleString()}</span>
                    ${canDelete ? `<button class="mon-comment-delete" onclick="deleteComment('${c.id}', '${cs.openMonId}')" title="${mine ? 'Delete' : 'Remove (staff)'}"><i data-lucide="trash-2" style="width:12px;height:12px;"></i></button>` : ''}
                </div>
                <div class="mon-comment-body">${escapeHtml(c.body)}</div>
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
    publishFakemon, publishCurrentEditorFakemon, unpublishMon, unpublishOpenCommunityMon, fetchCommunityFeed,
    fetchComments, postComment, deleteComment,
    openCommunityHub, closeCommunityHub, renderCommunityGrid, filterCommunity, changeCommunitySort, openCommunityRulesModal, closeCommunityRulesModal, acceptCommunityRules,
    openMonDetail, closeMonDetail, renderMonComments, submitMonComment,
    importCommunityMonToCollection, toggleCommunityExportMenu, closeCommunityExportMenu,
    toggleShareMenu, closeShareMenu
};
