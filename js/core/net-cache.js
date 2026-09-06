// The Showdown datasets (~4.3 MB/page load) send no Cache-Control from their
// CDN, so the browser re-downloaded them every visit. This uses Cache Storage
// to keep a copy and only refetches once it's older than `maxAgeMs`. See
// stamped() for why age is tracked in our own header rather than `Date`.
// Falls back to a plain fetch where Cache Storage is unavailable, and to a
// stale copy rather than failing when the network is down.

const DAY = 86400000;

export async function cachedFetch(url, { cacheName = 'woogidex-http-v1', maxAgeMs = DAY } = {}) {
    let cache = null;
    try {
        if (typeof caches !== 'undefined') cache = await caches.open(cacheName);
    } catch {
        cache = null;                // storage blocked; just use the network
    }
    if (!cache) return fetch(url);

    const hit = await cache.match(url).catch(() => null);
    if (hit && !isStale(hit, maxAgeMs)) return hit;

    try {
        const res = await fetch(url);
        // put() rejects on opaque/partial responses; don't fail the request over it
        if (res.ok) await cache.put(url, await stamped(res.clone())).catch(() => {});
        return res;
    } catch (err) {
        if (hit) return hit;        // offline: a stale dataset beats no dataset
        throw err;
    }
}

const STAMP = 'x-woogidex-cached-at';

// `Date` isn't a CORS-safelisted response header and these CDNs don't expose
// it, so reading it returned null cross-origin and every entry looked stale.
// Stamping our own header sidesteps that.
async function stamped(response) {
    const headers = new Headers(response.headers);
    headers.set(STAMP, String(Date.now()));
    return new Response(await response.blob(), {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

function isStale(response, maxAgeMs) {
    const stamp = Number(response.headers.get(STAMP));
    // undated entries (pre-dating this stamp, or header dropped) get refetched once
    if (!Number.isFinite(stamp) || !stamp) return true;
    return Date.now() - stamp > maxAgeMs;
}
