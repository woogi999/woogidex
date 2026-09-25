// Lost Fakemon recovery. Bugs in loadFromStorage() could wipe a user's
// collection (a transient IndexedDB read failure became an empty collection,
// which the very next save then made permanent). Those are fixed in
// js/core/storage.ts, but a fix doesn't undo damage already done.
//
// Recovery sources, newest-first:
//   1. The safety mirror -- a second copy of the last known-good collection
//      that storage.ts keeps in its own IndexedDB key. This is the one that
//      works for everybody.
//   2. The pre-IndexedDB localStorage collection, never deleted after the
//      migration, so it survives as an accidental backup. Only accounts old
//      enough to predate IndexedDB have one, which is why the check used to
//      report "nothing to recover" for almost everyone -- it looked here and
//      nowhere else.
//   3. The cloud backup, if the account has one. Not merged automatically;
//      the check just points at it, since restoring is the user's choice.
//
// Nothing here can help with a full site-data wipe on an account that never
// had a cloud backup.

import { state, api } from '../core/app.ts';
import { closeDialog, isDialogOpen, openDialog } from '../app/dialogs.tsx';
import { queueAutoModal } from '../core/modal-queue.ts';

const LEGACY_KEYS = ['fakemonDB_v4', 'fakemonDB_v3', 'fakemonDB_v2', 'fakemonDB'];
const DISMISSED_KEY = 'woogidex.recovery.dismissedIds.v1';

let candidates: any[] = [];        // Fakemon found in a backup but missing from the live collection
let sourceById = new Map(); // id -> human-readable origin, shown in the list

function readDismissedIds() {
    try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]')); }
    catch { return new Set(); }
}
function rememberDismissed(ids) {
    const dismissed = readDismissedIds();
    ids.forEach(id => dismissed.add(String(id)));
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed])); } catch { /* private mode */ }
}

function describeDate(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch { return ''; }
}

/**
 * Every backup copy of the collection this device can still reach, best first.
 */
async function collectSnapshots(): Promise<Array<{label: string, mons: Record<string, any>[]}>> {
    const snapshots: any[] = [];

    // The safety mirror is the most recent and the most complete, so it goes first:
    // whichever snapshot offers an id first is the copy the user is shown.
    try {
        const mirror = await api.readCollectionMirror?.();
        if (mirror?.fakemonDB?.length) {
            const when = describeDate(mirror.savedAt);
            snapshots.push({ label: when ? `device backup, ${when}` : 'device backup', mons: mirror.fakemonDB });
        }
    } catch { /* mirror is best-effort by design */ }

    for (const key of LEGACY_KEYS) {
        let raw;
        try { raw = localStorage.getItem(key); } catch { continue; }
        if (!raw) continue;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }
        if (Array.isArray(parsed) && parsed.length) snapshots.push({ label: 'older browser backup', mons: parsed });
    }

    return snapshots;
}

/**
 * Everything in a backup that the live collection does not have, keyed by id so
 * the same Fakemon found in two snapshots is only offered once.
 * @param knownIds ids already in the live collection
 */
async function scanSnapshots(knownIds: Set<string>): Promise<Map<string, Record<string, any>>> {
    const found = new Map();
    sourceById = new Map();
    for (const snapshot of await collectSnapshots()) {
        for (const mon of snapshot.mons) {
            if (!mon || typeof mon !== 'object') continue;
            const id = String(mon.id ?? '').trim();
            if (!id || knownIds.has(id) || found.has(id)) continue;
            found.set(id, mon);
            sourceById.set(id, snapshot.label);
        }
    }
    return found;
}

function liveIds() {
    return new Set((state.fakemonDB || []).map(f => String(f.id)));
}

/**
 * Called once at boot. Shows the recovery modal if it finds anything the
 * user has not already dismissed. Safe to call unconditionally.
 * @returns whether a modal was queued
 */
