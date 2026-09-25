// The Moves tab's sample sets: one card per competitive set, with its item,
// ability, nature, level, Tera type, EVs and IVs per stat, four moves, and the
// Showdown export text. The rules are js/editor/sample-sets.ts.

import { useState } from 'react';
import { api, state } from '../../../core/app.ts';
import { NATURES, getNatureOptionLabel } from '../../../core/data.ts';
import { form } from '../../../editor/draft.ts';
import { Icon } from '../Icon.tsx';
import { CommitInput } from '../CommitInput.tsx';
import { TypeDropdown } from './fields.tsx';
import { Autocomplete } from './lists.tsx';

const STAT_LABEL: Record<string, string> = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

function ItemField({ set, index }: { set: any; index: number }) {
    const icon = api.sampleItemIcon(set);
    const [broken, setBroken] = useState('');
    return (
        <div className="sample-set-item-wrap">
            {icon && broken !== icon && <img className="sample-set-item-icon" src={icon} alt="" onError={() => setBroken(icon)} />}
            <div className="autocomplete-container" style={{ flex: 1 }}>
                <Autocomplete id={`set-${index}-item`} placeholder="e.g., Leftovers" text={set.item || ''}
                    setText={t => api.updateSampleSetItem(index, t)} suggest={api.sampleItemSuggestions}
                    onPick={item => api.pickSampleSetItem(index, item)} onEnter={() => true} keepText
                    footer={close => (
                        <div className="autocomplete-item sample-set-add-custom-item" onMouseDown={e => { e.preventDefault(); close(); api.openCustomItemModal('', { setIndex: index }); }}>
                            <span><Icon name="plus" size={14} /> Add Custom Item</span>
                        </div>
                    )} />
            </div>
        </div>
    );
}

function StatRow({ row, index }: { row: any; index: number }) {
    const barFill = Math.min((row.total / 500) * 100, 100);
    const barColor = row.boosted ? '#cc4444' : row.reduced ? '#4466cc' : '#888';
    const label = STAT_LABEL[row.key];
    return (
        <div className={`sample-set-stat-row${row.boosted ? ' stat-boosted' : row.reduced ? ' stat-reduced' : ''}`}>
            <div className="sample-set-stat-col stat-name-col">
                <div className="sample-set-stat-label">{label}</div>
                <div className="sample-set-nature-btns">
                    <button type="button" className={`nature-btn nature-plus${row.boosted ? ' active' : ''}`} title={`Boost ${label}`} onClick={() => api.setNatureBoost(index, row.key, 'up')}>+</button>
                    <button type="button" className={`nature-btn nature-minus${row.reduced ? ' active' : ''}`} title={`Reduce ${label}`} onClick={() => api.setNatureBoost(index, row.key, 'down')}>−</button>
                </div>
            </div>
            <div className="sample-set-stat-base">{row.base}</div>
            <CommitInput type="number" className="sample-set-ev-input-compact" min={0} max={252} step={4} value={row.ev} aria-label={`${label} EVs`}
                onCommit={v => api.updateSampleSetEV(index, row.key, v)} />
            <div className="sample-set-stat-col slider-col">
                <div className="sample-set-stat-bar-above">
                    <div className="sample-set-stat-bar-fill" style={{ width: `${barFill}%`, background: barColor }} />
                </div>
                <div className="sample-set-ev-track">
                    <div className="sample-set-ev-fill" style={{ width: `${(row.ev / 252) * 100}%` }} />
                    <input type="range" className="sample-set-ev-slider" min={0} max={252} step={4} value={row.ev} aria-label={`${label} EVs`}
                        onChange={e => api.updateSampleSetEV(index, row.key, e.target.value)} />
                </div>
            </div>
            <div className="sample-set-stat-iv-wrap">
                <CommitInput type="number" className="sample-set-iv-input" min={0} max={31} value={row.iv} aria-label={`${label} IVs`}
                    onCommit={v => api.updateSampleSet(index, `ivs.${row.key}`, v)} />
            </div>
            <div className="sample-set-stat-calc">{row.total}</div>
        </div>
    );
}

