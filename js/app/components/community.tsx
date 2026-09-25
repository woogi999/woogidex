// Pieces of the Community Hub: feed cards, the landing shelves' cards, lazy
// artwork, and a post's comment thread.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../../core/app.ts';
import { renderCommentMarkdown } from '../../core/data.ts';
import { emptyFeedMessage, evoBadgeLabel, prepareCommunityFeed } from '../../features/community-feed-model.ts';
import { Avatar } from './Avatar.tsx';
import { BadgeRow } from './Badge.tsx';
import { Icon } from './Icon.tsx';
import { ShieldedArt } from './ShieldedArt.tsx';
import { TypeBadges } from './profile.tsx';

/** A row of the community feed (published_mons, slimmed). */
export interface FeedRow {
    id: string;
    user_id: string;
    published_at: string;
    source_fakemon_id?: string;
    author_name?: string;
    author_avatar_url?: string;
    author_badges?: string[];
    like_count?: number;
    comment_count?: number;
    view_count?: number;
    liked_by_me?: boolean;
    family_snapshots?: any[];
    family_full?: any[];
    fakemon_data?: { name?: string; species?: string; number?: string; type1?: string; type2?: string; artwork?: string; thumbnail?: string; [k: string]: any };
    [extra: string]: any;
}

// ==================== artwork ====================

/**
 * A post's artwork, fetched once its slot nears the screen (the feed query
 * carries no images; see requestCardArtwork in js/features/community.ts).
 */
export function LazyArt({ row, className = 'card-art', children }: { row: FeedRow; className?: string; children?: ReactNode }) {
    const mon = row.fakemon_data || {};
    const [art, setArt] = useState<string>(mon.thumbnail || mon.artwork || '');
    const ref = useRef<HTMLElement>(null);

    useEffect(() => {
        if (art) return;
        let live = true;
        const fetchIt = () => api.requestCardArtwork?.(row.id).then((url: string) => { if (live && url) setArt(url); }).catch(() => {});
        if (typeof IntersectionObserver === 'undefined') { fetchIt(); return () => { live = false; }; }
        const observer = new IntersectionObserver(entries => {
            if (!entries.some(e => e.isIntersecting)) return;
            observer.disconnect();
            fetchIt();
        }, { rootMargin: '300px' });
        if (ref.current) observer.observe(ref.current);
        return () => { live = false; observer.disconnect(); };
    }, [row.id, art]);

    const Tag = className.includes('community-landing-art') || className.includes('community-upload-art') ? 'span' : 'div';
    return (
        <Tag className={className} ref={ref as any}>
            {art
                ? <ShieldedArt src={art} alt={`${mon.name || 'Fakémon'} artwork`} />
                : <img className="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork" draggable={false} />}
            {children}
        </Tag>
    );
}

// ==================== the browse feed ====================

function SkeletonCard() {
    return (
        <div className="collection-card community-card skel-card">
            <div className="card-art skel" />
            <div className="card-body">
                <div className="skel skel-text skel-name" />
                <div className="card-types"><span className="skel skel-pill" /><span className="skel skel-pill" /></div>
                <div className="community-card-stats"><span className="skel skel-pill" /><span className="skel skel-pill" /><span className="skel skel-pill" /></div>
                <div className="community-card-author"><span className="skel skel-circle" /><span className="skel skel-text" /></div>
            </div>
        </div>
    );
}

export function AuthorLine({ row, className = 'community-card-author', prefix = '' }: { row: FeedRow; className?: string; prefix?: string }) {
    return (
        <div className={className}>
            <Avatar userId={row.user_id} url={row.author_avatar_url} name={row.author_name} />
            <span className="community-author-link" data-user-id={row.user_id}
                onClick={e => { e.stopPropagation(); api.showUserProfile(row.user_id); }}>
                {prefix}{row.author_name}
            </span>
            <BadgeRow badgeKeys={row.author_badges} size={13} />
        </div>
    );
}

export function LikeButton({ row, className = 'community-stat-btn community-like-btn' }: { row: FeedRow; className?: string }) {
    return (
        <button type="button" className={`${className}${row.liked_by_me ? ' liked' : ''}`} title={row.liked_by_me ? 'Unlike' : 'Like'}
            onClick={e => { e.stopPropagation(); api.toggleCommunityLike(row.id); }}>
            <Icon name="heart" /><span>{Number(row.like_count || 0)}</span>
        </button>
    );
}

