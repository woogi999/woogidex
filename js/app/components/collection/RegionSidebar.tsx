// The region list in My Collection's sidebar (#region-list): All, each region
// (with the way into its details and analytics under the one you're in), and
// No region. Dropping a collection card on a region puts the card in it.

import { useState, type ReactNode } from 'react';
import { api, state } from '../../../core/app.ts';
import { NO_REGION, REGION_COLORS, countIn, getRegionPage } from '../../../features/regions.ts';
import { Icon } from '../Icon.tsx';
import { useStore } from '../../store.ts';

function Row({ id, name, mark, count, active, editable, droppable }: {
    id: string | null; name: string; mark: ReactNode; count: number; active: boolean; editable?: boolean; droppable?: boolean;
}) {
    const [over, setOver] = useState(false);
    const drop = droppable ? {
        onDragOver: (e: React.DragEvent) => {
            if (!api.isDraggingCard()) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (!over) setOver(true);
        },
        onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); },
        onDrop: (e: React.DragEvent) => { setOver(false); api.dropOnRegion(id, e); }
    } : {};
    return (
        <div className={`region-row${active ? ' active' : ''}${over ? ' drag-over' : ''}`} {...drop}>
            <button type="button" className="region-row-main" onClick={() => api.selectRegion(id)} aria-current={active || undefined}>
                {mark}<span className="region-row-name">{name}</span><span className="region-row-count">{count}</span>
            </button>
            {editable && (
                <button type="button" className="region-row-edit" onClick={() => api.openRegionDetails(id)} title={`${name} details`} aria-label={`${name} details`}>
                    <Icon name="settings-2" />
                </button>
            )}
        </div>
    );
}

const Dot = ({ color }: { color: string }) => <span className="region-dot" style={{ '--region-color': color } as React.CSSProperties} />;

export function RegionSidebar() {
    useStore();
    const active = api.getActiveRegionId();
    const page = getRegionPage();
    const regions: any[] = api.getRegions();
    return (
        <>
            <Row id={null} name="All" mark={<Icon name="layout-grid" />} count={(state.fakemonDB || []).filter(f => !f.pendingVanilla).length} active={!active} />
            {regions.map(r => {
                const isActive = active === r.id;
                return (
                    <div key={r.id} style={{ display: 'contents' }}>
                        <Row id={r.id} name={r.name} mark={<Dot color={r.color || REGION_COLORS[0]} />} count={countIn(r.id)} active={isActive && !page} editable droppable />
                        {/* the way into a region's own pages, under the region you're in */}
                        {isActive && (
                            <>
                                <button type="button" className={`region-subrow${page === 'details' ? ' active' : ''}`} onClick={() => api.openRegionDetails()}><Icon name="book-open" /><span>Region details</span></button>
                                <button type="button" className={`region-subrow${page === 'analytics' ? ' active' : ''}`} onClick={() => api.openRegionAnalytics()}><Icon name="chart-bar" /><span>Analytics</span></button>
                            </>
                        )}
                    </div>
                );
            })}
            {regions.length > 0 && (
                <Row id={NO_REGION} name="No region" mark={<Icon name="circle-dashed" />} count={countIn(NO_REGION)} active={active === NO_REGION} droppable />
            )}
        </>
    );
}
