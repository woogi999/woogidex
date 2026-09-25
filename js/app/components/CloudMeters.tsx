// Usage bars for the limits the server enforces (cloud backup items, regions,
// community uploads). A cap of Infinity shows a count with "unlimited".

import { cloudMeters } from '../../features/cloud-save.ts';

interface Meter { label: string; used: number; max: number; hint: string; }

export function CloudMeters({ items = null, regions = null, className = 'cloud-meters' }: { items?: number | null; regions?: number | null; className?: string }) {
    const meters: Meter[] = cloudMeters(items, regions);
    return (
        <div className={className}>
            {meters.map(m => <MeterBar key={m.label} {...m} />)}
        </div>
    );
}

function MeterBar({ label, used, max, hint }: Meter) {
    if (max === Infinity) {
        return (
            <div className="cloud-meter is-unlimited">
                <div className="cloud-meter-head"><span>{label}</span><span>{used} / unlimited</span></div>
                {hint && <div className="cloud-meter-hint">{hint}</div>}
            </div>
        );
    }
    const pct = Math.min(100, Math.round((used / max) * 100));
    // three bands, so nearing full is visible before it's full
    const tone = used >= max ? ' is-full' : pct >= 80 ? ' is-high' : '';
    return (
        <div className={`cloud-meter${tone}`}>
            <div className="cloud-meter-head"><span>{label}</span><span>{used}/{max}</span></div>
            <div className="cloud-meter-track"><div className="cloud-meter-fill" style={{ width: `${pct}%` }} /></div>
            {hint && <div className="cloud-meter-hint">{hint}</div>}
        </div>
    );
}
