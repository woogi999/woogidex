// The block palette for the ability block editor. Interaction handlers call
// the same window globals the old inline ondragstart/onclick attributes did.

import { buildPaletteModel } from '../editor/ability-palette-model.js';

// Reached through window rather than imported to avoid a circular import
// back into the module that mounts this component.
const call = (name, ...args) => window[name]?.(...args);

function PaletteButton({ className, label, onDragStart, onClick }) {
    return (
        <button
            type="button"
            draggable
            className={className}
            onDragStart={onDragStart}
            onClick={onClick}
        >
            <span className="ab-palette-dot" />
            {label}
        </button>
    );
}

/**
 * @param {{kind: 'ability'|'move'|'item', tables: object}} props
 *   tables carries TRIGGERS / ACTIONS / BLOCK_GROUPS / EVENT_GROUP.
 */
export function AbilityPalette({ kind, tables }) {
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
                    <PaletteButton
                        key={key}
                        className="ab-palette-item ab-event-item"
                        label={label}
                        onDragStart={e => call('handlePaletteEventDragStart', e, key)}
                        onClick={e => { e.stopPropagation(); call('addAbilityEvent', key); }}
                    />
                ))}
            </div>

            {groups.map(group => (
                <div className="ab-palette-group" key={group.label}>
                    <div className="ab-palette-label">{group.label}</div>
                    {group.items.map(({ type, label }) => (
                        <PaletteButton
                            key={type}
                            className={`ab-palette-item ab-palette-${group.color}`}
                            label={label}
                            onDragStart={e => call('handlePaletteDragStart', e, type)}
                            onClick={() => call('addAbilityBlock', 'root', type)}
                        />
                    ))}
                </div>
            ))}

            <div className="ab-palette-tip">
                <strong>Tip</strong><br />
                Events are executable roots. Drag actions into an event stack.
                Add as many event triggers as you need.
            </div>
        </>
    );
}
