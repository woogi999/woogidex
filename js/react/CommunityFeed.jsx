// The Community Hub feed. Card artwork is state rather than a DOM patch, and
// skeleton/real cards are two states of one component so they can't drift
// apart in layout. Author names/badges are escaped by construction. Card
// actions call the same window globals the old inline onclick attributes did.

import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { paintShieldedCanvas } from '../core/art-shield.js';
import { BadgeRow } from './Badge.jsx';
import { Avatar } from './Avatar.jsx';
import { prepareCommunityFeed, emptyFeedMessage, evoBadgeLabel } from '../features/community-feed-model.js';

const call = (name, ...args) => window[name]?.(...args);

// ==================== loading state ====================
// Mirrors the real card's layout so swapping in real data shifts nothing.

function SkeletonCard() {
    return (
        <div className="collection-card community-card skel-card">
            <div className="card-art skel" />
            <div className="skel skel-text skel-name" />
            <div className="card-types">
                <span className="skel skel-pill" />
                <span className="skel skel-pill" />
            </div>
            <div className="community-card-stats">
                <span className="skel skel-pill" />
                <span className="skel skel-pill" />
                <span className="skel skel-pill" />
            </div>
            <div className="community-card-author">
                <span className="skel skel-circle" />
                <span className="skel skel-text" />
            </div>
        </div>
    );
}

// ==================== artwork ====================
// Full artwork averages ~176 kB per Fakemon, so a card shows the stored
// thumbnail if there is one, else lazy-fetches the full image near-viewport.

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

function CardArt({ row, mon, requestArtwork }) {
    const stored = mon.thumbnail || mon.artwork;
    const [art, setArt] = useState(stored || '');
    const ref = useRef(null);

    useEffect(() => {
        if (art || !requestArtwork) return;

        let live = true;
        const fetchIt = () => {
            requestArtwork(row.id).then(url => { if (live && url) setArt(url); }).catch(() => {});
        };

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
        <div className="card-art" ref={ref}>
            {art
                ? <ShieldedArt art={art} alt={`${mon.name || 'Fakémon'} artwork`} />
                : <img className="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork" draggable="false" />}
        </div>
    );
}

// ==================== cards ====================

/** Hint that a post bundles an evolution family or forme variants. */
function EvoBadge({ row }) {
    const label = evoBadgeLabel(row);
    if (!label) return null;
    return <span className="community-card-evo-badge">{label}</span>;
}

function Author({ row }) {
    return (
        <div className="community-card-author">
            <Avatar userId={row.user_id} url={row.author_avatar_url} name={row.author_name} />
            <span
                className="community-author-link"
                onClick={e => { e.stopPropagation(); call('showUserProfile', row.user_id); }}
            >
                {row.author_name}
            </span>
            <BadgeRow badgeKeys={row.author_badges} size={13} />
        </div>
    );
}

function CommunityCard({ row, canDelete, isMine, requestArtwork }) {
    const mon = row.fakemon_data || {};
    const open = () => call('openMonDetail', row.id);

    return (
        <div className="collection-card community-card" onClick={open}>
            {canDelete && (
                <button
                    className="card-delete-btn community-unpublish-btn"
                    title={isMine ? 'Unpublish' : 'Remove (staff)'}
                    onClick={e => { e.stopPropagation(); call('unpublishMon', row.id, e); }}
                >
                    <Icon name="trash-2" style={{ width: 14, height: 14 }} />
                </button>
            )}

            <CardArt row={row} mon={mon} requestArtwork={requestArtwork} />
            <div className="card-name">{mon.name}</div>
            <EvoBadge row={row} />

            <div className="card-types">
                {mon.type1 && <span className={`type-badge type-${String(mon.type1).toLowerCase()}`}>{mon.type1}</span>}
                {mon.type2 && <span className={`type-badge type-${String(mon.type2).toLowerCase()}`}>{mon.type2}</span>}
            </div>

            <div className="community-card-stats" aria-label="Community activity">
                <button
                    type="button"
                    className={`community-stat-btn community-like-btn${row.liked_by_me ? ' liked' : ''}`}
                    title={row.liked_by_me ? 'Unlike' : 'Like'}
                    onClick={e => { e.stopPropagation(); call('toggleCommunityLike', row.id, e); }}
                >
                    <Icon name="heart" /><span>{row.like_count || 0}</span>
                </button>
                <button
                    type="button"
                    className="community-stat-btn"
                    title="Comments"
                    onClick={e => { e.stopPropagation(); open(); }}
                >
                    <Icon name="message-circle" /><span>{row.comment_count || 0}</span>
                </button>
                <span className="community-stat-btn community-stat-static" title="Views">
                    <Icon name="eye" /><span>{row.view_count || 0}</span>
                </span>
            </div>

            <Author row={row} />
        </div>
    );
}

// ==================== the grid ====================

/**
 * @param {object} props
 * @param {Array}  props.rows        feed rows, unfiltered and unsorted
 * @param {boolean} props.loading    show skeletons instead of content
 * @param {object} props.prefs       {search, sortBy, sortOrder}
 * @param {string|null} props.viewerId  who is looking, so their own posts show
 *   an unpublish button
 * @param {boolean} props.viewerIsStaff  staff can remove anyone's post
 * @param {(id: string) => Promise<string>} [props.requestArtwork]
 */
export function CommunityFeed({ rows = [], loading = false, prefs = {}, viewerId = null, viewerIsStaff = false, requestArtwork }) {
    if (loading) {
        return <>{Array.from({ length: 8 }, (_, i) => <SkeletonCard key={i} />)}</>;
    }

    const visible = prepareCommunityFeed(rows, prefs);

    if (!visible.length) {
        return <div className="community-empty">{emptyFeedMessage(prefs.search)}</div>;
    }

    return (
        <>
            {visible.map(row => {
                const isMine = !!viewerId && row.user_id === viewerId;
                return (
                    <CommunityCard
                        key={row.id}
                        row={row}
                        isMine={isMine}
                        canDelete={isMine || viewerIsStaff}
                        requestArtwork={requestArtwork}
                    />
                );
            })}
        </>
    );
}
