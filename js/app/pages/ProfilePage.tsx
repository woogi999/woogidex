// A creator's profile (/profile/<username>), part Facebook, part Tumblr: a
// cover banner with their picture and numbers on it, an intro column (bio,
// links, badges, a peek at their Fakémon and followers), and their timeline
// (their posts and Fakémon, and what others write on their wall, in one
// stream like Facebook), with a tab for the full gallery. Their accent colour
// tints the page. On your own profile, Edit Profile swaps in the forms for
// your name, bio, pictures, look, username, badges, email and connected accounts.

import { useEffect, useState, type ChangeEvent } from 'react';
import { cropThen } from '../dialogs/cropImage.tsx';
import { api, state } from '../../core/app.ts';
import { Avatar } from '../components/Avatar.tsx';
import { BadgeRow } from '../components/Badge.tsx';
import { ConnectedAccounts } from '../components/ConnectedAccounts.tsx';
import { Icon } from '../components/Icon.tsx';
import { FeedCard, FeedSkeleton, PostComposer } from '../components/feed.tsx';
import { WallComposer, WallPostCard } from '../components/comments.tsx';
import { getThread, loadThread } from '../../features/comments.ts';
import { BadgePicker, ProfileMons } from '../components/profile.tsx';
import { LazyArt } from '../components/community.tsx';
import { ShieldedArt } from '../components/ShieldedArt.tsx';
import { useStore } from '../store.ts';
import { Modal } from '../components/Modal.tsx';
import { openDialog, registerDialog, type DialogProps } from '../dialogs.tsx';

type Message = { text: string; ok?: boolean };
type Tab = 'posts' | 'fakemon';

// banner presets: name -> CSS background. Stored as "preset:<name>".
export const BANNER_PRESETS: Record<string, string> = {
    sunset: 'linear-gradient(120deg, #ff5f6d, #ffc371)',
    ocean: 'linear-gradient(120deg, #2193b0, #6dd5ed)',
    aurora: 'linear-gradient(120deg, #00c9a7, #845ec2 55%, #d65db1)',
    ember: 'linear-gradient(120deg, #7a1f1f, #e2574c 50%, #f9c74f)',
    forest: 'linear-gradient(120deg, #134e5e, #71b280)',
    cosmic: 'linear-gradient(120deg, #0f0c29, #302b63 50%, #24243e)',
    candy: 'linear-gradient(120deg, #f8a5c2, #a29bfe)',
    stellar: 'linear-gradient(100deg, #f06a8e, #f5a55a 28%, #e8d35a 48%, #6cc8a0 68%, #5d8fe8 88%, #9a6cf0)'
};
export const ACCENTS = ['#7c5cff', '#e07a5f', '#2bb3a8', '#e6a23c', '#3b82f6', '#c056d8', '#5aa469', '#d64f7a', '#1d2433'];

// who sees what (the profiles.privacy column); the server enforces the same for
// the timeline and follower lists (profile_part_visible)
export const PRIVACY_PARTS: Array<[string, string]> = [
    ['profile', 'Whole profile'], ['details', 'Bio & details'], ['posts', 'Posts & wall'], ['fakemon', 'Fakémon gallery'], ['follows', 'Followers & following']
];
function canSee(profile: any, part: string, isOwn: boolean, following: boolean): boolean {
    if (isOwn || api.isStaff?.()) return true;
    const levels = [profile.privacy?.profile, profile.privacy?.[part]];
    if (levels.includes('only_me')) return false;
    return !levels.includes('followers') || following;
}

function bannerBackground(p: any): string {
    const c = String(p?.banner_color || '');
    if (c.startsWith('preset:')) return BANNER_PRESETS[c.slice(7)] || '';
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    return '';
}

export function ProfilePage() {
    useStore();
    const status = state.profilePageStatus || 'loading';
    const profile = state.profilePageUser;
    const isOwn = !!state.user && !!profile && state.user.id === profile.id;
    const editing = !!state.profilePageEditing && isOwn;

    if (status === 'error') {
        return (
            <div className="profile-page-shell">
                <div className="profile-loading profile-load-error" style={{ display: 'flex' }}>
                    <strong>Couldn’t load this profile.</strong>
                    <span>{state.profilePageError}</span>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => api.showProfileView()}>Try Again</button>
                </div>
            </div>
        );
    }

    return (
        <div className="profile-page-shell">
            {editing ? <EditProfile profile={profile} />
                : status === 'loading' || !profile ? <PublicProfileSkeleton />
                : <PublicProfile key={profile.id} profile={profile} isOwn={isOwn} />}
        </div>
    );
}

// ==================== the public page ====================