export async function checkForLostFakemon(): Promise<boolean> {
    // A failed read looks exactly like an empty collection here, and every
    // Fakemon in every backup would be offered as "lost". Say nothing instead;
    // storage.ts has already told the user to reload.
    if (api.isCollectionLoaded && !api.isCollectionLoaded()) return false;

    const found = await scanSnapshots(liveIds());
    if (!found.size) return false;

    const dismissed = readDismissedIds();
    candidates = [...found.values()].filter(m => !dismissed.has(String(m.id)));
    if (!candidates.length) return false;

    queueAutoModal(openRecoveryModal);
    return true;
}

/** Manual re-check from Settings; ignores prior dismissals unlike the boot check. */
export async function manualCheckForLostFakemon() {
    if (api.isCollectionLoaded && !api.isCollectionLoaded()) {
        api.showToast?.("We can't read your saved collection right now, so there's nothing safe to compare against. Please reload the page and try again.", 'error');
        return;
    }

    const found = await scanSnapshots(liveIds());
    if (!found.size) {
        await reportNothingFoundLocally();
        return;
    }
    candidates = [...found.values()];
    // A manual check is a direct request, so open now rather than going through
    // the auto-modal queue, which defers behind any other open dialog and gives
    // up entirely after a few minutes -- the button looked broken when it did.
    openRecoveryModal();
}

/**
 * No local backup had anything. If the account has a cloud backup, that is a
 * real second chance, so offer it instead of a dead-end "nothing to recover".
 */
async function reportNothingFoundLocally() {
    let hasCloud = false;
    try {
        if (state.user) hasCloud = !!(await api.fetchCloudBackup?.());
    } catch { /* offline or signed out; fall through to the plain message */ }

    if (hasCloud) {
        api.showToast?.('No missing Fakemon in this device’s backups. Opening your cloud backup so you can check there too.', 'info');
        api.openCloudBackupModal?.('restore');
        return;
    }
    api.showToast?.(
        state.user
            ? 'Nothing to recover: your collection matches every backup copy on this device, and this account has no cloud backup yet.'
            : 'Nothing to recover: your collection matches every backup copy on this device. Sign in to check a cloud backup as well.',
        'info'
    );
}

// ==================== "something is wrong with your collection" ====================
// Three situations, one modal. All three share the same advice, because in all
// three the dangerous thing is the same: carrying on and creating or editing
// Fakemon writes over data that is very likely still recoverable.
//
// Saving is already blocked by js/core/storage.ts in the first two cases. This
// is the part that tells the user why, before they go looking for the reason in
// an empty collection screen.

const WARNING_REOPEN_COOLDOWN_MS = 15000;
let lastWarningShownAt = 0;

const WARNING_KINDS = new Set(['load-failed', 'wiped', 'stale-tab']);

/**
 * Opens the warning for `kind`, unless it is already up or was just dismissed.
 * @param kind
 */
function openCollectionWarning(kind: 'load-failed'|'wiped'|'stale-tab') {
    if (!WARNING_KINDS.has(kind)) return;
    // saveToStorage() calls in here on every refused write, and a refused write
    // happens on every keystroke in the editor; without this the dialog would
    // reopen the instant the user closed it
    if (isDialogOpen('collection-warning')) return;
    if (Date.now() - lastWarningShownAt < WARNING_REOPEN_COOLDOWN_MS) {
        api.showToast?.('Saving is switched off until you reload the page.', 'error');
        return;
    }
    lastWarningShownAt = Date.now();
    openDialog('collection-warning', { kind });
}

export function closeCollectionWarning() {
    closeDialog('collection-warning');
}

/** The warning's recovery button: close it and run the full scan straight away. */
export async function checkForLostFakemonFromWarning() {
    closeCollectionWarning();
    await manualCheckForLostFakemon();
}

/** The warning's way out for a collection that really is supposed to be empty. */
export function confirmCollectionIsEmpty() {
    api.acknowledgeEmptyCollection?.();
    closeCollectionWarning();
    api.showToast?.('Got it. Saving is back on, and we will not ask again.', 'success');
}

/**
 * Boot check, ahead of the lost-Fakemon scan. Returns true when it showed
 * something, in which case its own buttons drive whatever happens next.
 */
