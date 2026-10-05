// The service worker: keeps Woogidex usable offline.
//
// Built into dist/sw.js by the woogidex-service-worker plugin in
// vite.config.js, which fills in __VERSION__ and __PRECACHE__ (the app shell
// for this exact build). Registered by js/core/offline.ts.
//
// What works offline: the collection, the editor and its tools, analysis,
// regions, exports and settings -- everything that lives on this device.
// What doesn't: anything that talks to our server (sign-in, community,
// messages, events, battles). Those requests are never touched here, so they
// fail the same way they would without a service worker.
//
// Strategies:
//   page loads          network first, the cached app shell when offline or slow
//   /bundle/*           cache first (file names are content hashes)
//   other site files    stale-while-revalidate (emojis, type icons, updates)
//   sprites, fonts      stale-while-revalidate, CORS responses only, capped
//
// Opaque (no-CORS) responses are never stored: Chrome counts each one as
// several MB against the site's quota, and running out of quota is what lets
// the browser evict IndexedDB -- which is where the collection lives.

const VERSION = __VERSION__;
const PRECACHE = __PRECACHE__;

const SHELL = `woogidex-shell-${VERSION}`;
const SHELL_PREFIX = 'woogidex-shell-';
const RUNTIME = 'woogidex-runtime-v1';
const EXTERNAL = 'woogidex-external-v1';
const META = 'woogidex-sw-meta';
const RUNTIME_LIMIT = 400;
const EXTERNAL_LIMIT = 600;
const NAVIGATION_TIMEOUT_MS = 4000;

// third-party hosts worth keeping a copy from: sprites and artwork the
// template picker and boards draw, PokeAPI's species text, and the fonts
const EXTERNAL_HOSTS = new Set([
    'play.pokemonshowdown.com',
    'raw.githubusercontent.com',
    'img.pokemondb.net',
    'pkmn.github.io',
    'pokeapi.co',
    'cdn.jsdelivr.net',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
]);

const scope = new URL(self.registration.scope);
const SHELL_URL = new URL('./', scope).href;

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL);
        // one by one rather than addAll(): a single missing file shouldn't
        // cost the visitor the whole offline copy
        await Promise.all(PRECACHE.map(async (path) => {
            const url = new URL(path, scope).href;
            try {
                const res = await fetch(url, { cache: 'reload' });
                if (res.ok) await cache.put(url, await clean(res));
            } catch { /* offline mid-install; the next visit tries again */ }
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // keep this build's shell and the one before it, so a tab still running
        // the previous build can load the chunks it asks for lazily
        const meta = await caches.open(META);
        const stored = await meta.match('versions').then(r => r ? r.json() : []).catch(() => []);
        const keep = [...stored.filter(v => v !== VERSION), VERSION].slice(-2);
        await meta.put('versions', new Response(JSON.stringify(keep)));
        const names = await caches.keys();
        await Promise.all(names
            .filter(n => n.startsWith(SHELL_PREFIX) && !keep.includes(n.slice(SHELL_PREFIX.length)))
            .map(n => caches.delete(n)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || req.headers.has('range')) return;
    const url = new URL(req.url);

    if (url.origin === scope.origin) {
        const path = url.pathname.slice(scope.pathname.length);
        // the Supabase proxy, link-preview images, the admin panel and this
        // file are always live
        if (/^(sb|og-image)\//.test(path) || /^(admin\.html|sw\.js)$/.test(path)) return;
        if (req.mode === 'navigate') { event.respondWith(page(req)); return; }
        if (path.startsWith('bundle/')) { event.respondWith(hashed(req)); return; }
        event.respondWith(staleWhileRevalidate(req, RUNTIME, RUNTIME_LIMIT));
        return;
    }

    if (EXTERNAL_HOSTS.has(url.hostname)) {
        // the Showdown datasets are cached by the page itself (js/core/net-cache.ts)
        if (url.hostname === 'play.pokemonshowdown.com' && url.pathname.startsWith('/data/')) return;
        event.respondWith(external(req));
    }
});

/** Page loads: the live page when it answers in time, else the cached shell. */
async function page(req) {
    const network = fetch(req);
    try {
        const res = await Promise.race([network, timeout(NAVIGATION_TIMEOUT_MS)]);
        // a 404 from GitHub Pages is still the app (it serves 404.html for /community/12)
        if (res) return res;
    } catch { /* offline */ }
    const cached = await caches.match(SHELL_URL, { cacheName: SHELL }) || await caches.match(SHELL_URL);
    if (cached) return cached;
    return network;     // nothing cached yet: wait it out
}

/** Content-hashed files never change, so any copy is the right one. */
async function hashed(req) {
    const cached = await caches.match(req);
    if (cached) return cached;
    const res = await fetch(req);
    if (res.ok) {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
}

async function staleWhileRevalidate(req, cacheName, limit) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(req);
    const fresh = fetch(req).then(async (res) => {
        if (res.ok && res.type !== 'opaque') {
            await cache.put(req, res.clone());
            trim(cacheName, limit);
        }
        return res;
    });
    if (cached) {
        fresh.catch(() => {});
        return cached;
    }
    return fresh;
}

/**
 * A picture or font from another site. The page asks for most of these in
 * no-cors mode, which would come back opaque; asking again with CORS gets a
 * response we can safely keep. Hosts that refuse CORS just aren't cached.
 */
async function external(req) {
    const cache = await caches.open(EXTERNAL);
    const cached = await cache.match(req.url);
    const fresh = (async () => {
        let res;
        try {
            res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
        } catch {
            return fetch(req);
        }
        if (res.ok) {
            await cache.put(req.url, res.clone());
            trim(EXTERNAL, EXTERNAL_LIMIT);
        }
        return res;
    })();
    if (cached) {
        fresh.catch(() => {});
        return cached;
    }
    return fresh;
}

/** Drops the oldest entries once a cache grows past `limit`. */
const trimming = new Set();
async function trim(cacheName, limit) {
    if (trimming.has(cacheName)) return;
    trimming.add(cacheName);
    try {
        const cache = await caches.open(cacheName);
        const keys = await cache.keys();
        const extra = keys.length - limit;
        for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
    } finally {
        trimming.delete(cacheName);
    }
}

function timeout(ms) {
    return new Promise(resolve => setTimeout(() => resolve(null), ms));
}

/**
 * A response that followed a redirect can't be handed to a navigation
 * ("redirected response was used for a request whose redirect mode is not
 * follow"), so the shell is stored as a fresh, unredirected copy.
 */
async function clean(res) {
    if (!res.redirected) return res;
    return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}
