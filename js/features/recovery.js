// Lost Fakemon recovery. Bugs in loadFromStorage() could wipe a user's
// collection (a transient IndexedDB read failure became an empty collection,
// which the very next save then made permanent). Those are fixed in
// js/core/storage.js, but a fix doesn't undo damage already done.
//
// Recovery sources, newest-first:
//   1. The safety mirror -- a second copy of the last known-good collection
//      that storage.js keeps in its own IndexedDB key. This is the one that
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

import { state, api } from '../core/app.js';
import { esc } from '../core/html.js';
import { queueAutoModal } from '../core/modal-queue.js';

const LEGACY_KEYS = ['fakemonDB_v4', 'fakemonDB_v3', 'fakemonDB_v2', 'fakemonDB'];
const DISMISSED_KEY = 'woogidex.recovery.dismissedIds.v1';

let candidates = [];        // Fakemon found in a backup but missing from the live collection
let selected = new Set();   // ids checked in the modal
let sourceById = new Map(); // id -> human-readable origin, shown in the list
let dupePairs = [];         // { recoveredId, name } pairs needing a decision

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
 * @returns {Promise<Array<{label: string, mons: object[]}>>}
 */
async function collectSnapshots() {
    const snapshots = [];

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
 * @param {Set<string>} knownIds ids already in the live collection
 * @returns {Promise<Map<string, object>>}
 */
async function scanSnapshots(knownIds) {
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
 * @returns {Promise<boolean>} whether a modal was queued
 */
export async function checkForLostFakemon() {
    // A failed read looks exactly like an empty collection here, and every
    // Fakemon in every backup would be offered as "lost". Say nothing instead;
    // storage.js has already told the user to reload.
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

function renderRecoveryList() {
    const list = document.getElementById('recovery-list');
    if (!list) return;
    if (!candidates.length) { list.innerHTML = '<p class="recovery-empty">Nothing left to recover.</p>'; return; }
    list.innerHTML = candidates.map(m => {
        const id = String(m.id);
        const name = m.name || 'Unnamed Fakemon';
        const bits = [];
        if (m.species) bits.push(esc(m.species));
        const source = sourceById.get(id);
        if (source) bits.push(esc(source));
        const meta = bits.length ? ` &middot; ${bits.join(' &middot; ')}` : '';
        return `<label class="recovery-row">
            <input type="checkbox" ${selected.has(id) ? 'checked' : ''} onchange="toggleRecoveryCandidate('${id}')">
            ${m.artwork ? `<img class="recovery-thumb" src="${esc(m.artwork)}" alt="">` : '<span class="recovery-thumb recovery-thumb-empty"><i data-lucide="help-circle"></i></span>'}
            <span class="recovery-row-text"><strong>${esc(name)}</strong>${meta}</span>
        </label>`;
    }).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function openRecoveryModal() {
    selected = new Set(candidates.map(m => String(m.id)));
    renderRecoveryList();
    const modal = document.getElementById('lost-fakemon-modal');
    if (!modal) return;
    modal.classList.add('active');
    document.body.classList.add('modal-open');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

export function closeRecoveryModal() {
    document.getElementById('lost-fakemon-modal')?.classList.remove('active');
    document.body.classList.remove('modal-open');
    rememberDismissed(candidates.map(m => m.id)); // don't nag every boot for declined items
    api.maybeShowSiteTransferNotice?.();
}

export function toggleRecoveryCandidate(id) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
}

export async function restoreSelectedFakemon() {
    const toRestore = candidates.filter(m => selected.has(String(m.id)));
    rememberDismissed(candidates.map(m => m.id));
    document.getElementById('lost-fakemon-modal')?.classList.remove('active');

    if (!toRestore.length) {
        document.body.classList.remove('modal-open');
        api.maybeShowSiteTransferNotice?.();
        return;
    }

    // matched by name, not id -- the recovered copy's id is always new (that's why it was offered)
    const existingNames = new Set(state.fakemonDB.map(f => String(f.name || '').trim().toLowerCase()));
    const newlyDuplicated = [];
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
        document.body.classList.remove('modal-open');
        api.maybeShowSiteTransferNotice?.();
    }
}

// ==================== possible duplicates ====================
// A recovered Fakemon can share a name with an existing one (often recreated
// by hand after being lost). We don't guess which copy is "right" -- just
// surface the collision.
function renderDuplicateList() {
    const list = document.getElementById('duplicate-list');
    if (!list) return;
    list.innerHTML = dupePairs.map(p => `
        <div class="recovery-dupe-row">
            <span><strong>${esc(p.name)}</strong> now exists twice in your collection.</span>
            <button type="button" class="btn btn-secondary btn-sm" onclick="deleteRecoveredDuplicate('${p.recoveredId}')">Delete the Recovered Copy</button>
        </div>`).join('');
}

function openDuplicateModal(restored) {
    dupePairs = restored
        .map(m => ({ recoveredId: String(m.id), name: m.name || 'Unnamed Fakemon' }))
        .filter(p => state.fakemonDB.some(f => String(f.id) !== p.recoveredId
            && String(f.name || '').trim().toLowerCase() === p.name.trim().toLowerCase()));
    if (!dupePairs.length) { api.maybeShowSiteTransferNotice?.(); return; }

    renderDuplicateList();
    const modal = document.getElementById('duplicate-fakemon-modal');
    if (!modal) return;
    modal.classList.add('active');
    document.body.classList.add('modal-open');
}

export function closeDuplicateModal() {
    document.getElementById('duplicate-fakemon-modal')?.classList.remove('active');
    document.body.classList.remove('modal-open');
    api.maybeShowSiteTransferNotice?.();
}

export async function deleteRecoveredDuplicate(id) {
    state.fakemonDB = state.fakemonDB.filter(f => String(f.id) !== id);
    await api.saveToStorage?.({ allowEmpty: true });
    api.renderCollection?.();
    dupePairs = dupePairs.filter(p => p.recoveredId !== id);
    if (!dupePairs.length) { closeDuplicateModal(); return; }
    renderDuplicateList();
}
