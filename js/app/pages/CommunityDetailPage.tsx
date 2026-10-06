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
import { TypeBadges } from '../components/profile.tsx';
import { useStore } from '../store.ts';

const STAT_LABELS: Array<[string, string]> = [['hp', 'HP'], ['atk', 'Attack'], ['def', 'Defense'], ['spa', 'Sp. Atk'], ['spd', 'Sp. Def'], ['spe', 'Speed']];

/**
 * Signed out, and its author hasn't made it open: what anyone may read about
 * it (seo_mon), text only, and a way in. Also what a search engine indexes.
 */
function MonTeaser({ t }: { t: any }) {
    const stats = t.stats && typeof t.stats === 'object' ? t.stats : null;
    const bst = stats ? STAT_LABELS.reduce((n, [k]) => n + (Number(stats[k]) || 0), 0) : 0;
    return (
        <div className="share-view-shell mon-teaser">
            <div className="share-view-header">
                <div><div className="share-view-kicker">Community Fakémon</div></div>
            </div>
            <article className="mon-teaser-card">
                <header className="mon-teaser-head">
                    <h1>{t.name}</h1>
                    {t.species && <p className="mon-teaser-species">The {t.species}</p>}
                    <TypeBadges type1={t.types?.[0]} type2={t.types?.[1]} />
                    <p className="mon-teaser-by">By <strong>{t.author}</strong>{t.username ? <span> (@{t.username})</span> : null}
                        {t.family > 1 && <span> · {t.family} evolution stages and forms</span>}</p>
                </header>
                {(t.dex1 || t.dex2) && (
                    <section className="mon-teaser-section">
                        <h2>Pokédex entry</h2>
                        {t.dex1 && <p>{t.dex1}</p>}
                        {t.dex2 && <p>{t.dex2}</p>}
                    </section>
                )}
                {t.abilities?.length > 0 && (
                    <section className="mon-teaser-section">
                        <h2>Abilities</h2>
                        <ul className="mon-teaser-abilities">{t.abilities.map((a: string) => <li key={a}>{a}</li>)}</ul>
                    </section>
                )}
                {stats && (
                    <section className="mon-teaser-section">
                        <h2>Base stats <span className="mon-teaser-bst">BST {bst}</span></h2>
                        <dl className="mon-teaser-stats">
                            {STAT_LABELS.map(([k, label]) => (
                                <div key={k}><dt>{label}</dt><dd><span className="mon-teaser-bar" style={{ width: `${Math.min(100, (Number(stats[k]) || 0) / 2.55)}%` }} />{Number(stats[k]) || 0}</dd></div>
                            ))}
                        </dl>
                    </section>
                )}
                <div className="mon-teaser-cta">
                    <p>Sign in to see {t.name} in full: its artwork, moves, evolutions and comments, and more Fakémon from the community.</p>
                    <button type="button" className="btn btn-primary" onClick={() => api.signInForTeaser()}><Icon name="arrow-right-on-rectangle" size={15} /> Sign in to see it</button>
                </div>
            </article>
        </div>
    );
}

export function CommunityDetailPage() {
    useStore();
    const cs = api.communityState();
    const row = cs.openMonRow;
    const isMine = !!state.user && !!row && row.user_id === state.user.id;
    // open: its author shared it freely (no art shield, anyone may export it)
    const isOpen = !!row?.is_open;
    const canRemove = isMine || !!api.isStaff?.();
    // the thread reports its count once loaded; the stored count stands in until then
    const [loadedCount, setLoadedCount] = useState<{ id: string; n: number } | null>(null);
    const commentCount = loadedCount && loadedCount.id === row?.id ? loadedCount.n : Number(row?.comment_count || 0);
    if (!row && cs.teaser) return <MonTeaser t={cs.teaser} />;

    return (
        <div className="share-view-shell">
            <div className="share-view-header">
                <div>
                    <div className="share-view-kicker">Community Fakémon{isOpen && <span className="community-open-badge" title="Its author shared it freely: no art shield, and anyone can export it"><Icon name="lock-open" size={12} />Open</span>}</div>
                    {row && (
                        <div className="community-detail-stats">
                            <MonReactions row={row} className="community-detail-stat community-reactions" />
                            <span className="community-detail-stat" title="Comments"><Icon name="message-circle" /><span>{commentCount}</span></span>
                        </div>
                    )}
                </div>
                <div className="share-view-actions">
                    {state.user && <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.closeMonDetail()}><Icon name="arrow-left" size={14} /> Back</button>}
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.copyOpenCommunityShareLink()}><Icon name="link" size={14} /> Copy Share Link</button>
                    {isMine && (
                        <>
                            <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openCommunityUpdateModal()} title="Update this Community Hub listing from one of your Fakemon">
                                <Icon name="refresh-cw" size={14} /> Update Listing
                            </button>
                            <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.setOpenCommunityMon(!isOpen)}
                                title={isOpen ? 'Shield its artwork again, and keep it to members' : 'Share it freely: no art shield, anyone can export it, readable signed out'}>
                                <Icon name={isOpen ? 'lock-closed' : 'lock-open'} size={14} /> {isOpen ? 'Close It' : 'Make Open'}
                            </button>
                        </>
                    )}
                    {/* the author's, or anyone's once it's open; never staff by role alone: these hand over the full-res artwork */}
                    {(isMine || isOpen) && (
                        <>
                            {state.user && (
                                <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.addOpenCommunityMonToCollection()} title="Add a copy of this Fakemon to your own collection">
                                    <Icon name="folder-plus" size={14} /> Add to My Collection
                                </button>
                            )}
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
            <div id="community-detail-board" className={isOpen ? 'is-open-mon' : undefined}>
                {row && cs.boardFor === row.id && (
                    <PokedexBoard id="pokedex-board-community" model={api.boardModel()}
                        renderArt={(src, alt) => isOpen
                            // open: an ordinary picture, to save or share (css/protect.css and protect.ts leave .is-open-mon alone)
                            ? <img className="open-art" src={src} alt={alt} decoding="async" />
                            : <ShieldedArt src={src} alt={alt} />}
                        underTitle={<AuthorLine row={row} className="community-card-author board-author" prefix="Published by " />}
                        evolution={<CommunityEvoStrip row={row} activeId={cs.openMonActiveSourceId || String(row.source_fakemon_id || '')} />}
                        onToggleShiny={() => api.togglePreviewArtworkMode()} />
                )}
            </div>

            <div className="section-divider" />
            <h4 className="mon-detail-comments-heading">Comments</h4>
            <div className="mon-detail-comments">
                {row && !state.user && (
                    <p className="community-signed-out-note">
                        <button type="button" className="link-btn" onClick={() => api.requireAccount?.('Sign in to read and write comments.')}>Sign in</button> to read the comments, react, and see more Fakémon from the community.
                    </p>
                )}
                {row && state.user && (
                    <CommentThread key={row.id} kind="mon" parentId={row.id} ownerId={row.user_id} targetName={row.fakemon_data?.name || 'your Fakémon'}
                        placeholder="Say something nice…" onCount={n => { setLoadedCount({ id: row.id, n }); row.comment_count = n; }} />
                )}
            </div>
        </div>
    );
}
