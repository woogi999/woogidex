// Deterrence, not real protection - a page can't stop a screenshot or hide
// pixels from devtools. This just removes the effortless routes (right-click,
// drag, Ctrl+P, crawling). Paired with css/protect.css; leaf module, safe to
// load early.

import { log } from './log.js';

// selectors where full-size artwork can appear; small UI images (icons,
// avatars, placeholder) are deliberately left alone
const PROTECTED_IMG = [
    '.card-art img',
    '.artwork-preview img',
    '.board-artwork-left img',
    '.profile-mon-art img',
    '.collection-library-artwork img',
    '.community-update-mon-art img',
    '.preview-evo-sprite-wrap img',
    // canvas.shielded-art already blocks "save image as" natively; listed so
    // right-click still shows our message instead of the default menu
    'canvas.shielded-art'
].join(', ');

let wired = false;
let shieldTimer = null;

// ---- capture deterrence ----------------------------------------------------
// armed while the tab is hidden or unfocused (looks the same as a capture
// tool/screen share from inside the page); only a blur, so alt-tab doesn't
// make the site look broken
function shield(on) {
    document.body.classList.toggle('protect-shielded', !!on);
}

function armShieldBriefly(ms = 1200) {
    shield(true);
    clearTimeout(shieldTimer);
    shieldTimer = setTimeout(() => shield(false), ms);
}

function isProtectedImage(target) {
    return !!(target && target.closest && target.closest(PROTECTED_IMG));
}

/**
 * Wires the document-level listeners. Idempotent; safe to call more than once.
 */
export function initContentProtection() {
    if (wired) return;
    wired = true;

    // scoped to artwork only; blocking site-wide would break copying names/links
    document.addEventListener('contextmenu', e => {
        if (!isProtectedImage(e.target)) return;
        e.preventDefault();
        window.showToast?.('That artwork belongs to the person who drew it. Please ask before reusing it.', 'info');
    });

    document.addEventListener('dragstart', e => {
        if (isProtectedImage(e.target)) e.preventDefault();
    });

    document.addEventListener('copy', e => {
        if (isProtectedImage(document.activeElement)) e.preventDefault();
    });

    document.addEventListener('visibilitychange', () => shield(document.hidden));
    window.addEventListener('blur', () => shield(true));
    window.addEventListener('focus', () => { clearTimeout(shieldTimer); shield(false); });

    // PrintScreen rarely reaches the page (OS usually eats it), but where it
    // does this blanks the screen a frame late and signals the site noticed;
    // clipboard clear is best-effort and often refused without a gesture
    document.addEventListener('keyup', e => {
        if (e.key !== 'PrintScreen') return;
        armShieldBriefly(1500);
        navigator.clipboard?.writeText?.('')
            .catch(() => { /* no clipboard permission; the blur still happened */ });
        window.showToast?.('Please do not redistribute artwork that is not yours.', 'info');
    });

    // css/protect.css does the real work here; this just makes the shield visible
    window.addEventListener('beforeprint', () => shield(true));
    window.addEventListener('afterprint', () => shield(false));

    log.info('PROTECT', 'Content protection armed');
}
