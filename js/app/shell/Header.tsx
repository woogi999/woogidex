// The app shell's header: logo and search on the left, the four places you
// can go in the middle (Facebook-style tabs), your account on the right.
// Tabs are icon-only on narrow screens; each carries its name in title/aria-label.

import { api, state } from '../../core/app.ts';
import { isAccountMenuOpen } from '../../features/auth.ts';
import { notificationsView } from '../../core/notifications.ts';
import { updatesUnreadCount } from '../../features/updates.ts';
import { Avatar } from '../components/Avatar.tsx';
import { BadgeRow } from '../components/Badge.tsx';
import { Icon } from '../components/Icon.tsx';
import { useClickAway } from '../components/editor/fields.tsx';
import { useStore } from '../store.ts';
import { GlobalSearch } from './GlobalSearch.tsx';

const NAV: Array<{ page: string; label: string; title: string; icon: string; open: () => void }> = [
    { page: 'collection-view', label: 'Collection', title: 'My Collection', icon: 'library', open: () => api.showCollection() },
    { page: 'community-view', label: 'Community', title: 'Community', icon: 'users', open: () => api.openCommunityHub() },
    { page: 'battle-view', label: 'Battle', title: 'Battle', icon: 'swords', open: () => api.openBattle() },
    { page: 'updates-view', label: 'Updates', title: 'Updates & Credits', icon: 'newspaper', open: () => api.openUpdatesPage() }
];

const count = (n: number) => (n > 9 ? '9+' : String(n));

export function Header() {
    useStore();
    // a Community post is still "in" the Community section
    const page = document.body.dataset.page || '';
    const section = page === 'community-detail-view' ? 'community-view' : page;
    const unreadUpdates = updatesUnreadCount();
    return (
        <>
            <div className="header-left">
                <button className="logo logo-button" type="button" onClick={() => api.showCollection()} aria-label="Woogidex home" title="Woogidex">
                    <img src="assets/woogidex_icon.png" alt="Woogidex" />
                </button>
                <GlobalSearch />
            </div>
            <nav className="header-nav" aria-label="Main navigation">
                {NAV.map(n => (
                    <button key={n.page} className={`header-nav-btn${section === n.page ? ' active' : ''}`} type="button" onClick={n.open}
                        title={n.title} aria-label={n.title} aria-current={section === n.page ? 'page' : undefined}>
                        <Icon name={n.icon} /><span className="header-nav-label">{n.label}</span>
                        {n.page === 'updates-view' && unreadUpdates > 0 && <span className="header-nav-badge">{count(unreadUpdates)}</span>}
                    </button>
                ))}
            </nav>
            <div className="header-actions">
                <Notifications />
                {!state.user && <button className="header-signin-btn" type="button" onClick={() => api.openAuthModal('signin')}>Sign In</button>}
                <AccountMenu />
            </div>
        </>
    );
}

