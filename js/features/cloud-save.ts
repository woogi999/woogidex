// ==================== cloud backup ====================
// Optional signed-in-only backup of the private collection. Not the community
// hub -- public.collections is owner-only via RLS, one row per user.
//
// Exists because IndexedDB isn't durable (cleared browser, new device, eviction).
//
// Item/row-size ceilings are enforced server-side by enforce_collection_quota();
// the checks below just warn before a large upload hits that limit.
//
// Ceilings aren't constants -- they come from public.site_limits (badges can
// raise/lift them), resolved per-user by my_limits(). The constants below are
// only the pre-fetch assumption and the fallback.

import { log } from '../core/log.ts';
import { state, api } from '../core/app.ts';
import { confirmDialog } from '../core/confirm-dialog.ts';
import { getClient } from '../core/supabase.ts';
import { notify } from '../app/store.ts';
import { closeDialog, openDialog } from '../app/dialogs.tsx';

// Default, matches site_limits'; exported since other modules import it.
export const CLOUD_MAX_ITEMS = 60;

const DEFAULT_LIMITS = {
    cloudItems: CLOUD_MAX_ITEMS,
    cloudBytes: 5 * 1024 * 1024,
    communityUploads: 20,
    publishCooldownSeconds: 3600,
    autoBackup: false,
    cloudRegions: 3
};

// -1 is the server's "unlimited" sentinel; converted to Infinity here so
// comparisons downstream stay ordinary.
export const UNLIMITED = -1;
export function asCap(n) { return n === UNLIMITED ? Infinity : Number(n); }

/** The limits in force for the signed-in user, defaulted until they load. */
export function cloudLimits() {
    return ensureCloudState().limits;
}

/** Asks the server what this account is allowed (site defaults + badges resolved server-side). */
export async function refreshCloudLimits() {
    const cs = ensureCloudState();
    if (!state.user) { cs.limits = { ...DEFAULT_LIMITS }; return cs.limits; }
    try {
        const client = await getClient();
        const { data, error } = await client.rpc('my_limits');
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        if (row) {
            cs.limits = {
                cloudItems: Number(row.cloud_items),
                cloudBytes: Number(row.cloud_bytes),
                communityUploads: Number(row.community_uploads),
                publishCooldownSeconds: Number(row.publish_cooldown_seconds),
                autoBackup: !!row.auto_backup,
                // absent until the server has the column; the default stands in
                cloudRegions: row.cloud_regions == null ? DEFAULT_LIMITS.cloudRegions : Number(row.cloud_regions)
            };
        }
    } catch (e: any) {
        // Server enforces the real limits regardless; defaults are a safe fallback.
        log.warn('CLOUD', 'Could not load your limits; using the defaults', e);
    }
    return cs.limits;
}


// ==================== the manifest ====================
// Collection cards need "is this exact version backed up?" on every render.
// Downloading the full backup (up to 5MB of artwork) just to draw a badge
// would be wasteful, so collections.manifest is a server-maintained
// {id, updatedAt} projection. This holds the last fetched copy of it.
function ensureCloudState() {
    if (!state.cloud) {
        state.cloud = {
            byId: new Map(),   // fakemon id -> the updatedAt that was backed up
            loaded: false,     // false until the first successful manifest fetch
            savedAt: null as any,     // when the backup was last written
            libraryCount: 0,   // custom moves + abilities + items stored
            publishedCount: null as any, // community uploads used, for the Settings meter
            limits: { ...DEFAULT_LIMITS } // replaced by refreshCloudLimits()
        };
    }
    return state.cloud;
}

/**
 * Fingerprint of everything in the manifest that the collection grid draws.
 * Re-rendering the grid rebuilds every card's innerHTML, so it is only worth
 * doing when this actually changed -- otherwise a routine manifest refetch
 * repaints the whole page for no visible difference.
 */
function cloudManifestSignature() {
    const cs = ensureCloudState();
    return [...cs.byId.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).join('|')
        + `#${cs.loaded ? 1 : 0}`;
}

/** Re-renders the collection only if the badges it draws would come out different. */
function renderCollectionIfManifestChanged(before) {
    if (cloudManifestSignature() === before) return;
    api.renderCollection?.();
}

/** Total items a backup of `list` would occupy against the item quota. */
export function countCloudItems(list = state.fakemonDB) {
    return (list?.length || 0)
         + (state.customMoves?.length || 0)
         + (state.customAbilities?.length || 0)
         + (state.customItems?.length || 0);
}

