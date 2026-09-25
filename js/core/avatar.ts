// Avatars, masked the way community artwork is.
//
// An avatar used to be a public bucket URL rendered as <img src>. That put a
// real image request in the network panel for every face on the page, and the
// URL kept working for anyone who copied it. Now the bytes live in
// profiles.avatar_data, come back AES-masked from profile_avatars(), and paint
// into a canvas -- see js/core/art-shield.ts, which owns the decoding and is
// honest about what this kind of protection is and is not.
//
// avatar_url is still the fallback. Anyone who has not re-saved their profile
// since this shipped has no avatar_data, and their bucket copy is all there is.
//
// Batched and cached per page life: a busy comment thread asks for one round
// trip, not one per face.

import { maskedArtwork } from './art-shield.ts';
import { log } from './log.ts';

// user id -> masked avatar, or '' for "asked, and there isn't one"
const cache = new Map();
const waiters = new Map();       // user id -> [resolve, ...]
const queue = new Set();
let flushTimer: any = null;
let getClient: any = null;

/**
 * Hands this module the Supabase client getter. Called once from app start;
 * kept as a setter so this file has no import cycle back into the feature
 * layer, the same way art-shield.ts stays dependency-free.
 * @param clientGetter
 */
export function initAvatars(clientGetter: () => Promise<Record<string, any>>) {
    getClient = clientGetter;
}

/**
 * Masked avatar for one user, if they have one.
 * @param userId
 * @returns '' when there is none, or when the lookup failed
 */
export function requestAvatar(userId: string): Promise<string> {
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
    } catch (e: any) {
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

/** Forgets one entry, so a fresh upload is picked up rather than the old face. */
export function dropCachedAvatar(userId) {
    if (userId) cache.delete(userId);
}
