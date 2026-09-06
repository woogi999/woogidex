// Avatars, masked the way community artwork is.
//
// An avatar used to be a public bucket URL rendered as <img src>. That put a
// real image request in the network panel for every face on the page, and the
// URL kept working for anyone who copied it. Now the bytes live in
// profiles.avatar_data, come back AES-masked from profile_avatars(), and paint
// into a canvas -- see js/core/art-shield.js, which owns the decoding and is
// honest about what this kind of protection is and is not.
//
// avatar_url is still the fallback. Anyone who has not re-saved their profile
// since this shipped has no avatar_data, and their bucket copy is all there is.
//
// Batched and cached per page life: a busy comment thread asks for one round
// trip, not one per face.

import { maskedArtwork, shieldedArtHtml, paintShieldedCanvas } from './art-shield.js';
import { log } from './log.js';

// user id -> masked avatar, or '' for "asked, and there isn't one"
const cache = new Map();
const waiters = new Map();       // user id -> [resolve, ...]
const queue = new Set();
let flushTimer = null;
let getClient = null;

/**
 * Hands this module the Supabase client getter. Called once from app start;
 * kept as a setter so this file has no import cycle back into the feature
 * layer, the same way art-shield.js stays dependency-free.
 * @param {() => Promise<object>} clientGetter
 */
export function initAvatars(clientGetter) {
    getClient = clientGetter;
}

/**
 * Masked avatar for one user, if they have one.
 * @param {string} userId
 * @returns {Promise<string>} '' when there is none, or when the lookup failed
 */
export function requestAvatar(userId) {
    if (!userId) return Promise.resolve('');
    const hit = cache.get(userId);
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise(resolve => {
        if (!waiters.has(userId)) waiters.set(userId, []);
        waiters.get(userId).push(resolve);
        queue.add(userId);
        // coalesce a burst (a comment thread painting, a feed of cards) into
        // one round trip rather than one request per face
        flushTimer ||= setTimeout(flush, 50);
    });
}

/** What is already in hand, synchronously. '' if nothing, undefined if unasked. */
export function cachedAvatar(userId) {
    return userId ? cache.get(userId) : undefined;
}

async function flush() {
    flushTimer = null;
    const ids = [...queue];
    queue.clear();
    if (!ids.length) return;
    try {
        if (!getClient) throw new Error('avatars: no client getter registered');
        const client = await getClient();
        const { data, error } = await client.rpc('profile_avatars', { p_ids: ids });
        if (error) throw error;
        for (const row of data || []) cache.set(row.user_id, maskedArtwork(row.image));
    } catch (e) {
        log.debug('AVATAR', 'Could not load avatars', e);
        // fall through: everyone asked for gets '' below and falls back to the
        // plain URL, which is what they were showing before this existed
    }
    // Anyone the query did not answer for has no avatar_data. Cached as '' so a
    // second scroll past them does not ask again.
    for (const id of ids) {
        if (!cache.has(id)) cache.set(id, '');
        const list = waiters.get(id);
        if (!list) continue;
        waiters.delete(id);
        for (const resolve of list) resolve(cache.get(id) || '');
    }
}

// ==================== vanilla rendering ====================

/**
 * Avatar markup for the plain-HTML renderers. Emits a slot now and fills it in
 * when the masked bytes land; the fallback URL (or the initial-letter circle)
 * shows until then, and stays if there is nothing to upgrade to.
 *
 * @param {string} userId
 * @param {{name?: string, url?: string, className?: string}} options
 * @returns {string}
 */
export function avatarHtml(userId, { name = '', url = '', className = 'community-mini-avatar' } = {}) {
    const masked = cachedAvatar(userId);
    if (masked) return shieldedArtHtml(masked, { alt: '', className });
    if (userId && masked === undefined) {
        // not asked for yet: start the fetch, and paintAvatarSlots() will swap
        // the fallback out when it arrives
        requestAvatar(userId).then(() => paintAvatarSlots());
    }
    const inner = url
        ? `<img class="${className}" src="${escapeAttr(url)}" alt="">`
        : `<span class="${className} ${className}-fallback">${escapeAttr(String(name || '?').charAt(0).toUpperCase())}</span>`;
    return `<span data-avatar-for="${escapeAttr(String(userId || ''))}">${inner}</span>`;
}

function escapeAttr(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Swaps every slot whose avatar has since arrived for the real thing. */
export function paintAvatarSlots(root = document) {
    const slots = root.querySelectorAll?.('[data-avatar-for]');
    if (!slots) return;
    slots.forEach(slot => {
        const id = slot.dataset.avatarFor;
        const masked = cachedAvatar(id);
        if (!masked) return;                       // nothing better to show yet
        const className = slot.firstElementChild?.className || 'community-mini-avatar';
        slot.innerHTML = shieldedArtHtml(masked, { alt: '', className: className.split(' ')[0] });
        delete slot.dataset.avatarFor;
    });
}

/**
 * Paints one already-existing element (the header/popover avatars, which are a
 * fixed <img> in the page rather than markup we generate). Replaces the <img>
 * with a canvas the first time it has masked bytes to draw.
 *
 * @param {HTMLElement|null} host element whose contents become the avatar
 * @param {string} userId
 * @param {string} fallbackUrl
 */
export async function paintAvatarInto(host, userId, fallbackUrl = '') {
    if (!host) return;
    const masked = await requestAvatar(userId);
    if (!masked) {
        if (fallbackUrl) host.innerHTML = `<img src="${escapeAttr(fallbackUrl)}" alt="">`;
        return;
    }
    host.innerHTML = '<canvas class="shielded-art" role="img" aria-label=""></canvas>';
    await paintShieldedCanvas(host.querySelector('canvas'), masked);
}

/** Forgets one entry, so a fresh upload is picked up rather than the old face. */
export function dropCachedAvatar(userId) {
    if (userId) cache.delete(userId);
}
