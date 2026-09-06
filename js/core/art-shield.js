// Renders artwork into a <canvas> with the pixel source kept in a
// module-scoped Map, so the element panel shows no src/data-URI/blob URL to
// grab, and right-click/drag "save image" don't apply to canvases. This is
// deterrence, not real protection - screenshots and canvas.toDataURL() from
// the console still work. It just closes the casual routes. Paired with
// js/core/protect.js for right-click/drag/copy.
//
// Animated artwork (GIF, animated WebP, APNG) is decoded frame by frame with
// WebCodecs' ImageDecoder and played onto the same canvas. Drawing a decoded
// bitmap paints exactly one frame, so without this every animation on the site
// is a still of its first frame.

import { log } from './log.js';

// token -> artwork; module-scoped so the console has no name to reach it by
const vault = new Map();
let counter = 0;

// caps rendered size only (memory: width*height*4 bytes of canvas backing
// store), not what's stored or published
const MAX_CANVAS_PX = 2048;

/**
 * Markup for a piece of artwork that should not be trivially liftable.
 * Register the pixels here, get back an element with nothing in it.
 *
 * @param {string} dataUri the artwork: a data: URI, or masked (see maskedArtwork)
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

// ==================== the masked form ====================
// Community artwork does not travel as a readable image: the server hands out
// an AES-CBC envelope instead (see the masked_artwork_transport migration) so a
// response body in the network panel is opaque rather than a
// "data:image/png;base64,..." string anyone can paste into an address bar.
//
// The key rides along in the envelope, because the browser is what has to
// decrypt it. So this is obfuscation of the same kind the canvas is, closing
// the network panel the way the canvas closed "save image as" -- not a claim
// that the pixels cannot be got at by someone who means it.
//
// Pipe-separated rather than JSON so a masked image is still a plain string and
// every caller that already passes artwork around as one is unaffected. None of
// the four fields can contain a pipe: base64 and a media type.
const MASK_TAG = 'wgx1';

/**
 * Packs a {mime, key, iv, body} envelope from the server into the string form
 * the rest of the app passes around.
 * @param {{mime?: string, key?: string, iv?: string, body?: string}|null} envelope
 * @returns {string} '' when the envelope is empty or malformed
 */
export function maskedArtwork(envelope) {
    if (!envelope) return '';
    const { mime, key, iv, body } = envelope;
    if (!mime || !key || !iv || !body) return '';
    return [MASK_TAG, mime, key, iv, body].join('|');
}

/** Whether a value is masked artwork rather than a plain data: URI. */
export function isMaskedArtwork(value) {
    return typeof value === 'string' && value.startsWith(MASK_TAG + '|');
}

function base64Bytes(text) {
    const binary = atob(String(text || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function unmask(value) {
    const [, mime, key, iv, body] = value.split('|');
    // pgcrypto's aes-cbc/pad:pkcs and SubtleCrypto's AES-CBC agree on both the
    // mode and the padding, so this is a plain decrypt with no fixups
    const cryptoKey = await crypto.subtle.importKey(
        'raw', base64Bytes(key), { name: 'AES-CBC' }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: base64Bytes(iv) }, cryptoKey, base64Bytes(body));
    return new Blob([plain], { type: mime });
}

/**
 * The bytes behind a piece of artwork, as a Blob.
 *
 * Sole reader of the stored form, so callers that need the decoded image (the
 * canvas painter here, the thumbnail maker in community.js) do not each have to
 * know whether they were handed a data: URI or a masked envelope.
 *
 * @param {string} source a data: URI, or masked artwork
 * @returns {Promise<Blob|null>} null when there is nothing to decode
 */
export async function artworkBlob(source) {
    const value = String(source || '');
    if (!value) return null;
    try {
        if (isMaskedArtwork(value)) return await unmask(value);
        return await (await fetch(value)).blob();
    } catch (e) {
        log.warn('SHIELD', 'Could not read artwork bytes', e);
        return null;
    }
}

/**
 * Masked artwork back as a data: URI. Only for the few places that must hand
 * artwork to something that takes a URL and nothing else -- the detail view's
 * preview board, which is a copy of the editor's and renders an <img>. The URI
 * exists in memory only; it is never what came over the wire.
 *
 * @param {string} source
 * @returns {Promise<string>} the original string if it was not masked, '' on failure
 */
export async function artworkDataUri(source) {
    const value = String(source || '');
    if (!isMaskedArtwork(value)) return value;
    const blob = await artworkBlob(value);
    if (!blob) return '';
    return await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => resolve('');
        reader.readAsDataURL(blob);
    });
}

