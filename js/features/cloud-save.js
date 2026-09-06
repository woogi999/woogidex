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

import { log } from '../core/log.js';
import { state, api } from '../core/app.js';
import { getClient } from '../core/supabase.js';
import { esc as escapeHtml } from '../core/html.js';

// Default, matches site_limits'; exported since other modules import it.
export const CLOUD_MAX_ITEMS = 60;

const DEFAULT_LIMITS = {
    cloudItems: CLOUD_MAX_ITEMS,
    cloudBytes: 5 * 1024 * 1024,
    communityUploads: 20,
    publishCooldownSeconds: 3600,
    autoBackup: false
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
                autoBackup: !!row.auto_backup
            };
        }
    } catch (e) {
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
            savedAt: null,     // when the backup was last written
            libraryCount: 0,   // custom moves + abilities + items stored
            publishedCount: null, // community uploads used, for the Settings meter
            limits: { ...DEFAULT_LIMITS } // replaced by refreshCloudLimits()
        };
    }
    return state.cloud;
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

/** The small server badge the collection cards draw. Empty string when not backed up. */
export function cloudBadgeHtml(f) {
    if (!isBackedUpToCloud(f)) return '';
    return '<span class="card-cloud-badge" title="Backed up to your cloud backup">'
         + '<i data-lucide="server" style="width:12px;height:12px;"></i></span>';
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
    if (!state.user) {
        cs.byId = new Map();
        cs.loaded = false;
        cs.savedAt = null;
        cs.libraryCount = 0;
        cs.publishedCount = null;
        cs.limits = { ...DEFAULT_LIMITS };
        api.renderCollection?.();
        await refreshCloudBackupUI({ revalidate: false });
        return;
    }
    // Limits refreshed alongside the manifest since meters are measured against them.
    await refreshCloudLimits();
    await fetchCloudManifest();
    api.renderCollection?.();
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

    cs.byId = new Map((data?.manifest || []).map(entry => [String(entry.id), entry.u]));
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
 * @param {{mons: object[], moves: object[], abilities: object[], items: object[]}} parts
 */
async function writeCloudBackup(parts, { silent = false } = {}) {
    if (!state.user) { api.showToast?.('Sign in to use cloud backup.', 'warning'); return false; }

    const mons = parts.mons || [];
    const moves = parts.moves || [];
    const abilities = parts.abilities || [];
    const items = parts.items || [];
    const count = mons.length + moves.length + abilities.length + items.length;
    const cap = asCap(cloudLimits().cloudItems);
    if (count > cap) {
        api.showToast?.(`That is ${count} items and the backup holds ${cap}. Untick a few before saving.`, 'error');
        return false;
    }

    const client = await getClient();
    const { error } = await client.from('collections').upsert({
        user_id: state.user.id,
        fakemon_db: mons,
        folders: state.folders || [],
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

/** The stored row's four lists, defaulted, for a read-modify-write. */
function partsFromRow(row) {
    return {
        mons: Array.isArray(row?.fakemon_db) ? row.fakemon_db : [],
        moves: Array.isArray(row?.custom_moves) ? row.custom_moves : [],
        abilities: Array.isArray(row?.custom_abilities) ? row.custom_abilities : [],
        items: Array.isArray(row?.custom_items) ? row.custom_items : []
    };
}

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
    if (!confirm('Delete your cloud backup? Your local collection on this device is not affected.')) return false;
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
    const incoming = new Map((chosen || []).filter(Boolean).map(entry => [String(entry.id), entry]));
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
 * @param {{mons: object[], moves: object[], abilities: object[], items: object[]}} parts
 */
async function restoreParts(parts) {
    const total = (parts.mons?.length || 0) + (parts.moves?.length || 0)
                + (parts.abilities?.length || 0) + (parts.items?.length || 0);
    if (!total) { api.showToast?.('Nothing selected to restore.', 'warning'); return false; }

    const mons = mergeById(state.fakemonDB, parts.mons);
    const moves = mergeById(state.customMoves, parts.moves);
    const abilities = mergeById(state.customAbilities, parts.abilities);
    const items = mergeById(state.customItems, parts.items);
    // Folders aren't pickable; only missing ones are added so renamed folders keep their new name.
    const knownFolders = new Set((state.folders || []).map(f => String(f?.id)));
    const folders = mergeById(state.folders,
        (cloudModal.row?.folders || []).filter(f => f && !knownFolders.has(String(f.id))));

    const added = mons.added + moves.added + abilities.added + items.added;
    const replaced = mons.replaced + moves.replaced + abilities.replaced + items.replaced;
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
    const parts_ = [];
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
    { key: 'items',     label: 'Items',     one: 'item',     many: 'items',     icon: 'package',  local: 'customItems',     column: 'custom_items' }
];

const cloudModal = {
    mode: 'upload',
    kind: 'mons',                // which tab is open
    source: { mons: [], moves: [], abilities: [], items: [] },
    selected: { mons: new Set(), moves: new Set(), abilities: new Set(), items: new Set() },
    row: null,                   // the fetched backup row
    search: ''
};

function cloudModalEl(id) { return document.getElementById(id); }

function emptySelection() {
    return { mons: new Set(), moves: new Set(), abilities: new Set(), items: new Set() };
}

function totalSelected() {
    return CLOUD_KINDS.reduce((n, k) => n + cloudModal.selected[k.key].size, 0);
}

export async function openCloudBackupModal(mode = 'upload') {
    if (!state.user) { api.showToast?.('Sign in to use cloud backup.', 'warning'); return; }
    cloudModal.mode = mode === 'restore' ? 'restore' : 'upload';
    cloudModal.kind = 'mons';
    cloudModal.search = '';
    cloudModal.row = null;
    cloudModal.source = { mons: [], moves: [], abilities: [], items: [] };
    cloudModal.selected = emptySelection();

    applySearchPlaceholder();
    cloudModalEl('cloud-backup-modal')?.classList.add('active');
    document.body.classList.add('modal-open');
    renderCloudBackupModal({ loading: true });

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
            cloudModal.source[kind.key] = Array.isArray(row[kind.column]) ? row[kind.column] : [];
            // Default-tick only what's missing locally; restoring what you already have is a no-op.
            const local = new Set((state[kind.local] || []).map(entry => String(entry?.id)));
            cloudModal.selected[kind.key] = new Set(
                cloudModal.source[kind.key]
                    .filter(entry => entry && !local.has(String(entry.id)))
                    .map(entry => String(entry.id))
            );
        }
    } else {
        cloudModal.row = row;
        for (const kind of CLOUD_KINDS) {
            cloudModal.source[kind.key] = state[kind.local] || [];
            // Pre-tick what's already stored, so opening and saving is a no-op, not an empty-out.
            const stored = new Set((Array.isArray(row?.[kind.column]) ? row[kind.column] : [])
                .map(entry => String(entry?.id)));
            cloudModal.selected[kind.key] = new Set(
                cloudModal.source[kind.key]
                    .filter(entry => entry && stored.has(String(entry.id)))
                    .map(entry => String(entry.id))
            );
        }
    }
    renderCloudBackupModal();
}

export function closeCloudBackupModal() {
    cloudModalEl('cloud-backup-modal')?.classList.remove('active');
    document.body.classList.remove('modal-open');
    cloudModal.source = { mons: [], moves: [], abilities: [], items: [] };
    cloudModal.row = null;
}

export function switchCloudBackupKind(kind) {
    if (!CLOUD_KINDS.some(k => k.key === kind)) return;
    cloudModal.kind = kind;
    // Search is per-tab; carrying it over would make another tab look empty.
    cloudModal.search = '';
    applySearchPlaceholder();
    renderCloudBackupModal();
}

function applySearchPlaceholder() {
    const searchEl = cloudModalEl('cloud-backup-search');
    if (!searchEl) return;
    searchEl.value = '';
    const kind = CLOUD_KINDS.find(k => k.key === cloudModal.kind);
    searchEl.placeholder = `Search ${kind.many.toLowerCase() === 'fakémon' ? 'Fakémon' : kind.many.toLowerCase()}...`;
}

export function filterCloudBackupModal() {
    cloudModal.search = (cloudModalEl('cloud-backup-search')?.value || '').trim().toLowerCase();
    renderCloudBackupModal();
}

export function toggleCloudBackupMon(id) {
    const picked = cloudModal.selected[cloudModal.kind];
    const key = String(id);
    if (picked.has(key)) picked.delete(key);
    else picked.add(key);
    renderCloudBackupModal();
}

export function selectAllCloudBackupMons() {
    visibleCloudModalEntries().forEach(e => cloudModal.selected[cloudModal.kind].add(String(e.id)));
    renderCloudBackupModal();
}

export function clearCloudBackupSelection() {
    visibleCloudModalEntries().forEach(e => cloudModal.selected[cloudModal.kind].delete(String(e.id)));
    renderCloudBackupModal();
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
    // Abilities/items are described by their text -- the only thing distinguishing two at a glance.
    return String(entry.desc || entry.description || 'No description').slice(0, 60);
}

function cloudModalCard(entry) {
    const id = String(entry.id);
    const picked = cloudModal.selected[cloudModal.kind].has(id);
    const isMon = cloudModal.kind === 'mons';
    const kindSpec = CLOUD_KINDS.find(k => k.key === cloudModal.kind);

    // Only Fakemon have artwork; others get their kind's icon so cards stay the same shape.
    const art = isMon
        ? (entry.artwork
            ? `<img src="${escapeHtml(entry.artwork)}" alt="${escapeHtml(entry.name || 'Fakémon')}" loading="lazy" decoding="async">`
            : '<img class="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork">')
        : `<i data-lucide="${kindSpec.icon}" style="width:18px;height:18px;"></i>`;

    // Restore mode: is it already on the device? Upload mode: does the backup hold it?
    let note = '';
    if (cloudModal.mode === 'restore') {
        const local = (state[kindSpec.local] || []).find(m => String(m?.id) === id);
        // Ticking an already-local entry overwrites it, so it reads as a warning while ticked.
        if (local) {
            note = picked
                ? '<span class="cloud-pick-note is-stale">Will replace the copy on this device</span>'
                : '<span class="cloud-pick-note">Already on this device</span>';
        }
    } else if (isMon) {
        if (isBackedUpToCloud(entry)) note = '<span class="cloud-pick-note is-saved">Backed up</span>';
        else if (ensureCloudState().byId.has(id)) note = '<span class="cloud-pick-note is-stale">Changed since backup</span>';
    } else {
        // No revision stamp for moves/abilities/items, so only "stored or not" is knowable.
        const stored = Array.isArray(cloudModal.row?.[kindSpec.column]) ? cloudModal.row[kindSpec.column] : [];
        if (stored.some(e => String(e?.id) === id)) note = '<span class="cloud-pick-note is-saved">Backed up</span>';
    }

    return `<button type="button" class="cloud-pick-card${picked ? ' selected' : ''}" onclick="toggleCloudBackupMon('${escapeHtml(id)}')" aria-pressed="${picked}">
        <span class="cloud-pick-check"><i data-lucide="${picked ? 'check' : 'plus'}" style="width:12px;height:12px;"></i></span>
        <span class="cloud-pick-art${isMon ? '' : ' cloud-pick-art-icon'}">${art}</span>
        <span class="cloud-pick-info">
            <strong>${escapeHtml(entry.name || 'Unnamed')}</strong>
            <span>${escapeHtml(entrySubtitle(entry))}</span>
            ${note}
        </span>
    </button>`;
}

function renderCloudBackupTabs() {
    const host = cloudModalEl('cloud-backup-tabs');
    if (!host) return;
    host.innerHTML = CLOUD_KINDS.map(kind => {
        const available = (cloudModal.source[kind.key] || []).length;
        const picked = cloudModal.selected[kind.key].size;
        const active = kind.key === cloudModal.kind;
        // Shows the ticked count per tab even when it's not the active one.
        return `<button type="button" class="tab${active ? ' active' : ''}" onclick="switchCloudBackupKind('${kind.key}')" ${available ? '' : 'disabled'}>
            ${escapeHtml(kind.label)}<span class="cloud-tab-count">${picked}/${available}</span>
        </button>`;
    }).join('');
}

function renderCloudBackupModal({ loading = false } = {}) {
    const grid = cloudModalEl('cloud-backup-grid');
    const title = cloudModalEl('cloud-backup-title');
    const help = cloudModalEl('cloud-backup-help');
    const confirm = cloudModalEl('cloud-backup-confirm');
    const summary = cloudModalEl('cloud-backup-summary');
    if (!grid) return;

    const uploading = cloudModal.mode === 'upload';
    if (title) title.textContent = uploading ? 'Choose what to back up' : 'Choose what to restore';
    if (help) {
        help.textContent = uploading
            ? (asCap(cloudLimits().cloudItems) === Infinity
                ? 'Your backup will hold exactly what you tick, across all four tabs. Your badges lift the item limit, so tick as many as you like.'
                : `Your backup will hold exactly what you tick, across all four tabs. Everything counts towards the same ${cloudLimits().cloudItems}-item limit.`)
            : 'Ticked entries are copied onto this device. Anything already here is left alone unless you tick it, in which case the backed-up version replaces it. Nothing is ever deleted.';
    }

    if (loading) {
        grid.innerHTML = '<div class="cloud-pick-empty">Loading your backup...</div>';
        if (confirm) confirm.disabled = true;
        return;
    }

    renderCloudBackupTabs();

    const visible = visibleCloudModalEntries();
    const kind = CLOUD_KINDS.find(k => k.key === cloudModal.kind);
    const noun = cloudModal.kind === 'mons' ? 'Fakémon' : `custom ${kind.many}`;
    grid.innerHTML = visible.length
        ? visible.map(cloudModalCard).join('')
        : `<div class="cloud-pick-empty">${(cloudModal.source[cloudModal.kind] || []).length
            ? 'Nothing here matches your search.'
            : `You have no ${noun} ${uploading ? 'yet' : 'in this backup'}.`}</div>`;

    const total = totalSelected();
    const cap = asCap(cloudLimits().cloudItems);
    const over = uploading && total > cap;

    if (summary) {
        const parts = CLOUD_KINDS
            .filter(k => cloudModal.selected[k.key].size)
            .map(k => {
                const n = cloudModal.selected[k.key].size;
                return `${n} ${n === 1 ? k.one : k.many}`;
            });
        summary.innerHTML = uploading
            ? `${parts.join(' + ') || 'Nothing selected'} = <strong class="${over ? 'cloud-over-limit' : ''}">${total}${cap === Infinity ? '' : `/${cap}`}</strong>`
            : `${parts.join(' + ') || 'Nothing selected'}`;
    }
    if (confirm) {
        confirm.disabled = uploading ? over : total === 0;
        confirm.innerHTML = uploading
            ? '<i data-lucide="cloud-upload" style="width:14px;height:14px;"></i> Save backup'
            : '<i data-lucide="cloud-download" style="width:14px;height:14px;"></i> Restore selected';
    }
    // Only upload previews the cost; in restore mode ticks are about the device, not the backup.
    renderCloudMeters(cloudModalEl('cloud-backup-meters'), uploading ? total : null);
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

/** The ticked entries of one kind, deep-copied out of their source list. */
function pickedEntries(kindKey) {
    const chosen = cloudModal.selected[kindKey];
    const source = cloudModal.mode === 'upload'
        ? (state[CLOUD_KINDS.find(k => k.key === kindKey).local] || [])
        : (cloudModal.source[kindKey] || []);
    return JSON.parse(JSON.stringify(source.filter(e => e && chosen.has(String(e.id)))));
}

export async function confirmCloudBackupModal() {
    const parts = {
        mons: pickedEntries('mons'),
        moves: pickedEntries('moves'),
        abilities: pickedEntries('abilities'),
        items: pickedEntries('items')
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
let autoBackupTimer = null;

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
        const local = new Map((localList || []).map(e => [String(e?.id), e]));
        return (storedList || [])
            .map(e => local.get(String(e?.id)))
            .filter(Boolean);
    };
    const parts = {
        mons: freshest(stored.mons, state.fakemonDB),
        moves: freshest(stored.moves, state.customMoves),
        abilities: freshest(stored.abilities, state.customAbilities),
        items: freshest(stored.items, state.customItems)
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

function meterHtml(label, used, max, hint) {
    // A bar that can never fill would be misleading, so show count + "unlimited" instead.
    if (max === Infinity) {
        return `<div class="cloud-meter is-unlimited">
            <div class="cloud-meter-head"><span>${escapeHtml(label)}</span><span>${used} / unlimited</span></div>
            ${hint ? `<div class="cloud-meter-hint">${escapeHtml(hint)}</div>` : ''}
        </div>`;
    }
    const pct = Math.min(100, Math.round((used / max) * 100));
    // Three bands rather than one colour, so nearing-full is visible before it's full.
    const tone = used >= max ? 'is-full' : (pct >= 80 ? 'is-high' : '');
    return `<div class="cloud-meter ${tone}">
        <div class="cloud-meter-head"><span>${escapeHtml(label)}</span><span>${used}/${max}</span></div>
        <div class="cloud-meter-track"><div class="cloud-meter-fill" style="width:${pct}%"></div></div>
        ${hint ? `<div class="cloud-meter-hint">${escapeHtml(hint)}</div>` : ''}
    </div>`;
}

// Shipped default only; the enforced value comes from cloudLimits() (server-resolved).
export const MAX_COMMUNITY_UPLOADS = 20;

function renderCloudMeters(host, overrideItems = null) {
    if (!host) return;
    const cs = ensureCloudState();
    const items = overrideItems ?? (cs.byId.size + cs.libraryCount);
    const published = cs.publishedCount;
    const limits = cs.limits;
    host.innerHTML = meterHtml('Cloud backup items', items, asCap(limits.cloudItems),
            'Fakemon, custom moves, abilities and items stored on our server.')
        + (published === null ? '' : meterHtml('Community uploads', published, asCap(limits.communityUploads),
            'Listings you have live on the Community Hub. Deleting one frees a slot.'));
}

/** Fills in the Settings > Data cloud backup rows. Signed-out visitors get the group hidden. */
export async function refreshCloudBackupUI({ revalidate = true } = {}) {
    const group = document.getElementById('settings-cloud-group');
    if (!group) return;
    group.style.display = state.user ? '' : 'none';
    if (!state.user) return;

    // Paint what's already known first so Settings never shows an empty panel while fetching.
    paintCloudBackupUI();
    if (!revalidate) return;

    // Refetched fresh every time rather than trusted from cache: other tabs/devices
    // can change these counts without this tab hearing about it.
    await Promise.all([refreshCloudLimits(), fetchCloudManifest(), refreshPublishedCount()]);
    paintCloudBackupUI();
    // Manifest also drives the collection grid's badges, so push a re-render there too.
    api.renderCollection?.();
}

/** Writes the current cloud state into the Settings rows. No fetching. */
function paintCloudBackupUI() {
    const group = document.getElementById('settings-cloud-group');
    if (!group || !state.user) return;

    const cs = ensureCloudState();
    const status = document.getElementById('settings-cloud-status');
    if (status) {
        status.textContent = cs.savedAt
            ? `Last backed up ${new Date(cs.savedAt).toLocaleString()} - ${cs.byId.size} Fakemon stored.`
            : (cs.loaded ? 'No cloud backup yet.' : 'Checking your cloud backup...');
    }
    const restoreBtn = document.getElementById('settings-cloud-restore-btn');
    const deleteBtn = document.getElementById('settings-cloud-delete-btn');
    if (restoreBtn) restoreBtn.disabled = !cs.savedAt;
    if (deleteBtn) deleteBtn.style.display = cs.savedAt ? '' : 'none';

    // Auto-backup row only shows for accounts allowed it, not a switch that would just fail.
    const autoRow = document.getElementById('settings-cloud-auto-row');
    if (autoRow) {
        const allowed = cs.limits.autoBackup;
        autoRow.style.display = allowed ? '' : 'none';
        const toggle = document.getElementById('settings-cloud-auto-toggle');
        if (toggle) toggle.checked = allowed && isAutoBackupOn();
        const autoStatus = document.getElementById('settings-cloud-auto-status');
        if (autoStatus) {
            autoStatus.textContent = !isAutoBackupOn() ? ''
                : (cs.savedAt
                    ? 'On. Your picks are kept current.'
                    : 'On, but there is nothing to keep current yet. Back something up once and it will take over from there.');
        }
    }

    renderCloudMeters(document.getElementById('settings-cloud-meters'));
}
