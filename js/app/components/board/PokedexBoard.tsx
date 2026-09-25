// The Pokédex board: one Fakémon laid out like a page of the Pokédex. The
// editor's Preview tab, the quick preview, the Community Hub page and the
// PNG export all draw it; it lays itself out by its own width (container
// queries in css/pokedex-board.css), never the window's, so all of them agree.
//
// The board is given a model (boardModel() in js/editor/editor-core.ts) and
// the parts that differ between its homes: how artwork is drawn (the
// Community Hub shields it), the evolution chain, the forme tabs, and a line
// under the title (who published it).

import type { ReactNode } from 'react';
import { api } from '../../../core/app.ts';
import { Icon } from '../Icon.tsx';

export interface BoardModel {
    name: string; species: string; type1: string; type2: string; number: string;
    stats: Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>; bst: number;
    facts: Array<[string, string]>;
    gender: { genderless: boolean; male: number; female: number; label: string };
    abilities: Array<{ name: string; role: string; isCustom: boolean; desc: string; art: string }>;
    dexEntries: string[];
    moves: Record<'physical' | 'special' | 'status', Array<{ name: string; category: string; faded: boolean; art: string }>>;
    customMoves: Array<{ index: number; name: string; type: string; desc: string; stats: string; flags: string[] }>;
    sets: Array<{ name: string; text: string }>;
    artwork: string; shinyArtwork: string; cry: string; artCredit: string;
    artMode: 'normal' | 'shiny';
}

const STAT_ROWS: Array<[keyof BoardModel['stats'], string]> = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];
const CATEGORY_TITLE: Record<string, string> = { physical: 'Physical', special: 'Special', status: 'Status' };

/** The credit text, with a URL in it made a link. */
function ArtCredit({ credit }: { credit: string }) {
    const m = credit.match(/(https?:\/\/[^\s]+)/i);
    if (!m) return <div className="board-artwork-credit">{credit}</div>;
    const url = m[1];
    const label = credit.replace(url, '').trim() || 'link';
    return (
        <div className="board-artwork-credit">
            {credit.slice(0, m.index)}<a href={url} target="_blank" rel="noopener noreferrer">{label}</a>
        </div>
    );
}

function TypeBadge({ type }: { type: string }) {
    return type ? <span className={`type-badge type-${type.toLowerCase()}`}>{type}</span> : null;
}