function Notifications() {
    const v = notificationsView();
    const ref = useClickAway(v.open, () => api.closeNotificationsPanel());
    if (!v.signedIn) return null;
    return (
        <div className="notifications-wrap" ref={ref}>
            <button className="notifications-bell-btn" type="button" onClick={() => api.toggleNotificationsPanel()} aria-label="Notifications" title="Notifications" aria-expanded={v.open}>
                <Icon name="bell" size={20} />
                {v.unread > 0 && <span className="notifications-badge">{count(v.unread)}</span>}
            </button>
            {v.open && (
                <div className="notifications-panel">
                    <div className="notifications-panel-header">
                        <span>Notifications</span>
                        <button className="notifications-mark-all-btn" type="button" onClick={() => api.markAllNotificationsRead()}>Mark all read</button>
                    </div>
                    <div className="notifications-list">
                        {v.loading
                            // mirrors .notification-item so real rows replace it without a jump
                            ? Array.from({ length: 4 }, (_, i) => (
                                <div className="notification-item skel-card" key={i}>
                                    <span className="notification-avatar skel skel-circle" />
                                    <span className="notification-body"><span className="notification-text skel skel-text" /><span className="notification-time skel skel-text" /></span>
                                </div>
                            ))
                            : !v.items.length
                                ? <div className="notifications-empty">You're all caught up - no notifications yet.</div>
                                : v.items.map(n => (
                                    <button key={n.id} className={`notification-item${n.read ? '' : ' unread'}`} type="button" onClick={() => api.openNotification(n.id)}>
                                        {n.actorAvatar
                                            ? <img className="notification-avatar" src={n.actorAvatar} alt="" />
                                            : <span className="notification-avatar notification-avatar-fallback">{n.actorName.charAt(0).toUpperCase()}</span>}
                                        <span className="notification-body">
                                            <span className="notification-text"><strong>{n.actorName}</strong> {n.text}</span>
                                            {n.preview && <span className="notification-preview">“{n.preview}”</span>}
                                            <span className="notification-time">{n.time}</span>
                                        </span>
                                        {!n.read && <span className="notification-dot" aria-hidden="true" />}
                                    </button>
                                ))}
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * Shown signed in and signed out: it also holds the theme switch, settings
 * and the policy links.
 */
function AccountMenu() {
    const open = isAccountMenuOpen();
    const close = () => api.closeHeaderProfilePopover();
    const ref = useClickAway(open, close);
    const user = state.user;
    const name = user ? (user.displayName || user.username || 'Profile') : '';
    const then = (fn: () => void) => () => { close(); fn(); };
    return (
        <div className={`header-profile-wrap${user ? '' : ' is-signed-out'}`} ref={ref}>
            <button className="header-profile-btn" type="button" onClick={() => api.toggleHeaderProfilePopover()} aria-haspopup="true" aria-expanded={open} aria-label="Account menu" title="Account menu">
                <span className="header-profile-avatar">
                    {user ? <Avatar userId={user.id} url={user.avatarUrl} name={name} className="header-avatar-img" /> : <Icon name="user" />}
                </span>
            </button>
            {open && (
                <div className="header-profile-popover">
                    {user ? (
                        <>
                            <button type="button" className="header-profile-popover-identity" onClick={then(() => api.showProfileView())}>
                                <span className="header-profile-popover-avatar"><Avatar userId={user.id} url={user.avatarUrl} name={name} className="header-avatar-img" /></span>
                                <span className="header-profile-popover-copy">
                                    <strong>{name}<BadgeRow badgeKeys={user.displayBadges || []} size={12} /></strong>
                                    <small>{user.username ? '@' + user.username : 'Edit profile'}</small>
                                </span>
                            </button>
                            <div className="header-profile-popover-divider" />
                        </>
                    ) : (
                        <div className="header-profile-popover-mobile-signin">
                            <button type="button" className="btn btn-primary header-profile-popover-signin" onClick={then(() => api.openAuthModal('signin'))}>Sign In</button>
                            <div className="header-profile-popover-divider" />
                        </div>
                    )}
                    {user && <button type="button" className="header-profile-popover-item" onClick={then(() => api.showProfileView())}><Icon name="user" /><span>View Profile</span></button>}
                    <button type="button" className="header-profile-popover-item" onClick={then(() => api.openSettings())}><Icon name="settings" /><span>Settings</span></button>
                    <button type="button" className="header-profile-popover-item" onClick={then(() => api.openFeedbackModal())}><Icon name="message-circle-warning" /><span>Feedback &amp; bug reports</span></button>
                    {/* a switch, not a one-shot button, so it reads as a setting and shows which theme is on */}
                    <label className="header-profile-popover-item header-theme-row">
                        <Icon name="moon" /><span>Dark mode</span>
                        <input className="header-theme-input" type="checkbox" role="switch" checked={!!api.isDarkModeEnabled()} onChange={() => api.toggleDarkMode()} />
                        <span className="header-theme-switch" aria-hidden="true" />
                    </label>
                    {user && (
                        <>
                            <div className="header-profile-popover-divider" />
                            <button type="button" className="header-profile-popover-item header-profile-popover-danger" onClick={then(() => api.handleSignOutClick())}><Icon name="log-out" /><span>Sign Out</span></button>
                        </>
                    )}
                    <div className="header-profile-popover-legal">
                        <button type="button" onClick={then(() => api.openTermsPage())}>Terms</button>
                        <span aria-hidden="true">&middot;</span>
                        <button type="button" onClick={then(() => api.openPrivacyPage())}>Privacy</button>
                        <span aria-hidden="true">&middot;</span>
                        <button type="button" onClick={then(() => api.openCommunityRulesModal())}>Community Rules</button>
                    </div>
                </div>
            )}
        </div>
    );
}
