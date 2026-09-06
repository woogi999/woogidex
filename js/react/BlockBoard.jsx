// The ability block editor's board: a recursive drag-and-drop tree of blocks.
// Handlers call the same window globals the old inline attributes called, so
// the drag system and compiler keep working as before. React reconciling the
// tree (rather than rebuilding it from strings) means a drag no longer resets
// the workspace scroll position on every edit.
//
// Reached through window rather than imported, to avoid a circular import
// back into the module that mounts this file.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import {
    ensureBlockPosition,
    isFreeContainer,
    blockCategory,
    categoryClass,
    splitParamTemplate,
    buildConnectorPaths
} from '../editor/ability-board-model.js';

const call = (name, ...args) => window[name]?.(...args);
const stop = e => e.stopPropagation();

// ==================== parameter controls ====================
// These sit inline inside a block's sentence: "raise [attack] by [2]".

/**
 * Commits on blur, not on every keystroke -- committing per keystroke would
 * re-run the compiler and repaint the code preview per character.
 * Keyed on value so it remounts (rather than going stale) if the AST value
 * changes elsewhere.
 */
function CommitInput({ as = 'input', value, onCommit, ...rest }) {
    const Tag = as;
    const commit = e => onCommit(e.target.value);
    return (
        <Tag
            key={String(value ?? '')}
            defaultValue={value ?? ''}
            onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter' && as !== 'textarea') e.currentTarget.blur(); }}
            onClick={stop}
            onPointerDown={stop}
            {...rest}
        />
    );
}

function ParamControl({ pdef, value, values, onCommit, resolveOptions }) {
    if (pdef.type === 'select' || pdef.type === 'dynamic-select') {
        // dynamic-select's choices depend on a sibling parameter's value.
        const options = (pdef.type === 'dynamic-select' && resolveOptions)
            ? resolveOptions(pdef, values || {})
            : (pdef.options || []);
        return (
            <select
                className="ab-inline-input"
                value={value ?? ''}
                onChange={e => onCommit(e.target.value)}
                onClick={stop}
                onPointerDown={stop}
            >
                {options.map(o => (
                    <option key={String(o.value)} value={o.value}>{o.label}</option>
                ))}
            </select>
        );
    }

    if (pdef.type === 'code') {
        return (
            <CommitInput
                as="textarea"
                className="ab-inline-code"
                rows={3}
                spellCheck={false}
                placeholder={pdef.placeholder || ''}
                value={value}
                onCommit={onCommit}
            />
        );
    }

    if (pdef.type === 'number') {
        return (
            <CommitInput
                type="number"
                className="ab-inline-input ab-inline-number"
                min={pdef.min}
                max={pdef.max}
                step={pdef.step}
                value={value}
                onCommit={onCommit}
            />
        );
    }

    return (
        <CommitInput
            type="text"
            className="ab-inline-input ab-inline-text"
            value={value}
            onCommit={onCommit}
        />
    );
}

/** An action's label with its parameter slots filled in, as one sentence. */
function ParamLabel({ template, paramDefs, values, onCommit, resolveOptions }) {
    return splitParamTemplate(template, paramDefs).map((seg, i) => (
        <span key={i}>
            {seg.text}
            {seg.param && (
                <ParamControl
                    pdef={seg.param}
                    value={(values || {})[seg.param.key]}
                    values={values}
                    resolveOptions={resolveOptions}
                    onCommit={v => onCommit(seg.param.key, v)}
                />
            )}
        </span>
    ));
}

// ==================== structure ====================

function ConnectionSlot({ containerId, label }) {
    return (
        <div
            className="ab-connection-slot"
            data-container-id={containerId}
            data-accept="statement"
            onDragOver={e => call('handleConnectionDragOver', e, containerId)}
            onDragLeave={e => call('handleConnectionDragLeave', e)}
            onDrop={e => call('handleConnectionDrop', e, containerId)}
        >
            <span className="ab-slot-notch" />
            <span>{label}</span>
        </div>
    );
}

function Container({ list, containerId, depth, tables }) {
    const free = containerId === 'root';
    list.forEach((b, i) => ensureBlockPosition(b, i, depth));
    return (
        <div
            className={`ab-container ${free ? 'ab-free-container' : 'ab-nested-container'}`}
            data-container-id={containerId}
            data-depth={depth}
        >
            {list.map((block, i) => (
                <Block key={block.id} block={block} containerId={containerId} index={i} depth={depth} tables={tables} />
            ))}
            {/* root is an open whiteboard; nested containers expose a real socket */}
            {!free && (
                <ConnectionSlot
                    containerId={containerId}
                    label={list.length ? 'Drop another block here' : 'Drop a block inside'}
                />
            )}
        </div>
    );
}