/** Items in the collection that are not Fakemon -- they ride along on every upload. */
export function cloudLibraryCount() {
    return (state.customMoves?.length || 0)
         + (state.customAbilities?.length || 0)
         + (state.customItems?.length || 0);
}

/** True when this Fakemon is backed up AT THIS REVISION -- editing it changes updatedAt, so the badge drops. */
export function isBackedUpToCloud(f) {
    if (!f) return false;
    const stored = ensureCloudState().byId.get(String(f.id));
    return stored !== undefined && String(stored) === String(f.updatedAt ?? '');
}

// Postgres raises quota errors with an already user-facing message; pass it through as-is.
function friendlyCloudError(error) {
    const message = String(error?.message || '');
    if (/Cloud backup/i.test(message)) return message;
    if (/row-level security|permission denied/i.test(message)) {
        return 'Sign in again to use your cloud backup.';
    }
    return 'Cloud backup failed: ' + (message || 'unknown error');
}

/** Refreshes the cached manifest (two small columns, never the full backup). Called on auth change and after every write. */
export async function refreshCloudManifest() {
    const cs = ensureCloudState();
    const signedInSignature = cloudManifestSignature();
    if (!state.user) {
        cs.byId = new Map();
        cs.loaded = false;
        cs.savedAt = null;
        cs.libraryCount = 0;
        cs.publishedCount = null;
        cs.limits = { ...DEFAULT_LIMITS };
        renderCollectionIfManifestChanged(signedInSignature);
        await refreshCloudBackupUI({ revalidate: false });
        return;
    }
    // Limits refreshed alongside the manifest since meters are measured against them.
    const before = cloudManifestSignature();
    await refreshCloudLimits();
    await fetchCloudManifest();
    renderCollectionIfManifestChanged(before);
    // Already revalidated above; don't refetch the same answers again.
    await refreshCloudBackupUI({ revalidate: false });
}

/** Manifest fetch alone, no UI calls -- lets refreshCloudBackupUI() revalidate without recursing through refreshCloudManifest. */
async function fetchCloudManifest() {
    const cs = ensureCloudState();
    if (!state.user) return false;
    const client = await getClient();
    const { data, error } = await client
        .from('collections')
        .select('manifest, updated_at, custom_moves, custom_abilities, custom_items')
        .eq('user_id', state.user.id)
        .maybeSingle();
    if (error) { log.error('CLOUD', 'Manifest fetch failed', error); return false; }

    cs.byId = new Map<any, any>((data?.manifest || []).map(entry => [String(entry.id), entry.u]));
    cs.libraryCount = (data?.custom_moves?.length || 0)
                    + (data?.custom_abilities?.length || 0)
                    + (data?.custom_items?.length || 0);
    cs.savedAt = data?.updated_at || null;
    cs.loaded = true;
    log.debug('CLOUD', 'Manifest loaded', { backedUp: cs.byId.size });
    return true;
}

/** The full backup row. Only fetched when something actually needs the data. */
export async function fetchCloudBackup() {
    if (!state.user) return null;
    const client = await getClient();
    const { data, error } = await client.from('collections').select('*').eq('user_id', state.user.id).maybeSingle();
    if (error) { log.error('CLOUD', 'Fetch failed', error); return null; }
    return data || null;
}

// ==================== writing the backup ====================
/**
 * Writes an exact backup: `parts` becomes what is stored, anything absent is
 * dropped. Each kind is chosen explicitly since all four share one quota.
 * @param parts
 */
