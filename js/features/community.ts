import { log } from '../core/log.ts';
import { state, api } from '../core/app.ts';
import { notify } from '../app/store.ts';
import { openDialog, closeDialog } from '../app/dialogs.tsx';
// registers the rules and picker dialogs
import '../app/dialogs/community.tsx';
import { getCommunityDexNumber } from './community-feed-model.ts';
import { getCachedArt, getCachedArtBatch, putCachedArt, dropCachedArt } from '../core/art-cache.ts';
import { artworkBlob, frameCount, maskedArtwork, artworkDataUri } from '../core/art-shield.ts';
import { cloudLimits, refreshCloudLimits, asCap } from './cloud-save.ts';

// ==================== live roles ====================
// roles are db-driven so staff can edit them from the admin panel. cache
// per session; fall back to data.ts's static roles if the fetch fails.
// a failed fetch is cached too (`resolved`), so a missing table logs once
// instead of spamming a 404 on every render.
let rolesMapCache: any = null;
let rolesResolved = false;
async function getRolesMap() {
    if (rolesResolved) return rolesMapCache;
    try {
        const client = await api.getClient();
        const { data, error } = await client.from('roles').select('key, label, color, rank');
        if (error) throw error;
        const map: Record<string, any> = {};
        (data || []).forEach(r => { map[r.key] = { label: r.label, color: r.color, rank: r.rank }; });
        rolesMapCache = map;
    } catch (e: any) {
        // not an error: static ROLES fallback keeps the site working.
        log.warn('COMMUNITY', 'Roles fetch failed, using the built-in defaults', e);
        rolesMapCache = null;
    }
    rolesResolved = true;
    return rolesMapCache;
}

// ==================== live author info ====================
// denormalized author_* columns are still written at insert time (fallback
// for deleted accounts), but rendering batch-loads live profile/role/badges
// instead so renames/role changes/badge grants show up immediately everywhere.
async function attachLiveAuthorInfo(rows) {
    if (!rows.length) return rows;
    const client = await api.getClient();
    const userIds = [...new Set(rows.map(r => r.user_id).filter(Boolean))];
    ensureCommunityState().rolesMap = await getRolesMap();
    if (!userIds.length) return rows;

    const [{ data: profiles }, { data: badgeRows }, { data: badgeDefinitions }] = await Promise.all([
        client.from('profiles').select('id, username, display_name, avatar_url, role, display_badges').in('id', userIds),
        client.from('profile_badges').select('user_id, badge_key').in('user_id', userIds),
        client.from('badges').select('key, label, icon, icon_image, color, description, rank').order('rank', { ascending: false })
    ]);
    if (Array.isArray(badgeDefinitions) && badgeDefinitions.length) api.setBadgeDefinitions?.(badgeDefinitions);

    const profileById: Record<string, any> = {};
    (profiles || []).forEach(p => { profileById[p.id] = p; });
    const badgesByUser: Record<string, any> = {};
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
// state.community.* is initialized lazily, for consistency and to avoid
// holding stale data across visits.
function ensureCommunityState() {
    if (!state.community) {
        state.community = {
            mons: [] as any[],          // feed: array of published-mon rows from Supabase
            fetchedAt: 0,      // when the feed above was loaded (see FEED_MAX_AGE_MS)
            loading: false,
            openMonId: null as any,   // currently open detail page, if any
            openMonRow: null as any,  // the full row object for the open detail page
            comments: [] as any[],        // comments for the currently open mon
            search: '',
            sortBy: 'activity',
            sortOrder: 'desc',
            panel: 'landing'   // 'landing' or 'browse' -- see setCommunityPanel()
        };
    }
    return state.community;
}

// ==================== evolution family bundling ====================
// each evolution stage/mega/forme is its own local record; publishing only
// the clicked mon left the rest of the chain out of the Community Hub. this
// walks the saved evolutionGraph, resolves every fakemon node against
// state.fakemonDB, and returns the whole family in stage order to publish
// together as one upload.
function collectEvolutionFamily(mon) {
    const graph = mon?.evolutionGraph;
    if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length < 2) {
        return [{ mon, stage: mon?.evolutionStage || 1, isMega: !!mon?.isMega, isFormeChange: !!mon?.isFormeChange }];
    }
    const stages = api.calculateEvolutionStages?.(graph) || {};
    const seen = new Set();
    const members: any[] = [];
    graph.nodes.forEach(node => {
        if (node.kind !== 'fakemon' || !node.refId) return;
        if (seen.has(String(node.refId))) return;
        const f = String(node.refId) === String(mon.id) ? mon : (state.fakemonDB || []).find(x => String(x.id) === String(node.refId));
        if (!f) return; // vanilla Pokémon node, or a stage not (or no longer) in this collection
        seen.add(String(node.refId));
        members.push({ mon: f, stage: stages[node.id] || f.evolutionStage || 1, isMega: !!node.isMega, isFormeChange: !!node.isFormeChange });
    });
    if (!members.some(m => String(m.mon.id) === String(mon.id))) {
        members.push({ mon, stage: mon.evolutionStage || 1, isMega: !!mon.isMega, isFormeChange: !!mon.isFormeChange });
    }
    members.sort((a, b) => a.stage - b.stage || String(a.mon.name || '').localeCompare(String(b.mon.name || '')));
    return members;
}

// picks the family "face" for the card thumbnail/default view: the final
// evolution stage (megas/formes don't count as later), falling back to
// whatever was published if the family is all megas/formes.
function pickFamilyDisplayMember(family) {
    const stagesOnly = family.filter(m => !m.isMega && !m.isFormeChange);
    const pool = stagesOnly.length ? stagesOnly : family;
    return pool.reduce((best, m) => (m.stage > best.stage ? m : best), pool[0]);
}

// small per-member summary embedded on the row so the evo badge
// (renderCommunityEvoBadge) can show "3-Stage"/"Has Mega" without an extra
// fetch. deliberately excludes artwork - family_full below already carries
// that, and duplicating it here was sending the same images 2-3x per publish.
function buildFamilySnapshotsPayload(family) {
    return family.map(({ mon: f, stage, isMega, isFormeChange }: { mon?: any; stage?: any; isMega?: any; isFormeChange?: any }) => ({
        sourceId: String(f.id),
        name: f.name || 'Unnamed',
        number: f.number || '',
        type1: f.type1 || '',
        type2: f.type2 || '',
        stage, isMega, isFormeChange
    }));
}

// full record for every family member, so switching stage/mega/forme in the
// detail view swaps the preview client-side (same post/comments/likes).
// kept out of the slim feed query - loaded via openMonDetail's select('*').
function buildFamilyFullPayload(family) {
    return family.map(({ mon: f, stage, isMega, isFormeChange }: { mon?: any; stage?: any; isMega?: any; isFormeChange?: any }) => ({
        sourceId: String(f.id),
        // each stage embeds its own ability programs so any family member is
        // battle-ready, not just the face.
        mon: withAbilityPrograms(f),
        stage, isMega, isFormeChange
    }));
}

// ==================== publish / unpublish ====================
// publishes a snapshot (not a live link), so private edits/deletes don't
// silently change what's already posted - republish to update it.
async function publishFakemon(fakemonId) {
    if (!state.user) { api.showToast?.('Sign in to publish to the Community Hub.', 'warning'); return; }
    const mon = state.fakemonDB.find(f => String(f.id) === String(fakemonId));
    if (!mon) { api.showToast?.('Could not find that Fakemon.', 'error'); return; }
    await publishSnapshot(mon);
}

