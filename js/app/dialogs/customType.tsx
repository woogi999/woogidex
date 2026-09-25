// The custom type editor (a right-hand sheet): name, colour or gradient, icon,
// description, and the type's matchups both ways, sorted by dragging each
// type into a group (or tapping it, then the group). It also edits a region's
// own version of a main-game type. Saving and the rules are
// js/features/custom-types.ts.

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../core/app.ts';
import {
    ANGLES, GRADIENT_PRESETS, MATCHUP_GROUPS, MAX_STOPS, TYPE_COLORS, canDeleteCustomType, colorAt, customTypeDraft,
    customTypeMatchups, deleteCustomType, matchupGroupOf, saveCustomTypeDraft, startGradient, typeBackground, withMatchup
} from '../../features/custom-types.ts';
import { entryRegionIds } from '../../features/regions.ts';
import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Modal } from '../components/Modal.tsx';
import { Icon } from '../components/Icon.tsx';
import { RegionAssign } from '../components/RegionAssign.tsx';
import { ArtField } from '../components/ArtField.tsx';

type Stop = { color: string; pos: number };
type Gradient = { angle: number; stops: Stop[] };
type Draft = {
    name: string; color: string; gradient: Gradient | null; desc: string; icon: string; vanillaOf: string | null;
    offense: Record<string, number>; defense: Record<string, number>;
};
type Side = 'offense' | 'defense';

const stopsBar = (stops: Stop[]) => `linear-gradient(90deg, ${[...stops].sort((a, b) => a.pos - b.pos).map(s => `${s.color} ${s.pos}%`).join(', ')})`;
const clampPos = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