async function writeCloudBackup(parts: {mons: Record<string, any>[], moves: Record<string, any>[], abilities: Record<string, any>[], items: Record<string, any>[], regions?: Record<string, any>[]}, { silent = false }: { silent?: any } = {}) {
    if (!state.user) { api.showToast?.('Sign in to use cloud backup.', 'warning'); return false; }

    const mons = parts.mons || [];
    const moves = parts.moves || [];
    const abilities = parts.abilities || [];
    const items = parts.items || [];
    const regions = parts.regions || [];
    const count = mons.length + moves.length + abilities.length + items.length;
    const cap = asCap(cloudLimits().cloudItems);
    if (count > cap) {
        api.showToast?.(`That is ${count} items and the backup holds ${cap}. Untick a few before saving.`, 'error');
        return false;
    }
    const regionCap = asCap(cloudLimits().cloudRegions);
    if (regions.length > regionCap) {
        api.showToast?.(regionCap === 0
            ? 'Regions can’t be backed up on your account. Untick them before saving.'
            : `That is ${regions.length} regions and the backup holds ${regionCap}. Untick a few before saving.`, 'error');
        return false;
    }

    const client = await getClient();
    const { error } = await client.from('collections').upsert({
        user_id: state.user.id,
        fakemon_db: mons,
        // ordinary folders and custom types always go; regions only when picked
        folders: [...(state.folders || []).filter(f => !isRegion(f)), ...regions],
        custom_moves: moves,
        custom_abilities: abilities,
        custom_items: items
    }, { onConflict: 'user_id' });

    if (error) {
        log.error('CLOUD', 'Upload failed', error);
        api.showToast?.(friendlyCloudError(error), 'error');
        return false;
    }
    log.info('CLOUD', 'Backup written', { mons: mons.length, items: count });
    if (!silent) {
        api.showToast?.(cap === Infinity
            ? `Backed up ${count} item${count === 1 ? '' : 's'}.`
            : `Backed up ${count} item${count === 1 ? '' : 's'} (${count}/${cap} used).`, 'success');
    }
    await refreshCloudManifest();
    return true;
}

/** The stored row's lists, defaulted, for a read-modify-write. */
function partsFromRow(row) {
    return {
        mons: Array.isArray(row?.fakemon_db) ? row.fakemon_db : [],
        moves: Array.isArray(row?.custom_moves) ? row.custom_moves : [],
        abilities: Array.isArray(row?.custom_abilities) ? row.custom_abilities : [],
        items: Array.isArray(row?.custom_items) ? row.custom_items : [],
        regions: rowRegions(row)
    };
}

// Regions live in the folders list next to ordinary folders and custom types,
// but unlike those they're picked one by one and have their own cap.
const isRegion = f => f?.type === 'region';
function localRegions() { return (state.folders || []).filter(isRegion); }
function rowRegions(row) { return (Array.isArray(row?.folders) ? row.folders : []).filter(isRegion); }

/** Collection card's cloud button: backs up one Fakemon without disturbing the rest; updates in place if already stored. */
export async function backupFakemonToCloud(fakemonId, event) {
    event?.stopPropagation();
    if (!state.user) { api.showToast?.('Sign in to back up to the cloud.', 'warning'); return false; }
    const mon = state.fakemonDB.find(f => String(f.id) === String(fakemonId));
    if (!mon) { api.showToast?.('Could not find that Fakemon.', 'error'); return false; }

    // Read-modify-write; needs the whole row, hence one button click, not autosave.
    const parts = partsFromRow(await fetchCloudBackup());
    parts.mons = parts.mons.filter(entry => String(entry?.id) !== String(mon.id));
    parts.mons.push(JSON.parse(JSON.stringify(mon)));

    const ok = await writeCloudBackup(parts, { silent: true });
    if (ok) api.showToast?.(`${mon.name || 'That Fakemon'} is backed up to the cloud.`, 'success');
    return ok;
}

/** Drops one Fakemon from the backup, leaving the rest of it alone. */
export async function removeFakemonFromCloud(fakemonId, event) {
    event?.stopPropagation();
    const parts = partsFromRow(await fetchCloudBackup());
    const before = parts.mons.length;
    parts.mons = parts.mons.filter(entry => String(entry?.id) !== String(fakemonId));
    if (parts.mons.length === before) return false;
    const ok = await writeCloudBackup(parts, { silent: true });
    if (ok) api.showToast?.('Removed from your cloud backup.', 'info');
    return ok;
}

export async function deleteCloudBackup() {
    if (!state.user) return false;
    if (!await confirmDialog({ title: 'Delete your cloud backup?', message: 'Your collection on this device is not affected.' })) return false;
    const client = await getClient();
    const { error } = await client.from('collections').delete().eq('user_id', state.user.id);
    if (error) {
        log.error('CLOUD', 'Delete failed', error);
        api.showToast?.(friendlyCloudError(error), 'error');
        return false;
    }
    api.showToast?.('Cloud backup deleted.', 'info');
    await refreshCloudManifest();
    return true;
}

// ==================== restoring ====================
// Restore never DELETES. Anything the backup doesn't mention is left alone --
// restoring an old backup must not wipe out everything made since.
// Overwrites only entries explicitly ticked; existing entries are unticked
// by default so replacing one can't happen by accident.
function mergeById(local, chosen) {
    const incoming = new Map<any, any>((chosen || []).filter(Boolean).map(entry => [String(entry.id), entry]));
    let replaced = 0;

    // Replacements swap in place rather than moving to the end, to avoid reshuffling order.
    const merged = (local || []).map(entry => {
        const key = String(entry?.id);
        if (!incoming.has(key)) return entry;
        replaced++;
        const next = incoming.get(key);
        incoming.delete(key);
        return next;
    });

    const added = [...incoming.values()];
    return { merged: [...merged, ...added], added: added.length, replaced };
}

