// IndexedDB is scoped per-origin, so localhost gets a separate empty database
// from the live site - looks like data loss on first local run otherwise.
// Shows once, only on a local origin with an empty collection, so it goes
// away for good once there's anything to lose. Inline styles (not a
// stylesheet) since this is dev-only scaffolding that shouldn't touch the real cascade.

import { log } from './log.js';

const DISMISSED = 'woogidex-dev-origin-notice-dismissed';

function isLocal() {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
}

/**
 * Shows the notice if this is a local origin with an empty collection.
 * Safe to call unconditionally; it decides for itself whether to appear.
 * @param {number} collectionSize how many Fakemon loaded from storage
 */
// z-index deliberately below .modal-overlay's (11000) so this can never
// render on top of a modal's backdrop
export function maybeShowOriginNotice(collectionSize) {
    if (!isLocal()) return;
    if (collectionSize > 0) return;
    try { if (localStorage.getItem(DISMISSED) === 'true') return; } catch { /* private mode */ }

    log.info('DEV', 'Local origin has an empty collection; showing the origin notice');

    const bar = document.createElement('div');
    bar.id = 'dev-origin-notice';
    bar.setAttribute('role', 'status');
    bar.style.cssText = [
        'position:fixed', 'left:50%', 'transform:translateX(-50%)', 'bottom:16px',
        'z-index:10500', 'max-width:min(46rem,calc(100vw - 2rem))',
        'background:#1f2430', 'color:#f2f4f8', 'border:1px solid #39415a',
        'border-radius:10px', 'padding:14px 16px',
        'font:14px/1.55 system-ui,sans-serif', 'box-shadow:0 10px 30px rgba(0,0,0,.35)'
    ].join(';');

    const title = document.createElement('strong');
    title.textContent = 'Your collection is not missing.';
    title.style.cssText = 'display:block;margin-bottom:6px;font-size:15px';

    const body = document.createElement('p');
    body.style.cssText = 'margin:0 0 10px';
    body.textContent =
        'You are running Woogidex locally. Browsers keep saved data separate per site, '
        + 'and localhost counts as a different site from the live one, so this copy starts empty. '
        + 'Your Fakemon are still on the live site.';

    const how = document.createElement('p');
    how.style.cssText = 'margin:0 0 12px;color:#aab3c5';
    how.textContent =
        'To work on them here: open the live site, use Export Collection, then Import on this page.';

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Got it';
    dismiss.style.cssText = [
        'background:#4f46e5', 'color:#fff', 'border:0', 'border-radius:6px',
        'padding:7px 14px', 'font:inherit', 'font-weight:600', 'cursor:pointer'
    ].join(';');
    dismiss.addEventListener('click', () => {
        try { localStorage.setItem(DISMISSED, 'true'); } catch { /* private mode */ }
        bar.remove();
    });

    bar.append(title, body, how, dismiss);
    document.body.appendChild(bar);
}
