// The dice buttons' suggestion popover (name, species, types, height/weight,
// egg groups): a short list to pick from, and a reroll. Not modal -- it sits
// by the cursor and closes on a click elsewhere, a scroll or a resize, since
// a fixed-position box doesn't follow its anchor. What each dice button
// suggests: js/tools/name-roll.ts and js/tools/field-roll.ts.

import { useLayoutEffect, useRef, useState } from 'react';
import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Icon } from '../components/Icon.tsx';

export interface RollProps<T = any> {
    /** where to put it, in real viewport pixels */
    point: { x: number; y: number };
    title: string;
    generate: () => T[];
    label: (option: T) => string;
    apply: (option: T) => void;
}

// The site scales with CSS `zoom`, which rescales position:fixed offsets too,
// so the box's own pixels and the viewport's differ by every zoom up the tree.
function effectiveZoom(el: Element | null): number {
    let zoom = 1;
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
        const z = parseFloat(getComputedStyle(node).zoom);
        if (!Number.isNaN(z) && z > 0) zoom *= z;
    }
    return zoom;
}

function RollPopover({ close, point, title, generate, label, apply }: DialogProps<RollProps>) {
    const [options, setOptions] = useState(() => generate());
    const box = useRef<HTMLDivElement>(null);

    // placed once (and again after layout settles); it doesn't follow the cursor
    useLayoutEffect(() => {
        const el = box.current;
        if (!el) return;
        const place = () => {
            const zoom = effectiveZoom(el);
            const left = Math.min(Math.max(8, point.x), window.innerWidth - el.offsetWidth * zoom - 8);
            const top = Math.min(Math.max(8, point.y), window.innerHeight - el.offsetHeight * zoom - 8);
            el.style.left = `${left / zoom}px`;
            el.style.top = `${top / zoom}px`;
        };
        place();
        const frame = requestAnimationFrame(place);
        return () => cancelAnimationFrame(frame);
    }, [point.x, point.y, options]);

    useLayoutEffect(() => {
        const away = (e: MouseEvent) => {
            const path = e.composedPath();
            // the dice button toggles it itself
            if (box.current && !path.includes(box.current) && !path.some(n => (n as Element).classList?.contains('name-roll-btn'))) close();
        };
        // a moment later, so the click that opened it doesn't close it
        const timer = setTimeout(() => document.addEventListener('click', away), 0);
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('click', away);
            window.removeEventListener('scroll', close, true);
            window.removeEventListener('resize', close);
        };
    }, [close]);

    return (
        <div className="name-roll-popover" ref={box} style={{ position: 'fixed' }}>
            <div className="name-roll-popover-head">
                <span>{title}</span>
                <button type="button" className="name-roll-reroll" title="Reroll" aria-label="Reroll" onClick={() => setOptions(generate())}>
                    <Icon name="dices" />
                </button>
            </div>
            <div className="name-roll-list">
                {options.map((o, i) => (
                    <button key={i} type="button" className="name-roll-option" onClick={() => { close(); apply(o); }}>{label(o)}</button>
                ))}
            </div>
        </div>
    );
}

registerDialog('roll', RollPopover);
