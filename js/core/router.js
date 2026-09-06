// Path-based routing on a static host (GitHub Pages) via two pieces: 404.html
// is a copy of index.html that Pages serves for any unrecognized path, so
// /community/12 loads the app with the URL intact (npm run build:404
// regenerates it); and index.html sets <base href> from the current path so
// relative URLs resolve when served from a subpath (e.g. /<repo>/, not root).
// basePath() derives from document.baseURI so it can't disagree with that.

import { log } from './log.js';

// Route segments the app owns. Order does not matter; these are matched as the
// first path segment after the base. Anything else falls through to the
// collection, which is also what "/" means.
const ROUTES = ['collection', 'editor', 'ability-editor', 'community', 'events', 'battle', 'profile',
    'privacy', 'terms', 'settings'];

let cachedBase = null;

/**
 * The path the app is installed at, with a trailing slash: '/' on a domain
 * root, '/woogidex/' on a GitHub Pages project site.
 * @returns {string}
 */
export function basePath() {
    if (cachedBase === null) cachedBase = new URL(document.baseURI).pathname.replace(/[^/]*$/, '');
    return cachedBase;
}

/**
 * Parses the address bar into a route.
 * @returns {{name: string, param: string}} name is '' for the app root
 */
export function currentRoute() {
    const path = window.location.pathname;
    const base = basePath();
    const rest = (path.startsWith(base) ? path.slice(base.length) : path.replace(/^\//, ''))
        .replace(/^\/+|\/+$/g, '');
    if (!rest || rest === 'index.html' || rest === '404.html') return { name: '', param: '' };
    const [name, ...tail] = rest.split('/');
    if (!ROUTES.includes(name)) return { name: '', param: '' };
    return { name, param: decodeURIComponent(tail.join('/')) };
}

/**
 * Absolute URL for a route, for share links and anything that leaves the page.
 * @param {string} path e.g. 'community/12' -- no leading slash
 * @returns {string}
 */
export function routeUrl(path) {
    return `${window.location.origin}${basePath()}${String(path || '').replace(/^\/+/, '')}`;
}

/**
 * Points the address bar at a route without navigating. Always replaceState,
 * never pushState, so in-app clicks don't pile up history entries (unchanged
 * from the old hash router's behavior).
 * @param {string} path route path without a leading slash, '' for the root
 */
export function replaceRoute(path) {
    const next = `${basePath()}${String(path || '').replace(/^\/+/, '')}`;
    if (window.location.pathname === next && !window.location.hash) return;
    try {
        history.replaceState(null, '', `${next}${window.location.search}`);
    } catch (err) {
        // only reachable from file://, where history is refused
        log.warn('ROUTER', 'Could not update the address bar', { path, error: String(err) });
    }
}

// ---- legacy hash links -----------------------------------------------------
// #community/<id> and #profile/<name> links have been shared and will keep
// arriving. They are rewritten to the equivalent path on arrival so an old
// link opens the right page and, from then on, shows the new URL.
const LEGACY = [
    [/^#community\/(.+)$/, id => `community/${id}`],
    [/^#profile\/(.+)$/, name => `profile/${name}`],
    [/^#editor\/(.+)$/, id => `editor/${id}`],
    [/^#ability-editor\/(.+)$/, id => `ability-editor/${id}`],
    [/^#(collection|editor|community|events|battle)$/, name => name]
];

// ---- Supabase email links --------------------------------------------------
// password reset / magic link / confirmation tokens (or errors) arrive in the
// URL fragment. Must be captured at module load, before the supabase client
// parses-and-wipes it, or replaceRoute() drops it.
const EMAIL_LINK = (() => {
    const hash = (window.location.hash || '').replace(/^#/, '');
    const query = (window.location.search || '').replace(/^\?/, '');
    const params = new URLSearchParams(`${hash}&${query}`);
    return Object.freeze({
        type: params.get('type') || '',
        errorCode: params.get('error_code') || '',
        errorDescription: params.get('error_description') || ''
    });
})();

/**
 * What the Supabase email link this page was opened from said, if any. All
 * fields are '' on an ordinary visit.
 * @returns {{type: string, errorCode: string, errorDescription: string}}
 */
export function emailLinkParams() {
    return EMAIL_LINK;
}

/**
 * Rewrites a legacy #hash URL to its path equivalent. Call once, before the
 * first route is read.
 * @returns {boolean} true if the URL was rewritten
 */
export function migrateLegacyHash() {
    const hash = window.location.hash || '';
    if (!hash) return false;
    for (const [pattern, toPath] of LEGACY) {
        const m = hash.match(pattern);
        if (!m) continue;
        const path = toPath(m[1]);
        log.info('ROUTER', 'Rewrote a legacy hash link', { from: hash, to: path });
        try {
            history.replaceState(null, '', `${basePath()}${path}${window.location.search}`);
        } catch { /* file://; the hash router below still reads it correctly */ }
        return true;
    }
    return false;
}