export function maybeWarnAboutCollectionHealth() {
    if (api.isCollectionLoaded && !api.isCollectionLoaded()) { openCollectionWarning('load-failed'); return true; }
    if (api.isCollectionWipeSuspected?.()) { openCollectionWarning('wiped'); return true; }
    return false;
}

/** Called by saveToStorage() when it refuses a write. */
export function warnCollectionLooksWiped() { openCollectionWarning('wiped'); }
export function warnCollectionLoadFailed() { openCollectionWarning('load-failed'); }
export function warnStaleTab() { openCollectionWarning('stale-tab'); }

function openRecoveryModal() {
    openDialog('lost-fakemon', {
        candidates: candidates.map(m => ({ id: String(m.id), name: m.name || 'Unnamed Fakemon', species: m.species || '', artwork: m.artwork || '', source: sourceById.get(String(m.id)) || '' }))
    });
}

/** Not Now: declined items aren't offered again at the next boot. */
export function closeRecoveryModal() {
    closeDialog('lost-fakemon');
    rememberDismissed(candidates.map(m => m.id)); // don't nag every boot for declined items
    api.maybeShowSiteTransferNotice?.();
}

/** Restore Selected: the ticked ones go back into the collection. */
export async function restoreSelectedFakemon(selectedIds: any[] = []) {
    const selected = new Set(selectedIds.map(String));
    const toRestore = candidates.filter(m => selected.has(String(m.id)));
    rememberDismissed(candidates.map(m => m.id));
    closeDialog('lost-fakemon');

    if (!toRestore.length) {
        api.maybeShowSiteTransferNotice?.();
        return;
    }

    // matched by name, not id -- the recovered copy's id is always new (that's why it was offered)
    const existingNames = new Set(state.fakemonDB.map(f => String(f.name || '').trim().toLowerCase()));
    const newlyDuplicated: any[] = [];
    for (const mon of toRestore) {
        const nameKey = String(mon.name || '').trim().toLowerCase();
        if (nameKey && existingNames.has(nameKey)) newlyDuplicated.push(mon);
        state.fakemonDB.push(JSON.parse(JSON.stringify(mon)));
    }
    // a restored Fakemon can reference custom moves/abilities/items that went
    // missing with it; this rebuilds those library entries from the Fakemon itself
    try { api.migrateCustomLibrariesFromCollection?.(); } catch { /* best effort */ }
    // a restore that was not written is not a restore; saveToStorage() refuses
    // to write when it could not read the stored collection first
    const saved = await api.saveToStorage?.();
    api.renderCollection?.();
    if (saved === false) {
        api.showToast?.('Your Fakemon are back on screen but could not be saved. Reload the page and try again before editing anything.', 'error');
    } else {
        api.showToast?.(`Restored ${toRestore.length} Fakemon.`, 'success');
    }

    if (newlyDuplicated.length) {
        openDuplicateModal(newlyDuplicated);
    } else {
        api.maybeShowSiteTransferNotice?.();
    }
}

// ==================== possible duplicates ====================
// A recovered Fakemon can share a name with an existing one (often recreated
// by hand after being lost). We don't guess which copy is "right" -- just
// surface the collision.
/** Pairs of the same name, now twice in the collection. */
function openDuplicateModal(restored) {
    const pairs = restored
        .map(m => ({ recoveredId: String(m.id), name: m.name || 'Unnamed Fakemon' }))
        .filter(p => state.fakemonDB.some(f => String(f.id) !== p.recoveredId
            && String(f.name || '').trim().toLowerCase() === p.name.trim().toLowerCase()));
    if (!pairs.length) { api.maybeShowSiteTransferNotice?.(); return; }
    openDialog('duplicate-fakemon', { pairs });
}

export function closeDuplicateModal() {
    closeDialog('duplicate-fakemon');
    api.maybeShowSiteTransferNotice?.();
}

/** Deletes a recovered copy (the dialog then drops its row). */
export async function deleteRecoveredDuplicate(id) {
    state.fakemonDB = state.fakemonDB.filter(f => String(f.id) !== String(id));
    await api.saveToStorage?.({ allowEmpty: true });
    api.renderCollection?.();
}