/**
 * Merges ticked entries of each kind back into the local collection.
 * @param parts
 */
async function restoreParts(parts: {mons: Record<string, any>[], moves: Record<string, any>[], abilities: Record<string, any>[], items: Record<string, any>[], regions?: Record<string, any>[]}) {
    const total = (parts.mons?.length || 0) + (parts.moves?.length || 0)
                + (parts.abilities?.length || 0) + (parts.items?.length || 0) + (parts.regions?.length || 0);
    if (!total) { api.showToast?.('Nothing selected to restore.', 'warning'); return false; }

    const mons = mergeById(state.fakemonDB, parts.mons);
    const moves = mergeById(state.customMoves, parts.moves);
    const abilities = mergeById(state.customAbilities, parts.abilities);
    const items = mergeById(state.customItems, parts.items);
    // Regions are picked like entries. Other folders aren't pickable; only missing
    // ones are added so renamed folders keep their new name.
    const regions = mergeById(state.folders, parts.regions);
    const knownFolders = new Set(regions.merged.map(f => String(f?.id)));
    const folders = mergeById(regions.merged,
        (cloudModal.row?.folders || []).filter(f => f && !isRegion(f) && !knownFolders.has(String(f.id))));

    const added = mons.added + moves.added + abilities.added + items.added + regions.added;
    const replaced = mons.replaced + moves.replaced + abilities.replaced + items.replaced + regions.replaced;
    if (!added && !replaced && !folders.added) {
        api.showToast?.('Nothing changed: everything you picked already matches this device.', 'info');
        return false;
    }

    state.fakemonDB = mons.merged;
    state.folders = folders.merged;
    state.customMoves = moves.merged;
    state.customAbilities = abilities.merged;
    state.customItems = items.merged;

    await api.saveToStorage?.();
    api.renderCollection?.();
    log.info('CLOUD', 'Restored from backup', { added, replaced });
    // Reported separately: added vs replaced are different things happening to the collection.
    const parts_: any[] = [];
    if (added) parts_.push(`added ${added}`);
    if (replaced) parts_.push(`replaced ${replaced}`);
    api.showToast?.(`Restored from your cloud backup: ${parts_.join(', ')}.`, 'success');
    return true;
}

// ==================== the picker modal ====================
// One modal, two modes, four kinds of thing.
//   'upload'  source is the local collection; confirming sets the backup to exactly what's ticked.
//   'restore' source is the backup; confirming merges ticked entries into the local collection.
//
// All four kinds are pickable (not just Fakemon) since they share one quota.
// Tabs share one selection so the total/meter is always visible regardless of tab.
const CLOUD_KINDS = [
    // `one`/`many` so the summary reads as a sentence ("1 Fakémon + 2 moves"), not "1 moves".
    { key: 'mons',      label: 'Fakémon',   one: 'Fakémon',  many: 'Fakémon',   icon: 'sparkles', local: 'fakemonDB',       column: 'fakemon_db' },
    { key: 'moves',     label: 'Moves',     one: 'move',     many: 'moves',     icon: 'zap',      local: 'customMoves',     column: 'custom_moves' },
    { key: 'abilities', label: 'Abilities', one: 'ability',  many: 'abilities', icon: 'wand',     local: 'customAbilities', column: 'custom_abilities' },
    { key: 'items',     label: 'Items',     one: 'item',     many: 'items',     icon: 'package',  local: 'customItems',     column: 'custom_items' },
    // own: counted against the region cap, not the item cap
    { key: 'regions',   label: 'Regions',   one: 'region',   many: 'regions',   icon: 'map',      own: true }
];

/** This device's entries of one kind. */
function localOf(kind) { return kind.key === 'regions' ? localRegions() : (state[kind.local] || []); }
/** A backup row's entries of one kind. */
function storedOf(row, kind) {
    if (kind.key === 'regions') return rowRegions(row);
    return Array.isArray(row?.[kind.column]) ? row[kind.column] : [];
}

const cloudModal = {
    mode: 'upload',
    kind: 'mons',                // which tab is open
    source: emptySource(),
    selected: emptySelection(),
    row: null as any,                   // the fetched backup row
    search: '',
    loading: false
};

