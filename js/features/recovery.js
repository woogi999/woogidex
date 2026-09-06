// Lost Fakemon recovery. A now-fixed bug in loadFromStorage() could wipe a
// user's collection on a transient IndexedDB read failure, but doesn't undo
// damage already done.
//
// Recovery source: the old pre-IndexedDB localStorage collection was never
// deleted after migrating to IndexedDB, so it survives as an accidental
// backup. This scans it for anything missing from the live collection.
//
// Only helps the IndexedDB-lost-it/localStorage-still-has-it case -- not full
// site-data wipes or accounts that never had a pre-IndexedDB snapshot.

import { state, api } from '../core/app.js';
import { esc } from '../core/html.js';
import { queueAutoModal } from '../core/modal-queue.js';

const LEGACY_KEYS = ['fakemonDB_v4', 'fakemonDB_v3', 'fakemonDB_v2', 'fakemonDB'];
const DISMISSED_KEY = 'woogidex.recovery.dismissedIds.v1';

let candidates = [];        // legacy-snapshot Fakemon missing from the live collection
let selected = new Set();   // ids checked in the modal
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

/**
 * Every Fakemon sitting in a legacy localStorage snapshot that the live
 * collection does not have, keyed by id so the same Fakemon found under two
 * different legacy keys is only offered once.
 * @param {Set<string>} knownIds ids already in the live collection
 * @returns {Map<string, object>}
 */
function scanLegacySnapshots(knownIds) {
    const found = new Map();
    for (const key of LEGACY_KEYS) {
        let raw;
        try { raw = localStorage.getItem(key); } catch { continue; }
        if (!raw) continue;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }
        if (!Array.isArray(parsed)) continue;
        for (const mon of parsed) {
            if (!mon || typeof mon !== 'object') continue;
            const id = String(mon.id ?? '').trim();
            if (!id || knownIds.has(id) || found.has(id)) continue;
            found.set(id, mon);
        }
    }
    return found;
}

/**
 * Called once at boot. Shows the recovery modal if it finds anything the
 * user has not already dismissed. Safe to call unconditionally.
 * @returns {boolean} whether the modal was shown
 */
export function checkForLostFakemon() {
    const known = new Set(state.fakemonDB.map(f => String(f.id)));
    const found = scanLegacySnapshots(known);
    if (!found.size) return false;

    const dismissed = readDismissedIds();
    candidates = [...found.values()].filter(m => !dismissed.has(String(m.id)));
    if (!candidates.length) return false;

    queueAutoModal(openRecoveryModal);
    return true;
}

/** Manual re-check from Settings; ignores prior dismissals unlike the boot check. */
export function manualCheckForLostFakemon() {
    const known = new Set(state.fakemonDB.map(f => String(f.id)));
    const found = scanLegacySnapshots(known);
    if (!found.size) {
        api.showToast?.('Nothing to recover. Your collection matches every backup copy we could find.', 'info');
        return;
    }
    candidates = [...found.values()];
    queueAutoModal(openRecoveryModal);
}

function renderRecoveryList() {
    const list = document.getElementById('recovery-list');
    if (!list) return;
    if (!candidates.length) { list.innerHTML = '<p class="recovery-empty">Nothing left to recover.</p>'; return; }
    list.innerHTML = candidates.map(m => {
        const id = String(m.id);
        const name = m.name || 'Unnamed Fakemon';
        const species = m.species ? ` &middot; ${esc(m.species)}` : '';
        return `<label class="recovery-row">
            <input type="checkbox" ${selected.has(id) ? 'checked' : ''} onchange="toggleRecoveryCandidate('${id}')">
            ${m.artwork ? `<img class="recovery-thumb" src="${esc(m.artwork)}" alt="">` : '<span class="recovery-thumb recovery-thumb-empty"><i data-lucide="help-circle"></i></span>'}
            <span class="recovery-row-text"><strong>${esc(name)}</strong>${species}</span>
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
        state.fakemonDB.push(mon);
    }
    await api.saveToStorage?.();
    api.renderCollection?.();
    api.showToast?.(`Restored ${toRestore.length} Fakemon.`, 'success');

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
    await api.saveToStorage?.();
    api.renderCollection?.();
    dupePairs = dupePairs.filter(p => p.recoveredId !== id);
    if (!dupePairs.length) { closeDuplicateModal(); return; }
    renderDuplicateList();
}
