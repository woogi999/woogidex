// The editor's Moves & Sets tab: the learnset (filters, rows, adding moves,
// the breakdown chart), the moves inherited from prevolutions, and the
// sample sets.

import { useState } from 'react';
import { api, state } from '../../../core/app.ts';
import { AddMoveRow, LearnsetChart, LearnsetFilters, LearnsetList } from './lists.tsx';
import { SampleSets } from './SampleSets.tsx';
import { Icon } from '../Icon.tsx';
import '../../dialogs/sampleSets.tsx';

const COMPACT_KEY = 'woogidex.learnset.compact';

export function MovesTab() {
    const [compact, setCompact] = useState(() => { try { return localStorage.getItem(COMPACT_KEY) === '1'; } catch { return false; } });
    const toggleCompact = () => {
        setCompact(!compact);
        try { localStorage.setItem(COMPACT_KEY, compact ? '0' : '1'); } catch { /* just this visit then */ }
    };
    return (
        <>
            <div className={`form-group${compact ? ' learnset-compact' : ''}`}>
                <div className="learnset-head">
                    <label>Learnset</label>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={toggleCompact} aria-pressed={compact} title={compact ? 'Show roomy cards' : 'Show a compact list'}>
                        <Icon name={compact ? 'squares-2x2' : 'list-bullet'} size={14} /> {compact ? 'Cards' : 'Compact list'}
                    </button>
                </div>
                <p className="field-hint">Add your moves here!</p>
                <LearnsetFilters />
                <LearnsetList />
                <AddMoveRow />
                <div className="learnset-actions" style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openCustomMoveChooser()}>+ Add Custom Move</button>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.addUniversalMoves()}>+ Add Universal Moves</button>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openMoveImportExportModal()}>Import / Export Moves</button>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openRecommendMovesModal()}>Recommend Moves</button>
                    <button className="btn btn-danger btn-sm" type="button" onClick={() => api.clearMoveset()} style={{ marginLeft: 'auto' }}>Clear Moveset</button>
                </div>
                <InheritedMoves />
                <LearnsetChart />
            </div>
            <div className="section-divider" />
            <div className="form-group">
                <label>Sample Sets</label>
                <p className="field-hint">Build competitive sets in Showdown export format</p>
                <SampleSets />
                <button className="sample-set-add" type="button" onClick={() => api.addSampleSet()}>+ Add Sample Set</button>
            </div>
        </>
    );
}

/**
 * The "inherit moves from prevolutions" switch, and what it brings in. Only
 * offered when this Fakemon evolves from one of your Fakemon (or is a Mega or
 * forme of one); the moves are read-only here because they belong to the
 * prevolution -- edit them there.
 */
function InheritedMoves() {
    const [open, setOpen] = useState(true);
    if (!api.editorHasPrevolution?.() && !state.inheritPrevoMoves) return null;
    const on = !!state.inheritPrevoMoves;
    const moves: any[] = on ? api.inheritedMovesForEditor() : [];
    const groups = new Map<string, any[]>();
    for (const m of moves) {
        if (!groups.has(m.inheritedFrom)) groups.set(m.inheritedFrom, []);
        groups.get(m.inheritedFrom)!.push(m);
    }
    return (
        <div className="inherited-moves">
            <label className="inherited-moves-toggle">
                <input type="checkbox" role="switch" checked={on} onChange={e => api.setInheritPrevoMoves(e.target.checked)} />
                <span className="inherited-moves-switch" aria-hidden="true" />
                <span>
                    <strong>Inherit moves from prevolutions</strong>
                    <small>Knows every move the Fakemon it evolves from knows, too. Updates by itself when you change theirs.</small>
                </span>
            </label>
            {on && (
                moves.length === 0 ? (
                    <p className="field-hint inherited-moves-empty">Nothing new to inherit: its prevolutions don't know any moves it doesn't already have.</p>
                ) : (
                    <>
                        <button type="button" className="inherited-moves-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
                            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
                            {moves.length} inherited move{moves.length === 1 ? '' : 's'}
                        </button>
                        {open && [...groups.entries()].map(([from, list]) => (
                            <div className="inherited-moves-group" key={from}>
                                <div className="inherited-moves-from">From {from}</div>
                                <div className="inherited-moves-list">
                                    {list.map(m => (
                                        <span key={m.name} className="inherited-move" title={`${m.category || 'Status'} · ${m.basePower || '-'} BP`}
                                            onClick={() => api.showMoveDetail?.(m.name)}>
                                            <span className={`type-pill type-${String(m.type || 'normal').toLowerCase()}`}>{m.type || 'Normal'}</span>
                                            {m.name}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </>
                )
            )}
        </div>
    );
}
