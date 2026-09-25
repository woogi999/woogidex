// Small editor widgets: the type picker, the Pokédex colour swatches, a
// dice button for the rollers, and a click-away hook they share.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { POKEMON_COLORS, SELECTABLE_TYPES } from '../../../core/data.ts';
import { Icon } from '../Icon.tsx';

/** Closes something when a click lands outside `ref`. */
export function useClickAway(open: boolean, close: () => void) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        // the path, not target.contains: a re-render can detach the clicked node (the
        // click that opened it, say) before the event reaches the document
        const away = (e: MouseEvent) => { if (ref.current && !e.composedPath().includes(ref.current)) close(); };
        document.addEventListener('click', away);
        return () => document.removeEventListener('click', away);
    }, [open, close]);
    return ref;
}

export function TypePill({ type }: { type: string }) {
    return <span className={`type-pill type-${type.toLowerCase()}`}>{type}</span>;
}

/** Type 1 / Type 2: a pill menu of every selectable type, custom ones included. */
export function TypeDropdown({ id, value, placeholder, allowNone, onPick }: {
    id: string; value: string; placeholder: string; allowNone?: boolean; onPick: (type: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const ref = useClickAway(open, () => setOpen(false));
    const pick = (type: string) => { setOpen(false); onPick(type); };
    return (
        <div className={`type-dropdown${open ? ' open' : ''}`} id={`${id}-dropdown`} ref={ref}>
            <button className="type-dropdown-trigger" type="button" onClick={() => setOpen(v => !v)} aria-haspopup="listbox" aria-expanded={open}>
                <span className="type-dropdown-value">{value ? <TypePill type={value} /> : placeholder}</span>
                <span className="type-dropdown-arrow"><Icon name="chevron-down" size={12} /></span>
            </button>
            <div className="type-dropdown-menu" role="listbox">
                {allowNone !== false && <div className="type-dropdown-option" role="option" aria-selected={!value} onClick={() => pick('')}><span>None</span></div>}
                {(SELECTABLE_TYPES as string[]).map(t => (
                    <div key={t} className="type-dropdown-option" role="option" aria-selected={t === value} onClick={() => pick(t)}><TypePill type={t} /></div>
                ))}
            </div>
        </div>
    );
}

/** The Pokédex colour, as the games' ten swatches. */
export function ColorSwatchPicker({ value, onPick }: { value: string; onPick: (name: string) => void }) {
    return (
        <div className="color-options" id="color-options">
            {(POKEMON_COLORS as Array<{ name: string; hex: string }>).map(c => (
                <div key={c.name} className={`color-option${c.name === value ? ' selected' : ''}`} style={{ backgroundColor: c.hex }} title={c.name}
                    role="button" tabIndex={0} aria-pressed={c.name === value} aria-label={c.name}
                    onClick={() => onPick(c.name)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(c.name); } }} />
            ))}
        </div>
    );
}

/** The dice button that opens one of the name/type/size rollers (js/tools). */
export function RollButton({ id, title, onRoll, small }: { id: string; title: string; onRoll: (e: React.MouseEvent) => void; small?: boolean }) {
    return (
        <button type="button" id={id} className="name-roll-btn" style={small ? { width: 32, height: 32 } : undefined} title={title} aria-label={title} onClick={onRoll}>
            <Icon name="dices" />
        </button>
    );
}

/** A small heading with a roller on the right, as the Typing and Egg Groups rows have. */
export function RowHeading({ children, roll }: { children: ReactNode; roll?: ReactNode }) {
    return (
        <div className="editor-row-heading">
            <span>{children}</span>
            {roll}
        </div>
    );
}