// publishes the editor's currently open Fakemon (share dropdown option).
// forces a save first so even an unsaved-new Fakemon publishes correctly.
async function publishCurrentEditorFakemon() {
    if (!state.user) { api.showToast?.('Sign in to publish to the Community Hub.', 'warning'); return; }
    const name = form.name.trim();
    if (!name) { api.showToast?.('Please enter a Pokemon name before publishing!', 'error'); return; }
    await api.autoSave?.(true);
    const mon = state.fakemonDB.find(f => String(f.id) === String(state.editingId));
    if (!mon) { api.showToast?.('Could not find that Fakemon.', 'error'); return; }
    await publishSnapshot(mon);
}

// Mirrors public.mon_text_for_scan() in Postgres - keep both in sync, or the
// pre-check and the trigger will disagree on what's allowed.
function monTextForScreening(payload) {
    const parts: any[] = [];
    const walk = (d) => {
        if (!d || typeof d !== 'object') return;
        parts.push(d.name, d.species, d.dexEntry1, d.dexEntry2, d.artCredit, d.color, d.notes);
        (d.abilities || []).forEach(a => parts.push(a?.name, a?.desc));
        (d.customAbilities || []).forEach(a => parts.push(a?.name, a?.desc));
        (d.learnset || []).forEach(m => parts.push(m?.name, m?.desc));
        (d.sampleSets || []).forEach(sset => parts.push(sset?.name, sset?.notes));
    };
    walk(payload.fakemon_data);
    (payload.family_full || []).forEach(entry => walk(entry?.mon || entry));
    return parts.filter(Boolean).join(' ');
}

// The server resolves each account's cap and cooldown (site defaults plus
// badges; -1 = unlimited) in my_limits(); published_mons_enforce_cooldown()
// is the real enforcement.
function publishLimits() {
    const limits = cloudLimits();
    return {
        max: asCap(limits.communityUploads),
        cooldownSeconds: asCap(limits.publishCooldownSeconds)
    };
}

function describeCooldown(seconds) {
    if (!(seconds > 0) || seconds === Infinity) return '';
    if (seconds % 3600 === 0) { const h = seconds / 3600; return h === 1 ? 'once an hour' : `once every ${h} hours`; }
    if (seconds % 60 === 0) { const m = seconds / 60; return m === 1 ? 'once a minute' : `once every ${m} minutes`; }
    return `once every ${seconds} seconds`;
}

async function publishSnapshot(mon, rulesChecked = false) {
    // show rules on every upload, even if previously accepted.
    if (!rulesChecked) {
        openCommunityRulesModal({ requireAgreement: true, onAccept: () => publishSnapshot(mon, true) });
        return;
    }
    const client = await api.getClient();

    // client-side pre-check for a friendly message and to avoid serializing a
    // full artwork payload the server will refuse anyway. Real enforcement is
    // published_mons_enforce_cooldown() in Postgres; one request covers both
    // the count ceiling and the cooldown.
    const { data: recent, count: publishedCount, error: recentError } = await client
        .from('published_mons')
        .select('published_at', { count: 'exact' })
        .eq('user_id', state.user!.id)
        .order('published_at', { ascending: false })
        .limit(1);
    await refreshCloudLimits();
    const { max, cooldownSeconds } = publishLimits();
    if (!recentError) {
        if ((publishedCount ?? 0) >= max) {
            api.showToast?.(`You have reached the limit of ${max} community uploads. Delete one of your listings to publish something new.`, 'warning');
            return;
        }
        const latest = recent?.[0];
        if (latest && cooldownSeconds > 0 && cooldownSeconds !== Infinity) {
            const elapsedMs = Date.now() - new Date(latest.published_at).getTime();
            const cooldownMs = cooldownSeconds * 1000;
            if (elapsedMs < cooldownMs) {
                const remainingMin = Math.ceil((cooldownMs - elapsedMs) / 60000);
                api.showToast?.(`You can publish again in ${remainingMin} minute${remainingMin === 1 ? '' : 's'}.`, 'warning');
                return;
            }
        }
    }

    // bundle the whole evolution family into one post/row, other stages as
    // embedded snapshots.
    const family = collectEvolutionFamily(mon);
    const isFamily = family.length > 1;
    // diagnostic: family size 1 when evolutions were expected means
    // mon.evolutionGraph or its sibling stages aren't resolving via state.fakemonDB.
    console.info('[COMMUNITY] Publishing', mon.name, '- family size:', family.length, family.map(f => f.mon?.name));

    // the card/default preview always shows the LAST evolution stage, not
    // necessarily whichever mon in the chain was clicked "publish" on.
    const display = isFamily ? pickFamilyDisplayMember(family) : { mon };

    const payload = {
        user_id: state.user!.id,
        author_name: publicName(state.user),
        author_avatar_url: state.user!.avatarUrl || null,
        author_role: state.user!.role || 'user',
        author_badges: state.user!.badges || [],
        source_fakemon_id: String(display.mon.id),
        fakemon_data: await withThumbnail(display.mon),
        evolution_stage: display.stage || display.mon.evolutionStage || 1,
        family_snapshots: isFamily ? buildFamilySnapshotsPayload(family) : [],
        family_full: isFamily ? buildFamilyFullPayload(family) : []
    };
    // scan authored text only (not artwork) - same fields the server-side scan reads.
    if (!(await api.guardContent?.(monTextForScreening(payload), 'published Fakemon') ?? true)) return;

    const { data: published, error } = await client.from('published_mons').insert(payload).select('id').single();
    if (error) {
        log.error('COMMUNITY', 'Publish failed', error);
        // the trigger raises cooldown/ceiling errors (42501) with a user-facing
        // message already attached - show that instead of guessing which limit
        // hit. a bare RLS rejection has no such message, hence the generic fallback.
        const serverMessage = /publish|community uploads/i.test(error.message) ? error.message : '';
        const friendly = serverMessage
            || (/row-level security|permission denied/i.test(error.message)
                ? 'You are not allowed to publish that right now.'
                : ('Publish failed: ' + error.message));
        api.showToast?.(friendly, 'error');
        return;
    }
    const copied = published?.id ? await copyCommunityShareLink(published.id, true) : false;
    const extra = isFamily ? ` (with its ${family.length - 1} other evolution stage${family.length - 1 === 1 ? '' : 's'})` : '';
    api.showToast?.(`${mon.name} published to the Community Hub!${extra}${copied ? ' Share link copied.' : ''}`, 'success');
    log.info('COMMUNITY', 'Published', { id: published?.id, name: mon.name, familySize: family.length });
    // feed and profile gallery changed - invalidate caches.
    ensureCommunityState().fetchedAt = 0;
    api.invalidateProfile?.(state.user?.id);
}


