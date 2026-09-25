// Permission rules for moderation controls, split out of the staff panel's
// markup builders since a permission rule doesn't belong inside a string.
//
// Two independent conditions gate each button:
//   * a permission -- may this moderator ever do this (their role)?
//   * `locked` -- may they do it to *this* account (self or equal/higher rank)?
// Either disables the button; the server re-checks both regardless (admin_*
// RPCs are SECURITY DEFINER) -- this is a courtesy, not the real control.

/** A ban or mute with a year of 9999 is the app's way of writing "permanent". */
export function isForever(iso) {
    return !!iso && new Date(iso).getFullYear() >= 9999;
}

/** Whether a ban/mute expiry is still in the future. */
export function isActive(iso) {
    return !!iso && new Date(iso).getTime() > Date.now();
}

/** How a sanction's expiry reads on a pill -- a lapsed one says "expired", not "until" a past date. */
export function whenText(iso) {
    if (!iso) return '';
    if (isForever(iso)) return 'permanent';
    const d = new Date(iso);
    return (d.getTime() < Date.now() ? 'expired ' : 'until ')
        + d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Coarse "3h ago" style timestamp; deliberately imprecise since these lists are scanned, not read closely. Falls back to a plain date past a week. */
export function timeAgo(iso) {
    if (!iso) return '';
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    if (mins < 10080) return `${Math.floor(mins / 1440)}d ago`;
    return new Date(iso).toLocaleDateString();
}

/**
 * Pills summarising an account's standing at a glance. Suspension hides mute
 * since a suspended account can't post anyway.
 */
export function userStanding(user: Record<string, any> = {}): {kind: string, icon: string, label: string}[] {
    const out: any[] = [];
    if (isActive(user.banned_until)) {
        out.push({ kind: 'banned', icon: 'ban', label: `Suspended ${whenText(user.banned_until)}` });
    } else if (isActive(user.muted_until)) {
        out.push({ kind: 'muted', icon: 'mic-off', label: `Muted ${whenText(user.muted_until)}` });
    }
    const strikes = Number(user.warnings) || 0;
    if (strikes > 0) {
        out.push({ kind: 'warned', icon: 'alert-triangle', label: `${strikes} strike${strikes === 1 ? '' : 's'}` });
    }
    return out;
}

/**
 * Every button on a user's moderation bar, resolved against the viewer's
 * permissions and rank rule. Toggle actions (mute/unmute, ban/unban) are one
 * entry each so the bar never offers both states at once.
 *
 * @param {object} user the account being moderated
 * @param {{perms?: Record<string, boolean>, locked?: boolean}} viewer
 */
export function moderationActions(user: Record<string, any> = {}, { perms = {}, locked = false }: { perms?: any; locked?: any } = {}): {key: string, label: string, icon: string, handler: string, arg?: string, tone?: string, disabled: boolean, needs?: string}[] {
    const may = perm => !!perms[perm] && !locked;
    const banned = isActive(user.banned_until);
    const muted = isActive(user.muted_until);

    const bar = [
        { key: 'comments', label: 'Comments', icon: 'message-square', handler: 'adminToggleUserComments', disabled: false },
        { key: 'history', label: 'History', icon: 'history', handler: 'adminToggleUserHistory', disabled: false, needs: 'view_log' },
        { key: 'sessions', label: 'Sessions', icon: 'globe', handler: 'adminToggleUserSessions', disabled: false, needs: 'view_ips' },
        { key: 'warn', label: 'Warn', icon: 'alert-triangle', handler: 'adminModAction', arg: 'warn', tone: 'warn', disabled: !may('warn') },
        muted
            ? { key: 'unmute', label: 'Unmute', icon: 'mic', handler: 'adminModAction', arg: 'unmute', disabled: !may('mute') }
            : { key: 'mute', label: 'Mute', icon: 'mic-off', handler: 'adminModAction', arg: 'mute', tone: 'warn', disabled: !may('mute') },
        { key: 'purge', label: 'Purge', icon: 'eraser', handler: 'adminOpenPurge', tone: 'warn', disabled: !may('purge_content') },
        banned
            ? { key: 'unban', label: 'Lift ban', icon: 'undo-2', handler: 'adminModAction', arg: 'unban', disabled: !may('ban') }
            : { key: 'ban', label: 'Suspend', icon: 'ban', handler: 'adminModAction', arg: 'ban', tone: 'danger', disabled: !may('ban') },
        { key: 'delete_user', label: 'Delete acct', icon: 'user-x', handler: 'adminModAction', arg: 'delete_user', tone: 'danger', disabled: !may('delete_users') }
    ];

    // hide (not just disable) drawer buttons a moderator lacks permission for -- don't advertise the capability
    return bar.filter(b => !b.needs || !!perms[b.needs]);
}

// ==================== the moderation log ====================
// Each entry renders as one plain sentence: who did what, to whom, and when.

const LOG_ICONS = {
    warn: ['alert-triangle', 'sev-warn'], mute: ['mic-off', 'sev-warn'], unmute: ['mic', 'sev-good'],
    ban: ['ban', 'sev-bad'], unban: ['undo-2', 'sev-good'], delete_user: ['user-x', 'sev-bad'],
    delete_comment: ['trash-2', 'sev-warn'], delete_mon: ['trash-2', 'sev-warn'],
    purge_comments: ['eraser', 'sev-bad'], purge_mons: ['eraser', 'sev-bad'],
    automod_block: ['shield-x', 'sev-bad'], automod_flag: ['flag', 'sev-warn'],
    badge_change: ['award', ''], badge_upsert: ['award', ''], badge_removed: ['award', 'sev-warn'],
    term_added: ['plus', ''], term_updated: ['pencil', ''], term_removed: ['minus', '']
};

const LOG_VERBS = {
    warn: 'warned', mute: 'muted', unmute: 'unmuted', ban: 'suspended', unban: 'lifted the suspension on',
    delete_user: 'deleted the account of', delete_comment: 'deleted a comment by', delete_mon: 'removed a Fakemon by',
    purge_comments: 'purged comments by', purge_mons: 'purged published Fakemon by',
    automod_block: 'blocked a post by', automod_flag: 'flagged a post by',
    badge_change: 'changed the badges of', badge_upsert: 'saved a badge',
    badge_removed: 'deleted a badge', term_added: 'added a filter rule',
    term_updated: 'edited a filter rule', term_removed: 'removed a filter rule'
};

// site-level actions have no person target -- naming one would invent it
const NO_TARGET = new Set(['term_added', 'term_updated', 'term_removed', 'badge_upsert', 'badge_removed']);

/**
 * Turns a log row into the pieces a sentence is built from.
 */
export function logEntry(a: Record<string, any> = {}): {icon, severity, actor, verb, target: string|null, removed, reason, expires, excerpt, when, exact} {
    const [icon, severity] = LOG_ICONS[a.action] || ['dot', ''];
    return {
        icon,
        severity,
        actor: a.actor_name || 'auto-moderator', // automatic filter actions have no staff member behind them
        verb: LOG_VERBS[a.action] || String(a.action || '').replace(/_/g, ' '),
        target: NO_TARGET.has(a.action) ? null : (a.target_name || 'a user'),
        removed: a.details?.removed,
        reason: a.reason || '',
        expires: a.expires_at ? whenText(a.expires_at) : '',
        excerpt: a.details?.excerpt || '',
        when: timeAgo(a.created_at),
        exact: a.created_at ? new Date(a.created_at).toLocaleString() : ''
    };
}

/** Where a comment was posted, phrased for a moderator scanning a list. */
export function commentLocation(c: Record<string, any> = {}) {
    return c.kind === 'profile'
        ? `on ${c.context_name}'s profile`
        : `on ${c.context_name}`;
}
