// One published Fakémon (/community/<id>): its stats, owner/staff actions,
// the read-only Pokédex board, and its comments. The post is loaded into the
// editor's state (js/features/community.ts), and the board is drawn from it
// like the editor's own, with its artwork shielded.

import { useState } from 'react';
import { api, state } from '../../core/app.ts';
import { AuthorLine, MonReactions } from '../components/community.tsx';
import { CommentThread } from '../components/comments.tsx';
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
    // the thread reports its count once loaded; the stored count stands in until then
    const [loadedCount, setLoadedCount] = useState<{ id: string; n: number } | null>(null);
    const commentCount = loadedCount && loadedCount.id === row?.id ? loadedCount.n : Number(row?.comment_count || 0);

    return (
        <div className="share-view-shell">
            <div className="share-view-header">
                <div>
                    <div className="share-view-kicker">Community Fakémon</div>
                    {row && (
                        <div className="community-detail-stats">
                            <MonReactions row={row} className="community-detail-stat community-reactions" />
                            <span className="community-detail-stat" title="Comments"><Icon name="message-circle" /><span>{commentCount}</span></span>
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
                {row && (
                    <CommentThread key={row.id} kind="mon" parentId={row.id} ownerId={row.user_id} targetName={row.fakemon_data?.name || 'your Fakémon'}
                        placeholder="Say something nice…" onCount={n => { setLoadedCount({ id: row.id, n }); row.comment_count = n; }} />
                )}
            </div>
        </div>
    );
}