function emptySource() {
    return { mons: [] as any[], moves: [] as any[], abilities: [] as any[], items: [] as any[], regions: [] as any[] };
}

function emptySelection() {
    return { mons: new Set(), moves: new Set(), abilities: new Set(), items: new Set(), regions: new Set() };
}

/** Ticked entries that count against the item cap (regions have their own). */
function totalSelected() {
    return CLOUD_KINDS.filter(k => !k.own).reduce((n, k) => n + cloudModal.selected[k.key].size, 0);
}

/** Ticks everything filed in a region, so backing up a region brings its contents along. */
function tickRegionContents(regionId) {
    for (const kind of CLOUD_KINDS) {
        if (kind.own) continue;
        (cloudModal.source[kind.key] || []).forEach(entry => {
            if (entry && !entry.pendingVanilla && api.entryInRegion?.(entry, regionId)) cloudModal.selected[kind.key].add(String(entry.id));
        });
    }
}

/** "4 Fakémon · 2 moves" for a region card, counted in the modal's source lists. */
function regionContentsLabel(regionId) {
    const bits = CLOUD_KINDS.filter(k => !k.own).map(kind => {
        const n = (cloudModal.source[kind.key] || []).filter(e => e && !e.pendingVanilla && api.entryInRegion?.(e, regionId)).length;
        return n ? `${n} ${n === 1 ? kind.one : kind.many}` : '';
    }).filter(Boolean);
    return bits.join(' · ') || 'Empty';
}

export async function openCloudBackupModal(mode = 'upload') {
    if (!state.user) { api.showToast?.('Sign in to use cloud backup.', 'warning'); return; }
    cloudModal.mode = mode === 'restore' ? 'restore' : 'upload';
    cloudModal.kind = 'mons';
    cloudModal.search = '';
    cloudModal.row = null;
    cloudModal.source = emptySource();
    cloudModal.selected = emptySelection();
    cloudModal.loading = true;
    openDialog('cloud-backup', {});
    notify();

    // Both modes fetch the whole row: restore needs the data, upload needs it to
    // pre-tick what's already stored across all four kinds (the manifest only tracks Fakemon).
    const row = await fetchCloudBackup();

    if (cloudModal.mode === 'restore') {
        if (!row) {
            closeCloudBackupModal();
            api.showToast?.('You have no cloud backup yet.', 'info');
            return;
        }
        cloudModal.row = row;
        for (const kind of CLOUD_KINDS) {
            cloudModal.source[kind.key] = storedOf(row, kind);
            // Default-tick only what's missing locally; restoring what you already have is a no-op.
            const local = new Set(localOf(kind).map(entry => String(entry?.id)));
            cloudModal.selected[kind.key] = new Set(
                cloudModal.source[kind.key]
                    .filter(entry => entry && !local.has(String(entry.id)))
                    .map(entry => String(entry.id))
            );
        }
    } else {
        cloudModal.row = row;
        for (const kind of CLOUD_KINDS) {
            cloudModal.source[kind.key] = localOf(kind);
            // Pre-tick what's already stored, so opening and saving is a no-op, not an empty-out.
            const stored = new Set(storedOf(row, kind).map(entry => String(entry?.id)));
            cloudModal.selected[kind.key] = new Set(
                cloudModal.source[kind.key]
                    .filter(entry => entry && stored.has(String(entry.id)))
                    .map(entry => String(entry.id))
            );
        }
    }
    cloudModal.loading = false;
    notify();
}

export function closeCloudBackupModal() {
    closeDialog('cloud-backup');
    cloudModal.source = emptySource();
    cloudModal.row = null;
}

export function switchCloudBackupKind(kind) {
    if (!CLOUD_KINDS.some(k => k.key === kind)) return;
    cloudModal.kind = kind;
    // Search is per-tab; carrying it over would make another tab look empty.
    cloudModal.search = '';
    notify();
}

export function filterCloudBackupModal(text) {
    cloudModal.search = String(text || '').trim().toLowerCase();
    notify();
}

export function toggleCloudBackupMon(id) {
    const picked = cloudModal.selected[cloudModal.kind];
    const key = String(id);
    if (picked.has(key)) picked.delete(key);
    else {
        picked.add(key);
        if (cloudModal.kind === 'regions') tickRegionContents(key);
    }
    notify();
}

export function selectAllCloudBackupMons() {
    visibleCloudModalEntries().forEach(e => cloudModal.selected[cloudModal.kind].add(String(e.id)));
    notify();
}

