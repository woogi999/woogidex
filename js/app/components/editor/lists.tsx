// The editor's abilities and learnset: the search-as-you-type boxes that add
// to them, the rows with their inline controls, the learnset's filters and
// its breakdown chart. The data and rules are js/editor/editor.ts and
// ./learnset-model.ts; this draws state.abilities and state.learnset.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, state } from '../../../core/app.ts';
import { abilityRole, accuracyText } from '../../../editor/learnset-model.ts';
import { Icon } from '../Icon.tsx';
import { TypeDropdown, useClickAway } from './fields.tsx';

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
const CATEGORY_ICON: Record<string, string> = {
    Physical: 'https://img.pokemondb.net/images/icons/move-physical.png',
    Special: 'https://img.pokemondb.net/images/icons/move-special.png',
    Status: 'https://img.pokemondb.net/images/icons/move-status.png'
};

export function CategoryIcon({ category, size = 16 }: { category: string; size?: number }) {
    return <img src={CATEGORY_ICON[category] || CATEGORY_ICON.Status} alt={category} style={{ width: size, height: size, verticalAlign: 'middle', imageRendering: 'auto' }} />;
}

const catClass = (category?: string) => (category === 'Physical' ? 'cat-physical' : category === 'Special' ? 'cat-special' : 'cat-status');

// ---- search-as-you-type ----

/**
 * A text box with up to eight suggestions under it. Enter adds the closest
 * match (onEnter says whether it did, and the box clears when it has).
 * keepText: the text is the value itself (a set's item or move), so picking
 * one fills it in rather than clearing it.
 */
export function Autocomplete({ id, placeholder, text, setText, suggest, onPick, onEnter, showCategory, keepText, footer }: {
    id: string; placeholder: string; text: string; setText: (t: string) => void;
    suggest: (q: string) => any[]; onPick: (item: any) => void; onEnter: (text: string) => boolean; showCategory?: boolean;
    keepText?: boolean; footer?: (close: () => void) => ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const items = open ? suggest(text) : [];
    const done = () => { if (!keepText) setText(''); setOpen(false); };
    return (
        <>
            <input type="text" id={id} placeholder={placeholder} autoComplete="off" value={text}
                onChange={e => { setText(e.target.value); setOpen(!!e.target.value.trim()); }}
                onKeyDown={e => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    if (!text.trim()) { done(); return; }
                    if (onEnter(text)) done();
                }}
                // a moment's grace, so a click on a suggestion still lands
                onBlur={() => setTimeout(() => setOpen(false), 200)} />
            <div className={`autocomplete-dropdown${open && text.trim() ? ' active' : ''}`}>
                {open && text.trim() && (items.length ? items.map(item => (
                    <div key={item.key || item.name} className="autocomplete-item" onMouseDown={e => { e.preventDefault(); onPick(item); done(); }}>
                        {item.name}
                        {showCategory && item.category && <span className={`cat-badge ${catClass(item.category)}`}><CategoryIcon category={item.category} size={12} /></span>}
                    </div>
                )) : <div className="autocomplete-item">No matches</div>)}
                {open && text.trim() && footer?.(() => setOpen(false))}
            </div>
        </>
    );
}

// ---- abilities ----

/** Search the main-game abilities and add one. */
export function AbilitySearch() {
    const [text, setText] = useState('');
    return (
        <div className="autocomplete-container">
            <Autocomplete id="ability-input" placeholder="Search abilities..." text={text} setText={setText} suggest={api.abilitySuggestions}
                onPick={item => api.addAbility(item.name, 'sd')} onEnter={t => api.addAbilityByName(t)} />
        </div>
    );
}

function RoleLabel({ role }: { role: string | null }) {
    return role ? <span className={`ability-label ${role.toLowerCase()}`}>{role}</span> : null;
}

