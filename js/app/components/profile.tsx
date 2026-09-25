// Pieces of a trainer's profile: their published Fakémon, the comments on
// their page, the badge picker, and the hover card shown over a name.
// Skeletons live beside the real content so the two can't drift in shape.

import { useEffect, useRef, useState } from 'react';
import { api } from '../../core/app.ts';
import { renderCommentMarkdown } from '../../core/data.ts';
import { Avatar } from './Avatar.tsx';
import { BadgeIcon, BadgeRow, badgeDefinition } from './Badge.tsx';
import { Icon } from './Icon.tsx';
import { ShieldedArt } from './ShieldedArt.tsx';

export interface PublishedRow { id: string; user_id?: string; published_at?: string; fakemon_data?: { name?: string; type1?: string; type2?: string; artwork?: string }; }
export interface ProfileComment { id: string; user_id: string; body: string; created_at: string; author?: any; }

// ==================== published Fakemon ====================

/** Artwork fetched once the card nears the screen (the list query carries none). */
function MonArt({ row }: { row: PublishedRow }) {
    const mon = row.fakemon_data || {};
    const [art, setArt] = useState(mon.artwork || '');
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (art || !api.requestCardArtwork) return;
        let live = true;
        const fetchIt = () => api.requestCardArtwork(row.id).then((url: string) => { if (live && url) setArt(url); }).catch(() => {});
        if (typeof IntersectionObserver === 'undefined') { fetchIt(); return () => { live = false; }; }
        const observer = new IntersectionObserver(entries => {
            if (!entries.some(e => e.isIntersecting)) return;
            observer.disconnect();
            fetchIt();
        }, { rootMargin: '300px' });
        if (ref.current) observer.observe(ref.current);
        return () => { live = false; observer.disconnect(); };
    }, [row.id, art]);

    return (
        <div className="profile-mon-art" ref={ref}>
            {art
                ? <ShieldedArt src={art} alt={`${mon.name || 'Fakémon'} artwork`} />
                : <img className="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork" draggable={false} />}
        </div>
    );
}

export function TypeBadges({ type1, type2 }: { type1?: string; type2?: string }) {
    return (
        <div className="card-types">
            {type1 && <span className={`type-badge type-${String(type1).toLowerCase()}`}>{type1}</span>}
            {type2 && <span className={`type-badge type-${String(type2).toLowerCase()}`}>{type2}</span>}
        </div>
    );
}

export function ProfileMons({ mons, loading = false }: { mons?: PublishedRow[]; loading?: boolean }) {
    if (loading) {
        return (
            <>
                {Array.from({ length: 4 }, (_, i) => (
                    <div className="profile-mon-card skel-card" key={i}>
                        <div className="profile-mon-art skel" />
                        <strong className="skel skel-text" style={{ margin: '10px 12px 5px', width: '70%' }} />
                        <div className="card-types"><span className="skel skel-pill" /><span className="skel skel-pill" /></div>
                    </div>
                ))}
            </>
        );
    }
    if (!mons?.length) return <div className="profile-empty">No published Fakemon yet.</div>;
    return (
        <>
            {mons.map(row => {
                const mon = row.fakemon_data || {};
                return (
                    <button key={row.id} type="button" className="profile-mon-card" onClick={() => api.openPublishedMonById(row.id)}>
                        <MonArt row={row} />
                        <strong>{mon.name || 'Fakemon'}</strong>
                        <TypeBadges type1={mon.type1} type2={mon.type2} />
                    </button>
                );
            })}
        </>
    );
}

// ==================== comments on a profile ====================

export function ProfileComments({ comments, loading = false, viewerId = null, viewerIsStaff = false }:
    { comments?: ProfileComment[]; loading?: boolean; viewerId?: string | null; viewerIsStaff?: boolean }) {
    if (loading) {
        return (
            <>
                {Array.from({ length: 3 }, (_, i) => (
                    <div className="profile-comment skel-card" key={i}>
                        <div className="profile-comment-header">
                            <span className="community-mini-avatar skel skel-circle" />
                            <strong className="skel skel-text" style={{ width: 90 }} />
                        </div>
                        <div className="profile-comment-body">
                            <span className="skel skel-text" style={{ width: '95%' }} />
                            <span className="skel skel-text" style={{ width: '65%' }} />
                        </div>
                    </div>
                ))}
            </>
        );
    }
    if (!comments?.length) return <div className="profile-empty">No comments yet. Be the first to say hello!</div>;
    return (
        <>
            {comments.map(c => {
                const author = c.author || {};
                const name = author.display_name || author.username || 'User';
                const canDelete = (!!viewerId && c.user_id === viewerId) || viewerIsStaff;
                return (
                    <div className="profile-comment" key={c.id}>
                        <div className="profile-comment-header" title="View profile" data-user-id={c.user_id} onClick={() => api.showUserProfile(c.user_id)}>
                            <Avatar userId={c.user_id} url={author.avatar_url} name={name} />
                            <strong>{name}</strong>
                            <BadgeRow badgeKeys={Array.isArray(author.display_badges) ? author.display_badges : []} size={12} />
                            <span className="profile-comment-time">{new Date(c.created_at).toLocaleString()}</span>
                            {canDelete && (
                                <button type="button" className="mon-comment-delete" title="Delete"
                                    onClick={e => { e.stopPropagation(); api.deleteProfileComment(c.id); }}>
                                    <Icon name="trash-2" style={{ width: 12, height: 12 }} />
                                </button>
                            )}
                        </div>
                        {/* app-generated markup from renderCommentMarkdown, which escapes the text first */}
                        <div className="profile-comment-body" dangerouslySetInnerHTML={{ __html: renderCommentMarkdown(c.body) }} />
                    </div>
                );
            })}
        </>
    );
}

// ==================== which badges to show ====================
// Earned badges and displayed badges are different things; this picks the display set.

export function BadgePicker({ owned, selected, onChange }: { owned: string[]; selected: Set<string>; onChange: (next: Set<string>) => void }) {
    if (!owned.length) return <div className="profile-badges-empty">You do not have any badges yet.</div>;
    return (
        <>
            {owned.map(key => {
                const b = badgeDefinition(key);
                if (!b) return null;     // a key this copy of the site doesn't know
                return (
                    <label className="profile-badge-option" key={key}>
                        <input type="checkbox" checked={selected.has(key)} onChange={e => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(key); else next.delete(key);
                            onChange(next);
                        }} />
                        <span className="profile-badge-option-icon">
                            <BadgeIcon badge={b} size={24} className="" style={{ color: b.color || 'var(--accent)' }} />
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
// A preview of someone without leaving the page. Contents only; the caller
// positions it against the name it's shown for.

export function UserHoverCard({ profile = null, loading = false }: { profile?: any; loading?: boolean }) {
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
            <div className="user-hover-card-badges"><BadgeRow badgeKeys={Array.isArray(profile.display_badges) ? profile.display_badges : []} size={15} /></div>
            {profile.bio && <div className="user-hover-card-bio">{profile.bio}</div>}
            {profile.created_at && (
                <div className="user-hover-card-joined">
                    Joined {new Date(profile.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })}
                </div>
            )}
        </>
    );
}
