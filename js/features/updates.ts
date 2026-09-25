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
// Add the new file's name to the top of its "updates" array. The page is
// js/app/pages/UpdatesPage.tsx.

import { notify } from '../app/store.ts';
import { log } from '../core/log.ts';
import { api } from '../core/app.ts';

export interface Update { id: string; version: string; date: string; title: string; items: string[]; }
export type UpdatesTab = 'updates' | 'credits';

const INDEX_URL = 'updates/index.json';
const SEEN_KEY = 'woogidex.updates.lastSeen.v1';

let UPDATES: Update[] = [];
let updatesLoaded = false;
let updatesLoading: Promise<Update[]> | null = null;
let indexCache: string[] | null = null;
let indexLoading: Promise<string[]> | null = null;

// ==================== parsing ====================
/**
 * Splits one update file into its front matter and its bullet list.
 * @param text the file's contents
 * @param id the file name, which is also the update's identity
 */
export function parseUpdateFile(text: string, id = ''): Update {
    const source = String(text || '');
    const update: Update = { id, version: '', date: '', title: '', items: [] };

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
async function loadUpdatesIndex(forceReload = false): Promise<string[]> {
    if (indexCache && !forceReload) return indexCache;
    if (indexLoading && !forceReload) return indexLoading;

    indexLoading = fetch(`${INDEX_URL}?v=${Date.now()}`, { cache: 'no-store' })
        .then(response => {
            if (!response.ok) throw new Error(`Could not load ${INDEX_URL} (${response.status})`);
            return response.json();
        })
        .then(data => {
            indexCache = (Array.isArray(data?.updates) ? data.updates : []).filter(Boolean).map(String);
            return indexCache!;
        })
        .finally(() => { indexLoading = null; });

    return indexLoading;
}

export async function loadUpdates(forceReload = false): Promise<Update[]> {
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
        UPDATES = files.filter((u): u is Update => !!u);
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
function readLastSeen(): string {
    try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; }
}

function writeLastSeen(id: string) {
    try { localStorage.setItem(SEEN_KEY, id); } catch { /* private mode */ }
}

/**
 * @param names the running order, newest first
 * @returns entries newer than the last one seen
 */
export function countUnread(names: string[] | null, lastSeen: string): number {
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

let unreadUpdates = 0;

/** The number on the header's Updates tab. */
export function updatesUnreadCount(): number { return unreadUpdates; }

function renderUpdatesBadge(count: number) {
    unreadUpdates = count;
    notify();
}

/**
 * Fills in the unread count on the header's Updates tab. The badge is the
 * nudge; nothing opens on its own. A never-recorded last-seen id means first
 * visit, so it's marked caught up silently rather than showing the whole
 * history as unread.
 */
export async function refreshUpdatesBadge(): Promise<number> {
    let names: string[];
    try { names = await loadUpdatesIndex(); }
    catch (e) { log.error('UPDATES', 'Could not load the update index', e); return 0; }
    if (!names.length) return 0;

    const lastSeen = readLastSeen();
    if (!lastSeen) { writeLastSeen(names[0]); renderUpdatesBadge(0); return 0; }

    const unread = countUnread(names, lastSeen);
    renderUpdatesBadge(unread);
    return unread;
}

// ==================== the page ====================
// what was unread when the page was opened: read before it marks everything
// seen, so this visit still shows the new entries as new
let unreadOnOpen = new Set<string>();

export function unreadUpdateIds(): Set<string> {
    return unreadOnOpen;
}

/** Opens the Updates & Credits page on one of its tabs. */
export async function openUpdatesPage(tab: string = 'updates') {
    const which: UpdatesTab = tab === 'credits' ? 'credits' : 'updates';
    const alreadyOpen = document.getElementById('updates-view')?.style.display === 'block';
    if (!alreadyOpen) {
        try { await loadUpdatesIndex(); } catch { /* the page shows the error */ }
        const names = indexCache || [];
        unreadOnOpen = new Set(names.slice(0, countUnread(names, readLastSeen())));
        api.activateTopLevelView?.('updates-view');
    }
    api.setRoute?.(which === 'credits' ? 'updates/credits' : 'updates', which === 'credits' ? 'Credits' : 'Updates');
    if (which === 'updates') markUpdatesRead();
}

// the old modal entry points, still called from elsewhere; both are the page now
export const openUpdatesModal = () => openUpdatesPage('updates');
export const openCreditsModal = () => openUpdatesPage('credits');
