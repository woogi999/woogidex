import { log } from './log.js';
import { state, api } from './app.js';

// bell icon + unread-count badge; notifies on comments to a user's published
// Fakemon or profile. Requires a `notifications` table (see schema/migrations).

const POLL_INTERVAL_MS = 30000;

function ensureNotificationState() {
    if (!state.notifications) {
        state.notifications = { items: [], unreadCount: 0, loading: false, open: false, pollTimer: null };
    }
    return state.notifications;
}

// no-ops silently if the notifications table isn't set up, so it never blocks a comment
async function createNotification({ userId, type, actorId, actorName, actorAvatarUrl, targetId, targetName, preview }) {
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
    } catch (e) {
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
async function fetchNotifications(options = {}) {
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
    } catch (e) {
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

function renderNotificationBadge() {
    const ns = ensureNotificationState();
    const badge = document.getElementById('notifications-badge');
    if (!badge) return;
    if (ns.unreadCount > 0) {
        badge.textContent = ns.unreadCount > 9 ? '9+' : String(ns.unreadCount);
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}
import { esc as escNotif } from './html.js';

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

function notificationText(n) {
    if (n.type === 'mod_warning') return `issued you a warning${n.target_name ? ` for ${escNotif(n.target_name)}` : ''}`;
    if (n.type === 'mod_muted') return 'muted your account';
    if (n.type === 'mod_banned') return 'suspended your account';
    if (n.type === 'mod_comment_deleted') return 'removed one of your comments';
    if (n.type === 'profile_comment') return 'commented on your profile';
    if (n.type === 'mon_deleted') return `removed your Fakemon "${escNotif(n.target_name || 'submission')}" from the Community Hub`;
    if (n.type === 'contest_submission_deleted') return `removed your contest entry "${escNotif(n.target_name || 'submission')}"`;
    return `commented on ${escNotif(n.target_name || 'your Fakemon')}`;
}

// mirrors .notification-item markup so it swaps to real content without layout jump
function notificationSkeleton() {
    return `
        <div class="notification-item skel-card">
            <span class="notification-avatar skel skel-circle"></span>
            <span class="notification-body">
                <span class="notification-text skel skel-text"></span>
                <span class="notification-time skel skel-text"></span>
            </span>
        </div>
    `;
}

function renderNotificationsPanel() {
    const ns = ensureNotificationState();
    const list = document.getElementById('notifications-list');
    if (!list) return;
    if (ns.loading && !ns.items.length) {
        list.innerHTML = Array.from({ length: 4 }, () => notificationSkeleton()).join('');
        return;
    }
    if (!ns.items.length) {
        list.innerHTML = '<div class="notifications-empty">You\'re all caught up - no notifications yet.</div>';
        return;
    }
    list.innerHTML = ns.items.map(n => `
        <button class="notification-item${n.read ? '' : ' unread'}" type="button" onclick="openNotification('${n.id}')">
            ${n.actor_avatar_url ? `<img class="notification-avatar" src="${n.actor_avatar_url}" alt="">` : `<span class="notification-avatar notification-avatar-fallback">${escNotif((n.actor_name || '?').charAt(0).toUpperCase())}</span>`}
            <span class="notification-body">
                <span class="notification-text"><strong>${escNotif(n.actor_name || 'Someone')}</strong> ${notificationText(n)}</span>
                ${n.preview ? `<span class="notification-preview">“${escNotif(n.preview)}”</span>` : ''}
                <span class="notification-time">${timeAgo(n.created_at)}</span>
            </span>
            ${!n.read ? '<span class="notification-dot" aria-hidden="true"></span>' : ''}
        </button>
    `).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
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
    const wrap = document.getElementById('notifications-wrap');
    if (!state.user) {
        ns.items = [];
        ns.unreadCount = 0;
        ns.open = false;
        stopNotificationPolling();
        renderNotificationBadge();
        if (wrap) wrap.style.display = 'none';
        return;
    }
    if (wrap) wrap.style.display = 'inline-flex';
    await fetchNotifications();
    renderNotificationBadge();
    if (ns.open) renderNotificationsPanel();
    startNotificationPolling();
}

function closeNotificationsPanelOnOutsideClick(e) {
    const wrap = document.getElementById('notifications-wrap');
    if (wrap && !wrap.contains(e.target)) closeNotificationsPanel();
}

function toggleNotificationsPanel(event) {
    event?.stopPropagation();
    const ns = ensureNotificationState();
    const panel = document.getElementById('notifications-panel');
    if (!panel) return;
    ns.open = !ns.open;
    panel.style.display = ns.open ? 'block' : 'none';
    if (ns.open) {
        // draw stale rows immediately, then refresh (only the count was polled while closed)
        renderNotificationsPanel();
        fetchNotifications().then(() => {
            renderNotificationBadge();
            if (ns.open) {
                renderNotificationsPanel();
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
        });
        document.addEventListener('click', closeNotificationsPanelOnOutsideClick);
        if (typeof lucide !== 'undefined') lucide.createIcons();
    } else {
        document.removeEventListener('click', closeNotificationsPanelOnOutsideClick);
    }
}

function closeNotificationsPanel() {
    const ns = ensureNotificationState();
    const panel = document.getElementById('notifications-panel');
    if (panel) panel.style.display = 'none';
    ns.open = false;
    document.removeEventListener('click', closeNotificationsPanelOnOutsideClick);
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
    } catch (e) {
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
    } catch (e) {
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
    }
}

export {
    createNotification, fetchNotifications, refreshNotifications, renderNotificationBadge, renderNotificationsPanel,
    toggleNotificationsPanel, closeNotificationsPanel, markAllNotificationsRead, markNotificationRead, openNotification
};
