// My Collection's side column: the region list and the way to make one. Only
// shown on that page (body[data-page], set by activateTopLevelView() in
// js/core/app.ts); on phones it's a drawer, with a backdrop dimming the page.

import { createPortal } from 'react-dom';
import { api } from '../../core/app.ts';
import { Icon } from '../components/Icon.tsx';
import { RegionSidebar } from '../components/collection/RegionSidebar.tsx';

export function Sidebar() {
    return (
        <>
            {createPortal(<div className="region-drawer-backdrop" onClick={() => api.closeRegionDrawer()} />, document.body)}
            <div className="sidebar-section-head">
                <span className="sidebar-section-label">Regions</span>
                <button className="sidebar-section-add" type="button" onClick={() => api.createRegion()} title="New region" aria-label="New region"><Icon name="plus" /></button>
            </div>
            <nav className="region-list" id="region-list" aria-label="Regions"><RegionSidebar /></nav>
            <button className="btn btn-secondary region-new-btn" type="button" onClick={() => api.createRegion()}><Icon name="map-plus" />New region</button>
            <button className="btn btn-secondary region-drawer-close" type="button" onClick={() => api.closeRegionDrawer()}>Close</button>
        </>
    );
}