// the same boxes as the loaded page, in the same places, so nothing jumps
// when it arrives
function PublicProfileSkeleton() {
    return (
        <div className="profile2 profile2-skeleton" aria-busy="true" aria-label="Loading profile">
            <div className="profile2-cover skel" />
            <div className="profile2-head">
                <div className="profile2-avatar-wrap"><span className="profile2-avatar skel skel-circle" /></div>
                <div className="profile2-identity">
                    <span className="skel skel-text profile2-skel-name" />
                    <span className="skel skel-text profile2-skel-handle" />
                    <div className="profile2-numbers">
                        {[64, 76, 84, 72].map((w, i) => <span key={i} className="skel skel-text profile2-skel-number" style={{ width: w }} />)}
                    </div>
                </div>
                <div className="profile2-actions">
                    <span className="skel profile2-skel-btn" style={{ width: 96 }} />
                    <span className="skel profile2-skel-btn" style={{ width: 92 }} />
                </div>
            </div>
            <div className="profile2-body">
                <div className="profile2-side">
                    <section className="panel profile2-card">
                        <span className="skel skel-text profile2-skel-title" />
                        <span className="skel skel-text" style={{ width: '90%', margin: '0 auto' }} />
                        <span className="skel skel-text" style={{ width: '65%', margin: '0 auto' }} />
                        <span className="skel skel-text" style={{ width: '55%', marginTop: 10 }} />
                        <span className="skel skel-text" style={{ width: '45%' }} />
                    </section>
                    <section className="panel profile2-card">
                        <span className="skel skel-text profile2-skel-title" />
                        <div className="profile2-peek">{Array.from({ length: 6 }, (_, i) => <span key={i} className="profile2-peek-mon skel" />)}</div>
                    </section>
                </div>
                <div className="profile2-main">
                    <div className="profile2-tabs">
                        {[48, 70, 44].map((w, i) => <span key={i} className="profile2-skel-tab"><span className="skel skel-text" style={{ width: w }} /></span>)}
                    </div>
                    <div className="profile2-timeline"><FeedSkeleton count={2} /></div>
                </div>
            </div>
        </div>
    );
}

function PublicProfile({ profile, isOwn }: { profile: any; isOwn: boolean }) {
    const [tab, setTab] = useState<Tab>('posts');
    const displayName = profile.display_name || profile.username || 'Profile';
    const stats = profile.stats || {};
    const following = api.isFollowing?.(profile.id) || !!stats.i_follow;
    const blocked = api.hasBlocked?.(profile.id) || !!stats.i_blocked;
    const accent = /^#[0-9a-f]{6}$/i.test(profile.accent_color || '') ? profile.accent_color : '';
    const cover = bannerBackground(profile);
    const followers = Number(stats.followers || 0) + (following && !stats.i_follow ? 1 : 0) - (!following && stats.i_follow ? 1 : 0);
    const tabs: Array<[Tab, string, number | null]> = [
        ['posts', 'Posts', null], ['fakemon', 'Fakémon', Number(stats.mons ?? (profile.mons || []).length)]
    ];
    // followers and following open as a pop-up list, like Instagram
    const see = (part: string) => canSee(profile, part, isOwn, following);
    const showFollows = (which: 'followers' | 'following') => { if (see('follows')) openDialog('follow-list', { userId: profile.id, which, isOwn, name: displayName }); };

    return (
        <div className="profile2" style={accent ? ({ '--profile-accent': accent } as any) : undefined}>
            <div className={`profile2-cover${profile.banner_url ? ' has-image' : ''}`} style={{ background: cover || undefined }}>
                {profile.banner_url && <ShieldedArt src={profile.banner_url} className="avatar-art" />}
            </div>
            <div className="profile2-head">
                <div className="profile2-avatar-wrap">
                    <Avatar userId={profile.id} url={profile.avatar_url} name={displayName} className="profile2-avatar" />
                </div>
                <div className="profile2-identity">
                    <h1>{displayName}<BadgeRow badgeKeys={Array.isArray(profile.display_badges) ? profile.display_badges : []} size={18} /></h1>
                    <div className="profile2-handle">
                        {profile.username && <span>@{profile.username}</span>}
                        {profile.pronouns && see('details') && <span className="profile2-pronouns">{profile.pronouns}</span>}
                        {stats.follows_me && !isOwn && <span className="profile2-follows-you">Follows you</span>}
                    </div>
                    <div className="profile2-numbers">
                        <button type="button" onClick={() => setTab('posts')}><strong>{Number(stats.posts || 0)}</strong> posts</button>
                        <button type="button" onClick={() => setTab('fakemon')}><strong>{Number(stats.mons ?? 0)}</strong> Fakémon</button>
                        <button type="button" onClick={() => showFollows('followers')}><strong>{followers}</strong> follower{followers === 1 ? '' : 's'}</button>
                        <button type="button" onClick={() => showFollows('following')}><strong>{Number(stats.following || 0)}</strong> following</button>
                    </div>
                </div>
                <div className="profile2-actions">
                    {isOwn ? (
                        <>
                            <button className="btn btn-primary btn-sm" type="button" onClick={() => api.editOwnProfile()}><Icon name="pencil" size={14} /> Edit profile</button>
                            <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openMessages()}><Icon name="chat-bubble-oval-left-ellipsis" size={14} /> Messages</button>
                        </>
                    ) : state.user && !blocked ? (
                        <>
                            {following
                                ? <button className="btn btn-secondary btn-sm profile2-following" type="button" onClick={() => api.unfollowUser(profile.id)}><Icon name="check" size={14} /><span>Following</span></button>
                                : <button className="btn btn-primary btn-sm" type="button" onClick={() => api.followUser(profile.id)}><Icon name="user-plus" size={14} /> Follow</button>}
                            {!stats.blocked_me && profile.dm_privacy !== 'nobody' && (
                                <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.messageUser(profile.id)}><Icon name="chat-bubble-oval-left-ellipsis" size={14} /> Message</button>
                            )}
                        </>
                    ) : null}
                    <ProfileMenu profile={profile} isOwn={isOwn} blocked={blocked} />
                </div>
            </div>

            {blocked ? (
                <div className="feed-empty"><Icon name="no-symbol" size={24} /><p>You blocked {displayName}. Unblock them from the ⋯ menu to see their profile.</p></div>
            ) : !see('profile') ? (
                <div className="feed-empty"><Icon name="lock-closed" size={24} /><p>{profile.privacy?.profile === 'followers' ? `${displayName}'s profile is for followers only.` : `${displayName}'s profile is private.`}</p></div>
            ) : (
                <div className="profile2-body">
                    <div className="profile2-side">
                        <Intro profile={profile} isOwn={isOwn} details={see('details')} />
                        {see('fakemon') && <GalleryPeek profile={profile} onAll={() => setTab('fakemon')} />}
                    </div>
                    <div className="profile2-main">
                        <div className="profile2-tabs" role="tablist">
                            {tabs.map(([key, label, n]) => (
                                <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
                                    {label}{n !== null && <span className="profile2-tab-count">{n}</span>}
                                </button>
                            ))}
                        </div>
                        {tab === 'posts' && (see('posts') ? <Timeline profile={profile} isOwn={isOwn} /> : <PrivatePart />)}
                        {tab === 'fakemon' && (see('fakemon') ? <div className="profile-mons-grid"><ProfileMons mons={profile.mons || []} /></div> : <PrivatePart />)}
                    </div>
                </div>
            )}
        </div>
    );
}