/**
 * How many frames an image has. 1 for a still image, and 1 wherever WebCodecs
 * is unavailable -- callers use this to decide whether flattening the image
 * onto a canvas would lose anything, and "no" is the safe answer to guess.
 *
 * @param {string} source a data: URI, or masked artwork
 * @returns {Promise<number>}
 */
export async function frameCount(source) {
    if (typeof ImageDecoder === 'undefined') return 1;
    const blob = await artworkBlob(source);
    if (!blob) return 1;
    let decoder = null;
    try {
        if (!(await ImageDecoder.isTypeSupported(blob.type))) return 1;
        decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: blob.type });
        // tracks.ready, not just completed -- see animate() below on why
        await Promise.all([decoder.completed, decoder.tracks.ready]);
        return Number(decoder.tracks.selectedTrack?.frameCount) || 1;
    } catch {
        return 1;
    } finally {
        try { decoder?.close(); } catch { /* already closed */ }
    }
}

// ==================== painting ====================

// One running animation per canvas. A canvas repainted with different artwork
// (the shiny toggle, a card recycled by React) must not end up with two loops
// drawing over each other, so each new paint revokes the last one's token.
const running = new WeakMap();

function claim(canvas) {
    const token = {};
    running.set(canvas, token);
    return () => running.get(canvas) === token;
}

// Sizes the canvas to the image, capped, and returns its 2D context.
//
// Guards the dimensions: a canvas whose width is set to NaN silently becomes 0
// wide, and drawing into it paints nothing at all. Anything that hands us a bad
// size should cost us the scaling, not the picture.
function fitCanvas(canvas, width, height) {
    const w = Number(width);
    const h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return null;
    const scale = Math.min(1, MAX_CANVAS_PX / Math.max(w, h));
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    return canvas.getContext('2d');
}

// The CSS holds a shielded canvas at opacity 0 until this class lands, so
// anything that fails to set it is invisible rather than merely unpainted.
// Guarded because classList.add() is a DOM mutation and initArtShield() has a
// MutationObserver on the whole document -- setting it every frame woke that
// observer, and a full querySelectorAll, sixty times a second per animation.
function markPainted(canvas) {
    if (!canvas.classList.contains('is-painted')) canvas.classList.add('is-painted');
}

/**
 * Draws artwork into a canvas already in the document, animating it if it has
 * more than one frame. Used directly by React islands, which hold the source in
 * props and skip the vault.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} source a data: URI, or masked artwork
 * @returns {Promise<boolean>} false when nothing could be drawn
 */
export async function paintShieldedCanvas(canvas, source) {
    if (!canvas || !source) return false;
    const isCurrent = claim(canvas);
    const blob = await artworkBlob(source);
    if (!blob || !isCurrent()) return false;

    // A still frame goes up FIRST, always. Animation is then an upgrade on top
    // of a picture that is already on screen. Ordering it the other way round
    // blanks animated images: if the animated path reports success as soon as
    // it has a decoder, anything that goes wrong afterwards -- a track that was
    // not ready, a frame with no usable dimensions -- leaves an empty canvas
    // with no still path left to fall back to, and the opacity rule above
    // means empty reads as missing.
    const painted = await paintStill(canvas, blob, isCurrent);
    // deliberately not awaited: the loop runs as long as the canvas is on the
    // page, and this call only has to start it
    animate(canvas, blob, isCurrent);
    return painted;
}

