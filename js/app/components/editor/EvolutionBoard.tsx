// The evolution and forme whiteboard on the editor's Stats tab. Pokémon and
// evolution methods are cards you drag around; dragging from a card's right
// handle to another's left handle connects them, a wire's scissors cut it,
// and a card dropped onto a wire joins it. The graph and its rules (stages,
// loops, stacking methods, saving onto every member) are
// js/features/evolution.ts.

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { api } from '../../../core/app.ts';
import { Icon } from '../Icon.tsx';

type Side = 'left' | 'right';
type Point = { x: number; y: number };
type Linking = { nodeId: string; side: Side; x: number; y: number; snap: (Point & { nodeId: string; side: Side }) | null };

const SNAP_RADIUS = 42;
const handleKey = (nodeId: string, side: Side) => `${nodeId}|${side}`;

function wirePath(a: Point, b: Point) {
    const dx = Math.max(30, Math.abs(b.x - a.x) * 0.45);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function Sprite({ src, name, fallback }: { src: string; name: string; fallback: string }) {
    if (!src) return <img className="no-art-placeholder" src="assets/no_art_placeholder.png" alt="" draggable={false} />;
    return (
        <img key={src} src={src} alt={name} loading="lazy" decoding="async" draggable={false}
            onError={e => (window as any).fallbackPokemonImage?.(e.currentTarget, name, fallback)} />
    );
}

export function EvolutionBoard() {
    const board = useRef<HTMLDivElement>(null);
    const [, redraw] = useReducer((x: number) => x + 1, 0);
    const [size, setSize] = useState({ w: 900, h: 520 });
    const [handles, setHandles] = useState<Record<string, Point>>({});
    const [linking, setLinking] = useState<Linking | null>(null);
    const [hoverEdge, setHoverEdge] = useState<number | null>(null);

    const g = api.ensureGraph();
    const me = api.addCurrentNode();
    const stages: Record<string, number> = api.calculateEvolutionStages(g);
    const { w: NODE_W, h: NODE_H } = api.getNodeSize();
    const W = Math.max(size.w || 900, NODE_W + 40);
    const H = Math.max(size.h || 520, NODE_H + 40);

    // the board's size decides where cards are kept inside it
    useEffect(() => {
        const el = board.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // wires start and end on the handles where they actually are (a method
    // card's height differs, and cards change size at breakpoints)
    useLayoutEffect(() => {
        const el = board.current;
        if (!el) return;
        const br = el.getBoundingClientRect();
        const next: Record<string, Point> = {};
        el.querySelectorAll<HTMLElement>('.evo-handle[data-node-id]').forEach(h => {
            const r = h.getBoundingClientRect();
            next[handleKey(h.dataset.nodeId!, h.dataset.side as Side)] = { x: r.left - br.left + r.width / 2, y: r.top - br.top + r.height / 2 };
        });
        if (JSON.stringify(next) !== JSON.stringify(handles)) setHandles(next);
    });

    const pointOf = (node: any, side: Side): Point => handles[handleKey(node.id, side)]
        || { x: (node.x || 0) + (side === 'right' ? NODE_W : 0), y: (node.y || 0) + NODE_H / 2 };
    const boardPoint = (e: { clientX: number; clientY: number }): Point => {
        const r = board.current!.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    /** Dragging a card around; only the dragged card and its wires move until it's let go. */
    const startNodeDrag = (e: React.PointerEvent, node: any) => {
        if ((e.target as Element).closest('.evo-handle, button')) return;
        e.preventDefault();
        const start = boardPoint(e);
        const ox = start.x - (node.x || 0), oy = start.y - (node.y || 0);
        const move = (ev: PointerEvent) => {
            const p = boardPoint(ev);
            const rect = board.current!.getBoundingClientRect();
            node.x = Math.max(4, Math.min(rect.width - NODE_W - 4, p.x - ox));
            node.y = Math.max(4, Math.min(rect.height - NODE_H - 4, p.y - oy));
            redraw();
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            api.finishNodeDrag(node.id);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    };

    /** Dragging a wire out of a handle; it snaps to a compatible handle nearby. */
    const startHandleDrag = (e: React.PointerEvent, nodeId: string, side: Side) => {
        e.stopPropagation();
        e.preventDefault();
        const nearest = (p: Point) => {
            let best: Linking['snap'] = null, bestDist = Infinity;
            for (const [key, pt] of Object.entries(handles)) {
                const [id, s] = key.split('|') as [string, Side];
                // a connection runs right to left; either end can start it
                if (id === nodeId || s === side) continue;
                const d = Math.hypot(pt.x - p.x, pt.y - p.y);
                if (d <= SNAP_RADIUS && d < bestDist) { bestDist = d; best = { ...pt, nodeId: id, side: s }; }
            }
            return best;
        };
        const p0 = boardPoint(e);
        let current: Linking = { nodeId, side, ...p0, snap: nearest(p0) };
        setLinking(current);
        const move = (ev: PointerEvent) => {
            const p = boardPoint(ev);
            current = { ...current, ...p, snap: nearest(p) };
            setLinking(current);
        };
        const up = (ev: PointerEvent) => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            setLinking(null);
            let target = current.snap ? { nodeId: current.snap.nodeId, side: current.snap.side } : null;
            if (!target && ev.type === 'pointerup') {
                const h = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('.evo-handle[data-node-id]');
                if (h) target = { nodeId: h.dataset.nodeId!, side: h.dataset.side as Side };
            }
            if (target && target.nodeId !== nodeId) api.connectHandles(nodeId, side, target.nodeId, target.side);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    };

    const handle = (nodeId: string, side: Side, title: string) => {
        const snapped = linking?.snap?.nodeId === nodeId && linking.snap.side === side;
        const dragging = linking?.nodeId === nodeId && linking.side === side;
        return (
            <button className={`evo-handle evo-handle-${side}${snapped ? ' evo-snap-target' : ''}${dragging ? ' dragging' : ''}`} type="button" title={title}
                aria-label={title} data-node-id={nodeId} data-side={side} onPointerDown={e => startHandleDrag(e, nodeId, side)} />
        );
    };
    const place = (n: any) => ({
        width: NODE_W, minHeight: NODE_H,
        left: Math.max(4, Math.min(W - NODE_W - 4, n.x || 20)),
        top: Math.max(4, Math.min(H - NODE_H - 4, n.y || 20))
    });

    return (
        <div id="evolution-board" className="evolution-board" ref={board}>
            <svg className="evo-wires" aria-hidden="true" viewBox={`0 0 ${size.w || NODE_W + 40} ${size.h || NODE_H + 40}`}>
                <defs>
                    <marker id="evo-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                        <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                    </marker>
                </defs>
                {linking && (() => {
                    const source = g.nodes.find((n: any) => n.id === linking.nodeId);
                    if (!source) return null;
                    const end = linking.snap || linking;
                    return <path className="evo-wire evo-wire-preview" d={wirePath(pointOf(source, linking.side), end)} />;
                })()}
                {g.edges.map((edge: any, i: number) => {
                    const a = g.nodes.find((n: any) => n.id === edge.from), b = g.nodes.find((n: any) => n.id === edge.to);
                    if (!a || !b) return null;
                    const from = pointOf(a, 'right'), to = pointOf(b, 'left');
                    const d = wirePath(from, to);
                    return (
                        <g key={`${edge.from}->${edge.to}`} className={`evo-wire-group${hoverEdge === i ? ' hover' : ''}`}>
                            <path className="evo-wire" d={d} markerEnd="url(#evo-arrow)" pointerEvents="none" />
                            {/* a wide invisible stroke, so the thin wire is still easy to hit */}
                            <path className="evo-wire-hit" d={d} pointerEvents="stroke"
                                onPointerEnter={() => setHoverEdge(i)} onPointerLeave={() => setHoverEdge(h => (h === i ? null : h))}
                                onPointerDown={ev => { ev.stopPropagation(); setHoverEdge(null); api.removeEvolutionEdge(edge); }} />
                            <Icon name="scissors" size={18} className="evo-wire-scissors" x={(from.x + to.x) / 2 - 9} y={(from.y + to.y) / 2 - 9} pointerEvents="none" />
                        </g>
                    );
                })}
            </svg>

            {g.nodes.map((n: any) => {
                if (api.isMethodNode(n)) {
                    return (
                        <div key={n.id} className={`evo-node evo-method-node${n.mergeGroup ? ' evo-method-merged' : ''}`} data-node-id={n.id} style={place(n)}
                            onPointerDown={e => startNodeDrag(e, n)}>
                            {handle(n.id, 'left', 'Connect from previous node')}
                            <div className="evo-method-head">
                                <span><span className="evo-method-kicker">Evo method</span><strong>{api.getMethodLabel(n)}</strong></span>
                                <span className="evo-method-tools">
                                    {n.mergeGroup && <span className="evo-method-stack-mark" title="Merged method group"><Icon name="diamond" size={10} /></span>}
                                    <button className="evo-method-edit" type="button" title="Edit method" aria-label="Edit method" onClick={e => { e.stopPropagation(); api.openEvolutionMethodEditor(n.id); }}><Icon name="pencil" size={12} /></button>
                                    <button className="evo-remove" type="button" title="Remove" aria-label="Remove" onClick={e => { e.stopPropagation(); api.removeEvolutionMethod(n.id); }}><Icon name="x" size={12} /></button>
                                </span>
                            </div>
                            <div className="evo-method-summary">{api.getMethodSummary(n)}</div>
                            {handle(n.id, 'right', 'Connect to next node')}
                        </div>
                    );
                }
                const info = api.getNodeInfo(n);
                const stageLabel = n.isMega ? 'Mega Evolution' : n.isFormeChange ? 'Forme Change' : `Stage ${stages[n.id] || 1}`;
                const tags = [n.isMega ? 'Mega Evolution' : '', n.isFormeChange ? 'Forme Change' : ''].filter(Boolean);
                // a Fakémon without artwork has no sprite anywhere to fall back on
                const sprite = info.artwork || (info.kindLabel === 'Fakemon' ? '' : api.getSpriteUrl?.(info.spriteId, info.record || { id: info.spriteId, name: info.name }) || '');
                const isMe = n.id === me.id;
                return (
                    <div key={n.id} className={`evo-node${isMe ? ' current' : ''}`} data-node-id={n.id} style={place(n)} onPointerDown={e => startNodeDrag(e, n)}>
                        {handle(n.id, 'left', 'Drag from this side to connect')}
                        <div className="evo-node-head">
                            <span className="evo-stage">{stageLabel}</span>
                            <span className="evo-method-tools">
                                <span className="evo-kind">{info.kindLabel}</span>
                                {!isMe && <button className="evo-remove" type="button" title="Remove" aria-label="Remove" onClick={e => { e.stopPropagation(); api.removeEvolutionNode(n.id); }}><Icon name="x" size={12} /></button>}
                            </span>
                        </div>
                        <div className="evo-node-body">
                            <div className="evo-sprite-wrap"><Sprite src={sprite} name={info.name} fallback={String(info.record?.baseSpecies || info.refId || info.name)} /></div>
                            <div className="evo-node-name">
                                <strong>{info.name}</strong>
                                <small>{info.species || ''}</small>
                                <span className="evo-node-types">{(info.types || []).map((t: string) => <span key={t} className={`type-pill type-${String(t).toLowerCase()}`}>{t}</span>)}</span>
                                {tags.length > 0 && <em>{tags.join(' · ')}</em>}
                            </div>
                        </div>
                        {/* a Mega is the end of its line */}
                        {!n.isMega && handle(n.id, 'right', 'Drag from this side to connect')}
                    </div>
                );
            })}
        </div>
    );
}

/** "3 Pokémon · 2 connections", above the board. */
export function EvolutionStatus() {
    const g = api.ensureGraph();
    return <div className="evolution-status">{g.nodes.length} Pokémon · {g.edges.length} connection{g.edges.length === 1 ? '' : 's'}</div>;
}
