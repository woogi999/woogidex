// The block palette beside the ability block board: drag an entry onto the
// board, or click it to add it. Which entries show: ability-palette-model.ts.

import type { DragEvent, MouseEvent } from 'react';
import { buildPaletteModel } from '../../../editor/ability-palette-model.ts';
import {
    addAbilityBlock, addAbilityEvent, handlePaletteDragStart, handlePaletteEventDragStart
} from '../../../editor/ability-blocks.ts';

function PaletteButton({ className, label, onDragStart, onClick }: {
    className: string; label: string; onDragStart: (e: DragEvent) => void; onClick: (e: MouseEvent) => void;
}) {
    return (
        <button type="button" draggable className={className} onDragStart={onDragStart} onClick={onClick}>
            <span className="ab-palette-dot" />
            {label}
        </button>
    );
}

/** tables carries TRIGGERS / ACTIONS / BLOCK_GROUPS / EVENT_GROUP. */
export function AbilityPalette({ kind, tables }: { kind: 'ability' | 'move' | 'item'; tables: any }) {
    const { events, groups } = buildPaletteModel(tables, kind);
    return (
        <>
            <div className="ab-palette-title">Blocks</div>
            <div className="ab-palette-help">
                Drag orange Events onto the board. Each event gets its own Scratch-style stack,
                so one ability can react to many triggers.
            </div>

            <div className="ab-palette-group ab-palette-events">
                <div className="ab-palette-label">Events</div>
                {events.map(({ key, label }) => (
                    <PaletteButton key={key} className="ab-palette-item ab-event-item" label={label}
                        onDragStart={e => handlePaletteEventDragStart(e, key)}
                        onClick={e => { e.stopPropagation(); addAbilityEvent(key); }} />
                ))}
            </div>

            {groups.map(group => (
                <div className="ab-palette-group" key={group.label}>
                    <div className="ab-palette-label">{group.label}</div>
                    {group.items.map(({ type, label }) => (
                        <PaletteButton key={type} className={`ab-palette-item ab-palette-${group.color}`} label={label}
                            onDragStart={e => handlePaletteDragStart(e, type)}
                            onClick={() => addAbilityBlock('root', type)} />
                    ))}
                </div>
            ))}

            <div className="ab-palette-tip">
                <strong>Tip</strong><br />
                Drag actions into an event block.
                Add as many event triggers as you need.
            </div>
        </>
    );
}
