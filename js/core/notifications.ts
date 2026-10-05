import { log } from './log.ts';
import { state, api } from './app.ts';
import { notify } from '../app/store.ts';

// bell icon + unread-count badge; notifies on comments to a user's published
// Fakemon or profile. Requires a `notifications` table (see schema/migrations).

const POLL_INTERVAL_MS = 30000;

function ensureNotificationState() {
    if (!state.notifications) {
        state.notifications = { items: [] as any[], unreadCount: 0, loading: false, open: false, pollTimer: null as any };
    }
    return state.notifications;
}

// no-ops silently if the notifications table isn't set up, so it never blocks a comment
async function createNotification({ userId, type, actorId, actorName, actorAvatarUrl, targetId, targetName, preview }: { userId?: any; type?: any; actorId?: any; actorName?: any; actorAvatarUrl?: any; targetId?: any; targetName?: any; preview?: any }) {
    if (!userId || !actorId || userId === actorId) return; // never notify yourself
    try {
        const client = await api.getClient();
        const { error } = await client.from('notifications').insert({
            user_id: userId,
            actor_id: actorId,
            actor_name: actorName || 'Someone',
            actor_avatar_url: actorAvatarUrl || null,
            type,
            target_id: targetId != null ? String(targetId) : null,
            target_name: targetName || null,
            preview: (preview || '').slice(0, 140)
        });
        if (error) log.error('NOTIFICATIONS', 'Failed to create notification', error);
    } catch (e: any) {
        log.error('NOTIFICATIONS', 'Failed to create notification', e);
    }
}

// named columns instead of select('*') since this runs every 30s per signed-in tab
const NOTIFICATION_COLUMNS =
    'id, type, actor_name, actor_avatar_url, actor_id, target_id, target_name, preview, read, created_at';

/**
 * @param {{countOnly?: boolean}} [options] countOnly fetches just the unread
 *        number (a few bytes vs ~10 kB for 50 full rows) since that's all the
 *        closed bell needs.
 */
async function fetchNotifications(options: Record<string, any> = {}) {
    const ns = ensureNotificationState();
    if (!state.user) { ns.items = []; ns.unreadCount = 0; return; }
    // skip the request while offline rather than spend it on a guaranteed error
    if (navigator.onLine === false) return;
    ns.loading = true;
    try {
        const client = await api.getClient();
        if (options.countOnly) {
            const { count, error } = await client
                .from('notifications')
                .select('id', { count: 'exact', head: true })
                .eq('user_id', state.user.id)
                .eq('read', false);
            if (error) throw error;
            ns.unreadCount = count || 0;
            ns.fetchFailed = false;
            // ns.items left alone; opening the panel refreshes it
            return;
        }
        const { data, error } = await client
            .from('notifications')
            .select(NOTIFICATION_COLUMNS)
            .eq('user_id', state.user.id)
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) throw error;
        ns.items = data || [];
        ns.unreadCount = ns.items.filter(n => !n.read).length;
        ns.fetchFailed = false;
    } catch (e: any) {
        // fail quietly rather than toast-spam every poll; logged once per
        // outage (re-armed on next success) rather than once per 30s
        if (!ns.fetchFailed) {
            ns.fetchFailed = true;
            log.error('NOTIFICATIONS', 'Failed to load notifications; will keep retrying quietly', e);
        }
    } finally {
        ns.loading = false;
    }
}

// The bell and its panel are drawn by js/app/shell/Notifications.tsx.
function renderNotificationBadge() { notify(); }
function renderNotificationsPanel() { notify(); }

function timeAgo(dateStr) {
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
}

/** What happened, after the actor's name: "commented on Emberpup". Plain text. */
function notificationText(n) {
    if (n.type === 'mod_warning') return `issued you a warning${n.target_name ? ` for ${n.target_name}` : ''}`;
    if (n.type === 'mod_muted') return 'muted your account';
    if (n.type === 'mod_banned') return 'suspended your account';
    if (n.type === 'mod_comment_deleted') return 'removed one of your comments';
    if (n.type === 'profile_comment') return 'commented on your profile';
    if (n.type === 'follow') return 'started following you';
    if (n.type === 'post_comment') return 'commented on your post';
    if (n.type === 'repost') return `${n.preview ? 'shared' : 'reposted'} ${n.target_name || 'your post'}`;
    if (n.type === 'mon_deleted') return `removed your Fakemon "${n.target_name || 'submission'}" from the Community Hub`;
    if (n.type === 'contest_submission_deleted') return `removed your contest entry "${n.target_name || 'submission'}"`;
    return `commented on ${n.target_name || 'your Fakemon'}`;
}