function PrivatePart() {
    return <div className="feed-empty"><Icon name="lock-closed" size={24} /><p>This part of the profile is private.</p></div>;
}

function ProfileMenu({ profile, isOwn, blocked }: { profile: any; isOwn: boolean; blocked: boolean }) {
    const [open, setOpen] = useState(false);
    const name = profile.display_name || profile.username || 'them';
    const copy = async () => {
        setOpen(false);
        const url = api.routeUrl(`profile/${encodeURIComponent(profile.username || profile.id)}`);
        try { await navigator.clipboard.writeText(url); api.showToast('Profile link copied!', 'success'); } catch { window.prompt('Copy this link:', url); }
    };
    return (
        <div className="feed-menu-wrap">
            <button type="button" className="btn btn-secondary btn-sm btn-icon" aria-label="More" onClick={() => setOpen(v => !v)}><Icon name="ellipsis-horizontal" size={16} /></button>
            {open && (
                <div className="feed-menu feed-menu-right" onMouseLeave={() => setOpen(false)}>
                    <button type="button" onClick={copy}><Icon name="link" size={14} /> Copy profile link</button>
                    {!isOwn && state.user && (blocked
                        ? <button type="button" onClick={() => { setOpen(false); api.unblockUser(profile.id); }}><Icon name="no-symbol" size={14} /> Unblock {name}</button>
                        : <button type="button" className="is-danger" onClick={() => { setOpen(false); api.blockUser(profile.id, name); }}><Icon name="no-symbol" size={14} /> Block {name}</button>)}
                    <button type="button" onClick={() => { setOpen(false); api.showCollection(); }}><Icon name="arrow-left" size={14} /> Back to my collection</button>
                </div>
            )}
        </div>
    );
}