// Single frame. createImageBitmap decodes the first frame of an animation,
// which is the right thing to show while the decoder spins up, and the whole
// story for PNG/JPEG and for browsers without WebCodecs.
async function paintStill(canvas, blob, isCurrent) {
    try {
        const bitmap = await createImageBitmap(blob);
        if (!isCurrent()) { bitmap.close(); return false; }
        const ctx = fitCanvas(canvas, bitmap.width, bitmap.height);
        if (ctx) ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        if (!ctx) return false;
        markPainted(canvas);
        return true;
    } catch (e) {
        log.warn('SHIELD', 'Could not paint shielded artwork', e);
        return false;
    }
}

/**
 * Plays a multi-frame image onto the canvas, if it is one and if this browser
 * can decode it that way. Returns quietly when it is not: the still frame
 * paintShieldedCanvas() already drew is the correct result in that case.
 */
async function animate(canvas, blob, isCurrent) {
    if (typeof ImageDecoder === 'undefined') return;
    let decoder = null;
    try {
        if (!(await ImageDecoder.isTypeSupported(blob.type))) return;
        decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: blob.type });
        // `completed` says the bytes are all in; `tracks.ready` is what says
        // selectedTrack is populated. Reading frameCount without the second one
        // gets you a null track and a one-frame answer for a real animation,
        // which is how an animated GIF ends up frozen.
        await Promise.all([decoder.completed, decoder.tracks.ready]);
        const track = decoder.tracks.selectedTrack;
        const frames = Number(track?.frameCount) || 1;
        if (frames < 2 || !isCurrent()) return;
        await playFrames(canvas, decoder, frames, track, isCurrent);
    } catch (e) {
        // Not worth surfacing: the still frame is already on screen.
        log.debug('SHIELD', 'Animated decode unavailable; the still frame stands', e);
    } finally {
        try { decoder?.close(); } catch { /* already closed */ }
    }
}

async function playFrames(canvas, decoder, frames, track, isCurrent) {
    const repeats = Number(track?.repetitionCount);
    // -1/Infinity both mean "loop forever", which is what most GIFs say
    const loopsForever = !Number.isFinite(repeats) || repeats < 0;
    let ctx = null;
    let index = 0;
    while (isCurrent()) {
        // Stop once the canvas leaves the document (card scrolled out and
        // recycled, page navigated away) rather than decoding forever.
        if (index > 0 && !canvas.isConnected) return;
        const { image } = await decoder.decode({ frameIndex: index % frames });
        if (!isCurrent()) { image.close(); return; }
        // codedWidth is the fallback for implementations that do not expose the
        // display size; without one of them fitCanvas refuses the frame rather
        // than sizing the canvas to nothing.
        ctx ||= fitCanvas(canvas,
            image.displayWidth || image.codedWidth,
            image.displayHeight || image.codedHeight);
        if (!ctx) { image.close(); return; }     // leaves the still frame up
        // frames carry transparency; without the clear, an area that goes
        // transparent keeps whatever the previous frame left there
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        markPainted(canvas);
        // duration is microseconds; the floor matches what browsers do with the
        // 0/10ms delays old GIFs are full of
        const delay = Math.max(20, (Number(image.duration) || 100000) / 1000);
        image.close();
        index++;
        if (!loopsForever && index >= frames * Math.max(1, repeats + 1)) return;
        await new Promise(resolve => setTimeout(resolve, delay));
    }
}

async function paintFromVault(canvas) {
    const token = canvas.dataset.shield;
    if (!token) return;
    const source = vault.get(token);
    delete canvas.dataset.shield;
    if (!source) return;
    await paintShieldedCanvas(canvas, source);
    // drop the entry so the map doesn't grow one per card per re-render
    vault.delete(token);
}

/**
 * Paints every unpainted shielded canvas under `root`. Safe to call as often as
 * you like; a canvas is only ever claimed once.
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
