// ==================== updates ====================
// One file per update, under public/updates/, listed newest first in
// public/updates/index.json. Adding a release means adding a markdown file
// rather than editing one growing changelog file.
//
// public/updates/<slug>.md:
//
//     ---
//     version: v1.25.0
//     date: September 1, 2026
//     title: What changed
//     ---
//
//     - Something that changed.
//     - Something else, with **bold** allowed.
//
// A static host cannot list a directory, so index.json is the running order.
// Add the new file's name to the top of its "updates" array.

import { log } from '../core/log.js';
import { queueAutoModal } from '../core/modal-queue.js';

const INDEX_URL = 'updates/index.json';
const SEEN_KEY = 'woogidex.updates.lastSeen.v1';

let UPDATES = [];
let updatesLoaded = false;
let updatesLoading = null;
let indexCache = null;
let indexLoading = null;

// ==================== parsing ====================
/**
 * Splits one update file into its front matter and its bullet list.
 * @param {string} text the file's contents
 * @param {string} id the file name, which is also the update's identity
 */
export function parseUpdateFile(text, id = '') {
    const source = String(text || '');
    const update = { id, version: '', date: '', title: '', items: [] };

    // front matter is optional -- a file without it still shows its bullets
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    const body = match ? source.slice(match[0].length) : source;
    if (match) {
        for (const line of match[1].split(/\r?\n/)) {
            const at = line.indexOf(':');
            if (at === -1) continue;
            const key = line.slice(0, at).trim().toLowerCase();
            const value = line.slice(at + 1).trim();
            if (key === 'version' || key === 'date' || key === 'title') update[key] = value;
        }
    }

    for (const raw of body.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (/^[-*]\s+/.test(line)) update.items.push(line.replace(/^[-*]\s+/, ''));
        else if (update.items.length) update.items[update.items.length - 1] += ' ' + line; // wrapped continuation line
    }
    return update;
}

// ==================== loading ====================
/** The running order, newest first. One small request. */
async function loadUpdatesIndex(forceReload = false) {
    if (indexCache && !forceReload) return indexCache;
    if (indexLoading && !forceReload) return indexLoading;

    indexLoading = fetch(`${INDEX_URL}?v=${Date.now()}`, { cache: 'no-store' })
        .then(response => {
            if (!response.ok) throw new Error(`Could not load ${INDEX_URL} (${response.status})`);
            return response.json();
        })
        .then(data => {
            indexCache = (Array.isArray(data?.updates) ? data.updates : []).filter(Boolean).map(String);
            return indexCache;
        })
        .finally(() => { indexLoading = null; });

    return indexLoading;
}

export async function loadUpdates(forceReload = false) {
    if (updatesLoading && !forceReload) return updatesLoading;
    if (updatesLoaded && !forceReload) return UPDATES;

    updatesLoading = (async () => {
        const names = await loadUpdatesIndex(forceReload);
        // parallel fetch -- small, independent files; nothing renders until the last lands anyway
        const files = await Promise.all(names.map(async name => {
            try {
                const response = await fetch(`updates/${name}`, { cache: 'no-store' });
                if (!response.ok) throw new Error(String(response.status));
                return parseUpdateFile(await response.text(), name);
            } catch (e) {
                // one unreadable file shouldn't blank the whole changelog
                log.error('UPDATES', 'Could not load an update file', { name, error: String(e) });
                return null;
            }
        }));
        UPDATES = files.filter(Boolean);
        updatesLoaded = true;
        return UPDATES;
    })()
        .catch(error => {
            log.error('UPDATES', 'Failed to load updates', error);
            UPDATES = [];
            updatesLoaded = false;
            throw error;
        })
        .finally(() => { updatesLoading = null; });

    return updatesLoading;
}

// ==================== read / unread ====================
// "unread" = entries above the last-seen id in the ordered index -- only
// needs index.json, so the badge never downloads the full changelog.
function readLastSeen() {
    try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; }
}

function writeLastSeen(id) {
    try { localStorage.setItem(SEEN_KEY, id); } catch { /* private mode */ }
}

/**
 * @param {string[]} names the running order, newest first
 * @returns {number} entries newer than the last one seen
 */
export function countUnread(names, lastSeen) {
    if (!names?.length) return 0;
    if (!lastSeen) return names.length;
    const at = names.indexOf(lastSeen);
    // a last-seen id no longer in the index (renamed/withdrawn file) means caught up, not "everything is new"
    return at === -1 ? 0 : at;
}

export function markUpdatesRead() {
    const names = indexCache || [];
    if (names.length) writeLastSeen(names[0]);
    renderUpdatesBadge(0);
}

function renderUpdatesBadge(count) {
    const badge = document.getElementById('updates-badge');
    if (!badge) return;
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.style.display = count > 0 ? 'flex' : 'none';
}

/**
 * Fills in the sidebar's unread count, opens the modal when there's something new.
 * A never-recorded last-seen id means first visit, so it's marked caught up
 * silently rather than showing the whole history as unread.
 */
export async function refreshUpdatesBadge({ autoOpen = false } = {}) {
    let names;
    try { names = await loadUpdatesIndex(); }
    catch (e) { log.error('UPDATES', 'Could not load the update index', e); return 0; }
    if (!names.length) return 0;

    const lastSeen = readLastSeen();
    if (!lastSeen) { writeLastSeen(names[0]); renderUpdatesBadge(0); return 0; }

    const unread = countUnread(names, lastSeen);
    renderUpdatesBadge(unread);

    // queued -- other boot-time notices take priority over a changelog
    if (autoOpen && unread > 0) queueAutoModal(openUpdatesModal);
    return unread;
}

// ==================== the panel ====================
import { mountIsland } from '../react/island.jsx';
import { UpdatesPanel } from '../react/UpdatesPanel.jsx';

// React island: openUpdatesModal() just opens the modal and hands the loader
// to the component, which owns loading/error/empty/list states.
// #updates-modal-body lives in index.html's shell (not a views/ fragment), so
// it survives innerHTML replacement and can be mounted on demand.
const UPDATES_ISLAND = 'updates-modal-body';

export function renderUpdates() {
    // re-mounting re-runs the load, which is what a caller asking for a re-render wants
    if (!document.getElementById(UPDATES_ISLAND)) return;
    mountIsland(UPDATES_ISLAND, UpdatesPanel, { load: loadIslandUpdates, unreadIds: unreadIdSet() });
}

// read before the modal marks everything seen, so opening it still shows what was unread
function unreadIdSet() {
    const names = indexCache || [];
    const unread = countUnread(names, readLastSeen());
    return new Set(names.slice(0, unread));
}

// keeps the component from touching the cache/fetch directly
async function loadIslandUpdates() {
    await loadUpdates();
    return UPDATES;
}

export async function openUpdatesModal() {
    const modal = document.getElementById('updates-modal');
    if (!modal) return;

    modal.classList.add('active');
    document.body.classList.add('modal-open');
    renderUpdates();
    markUpdatesRead(); // after renderUpdates() so unread entries still show as new in this view
}

export function closeUpdatesModal() {
    const modal = document.getElementById('updates-modal');
    if (!modal) return;
    modal.classList.remove('active');
    document.body.classList.remove('modal-open');
}

window.openUpdatesModal = openUpdatesModal;
window.closeUpdatesModal = closeUpdatesModal;
window.renderUpdates = renderUpdates;
window.loadUpdates = loadUpdates;
window.refreshUpdatesBadge = refreshUpdatesBadge;
window.markUpdatesRead = markUpdatesRead;
