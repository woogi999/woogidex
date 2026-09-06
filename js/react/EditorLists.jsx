// A Fakemon's abilities and its learnset: lists of rows with inline controls,
// rebuilt on every keystroke. Ability list drag-to-reorder handlers are part
// of the row now, rather than re-attached to the whole container on each render.

import { useState } from 'react';
import { Icon } from './Icon.jsx';
import { abilityRole, accuracyText } from '../editor/learnset-model.js';

const call = (name, ...args) => window[name]?.(...args);
const stop = e => e.stopPropagation();

// ==================== abilities ====================

function AbilityRoleLabel({ role }) {
    if (!role) return null;
    return <span className={`ability-label ${role.toLowerCase()}`}>{role}</span>;
}

/**
 * An ability being edited in place. Uncontrolled: a controlled input driven by
 * a full list re-render would fight the caret.
 */
function AbilityEditRow({ ability, index, role, desc, dragProps, dragState = '' }) {
    return (
        <div
            className={`ability-row ability-custom ability-editing ${dragState}`.trim()}
            data-ability-index={index}
            {...dragProps}
        >
            <span className="ability-drag-handle" title="Drag to reorder" aria-label="Drag to reorder">⋮⋮</span>
            <div className="ability-body">
                <div className="ability-name-wrap">
                    <input
                        className="ability-name-input"
                        type="text"
                        defaultValue={ability.name || ''}
                        placeholder="Ability name"
                        onInput={e => call('updateAbility', index, 'name', e.target.value)}
                    />
                    <AbilityRoleLabel role={role} />
                </div>
                <input
                    className="ability-desc-input"
                    type="text"
                    defaultValue={desc}
                    placeholder="Short description"
                    onInput={e => call('updateAbility', index, 'desc', e.target.value)}
                />
            </div>
            <button
                className="ability-remove"
                type="button"
                title="Remove"
                onClick={e => { stop(e); call('removeAbility', index); }}
            >
                ×
            </button>
        </div>
    );
}

function AbilityRow({ ability, index, role, desc, isCustom, isCoded, dragProps, dragState = '' }) {
    // only custom abilities are editable
    const editProps = isCustom
        ? { onClick: e => { stop(e); call('toggleCustomAbilityEdit', index); }, title: 'Click to edit' }
        : {};

    return (
        <div
            className={`ability-row${isCustom ? ' ability-custom' : ''} ${dragState}`.trim()}
            draggable
            data-ability-index={index}
            {...dragProps}
        >
            <span className="ability-drag-handle" title="Drag to reorder" aria-label="Drag to reorder">⋮⋮</span>
            <div className="ability-body">
                <div className="ability-name-wrap">
                    <span className="ability-name-text" {...editProps}>{ability.name || 'Unnamed Ability'}</span>
                    <AbilityRoleLabel role={role} />
                    {isCoded && (
                        <span className="ability-code-badge" title="Has battle code from the block editor">
                            <Icon name="puzzle" /> Coded
                        </span>
                    )}
                </div>
                <div className="ability-desc-text" {...editProps}>{desc || 'No description available.'}</div>
            </div>
            {isCustom && ability.customId && (
                <button
                    className="ability-code-open"
                    type="button"
                    title={isCoded ? 'Edit battle code' : 'Add battle code'}
                    onClick={e => { stop(e); call('openAbilityBlockEditor', ability.customId); }}
                >
                    <Icon name="puzzle" />
                </button>
            )}
            <button
                className="ability-remove"
                type="button"
                title="Remove"
                onClick={e => { stop(e); call('removeAbility', index); }}
            >
                ×
            </button>
        </div>
    );
}

/**
 * @param {object} props
 * @param {Array} props.abilities
 * @param {number|null} props.editingIndex which custom ability is open for editing
 * @param {(ability) => {isCustom: boolean, isCoded: boolean, desc: string}} props.describe
 *   Looks through the Showdown dataset and custom-ability library in editor state.
 */