export function PokedexBoard({ model: m, id, renderArt, underTitle, formeTabs, evolution, onToggleShiny, onMove, onCustomMove }: {
    model: BoardModel;
    id?: string;
    /** how the artwork itself is drawn; a plain <img> by default */
    renderArt?: (src: string, alt: string) => ReactNode;
    underTitle?: ReactNode;
    formeTabs?: ReactNode;
    evolution?: ReactNode;
    onToggleShiny: () => void;
    onMove?: (name: string) => void;
    onCustomMove?: (index: number, name: string) => void;
}) {
    const shiny = m.artMode === 'shiny';
    const art = shiny ? m.shinyArtwork : m.artwork;
    const alt = `${m.name}${shiny ? ' shiny' : ''} artwork`;
    const hasMoves = m.moves.physical.length + m.moves.special.length + m.moves.status.length + m.customMoves.length > 0;
    const moveClick = onMove || ((name: string) => api.showMoveDetail(name));
    return (
        <article className="pokedex-board" id={id}>
            {formeTabs}
            <header className="board-head">
                <div className="board-title">
                    <h2 className="board-name">{m.name}</h2>
                    {m.species && <p className="board-species">{m.species}</p>}
                    {underTitle}
                    <div className="board-types"><TypeBadge type={m.type1} /><TypeBadge type={m.type2} /></div>
                </div>
                <div className="board-number">{m.number || '#???'}</div>
            </header>

            <div className="board-main">
                <div className="board-artwork-left">
                    {(m.shinyArtwork || m.cry) && (
                        <div className="board-artwork-mode" aria-label="Preview controls">
                            {m.shinyArtwork && (
                                <button type="button" className={`collection-shiny-toggle board-artwork-shiny-toggle${shiny ? ' active' : ''}`} aria-pressed={shiny}
                                    title={shiny ? 'Show normal artwork' : 'Show shiny artwork'} aria-label={shiny ? 'Show normal artwork' : 'Show shiny artwork'}
                                    onClick={e => { e.preventDefault(); e.stopPropagation(); onToggleShiny(); }}>
                                    <Icon name="sparkles" />
                                </button>
                            )}
                            {m.cry && (
                                <button type="button" className="collection-shiny-toggle board-artwork-shiny-toggle board-artwork-cry-toggle" title="Play Pokemon cry" aria-label="Play Pokemon cry"
                                    onClick={e => api.playPokemonCry(e)}>
                                    <Icon name="volume-2" />
                                </button>
                            )}
                        </div>
                    )}
                    <div className="board-artwork-image">
                        {art
                            ? (renderArt ? renderArt(art, alt) : <img src={art} alt={alt} />)
                            : shiny ? <span className="placeholder">Shiny</span> : <img className="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork" />}
                    </div>
                    {m.artCredit && <ArtCredit credit={m.artCredit} />}
                </div>
                <section className="board-block board-facts">
                    <h3 className="board-section-title">Profile</h3>
                    {m.facts.length > 0 && (
                        <dl className="board-facts-grid">
                            {m.facts.map(([k, v]) => <div className="board-data-row" key={k}><dt className="label">{k}</dt><dd className="value">{v}</dd></div>)}
                        </dl>
                    )}
                    <div className="board-gender-compact">
                        <span className="label">Gender</span>
                        <div className="gender-bar">
                            {m.gender.genderless
                                ? <div className="genderless" style={{ width: '100%' }} />
                                : <>{m.gender.male > 0 && <div className="male" style={{ width: `${m.gender.male}%` }} />}{m.gender.female > 0 && <div className="female" style={{ width: `${m.gender.female}%` }} />}</>}
                        </div>
                        <span className="gender-label">{m.gender.label}</span>
                    </div>
                </section>
                {m.abilities.length > 0 && (
                    <section className="board-block board-abilities">
                        <h3 className="board-section-title">Abilities</h3>
                        <div className="board-ability-list">
                            {m.abilities.map(a => (
                                <div key={a.name} className={`board-ability-item${a.isCustom ? ' board-ability-custom' : ''}`}>
                                    <div className="board-ability-name-row">
                                        {a.art && <img className="board-entity-art" src={a.art} alt="" />}
                                        <span className="ability-name">{a.name}</span>
                                        {a.role && <span className={`board-ability-role ${a.role.toLowerCase()}`}>{a.role}</span>}
                                    </div>
                                    {a.desc && <span className="ability-desc">{a.desc}</span>}
                                </div>
                            ))}
                        </div>
                    </section>
                )}
                {m.dexEntries.length > 0 && (
                    <section className="board-block board-dex">
                        <h3 className="board-section-title">Pokédex Entries</h3>
                        <div className="dex-entries">{m.dexEntries.map((d, i) => <p className="dex-entry" key={i}>{d}</p>)}</div>
                    </section>
                )}
            </div>

            <div className="board-lower-row">
                <section className="board-section board-stats-narrow">
                    <h3 className="board-section-title">Base Stats</h3>
                    {STAT_ROWS.map(([k, label]) => (
                        <div className="stat-bar-container" key={k}>
                            <span className="stat-label">{label}</span>
                            <span className="stat-value">{m.stats[k]}</span>
                            <div className="stat-bar-bg"><div className={`stat-bar-fill ${k}`} style={{ width: `${Math.min((m.stats[k] / 255) * 100, 100)}%` }} /></div>
                        </div>
                    ))}
                    <div className="board-bst-display"><span className="label">Total</span><span className="value">{m.bst}</span></div>
                </section>
                <div className="board-learnset-slot">
                    {hasMoves && (
                        // category labels are text only: the icons are pokemondb.net images,
                        // which the PNG export can't read cross-origin, so they came out blank
                        <section className="board-section board-learnset-col">
                            <h3 className="board-section-title">Learnset</h3>
                            {(['physical', 'special', 'status'] as const).filter(c => m.moves[c].length).map(c => (
                                <div className={`move-category ${c}`} key={c}>
                                    <div className="move-category-title">{CATEGORY_TITLE[c]}</div>
                                    <div className="move-list">
                                        {m.moves[c].map(t => (
                                            <span key={t.name} className={`move-tag ${c}${t.faded ? ' low-value' : ''}${t.art ? ' has-art' : ''}`} onClick={() => moveClick(t.name)}>
                                                {t.art && <img className="move-tag-art" src={t.art} alt="" />}{t.name}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            ))}
                            {m.customMoves.map(cm => (
                                <div key={cm.index} className="board-custom-move-item board-custom-move-inline" onClick={() => (onCustomMove ? onCustomMove(cm.index, cm.name) : api.handlePreviewCustomMove(cm.index))}>
                                    <span className={`cm-type type-${cm.type.toLowerCase()}`}>{cm.type}</span>
                                    <div className="cm-body">
                                        <div className="cm-name">{cm.name}</div>
                                        <div className="cm-stats">{cm.stats}</div>
                                        {cm.desc && <div className="cm-desc">{cm.desc}</div>}
                                        {cm.flags.length > 0 && <div className="cm-flags">{cm.flags.map(f => <span className="flag-tidbit" key={f}>{f}</span>)}</div>}
                                    </div>
                                </div>
                            ))}
                        </section>
                    )}
                    {evolution}
                </div>
                {m.sets.length > 0 && (
                    <div className="board-sets-slot">
                        <section className="board-section board-sets-col">
                            <h3 className="board-section-title">Sample Sets</h3>
                            {m.sets.map((set, i) => (
                                <div className="board-set" key={i}>
                                    <div className="board-set-name">{set.name}</div>
                                    <div className="sample-set-output">
                                        <button type="button" className="sample-set-copy" title="Copy to clipboard" aria-label="Copy to clipboard" onClick={() => api.copySampleSetText(set.text)}>
                                            <Icon name="copy" size={14} />
                                        </button>
                                        <span className="sample-set-output-text">{set.text}</span>
                                    </div>
                                </div>
                            ))}
                        </section>
                    </div>
                )}
            </div>
        </article>
    );
}