function SampleSetCard({ set, index }: { set: any; index: number }) {
    const name = form.name || 'Fakemon';
    const exportText = api.generateShowdownExport(name, set);
    const rows = api.sampleSetStatRows(set);
    const totalEVs = rows.reduce((sum: number, r: any) => sum + r.ev, 0);
    const remaining = 508 - totalEVs;
    const abilities: string[] = api.getAllAbilities();
    return (
        <div className="sample-set-card" data-set-index={index}>
            <button type="button" className="sample-set-delete" onClick={() => api.removeSampleSet(index)} title="Delete" aria-label="Delete set"><Icon name="trash-2" size={16} /></button>
            <div className="sample-set-header">
                <input type="text" className="sample-set-name" value={set.name || ''} placeholder="Set name" aria-label="Set name" onChange={e => api.updateSampleSet(index, 'name', e.target.value)} />
            </div>
            <div className="sample-set-row">
                <div className="sample-set-field">
                    <label>Item</label>
                    <ItemField set={set} index={index} />
                </div>
                <div className="sample-set-field">
                    <label>Ability</label>
                    <select value={set.ability || ''} onChange={e => api.updateSampleSet(index, 'ability', e.target.value)}>
                        <option value="">None</option>
                        {/* a set may name an ability the Fakemon no longer has */}
                        {[...new Set([...abilities, ...(set.ability ? [set.ability] : [])])].map(a => <option key={a} value={a}>{a}</option>)}
                    </select>
                </div>
                <div className="sample-set-field">
                    <label>Nature</label>
                    <select value={set.nature || 'Hardy'} onChange={e => api.updateSampleSet(index, 'nature', e.target.value)}>
                        {(NATURES as string[]).map(n => <option key={n} value={n}>{getNatureOptionLabel(n)}</option>)}
                    </select>
                </div>
            </div>
            <div className="sample-set-row">
                <div className="sample-set-field">
                    <label>Level</label>
                    <CommitInput type="number" min={1} max={100} placeholder="100" value={set.level || 100} onCommit={v => api.updateSampleSet(index, 'level', v)} />
                </div>
                <div className="sample-set-field wide">
                    <label>Tera Type</label>
                    <TypeDropdown id={`tera-type-${index}`} value={set.teraType || ''} placeholder="None" onPick={t => api.updateSampleSet(index, 'teraType', t)} />
                </div>
            </div>
            <div className="sample-set-ev-total-row">
                <div className="sample-set-ev-total-text">{totalEVs} / 508 EVs {remaining >= 0 ? `(${remaining} remaining)` : `(${Math.abs(remaining)} over!)`}</div>
                <button type="button" className="sample-set-guess-btn btn btn-secondary btn-sm" onClick={() => api.guessEVSpread(index)}
                    title="Guess a competitive EV spread from this Fakemon's base stats and moves">{api.formatEVSpread(set.evs, set.nature, set)}</button>
            </div>
            <div className="sample-set-stats-section">
                <div className="sample-set-stats-header"><span>Stat</span><span>Base</span><span>EV</span><span>Slider</span><span>IV</span><span>Total</span></div>
                {rows.map((row: any) => <StatRow key={row.key} row={row} index={index} />)}
            </div>
            <div className="sample-set-moves-block">
                <div className="sample-set-moves-label">Moves</div>
                <div className="sample-set-moves">
                    {[0, 1, 2, 3].map(slot => (
                        <div className="autocomplete-container" key={slot}>
                            <Autocomplete id={`set-${index}-move-${slot}`} placeholder={`Move ${slot + 1}`} showCategory text={set.moves?.[slot] || ''}
                                setText={t => api.updateSampleSet(index, `moves.${slot}`, t)} suggest={api.sampleMoveSuggestions}
                                onPick={m => api.updateSampleSet(index, `moves.${slot}`, m.name)} onEnter={() => true} keepText />
                        </div>
                    ))}
                </div>
            </div>
            <div className="sample-set-output">
                <button type="button" className="sample-set-copy" onClick={() => api.copySampleSet(index)} title="Copy to clipboard" aria-label="Copy to clipboard"><Icon name="copy" size={14} /></button>
                <span className="sample-set-output-text">{exportText}</span>
            </div>
        </div>
    );
}

export function SampleSets() {
    return (
        <div id="sample-sets-list">
            {(state.sampleSets || []).map((set: any, i: number) => <SampleSetCard key={i} set={set} index={i} />)}
        </div>
    );
}