// an arrow pointing the way the gradient runs (CSS angles: 90deg is left to right)
function AngleArrow({ deg }: { deg: number }) {
    return (
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" style={{ transform: `rotate(${deg - 90}deg)` }}>
            <path d="M4 12h15M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

/** The fixed colours plus "any colour" (a native picker). */
function Swatches({ current, onPick }: { current: string; onPick: (hex: string) => void }) {
    const custom = !TYPE_COLORS.includes(current);
    return (
        <div className="type-color-row">
            {TYPE_COLORS.map((hex: string) => (
                <button key={hex} type="button" className={`color-option${hex === current ? ' selected' : ''}`} style={{ backgroundColor: hex }}
                    aria-label={`Colour ${hex}`} onClick={() => onPick(hex)} />
            ))}
            <label className={`color-option color-option-custom${custom ? ' selected' : ''}`} title="Pick any colour" style={{ backgroundColor: custom ? current : 'transparent' }}>
                <Icon name="pipette" />
                <input type="color" value={current} onChange={e => onPick(e.target.value)} />
            </label>
        </div>
    );
}

// ---- colour: solid, or a gradient of up to MAX_STOPS stops ----

function FillEditor({ draft, setDraft }: { draft: Draft; setDraft: (fn: (d: Draft) => Draft) => void }) {
    const [selected, setSelected] = useState(0);
    const lastGradient = useRef<Gradient | null>(null);
    const bar = useRef<HTMLDivElement>(null);
    const g = draft.gradient;
    const sel = g ? Math.min(selected, g.stops.length - 1) : 0;

    // the first stop doubles as the type's plain colour, for anything that only takes one
    const setGradient = (next: Gradient | null) => setDraft(d => ({ ...d, gradient: next, color: next ? [...next.stops].sort((a, b) => a.pos - b.pos)[0].color : d.color }));
    const setStops = (stops: Stop[]) => g && setGradient({ ...g, stops });
    /** Sorts the stops by position, keeping the given one selected. */
    const settle = (stops: Stop[], index: number) => {
        const order = stops.map((s, i) => [s, i] as const).sort((a, b) => a[0].pos - b[0].pos);
        setStops(order.map(([s]) => s));
        setSelected(order.findIndex(([, i]) => i === index));
    };

    const posAt = (clientX: number) => {
        const rect = bar.current!.getBoundingClientRect();
        return clampPos(((clientX - rect.left) / rect.width) * 100);
    };

    /** Drags stop `index` of `stops` with the pointer until it's let go. */
    const drag = (event: ReactPointerEvent, stops: Stop[], index: number) => {
        event.preventDefault();
        event.stopPropagation();
        let current = stops;
        setSelected(index);
        const move = (e: PointerEvent) => {
            current = current.map((s, i) => (i === index ? { ...s, pos: posAt(e.clientX) } : s));
            setStops(current);
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            settle(current, index);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    };

    /** Clicking empty bar adds a stop there, in the colour the gradient already has at that spot. */
    const barDown = (event: ReactPointerEvent) => {
        if (!g || (event.target as Element).closest('.type-gradient-stop')) return;
        if (g.stops.length >= MAX_STOPS) { api.showToast?.(`A gradient can have up to ${MAX_STOPS} stops.`, 'info'); return; }
        const pos = posAt(event.clientX);
        const sorted = [...g.stops].sort((a, b) => a.pos - b.pos);
        const stops = [...g.stops, { color: colorAt(sorted, pos), pos }];
        setStops(stops);
        // carry straight on into a drag, so click-and-drag places it in one go
        drag(event, stops, stops.length - 1);
    };

    const mode = (
        <div className="seg type-fill-mode" role="radiogroup" aria-label="Fill">
            <button type="button" role="radio" aria-checked={!g} className={`seg-btn${g ? '' : ' on'}`}
                onClick={() => { if (g) { lastGradient.current = g; setGradient(null); } }}>Solid</button>
            <button type="button" role="radio" aria-checked={!!g} className={`seg-btn${g ? ' on' : ''}`}
                onClick={() => { if (!g) { setSelected(0); setGradient(lastGradient.current || startGradient(draft.color)); } }}>Gradient</button>
        </div>
    );
    if (!g) {
        return <>{mode}<Swatches current={draft.color} onPick={hex => setDraft(d => ({ ...d, color: hex }))} /></>;
    }
    const stop = g.stops[sel];
    return (
        <>
            {mode}
            <div className="type-gradient-opts">
                <span className="type-gradient-label">Presets</span>
                <div className="type-gradient-presets">
                    {GRADIENT_PRESETS.map(([label, angle, stops]: [string, number, Array<[string, number]>]) => (
                        <button key={label} type="button" className="type-gradient-preset" title={label} aria-label={`${label} preset`}
                            style={{ background: `linear-gradient(${angle}deg, ${stops.map(([c, p]) => `${c} ${p}%`).join(', ')})` }}
                            onClick={() => { setSelected(0); setGradient({ angle, stops: stops.map(([color, pos]) => ({ color, pos })) }); }} />
                    ))}
                </div>
                <span className="type-gradient-label">Stops <small>click the bar to add one, drag to move</small></span>
                <div className="type-gradient-bar" ref={bar} style={{ background: stopsBar(g.stops) }} onPointerDown={barDown}>
                    {g.stops.map((s, i) => (
                        <button key={i} type="button" className={`type-gradient-stop${i === sel ? ' on' : ''}`} style={{ left: `${s.pos}%`, '--stop': s.color } as CSSProperties}
                            aria-label={`Stop ${i + 1} at ${s.pos}%`} onPointerDown={e => drag(e, g.stops, i)} />
                    ))}
                </div>
                <div className="type-gradient-stop-edit">
                    <span className="type-gradient-label">Stop {sel + 1} colour</span>
                    <Swatches current={stop.color} onPick={hex => setStops(g.stops.map((s, i) => (i === sel ? { ...s, color: hex } : s)))} />
                    <div className="type-gradient-stop-row">
                        <label className="type-gradient-pos">Position{' '}
                            <input type="number" min={0} max={100} value={stop.pos}
                                onChange={e => settle(g.stops.map((s, i) => (i === sel ? { ...s, pos: clampPos(Number(e.target.value) || 0) } : s)), sel)} />%
                        </label>
                        <button type="button" className="btn btn-secondary btn-sm" disabled={g.stops.length <= 2}
                            onClick={() => { setStops(g.stops.filter((_, i) => i !== sel)); setSelected(Math.max(0, sel - 1)); }}>
                            <Icon name="trash-2" /><span>Remove stop</span>
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm"
                            onClick={() => { setStops(g.stops.map(s => ({ color: s.color, pos: 100 - s.pos })).reverse()); setSelected(g.stops.length - 1 - sel); }}>
                            <Icon name="refresh-cw" /><span>Reverse</span>
                        </button>
                    </div>
                </div>
                <span className="type-gradient-label">Direction</span>
                <div className="type-gradient-angle">
                    <div className="seg">
                        {ANGLES.map(([deg, label]: [number, string]) => (
                            <button key={deg} type="button" className={`seg-btn${Number(g.angle) === deg ? ' on' : ''}`} title={label} aria-label={label}
                                onClick={() => setGradient({ ...g, angle: deg })}><AngleArrow deg={deg} /></button>
                        ))}
                    </div>
                    <input type="range" min={0} max={360} step={5} value={Number(g.angle)} aria-label="Angle in degrees"
                        onChange={e => setGradient({ ...g, angle: Number(e.target.value) || 0 })} />
                    <span className="type-gradient-angle-value">{Number(g.angle)}°</span>
                </div>
            </div>
        </>
    );
}

// ---- matchups: two boards of five groups ----

type Chip = { key: string; name: string; value: number; self?: boolean };
type Dragging = { side: Side; key: string; name: string; x: number; y: number; over: HTMLElement | null; self?: boolean };

function MatchupBoards({ draft, entry, setDraft, selfStyle }: { draft: Draft; entry: any; setDraft: (fn: (d: Draft) => Draft) => void; selfStyle: CSSProperties }) {
    const [picked, setPicked] = useState<{ side: Side; key: string } | null>(null);
    const [dragging, setDragging] = useState<Dragging | null>(null);
    const { offense, defense } = customTypeMatchups(draft, entry) as { offense: Chip[]; defense: Chip[] };
    const place = (side: Side, key: string, mult: number) => setDraft(d => withMatchup(d, side, key, mult));

    /** Drags a chip to another group; a press that doesn't move is a tap. */
    const down = (event: ReactPointerEvent, side: Side, chip: Chip) => {
        event.stopPropagation();
        const startX = event.clientX, startY = event.clientY;
        let state: Dragging | null = null;
        const zoneAt = (x: number, y: number) => {
            const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.type-group-zone');
            return el && el.dataset.kind === side ? el : null;
        };
        const move = (e: PointerEvent) => {
            if (!state && Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
            e.preventDefault();
            state = { side, key: chip.key, name: chip.name, self: chip.self, x: e.clientX, y: e.clientY, over: zoneAt(e.clientX, e.clientY) };
            setDragging(state);
        };
        const up = (e: PointerEvent) => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            setDragging(null);
            if (state) {
                const zone = e.type === 'pointerup' ? zoneAt(e.clientX, e.clientY) : null;
                if (zone) { setPicked(null); place(side, chip.key, Number(zone.dataset.mult)); }
                return;
            }
            // a tap: pick it up (or put it back down)
            setPicked(p => (p && p.side === side && p.key === chip.key ? null : { side, key: chip.key }));
        };
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    };

    const self = draft.name || draft.vanillaOf || 'this type';
    const board = (side: Side, chips: Chip[]) => (
        <section className="type-group-board" data-kind={side}>
            <header>
                <h4>{side === 'offense' ? `When ${self} attacks` : `When ${self} is attacked`}</h4>
                <p>{side === 'offense' ? 'How much damage its moves do to each type.' : 'How much damage each type does to it.'}</p>
            </header>
            {MATCHUP_GROUPS.map(([m, label, short]: [number, string, string]) => {
                const inGroup = chips.filter(c => matchupGroupOf(c.value) === m);
                const over = dragging?.side === side && dragging.over?.dataset.mult === String(m);
                return (
                    <div key={m} className={`type-group-zone mult-${String(m).replace('.', '')}${over ? ' drag-over' : ''}`} data-kind={side} data-mult={m}
                        onClick={() => { if (picked?.side === side) { place(side, picked.key, m); setPicked(null); } }}>
                        <div className="type-group-label"><strong>{short}</strong><span>{label}</span><em>{inGroup.length}</em></div>
                        <div className="type-group-chips">
                            {inGroup.length ? inGroup.map(c => {
                                const isPicked = picked?.side === side && picked.key === c.key;
                                const isDragged = dragging?.side === side && dragging.key === c.key;
                                return (
                                    <button key={c.key} type="button"
                                        className={`type-badge type-group-chip ${c.self ? '' : `type-${c.name.toLowerCase()}`}${isPicked ? ' picked' : ''}${isDragged ? ' dragging' : ''}`}
                                        style={c.self ? selfStyle : undefined} aria-label={`${c.name}${c.self ? ' (itself)' : ''}`}
                                        onPointerDown={e => down(e, side, c)} onClick={e => e.stopPropagation()}>
                                        {c.name}
                                    </button>
                                );
                            }) : <span className="type-group-empty">Drop types here</span>}
                        </div>
                    </div>
                );
            })}
        </section>
    );

    return (
        <>
            <div className="type-group-boards">{board('offense', offense)}{board('defense', defense)}</div>
            {dragging && createPortal(
                <span className={`type-badge type-group-chip type-group-ghost ${dragging.self ? '' : `type-${dragging.name.toLowerCase()}`}`}
                    style={{ left: dragging.x, top: dragging.y, ...(dragging.self ? selfStyle : {}) }}>{dragging.name}</span>,
                document.body
            )}
        </>
    );
}

// ---- the sheet ----

function CustomTypeDialog({ entry, close }: DialogProps<{ entry: any }>) {
    const [draft, setDraftState] = useState<Draft>(() => customTypeDraft(entry));
    const setDraft = (fn: (d: Draft) => Draft) => setDraftState(fn);
    const [regionIds, setRegionIds] = useState<string[]>(() => entry ? entryRegionIds(entry) : [api.defaultRegionForNewFakemon?.()].filter(Boolean));
    const vanillaOf = draft.vanillaOf;
    const bg = typeBackground(draft);
    const selfStyle = { background: bg };
    const title = vanillaOf
        ? `${api.getActiveRegion?.()?.name || 'This region'}'s ${vanillaOf}`
        : entry ? 'Edit custom type' : 'New custom type';

    // the type pickers and chart follow a save; a closed sheet leaves nothing behind
    useEffect(() => () => { document.querySelectorAll('.type-group-ghost').forEach(el => el.remove()); }, []);

    const save = () => {
        const problem = saveCustomTypeDraft(entry, draft, regionIds);
        if (problem) api.showToast?.(problem, 'error');
        else close();
    };
    const remove = async () => { if (await deleteCustomType(entry)) close(); };

    return (
        <Modal onClose={close} className="custom-type-modal" overlayClassName="as-sheet" labelledBy="custom-type-modal-title">
            <div className="modal-header">
                <h3 id="custom-type-modal-title">{title}</h3>
                {/* a region's version belongs to that region by definition */}
                {!vanillaOf && <RegionAssign value={regionIds} onChange={setRegionIds} />}
                <button className="modal-close" type="button" onClick={close} aria-label="Close"><Icon name="x" size={20} /></button>
            </div>
            <div className="custom-type-top">
                <div className="form-group">
                    <label htmlFor="custom-type-name">Name</label>
                    {/* a region's version of Fire is still called Fire */}
                    <input type="text" id="custom-type-name" maxLength={16} placeholder="e.g., Cosmic" value={draft.name} disabled={!!vanillaOf} autoFocus={!vanillaOf}
                        onChange={e => { const name = e.target.value; setDraft(d => ({ ...d, name })); }} />
                </div>
                <span className="type-badge custom-type-preview" style={selfStyle}>{draft.name.trim() || 'Preview'}</span>
            </div>
            <div className="form-group">
                <label>Colour</label>
                <div className="color-options"><FillEditor draft={draft} setDraft={setDraft} /></div>
            </div>
            <div className="form-group">
                <label>Icon <span className="label-optional">(optional; a white symbol on a transparent background looks best)</span></label>
                {/* the icon previews on the type's own colour, where it will actually sit */}
                <ArtField value={draft.icon} onChange={icon => setDraft(d => ({ ...d, icon }))} uploadLabel="Upload icon" previewClassName="type-icon-preview" previewStyle={selfStyle} />
            </div>
            <div className="form-group">
                <label htmlFor="custom-type-desc">Description <span className="label-optional">(optional)</span></label>
                <textarea id="custom-type-desc" rows={2} maxLength={200} placeholder="What this type is about" value={draft.desc} onChange={e => { const desc = e.target.value; setDraft(d => ({ ...d, desc })); }} />
            </div>
            <div className="form-group">
                <label>Matchups</label>
                <p className="custom-type-help">Drag each type into a group, or tap a type and then the group it belongs in.</p>
                <div className="type-matchups"><MatchupBoards draft={{ ...draft, name: draft.name.trim() }} entry={entry} setDraft={setDraft} selfStyle={selfStyle} /></div>
            </div>
            <div className="region-modal-actions custom-type-actions">
                {canDeleteCustomType(entry) && (
                    // a region's version isn't deleted so much as undone
                    <button className="btn btn-secondary region-delete-btn" type="button" onClick={remove}>
                        <Icon name={vanillaOf ? 'rotate-ccw' : 'trash-2'} /><span>{vanillaOf ? 'Use the original' : 'Delete'}</span>
                    </button>
                )}
                <span className="region-modal-spacer" />
                <button className="btn btn-secondary" type="button" onClick={close}>Cancel</button>
                <button className="btn btn-primary" type="button" onClick={save}>Save</button>
            </div>
        </Modal>
    );
}

registerDialog('custom-type', CustomTypeDialog);