/** A custom ability open for editing in place; a click outside the row closes it. */
function AbilityEditRow({ ability, index, role, desc, dragProps, dragState }: any) {
    const row = useRef<HTMLDivElement>(null);
    useEffect(() => {
        row.current?.querySelector<HTMLInputElement>('.ability-name-input')?.focus();
        const away = (e: MouseEvent) => { if (!row.current?.contains(e.target as Node)) api.finishCustomAbilityEdit(index); };
        document.addEventListener('mousedown', away);
        return () => document.removeEventListener('mousedown', away);
    }, [index]);
    return (
        <div ref={row} className={`ability-row ability-custom ability-editing ${dragState}`.trim()} data-ability-index={index} {...dragProps}>
            <span className="ability-drag-handle" title="Drag to reorder" aria-label="Drag to reorder">⋮⋮</span>
            <div className="ability-body">
                <div className="ability-name-wrap">
                    {/* uncontrolled: the list redraws on each keystroke and would fight the caret */}
                    <input className="ability-name-input" type="text" defaultValue={ability.name || ''} placeholder="Ability name"
                        onChange={e => api.updateAbility(index, 'name', e.target.value)} />
                    <RoleLabel role={role} />
                </div>
                <input className="ability-desc-input" type="text" defaultValue={desc} placeholder="Short description"
                    onChange={e => api.updateAbility(index, 'desc', e.target.value)} />
            </div>
            <button className="ability-remove" type="button" title="Remove" aria-label="Remove" onClick={e => { stop(e); api.removeAbility(index); }}>
                <Icon name="x" size={14} />
            </button>
        </div>
    );
}

function AbilityRow({ ability, index, role, desc, isCustom, isCoded, dragProps, dragState }: any) {
    // only custom abilities are editable
    const editProps = isCustom ? { onClick: (e: React.MouseEvent) => { stop(e); api.toggleCustomAbilityEdit(index); }, title: 'Click to edit' } : {};
    return (
        <div className={`ability-row${isCustom ? ' ability-custom' : ''} ${dragState}`.trim()} draggable data-ability-index={index} {...dragProps}>
            <span className="ability-drag-handle" title="Drag to reorder" aria-label="Drag to reorder">⋮⋮</span>
            <div className="ability-body">
                <div className="ability-name-wrap">
                    <span className="ability-name-text" {...editProps}>{ability.name || 'Unnamed Ability'}</span>
                    <RoleLabel role={role} />
                    {isCoded && <span className="ability-code-badge" title="Has battle code from the block editor"><Icon name="puzzle" /> Coded</span>}
                </div>
                <div className="ability-desc-text" {...editProps}>{desc || 'No description available.'}</div>
            </div>
            {isCustom && ability.customId && (
                <button className="ability-code-open" type="button" title={isCoded ? 'Edit battle code' : 'Add battle code'}
                    onClick={e => { stop(e); api.openAbilityBlockEditor(ability.customId); }}>
                    <Icon name="puzzle" />
                </button>
            )}
            <button className="ability-remove" type="button" title="Remove" aria-label="Remove" onClick={e => { stop(e); api.removeAbility(index); }}>
                <Icon name="x" size={14} />
            </button>
        </div>
    );
}

/** The Fakemon's up-to-four abilities, dragged to reorder (the order decides Hidden and Event). */
export function AbilityList() {
    const [dragging, setDragging] = useState<number | null>(null);
    const [over, setOver] = useState<number | null>(null);
    const abilities: any[] = state.abilities || [];
    const editing = api.getEditingAbilityIndex();
    return (
        <div id="abilities-list">
            {abilities.map((ability, index) => {
                const { isCustom = false, isCoded = false, desc = '' } = api.describeAbility(ability) || {};
                const role = abilityRole(index, abilities.length);
                const dragProps = {
                    onDragStart: (e: React.DragEvent) => {
                        // avoid stealing the text selection gesture from inputs
                        if ((e.target as Element).closest('input, button')) { e.preventDefault(); return; }
                        setDragging(index);
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', String(index));
                    },
                    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(index); },
                    onDragLeave: () => setOver(o => (o === index ? null : o)),
                    onDrop: (e: React.DragEvent) => {
                        e.preventDefault();
                        const from = dragging !== null ? dragging : Number(e.dataTransfer.getData('text/plain'));
                        setDragging(null);
                        setOver(null);
                        api.moveAbility(from, index);
                    },
                    onDragEnd: () => { setDragging(null); setOver(null); }
                };
                const dragState = [dragging === index ? 'ability-dragging' : '', over === index ? 'ability-drag-over' : ''].filter(Boolean).join(' ');
                const common = { ability, index, role, desc, dragProps, dragState };
                const key = ability.customId || ability.name || index;
                return isCustom && editing === index
                    ? <AbilityEditRow key={key} {...common} />
                    : <AbilityRow key={key} {...common} isCustom={isCustom} isCoded={isCoded} />;
            })}
        </div>
    );
}

// ---- learnset ----