// pushes updates to an existing listing (same row/comments) instead of a new
// post. skips the hourly cooldown since this edits something already live.
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

    // re-walk the graph from the newly selected mon so the bundled family stays current.
    const family = collectEvolutionFamily(mon);
    const isFamily = family.length > 1;
    // unlike publishSnapshot, skip pickFamilyDisplayMember - the update modal
    // lets the user explicitly choose the display member; overriding that made
    // picking a mon look like it did nothing.
    const selfEntry = family.find(f => String(f.mon.id) === String(mon.id)) || { mon };

    const payload = {
        author_name: publicName(state.user),
        author_avatar_url: state.user.avatarUrl || null,
        author_role: state.user.role || 'user',
        author_badges: state.user.badges || [],
        fakemon_data: await withThumbnail(mon),
        source_fakemon_id: String(mon.id),
        evolution_stage: selfEntry.stage || mon.evolutionStage || 1,
        family_snapshots: isFamily ? buildFamilySnapshotsPayload(family) : [],
        family_full: isFamily ? buildFamilyFullPayload(family) : []
    };
    if (!(await api.guardContent?.(monTextForScreening(payload), 'published Fakemon') ?? true)) return;

    // request the row back - RLS filtering an update to zero rows is a silent
    // success in PostgREST, not an error, so without this a missing policy
    // would look like a working save.
    const { data: saved, error } = await client
        .from('published_mons')
        .update(payload)
        .eq('id', publishedId)
        .select('id');
    if (error) {
        log.error('COMMUNITY', 'Update listing failed', error);
        const friendly = api.friendlyModerationError?.(error);
        api.showToast?.(friendly || ('Could not update the listing: ' + error.message), 'error');
        return;
    }
    if (!saved?.length) {
        log.error('COMMUNITY', 'Update listing changed no rows', { id: publishedId });
        api.showToast?.('That listing could not be updated. It may have been removed, or you may not own it any more.', 'error');
        return;
    }

    // Same id, new artwork: both the disk cache and the "already fetched in
    // full" flag are now describing the previous version of this post.
    dropCachedArt(publishedId);
    artworkCache.delete(publishedId);
    const staleIdx = ensureCommunityState().mons.findIndex(m => m.id === publishedId);
    if (staleIdx !== -1) delete ensureCommunityState().mons[staleIdx].__full;

    closeCommunityUpdateModal();
    api.showToast?.(`${mon.name}'s Community Hub listing was updated!`, 'success');
    log.info('COMMUNITY', 'Updated published listing', { id: publishedId, name: mon.name });
    api.invalidateProfile?.(state.user?.id);

    const cs = ensureCommunityState();
    const idx = (cs.mons || []).findIndex(m => m.id === publishedId);
    // merge onto the cached row, don't replace it - like_count/comment_count/
    // liked_by_me are client-attached, not columns, so a server-only rebuild
    // would blank those counters until the next feed fetch.
    const updatedRow = { ...(idx !== -1 ? cs.mons[idx] : {}), ...row, ...payload };
    // re-fetched on next open: the row above predates the update, and the
    // guard trigger rewrites author_role/author_badges on the way in.
    delete updatedRow.__full;
    if (idx !== -1) cs.mons[idx] = updatedRow;
    if (cs.openMonId === publishedId) {
        cs.openMonRow = updatedRow;
        await openMonDetail(publishedId);
    } else {
        renderCommunityGrid();
    }
}

// One picker, two jobs (js/app/dialogs/community.tsx): publish a new listing,
// or replace an existing one with another of your Fakemon.
function openCommunityPicker(mode, targetId, preselectId) {
    const collection = (Array.isArray(state.fakemonDB) ? state.fakemonDB : []).filter(f => !f.pendingVanilla);
    if (!collection.length) {
        api.showToast?.('You need at least one Fakémon in your collection first.', 'warning');
        return;
    }
    openDialog('community-picker', { mode: mode === 'publish' ? 'publish' : 'update', targetId: targetId || null, preselectId: preselectId || '' });
}

// Publish from inside the hub instead of via the collection's share menu.
function openCommunityPublishModal() {
    if (!state.user) { api.showToast?.('Sign in to publish to the community hub.', 'warning'); return; }
    openCommunityPicker('publish', null, '');
}

// The open detail page's "update listing" button.
function openCommunityUpdateModal() {
    const row = ensureCommunityState().openMonRow;
    if (!row || !state.user || row.user_id !== state.user.id) return;
    openCommunityPicker('update', row.id, row.source_fakemon_id);
}

// The my-uploads list, where there is no open detail row to read from.
function openCommunityUpdateModalFor(publishedId) {
    const row = (ensureCommunityState().mons || []).find(r => String(r.id) === String(publishedId));
    if (!row || !state.user || row.user_id !== state.user.id) return;
    openCommunityPicker('update', row.id, row.source_fakemon_id);
}

function closeCommunityUpdateModal() { closeDialog('community-picker'); }

function updateOpenCommunityMon() {
    openCommunityUpdateModal();
}

async function openPublishedMonById(publishedId, options: Record<string, any> = {}) {
    // Shared links land here - hold the link, sign the visitor in, then open
    // the Fakemon they came for.
    if (!api.requireAccount?.('Sign in to view this Fakemon.',
        () => openPublishedMonById(publishedId, options))) return false;
    const data = await fetchMonDetailRow(publishedId);
    if (!data) { api.showToast?.('Could not load that Fakemon.', 'error'); return false; }
    const cs = ensureCommunityState();
    cs.mons = [data, ...(cs.mons || []).filter(x => x.id !== data.id)];
    await attachLiveAuthorInfo(cs.mons);
    await openMonDetail(publishedId, options);
    return true;
}

// owners unpublish their own mon; staff can remove any as moderation (RLS
// allows is_staff() to delete any row). same guard pattern as deleteComment.
async function unpublishMon(publishedId, event?) {
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
        // viewing the mon we just unpublished - return to the grid instead of
        // a blank screen. openCommunityHub() clears isCommunityPreview itself.
        cs.openMonId = null;
        cs.openMonRow = null;
        await openCommunityHub();
        return;
    }
    // the author's profile gallery just changed too
    api.invalidateProfile?.(state.user?.id);
    await fetchCommunityFeed({ force: true });
    notify();
}

// wrapper for the detail page's unpublish button - inline onclick handlers
// only have access to functions on `api`/`window`, not module-scoped `state`.
function unpublishOpenCommunityMon() {
    const cs = ensureCommunityState();
    if (cs.openMonId) unpublishMon(cs.openMonId);
}
// ==================== community share routes ====================
// /community/<id>. Used to be #community/<id>; old links still work via
// migrateLegacyHash() in js/core/router.ts.

function communityShareUrl(publishedId) {
    return routeUrl(`community/${encodeURIComponent(String(publishedId))}`);
}

function copyOpenCommunityShareLink() { return copyCommunityShareLink(ensureCommunityState().openMonId); }

async function copyCommunityShareLink(publishedId, silent = false) {
    if (!publishedId) return false;
    const url = communityShareUrl(publishedId);
    try {
        await navigator.clipboard.writeText(url);
        if (!silent) api.showToast?.('Community share link copied!', 'success');
        return true;
    } catch (_: any) {
        if (!silent) window.prompt('Copy this Community share link:', url);
        return false;
    }
}

// Called when leaving a post. The page opened next sets its own address as a
// new history entry, so the post's stays behind for Back.
function exitCommunityRoute() {}

/**
 * Opens the Fakemon a /community/<id> URL names. The caller has already parsed
 * the route, so this takes the id rather than reading the address bar.
 * @param publishedId
 * @returns whether it opened
 */
async function handleCommunityRoute(publishedId: string): Promise<boolean> {
    const id = String(publishedId || '').trim();
    if (!id) return false;
    return await openPublishedMonById(id, { preserveRoute: true });
}

// ==================== feed ====================
// the grid only needs name/types/thumbnail up front; fakemon_data also carries
// shiny art, cry audio, learnset, sample sets and evolution graph (hundreds of
// kb), which pulled for every row of a 100-row feed was the biggest source of
// Supabase egress in the app. openMonDetail() fetches the full row on demand.
// how long a loaded feed is reused before refetching. avoids re-running the
// full feed+stats query on every hub<->profile bounce; a minute balances
// freshness against cost.
const FEED_MAX_AGE_MS = 60000;

function feedIsFresh() {
    const cs = ensureCommunityState();
    return cs.mons?.length > 0 && Date.now() - (cs.fetchedAt || 0) < FEED_MAX_AGE_MS;
}

/**
 * @param {{force?: boolean}} [options] force skips the freshness check; pass it
 *        after anything that changes the feed (publish, unpublish, like, comment)
 */
