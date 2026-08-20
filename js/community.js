import { log } from './log.js';
import { state, api } from './app.js';
import { renderBadgeRow, renderCommentMarkdown } from './data.js';

// ==================== live roles ====================
// roles are db-driven now (see live_profiles_and_roles_setup.sql) so staff
// can add/edit them from the admin panel. cache the table once per session
// rather than re-fetching on every render; falls back to data.js's static
// roles (used as seed data) if the fetch ever fails.
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

// ==================== live author info ====================
// published mons / comments still write author_name/author_avatar_url/
// author_role/author_badges at insert time (harmless denormalized columns,
// kept as a fallback for a since-deleted account), but rendering no longer
// trusts them. instead every fetch batch-loads the current profiles + role +
// badges for whoever's user_ids showed up, so a rename/avatar change/role
// change/badge grant shows up immediately everywhere without needing the
// original row edited. falls back to the stored snapshot only if the
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

// ==================== state ====================
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
            sortBy: 'activity',
            sortOrder: 'desc'
        };
    }
    return state.community;
}

// ==================== evolution family bundling ====================
// when a Fakemon has evolution stages (or mega/forme variants), each one is
// its own record in the user's local collection with its own copy of the
// shared evolutionGraph (see evolution.js persistEvolutionGraph). publishing
// only the one mon someone clicked "publish" on meant the other stages -
// which the graph references by *local* fakemonDB id - never made it to the
// Community Hub at all, so a visitor could never see the full chain.
//
// this walks the mon's saved evolutionGraph, resolves every fakemon-kind
// node back to the full record in state.fakemonDB, and returns the whole
// family in stage order so it can be published together as one upload.
function collectEvolutionFamily(mon) {
    const graph = mon?.evolutionGraph;
    if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length < 2) {
        return [{ mon, stage: mon?.evolutionStage || 1, isMega: !!mon?.isMega, isFormeChange: !!mon?.isFormeChange }];
    }
    const stages = api.calculateEvolutionStages?.(graph) || {};
    const seen = new Set();
    const members = [];
    graph.nodes.forEach(node => {
        if (node.kind !== 'fakemon' || !node.refId) return;
        if (seen.has(String(node.refId))) return;
        const f = String(node.refId) === String(mon.id) ? mon : (state.fakemonDB || []).find(x => String(x.id) === String(node.refId));
        if (!f) return; // a vanilla Pokémon node, or a stage that isn't (or is no longer) in this user's collection
        seen.add(String(node.refId));
        members.push({ mon: f, stage: stages[node.id] || f.evolutionStage || 1, isMega: !!node.isMega, isFormeChange: !!node.isFormeChange });
    });
    if (!members.some(m => String(m.mon.id) === String(mon.id))) {
        members.push({ mon, stage: mon.evolutionStage || 1, isMega: !!mon.isMega, isFormeChange: !!mon.isFormeChange });
    }
    members.sort((a, b) => a.stage - b.stage || String(a.mon.name || '').localeCompare(String(b.mon.name || '')));
    return members;
}

// small denormalized summary of every member of a family, embedded on the
// single published_mons row so the grid card can render evolution/mega/forme
// thumbnails without any extra fetch.
function buildFamilySnapshotsPayload(family) {
    return family.map(({ mon: f, stage, isMega, isFormeChange }) => ({
        sourceId: String(f.id),
        name: f.name || 'Unnamed',
        number: f.number || '',
        artwork: f.artwork || null,
        type1: f.type1 || '',
        type2: f.type2 || '',
        stage, isMega, isFormeChange
    }));
}

// the *full* record for every family member, so clicking a stage/mega/forme
// in the detail view can swap the live preview board to that mon entirely
// client-side - same post, same comments/likes/views, just a different
// snapshot on display. kept out of the slim feed query (openMonDetail's
// `select('*')` is what actually loads this).
function buildFamilyFullPayload(family) {
    return family.map(({ mon: f, stage, isMega, isFormeChange }) => ({
        sourceId: String(f.id),
        mon: f,
        stage, isMega, isFormeChange
    }));
}

// ==================== publish / unpublish ====================
// publishes a snapshot of a Fakemon from the user's own collection. snapshot
// (not a live link) so edits/deletes in the private collection don't silently
// change what's already posted publicly - republish to update it.
async function publishFakemon(fakemonId) {
    if (!state.user) { api.showToast?.('Sign in to publish to the Community Hub.', 'warning'); return; }
    const mon = state.fakemonDB.find(f => String(f.id) === String(fakemonId));
    if (!mon) { api.showToast?.('Could not find that Fakemon.', 'error'); return; }
    await publishSnapshot(mon);
}