function LearnsetRow({ move, index }: { move: any; index: number }) {
    const custom = api.isCustomMove(move);
    const method = move.learnMethod || 'none';
    return (
        <div className={`learnset-item${custom ? ' custom-move-editor-item' : ''}`}
            onClick={() => (custom ? api.openCustomMoveModal(index) : api.showMoveDetail(move.name))}>
            <div className="learnset-main">
                <span className="move-name">{move.name}</span>
                <div className="move-meta">
                    <span className={`type-pill type-${String(move.type || 'normal').toLowerCase()}`}>{move.type || 'Normal'}</span>
                    <span className={`cat-pill ${catClass(move.category)}`}><CategoryIcon category={move.category || 'Status'} size={14} /></span>
                    <span className="power-text">{move.basePower || '-'} BP / {accuracyText(move.accuracy)}</span>
                </div>
                <div className="move-method-row">
                    <select className="method-select-inline" value={method} aria-label="How it's learned" onClick={stop}
                        onChange={e => { e.stopPropagation(); api.updateMoveMethod(index, e.target.value); }}>
                        <option value="none">-</option>
                        <option value="level">Level</option>
                        <option value="tm">TM</option>
                        <option value="egg">Egg</option>
                    </select>
                    {method === 'level' && (
                        <input type="number" className="level-input-inline" placeholder="Lv" min={1} max={100} aria-label="Level" defaultValue={move.level || ''}
                            onClick={stop} onChange={e => { e.stopPropagation(); api.updateMoveLevel(index, e.target.value); }} />
                    )}
                </div>
            </div>
            <button className="remove-btn" type="button" aria-label="Remove" onClick={e => { stop(e); api.removeLearnsetMove(index); }}><Icon name="x" size={14} /></button>
        </div>
    );
}

const CATEGORIES = ['Physical', 'Special', 'Status'];