function CommunityCard({ row, isMine, canDelete }: { row: FeedRow; isMine: boolean; canDelete: boolean }) {
    const mon = row.fakemon_data || {};
    const open = () => api.openMonDetail(row.id);
    const evo = evoBadgeLabel(row);
    return (
        <div className="collection-card community-card" onClick={open}>
            {canDelete && (
                <button className="card-delete-btn community-unpublish-btn" title={isMine ? 'Unpublish' : 'Remove (staff)'}
                    onClick={e => { e.stopPropagation(); api.unpublishMon(row.id); }}>
                    <Icon name="trash-2" style={{ width: 14, height: 14 }} />
                </button>
            )}
            {/* the family badge sits on the artwork's corner, so every card is the same height */}
            <LazyArt row={row}>{evo && <span className="community-card-evo-badge">{evo}</span>}</LazyArt>
            <div className="card-body">
                <div className="card-name" title={mon.name}>{mon.name}</div>
                <TypeBadges type1={mon.type1} type2={mon.type2} />
                <div className="community-card-stats" aria-label="Community activity">
                    <LikeButton row={row} />
                    <button type="button" className="community-stat-btn" title="Comments" onClick={e => { e.stopPropagation(); open(); }}>
                        <Icon name="message-circle" /><span>{row.comment_count || 0}</span>
                    </button>
                    <span className="community-stat-btn community-stat-static" title="Views"><Icon name="eye" /><span>{row.view_count || 0}</span></span>
                </div>
                <AuthorLine row={row} />
            </div>
        </div>
    );
}

interface FeedProps {
    rows: FeedRow[];
    loading: boolean;
    prefs: { search: string; sortBy: string; sortOrder: 'asc' | 'desc' };
    viewerId: string | null;
    viewerIsStaff: boolean;
}

export function CommunityFeed({ rows, loading, prefs, viewerId, viewerIsStaff }: FeedProps) {
    if (loading) return <>{Array.from({ length: 8 }, (_, i) => <SkeletonCard key={i} />)}</>;
    const visible: FeedRow[] = prepareCommunityFeed(rows, prefs);
    if (!visible.length) return <div className="community-empty">{emptyFeedMessage(prefs.search)}</div>;
    return (
        <>
            {visible.map(row => {
                const isMine = !!viewerId && row.user_id === viewerId;
                return <CommunityCard key={row.id} row={row} isMine={isMine} canDelete={isMine || viewerIsStaff} />;
            })}
        </>
    );
}

// ==================== the landing shelves ====================

export function LandingCard({ row }: { row: FeedRow }) {
    const mon = row.fakemon_data || {};
    return (
        <button type="button" className="community-landing-card" onClick={() => api.openMonDetail(row.id)}>
            <LazyArt row={row} className="community-landing-art" />
            <span className="community-landing-body">
                <span className="community-landing-name">{mon.name || 'Unnamed'}</span>
                <span className="community-landing-author">by {row.author_name || 'Unknown'}</span>
                <span className="community-landing-foot">
                    <span className="community-landing-types">
                        {[mon.type1, mon.type2].filter(Boolean).map(t => <span key={t} className={`type-badge type-${String(t).toLowerCase()}`}>{t}</span>)}
                    </span>
                    <span className="community-landing-stats">
                        <span><Icon name="heart" size={12} /> {Number(row.like_count || 0)}</span>
                        <span><Icon name="message-circle" size={12} /> {Number(row.comment_count || 0)}</span>
                    </span>
                </span>
            </span>
        </button>
    );
}

// ==================== a post's comments ====================

export interface MonComment { id: string; user_id: string; body: string; created_at: string; author_name?: string; author_avatar_url?: string; author_badges?: string[]; }

export function CommentList({ comments, loading, monId, viewerId, viewerIsStaff }:
    { comments: MonComment[]; loading: boolean; monId: string; viewerId: string | null; viewerIsStaff: boolean }) {
    if (loading) {
        return (
            <>
                {Array.from({ length: 3 }, (_, i) => (
                    <div className="mon-comment skel-card" key={i}>
                        <div className="mon-comment-header"><span className="skel skel-circle" /><span className="skel skel-text" /></div>
                        <div className="mon-comment-body"><span className="skel skel-text" /><span className="skel skel-text" /></div>
                    </div>
                ))}
            </>
        );
    }
    if (!comments.length) return <div className="community-empty">No comments yet.</div>;
    return (
        <>
            {comments.map(c => {
                const isMine = !!viewerId && c.user_id === viewerId;
                return (
                    <div className="mon-comment" key={c.id}>
                        <div className="mon-comment-header">
                            <Avatar userId={c.user_id} url={c.author_avatar_url} name={c.author_name} />
                            <span className="mon-comment-author community-author-link" data-user-id={c.user_id}
                                onClick={e => { e.stopPropagation(); api.showUserProfile(c.user_id); }}>{c.author_name}</span>
                            <BadgeRow badgeKeys={c.author_badges} size={12} />
                            <span className="mon-comment-time">{new Date(c.created_at).toLocaleString()}</span>
                            {(isMine || viewerIsStaff) && (
                                <button className="mon-comment-delete" type="button" title={isMine ? 'Delete' : 'Remove (staff)'} onClick={() => api.deleteComment(c.id, monId)}>
                                    <Icon name="trash-2" style={{ width: 12, height: 12 }} />
                                </button>
                            )}
                        </div>
                        {/* renderCommentMarkdown escapes the text first, then builds a closed set of tags */}
                        <div className="mon-comment-body" dangerouslySetInnerHTML={{ __html: renderCommentMarkdown(c.body) }} />
                    </div>
                );
            })}
        </>
    );
}
