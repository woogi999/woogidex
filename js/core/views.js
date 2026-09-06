// Each page's markup lives in its own file under views/, fetched at boot in
// parallel and mounted into placeholder divs (data-view-src). All pages are
// mounted eagerly up front rather than lazily on first visit: some code (e.g.
// openMonDetail) reaches into a page's DOM before navigating to it, which
// silently breaks under lazy mounting since the element wouldn't exist yet.
// Inline onclick handlers still work since module exports are on window.

import { log } from './log.js';

const cache = new Map();     // view id -> markup string
const mounted = new Set();   // view ids already parsed into the DOM
const hooks = new Map();     // view id -> [fn], run once after mounting
let fetched = null;          // the boot-time fetch, so it is only started once

function placeholders() {
    return [...document.querySelectorAll('[data-view-src]')];
}

/**
 * Registers a function to run once, immediately after a page's markup is
 * first put into the DOM. Use this for anything that binds to elements inside
 * a page rather than delegating from the document.
 * @param {string} viewId
 * @param {Function} fn
 */
export function onViewMounted(viewId, fn) {
    if (typeof fn !== 'function') return;
    if (!hooks.has(viewId)) hooks.set(viewId, []);
    hooks.get(viewId).push(fn);
    // run immediately if the page is already mounted, so import order doesn't matter
    if (mounted.has(viewId)) fn();
}

/**
 * Fetches every page fragment in parallel. Awaited once during boot, before
 * anything touches the DOM. Resolves even if some pages fail, so one bad file
 * degrades to one missing page rather than a blank site.
 * @returns {Promise<void>}
 */
export function loadViewMarkup() {
    if (fetched) return fetched;
    const done = log.time('VIEWS', 'Fetching page markup');
    fetched = Promise.all(placeholders().map(async el => {
        const src = el.getAttribute('data-view-src');
        try {
            const res = await fetch(src, { cache: 'no-cache' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            cache.set(el.id, await res.text());
        } catch (err) {
            log.error('VIEWS', `Could not load ${src}`, { view: el.id, error: String(err) });
        }
    })).then(() => { done(); });
    return fetched;
}

/**
 * Puts a page's markup into the DOM if it is not there yet. Synchronous, and
 * safe to call on every navigation -- the second call onwards is a Set lookup.
 * @param {string} viewId
 * @returns {HTMLElement|null} the page container
 */
export function mountView(viewId) {
    const el = document.getElementById(viewId);
    if (!el) return null;
    if (mounted.has(viewId) || !el.hasAttribute('data-view-src')) return el;

    const markup = cache.get(viewId);
    if (markup === undefined) {
        // fetch hasn't landed or failed; show an error rather than a blank panel
        log.warn('VIEWS', 'Page opened before its markup was available', { view: viewId });
        el.innerHTML = '<div class="panel"><p>This page could not be loaded. Please refresh.</p></div>';
        return el;
    }

    el.innerHTML = markup;
    mounted.add(viewId);
    if (typeof lucide !== 'undefined') lucide.createIcons();
    for (const fn of hooks.get(viewId) || []) {
        try { fn(); } catch (err) { log.error('VIEWS', `Mount hook failed for ${viewId}`, { error: String(err) }); }
    }
    log.debug('VIEWS', `Mounted ${viewId}`);
    return el;
}

/**
 * Mounts every page. Called once at boot, after loadViewMarkup() has resolved.
 * @returns {string[]} the pages that were mounted
 */
export function mountAllViews() {
    for (const el of placeholders()) mountView(el.id);
    return mountedViews();
}

/** Which pages have been parsed into the DOM. Exposed for tests and logging. */
export function mountedViews() {
    return [...mounted];
}