/**
 * Everything the header's bell shows. signedIn false hides it; loading with
 * no rows yet shows skeletons.
 */
function notificationsView(): {
    signedIn: boolean; open: boolean; unread: number; loading: boolean;
    items: Array<{ id: string; read: boolean; actorName: string; actorId: string; actorAvatar: string; text: string; preview: string; time: string }>;
} {
    const ns = ensureNotificationState();
    return {
        signedIn: !!state.user, open: !!ns.open, unread: ns.unreadCount || 0,
        loading: !!ns.loading && !ns.items.length,
        items: ns.items.map(n => ({
            id: String(n.id), read: !!n.read, actorName: n.actor_name || 'Someone', actorId: n.actor_id || '', actorAvatar: n.actor_avatar_url || '',
            text: notificationText(n), preview: n.preview || '', time: timeAgo(n.created_at)
        }))
    };
}

function startNotificationPolling() {
    const ns = ensureNotificationState();
    if (ns.pollTimer) return;
    ns.pollTimer = setInterval(() => {
        // skip polling a hidden tab; browsers don't throttle timers to zero reliably
        if (document.visibilityState === 'hidden') return;
        fetchNotifications({ countOnly: !ns.open }).then(() => {
            renderNotificationBadge();
            if (ns.open) renderNotificationsPanel();
        });
    }, POLL_INTERVAL_MS);

    // catch up immediately on return instead of waiting for the skipped interval
    if (!ns.visibilityHandler) {
        ns.visibilityHandler = () => {
            if (document.visibilityState !== 'visible' || !state.user) return;
            fetchNotifications({ countOnly: !ns.open }).then(() => {
                renderNotificationBadge();
                if (ns.open) renderNotificationsPanel();
            });
        };
        document.addEventListener('visibilitychange', ns.visibilityHandler);
    }
}

function stopNotificationPolling() {
    const ns = ensureNotificationState();
    if (ns.pollTimer) { clearInterval(ns.pollTimer); ns.pollTimer = null; }
    if (ns.visibilityHandler) {
        document.removeEventListener('visibilitychange', ns.visibilityHandler);
        ns.visibilityHandler = null;
    }
}

async function refreshNotifications() {
    const ns = ensureNotificationState();
    if (!state.user) {
        ns.items = [];
        ns.unreadCount = 0;
        ns.open = false;
        stopNotificationPolling();
        renderNotificationBadge();
        return;
    }
    notify();
    await fetchNotifications();
    renderNotificationBadge();
    if (ns.open) renderNotificationsPanel();
    startNotificationPolling();
}

function toggleNotificationsPanel(event) {
    event?.stopPropagation();
    const ns = ensureNotificationState();
    ns.open = !ns.open;
    notify();
    // shows the stale rows at once, then refreshes (only the count was polled while closed)
    if (ns.open) fetchNotifications().then(notify);
}

function closeNotificationsPanel() {
    const ns = ensureNotificationState();
    if (!ns.open) return;
    ns.open = false;
    notify();
}

async function markAllNotificationsRead(event) {
    event?.stopPropagation();
    const ns = ensureNotificationState();
    if (!state.user || !ns.unreadCount) return;
    ns.items.forEach(n => { n.read = true; });
    ns.unreadCount = 0;
    renderNotificationBadge();
    renderNotificationsPanel();
    try {
        const client = await api.getClient();
        await client.from('notifications').update({ read: true }).eq('user_id', state.user.id).eq('read', false);
    } catch (e: any) {
        log.error('NOTIFICATIONS', 'Failed to mark all read', e);
    }
}