export function AbilityList({ abilities = [], editingIndex = null, describe = () => ({}) }) {
    // held in state, not the DOM, so a re-render mid-drag can't lose it
    const [dragging, setDragging] = useState(null);
    const [over, setOver] = useState(null);

    return (
        <>
            {abilities.map((ability, index) => {
                const { isCustom = false, isCoded = false, desc = '' } = describe(ability, index) || {};
                const role = abilityRole(index, abilities.length);

                const dragProps = {
                    onDragStart: e => {
                        // avoid stealing the text selection gesture from inputs
                        if (e.target.closest('input, button')) { e.preventDefault(); return; }
                        setDragging(index);
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', String(index));
                    },
                    onDragOver: e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(index); },
                    onDragLeave: () => setOver(o => (o === index ? null : o)),
                    onDrop: e => {
                        e.preventDefault();
                        const from = dragging !== null ? dragging : Number(e.dataTransfer.getData('text/plain'));
                        setDragging(null);
                        setOver(null);
                        call('moveAbility', from, index);
                    },
                    onDragEnd: () => { setDragging(null); setOver(null); }
                };

                // kept out of dragProps: a className there would replace .ability-row
                // instead of appending to it, since dragProps spreads after className
                const dragState = [
                    dragging === index ? 'ability-dragging' : '',
                    over === index ? 'ability-drag-over' : ''
                ].filter(Boolean).join(' ');

                const common = { ability, index, role, desc, dragProps, dragState };

                return isCustom && editingIndex === index
                    ? <AbilityEditRow key={ability.customId || ability.name || index} {...common} />
                    : <AbilityRow key={ability.customId || ability.name || index} {...common} isCustom={isCustom} isCoded={isCoded} />;
            })}
        </>
    );
}

// ==================== learnset ====================

export function LearnsetRow({ move, index, isCustom, categoryIcon }) {
    const catClass = move.category === 'Physical' ? 'cat-physical'
        : move.category === 'Special' ? 'cat-special'
            : 'cat-status';

    return (
        <div
            className={`learnset-item${isCustom ? ' custom-move-editor-item' : ''}`}
            onClick={() => (isCustom ? call('openCustomMoveModal', index) : call('showMoveDetail', move.name))}
        >
            <div className="learnset-main">
                <span className="move-name">{move.name}</span>
                <div className="move-meta">
                    <span className={`type-pill type-${String(move.type || 'normal').toLowerCase()}`}>
                        {move.type || 'Normal'}
                    </span>
                    {/* SVG markup generated in js/core/data.js for a fixed set of categories */}
                    <span
                        className={`cat-pill ${catClass}`}
                        dangerouslySetInnerHTML={{ __html: categoryIcon(move.category || 'Status', 14) }}
                    />
                    <span className="power-text">
                        {move.basePower || '-'} BP / {accuracyText(move.accuracy)}
                    </span>
                </div>
                <div className="move-method-row">
                    <select
                        className="method-select-inline"
                        value={move.learnMethod || 'none'}
                        onClick={stop}
                        onChange={e => { e.stopPropagation(); call('updateMoveMethod', index, e.target.value); }}
                    >
                        <option value="none">-</option>
                        <option value="level">Level</option>
                        <option value="tm">TM</option>
                        <option value="egg">Egg</option>
                    </select>
                    {/* hidden unless learn method is level-up */}
                    <input
                        type="number"
                        className="level-input-inline"
                        placeholder="Lv"
                        min="1"
                        max="100"
                        defaultValue={move.level || ''}
                        style={{ display: move.learnMethod === 'level' ? 'inline-block' : 'none' }}
                        onClick={stop}
                        onChange={e => { e.stopPropagation(); call('updateMoveLevel', index, e.target.value); }}
                    />
                </div>
            </div>
            <button className="remove-btn" onClick={e => { stop(e); call('removeLearnsetMove', index); }}>×</button>
        </div>
    );
}

/**
 * @param {object} props
 * @param {{m: object, i: number}[]} props.entries already filtered/sorted by
 *   prepareLearnset(); `i` is the index into the real learnset, used for edits.
 * @param {boolean} props.filtered whether a filter is responsible for an empty list
 * @param {(move) => boolean} props.isCustomMove
 * @param {(category: string, size: number) => string} props.categoryIcon
 */
export function LearnsetList({ entries = [], filtered = false, isCustomMove = () => false, categoryIcon = () => '' }) {
    if (!entries.length) {
        // a filtered-empty list needs to explain itself; an unfiltered one is normal
        if (!filtered) return null;
        return (
            <p style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>
                No moves match your filters.
            </p>
        );
    }

    return (
        <>
            {entries.map(({ m, i }) => (
                <LearnsetRow key={`${m.name}-${i}`} move={m} index={i} isCustom={isCustomMove(m)} categoryIcon={categoryIcon} />
            ))}
        </>
    );
}