export function clearCloudBackupSelection() {
    visibleCloudModalEntries().forEach(e => cloudModal.selected[cloudModal.kind].delete(String(e.id)));
    notify();
}

function visibleCloudModalEntries() {
    const list = cloudModal.source[cloudModal.kind] || [];
    if (!cloudModal.search) return list;
    return list.filter(e =>
        String(e?.name || '').toLowerCase().includes(cloudModal.search)
        || String(e?.number || '').toLowerCase().includes(cloudModal.search));
}

/** The one-line summary under a card's name, per kind. */
function entrySubtitle(entry) {
    if (cloudModal.kind === 'mons') {
        return entry.number ? `#${String(entry.number).replace(/^#/, '')}` : '';
    }
    if (cloudModal.kind === 'moves') {
        const bits = [entry.type || 'Normal', entry.category || 'Status'];
        if (entry.basePower) bits.push(`${entry.basePower} BP`);
        return bits.join(' · ');
    }
    if (cloudModal.kind === 'regions') return regionContentsLabel(entry.id);
    // Abilities/items are described by their text -- the only thing distinguishing two at a glance.
    return String(entry.desc || entry.description || 'No description').slice(0, 60);
}

/** Under a card: is it already on the device (restore), or in the backup (upload)? */
function entryNote(entry, picked) {
    const id = String(entry.id);
    const kindSpec = CLOUD_KINDS.find(k => k.key === cloudModal.kind);
    if (cloudModal.mode === 'restore') {
        // Ticking an already-local entry overwrites it, so it reads as a warning while ticked.
        if (!localOf(kindSpec).some(m => String(m?.id) === id)) return null;
        return picked ? { text: 'Will replace the copy on this device', tone: 'is-stale' } : { text: 'Already on this device', tone: '' };
    }
    if (cloudModal.kind === 'mons') {
        if (isBackedUpToCloud(entry)) return { text: 'Backed up', tone: 'is-saved' };
        if (ensureCloudState().byId.has(id)) return { text: 'Changed since backup', tone: 'is-stale' };
        return null;
    }
    // No revision stamp for moves/abilities/items, so only "stored or not" is knowable.
    return storedOf(cloudModal.row, kindSpec).some(e => String(e?.id) === id) ? { text: 'Backed up', tone: 'is-saved' } : null;
}

/** Everything the backup picker (js/app/dialogs/cloudBackup.tsx) shows. */
export function cloudBackupPicker() {
    const uploading = cloudModal.mode === 'upload';
    const kind = CLOUD_KINDS.find(k => k.key === cloudModal.kind)!;
    const limits = cloudLimits();
    const regionCap = asCap(limits.cloudRegions);
    const cap = asCap(limits.cloudItems);
    const help = cloudModal.kind === 'regions'
        ? (regionCap === 0
            ? 'Region backup isn’t available on your account.'
            : `A region brings its details, banner and main-game roster. Ticking one also ticks everything filed in it. ${regionCap === Infinity ? 'You can back up as many regions as you like.' : `Your backup holds up to ${regionCap} region${regionCap === 1 ? '' : 's'}, separate from the item limit.`}`)
        : uploading
            ? (cap === Infinity
                ? 'Your backup will hold exactly what you tick, across every tab. Your badges lift the item limit, so tick as many as you like.'
                : `Your backup will hold exactly what you tick, across every tab. Fakémon, moves, abilities and items count towards the same ${limits.cloudItems}-item limit.`)
            : 'Ticked entries are copied onto this device. Anything already here is left alone unless you tick it, in which case the backed-up version replaces it. Nothing is ever deleted.';
    const total = totalSelected();
    const regionCount = cloudModal.selected.regions.size;
    const parts = CLOUD_KINDS.filter(k => !k.own && cloudModal.selected[k.key].size).map(k => {
        const n = cloudModal.selected[k.key].size;
        return `${n} ${n === 1 ? k.one : k.many}`;
    });
    const noun = cloudModal.kind === 'mons' ? 'Fakémon' : kind.own ? kind.many : `custom ${kind.many}`;
    const available = (cloudModal.source[cloudModal.kind] || []).length;
    return {
        mode: cloudModal.mode, uploading, loading: cloudModal.loading, kind: cloudModal.kind, search: cloudModal.search, help,
        tabs: CLOUD_KINDS.map(k => ({
            key: k.key, label: k.label, active: k.key === cloudModal.kind,
            picked: cloudModal.selected[k.key].size, available: (cloudModal.source[k.key] || []).length,
            // an account whose badges allow no regions can still restore them, just not back them up
            blocked: !!k.own && uploading && regionCap === 0
        })),
        searchPlaceholder: `Search ${kind.many.toLowerCase() === 'fakémon' ? 'Fakémon' : kind.many.toLowerCase()}...`,
        entries: visibleCloudModalEntries().map(entry => {
            const picked = cloudModal.selected[cloudModal.kind].has(String(entry.id));
            return {
                id: String(entry.id), name: entry.name || 'Unnamed', subtitle: entrySubtitle(entry), picked,
                artwork: cloudModal.kind === 'mons' ? (entry.artwork || '') : null,
                icon: kind.icon, color: kind.own ? entry.color || '' : '', note: entryNote(entry, picked)
            };
        }),
        empty: available ? 'Nothing here matches your search.' : `You have no ${noun} ${uploading ? 'yet' : 'in this backup'}.`,
        total, cap, regionCount, regionCap, parts,
        itemsOver: uploading && total > cap,
        regionsOver: uploading && regionCount > regionCap,
        canConfirm: uploading ? !(total > cap || regionCount > regionCap) : (total + regionCount) > 0
    };
}

