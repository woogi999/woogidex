import { log } from './log.js';
import { state, api } from './app.js';

// ==================== STATE ====================
// state.community.* is initialized lazily (see initAuth-style note in auth.js —
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
            comments: []        // comments for the currently open mon
        };
    }
    return state.community;
}

// ==================== PUBLISH / UNPUBLISH ====================
// Publishes a snapshot of a Fakemon from the user's own collection. Snapshot
// (not a live link) so edits/deletes in the private collection don't silently
// change what's already posted publicly — republish to update it.
async function publishFakemon(fakemonId) {
    if (!state.user) { api.showToast?.('Sign in to publish to the Community Hub.', 'warning'); return; }
    const mon = state.fakemonDB.find(f => String(f.id) === String(fakemonId));
    if (!mon) { api.showToast?.('Could not find that Fakemon.', 'error'); return; }
    await publishSnapshot(mon);
}

// Publishes whatever is currently open in the editor — used by the Share
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

async function publishSnapshot(mon) {
    const client = await api.getClient();
    const payload = {
        user_id: state.user.id,
        author_name: state.user.displayName || state.user.email,
        author_avatar_url: state.user.avatarUrl || null,
        source_fakemon_id: String(mon.id),
        fakemon_data: mon
    };
    const { error } = await client.from('published_mons').insert(payload);
    if (error) { log.error('COMMUNITY', 'Publish failed', error); api.showToast?.('Publish failed: ' + error.message, 'error'); return; }
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

async function unpublishMon(publishedId, event) {
    if (event) event.stopPropagation();
    if (!state.user) return;
    const client = await api.getClient();
    const { error } = await client.from('published_mons').delete().eq('id', publishedId).eq('user_id', state.user.id);
    if (error) { log.error('COMMUNITY', 'Unpublish failed', error); api.showToast?.('Could not unpublish: ' + error.message, 'error'); return; }
    api.showToast?.('Removed from Community Hub', 'info');
    const cs = ensureCommunityState();
    if (cs.openMonId === publishedId) {
        state.isCommunityPreview = false;
        cs.openMonId = null;
        cs.openMonRow = null;
        document.getElementById('community-detail-view').style.display = 'none';
    }
    await fetchCommunityFeed();
    renderCommunityGrid();
}

// Wrapper for the detail page's Unpublish button — inline onclick handlers
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
        author_name: state.user.displayName || state.user.email,
        author_avatar_url: state.user.avatarUrl || null,
        body: text
    };
    const { error } = await client.from('mon_comments').insert(payload);
    if (error) { log.error('COMMUNITY', 'Comment failed', error); api.showToast?.('Comment failed: ' + error.message, 'error'); return; }
    await fetchComments(publishedId);
    renderMonComments();
}

async function deleteComment(commentId, publishedId) {
    if (!state.user) return;
    const client = await api.getClient();
    const { error } = await client.from('mon_comments').delete().eq('id', commentId).eq('user_id', state.user.id);
    if (error) { api.showToast?.('Could not delete comment: ' + error.message, 'error'); return; }
    await fetchComments(publishedId);
    renderMonComments();
}

