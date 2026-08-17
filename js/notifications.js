import { log } from './log.js';
import { state, api } from './app.js';

// ==================== notifications ====================
// lets someone know when another user comments on a Fakemon they've
// published to the community hub, or on their profile. replaces the header's
// old sign-in/profile controls (those live in the sidebar now) with a bell
// icon + unread-count badge.
//
// requires a `notifications` table in Supabase. it doesn't exist in the
// current schema yet - run this once against your project:
//
//   create table public.notifications (
//     id uuid primary key default gen_random_uuid(),
//     user_id uuid not null references auth.users(id) on delete cascade,       -- recipient
//     actor_id uuid references auth.users(id) on delete set null,              -- who triggered it
//     actor_name text,
//     actor_avatar_url text,
//     type text not null,                 -- 'mon_comment' | 'profile_comment'
//     target_id text,                     -- published_mons.id, or the profile owner's user id
//     target_name text,                   -- mon name, shown in the notification text
//     preview text,                       -- first ~140 chars of the comment
//     read boolean not null default false,
//     created_at timestamptz not null default now()
//   );
//   alter table public.notifications enable row level security;
//   create policy "read own notifications" on public.notifications
//     for select using (auth.uid() = user_id);
//   create policy "insert notifications for others" on public.notifications
//     for insert with check (auth.uid() = actor_id and actor_id <> user_id);
//   create policy "update own notifications" on public.notifications
//     for update using (auth.uid() = user_id);

const POLL_INTERVAL_MS = 30000;

function ensureNotificationState() {
    if (!state.notifications) {
        state.notifications = { items: [], unreadCount: 0, loading: false, open: false, pollTimer: null };
    }
    return state.notifications;
}

// called from community.js (new mon comment) and auth.js (new profile
// comment) right after the comment itself is inserted. silently no-ops if
// the notifications table isn't set up yet, so it can never block a comment
// from posting.
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

async function fetchNotifications() {
    const ns = ensureNotificationState();
    if (!state.user) { ns.items = []; ns.unreadCount = 0; return; }
    ns.loading = true;
    try {
        const client = await api.getClient();
        const { data, error } = await client
            .from('notifications')
            .select('*')
            .eq('user_id', state.user.id)
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) throw error;
        ns.items = data || [];
        ns.unreadCount = ns.items.filter(n => !n.read).length;
    } catch (e) {
        // most likely cause: the `notifications` table hasn't been created
        // yet (see the SQL above). fail quietly rather than toast-spamming
        // on every poll.
        log.error('NOTIFICATIONS', 'Failed to load notifications', e);
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

function escNotif(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
    if (n.type === 'profile_comment') return 'commented on your profile';
    return `commented on ${escNotif(n.target_name || 'your Fakemon')}`;
}

// mirrors the real .notification-item markup (avatar circle, one text line,
// a short time stub) so it swaps to real content without any layout jump.
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
        fetchNotifications().then(() => {
            renderNotificationBadge();
            if (ns.open) renderNotificationsPanel();
        });
    }, POLL_INTERVAL_MS);
}

function stopNotificationPolling() {
    const ns = ensureNotificationState();
    if (ns.pollTimer) { clearInterval(ns.pollTimer); ns.pollTimer = null; }
}

// called from updateAuthUI() on sign-in, sign-out, and token refresh, so the
// bell always reflects whoever is currently signed in.
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
        renderNotificationsPanel();
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

// click handler for a single notification row - marks it read, closes the
// panel, and takes the user to the mon or profile it's about.
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
// notificationSkeleton is internal to this module's rendering only.