/** The ticked entries of one kind, deep-copied out of their source list. */
function pickedEntries(kindKey) {
    const chosen = cloudModal.selected[kindKey];
    const source = cloudModal.mode === 'upload'
        ? localOf(CLOUD_KINDS.find(k => k.key === kindKey))
        : (cloudModal.source[kindKey] || []);
    return JSON.parse(JSON.stringify(source.filter(e => e && chosen.has(String(e.id)))));
}

export async function confirmCloudBackupModal() {
    const parts = {
        mons: pickedEntries('mons'),
        moves: pickedEntries('moves'),
        abilities: pickedEntries('abilities'),
        items: pickedEntries('items'),
        regions: pickedEntries('regions')
    };
    if (cloudModal.mode === 'upload') {
        const ok = await writeCloudBackup(parts);
        if (ok) closeCloudBackupModal();
        return ok;
    }
    const ok = await restoreParts(parts);
    if (ok) closeCloudBackupModal();
    return ok;
}

// ==================== automatic backup ====================
// Off by default: site_limits' site-wide switch starts false, and a badge must
// also carry can_auto_backup; my_limits() resolves both into cloudLimits().autoBackup.
//
// Deliberately not "everything" -- it refreshes the backup you already chose,
// not the whole collection. Sweeping everything up would silently override the
// picker's choice and could blow past the item ceiling.
//
// Does nothing until there's a backup to keep current; that's a normal state,
// not an error.
const AUTO_BACKUP_KEY = 'woogidex.cloud.autoBackup.v1';
// Long enough that a run of edits becomes one upload instead of twenty.
const AUTO_BACKUP_DELAY_MS = 4 * 60 * 1000;
let autoBackupTimer: any = null;

export function isAutoBackupOn() {
    if (!cloudLimits().autoBackup) return false;
    try { return localStorage.getItem(AUTO_BACKUP_KEY) === 'on'; } catch { return false; }
}