// ==================== UI: hub view ====================
async function openCommunityHub() {
    api.autoSave?.(true);
    document.getElementById('editor-view') && (document.getElementById('editor-view').style.display = 'none');
    document.getElementById('collection-view') && (document.getElementById('collection-view').style.display = 'none');
    document.getElementById('community-view').style.display = 'block';
    const grid = document.getElementById('community-grid');
    grid.innerHTML = '<div class="community-loading">Loading Community Hub…</div>';
    await fetchCommunityFeed();
    renderCommunityGrid();
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

function renderCommunityGrid() {
    const cs = ensureCommunityState();
    const grid = document.getElementById('community-grid');
    if (!grid) return;
    if (cs.loading) { grid.innerHTML = '<div class="community-loading">Loading Community Hub…</div>'; return; }
    if (!cs.mons.length) { grid.innerHTML = '<div class="community-empty">Nobody has published a Fakemon yet — be the first!</div>'; return; }

    grid.innerHTML = cs.mons.map(row => {
        const mon = row.fakemon_data || {};
        const type1Class = mon.type1 ? `type-${mon.type1.toLowerCase()}` : '';
        const type2Class = mon.type2 ? `type-${mon.type2.toLowerCase()}` : '';
        const isMine = state.user && row.user_id === state.user.id;
        return `
            <div class="collection-card community-card" onclick="openMonDetail('${row.id}')">
                ${isMine ? `<button class="card-delete-btn community-unpublish-btn" onclick="unpublishMon('${row.id}', event); event.stopPropagation();" title="Unpublish"><i data-lucide="x" style="width:14px;height:14px;"></i></button>` : ''}
                <div class="card-art">${mon.artwork ? `<img src="${mon.artwork}" alt="${escapeHtml(mon.name)}" draggable="false">` : '<span class="placeholder">ART</span>'}</div>
                <div class="card-name">${escapeHtml(mon.name)}</div>
                <div class="card-types">
                    ${mon.type1 ? `<span class="type-badge ${type1Class}">${mon.type1}</span>` : ''}
                    ${mon.type2 ? `<span class="type-badge ${type2Class}">${mon.type2}</span>` : ''}
                </div>
                <div class="community-card-author">
                    ${row.author_avatar_url ? `<img class="community-mini-avatar" src="${row.author_avatar_url}" alt="">` : `<span class="community-mini-avatar community-mini-avatar-fallback">${escapeHtml((row.author_name || '?').charAt(0).toUpperCase())}</span>`}
                    <span>${escapeHtml(row.author_name)}</span>
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
    }

    document.getElementById('editor-view') && (document.getElementById('editor-view').style.display = 'none');
    document.getElementById('collection-view') && (document.getElementById('collection-view').style.display = 'none');
    document.getElementById('community-view').style.display = 'none';
    document.getElementById('community-detail-view').style.display = 'block';

    document.getElementById('community-detail-title').textContent = mon.name || 'Fakemon';
    document.getElementById('community-detail-author').innerHTML = `
        ${row.author_avatar_url ? `<img class="community-mini-avatar" src="${row.author_avatar_url}" alt="">` : `<span class="community-mini-avatar community-mini-avatar-fallback">${escapeHtml((row.author_name || '?').charAt(0).toUpperCase())}</span>`}
        <span>Published by ${escapeHtml(row.author_name)}</span>
    `;

    const isMine = state.user && row.user_id === state.user.id;
    document.getElementById('community-detail-unpublish-btn').style.display = isMine ? 'inline-flex' : 'none';

    document.getElementById('mon-detail-comment-box').style.display = state.user ? 'flex' : 'none';
    document.getElementById('mon-detail-comment-signin-hint').style.display = state.user ? 'none' : 'block';
    document.getElementById('mon-detail-comment-input').value = '';

    document.getElementById('mon-detail-comments').innerHTML = '<div class="community-loading">Loading comments…</div>';
    if (typeof lucide !== 'undefined') lucide.createIcons();

    await fetchComments(publishedId);
    renderMonComments();
}

function closeMonDetail() {
    const cs = ensureCommunityState();
    state.isCommunityPreview = false;
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
        return `
            <div class="mon-comment">
                <div class="mon-comment-header">
                    ${c.author_avatar_url ? `<img class="community-mini-avatar" src="${c.author_avatar_url}" alt="">` : `<span class="community-mini-avatar community-mini-avatar-fallback">${escapeHtml((c.author_name || '?').charAt(0).toUpperCase())}</span>`}
                    <span class="mon-comment-author">${escapeHtml(c.author_name)}</span>
                    <span class="mon-comment-time">${new Date(c.created_at).toLocaleString()}</span>
                    ${mine ? `<button class="mon-comment-delete" onclick="deleteComment('${c.id}', '${cs.openMonId}')" title="Delete"><i data-lucide="trash-2" style="width:12px;height:12px;"></i></button>` : ''}
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
    openCommunityHub, closeCommunityHub, renderCommunityGrid,
    openMonDetail, closeMonDetail, renderMonComments, submitMonComment,
    importCommunityMonToCollection, toggleCommunityExportMenu, closeCommunityExportMenu,
    toggleShareMenu, closeShareMenu
};