// publishes whatever is currently open in the editor - used by the share
// dropdown's "publish to community" option. forces an immediate save first
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
    // show the rules before every community upload, even after the user has
    // accepted them previously. this makes the upload rules impossible to miss.
    if (!rulesChecked) {
        openCommunityRulesModal({ requireAgreement: true, onAccept: () => publishSnapshot(mon, true) });
        return;
    }
    const client = await api.getClient();

    // client-side pre-check so the user gets a friendly "come back in xm"
    // message instead of a raw database error. the Supabase RLS policy
    // (see Supabase_setup.md) is the real enforcement and can't be bypassed
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

    // gather every evolution stage / mega / forme reachable from this mon's
    // saved evolution graph so the whole family goes up as ONE post - a
    // single published_mons row, with the other stages riding along as
    // embedded snapshots rather than separate rows.
    const family = collectEvolutionFamily(mon);
    const isFamily = family.length > 1;
    // diagnostic: if you expected this mon to bundle its evolutions but this
    // logs size 1, the mon's saved evolutionGraph isn't reaching this
    // function with resolvable sibling stages - check that mon.evolutionGraph
    // exists and that its other stages are in state.fakemonDB.
    console.info('[COMMUNITY] Publishing', mon.name, '- family size:', family.length, family.map(f => f.mon?.name));

    const payload = {
        user_id: state.user.id,
        author_name: state.user.displayName || state.user.username || state.user.email,
        author_avatar_url: state.user.avatarUrl || null,
        author_role: state.user.role || 'user',
        author_badges: state.user.badges || [],
        source_fakemon_id: String(mon.id),
        fakemon_data: mon,
        evolution_stage: mon.evolutionStage || 1,
        family_snapshots: isFamily ? buildFamilySnapshotsPayload(family) : [],
        family_full: isFamily ? buildFamilyFullPayload(family) : []
    };
    const { data: published, error } = await client.from('published_mons').insert(payload).select('id').single();
    if (error) {
        log.error('COMMUNITY', 'Publish failed', error);
        // a 42501/RLS rejection here means the hourly cooldown was hit despite
        // the pre-check above (e.g. published from another tab/device).
        const friendly = /row-level security|permission denied/i.test(error.message)
            ? 'You can only publish once per hour.'
            : ('Publish failed: ' + error.message);
        api.showToast?.(friendly, 'error');
        return;
    }
    const copied = published?.id ? await copyCommunityShareLink(published.id, true) : false;
    const extra = isFamily ? ` (with its ${family.length - 1} other evolution stage${family.length - 1 === 1 ? '' : 's'})` : '';
    api.showToast?.(`${mon.name} published to the Community Hub!${extra}${copied ? ' Share link copied.' : ''}`, 'success');
    log.info('COMMUNITY', 'Published', { id: published?.id, name: mon.name, familySize: family.length });
}