async function fetchCommunityFeed(options: Record<string, any> = {}) {
    const cs = ensureCommunityState();
    if (!options.force && feedIsFresh()) {
        log.debug('COMMUNITY', 'Feed still fresh; not re-fetching');
        return;
    }
    cs.loading = true;
    try {
        const client = await api.getClient();
        const { data, error } = await client
            .from('published_mons')
            // no thumbnail here any more: a thumbnail is an image, and an
            // image in this response is an image in the network panel. Cards
            // ask community_mon_artwork() for a masked one instead.
            .select('id, user_id, published_at, activity_at, view_count, source_fakemon_id, author_name, author_avatar_url, author_role, author_badges, family_snapshots, evolution_stage, fakemon_data->>name, fakemon_data->>species, fakemon_data->>number, fakemon_data->>type1, fakemon_data->>type2')
            .order('activity_at', { ascending: false })
            .limit(100);
        if (error) throw error;
        cs.mons = await attachLiveAuthorInfo((data || []).map(unflattenSlimMonRow));
        // fill in cached artwork before the grid renders so return visits paint
        // from disk with no requests. awaited: it's a local read; painting
        // first would still fire the network queue for the same images.
        await warmArtworkCache(cs.mons);
        await hydrateCommunityStats(cs.mons);
        cs.fetchedAt = Date.now();
        log.info('COMMUNITY', 'Feed loaded', { count: cs.mons.length });
    } catch (e: any) {
        log.error('COMMUNITY', 'Feed load failed', e);
        api.showToast?.('Could not load the Community Hub.', 'error');
        cs.mons = [];
        cs.fetchedAt = 0;
    } finally {
        cs.loading = false;
    }
}

// PostgREST's `column->>key` selector flattens jsonb keys to top-level
// columns, but every renderer expects row.fakemon_data.name etc. - rebuild
// that shape and drop the flat columns so a slim row isn't mistaken for a full one.
function unflattenSlimMonRow(row) {
    const { name, species, number, type1, type2, ...rest } = row;
    // every image is deliberately absent from the feed query -- a card asks
    // for a masked one on scroll, and artworkCache is where that lands.
    return { ...rest, fakemon_data: { name, species, number, type1, type2, artwork: artworkCache.get(row.id) || '' } };
}

// ==================== community stats ====================
// like/comment/view counts per card. used to fetch every like/comment row and
// count with .length - proportional to total engagement, not posts on screen.
// community_mon_stats() returns one small row per post instead.
let statsRpcMissing = false;

async function hydrateCommunityStats(rows) {
    if (!rows.length) return rows;
    const client = await api.getClient();
    const ids = rows.map(r => r.id).filter(Boolean);

    let stats: any = null;
    const { data, error } = statsRpcMissing
        ? { data: null as any, error: { message: 'community_mon_stats is not installed' } }
        : await client.rpc('community_mon_stats', { p_ids: ids });
    if (error) {
        // a cached client can outlive a rolled-back migration; fall back to
        // slower client-side counting rather than showing no numbers. latched
        // for the session so a missing RPC doesn't add a guaranteed-404 on
        // every hub load.
        if (!statsRpcMissing) log.warn('COMMUNITY', 'community_mon_stats unavailable; counting client-side', error);
        statsRpcMissing = true;
        stats = await countStatsClientSide(client, ids);
    } else {
        stats = new Map<any, any>((data || []).map(r => [r.mon_id, {
            like_count: Number(r.like_count || 0),
            comment_count: Number(r.comment_count || 0),
            liked_by_me: !!r.liked_by_me
        }]));
    }

    rows.forEach(r => {
        const s = stats.get(r.id);
        r.comment_count = s?.comment_count || 0;
        r.like_count = s?.like_count || 0;
        r.liked_by_me = !!s?.liked_by_me;
        r.view_count = Number(r.view_count || 0);
    });
    return rows;
}

// The pre-RPC path, kept only as the fallback above.
async function countStatsClientSide(client, ids) {
    const [{ data: comments }, { data: likes }] = await Promise.all([
        client.from('mon_comments').select('mon_id').in('mon_id', ids),
        client.from('mon_likes').select('mon_id, user_id').in('mon_id', ids)
    ]);
    const stats = new Map<any, any>(ids.map(id => [id, { like_count: 0, comment_count: 0, liked_by_me: false }]));
    (comments || []).forEach(r => { const s = stats.get(r.mon_id); if (s) s.comment_count++; });
    (likes || []).forEach(r => {
        const s = stats.get(r.mon_id);
        if (!s) return;
        s.like_count++;
        if (state.user && r.user_id === state.user.id) s.liked_by_me = true;
    });
    return stats;
}

async function toggleCommunityLike(publishedId, event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!state.user) { api.showToast?.('Sign in to like Fakemon.', 'warning'); return; }
    const client = await api.getClient();
    const cs = ensureCommunityState();
    // A detail page reached from a share link never went through the feed, so
    // the row is not in cs.mons. openMonRow is the one that is always there.
    const row = cs.mons.find(r => r.id === publishedId)
        || (cs.openMonId === publishedId ? cs.openMonRow : null);
    const liked = !!row?.liked_by_me;
    if (liked) {
        const { error } = await client.from('mon_likes').delete().eq('mon_id', publishedId).eq('user_id', state.user.id);
        if (error) { api.showToast?.('Could not remove like: ' + error.message, 'error'); return; }
    } else {
        const { error } = await client.from('mon_likes').insert({ mon_id: publishedId, user_id: state.user.id });
        if (error) { api.showToast?.('Could not like this Fakemon: ' + error.message, 'error'); return; }
    }
    // the feed row and the open post's row may be one object or two
    for (const r of new Set([row, cs.openMonId === publishedId ? cs.openMonRow : null].filter(Boolean))) {
        r.liked_by_me = !liked;
        r.like_count = Math.max(0, Number(r.like_count || 0) + (liked ? -1 : 1));
    }
    notify();
}

// the detail page's stat strip reads the open row; this re-renders it
function renderCommunityDetailStats() {
    notify();
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
        cs.commentsLoaded = true;
    } catch (e: any) {
        log.error('COMMUNITY', 'Comments load failed', e);
        cs.comments = [];
        // a failed load isn't zero comments - count falls back to the
        // listing's stored value.
        cs.commentsLoaded = false;
    }
}

/** @returns whether the comment was posted */
async function postComment(publishedId, body): Promise<boolean> {
    if (!state.user) { api.showToast?.('Sign in to comment.', 'warning'); return false; }
    const text = String(body || '').trim();
    if (!text) return false;
    if (text.length > 1000) { api.showToast?.('Comments are limited to 1000 characters.', 'warning'); return false; }

    // blocklist scan + standing check; also records infractions and escalates
    // repeat offenders, so it must run before insert (the trigger can only refuse).
    if (!(await api.guardContent?.(text, 'mon comment') ?? true)) return false;

    const client = await api.getClient();
    const payload = {
        mon_id: publishedId,
        user_id: state.user!.id,
        author_name: publicName(state.user),
        author_avatar_url: state.user!.avatarUrl || null,
        author_role: state.user!.role || 'user',
        author_badges: state.user!.badges || [],
        body: text
    };
    const { error } = await client.from('mon_comments').insert(payload);
    if (error) {
        log.error('COMMUNITY', 'Comment failed', error);
        const friendly = api.friendlyModerationError?.(error);
        api.showToast?.(friendly || ('Comment failed: ' + error.message), 'error');
        return false;
    }
    await fetchComments(publishedId);
    notify();

    // notify the mon's owner (unless commenting on their own). openMonRow is
    // reliably set while the comment box is visible, so no extra fetch needed.
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
    return true;
}