function Intro({ profile, isOwn, details = true }: { profile: any; isOwn: boolean; details?: boolean }) {
    const site = String(profile.website || '');
    const siteLabel = site.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    return (
        <section className="panel profile2-card">
            <h3>Intro</h3>
            {!details ? <p className="profile2-bio is-empty">Details are private.</p> : profile.bio ? <p className="profile2-bio">{profile.bio}</p> : <p className="profile2-bio is-empty">{isOwn ? 'Add a bio so people know what you make.' : 'No bio yet.'}</p>}
            <ul className="profile2-facts">
                {details && profile.location && <li><Icon name="map-pin" size={16} /> {profile.location}</li>}
                {details && site && <li><Icon name="link" size={16} /> <a href={/^https?:\/\//i.test(site) ? site : '#'} target="_blank" rel="noopener noreferrer nofollow ugc">{siteLabel}</a></li>}
                {profile.created_at && <li><Icon name="calendar" size={16} /> Joined {new Date(profile.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}</li>}
            </ul>
            {isOwn && <ConnectedBadges />}
            {isOwn && <button type="button" className="btn btn-secondary btn-sm profile2-wide" onClick={() => api.editOwnProfile()}>Edit details</button>}
        </section>
    );
}

function GalleryPeek({ profile, onAll }: { profile: any; onAll: () => void }) {
    const mons = (profile.mons || []).slice(0, 9);
    if (!mons.length) return null;
    return (
        <section className="panel profile2-card">
            <div className="profile2-card-head"><h3>Fakémon</h3><button type="button" className="link-btn" onClick={onAll}>See all</button></div>
            <div className="profile2-peek">
                {mons.map((row: any) => (
                    <button type="button" key={row.id} className="profile2-peek-mon" onClick={() => api.openPublishedMonById(row.id)} title={row.fakemon_data?.name}>
                        <LazyArt row={row} className="profile2-peek-art" />
                    </button>
                ))}
            </div>
        </section>
    );
}

/**
 * Everything on a profile in one stream, newest first: their posts and
 * Fakémon, and what other people wrote on their wall. The posts page in 30s;
 * wall posts older than the oldest loaded post wait for "Show older", so the
 * order never jumps.
 */
function Timeline({ profile, isOwn }: { profile: any; isOwn: boolean }) {
    const items: any[] = profile.timeline || [];
    const [more, setMore] = useState<'idle' | 'loading' | 'done'>(items.length < 30 ? 'done' : 'idle');
    const name = profile.display_name || profile.username || 'them';
    useEffect(() => { loadThread('profile', profile.id); }, [profile.id]);
    const wall = getThread('profile', profile.id);

    async function loadMore() {
        setMore('loading');
        try {
            const older = await api.fetchTimeline(profile.id, items[items.length - 1]?.created_at || null);
            profile.timeline = [...items, ...older.filter((o: any) => !items.some(i => i.kind === o.kind && i.id === o.id))];
            setMore(older.length < 30 ? 'done' : 'idle');
        } catch { setMore('idle'); }
    }
    /** After posting from your own profile, the new post shows up at the top. */
    async function refresh() {
        try { profile.timeline = await api.fetchTimeline(profile.id); } catch { /* the post is still on the feed */ }
        setMore((profile.timeline || []).length < 30 ? 'done' : 'idle');
    }

    const oldest = more === 'done' ? 0 : new Date(items[items.length - 1]?.created_at || 0).getTime();
    const entries = [
        ...items.map(item => ({ at: new Date(item.created_at).getTime(), key: `${item.kind}:${item.id}`, node: <FeedCard item={item} /> })),
        ...(wall?.comments || []).filter(c => new Date(c.created_at).getTime() >= oldest).map(c => ({
            at: new Date(c.created_at).getTime(), key: `wall:${c.id}`,
            node: <WallPostCard profileId={profile.id} profileName={name} comment={c} />
        }))
    ].sort((a, b) => b.at - a.at);

    return (
        <div className="profile2-timeline">
            {state.user && (isOwn ? <PostComposer onPosted={refresh} /> : <WallComposer profileId={profile.id} profileName={name} />)}
            {!entries.length && (wall?.status === 'ready' || wall?.status === 'error') && (
                <div className="feed-empty"><Icon name="sparkles" size={24} /><p>{isOwn ? 'Nothing here yet. Share a post or publish a Fakémon!' : `No posts yet. Be the first to write on ${name}'s wall!`}</p></div>
            )}
            {!entries.length && (!wall || wall.status === 'loading') && <FeedSkeleton count={1} />}
            {entries.map(e => <div key={e.key} style={{ display: 'contents' }}>{e.node}</div>)}
            {more !== 'done' && <button type="button" className="btn btn-secondary btn-sm profile2-wide" disabled={more === 'loading'} onClick={loadMore}>{more === 'loading' ? 'Loading…' : 'Show older'}</button>}
        </div>
    );
}

/** Someone's followers or who they follow, in a pop-up with a search box. */
function FollowListDialog({ close, userId, which, isOwn, name }: DialogProps<{ userId: string; which: 'followers' | 'following'; isOwn: boolean; name: string }>) {
    useStore();
    const [rows, setRows] = useState<any[] | null>(null);
    const [query, setQuery] = useState('');
    useEffect(() => {
        let live = true;
        api.fetchFollowList(userId, which).then((r: any[]) => { if (live) setRows(r); }).catch(() => { if (live) setRows([]); });
        return () => { live = false; };
    }, [userId, which]);
    const q = query.trim().toLowerCase();
    const list = (rows || []).filter(r => !q || `${r.display_name || ''} ${r.username || ''}`.toLowerCase().includes(q));
    const emptyText = q ? 'Nobody matches that.'
        : which === 'followers' ? (isOwn ? 'Nobody follows you yet.' : `Nobody follows ${name} yet.`)
        : (isOwn ? 'You don\u2019t follow anyone yet.' : `${name} doesn\u2019t follow anyone yet.`);
    return (
        <Modal onClose={close} title={which === 'followers' ? 'Followers' : 'Following'} className="follow-dialog">
            <input type="search" className="follow-dialog-search" placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search this list" />
            <div className="follow-dialog-list">
                {rows === null ? Array.from({ length: 5 }, (_, i) => (
                    <div className="follow-row" key={i}>
                        <span className="feed-avatar skel skel-circle" />
                        <span className="follow-row-text" style={{ flex: 1 }}><span className="skel skel-text" style={{ width: '45%' }} /><span className="skel skel-text" style={{ width: '30%' }} /></span>
                    </div>
                )) : !list.length ? (
                    <div className="follow-dialog-empty"><Icon name="users" size={26} /><p>{emptyText}</p></div>
                ) : list.map(r => {
                    const me = state.user?.id === r.id;
                    const iFollow = api.isFollowing?.(r.id);
                    return (
                        <div className="follow-row" key={r.id}>
                            <button type="button" className="follow-row-main" onClick={() => { close(); api.showUserProfile(r.id); }}>
                                <Avatar userId={r.id} url={r.avatar_url} name={r.display_name || r.username} className="feed-avatar" />
                                <span className="follow-row-text">
                                    <strong>{r.display_name || r.username}<BadgeRow badgeKeys={r.display_badges || []} size={12} /></strong>
                                    <span>@{r.username}</span>
                                </span>
                            </button>
                            {isOwn && which === 'followers' ? (
                                <button type="button" className="btn btn-secondary btn-sm" title="Remove this follower"
                                    onClick={async () => { if (await api.removeFollower(r.id)) setRows((rows || []).filter(x => x.id !== r.id)); }}>Remove</button>
                            ) : !me && state.user && (iFollow
                                ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => api.unfollowUser(r.id)}>Following</button>
                                : <button type="button" className="btn btn-primary btn-sm" onClick={() => api.followUser(r.id)}>Follow</button>)}
                        </div>
                    );
                })}
            </div>
        </Modal>
    );
}
registerDialog('follow-list', FollowListDialog);

function ConnectedBadges() {
    const [html, setHtml] = useState('');
    useEffect(() => {
        let live = true;
        api.renderConnectedBadgesHtml?.().then((markup: string) => { if (live) setHtml(markup || ''); });
        return () => { live = false; };
    }, []);
    if (!html) return null;
    // brand marks from oauth.ts's own constants
    return <div className="profile-connected-badges" style={{ display: 'flex' }} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ==================== editing your own ====================

function Note({ message }: { message: Message | null }) {
    return <p className="auth-modal-error" style={message?.ok ? { color: 'var(--success, #22c55e)' } : undefined}>{message?.text || ''}</p>;
}

function EditProfile({ profile }: { profile: any }) {
    const user = state.user!;
    const [displayName, setDisplayName] = useState(user.displayName || '');
    const [bio, setBio] = useState(profile.bio || '');
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<string>(user.avatarUrl || '');
    const [detailsMsg, setDetailsMsg] = useState<Message | null>(null);
    const [saving, setSaving] = useState(false);
    const [look, setLook] = useState(() => ({
        pronouns: profile.pronouns || '', location: profile.location || '', website: profile.website || '',
        bannerColor: profile.banner_color || '', accentColor: profile.accent_color || '', dmPrivacy: profile.dm_privacy || 'everyone',
        bannerFile: null as File | null, removeBanner: false,
        privacy: { ...(profile.privacy || {}) } as Record<string, string>
    }));
    const [bannerPreview, setBannerPreview] = useState<string>(profile.banner_url || '');
    // the uncropped pick, so "Adjust crop" starts from the whole picture again
    const [avatarSource, setAvatarSource] = useState<File | null>(null);
    const [bannerSource, setBannerSource] = useState<File | null>(null);
    const patchLook = (patch: Partial<typeof look>) => setLook(l => ({ ...l, ...patch }));

    function chooseBanner(event: ChangeEvent<HTMLInputElement>) {
        const chosen = event.target.files?.[0] || null;
        setDetailsMsg(null);
        if (!chosen) return;
        const problem: string = api.bannerFileProblem(chosen);
        if (problem) { setDetailsMsg({ text: problem }); event.target.value = ''; return; }
        event.target.value = '';
        setBannerSource(chosen);
        cropBanner(chosen);
    }
    const cropBanner = (source: File) => cropThen(source, 3, cropped => {
        patchLook({ bannerFile: cropped, removeBanner: false });
        setBannerPreview(URL.createObjectURL(cropped));
    });
    const cropAvatar = (source: File) => cropThen(source, 1, cropped => {
        setFile(cropped);
        setPreview(URL.createObjectURL(cropped));
    });
    /** Re-crops the picture you just chose, or the one already saved. */
    async function adjust(which: 'avatar' | 'banner') {
        let source = which === 'avatar' ? avatarSource : bannerSource;
        if (!source) {
            const url = which === 'avatar' ? user.avatarUrl : profile.banner_url;
            try {
                const blob = await (await fetch(url)).blob();
                source = new File([blob], which, { type: blob.type });
            } catch { setDetailsMsg({ text: 'Couldn\u2019t load that picture to crop. Choose it again instead.' }); return; }
        }
        (which === 'avatar' ? cropAvatar : cropBanner)(source);
    }

    function chooseAvatar(event: ChangeEvent<HTMLInputElement>) {
        const chosen = event.target.files?.[0] || null;
        setDetailsMsg(null);
        if (!chosen) return;
        const problem: string = api.avatarFileProblem(chosen);
        if (problem) { setDetailsMsg({ text: problem }); event.target.value = ''; return; }
        event.target.value = '';
        setAvatarSource(chosen);
        cropAvatar(chosen);
    }

    async function saveDetails() {
        if (saving) return;
        setSaving(true);
        setDetailsMsg(null);
        try {
            await api.saveProfileDetails({ displayName: displayName.trim(), bio: bio.trim(), file, look });
        } catch (e: any) {
            setDetailsMsg({ text: e?.message || 'Something went wrong.' });
        } finally {
            setSaving(false);
        }
    }

    const accent = /^#[0-9a-f]{6}$/i.test(look.accentColor) ? look.accentColor : '';
    const coverBg = bannerPreview ? undefined : (look.bannerColor.startsWith('preset:') ? BANNER_PRESETS[look.bannerColor.slice(7)] : look.bannerColor) || undefined;

    // laid out like the profile itself, so you edit it where it shows: the
    // cover and picture up top, the look and privacy on the left, your
    // details and account down the right
    return (
        <div className="profile2 profile2-editing" style={accent ? ({ '--profile-accent': accent } as any) : undefined}>
            <div className="profile2-edit-bar">
                <strong><Icon name="pencil" size={16} /> Editing your profile</strong>
                <Note message={detailsMsg} />
                <div className="profile2-edit-bar-actions">
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.cancelEditOwnProfile()}><Icon name="x" size={14} /> Cancel</button>
                    <button className="btn btn-primary btn-sm" type="button" disabled={saving} onClick={saveDetails}>
                        <Icon name="check" size={14} /> {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>

            <div className={`profile2-cover${bannerPreview ? ' has-image' : ''}`} style={{ background: coverBg }}>
                {bannerPreview && <ShieldedArt src={bannerPreview} className="avatar-art" />}
                <div className="profile2-cover-edit">
                    <label className="btn btn-secondary btn-sm"><Icon name="camera" size={14} /> {bannerPreview ? 'Change cover photo' : 'Add cover photo'}
                        <input type="file" accept="image/*" style={{ display: 'none' }} onChange={chooseBanner} />
                    </label>
                    {bannerPreview && <button type="button" className="btn btn-secondary btn-sm" onClick={() => adjust('banner')}><Icon name="arrows-pointing-out" size={14} /> Adjust crop</button>}
                    {bannerPreview && <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setBannerPreview(''); setBannerSource(null); patchLook({ bannerFile: null, removeBanner: true }); }}>Remove</button>}
                </div>
            </div>
            <div className="profile2-head">
                <label className="profile2-avatar-wrap profile2-avatar-edit" title="Change picture">
                    {preview
                        ? <img className="profile2-avatar" src={preview} alt="" />
                        : <span className="profile2-avatar profile2-avatar-fallback"><Icon name="camera" size={34} /></span>}
                    <span className="profile2-avatar-edit-badge"><Icon name="camera" size={16} /></span>
                    <input type="file" accept="image/*" style={{ display: 'none' }} onChange={chooseAvatar} />
                </label>
                <div className="profile2-identity">
                    <h1>{displayName.trim() || profile.username || 'Your name'}</h1>
                    <div className="profile2-handle">
                        {profile.username && <span>@{profile.username}</span>}
                        {look.pronouns.trim() && <span className="profile2-pronouns">{look.pronouns.trim()}</span>}
                    </div>
                    {preview && <button type="button" className="btn btn-secondary btn-sm" onClick={() => adjust('avatar')}><Icon name="arrows-pointing-out" size={14} /> Adjust picture crop</button>}
                    <p className="profile-field-hint">Picture: JPG, PNG or GIF up to 2MB. Cover: wide works best (about 1500 × 500), up to 2MB.</p>
                </div>
            </div>

            <div className="profile2-body">
                <div className="profile2-side">
                    <section className="panel profile2-card">
                        <h3>Look</h3>
                        <div className="form-group">
                            <label>Cover colour <span className="profile-field-hint">(when there's no photo)</span></label>
                            <div className="profile-swatches">
                                <button type="button" className={`profile-swatch is-none${!look.bannerColor ? ' active' : ''}`} onClick={() => patchLook({ bannerColor: '' })} title="Default">∅</button>
                                {Object.entries(BANNER_PRESETS).map(([key, bg]) => (
                                    <button key={key} type="button" className={`profile-swatch${look.bannerColor === `preset:${key}` ? ' active' : ''}`} style={{ background: bg }}
                                        title={key} aria-label={key} onClick={() => patchLook({ bannerColor: `preset:${key}` })} />
                                ))}
                            </div>
                        </div>
                        <div className="form-group">
                            <label>Accent colour</label>
                            <div className="profile-swatches">
                                <button type="button" className={`profile-swatch is-none${!look.accentColor ? ' active' : ''}`} onClick={() => patchLook({ accentColor: '' })} title="Site default">∅</button>
                                {ACCENTS.map(c => (
                                    <button key={c} type="button" className={`profile-swatch${look.accentColor === c ? ' active' : ''}`} style={{ background: c }} aria-label={c} onClick={() => patchLook({ accentColor: c })} />
                                ))}
                                <input type="color" aria-label="Pick any colour" value={accent || '#7c5cff'} onChange={e => patchLook({ accentColor: e.target.value })} />
                            </div>
                        </div>
                    </section>
                    <section className="panel profile2-card">
                        <h3>Privacy</h3>
                        <div className="form-group">
                            <label htmlFor="profile-dm-privacy">Who can message you</label>
                            <select id="profile-dm-privacy" value={look.dmPrivacy} onChange={e => patchLook({ dmPrivacy: e.target.value })}>
                                <option value="everyone">Everyone</option>
                                <option value="following">Only people I follow</option>
                                <option value="nobody">Nobody (new chats)</option>
                            </select>
                            <div className="profile-field-hint">Chats you already have keep working. Blocking someone always stops them.</div>
                        </div>
                        {PRIVACY_PARTS.map(([part, label]) => (
                            <div className="form-group" key={part}>
                                <label htmlFor={`profile-privacy-${part}`}>{label}</label>
                                <select id={`profile-privacy-${part}`} value={look.privacy[part] || 'everyone'}
                                    onChange={e => patchLook({ privacy: { ...look.privacy, [part]: e.target.value } })}>
                                    <option value="everyone">Everyone</option>
                                    <option value="followers">Followers only</option>
                                    <option value="only_me">Only me</option>
                                </select>
                            </div>
                        ))}
                        <div className="profile-field-hint">“Whole profile” limits every part below it. Your name and picture always show, and Fakémon you publish stay on the hub.</div>
                    </section>
                </div>

                <div className="profile2-main">
                    <section className="panel profile2-card">
                        <h3>Details</h3>
                        <div className="form-group">
                            <label htmlFor="profile-display-name">Display name</label>
                            <input type="text" id="profile-display-name" maxLength={40} placeholder="e.g., AshK" autoFocus value={displayName} onChange={e => setDisplayName(e.target.value)} />
                        </div>
                        <div className="form-group">
                            <label htmlFor="profile-bio">Bio</label>
                            <textarea id="profile-bio" maxLength={280} rows={4} placeholder="Tell people a little about yourself..." value={bio} onChange={e => setBio(e.target.value)} />
                            <div className="profile-field-hint">{bio.length}/280</div>
                        </div>
                        <div className="profile-look-fields">
                            <div className="form-group">
                                <label htmlFor="profile-pronouns">Pronouns</label>
                                <input id="profile-pronouns" type="text" maxLength={30} placeholder="e.g. she/her" value={look.pronouns} onChange={e => patchLook({ pronouns: e.target.value })} />
                            </div>
                            <div className="form-group">
                                <label htmlFor="profile-location">Location</label>
                                <input id="profile-location" type="text" maxLength={40} placeholder="e.g. Hoenn" value={look.location} onChange={e => patchLook({ location: e.target.value })} />
                            </div>
                        </div>
                        <div className="form-group">
                            <label htmlFor="profile-website">Website</label>
                            <input id="profile-website" type="url" maxLength={200} placeholder="https://…" value={look.website} onChange={e => patchLook({ website: e.target.value })} />
                        </div>
                    </section>

                    <div className="profile2-account-head"><h3>Account</h3><p>These save on their own, with their own buttons.</p></div>
                    <UsernameCard />
                    <BadgesCard />
                    <EmailCard />
                    <ConnectedAccounts className="panel profile-page-card" heading={
                        <div className="profile-section-title"><div><h3>Connected Accounts</h3><p>Sign in with a linked account as well as your password. Also editable from Settings → Account.</p></div></div>
                    } />
                </div>
            </div>
        </div>
    );
}

function UsernameCard() {
    const user = state.user!;
    const [username, setUsername] = useState(user.username || '');
    const [msg, setMsg] = useState<Message | null>(null);
    const [busy, setBusy] = useState(false);
    async function save() {
        setBusy(true);
        setMsg(null);
        try {
            await api.saveUsername(username);
            setMsg({ text: 'Username updated.', ok: true });
        } catch (e: any) {
            setMsg({ text: e?.message || 'Could not update username.' });
        } finally {
            setBusy(false);
        }
    }
    return (
        <section className="panel profile-page-card">
            <div className="profile-section-title"><div><h3>Username</h3><p>Your username is used to sign in and identify you.</p></div></div>
            <div className="form-group">
                <label htmlFor="profile-username">Username</label>
                <input type="text" id="profile-username" maxLength={20} placeholder="letters, numbers, underscore only" value={username} onChange={e => setUsername(e.target.value)} />
                <div className="profile-field-hint">{api.usernameChangesRemainingText(user.usernameHistory)}</div>
            </div>
            <Note message={msg} />
            <button className="btn btn-secondary auth-submit-btn" type="button" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save Username'}</button>
        </section>
    );
}

function BadgesCard() {
    const user = state.user!;
    const owned: string[] = Array.isArray(user.badges) ? user.badges : [];
    // a badge no longer held can't stay selected
    const initial = (Array.isArray(user.displayBadges) ? user.displayBadges : owned).filter((k: string) => owned.includes(k));
    const [selected, setSelected] = useState<Set<string>>(() => new Set(initial));
    const [msg, setMsg] = useState<Message | null>(null);
    const [busy, setBusy] = useState(false);
    async function save() {
        setBusy(true);
        setMsg(null);
        try {
            await api.saveDisplayedBadges(owned.filter(k => selected.has(k)));
            setMsg({ text: 'Badge display updated.', ok: true });
        } catch (e: any) {
            setMsg({ text: e?.message || 'Could not update badge display.' });
        } finally {
            setBusy(false);
        }
    }
    return (
        <section className="panel profile-page-card">
            <div className="profile-section-title">
                <div><h3>Badges to Show</h3><p>Choose which badges appear on your profile and beside your name.</p></div>
                <span className="profile-badge-count">{owned.filter(k => selected.has(k)).length} of {owned.length} shown</span>
            </div>
            <div className="profile-badges-selection"><BadgePicker owned={owned} selected={selected} onChange={setSelected} /></div>
            <Note message={msg} />
            <button className="btn btn-primary auth-submit-btn" type="button" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save Badge Display'}</button>
        </section>
    );
}

function EmailCard() {
    const user = state.user!;
    const [email, setEmail] = useState(user.hasRealEmail ? user.email || '' : '');
    const [msg, setMsg] = useState<Message | null>(null);
    const [busy, setBusy] = useState<'' | 'save' | 'remove'>('');
    async function save() {
        setBusy('save');
        setMsg(null);
        try {
            await api.saveEmail(email);
            setMsg({ text: 'Email updated. If confirmation is required, check your inbox.', ok: true });
        } catch (e: any) {
            setMsg({ text: e?.message || 'Could not update email.' });
        } finally {
            setBusy('');
        }
    }
    async function remove() {
        setBusy('remove');
        setMsg(null);
        try {
            if (await api.removeAccountEmail()) setMsg({ text: 'Check your current inbox to confirm removal - it takes effect once confirmed.', ok: true });
        } catch (e: any) {
            setMsg({ text: e?.message || 'Could not remove email.' });
        } finally {
            setBusy('');
        }
    }
    return (
        <section className="panel profile-page-card">
            <div className="profile-section-title"><div><h3>Account Email</h3><p>Optional. Use an email for account recovery, or leave the account username-only.</p></div></div>
            <div className="form-group">
                <label htmlFor="profile-email">Account Email</label>
                <input type="email" id="profile-email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder={user.hasRealEmail ? '' : 'No email on file - add one for account recovery'} />
            </div>
            <Note message={msg} />
            <div className="profile-email-actions">
                <button type="button" className="btn btn-secondary profile-email-save-btn" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save Email'}</button>
                {user.hasRealEmail && (
                    <button type="button" className="btn btn-danger profile-email-remove-btn" disabled={!!busy} onClick={remove}>{busy === 'remove' ? 'Removing…' : 'Remove Email'}</button>
                )}
            </div>
        </section>
    );
}