// pushes the current state of a Fakemon the user already has published back
// up to its existing community hub listing (same row, same comments) instead
// of creating a duplicate post. skips the hourly publish cooldown since this
// is an edit to something already live, not a new upload.
async function updatePublishedMon(publishedId, selectedSourceId = '') {
    if (!state.user) { api.showToast?.('Sign in to update your Community Hub listing.', 'warning'); return; }
    const client = await api.getClient();
    const { data: row, error: fetchError } = await client
        .from('published_mons')
        .select('*')
        .eq('id', publishedId)
        .maybeSingle();
    if (fetchError || !row) { api.showToast?.('Could not find that listing.', 'error'); return; }
    if (row.user_id !== state.user.id && !api.isStaff?.()) { api.showToast?.('You can only update your own listings.', 'error'); return; }

    const mon = state.fakemonDB.find(f => String(f.id) === String(selectedSourceId));
    if (!mon) { api.showToast?.('Could not find that Fakemon in your collection.', 'error'); return; }

    // re-walk the evolution graph from the newly-selected mon so the family
    // bundled with this post reflects its current stages/megas/formes too.
    const family = collectEvolutionFamily(mon);
    const isFamily = family.length > 1;

    const payload = {
        author_name: state.user.displayName || state.user.username || state.user.email,
        author_avatar_url: state.user.avatarUrl || null,
        author_role: state.user.role || 'user',
        author_badges: state.user.badges || [],
        fakemon_data: mon,
        source_fakemon_id: String(mon.id),
        evolution_stage: mon.evolutionStage || 1,
        family_snapshots: isFamily ? buildFamilySnapshotsPayload(family) : [],
        family_full: isFamily ? buildFamilyFullPayload(family) : []
    };
    const { error } = await client.from('published_mons').update(payload).eq('id', publishedId);
    if (error) {
        log.error('COMMUNITY', 'Update listing failed', error);
        api.showToast?.('Could not update the listing: ' + error.message, 'error');
        return;
    }

    closeCommunityUpdateModal();
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

function getCommunityUpdateCollection(){const collection=Array.isArray(state.fakemonDB)?state.fakemonDB.slice():[];const search=(document.getElementById('community-update-search')?.value||'').trim().toLowerCase();const sortBy=document.getElementById('community-update-sort-by')?.value||'created';const order=document.getElementById('community-update-sort-order')?.value==='asc'?1:-1;const dex=f=>{const n=parseInt(String(f?.number||'').replace(/^#/,'') ,10);return Number.isFinite(n)?n:Number.POSITIVE_INFINITY};const bst=f=>['hp','attack','defense','spAtk','spDef','speed'].reduce((sum,k)=>sum+(Number(f?.stats?.[k])||0),0);const filtered=collection.filter(f=>!search||String(f?.name||'').toLowerCase().includes(search)||String(f?.number||'').toLowerCase().includes(search));filtered.sort((a,b)=>{if(sortBy==='name')return String(a.name||'').localeCompare(String(b.name||''))*order;if(sortBy==='number')return(dex(a)-dex(b))*order;if(sortBy==='bst')return(bst(a)-bst(b))*order;if(sortBy==='updated')return((Number(a.updatedAt)||0)-(Number(b.updatedAt)||0))*order;return((Number(a.createdAt)||0)-(Number(b.createdAt)||0))*order});return filtered}
function renderCommunityUpdateCollection(selectedId=''){const grid=document.getElementById('community-update-collection-grid');if(!grid)return;const collection=getCommunityUpdateCollection();if(!collection.length){grid.innerHTML='<div class="community-update-empty">No Fakemon match your search.</div>';return}grid.innerHTML=collection.map(f=>{const id=escapeHtml(String(f.id)),active=String(f.id)===String(selectedId),art=f.artwork||'',number=f.number?`#${escapeHtml(String(f.number).replace(/^#/,''))}`:'';const bst=['hp','attack','defense','spAtk','spDef','speed'].reduce((sum,k)=>sum+(Number(f?.stats?.[k])||0),0);return `<button type="button" class="community-update-mon-card${active?' selected':''}" data-id="${id}" onclick="selectCommunityUpdateMon('${id}')"><div class="community-update-mon-art">${art?`<img src="${escapeHtml(art)}" alt="${escapeHtml(f.name||'Fakemon')}">`:'<img class="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork">'}</div><div class="community-update-mon-info"><strong>${escapeHtml(f.name||'Unnamed Fakemon')}</strong><span>${number}${number&&bst?' · ':''}${bst?'BST '+bst:''}</span></div></button>`}).join('');const current=collection.find(f=>String(f.id)===String(selectedId));const label=document.getElementById('community-update-selected'),confirm=document.getElementById('community-update-confirm');if(label)label.textContent=current?`Selected: ${current.name||'Unnamed Fakemon'}`:'No Fakemon selected';if(confirm)confirm.disabled=!current;if(typeof lucide!=='undefined')lucide.createIcons()}
function sortCommunityUpdateCollection(){renderCommunityUpdateCollection(document.getElementById('community-update-selected-id')?.value||'')}
function filterCommunityUpdateCollection(){renderCommunityUpdateCollection(document.getElementById('community-update-selected-id')?.value||'')}
function selectCommunityUpdateMon(id){let hidden=document.getElementById('community-update-selected-id');if(!hidden){hidden=document.createElement('input');hidden.type='hidden';hidden.id='community-update-selected-id';document.getElementById('community-update-modal')?.appendChild(hidden)}hidden.value=String(id);renderCommunityUpdateCollection(String(id))}
function openCommunityUpdateModal(){const cs=ensureCommunityState(),row=cs.openMonRow;if(!row||!state.user||row.user_id!==state.user.id)return;const collection=Array.isArray(state.fakemonDB)?state.fakemonDB:[];if(!collection.length){api.showToast?.('You need at least one Fakemon in your collection to update this listing.','warning');return}const hidden=document.getElementById('community-update-selected-id');if(hidden)hidden.value=row.source_fakemon_id&&collection.some(f=>String(f.id)===String(row.source_fakemon_id))?String(row.source_fakemon_id):'';const search=document.getElementById('community-update-search');if(search)search.value='';const by=document.getElementById('community-update-sort-by');if(by)by.value='created';const order=document.getElementById('community-update-sort-order');if(order)order.value='desc';renderCommunityUpdateCollection(hidden?.value||'');document.getElementById('community-update-modal')?.classList.add('active');if(typeof lucide!=='undefined')lucide.createIcons()}
function closeCommunityUpdateModal(){document.getElementById('community-update-modal')?.classList.remove('active')}
function confirmCommunityUpdate(){const cs=ensureCommunityState(),selected=document.getElementById('community-update-selected-id')?.value||'';if(!cs.openMonId||!selected){api.showToast?.('Choose a Fakemon from your collection first.','warning');return}updatePublishedMon(cs.openMonId,selected)}

// wrapper for the detail page's "update listing" button - inline onclick
function updateOpenCommunityMon() {
    openCommunityUpdateModal();
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

// owners "unpublish" their own mon; staff can remove any mon as a moderation
// action (RLS on published_mons allows is_staff() to delete any row - see
// Supabase_setup.md). same eq('user_id', ...) guard logic as deleteComment.
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
        // we were viewing the mon we just unpublished - return to the grid
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

// wrapper for the detail page's unpublish button - inline onclick handlers
// only have access to functions on `api`/`window`, not module-scoped `state`.
function unpublishOpenCommunityMon() {
    const cs = ensureCommunityState();
    if (cs.openMonId) unpublishMon(cs.openMonId);
}
// ==================== community share routes ====================
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

// ==================== feed ====================
// the grid only ever renders a mon's name, types, and artwork thumbnail (see
// renderCommunityGrid below) - but `fakemon_data` also carries shiny artwork,
// a cry audio clip, the full learnset, sample sets, and evolution graph,
// which for a published Fakemon can add up to several hundred kb or more.
// pulling all of that for every row of a 100-row feed (on every single
// community hub open) was by far the biggest source of Supabase egress in
// the app. we only need the slim fields here; openMonDetail() below fetches
// the full row on demand, only for the one mon someone actually opens.
async function fetchCommunityFeed() {
    const cs = ensureCommunityState();
    cs.loading = true;
    try {
        const client = await api.getClient();
        const { data, error } = await client
            .from('published_mons')
            .select('id, user_id, published_at, activity_at, view_count, source_fakemon_id, author_name, author_avatar_url, author_role, author_badges, family_snapshots, evolution_stage, fakemon_data->>name, fakemon_data->>species, fakemon_data->>number, fakemon_data->>type1, fakemon_data->>type2, fakemon_data->>artwork')
            .order('activity_at', { ascending: false })
            .limit(100);
        if (error) throw error;
        cs.mons = await attachLiveAuthorInfo((data || []).map(unflattenSlimMonRow));
        await hydrateCommunityStats(cs.mons);
        log.info('COMMUNITY', 'Feed loaded', { count: cs.mons.length });
    } catch (e) {
        log.error('COMMUNITY', 'Feed load failed', e);
        api.showToast?.('Could not load the Community Hub.', 'error');
        cs.mons = [];
    } finally {
        cs.loading = false;
    }
}

// Supabase/PostgREST's `column->>key` selector returns each requested jsonb
// key as its own flat top-level column (named `key`, not `fakemon_data`)
// rather than a nested object. every renderer in this file expects
// `row.fakemon_data.name` etc., so this rebuilds that shape from the flat
// columns and removes them so a slim row can't be mistaken for a full one.
function unflattenSlimMonRow(row) {
    const { name, species, number, type1, type2, artwork, ...rest } = row;
    return { ...rest, fakemon_data: { name, species, number, type1, type2, artwork } };
}

// ==================== community stats ====================
async function hydrateCommunityStats(rows) {
    if (!rows.length) return rows;
    const client = await api.getClient();
    const ids = rows.map(r => r.id).filter(Boolean);
    const [{ data: comments }, { data: likes }] = await Promise.all([
        client.from('mon_comments').select('mon_id').in('mon_id', ids),
        client.from('mon_likes').select('mon_id, user_id').in('mon_id', ids)
    ]);
    const commentCounts = {};
    const likeCounts = {};
    const likedByMe = {};
    (comments || []).forEach(r => { commentCounts[r.mon_id] = (commentCounts[r.mon_id] || 0) + 1; });
    (likes || []).forEach(r => {
        likeCounts[r.mon_id] = (likeCounts[r.mon_id] || 0) + 1;
        if (state.user && r.user_id === state.user.id) likedByMe[r.mon_id] = true;
    });
    rows.forEach(r => {
        r.comment_count = commentCounts[r.id] || 0;
        r.like_count = likeCounts[r.id] || 0;
        r.liked_by_me = !!likedByMe[r.id];
        r.view_count = Number(r.view_count || 0);
    });
    return rows;
}

async function toggleCommunityLike(publishedId, event) {
    event?.preventDefault();
    event?.stopPropagation();
    // capture the button synchronously, before any `await`. once a DOM event
    // finishes dispatching, the browser nulls out event.currentTarget - and
    // since this function is async, every line after our first `await` runs
    // *after* dispatch has already finished. reading currentTarget down
    // there was reliably grabbing null and falling through to a full-grid
    // querySelector re-scan, which is what made liking a mon feel like the
    // whole community hub was refreshing.
    const btn = event?.currentTarget || document.querySelector(`.community-like-btn[onclick*="'${publishedId}'"]`);
    if (!state.user) { api.showToast?.('Sign in to like Fakemon.', 'warning'); return; }
    const client = await api.getClient();
    const row = ensureCommunityState().mons.find(r => r.id === publishedId);
    const liked = !!row?.liked_by_me;
    if (liked) {
        const { error } = await client.from('mon_likes').delete().eq('mon_id', publishedId).eq('user_id', state.user.id);
        if (error) { api.showToast?.('Could not remove like: ' + error.message, 'error'); return; }
    } else {
        const { error } = await client.from('mon_likes').insert({ mon_id: publishedId, user_id: state.user.id });
        if (error) { api.showToast?.('Could not like this Fakemon: ' + error.message, 'error'); return; }
    }
    if (row) {
        row.liked_by_me = !liked;
        row.like_count = Math.max(0, Number(row.like_count || 0) + (liked ? -1 : 1));
    }
    // update just this card's like button in place instead of re-rendering
    // the whole grid - calling renderCommunityGrid() here was rebuilding
    // every card's DOM (replaying every entrance animation and resetting
    // scroll position) just to reflect one heart count changing.
    if (btn && row) {
        btn.classList.toggle('liked', row.liked_by_me);
        btn.title = row.liked_by_me ? 'Unlike' : 'Like';
        const countEl = btn.querySelector('span');
        if (countEl) countEl.textContent = row.like_count || 0;
    }
}

// ==================== comments ====================
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

    // let the mon's owner know someone commented, unless they're commenting
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

// staff (moderator/admin/developer) can delete any comment; everyone else
// only their own. the .eq('user_id', ...) guard is dropped for staff since
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
// ==================== community rules ====================
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
    // leaving a community-mon preview is a navigation action, not an editor
    // save - mirrors how showCollection() treats leaving a shared-link
    // preview. without this guard, the editor DOM still holds whatever
    // community Fakemon was last previewed, and force-saving it here would
    // silently import it into the user's own collection.
    const wasCommunityPreview = !!state.isCommunityPreview;
    state.isCommunityPreview = false;

    // community pages are never an editor session. if we are leaving a preview,
    // discard the preview-only editor identity so it cannot become a real save
    // target later. only a genuinely visible editor gets a navigation autosave.
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

    api.activateTopLevelView?.('community-view');
    api.setRoute?.('community', 'Community Hub');

    if (!hasAcceptedCommunityRules()) {
        openCommunityRulesModal({ requireAgreement: false });
    }

    renderCommunityGridSkeleton();

    // guard against a slower, earlier fetch resolving after a newer one and
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

const COMMUNITY_SORT_KEY = 'woogidex.community.sort.v2';

function getCommunityPrefs() {
    const cs = ensureCommunityState();
    try {
        const saved = JSON.parse(localStorage.getItem(COMMUNITY_SORT_KEY) || 'null');
        if (saved) {
            cs.sortBy = ['activity','likes','comments','views','published','name','author','number'].includes(saved.sortBy) ? saved.sortBy : 'activity';
            cs.sortOrder = saved.sortOrder === 'asc' ? 'asc' : 'desc';
        }
    } catch {}
    return { sortBy: cs.sortBy || 'activity', sortOrder: cs.sortOrder === 'asc' ? 'asc' : 'desc' };
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
    cs.sortBy = document.getElementById('community-sort-by')?.value || 'activity';
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

// skeleton cards mirror the real .collection-card.community-card markup
// exactly (same art box, name bar, type pills, stats row, author row) so
// there's no layout shift when real data replaces them.
function communityCardSkeleton() {
    return `
        <div class="collection-card community-card skel-card">
            <div class="card-art skel"></div>
            <div class="skel skel-text skel-name"></div>
            <div class="card-types">
                <span class="skel skel-pill"></span>
                <span class="skel skel-pill"></span>
            </div>
            <div class="community-card-stats">
                <span class="skel skel-pill"></span>
                <span class="skel skel-pill"></span>
                <span class="skel skel-pill"></span>
            </div>
            <div class="community-card-author">
                <span class="skel skel-circle"></span>
                <span class="skel skel-text"></span>
            </div>
        </div>
    `;
}

function renderCommunityGridSkeleton(count = 8) {
    const grid = document.getElementById('community-grid');
    if (!grid) return;
    grid.innerHTML = Array.from({ length: count }, () => communityCardSkeleton()).join('');
}

function renderCommunityGrid() {
    const cs = ensureCommunityState();
    const grid = document.getElementById('community-grid');
    if (!grid) return;
    applyCommunityPrefsToUI();
    if (cs.loading) { renderCommunityGridSkeleton(); return; }

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
        if (prefs.sortBy === 'activity') result = new Date(a.activity_at || a.published_at || 0).getTime() - new Date(b.activity_at || b.published_at || 0).getTime();
        else if (prefs.sortBy === 'likes') result = Number(a.like_count || 0) - Number(b.like_count || 0);
        else if (prefs.sortBy === 'comments') result = Number(a.comment_count || 0) - Number(b.comment_count || 0);
        else if (prefs.sortBy === 'views') result = Number(a.view_count || 0) - Number(b.view_count || 0);
        else if (prefs.sortBy === 'name') result = String(am.name || '').localeCompare(String(bm.name || ''));
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
                <div class="card-art">${mon.artwork ? `<img src="${mon.artwork}" alt="${escapeHtml(mon.name)}" draggable="false">` : '<img class="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork" draggable="false">'}</div>
                <div class="card-name">${escapeHtml(mon.name)}</div>
                ${renderCommunityEvoBadge(row)}
                <div class="card-types">
                    ${mon.type1 ? `<span class="type-badge ${type1Class}">${mon.type1}</span>` : ''}
                    ${mon.type2 ? `<span class="type-badge ${type2Class}">${mon.type2}</span>` : ''}
                </div>
                <div class="community-card-stats" aria-label="Community activity">
                    <button type="button" class="community-stat-btn" onclick="openMonDetail('${row.id}'); event.stopPropagation();" title="Comments"><i data-lucide="message-circle"></i><span>${row.comment_count || 0}</span></button>
                    <span class="community-stat-btn community-stat-static" title="Views"><i data-lucide="eye"></i><span>${row.view_count || 0}</span></span>
                    <button type="button" class="community-stat-btn community-like-btn${row.liked_by_me ? ' liked' : ''}" onclick="toggleCommunityLike('${row.id}', event)" title="${row.liked_by_me ? 'Unlike' : 'Like'}"><i data-lucide="heart"></i><span>${row.like_count || 0}</span></button>
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

// small text-only badge shown on a community card when this post bundles
// an evolution family (or mega/forme variants) - no per-stage interaction
// on the card itself, just a hint that there's more to see once opened.
function renderCommunityEvoBadge(row) {
    const members = Array.isArray(row.family_snapshots) ? row.family_snapshots : [];
    if (members.length < 2) return '';
    const stages = new Set(members.filter(m => !m.isMega && !m.isFormeChange).map(m => m.stage || 1));
    const hasMega = members.some(m => m.isMega);
    const hasForme = members.some(m => m.isFormeChange);
    const bits = [];
    if (stages.size > 1) bits.push(`${stages.size}-Stage`);
    if (hasMega) bits.push('Has Mega');
    if (hasForme) bits.push('Has Forme Change');
    if (!bits.length) bits.push(`${members.length} Forms`);
    return `<span class="community-card-evo-badge">${escapeHtml(bits.join(' \u00b7 '))}</span>`;
}

// tiny arrow glyph between evolution-chain nodes - same icon as the local
// editor's own preview-evo-connector (evolution.js PREVIEW_EVO_ARROW_ICON).
const COMMUNITY_EVO_ARROW_ICON = '<svg class="preview-evo-arrow-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M3 12h15M12 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// builds the same evolution-chain markup as the local editor's own
// renderPreviewEvolutionChain() (evolution.js), for a bundled community
// post. returns '' for a normal single-mon post. clicking a non-active node
// calls switchCommunityPreviewMon() to swap the live preview board in place
// - never navigates away, since it's all still the same post/comments/
// likes/views.
function buildCommunityEvoStripHtml(row) {
    const members = Array.isArray(row.family_full) ? row.family_full : [];
    if (members.length < 2) {
        // this is expected for a normal single-mon post - but if you just
        // published something with evolutions and still see this, either the
        // Supabase migration (family_full/family_snapshots columns) hasn't
        // been run, or this particular post predates it and needs republishing.
        if (row.family_snapshots?.length > 1 && !members.length) {
            console.warn('[COMMUNITY] This post has family_snapshots but no family_full data - it was likely published before the family_full column/migration existed. Republish it to backfill.');
        }
        return '';
    }
    const activeId = ensureCommunityState().openMonActiveSourceId || String(row.source_fakemon_id || '');
    const ordered = members.slice().sort((a, b) => (a.stage || 1) - (b.stage || 1));
    const parts = ordered.map((entry, i) => {
        const mon = entry.mon || {};
        const isCurrent = entry.sourceId === activeId;
        const label = entry.isMega ? 'Mega' : (entry.isFormeChange ? 'Forme' : `Stage ${entry.stage || 1}`);
        const typesHtml = [mon.type1, mon.type2].filter(Boolean).map(t => `<span class="type-pill type-${String(t).toLowerCase()}">${escapeHtml(t)}</span>`).join('');
        const metaBits = [mon.number, mon.species].filter(Boolean);
        const titleText = isCurrent ? 'Currently viewing' : `View ${mon.name || 'this stage'}`;
        const node = `<button type="button" class="preview-evo-node${isCurrent ? ' current' : ''}" ${isCurrent ? 'disabled' : `onclick="switchCommunityPreviewMon('${escapeHtml(entry.sourceId)}')"`} title="${escapeHtml(titleText)}">
            <span class="preview-evo-stage">${escapeHtml(label)}</span>
            <div class="preview-evo-sprite-wrap">${mon.artwork ? `<img src="${escapeHtml(mon.artwork)}" alt="${escapeHtml(mon.name || '')}">` : '<img class="no-art-placeholder" src="assets/no_art_placeholder.png" alt="">'}</div>
            <span class="preview-evo-name">${escapeHtml(mon.name || 'Unnamed')}</span>
            ${metaBits.length ? `<span class="preview-evo-meta">${escapeHtml(metaBits.join(' \u00b7 '))}</span>` : ''}
            ${typesHtml ? `<span class="preview-evo-types">${typesHtml}</span>` : ''}
        </button>`;
        if (i === ordered.length - 1) return node;
        return node + `<div class="preview-evo-connector">${COMMUNITY_EVO_ARROW_ICON}</div>`;
    }).join('');
    return `<div class="board-section board-evolution-chain"><div class="board-section-title">Evolution Chain</div><div class="preview-evo-row">${parts}</div></div>`;
}

function getCommunityViewerKey() {
    const keyName = 'woogidex.community.viewer.v1';
    try {
        let key = localStorage.getItem(keyName);
        if (!key) {
            key = (crypto?.randomUUID ? crypto.randomUUID() : `viewer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            localStorage.setItem(keyName, key);
        }
        return state.user?.id ? `user:${state.user.id}` : `anon:${key}`;
    } catch {
        return state.user?.id ? `user:${state.user.id}` : null;
    }
}

// ==================== UI: detail page ("warp" like the share page) ====================
// view counting calls an `increment_published_mon_view` RPC in Supabase.
// your project already has one, but with a single `p_published_id` param
// (confirmed via the PostgREST 404 hint when this called a 2-arg version) -
// so the call below matches that existing signature. if your function
// doesn't dedupe repeat views from the same visitor and you want that,
// replace it with this version instead (mirrors the notifications.js
// pattern for documenting schema this file depends on):
//
//   create table if not exists public.published_mon_views (
//     published_id uuid not null references public.published_mons(id) on delete cascade,
//     viewer_key text not null,
//     viewed_at timestamptz not null default now(),
//     primary key (published_id, viewer_key)
//   );
//   alter table public.published_mon_views enable row level security;
//   create policy "anyone can record a view" on public.published_mon_views
//     for insert with check (true);
//   create policy "anyone can read view rows" on public.published_mon_views
//     for select using (true);
//
//   -- drop the old single-arg version first so PostgREST doesn't end up
//   -- with two overloads of the same name and refuse to pick one:
//   drop function if exists public.increment_published_mon_view(uuid);
//   create or replace function public.increment_published_mon_view(
//     p_published_id uuid, p_viewer_key text
//   ) returns int
//   language plpgsql security definer as $$
//   declare v_count int;
//   begin
//     insert into public.published_mon_views (published_id, viewer_key)
//     values (p_published_id, p_viewer_key)
//     on conflict (published_id, viewer_key) do nothing;
//     if found then
//       update public.published_mons set view_count = coalesce(view_count, 0) + 1
//         where id = p_published_id;
//     end if;
//     select view_count into v_count from public.published_mons where id = p_published_id;
//     return v_count;
//   end;
//   $$;
//   grant execute on function public.increment_published_mon_view(uuid, text) to anon, authenticated;
//   -- and swap the .rpc() call below back to passing both p_published_id and p_viewer_key.
// renders a Fakemon snapshot into the read-only community preview board.
// shared by openMonDetail (first load) and switchCommunityPreviewMon
// (clicking an evolution/mega/forme chip) so both stay in sync.
function renderCommunityPreviewBoard(mon, row) {
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
        // community detail is a read-only copy of the editor preview. keep its
        // artwork toggle independent from the hidden editor board so clicks
        // always update the board the user is actually looking at.
        setCommunityPreviewArtworkMode(state.previewArtworkMode || 'normal');

        // the editor's own board puts the evolution chain inside
        // .board-learnset-slot, right after the learnset (see editor-core.js).
        // api.renderPreviewEvolutionChain() comes back empty here because this
        // preview isn't tied to a live-edited Fakemon (state.editingId is
        // null), so we inject our own version into that same slot to match
        // its placement exactly.
        if (row) {
            const slot = target.querySelector('.board-learnset-slot');
            const stripHtml = buildCommunityEvoStripHtml(row);
            if (slot && stripHtml) slot.insertAdjacentHTML('beforeend', stripHtml);
        }
    }
    api.setPageTitle?.(mon.name ? `${mon.name} (Community)` : 'Community Hub');
    const titleEl = document.getElementById('community-detail-title');
    if (titleEl) titleEl.textContent = mon.name || 'Fakemon';
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// clicking an evolution stage / mega / forme chip on a bundled post swaps
// the live preview board to that mon - same post underneath (same id, same
// comments/likes/views), just a different snapshot on display.
function switchCommunityPreviewMon(sourceId) {
    const cs = ensureCommunityState();
    const row = cs.openMonRow;
    const entry = (row?.family_full || []).find(m => m.sourceId === String(sourceId));
    if (!entry || cs.openMonActiveSourceId === String(sourceId)) return;
    cs.openMonActiveSourceId = String(sourceId);
    renderCommunityPreviewBoard(entry.mon, row);
}

async function openMonDetail(publishedId, options = {}) {
    const cs = ensureCommunityState();
    let row = cs.mons.find(m => m.id === publishedId);
    if (!row) return;
    // the feed only loads slim fields (name/types/artwork thumbnail) to keep
    // egress down - fetch the full row now that someone's actually opening
    // this one mon, so the live preview board has its real learnset, sample
    // sets, shiny artwork, cry, and evolution graph.
    try {
        const client = await api.getClient();
        const { data: fullRow, error } = await client.from('published_mons').select('*').eq('id', publishedId).maybeSingle();
        if (error) throw error;
        if (fullRow) {
            row = { ...row, ...fullRow };
            const idx = cs.mons.findIndex(m => m.id === publishedId);
            if (idx !== -1) cs.mons[idx] = row;
        }
    } catch (e) {
        log.error('COMMUNITY', 'Failed to load full mon detail', e);
        api.showToast?.('Could not load the full details for this Fakemon.', 'error');
        return;
    }
    closeCommunityExportMenu();
    cs.openMonId = publishedId;
    cs.openMonRow = row;
    if (!options.preserveHash) history.replaceState(null, '', communityShareUrl(publishedId));

    // if opened via an evolution/mega/forme chip (options.stage), show that
    // family member's snapshot first instead of the post's default mon.
    const familyFull = Array.isArray(row.family_full) ? row.family_full : [];
    const preselect = options.stage ? familyFull.find(m => m.sourceId === String(options.stage)) : null;
    const mon = preselect ? preselect.mon : (row.fakemon_data || {});
    cs.openMonActiveSourceId = preselect ? preselect.sourceId : String(row.source_fakemon_id || '');

    renderCommunityPreviewBoard(mon, row);

    api.exitProfileRoute?.();
    api.activateTopLevelView?.('community-detail-view');

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

    renderCommentsSkeleton();
    if (typeof lucide !== 'undefined') lucide.createIcons();

    try {
        const client = await api.getClient();
        const { data: nextViewCount, error: viewError } = await client.rpc('increment_published_mon_view', { p_published_id: publishedId });
        if (viewError) throw viewError;
        if (Number.isFinite(Number(nextViewCount))) row.view_count = Number(nextViewCount);
    } catch (e) {
        // most likely cause: your `increment_published_mon_view` function has
        // a different signature than the call above (see the comment at the
        // top of this section). fail quietly in the UI - a missing view
        // count should never block viewing the mon itself - but log it so
        // it's visible in devtools instead of vanishing.
        log.error('COMMUNITY', 'Failed to record view', e);
    }

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
        image.innerHTML = artwork ? `<img src="${artwork}" alt="${escapeHtml(name)}${active ? ' shiny' : ''} artwork">` : (active ? `<span class="placeholder">SHINY</span>` : '<img class="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork">');
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

// imports the currently open community Fakemon into the signed-in user's
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

// mirrors .mon-comment's real markup (avatar circle, author/time line, two
// body lines of varying width) so the skeleton -> real swap doesn't shift.
function commentSkeleton() {
    return `
        <div class="mon-comment skel-card">
            <div class="mon-comment-header">
                <span class="skel skel-circle"></span>
                <span class="skel skel-text"></span>
            </div>
            <div class="mon-comment-body">
                <span class="skel skel-text"></span>
                <span class="skel skel-text"></span>
            </div>
        </div>
    `;
}

function renderCommentsSkeleton(count = 3) {
    const container = document.getElementById('mon-detail-comments');
    if (!container) return;
    container.innerHTML = Array.from({ length: count }, () => commentSkeleton()).join('');
}

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
    importCommunityMonToCollection, toggleCommunityExportMenu, closeCommunityExportMenu, toggleCommunityLike, openCommunityUpdateModal, closeCommunityUpdateModal, confirmCommunityUpdate,
    renderCommunityGridSkeleton, renderCommentsSkeleton, selectCommunityUpdateMon, sortCommunityUpdateCollection, filterCommunityUpdateCollection,
    switchCommunityPreviewMon,
};