// staff can delete any comment, others only their own. guard dropped for
// staff since RLS already allows is_staff() - filtering by user_id too would
// silently no-op staff deletes.
async function deleteComment(commentId, publishedId) {
    if (!state.user) return;
    const client = await api.getClient();
    let query = client.from('mon_comments').delete().eq('id', commentId);
    if (!api.isStaff?.()) query = query.eq('user_id', state.user.id);
    const { error } = await query;
    if (error) { api.showToast?.('Could not delete comment: ' + error.message, 'error'); return; }
    await fetchComments(publishedId);
    notify();
}

// ==================== UI: hub view ====================
// ==================== community rules ====================
const COMMUNITY_RULES_KEY = 'woogidex-community-rules-v2';
let communityRulesPendingAction: any = null;

function hasAcceptedCommunityRules() {
    try { return localStorage.getItem(COMMUNITY_RULES_KEY) === 'accepted'; } catch { return false; }
}

/** The rules dialog (js/app/dialogs/community.tsx); onAccept runs once they're agreed to. */
function openCommunityRulesModal({ requireAgreement = false, onAccept = null }: { requireAgreement?: any; onAccept?: any } = {}) {
    openDialog('community-rules', { requireAgreement, onAccept: typeof onAccept === 'function' ? onAccept : null });
}

function closeCommunityRulesModal() {
    closeDialog('community-rules');
}

function markCommunityRulesAccepted() {
    try { localStorage.setItem(COMMUNITY_RULES_KEY, 'accepted'); } catch {}
}

async function openCommunityHub({ panel = null }: { panel?: any } = {}) {
    // RLS refuses published_mons to anonymous callers - without this the hub
    // would render an empty grid instead of looking closed.
    if (!api.requireAccount?.('Sign in to browse the Community Hub.', openCommunityHub)) return;
    exitCommunityRoute();
    // leaving a preview is navigation, not a save - mirrors showCollection()'s
    // handling of shared-link previews. without this guard, force-saving here
    // would silently import the previewed community mon into the user's collection.
    const wasCommunityPreview = !!state.isCommunityPreview;
    state.isCommunityPreview = false;

    // community pages aren't an editor session. discard the preview-only
    // editor identity so it can't become a real save target; only a visible
    // editor autosaves.
    if (wasCommunityPreview) {
        if (state.autoSaveTimer) {
            clearTimeout(state.autoSaveTimer);
            state.autoSaveTimer = null;
        }
        state.editingId = null;
    } else if (document.getElementById('editor-view')?.style.display !== 'none') {
        await api.autoSave?.(true);
    }

    api.exitProfileRoute?.();

    api.activateTopLevelView?.('community-view');
    api.setRoute?.('community', 'Community Hub');

    if (!hasAcceptedCommunityRules()) {
        openCommunityRulesModal({ requireAgreement: false });
    }

    // Coming back to a feed we already have: paint it, don't flash a skeleton
    // at someone for a grid that is about to look exactly as they left it.
    const cs = ensureCommunityState();
    setCommunityPanel(panel || cs.panel || 'landing');
    // The events panel loads from its own tables, not the feed, so it is
    // painted here rather than waiting on fetchCommunityFeed() below.
    if (cs.panel === 'events') api.showEventsPanel?.();
    if (feedIsFresh()) { paintCommunityPanels(); return; }

    // Mark the feed loading BEFORE the first paint. paintCommunityPanels()
    // renders the grid from cs.loading, so painting a skeleton and then
    // calling it here drew the skeleton, replaced it with an empty grid, and
    // only then filled it in - three passes and a visible flash of "nothing
    // published" where one pass would do.
    cs.loading = true;
    paintCommunityPanels();

    // guard against a slower, earlier fetch resolving after a newer one and
    // clobbering the grid with stale data (e.g. rapid back-and-forth clicks).
    const requestToken = Symbol('community-fetch');
    cs.latestFetchToken = requestToken;
    try {
        await fetchCommunityFeed();
    } finally {
        cs.loading = false;
    }
    if (cs.latestFetchToken === requestToken) paintCommunityPanels();
}

function closeCommunityHub() {
    api.showCollection?.();
}

import { publicName } from '../core/html.ts';
import { routeUrl, navigateRoute } from '../core/router.ts';
import { form } from '../editor/draft.ts';

const COMMUNITY_SORT_KEY = 'woogidex.community.sort.v2';
const COMMUNITY_LAYOUT_KEY = 'woogidex.community.layout.v1';
let communityLayout = (() => {
    try { return localStorage.getItem(COMMUNITY_LAYOUT_KEY) === 'list' ? 'list' : 'grid'; }
    catch { return 'grid'; }
})();

function communityLayoutMode() {
    return communityLayout;
}

function applyCommunityLayoutUI() {
    notify();
}

function toggleCommunityLayout() {
    communityLayout = communityLayout === 'list' ? 'grid' : 'list';
    try { localStorage.setItem(COMMUNITY_LAYOUT_KEY, communityLayout); } catch {}
    notify();
}

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

function changeCommunitySort(sortBy, sortOrder) {
    const cs = ensureCommunityState();
    cs.sortBy = sortBy || 'activity';
    cs.sortOrder = sortOrder === 'asc' ? 'asc' : 'desc';
    try { localStorage.setItem(COMMUNITY_SORT_KEY, JSON.stringify({ sortBy: cs.sortBy, sortOrder: cs.sortOrder })); } catch {}
    notify();
}

function filterCommunity(search) {
    ensureCommunityState().search = String(search ?? '');
    notify();
}

// The pages (js/app/pages/CommunityPage.tsx, CommunityDetailPage.tsx) draw
// state.community; these tell them to.
function renderCommunityGridSkeleton() {
    ensureCommunityState().loading = true;
    notify();
}

function renderCommunityGrid() {
    notify();
}

// ==================== the hub landing page ====================
// replaces the old "search bar over every Fakemon" default view, which gave
// no answer to "what's worth seeing today". full listing is one button away.

// four panels, one route. active panel is remembered on community state so
// returning from a detail page doesn't reset to landing.
const COMMUNITY_PANELS = {
    landing: { title: 'Community hub' },
    browse:  { title: 'Browse Fakemon' },
    events:  { title: 'Events and contests' },
    uploads: { title: 'My uploads' }
};

// The contest shelf on the landing panel needs events data the events panel
// used to own. Fetched once per page life rather than once per paint: this
// used to fire on every call to paintCommunityPanels() and repaint the landing
// again each time it resolved, which is most of why opening the hub painted
// itself four or five times over.
let contestFetch: any = null;
function ensureContestData() {
    // no contests means no shelf, so a failure here is not worth reporting
    contestFetch ||= Promise.resolve(api.fetchEvents?.()).catch(() => {});
    return contestFetch;
}

// paint all three feed-backed panels together - they all read cs.mons, and
// repainting hidden ones costs nothing.
function paintCommunityPanels() {
    ensureContestData();
    renderCommunityUploads();
    notify();
}

function setCommunityPanel(panel) {
    const cs = ensureCommunityState();
    cs.panel = COMMUNITY_PANELS[panel] ? panel : 'landing';
    api.setPageTitle?.(COMMUNITY_PANELS[cs.panel].title);
    notify();
}

/**
 * Switches panel and paints it. Each panel owns what it needs to fetch, so
 * this is the one place that knows the mapping.
 */
