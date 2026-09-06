// Four lists on a trainer's profile: published Fakemon, comments, badge
// picker, and hover card. The rest of the profile page stays vanilla (a form
// edited by id, no list-shaped state). Skeleton and real content live in the
// same component so they can't drift apart in layout.

import { useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar.jsx';
import { paintShieldedCanvas } from '../core/art-shield.js';
import { Icon } from './Icon.jsx';
import { BadgeRow } from './Badge.jsx';
import { BADGES, renderCommentMarkdown } from '../core/data.js';

const call = (name, ...args) => window[name]?.(...args);

// ==================== published Fakemon ====================

// Canvas, not <img>, so there's no src to copy or "Save image as" on
// right-click. Painted via js/core/art-shield.js -- see that module's header.
function ShieldedArt({ art, alt, className = '' }) {
    const canvasRef = useRef(null);

    useEffect(() => {
        let live = true;
        if (canvasRef.current && art) {
            paintShieldedCanvas(canvasRef.current, art).catch(() => {});
        }
        return () => { live = false; };
    }, [art]);

    return <canvas ref={canvasRef} className={`shielded-art ${className}`} role="img" aria-label={alt || ''} />;
}

function MonArt({ row, mon, requestArtwork }) {
    // lazy-fetches masked artwork near-viewport. The gallery query no longer
    // carries a thumbnail -- see the masked_artwork_transport migration.
    const [art, setArt] = useState(mon.artwork || '');
    const ref = useRef(null);

    useEffect(() => {
        if (art || !requestArtwork) return;
        let live = true;
        const fetchIt = () => requestArtwork(row.id).then(url => { if (live && url) setArt(url); }).catch(() => {});

        if (typeof IntersectionObserver === 'undefined') {
            fetchIt();
            return () => { live = false; };
        }
        const observer = new IntersectionObserver(entries => {
            if (!entries.some(e => e.isIntersecting)) return;
            observer.disconnect();
            fetchIt();
        }, { rootMargin: '300px' });
        if (ref.current) observer.observe(ref.current);
        return () => { live = false; observer.disconnect(); };
    }, [row.id, art, requestArtwork]);

    return (
        <div className="profile-mon-art" ref={ref}>
            {art
                ? <ShieldedArt art={art} alt={`${mon.name || 'Fakémon'} artwork`} />
                : <img className="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork" draggable="false" />}
        </div>
    );
}

// mirrors .profile-mon-card's markup so it swaps in without layout shift
function MonCardSkeleton() {
    return (
        <div className="profile-mon-card skel-card">
            <div className="profile-mon-art skel" />
            <strong className="skel skel-text" style={{ margin: '10px 12px 5px', width: '70%' }} />
            <div className="card-types">
                <span className="skel skel-pill" />
                <span className="skel skel-pill" />
            </div>
        </div>
    );
}

export function ProfileMons({ mons = [], loading = false, requestArtwork }) {
    if (loading) return <>{Array.from({ length: 4 }, (_, i) => <MonCardSkeleton key={i} />)}</>;
    if (!mons.length) return <div className="profile-empty">No published Fakemon yet.</div>;

    return (
        <>
            {mons.map(row => {
                const mon = row.fakemon_data || {};
                return (
                    <button
                        key={row.id}
                        type="button"
                        className="profile-mon-card"
                        onClick={() => call('openPublishedMonById', row.id)}
                    >
                        <MonArt row={row} mon={mon} requestArtwork={requestArtwork} />
                        <strong>{mon.name || 'Fakemon'}</strong>
                        <div className="card-types">
                            {mon.type1 && <span className={`type-badge type-${String(mon.type1).toLowerCase()}`}>{mon.type1}</span>}
                            {mon.type2 && <span className={`type-badge type-${String(mon.type2).toLowerCase()}`}>{mon.type2}</span>}
                        </div>
                    </button>
                );
            })}
        </>
    );
}

// ==================== comments on a profile ====================

// mirrors .profile-comment's markup
function ProfileCommentSkeleton() {
    return (
        <div className="profile-comment skel-card">
            <div className="profile-comment-header">
                <span className="community-mini-avatar skel skel-circle" />
                <strong className="skel skel-text" style={{ width: 90 }} />
            </div>
            <div className="profile-comment-body">
                <span className="skel skel-text" style={{ width: '95%' }} />
                <span className="skel skel-text" style={{ width: '65%' }} />
            </div>
        </div>
    );
}

export function ProfileComments({ comments = [], loading = false, viewerId = null, viewerIsStaff = false }) {
    if (loading) return <>{Array.from({ length: 3 }, (_, i) => <ProfileCommentSkeleton key={i} />)}</>;
    if (!comments.length) {
        return <div className="profile-empty">No comments yet. Be the first to say hello!</div>;
    }

    return (
        <>
            {comments.map(c => {
                const author = c.author || {};
                const name = author.display_name || author.username || 'User';
                const mine = !!viewerId && c.user_id === viewerId;
                const canDelete = mine || viewerIsStaff;
                const badgeKeys = Array.isArray(author.display_badges) ? author.display_badges : [];

                return (
                    <div className="profile-comment" key={c.id}>
                        <div
                            className="profile-comment-header"
                            title="View profile"
                            onClick={() => call('showUserProfile', c.user_id)}
                        >
                            <Avatar userId={c.user_id} url={author.avatar_url} name={name} />
                            <strong>{name}</strong>
                            <BadgeRow badgeKeys={badgeKeys} size={12} />
                            <span className="profile-comment-time">{new Date(c.created_at).toLocaleString()}</span>
                            {canDelete && (
                                <button
                                    type="button"
                                    className="mon-comment-delete"
                                    title="Delete"
                                    onClick={e => { e.stopPropagation(); call('deleteProfileComment', c.id); }}
                                >
                                    <Icon name="trash-2" style={{ width: 12, height: 12 }} />
                                </button>
                            )}
                        </div>
                        {/* app-generated markup, not raw user input -- see CommentList.jsx */}
                        <div
                            className="profile-comment-body"
                            dangerouslySetInnerHTML={{ __html: renderCommentMarkdown(c.body) }}
                        />
                    </div>
                );
            })}
        </>
    );
}

// ==================== which badges to show ====================
// Earned badges vs. displayed badges are different things; this picks the
// display set. Checkboxes stay uncontrolled with data-badge attributes since
// submitDisplayedBadges() reads the selection straight off the DOM.

export function BadgePicker({ owned = [], selected = [] }) {
    if (!owned.length) {
        return <div className="profile-badges-empty">You do not have any badges yet.</div>;
    }
    const shown = new Set(selected);
    return (
        <>
            {owned.map(key => {
                const b = BADGES[key];
                if (!b) return null;     // key this copy of the site doesn't know
                return (
                    <label className="profile-badge-option" key={key}>
                        <input type="checkbox" data-badge={key} defaultChecked={shown.has(key)} />
                        <span className="profile-badge-option-icon">
                            <Icon name={b.icon || 'star'} style={{ color: b.color || 'var(--accent)' }} />
                        </span>
                        <span className="profile-badge-option-copy">
                            <strong>{b.label || key}</strong>
                            <small>{b.tooltip || ''}</small>
                        </span>
                    </label>
                );
            })}
        </>
    );
}

// ==================== hover card ====================
// Preview of a user without leaving the page. Renders contents only; the
// caller positions it against the anchor element.

export function UserHoverCard({ profile = null, loading = false }) {
    if (loading || !profile) {
        return (
            <>
                <div className="user-hover-card-accent" />
                <div className="user-hover-card-top">
                    <div className="user-hover-card-avatar skel skel-circle" />
                    <div className="user-hover-card-identity">
                        <div className="user-hover-card-label">Trainer card</div>
                        <strong className="skel skel-text" style={{ width: 110, height: 16 }} />
                        <span className="skel skel-text" style={{ width: 70, marginTop: 4 }} />
                    </div>
                </div>
                <div className="user-hover-card-bio">
                    <span className="skel skel-text" style={{ width: '100%' }} />
                    <span className="skel skel-text" style={{ width: '80%' }} />
                </div>
            </>
        );
    }

    const name = profile.display_name || profile.username || 'Trainer';
    const badges = Array.isArray(profile.display_badges) ? profile.display_badges : [];

    return (
        <>
            <div className="user-hover-card-accent" />
            <div className="user-hover-card-top">
                <div className="user-hover-card-avatar">
                    <Avatar userId={profile.id} url={profile.avatar_url} name={name} className="profile-avatar-img" />
                </div>
                <div className="user-hover-card-identity">
                    <div className="user-hover-card-label">Trainer card</div>
                    <strong>{name}</strong>
                    <span>@{profile.username || ''}</span>
                </div>
            </div>
            <div className="user-hover-card-badges">
                <BadgeRow badgeKeys={badges} size={15} />
            </div>
            {profile.bio && <div className="user-hover-card-bio">{profile.bio}</div>}
            {profile.created_at && (
                <div className="user-hover-card-joined">
                    Joined {new Date(profile.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })}
                </div>
            )}
        </>
    );
}