/** "All Categories", or one of the three. */
function CategoryDropdown({ value, onPick }: { value: string; onPick: (c: string) => void }) {
    const [open, setOpen] = useState(false);
    const ref = useClickAway(open, () => setOpen(false));
    const pick = (c: string) => { setOpen(false); onPick(c); };
    return (
        <div className={`cat-dropdown${open ? ' open' : ''}`} ref={ref} style={{ width: 150 }}>
            <button className="cat-dropdown-trigger" type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}>
                <span className="cat-dropdown-value">{value ? <span className={`cat-pill ${catClass(value)}`}><CategoryIcon category={value} size={14} /> {value}</span> : 'All Categories'}</span>
                <span className="type-dropdown-arrow"><Icon name="chevron-down" size={12} /></span>
            </button>
            <div className="cat-dropdown-menu">
                <div className="cat-dropdown-option" onClick={() => pick('')}><span>All Categories</span></div>
                {CATEGORIES.map(c => (
                    <div key={c} className="cat-dropdown-option" onClick={() => pick(c)}>
                        <span className={`cat-pill ${catClass(c)}`}><CategoryIcon category={c} size={14} /> {c}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

const selectStyle: React.CSSProperties = { padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, fontFamily: "'Exo 2',sans-serif", fontSize: 13 };

export function LearnsetFilters() {
    const f = api.getLearnsetFilters();
    const set = (patch: object) => api.setLearnsetFilters(patch);
    return (
        <div className="learnset-toolbar" style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <input type="text" placeholder="Search learnset..." aria-label="Search learnset" style={{ flex: 1, minWidth: 140 }} value={f.query} onChange={e => set({ query: e.target.value })} />
            <div style={{ width: 130 }}>
                <TypeDropdown id="learnset-filter-type" value={f.type} placeholder="All Types" onPick={type => set({ type })} />
            </div>
            <CategoryDropdown value={f.category} onPick={category => set({ category })} />
            <select aria-label="Sort learnset" style={{ ...selectStyle, width: 130 }} value={f.sort} onChange={e => set({ sort: e.target.value })}>
                <option value="default">Sort: Default</option>
                <option value="name">Sort: Name</option>
                <option value="type">Sort: Type</option>
                <option value="power">Sort: Power</option>
                <option value="category">Sort: Category</option>
            </select>
            <select aria-label="Sort direction" style={{ ...selectStyle, width: 100 }} value={f.order} onChange={e => set({ order: e.target.value })}>
                <option value="desc">Desc</option>
                <option value="asc">Asc</option>
            </select>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.clearLearnsetFilters()} title="Clear all filters">Clear</button>
        </div>
    );
}

export function LearnsetList() {
    const entries: Array<{ m: any; i: number }> = api.learnsetEntries();
    if (!entries.length) {
        // an empty learnset says nothing; an empty *filtered* one has to explain
        // itself, or it looks like the moves were lost
        return <div id="learnset-list">{state.learnset.length > 0 && <p className="field-hint" style={{ padding: '8px 0' }}>No moves match your filters.</p>}</div>;
    }
    return <div id="learnset-list">{entries.map(({ m, i }) => <LearnsetRow key={`${m.name}-${i}`} move={m} index={i} />)}</div>;
}

/** Search, how it's learned, and Add; plus the full browser. */
export function AddMoveRow() {
    // kept in editor.ts: the move browser adds with the same learn method
    const { method, level } = api.getNewMoveMethod();
    const setMethod = (m: string) => api.setNewMoveMethod({ method: m });
    const setLevel = (l: string) => api.setNewMoveMethod({ level: l });
    const levelInput = useRef<HTMLInputElement>(null);
    const [text, setText] = useState('');
    const add = (typed: string) => api.addMoveByName(typed, method, level);
    return (
        <div className="learnset-add-row" style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <div className="autocomplete-container" style={{ flex: 1 }}>
                <Autocomplete id="move-input" placeholder="Search moves..." showCategory text={text} setText={setText} suggest={api.moveSuggestions}
                    onPick={item => api.addLearnsetMove(item, method, method === 'level' ? level : null)} onEnter={add} />
            </div>
            <select aria-label="How it's learned" style={{ ...selectStyle, width: 90 }} value={method}
                onChange={e => { setMethod(e.target.value); if (e.target.value === 'level') setTimeout(() => levelInput.current?.focus(), 0); else setLevel(''); }}>
                <option value="none">-</option>
                <option value="level">Level</option>
                <option value="tm">TM</option>
                <option value="egg">Egg</option>
            </select>
            {method === 'level' && (
                <input ref={levelInput} type="number" placeholder="Lv" min={1} max={100} aria-label="Level" value={level} onChange={e => setLevel(e.target.value)}
                    style={{ ...selectStyle, width: 64, fontFamily: "'Inconsolata',monospace" }} />
            )}
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => {
                if (add(text)) { setText(''); setMethod('none'); setLevel(''); }
            }}>Add</button>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openMoveBrowserModal()} title="Browse all moves with filters">Browse Moves</button>
        </div>
    );
}

/** A donut of the whole learnset by type, category or learn method. */
export function LearnsetChart() {
    const group = api.getLearnsetChartGroup();
    const total = state.learnset.length;
    const segments: Array<{ label: string; value: number; color: string }> = total ? api.learnsetChartSegments(group) : [];
    const size = 140, radius = 54, stroke = 22, circumference = 2 * Math.PI * radius;
    let offset = 0;
    return (
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border-light)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                <select aria-label="Group the chart" style={{ ...selectStyle, width: 150, padding: '6px 10px' }} value={group} onChange={e => api.setLearnsetChartGroup(e.target.value)}>
                    <option value="type">By Type</option>
                    <option value="category">By Category</option>
                    <option value="method">By Learn Method</option>
                </select>
            </div>
            <div className="learnset-chart-wrap">
                {!total ? <p className="learnset-chart-empty">Add moves to see a breakdown.</p> : (
                    <div className="learnset-chart">
                        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${total} moves`}>
                            {segments.map(seg => {
                                const dash = (seg.value / total) * circumference;
                                const circle = (
                                    <circle key={seg.label} r={radius} cx={size / 2} cy={size / 2} fill="transparent" stroke={seg.color} strokeWidth={stroke}
                                        strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={-offset} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
                                );
                                offset += dash;
                                return circle;
                            })}
                            <text x={size / 2} y={size / 2 - 3} textAnchor="middle" fontSize="24" fontWeight="800" fill="var(--text-primary)" fontFamily="'Exo 2',sans-serif">{total}</text>
                            <text x={size / 2} y={size / 2 + 15} textAnchor="middle" fontSize="10" fill="var(--text-muted)" fontFamily="'Exo 2',sans-serif">move{total === 1 ? '' : 's'}</text>
                        </svg>
                        <div className="learnset-chart-legend">
                            {segments.map(s => (
                                <div key={s.label} className="learnset-chart-row">
                                    <span className="learnset-chart-swatch" style={{ background: s.color }} />
                                    <span className="learnset-chart-label">{s.label}</span>
                                    <span className="learnset-chart-count">{s.value} · {Math.round((s.value / total) * 100)}%</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