/** Attributes every block shares: pointer-drag, drop target, and absolute
 *  positioning when on the free board rather than in a socket. */
function blockFrameProps(block, containerId) {
    return {
        'data-id': block.id,
        draggable: false,
        onPointerDown: e => call('startAbilityBlockMove', e, block.id, containerId),
        onDragStart: e => call('handleBlockConnectionDragStart', e, block.id),
        onDragEnd: e => call('handleBlockConnectionDragEnd', e),
        onDragOver: e => call('allowWorkspaceDrop', e),
        onDrop: e => call('handleWorkspaceDrop', e),
        style: isFreeContainer(containerId) ? { left: block.pos.x, top: block.pos.y } : undefined
    };
}

function BlockControls({ id, canReorder = true }) {
    return (
        <span className="ab-block-controls">
            {canReorder && (
                <>
                    <button type="button" title="Move earlier" onClick={e => { stop(e); call('moveAbilityBlock', id, -1); }}>
                        <Icon name="chevron-up" />
                    </button>
                    <button type="button" title="Move later" onClick={e => { stop(e); call('moveAbilityBlock', id, 1); }}>
                        <Icon name="chevron-down" />
                    </button>
                </>
            )}
            <button type="button" title="Delete block" onClick={e => { stop(e); call('removeAbilityBlock', id); }}>
                <Icon name="trash-2" />
            </button>
        </span>
    );
}

function EventBlock({ block, index, tables }) {
    const def = tables.TRIGGERS?.[block.trigger];
    if (!def) return null;
    ensureBlockPosition(block, index, 0);
    const defs = def.params || [];

    return (
        <div className="ab-block ab-event-block" {...blockFrameProps(block, 'root-events')}>
            <div className="ab-trigger-hat">
                <span className="ab-block-drag"><Icon name="grip-vertical" /></span>
                <Icon name={def.icon || 'zap'} />
                <strong>When</strong>
                <span>{def.label}</span>
                {defs.map(p => (
                    <span key={p.key}>
                        {/* only label when there's more than one dropdown, to avoid ambiguity */}
                        {defs.length > 1 && p.label && <span className="ab-param-label">{p.label}</span>}
                        <ParamControl
                            pdef={p}
                            value={(block.triggerParams || {})[p.key]}
                            values={block.triggerParams}
                            resolveOptions={tables.resolveOptions}
                            onCommit={v => call('updateAbilityEventParam', block.id, p.key, v)}
                        />
                    </span>
                ))}
                <span className="ab-block-controls">
                    <button type="button" title="Delete event" onClick={e => { stop(e); call('removeAbilityBlock', block.id); }}>
                        <Icon name="trash-2" />
                    </button>
                </span>
            </div>
            <div className="ab-event-body">
                <Container list={block.body || []} containerId={block.id + ':body'} depth={1} tables={tables} />
            </div>
        </div>
    );
}

function ActionBlock({ block, containerId, index, tables }) {
    const def = tables.ACTIONS?.[block.action];
    if (!def) return null;
    ensureBlockPosition(block, index, containerId === 'root' ? 0 : 1);
    const category = blockCategory(block.action, tables);

    return (
        <div className={`ab-block ab-action-block ${categoryClass(category)}`} {...blockFrameProps(block, containerId)}>
            <div className="ab-block-main">
                <span className="ab-block-drag" title="Drag anywhere on the block"><Icon name="grip-vertical" /></span>
                <span className="ab-block-text">
                    <strong className="ab-block-kind">{category}</strong>{' '}
                    <ParamLabel
                        template={def.label}
                        paramDefs={def.params}
                        values={block.params}
                        resolveOptions={tables.resolveOptions}
                        onCommit={(key, v) => call('updateAbilityBlockParam', block.id, key, v)}
                    />
                </span>
                <BlockControls id={block.id} />
            </div>
            <span className="ab-block-bottom-connector" aria-hidden="true" />
        </div>
    );
}

