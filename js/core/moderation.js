// Client-side half of moderation. screenContent() pre-checks text against the
// server blocklist (recording infractions/escalation there, since a raising
// trigger can't log). refreshStanding() caches muted/banned status for the UI.
// Actual enforcement is the enforce_content_policy() trigger on the server,
// which re-checks everything on every write regardless of this file.

import { getClient } from './supabase.js';
import { log } from './log.js';

let standing = null;          // last my_standing() result
let standingFetchedAt = 0;
const STANDING_TTL_MS = 60 * 1000;

// a punishment mid-session should show up immediately, not after the TTL
function invalidateStanding() { standing = null; standingFetchedAt = 0; }

/**
 * Current account standing, cached for a minute.
 * @returns {Promise<{banned:boolean, muted:boolean, banned_until, muted_until,
 *                    ban_reason, mute_reason, warnings:number}|null>}
 */
async function refreshStanding(force = false) {
    if (!force && standing && Date.now() - standingFetchedAt < STANDING_TTL_MS) return standing;
    try {
        const client = await getClient();
        const { data, error } = await client.rpc('my_standing');
        if (error) throw error;
        standing = data || null;
        standingFetchedAt = Date.now();
    } catch (e) {
        log.warn?.('MOD', 'Could not read account standing', e);
        standing = null;
    }
    return standing;
}

function getCachedStanding() { return standing; }

function formatUntil(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    // server sentinel for "until a moderator lifts it"
    if (d.getFullYear() >= 9999) return 'indefinitely';
    return `until ${d.toLocaleString()}`;
}

function standingMessage(s) {
    if (!s) return '';
    if (s.banned) return `Your account is suspended ${formatUntil(s.banned_until)}.${s.ban_reason ? ' Reason: ' + s.ban_reason : ''}`;
    if (s.muted) return `You're muted ${formatUntil(s.muted_until)} and can't post.${s.mute_reason ? ' Reason: ' + s.mute_reason : ''}`;
    return '';
}

/**
 * Runs `text` past the server blocklist. When blocked, the infraction/escalation
 * has already been applied server-side. Fails open on network/RPC error since
 * the server trigger still enforces the write either way.
 * @param {string} text     what the user typed
 * @param {string} context  where it came from, e.g. 'comment' - shown to staff
 */
async function screenContent(text, context = 'content') {
    const body = String(text || '').trim();
    if (!body) return { allowed: true, matches: [] };
    try {
        const client = await getClient();
        const { data, error } = await client.rpc('screen_content', { p_text: body, p_context: context });
        if (error) throw error;
        const verdict = data || { allowed: true, matches: [] };
        if (verdict.punishment) invalidateStanding();
        return verdict;
    } catch (e) {
        log.warn?.('MOD', 'Content screening unavailable, deferring to the server trigger', e);
        return { allowed: true, matches: [], unavailable: true };
    }
}

function blockedMessage(verdict) {
    const base = `That can't be posted - our filter flagged it${verdict?.label ? ` as ${verdict.label.toLowerCase()}` : ''}.`;
    const note = verdict?.punishment?.note;
    return note ? `${base} ${note}` : `${base} Repeating it will get your account restricted.`;
}

/**
 * The one call every compose path makes. Returns true when the caller may go
 * ahead, and has already shown the user why when it returns false.
 */
async function guardContent(text, context = 'content', toast = null) {
    const say = toast || window.showToast || (() => {});
    const s = await refreshStanding();
    if (s && (s.banned || s.muted)) { say(standingMessage(s), 'error'); return false; }

    const verdict = await screenContent(text, context);
    if (!verdict.allowed) { say(blockedMessage(verdict), 'error'); return false; }
    // mild flags pass through, but let the user know staff can see it
    if (verdict.matches?.length && verdict.severity === 'mild') {
        say('Heads up: that language is flagged for staff review. Keep it friendly.', 'warning');
    }
    return true;
}

// matches the pre-check wording for paths where the write reaches the server first
function friendlyModerationError(error) {
    const msg = String(error?.message || '');
    if (/content filter/i.test(msg)) return 'That can\'t be posted - our filter flagged it.';
    if (/account is suspended/i.test(msg)) return 'Your account is suspended.';
    if (/you are muted/i.test(msg)) return 'You\'re muted and can\'t post right now.';
    return '';
}

export {
    screenContent, guardContent, refreshStanding, getCachedStanding,
    invalidateStanding, standingMessage, friendlyModerationError, blockedMessage
};