function showCommunityPanel(panel) {
    setCommunityPanel(panel);
    const cs = ensureCommunityState();
    if (cs.panel === 'events') api.showEventsPanel?.();
    else if (cs.panel === 'uploads') renderCommunityUploads();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Kept as named entry points because the landing markup and the old call
// sites read better than showCommunityPanel('...') does inline.
function showCommunityLanding() { showCommunityPanel('landing'); }
function browseCommunityFakemon() { showCommunityPanel('browse'); }

// ==================== my uploads ====================
// publishing used to mean leaving the hub for the collection page's share
// menu. this panel is both the list of live uploads and where you add to it.
// Limits are fetched once per signed-in account; until then the meter shows
// the site defaults, which would read "20" to someone with no cap at all.
let uploadLimitsLoadedFor: any = null;
function renderCommunityUploads() {
    // the meter needs this account's real limits, fetched once per account
    if (state.user && uploadLimitsLoadedFor !== state.user.id) {
        uploadLimitsLoadedFor = state.user.id;
        refreshCloudLimits().then(notify).catch(() => {});
    }
    notify();
}

// ==================== weekly rotation ====================
// "Featured this week" must be the same set for everyone with no server
// scheduler (no cron here). derived instead: a seeded shuffle keyed to the
// ISO week, so it's deterministic per-week with nothing to run or sync.
function isoWeekKey(date = new Date()) {
    // ISO weeks start Monday, belong to their Thursday's year. done by hand
    // (not locale) so the key is identical for every visitor -- which means
    // reading the date in UTC too, not in whatever zone the visitor is in.
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = d.getUTCDay() || 7;               // Sunday counts as 7
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);       // move to this week's Thursday
    const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
    const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${week}`;
}

function seedFrom(text) {
    // FNV-1a. Any cheap avalanche would do; the requirement is only that one
    // week's key does not produce an ordering recognisably like the next.
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

// Scores each row on its own, from its id and the week, and takes the best
// `count`. The seed alone used to drive a Fisher-Yates shuffle of the whole
// pool, which made the result depend on how many rows were in it: publishing
// one new Fakemon shifted every index and dealt a completely different
// "Featured this week", so on any day something was published the shelf reset.
// A per-row score has no such coupling -- the same row scores the same all
// week no matter what else is in the hub.
function seededPick(rows, count, seedText) {
    return [...rows]
        .map(row => ({ row, score: seedFrom(`${seedText}:${row.id}`) }))
        // id breaks ties so two rows that hash alike still order consistently
        .sort((a, b) => a.score - b.score || String(a.row.id).localeCompare(String(b.row.id)))
        .slice(0, count)
        .map(entry => entry.row);
}

/** The same rotating pick for every visitor, all week (see seededPick). */
function featuredThisWeek(rows, count) {
    return seededPick(rows || [], count, isoWeekKey());
}

function renderCommunityLanding() {
    notify();
}

// ==================== card thumbnails ====================
// artwork averages ~176 kB; cards only need thumbnail size, so publish/update
// also stores a downscaled fakemon_data.thumbnail (~5 kB) for the feed to use.
// additional copy, not a replacement - the full-res original stays the post's
// real artwork (see js/core/art-shield.ts on what protecting it can't mean).
// rows from before this existed have no thumbnail and fall through to
// observeCardArtwork()'s lazy path.
const THUMB_MAX_PX = 160;

async function withThumbnail(mon) {
    return { ...withAbilityPrograms(mon), thumbnail: await makeThumbnail(mon?.artwork) };
}

// a Fakemon names its custom abilities but doesn't contain them - the block
// program lives in the author's private library (state.customAbilities). so
// publishing embeds just the referenced entries, letting the battle sim
// actually run someone else's ability (see toPeerPackage in battle/teams.ts).
// matched by customId, falling back to name for pre-customId saves.
function embeddedCustomAbilities(mon) {
    const lib = state.customAbilities || [];
    const out = new Map();
    (mon?.abilities || []).forEach(a => {
        if (!a || !(a.source === 'custom' || a.custom === true)) return;
        const entry = (a.customId && lib.find(x => String(x.id) === String(a.customId)))
            || lib.find(x => String(x.name || '').toLowerCase() === String(a.name || '').toLowerCase());
        if (!entry || out.has(entry.id)) return;
        out.set(entry.id, {
            id: entry.id,
            name: entry.name || a.name,
            desc: entry.desc || a.desc || '',
            blocks: entry.blocks ? JSON.parse(JSON.stringify(entry.blocks)) : null
        });
    });
    return [...out.values()];
}

function withAbilityPrograms(mon) {
    if (!mon) return mon;
    const customAbilities = embeddedCustomAbilities(mon);
    return customAbilities.length ? { ...mon, customAbilities } : mon;
}

async function makeThumbnail(dataUri) {
    if (!String(dataUri || '')) return '';
    // An animated image cannot survive this: drawImage paints exactly one
    // frame, so a GIF would get a still thumbnail on its card and only move
    // once the post was opened. Leaving it without one puts the card on the
    // lazy path, which loads and plays the real thing.
    if (await frameCount(dataUri) > 1) {
        log.debug('COMMUNITY', 'Animated artwork gets no thumbnail; the card loads the real image');
        return '';
    }
    try {
        const blob = await artworkBlob(dataUri);
        if (!blob) return '';
        const bitmap = await createImageBitmap(blob);
        const scale = Math.min(1, THUMB_MAX_PX / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
        // Browsers that cannot encode webp silently return a png here, which at
        // 160px is still small enough to be worth it.
        return canvas.toDataURL('image/webp', 0.75);
    } catch (e: any) {
        log.warn('COMMUNITY', 'Thumbnail generation failed; card will lazy-load full art', e);
        return '';
    }
}

// ==================== lazy card artwork ====================
// selecting artwork (~176 kB/mon) with the feed meant every hub visit
// downloaded every image up front, most below the fold and never viewed.
// cards now paint with a placeholder and fetch artwork only on scroll into
// view, batched per frame and cached for the rest of the session.
const artworkCache = new Map();      // published mon id -> data URI ('' = no artwork)
let artworkObserver: any = null;
const artworkQueue = new Set<string>();
let artworkFlush: any = null;

// warms the in-memory cache from disk so observers/CardArt find a synchronous
// hit instead of re-requesting already-downloaded artwork.
async function warmArtworkCache(rows) {
    const ids = (rows || []).map(r => r?.id).filter(id => id && !artworkCache.has(id));
    if (!ids.length) return;
    const found = await getCachedArtBatch(ids);
    for (const [id, art] of found) {
        artworkCache.set(id, art);
        paintArtwork(id, art);
        settleArtwork(id, art);
    }
    if (found.size) log.debug('COMMUNITY', 'Artwork served from disk cache', { count: found.size });
}

// React feed awaits artwork rather than having it patched in later; this just
// wraps the existing batching in a promise.
const artworkWaiters = new Map();    // published mon id -> [resolve, ...]

function requestCardArtwork(id) {
    if (!id) return Promise.resolve('');
    const cached = artworkCache.get(id);
    if (cached !== undefined) return Promise.resolve(cached);
    return new Promise(resolve => {
        if (!artworkWaiters.has(id)) artworkWaiters.set(id, []);
        artworkWaiters.get(id).push(resolve);
        // Disk first. A hit settles the waiter without a request at all; a
        // miss falls through to the batched network queue.
        getCachedArt(id).then(art => {
            if (art === null) return queueArtwork(id);
            artworkCache.set(id, art);
            paintArtwork(id, art);
            settleArtwork(id, art);
        }).catch(() => queueArtwork(id));
    });
}

// settles and forgets everyone waiting on this id, including ids the query
// didn't return - an unresolved waiter is a card stuck on a placeholder forever.
function settleArtwork(id, art) {
    const waiters = artworkWaiters.get(id);
    if (!waiters) return;
    artworkWaiters.delete(id);
    for (const resolve of waiters) resolve(art);
}

function queueArtwork(id) {
    if (!id || artworkCache.has(id)) return;
    artworkQueue.add(id);
    // Coalesce a burst of intersections (a fast scroll, or the initial paint)
    // into a single round trip instead of one request per card.
    artworkFlush ||= setTimeout(flushArtworkQueue, 50);
}

async function flushArtworkQueue() {
    artworkFlush = null;
    const ids: string[] = [...artworkQueue];
    artworkQueue.clear();
    if (!ids.length) return;
    try {
        const client = await api.getClient();
        // Was `select('id, fakemon_data->>artwork')`, which put the whole image
        // in the response as readable base64. The RPC returns it encrypted and
        // picks the stored thumbnail over the full image the way the cards
        // used to themselves.
        const { data, error } = await client.rpc('community_mon_artwork', { p_ids: ids });
        if (error) throw error;
        for (const row of data || []) {
            const art = maskedArtwork(row.image);
            artworkCache.set(row.mon_id, art);
            // Written through to disk so the next visit costs nothing. Not
            // awaited: painting must not wait on storage. The masked form is
            // what gets cached; it decrypts for as long as it is kept.
            putCachedArt(row.mon_id, art);
            paintArtwork(row.mon_id, art);
            settleArtwork(row.mon_id, art);
            // is_thumb false means the post had no small version and this is
            // the full image, which is exactly when a backfill is worth doing
            if (!row.is_thumb) backfillThumbnail(row.mon_id, art);
        }
        // Anything the query did not return still gets a cache entry, so a
        // deleted or unreadable row is not re-requested on every scroll.
        for (const id of ids) if (!artworkCache.has(id)) { artworkCache.set(id, ''); putCachedArt(id, ''); }
        for (const id of ids) settleArtwork(id, artworkCache.get(id) || '');
    } catch (e: any) {
        log.warn('COMMUNITY', 'Card artwork failed to load', e);
        for (const id of ids) artworkQueue.delete(id);   // let a later scroll retry
        // Resolve rather than reject: a card that could not load its artwork
        // keeps its placeholder, which is what it was already showing.
        for (const id of ids) settleArtwork(id, '');
    }
}

// ==================== thumbnail backfill ====================
// posts published before thumbnails existed cost every viewer the full image
// to render a 160px card. this is the moment the image is already decoded, so
// making the small version is nearly free; sent back only by the author/staff
// (RLS), others get it fixed when the author next browses the hub. the RPC
// refuses to overwrite an existing thumbnail, so concurrent writers don't fight.
// fire-and-forget - nothing on screen depends on it.
const thumbnailBackfillTried = new Set();

async function backfillThumbnail(id, art) {
    if (!id || !art || thumbnailBackfillTried.has(id)) return;
    if (!state.user) return;
    const row = ensureCommunityState().mons.find(m => m.id === id);
    if (!row) return;
    // whether a thumbnail already exists is the caller's to know now (the RPC
    // reports it); the feed row no longer carries one to check
    const mine = row.user_id === state.user.id;
    if (!mine && !api.isStaff?.()) return;

    thumbnailBackfillTried.add(id);
    try {
        const thumb = await makeThumbnail(art);
        if (!thumb) return;
        const client = await api.getClient();
        const { error } = await client.rpc('set_mon_thumbnail', { p_id: id, p_thumb: thumb });
        if (error) throw error;
        if (row.fakemon_data) row.fakemon_data.thumbnail = thumb;
        log.info('COMMUNITY', 'Backfilled a missing card thumbnail', { id });
    } catch (e: any) {
        log.debug('COMMUNITY', 'Thumbnail backfill skipped', { id, error: String(e?.message || e) });
    }
}

function paintArtwork(id, art) {
    if (!art) return;                                   // keep the placeholder
    // update the model before looking for a DOM slot - warmArtworkCache() runs
    // before the grid exists; an early return here would lose art the cache
    // already had.
    const row = ensureCommunityState().mons.find(m => m.id === id);
    if (row?.fakemon_data) row.fakemon_data.artwork = art;
}

// ==================== UI: detail page ("warp" like the share page) ====================
// view counting calls increment_published_mon_view(p_published_id) in
// Supabase (single-arg signature, confirmed via a PostgREST 404 hint). to add
// per-visitor dedup, add a published_mon_views table and a 2-arg RPC version.
// renders a Fakemon snapshot into the read-only community preview board.
// shared by openMonDetail (first load) and switchCommunityPreviewMon
// (clicking an evolution/mega/forme chip) so both stay in sync.
async function renderCommunityPreviewBoard(mon, row) {
    if (state.autoSaveTimer) { clearTimeout(state.autoSaveTimer); state.autoSaveTimer = null; }
    state.isCommunityPreview = true;
    state.editingId = null;
    // The board is a copy of the editor's, which renders artwork as an <img>
    // and so needs a URL. Decoded here, in memory: this never touches the
    // network, and it is the only place masked artwork is turned back.
    api.loadFakemonIntoEditor({
        ...mon,
        artwork: await artworkDataUri(mon.artwork),
        shinyArtwork: await artworkDataUri(mon.shinyArtwork)
    });
    // the page draws the board from the editor's state (CommunityDetailPage.tsx)
    ensureCommunityState().boardFor = row?.id ?? null;
    api.setPageTitle?.(mon.name ? `${mon.name} (Community)` : 'Community Hub');
    notify();
}

// clicking a stage/mega/forme chip swaps the preview board to that mon - same
// post/comments/likes/views underneath.
function switchCommunityPreviewMon(sourceId) {
    const cs = ensureCommunityState();
    const row = cs.openMonRow;
    const entry = (row?.family_full || []).find(m => m.sourceId === String(sourceId));
    if (!entry || cs.openMonActiveSourceId === String(sourceId)) return;
    cs.openMonActiveSourceId = String(sourceId);
    renderCommunityPreviewBoard(entry.mon, row);   // fire and forget: nothing below waits on the board
}

// The full post, minus every picture, plus the pictures back in masked form.
//
// This was `select('*')`, the single largest readable image payload on the
// site: full artwork and shinies for a whole evolution family, sitting in one
// response body. community_mon_detail() strips the image keys server-side and
// community_mon_images() returns them encrypted, so the row arrives whole but
// nothing in it is a viewable image.
async function fetchMonDetailRow(publishedId) {
    const client = await api.getClient();
    const [detail, images] = await Promise.all([
        client.rpc('community_mon_detail', { p_id: publishedId }),
        client.rpc('community_mon_images', { p_id: publishedId })
    ]);
    if (detail.error) throw detail.error;
    const row = detail.data;
    if (!row) return null;
    // an images failure is not fatal: the post still reads, it just has no art
    if (images.error) log.warn('COMMUNITY', 'Could not load artwork for this post', images.error);

    // '' as the source id is the post's own mon; anything else names a family
    // member, keyed the way family_full is.
    const byMember = new Map();
    for (const img of images.data || []) {
        const art = maskedArtwork(img.image);
        if (!art) continue;
        const key = String(img.source_id || '');
        if (!byMember.has(key)) byMember.set(key, {});
        byMember.get(key)[img.kind] = art;
    }
    Object.assign(row.fakemon_data ||= {}, byMember.get('') || {});
    for (const entry of row.family_full || []) {
        Object.assign(entry.mon ||= {}, byMember.get(String(entry.sourceId || '')) || {});
    }
    return row;
}

async function openMonDetail(publishedId, options: Record<string, any> = {}) {
    const cs = ensureCommunityState();
    let row = cs.mons.find(m => m.id === publishedId);
    if (!row) return;
    // feed only loads slim fields; fetch the full row now that this one mon
    // is actually opened, for the real learnset/artwork/cry/evolution graph.
    // fetched once and flagged on cs.mons - full artwork across a family can
    // be ~400 kB, the heaviest request on the site, and opening twice paid
    // twice. flag cleared by updatePublishedMon or a forced feed reload.
    try {
        if (!row.__full) {
            const fullRow = await fetchMonDetailRow(publishedId);
            if (fullRow) {
                row = { ...row, ...fullRow, __full: true };
                const idx = cs.mons.findIndex(m => m.id === publishedId);
                if (idx !== -1) cs.mons[idx] = row;
            }
        }
    } catch (e: any) {
        log.error('COMMUNITY', 'Failed to load full mon detail', e);
        api.showToast?.('Could not load the full details for this Fakemon.', 'error');
        return;
    }
    cs.openMonId = publishedId;
    cs.openMonRow = row;
    // Drop the previous mon's thread so the stat strip falls back to the
    // stored count rather than briefly showing the last mon's comment total.
    cs.comments = null;
    cs.commentsLoaded = false;
    if (!options.preserveRoute) navigateRoute(`community/${encodeURIComponent(String(publishedId))}`);

    // if opened via an evolution/mega/forme chip (options.stage), show that
    // family member's snapshot first instead of the post's default mon.
    const familyFull = Array.isArray(row.family_full) ? row.family_full : [];
    const preselect = options.stage ? familyFull.find(m => m.sourceId === String(options.stage)) : null;
    const mon = preselect ? preselect.mon : (row.fakemon_data || {});
    cs.openMonActiveSourceId = preselect ? preselect.sourceId : String(row.source_fakemon_id || '');

    // navigate first, then render: the board is drawn into the page's element
    api.activateTopLevelView?.('community-detail-view');
    renderCommunityPreviewBoard(mon, row);
    notify();

    try {
        const client = await api.getClient();
        const { data: nextViewCount, error: viewError } = await client.rpc('increment_published_mon_view', { p_published_id: publishedId });
        if (viewError) throw viewError;
        if (Number.isFinite(Number(nextViewCount))) {
            row.view_count = Number(nextViewCount);
            notify();
        }
    } catch (e: any) {
        // likely cause: RPC signature mismatch (see note above). fail quietly
        // in the UI - a missing view count shouldn't block viewing the mon -
        // but log it.
        log.error('COMMUNITY', 'Failed to record view', e);
    }

    await fetchComments(publishedId);
    notify();
}


function closeMonDetail() {
    const cs = ensureCommunityState();
    cs.openMonId = null;
    cs.openMonRow = null;
    openCommunityHub();
}

// ==================== owner-only export / add to collection ====================
// These were removed once, because handing over a file gives away the full-res
// artwork the page deliberately shields (js/core/art-shield.ts). They are back
// only for the person who published the post: their own artwork is theirs to
// download, and nobody else's is reachable through them.
//
// The guard is applied twice on purpose. ownsOpenCommunityMon() decides whether
// the buttons are rendered at all, and each action re-checks before it does
// anything, so calling the function straight from the console on someone else's
// post gets a refusal rather than a download. Staff are NOT an exception here:
// moderation powers cover taking a post down, not taking a copy of it.

function ownsOpenCommunityMon() {
    const row = ensureCommunityState().openMonRow;
    return !!(row && state.user && row.user_id === state.user.id);
}

// the post's own mon plus every family member it carries, in publish order
function openCommunityMonRecords() {
    const row = ensureCommunityState().openMonRow;
    if (!row) return [];
    const primary = row.fakemon_data || null;
    const family = (Array.isArray(row.family_full) ? row.family_full : [])
        .map(entry => entry?.mon)
        .filter(mon => mon && mon !== primary);
    return [primary, ...family].filter(Boolean);
}

function exportOpenCommunityMon() {
    if (!ownsOpenCommunityMon()) {
        api.showToast?.('You can only export your own published Fakemon.', 'error');
        return;
    }
    const records = openCommunityMonRecords();
    if (!records.length) { api.showToast?.('Nothing to export!', 'error'); return; }
    const name = String(records[0].name || 'fakemon');
    // same shape the file importer already reads, so this needs no new path
    api.downloadJsonFile?.(`${name}-pokedex.json`, {
        format: 'woogidex-collection',
        version: 2,
        exportedAt: new Date().toISOString(),
        primaryName: name,
        fakemonDB: records
    });
    log.info('COMMUNITY', 'Owner exported their published mon', { id: ensureCommunityState().openMonId });
    api.showToast?.(`${name} exported!`, 'success');
}

async function addOpenCommunityMonToCollection() {
    if (!ownsOpenCommunityMon()) {
        api.showToast?.('You can only add your own published Fakemon to your collection.', 'error');
        return;
    }
    const records = openCommunityMonRecords();
    if (!records.length) { api.showToast?.('Nothing to add!', 'error'); return; }
    try {
        const added = await api.addFakemonToCollection(records);
        if (!added.length) { api.showToast?.('Could not add this to your collection.', 'error'); return; }
        log.info('COMMUNITY', 'Owner copied their published mon back into their collection', { added: added.length });
        api.showToast?.(added.length === 1
            ? `${added[0].name} added to your collection!`
            : `${added.length} Fakemon added to your collection!`, 'success');
    } catch (e: any) {
        log.error('COMMUNITY', 'Add to collection failed', e);
        api.showToast?.('Could not add this to your collection.', 'error');
    }
}

window.exportOpenCommunityMon = exportOpenCommunityMon;
window.addOpenCommunityMonToCollection = addOpenCommunityMonToCollection;

// the detail page (js/app/pages/CommunityDetailPage.tsx) draws the thread
function renderCommentsSkeleton() {
    ensureCommunityState().commentsLoaded = false;
    notify();
}

function renderMonComments() {
    notify();
}

/**
 * Posts a comment on the open post.
 * @returns whether it was posted
 */
async function submitMonComment(text): Promise<boolean> {
    const cs = ensureCommunityState();
    if (!cs.openMonId) return false;
    return postComment(cs.openMonId, text);
}

/** What the Community pages draw from. */
function communityState() {
    return ensureCommunityState();
}

export {
    publishFakemon, publishCurrentEditorFakemon, unpublishMon, unpublishOpenCommunityMon, updatePublishedMon, updateOpenCommunityMon, fetchCommunityFeed,
    fetchComments, postComment, deleteComment,
    openCommunityHub, closeCommunityHub, renderCommunityGrid, filterCommunity, changeCommunitySort, openCommunityRulesModal, closeCommunityRulesModal,
    hasAcceptedCommunityRules, markCommunityRulesAccepted,
    openMonDetail, openPublishedMonById, closeMonDetail, renderMonComments, submitMonComment, handleCommunityRoute, exitCommunityRoute, copyCommunityShareLink, copyOpenCommunityShareLink,
    toggleCommunityLike, openCommunityUpdateModal, closeCommunityUpdateModal,
    renderCommunityGridSkeleton, renderCommentsSkeleton,
    switchCommunityPreviewMon, toggleCommunityLayout, applyCommunityLayoutUI, communityLayoutMode, getCommunityPrefs,
    requestCardArtwork,
    showCommunityLanding, browseCommunityFakemon, renderCommunityLanding, featuredThisWeek,
    showCommunityPanel, renderCommunityUploads, openCommunityPublishModal, openCommunityUpdateModalFor,
    exportOpenCommunityMon, addOpenCommunityMonToCollection, communityState, publishLimits, describeCooldown,
};
