// One published Fakémon (/community/<id>): its stats, owner/staff actions,
// the read-only Pokédex board, and its comments. The post is loaded into the
// editor's state (js/features/community.ts), and the board is drawn from it
// like the editor's own, with its artwork shielded.

import { useState } from 'react';
import { api, state } from '../../core/app.ts';
import { AuthorLine, CommentList, LikeButton } from '../components/community.tsx';
import { PokedexBoard } from '../components/board/PokedexBoard.tsx';
import { CommunityEvoStrip } from '../components/board/CommunityEvoStrip.tsx';
import { ShieldedArt } from '../components/ShieldedArt.tsx';
import { Icon } from '../components/Icon.tsx';
import { useStore } from '../store.ts';

export function CommunityDetailPage() {
    useStore();
    const cs = api.communityState();
    const row = cs.openMonRow;
    const isMine = !!state.user && !!row && row.user_id === state.user.id;
    const canRemove = isMine || !!api.isStaff?.();
    // the loaded thread is freshest; the stored count stands in until it arrives
    const commentCount = cs.commentsLoaded && Array.isArray(cs.comments) ? cs.comments.length : Number(row?.comment_count || 0);

    return (
        <div className="share-view-shell">
            <div className="share-view-header">
                <div>
                    <div className="share-view-kicker">Community Fakémon</div>
                    {row && (
                        <div className="community-detail-stats">
                            <LikeButton row={row} className="community-detail-stat community-like-btn" />
                            <span className="community-detail-stat" title="Comments"><Icon name="message-circle" /><span>{commentCount}</span></span>
                            <span className="community-detail-stat" title="Views"><Icon name="eye" /><span>{Number(row.view_count || 0)}</span></span>
                        </div>
                    )}
                </div>
                <div className="share-view-actions">
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.closeMonDetail()}><Icon name="arrow-left" size={14} /> Back</button>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.copyOpenCommunityShareLink()}><Icon name="link" size={14} /> Copy Share Link</button>
                    {isMine && (
                        <>
                            <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openCommunityUpdateModal()} title="Update this Community Hub listing from one of your Fakemon">
                                <Icon name="refresh-cw" size={14} /> Update Listing
                            </button>
                            {/* owner only, not staff: these hand over the full-res artwork */}
                            <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.addOpenCommunityMonToCollection()} title="Add a copy of this Fakemon to your own collection">
                                <Icon name="folder-plus" size={14} /> Add to My Collection
                            </button>
                            <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.exportOpenCommunityMon()} title="Download this Fakemon as JSON">
                                <Icon name="download" size={14} /> Export JSON
                            </button>
                        </>
                    )}
                    {canRemove && (
                        <button className="btn btn-secondary btn-sm community-unpublish-inline" type="button" onClick={() => api.unpublishOpenCommunityMon()} title={isMine ? 'Unpublish' : 'Remove (staff)'}>
                            Unpublish
                        </button>
                    )}
                </div>
            </div>
            <div id="community-detail-board">
                {row && cs.boardFor === row.id && (
                    <PokedexBoard id="pokedex-board-community" model={api.boardModel()}
                        renderArt={(src, alt) => <ShieldedArt src={src} alt={alt} />}
                        underTitle={<AuthorLine row={row} className="community-card-author board-author" prefix="Published by " />}
                        evolution={<CommunityEvoStrip row={row} activeId={cs.openMonActiveSourceId || String(row.source_fakemon_id || '')} />}
                        onToggleShiny={() => api.togglePreviewArtworkMode()} />
                )}
            </div>

            <div className="section-divider" />
            <h4 className="mon-detail-comments-heading">Comments</h4>
            <div className="mon-detail-comments">
                <CommentList comments={cs.comments || []} loading={!cs.commentsLoaded && !!row} monId={cs.openMonId || ''}
                    viewerId={state.user?.id || null} viewerIsStaff={!!api.isStaff?.()} />
            </div>
            {state.user ? <CommentBox key={cs.openMonId || ''} /> : (
                <p className="mon-detail-signin-hint" style={{ display: 'block' }}>
                    <a href="#" onClick={e => { e.preventDefault(); api.openAuthModal('signin'); }}>Sign in</a> to leave a comment.
                </p>
            )}
        </div>
    );
}

function CommentBox() {
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    async function post() {
        if (!text.trim() || busy) return;
        setBusy(true);
        const posted: boolean = await api.submitMonComment(text);
        setBusy(false);
        if (posted) setText('');
    }
    return (
        <div className="mon-detail-comment-box" style={{ display: 'flex' }}>
            <textarea placeholder="Say something nice…" maxLength={1000} value={text} onChange={e => setText(e.target.value)} />
            <button className="btn btn-primary" type="button" disabled={busy} onClick={post}>Post</button>
        </div>
    );
}