export function setCloudAutoBackup(on) {
    try { localStorage.setItem(AUTO_BACKUP_KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
    if (!on && autoBackupTimer) { clearTimeout(autoBackupTimer); autoBackupTimer = null; }
    if (on) scheduleAutoBackup();
    // Local toggle only; nothing server-side changed, so just repaint.
    refreshCloudBackupUI({ revalidate: false });
}

/** Called after the collection is saved. No-op unless auto-backup is on; debounces a burst of edits into one upload. */
export function scheduleAutoBackup() {
    if (!state.user || !isAutoBackupOn()) return;
    if (autoBackupTimer) clearTimeout(autoBackupTimer);
    autoBackupTimer = setTimeout(() => { autoBackupTimer = null; runAutoBackup(); }, AUTO_BACKUP_DELAY_MS);
}

async function runAutoBackup() {
    if (!state.user || !isAutoBackupOn()) return;

    // This backup mirrors the device, so anything missing locally is dropped from
    // the cloud copy. That is correct for a real deletion and catastrophic for a
    // failed load -- it would push a local wipe up to the one copy that could have
    // undone it. If we never proved we read local storage, leave the backup alone.
    if (api.isCollectionLoaded && !api.isCollectionLoaded()) {
        log.warn('CLOUD', 'Auto-backup skipped: local collection was never loaded this session');
        return;
    }

    const cs = ensureCloudState();
    // Nothing to keep current yet; silent since this fires on a timer, not a user action.
    if (!cs.savedAt) { log.debug('CLOUD', 'Auto-backup skipped: no backup to update yet'); return; }

    const row = await fetchCloudBackup();
    if (!row) return;
    const stored = partsFromRow(row);

    // Match by id against the device's current state; a locally-deleted entry drops from the backup.
    const freshest = (storedList, localList) => {
        const local = new Map<any, any>((localList || []).map(e => [String(e?.id), e]));
        return (storedList || [])
            .map(e => local.get(String(e?.id)))
            .filter(Boolean);
    };
    const parts = {
        mons: freshest(stored.mons, state.fakemonDB),
        moves: freshest(stored.moves, state.customMoves),
        abilities: freshest(stored.abilities, state.customAbilities),
        items: freshest(stored.items, state.customItems),
        regions: freshest(stored.regions, localRegions())
    };

    // A backup that would keep nothing is not a backup refresh, it is a delete.
    // Auto-backup runs unattended on a timer, so it never gets to make that call:
    // a real "I deleted everything" still reaches the cloud through the manual
    // picker, which is an explicit action with a confirmation.
    const kept = parts.mons.length + parts.moves.length + parts.abilities.length + parts.items.length;
    const had = stored.mons.length + stored.moves.length + stored.abilities.length + stored.items.length;
    if (had && !kept) {
        log.warn('CLOUD', 'Auto-backup skipped: it would have emptied the backup', { had });
        return;
    }

    const ok = await writeCloudBackup(parts, { silent: true });
    log.info('CLOUD', 'Auto-backup ran', { ok, items: kept });
}

// ==================== limit meters ====================
/** Community listing count for this account (HEAD request, no rows). Cached so callers share one fetch. */
export async function refreshPublishedCount() {
    const cs = ensureCloudState();
    if (!state.user) { cs.publishedCount = null; return null; }
    const client = await getClient();
    const { count, error } = await client
        .from('published_mons')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', state.user.id);
    if (error) { log.error('CLOUD', 'Published count failed', error); return null; }
    cs.publishedCount = count ?? 0;
    return cs.publishedCount;
}

// Shipped default only; the enforced value comes from cloudLimits() (server-resolved).
export const MAX_COMMUNITY_UPLOADS = 20;

/**
 * The meters as data: [label, used, cap, hint], drawn by js/app/components/CloudMeters.tsx.
 * @param [overrideItems] items to show instead of what is stored (the picker previews its ticks)
 * @param [regions] regions to show; the regions meter is left out when null
 */
export function cloudMeters(overrideItems: number|null = null, regions: number|null = null): Array<{label: string, used: number, max: number, hint: string}> {
    const cs = ensureCloudState();
    const limits = cs.limits;
    const out = [{ label: 'Cloud backup items', used: overrideItems ?? (cs.byId.size + cs.libraryCount), max: asCap(limits.cloudItems),
        hint: 'Fakemon, custom moves, abilities and items stored on our server.' }];
    if (regions !== null && asCap(limits.cloudRegions) !== 0) {
        out.push({ label: 'Cloud backup regions', used: regions, max: asCap(limits.cloudRegions), hint: 'Regions count separately from items.' });
    }
    if (cs.publishedCount !== null) {
        out.push({ label: 'Community uploads', used: cs.publishedCount, max: asCap(limits.communityUploads),
            hint: 'Listings you have live on the Community Hub. Deleting one frees a slot.' });
    }
    return out;
}

/** What the Settings page shows about the backup; read-only. */
export function cloudState() {
    return ensureCloudState();
}

/** Refreshes what Settings > Data shows about the backup (revalidate: refetch it too). */
export async function refreshCloudBackupUI({ revalidate = true }: { revalidate?: any } = {}) {
    if (!state.user) { notify(); return; }

    // Paint what's already known first so Settings never shows an empty panel while fetching.
    paintCloudBackupUI();
    if (!revalidate) return;

    // Refetched fresh every time rather than trusted from cache: other tabs/devices
    // can change these counts without this tab hearing about it.
    const before = cloudManifestSignature();
    await Promise.all([refreshCloudLimits(), fetchCloudManifest(), refreshPublishedCount()]);
    paintCloudBackupUI();
    // Manifest also drives the collection grid's badges, so push a re-render there
    // too -- but only when a badge would actually come out different.
    renderCollectionIfManifestChanged(before);
}

// the Settings page renders from cloudState(); this re-renders it
function paintCloudBackupUI() {
    notify();
}
