// "Add to region": the button in an editor's header that puts what's being
// edited into any number of regions. The React editors use this; the legacy
// ones still use the hidden-<select> version in js/features/regions.ts.

import { useEffect, useRef, useState } from 'react';
import { api } from '../../core/app.ts';
import { REGION_COLORS } from '../../features/regions.ts';
import { Icon } from './Icon.tsx';
import { useStore } from '../store.ts';

export function RegionAssign({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
    useStore();
    const [open, setOpen] = useState(false);
    const wrap = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
        document.addEventListener('mousedown', away, true);
        return () => document.removeEventListener('mousedown', away, true);
    }, [open]);

    const regions: any[] = api.getRegions();
    // regions deleted meanwhile drop out
    const chosen = value.filter(id => regions.some(r => String(r.id) === String(id)));
    const first = regions.find(r => String(r.id) === String(chosen[0]));
    const label = chosen.length > 1 ? `${chosen.length} regions` : first?.name || 'Add to region';
    const toggle = (id: string) => onChange(chosen.includes(id) ? chosen.filter(x => x !== id) : [...chosen, id]);

    return (
        <div className="region-assign" ref={wrap}>
            <button type="button" className={`btn btn-secondary btn-sm region-assign-btn${chosen.length ? ' has-region' : ''}`}
                style={{ '--region-color': first?.color || 'transparent' } as React.CSSProperties}
                title={regions.filter(r => chosen.includes(String(r.id))).map(r => r.name).join(', ')}
                aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(v => !v)}>
                <Icon name="map" /><span className="region-assign-label">{label}</span>
            </button>
            {open && (
                <div className="region-assign-menu" role="menu">
                    <div className="region-assign-title">Regions <small>pick any number</small></div>
                    {regions.map(r => {
                        const on = chosen.includes(String(r.id));
                        return (
                            <button key={r.id} type="button" className={`region-assign-item${on ? ' on' : ''}`} role="menuitemcheckbox" aria-checked={on} onClick={() => toggle(String(r.id))}>
                                <span className="region-dot" style={{ '--region-color': r.color || REGION_COLORS[0] } as React.CSSProperties} />
                                <span>{r.name}</span>{on && <Icon name="check" className="region-assign-check" />}
                            </button>
                        );
                    })}
                    <button type="button" className={`region-assign-item${chosen.length ? '' : ' on'}`} role="menuitemcheckbox" aria-checked={!chosen.length} onClick={() => onChange([])}>
                        <Icon name="circle-dashed" /><span>No region</span>{!chosen.length && <Icon name="check" className="region-assign-check" />}
                    </button>
                    <div className="region-assign-divider" />
                    <button type="button" className="region-assign-item" onClick={() => { setOpen(false); api.createRegion(); }}>
                        <Icon name="plus" /><span>New region</span>
                    </button>
                </div>
            )}
        </div>
    );
}
