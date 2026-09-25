// The editor's Stats, Abilities & Evos tab: level, stat template, base stats
// (each bar is also a slider), BST, bulk comparison, abilities, and the
// evolution board.

import { useRef, useState } from 'react';
import { api } from '../../../core/app.ts';
import { STAT_KEYS, clampBaseStat, form, formBst, setForm, setStat, type StatKey } from '../../../editor/draft.ts';
import { Icon } from '../Icon.tsx';
import { CommitInput } from '../CommitInput.tsx';
import { AbilityList, AbilitySearch } from './lists.tsx';
import { EvolutionBoard, EvolutionStatus } from './EvolutionBoard.tsx';
import '../../dialogs/evolution.tsx';

const STAT_LABEL: Record<StatKey, string> = { hp: 'HP', atk: 'ATK', def: 'DEF', spa: 'SPA', spd: 'SPD', spe: 'SPE' };

/** One base stat: its bar doubles as a slider (drag, click, or arrow keys) next to a number field. */
function StatRow({ stat }: { stat: StatKey }) {
    const value = clampBaseStat(form.stats[stat]);
    const bar = useRef<HTMLDivElement>(null);
    const [dragging, setDragging] = useState(false);
    const pct = `${Math.min((value / 255) * 100, 100)}%`;
    const fromPointer = (clientX: number) => {
        const rect = bar.current!.getBoundingClientRect();
        const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
        setStat(stat, Math.round(Math.max(0, Math.min(1, ratio)) * 255));
    };
    const down = (event: React.PointerEvent) => {
        event.preventDefault();
        setDragging(true);
        fromPointer(event.clientX);
        const move = (e: PointerEvent) => fromPointer(e.clientX);
        const up = () => {
            setDragging(false);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };
    const key = (event: React.KeyboardEvent) => {
        const step = event.shiftKey ? 10 : 1;
        const next = ({
            ArrowRight: value + step, ArrowUp: value + step, ArrowLeft: value - step, ArrowDown: value - step,
            PageUp: value + 10, PageDown: value - 10, Home: 1, End: 255
        } as Record<string, number>)[event.key];
        if (next === undefined) return;
        event.preventDefault();
        setStat(stat, next);
    };
    return (
        <div className="editor-stat-row" data-stat={stat}>
            <span className="editor-stat-label">{STAT_LABEL[stat]}</span>
            <div className="editor-stat-bar-wrap">
                <div ref={bar} className={`editor-stat-bar-bg${dragging ? ' dragging' : ''}`} style={{ '--stat-pct': pct } as React.CSSProperties}
                    role="slider" tabIndex={0} aria-valuemin={1} aria-valuemax={255} aria-valuenow={value} aria-label={`${STAT_LABEL[stat]} base stat`}
                    onPointerDown={down} onKeyDown={key}>
                    <div className={`editor-stat-bar-fill ${stat}`} style={{ width: pct }} />
                </div>
                <input type="number" id={`stat-${stat}`} className="editor-stat-input" min={1} max={255} step={1} inputMode="numeric"
                    aria-label={`${STAT_LABEL[stat]} base stat`} value={value} onChange={e => setStat(stat, e.target.value)} />
            </div>
            <span className="editor-stat-calc">{api.statAtLevel(stat)}</span>
        </div>
    );
}

function StatTemplate() {
    const [templateId, setTemplateId] = useState('');
    const [target, setTarget] = useState('');
    const template = (api.STAT_TEMPLATES as Array<{ id: string; label: string; stats: Record<string, number> }>).find(t => t.id === templateId);
    const templateBst = template ? Object.values(template.stats).reduce((a, b) => a + b, 0) : null;
    return (
        <div className="form-group stat-toolbar-template">
            <label htmlFor="stat-template-select">Stat Template</label>
            <div className="stat-template-row">
                <select id="stat-template-select" className="stat-template-select" value={templateId} onChange={e => setTemplateId(e.target.value)}>
                    <option value="">Choose a template…</option>
                    {(api.STAT_TEMPLATES as Array<{ id: string; label: string }>).map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
                <input type="number" className="stat-template-bst-input" min={6} max={1530} step={1} value={target}
                    placeholder={templateBst ? `BST ${templateBst}` : 'BST'} aria-label="Target base stat total"
                    title="Target Base Stat Total for the template (leave blank to use its default BST)"
                    onChange={e => setTarget(e.target.value)} />
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => {
                    if (api.applyStatTemplate(templateId, target) && target.trim()) setTarget(String(api.clampTemplateBstValue(target)));
                }}>Apply Template</button>
            </div>
        </div>
    );
}

/** The Fakemon's max physical and special bulk, next to the Pokémon closest to each. */
function BulkComparison() {
    const data = api.bulkComparison();
    if (!data) {
        return <div className="bulk-comparison"><div className="bulk-comparison-title">Bulk Comparison</div><p className="bulk-loading">Loading Pokemon data...</p></div>;
    }
    const card = (kind: 'physical' | 'special', match: any, stat: number, bulk: number) => {
        const sprite = match ? (match.isOwnFakemon && match.artwork ? match.artwork : api.getSpriteUrl(match.id, match)) : '';
        return (
            <div className={`bulk-card${match?.isOwnFakemon ? ' bulk-card-own' : ''}`}>
                <div className="bulk-label">{kind === 'physical' ? 'Physical Bulk (HP × Def)' : 'Special Bulk (HP × SpD)'}</div>
                <div className="bulk-stats"><span>HP <strong>{data.hpStat.toLocaleString()}</strong></span><span>{kind === 'physical' ? 'Def' : 'SpD'} <strong>{stat.toLocaleString()}</strong></span></div>
                <div className="bulk-value">{bulk.toLocaleString()}</div>
                <div className="bulk-match">
                    {/* keyed by the match, so a fallback swapped into one image never sticks to the next */}
                    <img key={sprite} className="bulk-match-sprite" src={sprite} alt={match?.name || ''} loading="lazy" decoding="async"
                        onError={e => (window as any).fallbackPokemonImage?.(e.currentTarget, String(match?.name || ''), String(match?.baseSpecies || ''))} />
                    <span className="bulk-match-name">Closest: {match ? `${match.name} - ${data.bulkOf(match, kind).toLocaleString()} bulk` : 'N/A'}</span>
                </div>
            </div>
        );
    };
    return (
        <div className="bulk-comparison" id="bulk-comparison">
            <div className="bulk-comparison-title">Bulk Comparison</div>
            <div className="bulk-row">
                {card('physical', data.phys, data.defStat, data.physBulk)}
                {card('special', data.spec, data.spdStat, data.specBulk)}
            </div>
        </div>
    );
}

export function StatsTab() {
    return (
        <>
            <div className="stat-toolbar-row">
                <div className="form-group stat-toolbar-level">
                    <label htmlFor="editor-level">Level</label>
                    <CommitInput type="number" id="editor-level" min={1} max={100} value={form.level} style={{ width: 80 }}
                        onCommit={v => { setForm({ level: Math.max(1, Math.min(100, parseInt(v) || 100)) }); api.updateEditorStats(); }} />
                </div>
                <StatTemplate />
            </div>
            <div id="editor-stat-bars">{STAT_KEYS.map(k => <StatRow key={k} stat={k} />)}</div>
            <div className="bst-display">
                <div className="label">Base Stat Total</div>
                <div className="value">{formBst()}</div>
            </div>
            <BulkComparison />
            <div className="section-divider" />
            <div className="form-group">
                <label htmlFor="ability-input">Abilities <span className="label-note">(up to 4)</span></label>
                <AbilitySearch />
                <p className="field-hint">Drag the abilities to reorder. If you have more than 1 ability, the last one will be the Hidden Ability. If you have 4, the 3rd one is the Hidden Ability, the last one is Event Ability.</p>
                <AbilityList />
                <div className="ability-actions">
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openAbilityBrowserModal()}><Icon name="list-filter" size={14} /> Browse Abilities</button>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openCustomAbilityChooser()}><Icon name="plus" />Add Custom Ability</button>
                </div>
            </div>

            <div className="section-divider" />
            <div className="evolution-section">
                <div className="evolution-section-header">
                    <div>
                        <div className="section-title">Evolutions and formes</div>
                        <EvolutionStatus />
                    </div>
                    <div className="evolution-toolbar">
                        <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openEvolutionNodeChooser('fakemon')}><Icon name="plus" />Add Fakemon</button>
                        <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openEvolutionNodeChooser('vanilla')}><Icon name="plus" />Add Vanilla Pokémon</button>
                        <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openEvolutionMethodEditor()}><Icon name="plus" />Add Evo Method</button>
                    </div>
                </div>
                <EvolutionBoard />
                <div className="evolution-help">Drag Pokémon to arrange them. Drag from a <strong>right handle</strong> to a <strong>left handle</strong> to connect them. Hover a connection and click the scissors to sever it. Stages are calculated automatically.</div>
            </div>
        </>
    );
}