function IfBlock({ block, containerId, index, depth, tables }) {
    const CONDITIONS = tables.CONDITIONS || {};
    const def = CONDITIONS[block.condition] || CONDITIONS[Object.keys(CONDITIONS)[0]] || {};
    ensureBlockPosition(block, index, containerId === 'root' ? 0 : 1);

    return (
        <div className="ab-block ab-if-block" {...blockFrameProps(block, containerId)}>
            <span className="ab-block-top-connector" aria-hidden="true" />
            <div className="ab-block-main">
                <span className="ab-block-drag" title="Drag anywhere on the block"><Icon name="grip-vertical" /></span>
                <span className="ab-block-text">
                    <strong className="ab-block-kind">Control</strong> If{' '}
                    <select
                        className="ab-inline-input"
                        value={block.condition ?? ''}
                        onChange={e => call('updateAbilityIfCondition', block.id, e.target.value)}
                        onClick={stop}
                        onPointerDown={stop}
                    >
                        {Object.entries(CONDITIONS).map(([key, c]) => (
                            <option key={key} value={key}>{String(c.label || key).replace(/__/g, '…')}</option>
                        ))}
                    </select>{' '}
                    {(def.params || []).map(p => (
                        <ParamControl
                            key={p.key}
                            pdef={p}
                            value={(block.condParams || {})[p.key]}
                            values={block.condParams}
                            resolveOptions={tables.resolveOptions}
                            onCommit={v => call('updateAbilityIfCondParam', block.id, p.key, v)}
                        />
                    ))}
                </span>
                <BlockControls id={block.id} />
            </div>
            <div className="ab-if-then">
                <span className="ab-if-label">then</span>
                <Container list={block.then || []} containerId={block.id + ':then'} depth={depth + 1} tables={tables} />
            </div>
            <div className="ab-if-else">
                <span className="ab-if-label">else</span>
                <Container list={block.else || []} containerId={block.id + ':else'} depth={depth + 1} tables={tables} />
            </div>
            <span className="ab-block-bottom-connector" aria-hidden="true" />
        </div>
    );
}

function Block({ block, containerId, index, depth, tables }) {
    if (block.kind === 'event') return <EventBlock block={block} index={index} tables={tables} />;
    if (block.kind === 'action') return <ActionBlock block={block} containerId={containerId} index={index} tables={tables} />;
    if (block.kind === 'if') return <IfBlock block={block} containerId={containerId} index={index} depth={depth} tables={tables} />;
    return null;
}

// ==================== execution-order connectors ====================
// Curves from each event block to the next. Drawn after layout since they need
// measured geometry (buildConnectorPaths() does the actual math).

// Falls back to useEffect when there's no browser layout to measure, since
// React warns on useLayoutEffect during server rendering.
const useMeasureEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function BoardConnections({ events }) {
    const ref = useRef(null);
    const [paths, setPaths] = useState([]);

    // Signature rather than the array itself: drag code mutates event objects
    // in place, so identity alone wouldn't reflect a move.
    const signature = events.map(e => `${e.id}@${e.pos?.x},${e.pos?.y}`).join('|');

    useMeasureEffect(() => {
        const workspace = ref.current?.parentElement;
        if (!workspace) return;
        const root = workspace.getBoundingClientRect();
        const boxes = events.map(ev => {
            const el = workspace.querySelector(`.ab-block[data-id="${CSS.escape(ev.id)}"]`);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left - root.left, y: r.top - root.top, width: r.width, height: r.height };
        });
        setPaths(buildConnectorPaths(boxes));
    }, [signature]);

    return (
        <svg ref={ref} className="ab-board-connections" id="ab-board-connections" aria-hidden="true">
            <defs>
                <marker id="ab-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                </marker>
            </defs>
            {paths.map((d, i) => (
                <path key={i} d={d} className="ab-connector-line" markerEnd="url(#ab-arrow)" />
            ))}
        </svg>
    );
}

// ==================== the board ====================

/**
 * @param {object} props
 * @param {Array} props.events top-level event stacks, in execution order
 * @param {Array} props.loose  blocks parked on the board outside any event
 * @param {object} props.tables TRIGGERS / ACTIONS / CONDITIONS / BLOCK_GROUPS,
 *   plus resolveOptions() for dynamic selects.
 */
export function BlockBoard({ events = [], loose = [], tables = {} }) {
    return (
        <>
            <BoardConnections events={events} />
            <div className="ab-container ab-event-root-container" data-container-id="root-events">
                {events.map((block, i) => (
                    <Block key={block.id} block={block} containerId="root-events" index={i} depth={0} tables={tables} />
                ))}
            </div>
            <div className="ab-container ab-loose-container" data-container-id="loose">
                {loose.map((block, i) => (
                    <Block key={block.id} block={block} containerId="loose" index={i} depth={0} tables={tables} />
                ))}
            </div>
        </>
    );
}
