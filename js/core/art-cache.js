// Community artwork is a base64 data URI in a jsonb column (DB egress, not a
// static file), so the browser can't cache it as an image on its own. This
// persists artwork across reloads using Cache Storage rather than IndexedDB
// since it evicts gracefully under storage pressure and net-cache.js already
// uses it for the Showdown datasets.

const CACHE_NAME = 'woogidex-art-v1';
// URL form because Cache Storage keys on Requests; unroutable host (RFC 2606)
// so nothing ever actually fetches these.
const KEY_PREFIX = 'https://artwork.woogidex.invalid/';
// republishing writes a new row, so a cached entry keyed by row id rarely goes
// stale; a week bounds the case where an existing row's artwork is updated in place
const MAX_AGE_MS = 7 * 86400000;

let cachePromise = null;

// null wherever Cache Storage is unavailable (insecure origin, file://,
// private mode); callers below degrade to the network in that case.
function openCache() {
    if (cachePromise) return cachePromise;
    cachePromise = (async () => {
        try {
            if (typeof caches === 'undefined') return null;
            return await caches.open(CACHE_NAME);
        } catch {
            return null;
        }
    })();
    return cachePromise;
}

const keyFor = id => KEY_PREFIX + encodeURIComponent(String(id));

/**
 * @param {string} id published_mons row id
 * @returns {Promise<string|null>} the stored data URI, or null on a miss
 */
export async function getCachedArt(id) {
    if (!id) return null;
    const cache = await openCache();
    if (!cache) return null;
    try {
        const hit = await cache.match(keyFor(id));
        if (!hit) return null;
        const storedAt = Number(hit.headers.get('x-cached-at') || 0);
        if (!storedAt || Date.now() - storedAt > MAX_AGE_MS) {
            await cache.delete(keyFor(id)).catch(() => {});
            return null;
        }
        return await hit.text();
    } catch {
        return null;
    }
}

/**
 * Stores one artwork. Empty strings are stored too: "this row has no artwork"
 * is worth remembering, and it is what stops a thumbnail-less post being
 * re-requested on every scroll past it.
 * @param {string} id
 * @param {string} dataUri
 */
export async function putCachedArt(id, dataUri) {
    if (!id) return;
    const cache = await openCache();
    if (!cache) return;
    try {
        await cache.put(keyFor(id), new Response(String(dataUri ?? ''), {
            headers: { 'x-cached-at': String(Date.now()) }
        }));
    } catch {
        // quota exceeded, or write refused; worst case is a re-download later
    }
}

/** Looks up many at once. Returns a Map of id -> data URI for the hits only. */
export async function getCachedArtBatch(ids) {
    const found = new Map();
    const cache = await openCache();
    if (!cache) return found;
    await Promise.all([...ids].map(async id => {
        const art = await getCachedArt(id);
        if (art !== null) found.set(id, art);
    }));
    return found;
}

/** Forgets one entry -- used when a listing is known to have changed. */
export async function dropCachedArt(id) {
    const cache = await openCache();
    if (!cache) return;
    try { await cache.delete(keyFor(id)); } catch { /* nothing to do */ }
}
