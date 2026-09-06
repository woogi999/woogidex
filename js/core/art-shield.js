// Renders artwork into a <canvas> with the pixel source kept in a
// module-scoped Map, so the element panel shows no src/data-URI/blob URL to
// grab, and right-click/drag "save image" don't apply to canvases. This is
// deterrence, not real protection - screenshots and canvas.toDataURL() from
// the console still work, and the API route itself is unrestricted. It just
// closes the casual routes. Paired with js/core/protect.js for right-click/drag/copy.

import { log } from './log.js';

// token -> data URI; module-scoped so the console has no name to reach it by
const vault = new Map();
let counter = 0;

// caps rendered size only (memory: width*height*4 bytes of canvas backing
// store), not what's stored or published
const MAX_CANVAS_PX = 2048;

/**
 * Markup for a piece of artwork that should not be trivially liftable.
 * Register the pixels here, get back an element with nothing in it.
 *
 * @param {string} dataUri the artwork, as a data: URI
 * @param {{alt?: string, className?: string}} options
 * @returns {string} canvas markup, or '' when there is no artwork to shield
 */
export function shieldedArtHtml(dataUri, { alt = '', className = '' } = {}) {
    if (!String(dataUri || '')) return '';
    const token = `s${(++counter).toString(36)}`;
    vault.set(token, String(dataUri));
    // aria-label since a canvas isn't a replaced image element (no alt support)
    return `<canvas class="shielded-art ${className}" data-shield="${token}" role="img" aria-label="${escapeAttr(alt)}"></canvas>`;
}

function escapeAttr(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Draws a data URI into a canvas already in the document. Used directly by
 * React islands, which hold the URI in props and skip the vault.
 * @param {HTMLCanvasElement} canvas
 * @param {string} dataUri
 */
export async function paintShieldedCanvas(canvas, dataUri) {
    if (!canvas || !dataUri) return false;
    try {
        const bitmap = await createImageBitmap(await (await fetch(dataUri)).blob());
        const scale = Math.min(1, MAX_CANVAS_PX / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
        canvas.classList.add('is-painted');
        return true;
    } catch (e) {
        log.warn('SHIELD', 'Could not paint shielded artwork', e);
        return false;
    }
}

async function paintFromVault(canvas) {
    const token = canvas.dataset.shield;
    if (!token) return;
    const dataUri = vault.get(token);
    delete canvas.dataset.shield;
    if (!dataUri) return;
    await paintShieldedCanvas(canvas, dataUri);
    // drop the entry so the map doesn't grow one per card per re-render
    vault.delete(token);
}

/**
 * Paints every unpainted shielded canvas under `root`. Safe to call as often
 * as you like; a canvas is only ever claimed once.
 */
export function paintShieldedArt(root = document) {
    const nodes = root.querySelectorAll?.('canvas[data-shield]');
    if (nodes) nodes.forEach(paintFromVault);
}

let observing = false;

/**
 * Watches the document so a canvas painted by any render path gets filled in
 * without that path needing to know this module exists (vs. adding a manual
 * paintShieldedArt() call after every innerHTML assignment site).
 */
export function initArtShield() {
    if (observing) return;
    observing = true;
    paintShieldedArt();

    let queued = false;
    const observer = new MutationObserver(() => {
        // coalesce to one pass per frame instead of re-querying per mutation record
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; paintShieldedArt(); });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    log.info('SHIELD', 'Artwork shield armed');
}