async function markNotificationRead(id) {
    const ns = ensureNotificationState();
    const n = ns.items.find(x => String(x.id) === String(id));
    if (!n || n.read) return;
    n.read = true;
    ns.unreadCount = Math.max(0, ns.unreadCount - 1);
    renderNotificationBadge();
    try {
        const client = await api.getClient();
        await client.from('notifications').update({ read: true }).eq('id', id);
    } catch (e: any) {
        log.error('NOTIFICATIONS', 'Failed to mark notification read', e);
    }
}

async function openNotification(id) {
    const ns = ensureNotificationState();
    const n = ns.items.find(x => String(x.id) === String(id));
    if (!n) return;
    await markNotificationRead(id);
    closeNotificationsPanel();
    if (n.type === 'mon_comment' && n.target_id) {
        await api.openPublishedMonById?.(n.target_id);
    } else if (n.type === 'profile_comment' && n.target_id) {
        await api.showProfileView?.(n.target_id);
    } else if (n.type === 'follow' && n.actor_id) {
        await api.showProfileView?.(n.actor_id);
    } else if (n.type === 'post_comment' && n.target_id) {
        await api.openPost?.(n.target_id);
    } else if (n.type === 'repost' && n.target_id) {
        // "mon:<id>", "post:<id>" or "event:<id>": what was reposted
        const [kind, id] = String(n.target_id).split(':');
        if (kind === 'mon') await api.openPublishedMonById?.(id);
        else if (kind === 'event') await api.openEvents?.(id);
        else await api.openPost?.(id);
    }
}

// ==================== which kinds you get ====================
// Saved in a private row (notification_prefs); the server drops a kind you've
// turned off before it's ever stored, so it can't show up or count as unread.
// Moderation notices always get through.

/** The kinds you can switch off: [type, label, what it is]. */
export const NOTIFICATION_KINDS: Array<[string, string, string]> = [
    ['follow', 'New followers', 'When someone starts following you.'],
    ['mon_comment', 'Comments on your Fakémon', 'When someone comments on a Fakémon you published.'],
    ['post_comment', 'Comments on your posts', 'When someone comments on something you posted.'],
    ['profile_comment', 'Posts on your wall', 'When someone writes on your profile.'],
    ['repost', 'Reposts and shares', 'When someone reposts or shares your Fakémon or posts.']
];

const prefState: { userId: string | null; prefs: Record<string, boolean> | null; loading: boolean } = { userId: null, prefs: null, loading: false };

async function loadNotificationPrefs() {
    const me = state.user?.id;
    if (!me || prefState.loading) return;
    prefState.loading = true;
    try {
        const client = await api.getClient();
        const { data, error } = await client.from('notification_prefs').select('prefs').eq('user_id', me).maybeSingle();
        if (error) throw error;
        prefState.userId = me;
        prefState.prefs = data?.prefs || {};
    } catch (e: any) {
        log.warn('NOTIFICATIONS', 'Could not load notification settings', e);
        prefState.prefs = prefState.prefs || {};
    } finally {
        prefState.loading = false;
        notify();
    }
}

/** Your settings, or null while they load (asking starts the load). Missing keys mean on. */
export function notificationPrefs(): Record<string, boolean> | null {
    if (!state.user) return null;
    if (prefState.userId !== state.user.id) {
        prefState.prefs = null;
        prefState.userId = state.user.id;
        loadNotificationPrefs();
    }
    return prefState.prefs;
}

/** Turns one kind (or "all") on or off. */
export async function setNotificationPref(key: string, on: boolean) {
    const me = state.user?.id;
    if (!me) return;
    const before = { ...(prefState.prefs || {}) };
    const next = { ...before, [key]: on };
    prefState.prefs = next;
    notify();
    try {
        const client = await api.getClient();
        const { error } = await client.from('notification_prefs').upsert({ user_id: me, prefs: next, updated_at: new Date().toISOString() });
        if (error) throw error;
    } catch (e: any) {
        prefState.prefs = before;
        notify();
        api.showToast?.('Could not save that setting. Please try again.', 'error');
        log.warn('NOTIFICATIONS', 'Could not save notification settings', e);
    }
}

export {
    notificationsView,
    createNotification, fetchNotifications, refreshNotifications, renderNotificationBadge, renderNotificationsPanel,
    toggleNotificationsPanel, closeNotificationsPanel, markAllNotificationsRead, markNotificationRead, openNotification
};
