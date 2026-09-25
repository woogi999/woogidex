// My Collection (/collection): your Fakémon, custom moves, abilities, items
// and types, in folders and regions. The data and actions stay in
// js/features/pokedex.ts (tabs, folders, sorting), regions.ts and
// custom-types.ts; this draws what they hold. A region's details or analytics
// page takes the place of the tabs and grid.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, state } from '../../core/app.ts';
import { getRegionPage, isRegionDrawerOpen, NO_REGION, regionVanillaLibrary, regionVanillaPokemon } from '../../features/regions.ts';
import { Icon } from '../components/Icon.tsx';
import {
    AddCard, FakemonCard, FolderCard, LibraryCard, SkeletonCard, VanillaLibraryCard, VanillaMoreCard, VanillaPokemonCard
} from '../components/collection/cards.tsx';
import { TypeCards, TypesAfter } from '../components/collection/TypesTab.tsx';
import { RegionDetails } from '../components/collection/RegionDetails.tsx';
import { RegionAnalytics } from '../components/collection/RegionAnalytics.tsx';
import { useStore } from '../store.ts';
import type { CollectionTab, LibraryKind } from '../types.ts';
import '../dialogs/collection.tsx';
import '../dialogs/customType.tsx';
import '../dialogs/newFakemon.tsx';

const TABS: Array<[CollectionTab, string]> = [['fakemon', 'Fakémon'], ['moves', 'Moves'], ['abilities', 'Abilities'], ['items', 'Items'], ['types', 'Types']];
const SEARCH_PLACEHOLDER: Record<CollectionTab, string> = {
    fakemon: 'Search your Fakemon...', moves: 'Search your custom moves...', abilities: 'Search your custom abilities...',
    items: 'Search your custom items...', types: 'Search your custom types...'
};

export function CollectionPage() {
    useStore();
    const page = getRegionPage();
    const region = api.getActiveRegion();
    if (page && region) {
        return (
            <section id="region-details" className="region-details">
                {page === 'analytics' ? <RegionAnalytics region={region} /> : <RegionDetails region={region} />}
            </section>
        );
    }
    const ui = api.collectionUI();
    const crumb = api.activeRegionBreadcrumb();
    return (
        <>
            {crumb?.banner && <div className="collection-region-banner" style={{ backgroundImage: `url('${crumb.banner}')` }} />}
            <Header view={ui.view} layout={ui.layout} />
            <div className="tabs collection-tabs" role="tablist" aria-label="Collection view">
                {TABS.map(([key, label]) => (
                    <button key={key} className={`tab${ui.view === key ? ' active' : ''}`} type="button" role="tab" aria-selected={ui.view === key}
                        onClick={() => api.setCollectionView(key)}>{label}</button>
                ))}
            </div>
            <Toolbar view={ui.view} search={ui.search} sort={ui.sort} />
            {!ui.ready ? <SkeletonGrid layout={ui.layout} /> : ui.view === 'types' ? <TypesGrid layout={ui.layout} search={ui.search} /> : <Grid layout={ui.layout} />}
        </>
    );
}

// ---- header: where you are, and what you can do ----

/** A menu under a button, closed by a click anywhere else. */
function useMenu(): [boolean, (open?: boolean) => void, React.RefObject<HTMLDivElement | null>] {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
        document.addEventListener('click', away);
        return () => document.removeEventListener('click', away);
    }, [open]);
    return [open, (next?: boolean) => setOpen(v => next ?? !v), ref];
}

function MenuButton({ className, icon, label, items }: { className: string; icon: string; label: string; items: Array<[string, () => void]> }) {
    const [open, toggle, ref] = useMenu();
    return (
        <div className="export-as-wrap" ref={ref}>
            <button className={`btn ${className}`} type="button" onClick={() => toggle()} aria-expanded={open}><Icon name={icon} /><span>{label}</span></button>
            {open && (
                <div className="export-as-menu" style={{ display: 'block' }}>
                    {items.map(([text, run]) => (
                        <button key={text} className="export-as-menu-item" type="button" onClick={() => { toggle(false); run(); }}>{text}</button>
                    ))}
                </div>
            )}
        </div>
    );
}

function Breadcrumb() {
    const region = api.activeRegionBreadcrumb();
    const folder = state.currentFolderId ? state.folders.find(f => f.id === state.currentFolderId) : null;
    const sep = <span className="breadcrumb-sep" style={{ color: 'var(--text-muted)' }}> / </span>;
    const link = (onClick: () => void, children: ReactNode) => <span className="breadcrumb-root" onClick={onClick} style={{ cursor: 'pointer' }}>{children}</span>;
    if (region) {
        const label = <>{region.color && <span className="region-dot region-dot-lg" style={{ '--region-color': region.color } as React.CSSProperties} />}{region.name}</>;
        return (
            <>
                {link(() => api.selectRegion(null), 'My Collection')}
                {sep}
                {folder
                    ? <>{link(() => api.openFolder(null), label)}{sep}<span className="breadcrumb-current">{folder.name}</span></>
                    : <span className="breadcrumb-current">{label}</span>}
            </>
        );
    }
    if (!state.currentFolderId) return link(() => api.openFolder(null), 'My Collection');
    return <>{link(() => api.openFolder(null), 'My Collection')}{sep}<span className="breadcrumb-current">{folder ? folder.name : 'Folder'}</span></>;
}

function Header({ view, layout }: { view: CollectionTab; layout: 'grid' | 'list' }) {
    const region = api.activeRegionBreadcrumb();
    const activeRegion = api.getActiveRegion();
    const activeId = api.getActiveRegionId();
    const isList = layout === 'list';
    const shiny = !!state.collectionShinyPreview;
    return (
        <div className="page-header" id="collection-header-row">
            <div className="page-heading">
                <h1 className="page-title collection-heading" id="collection-heading"><Breadcrumb /></h1>
                <p className="page-subtitle">{region ? (region.description || 'Everything in this region.') : 'Your Fakémon, folders, and custom moves, abilities and items.'}</p>
            </div>
            <div className="page-actions collection-header-actions">
                {/* phones: the regions sidebar is a drawer, opened from here */}
                <button className="btn btn-secondary collection-regions-btn" id="collection-regions-btn" type="button" onClick={() => api.toggleRegionDrawer()}
                    aria-expanded={isRegionDrawerOpen()} aria-controls="app-sidebar">
                    <Icon name="map" /><span>{activeRegion?.name || (activeId === NO_REGION ? 'No region' : 'All')}</span><Icon name="chevron-down" className="collection-regions-chev" />
                </button>
                <button className="btn btn-secondary btn-icon" type="button" onClick={() => api.toggleCollectionLayout()}
                    title={isList ? 'Switch to grid view' : 'Switch to list view'} aria-label="Toggle list or grid view" aria-pressed={isList}>
                    <Icon name={isList ? 'layout-grid' : 'list'} />
                </button>
                {view === 'fakemon' && (
                    <button className={`btn btn-secondary btn-icon collection-shiny-toggle${shiny ? ' active' : ''}`} id="collection-shiny-toggle" type="button"
                        onClick={() => api.toggleCollectionShinyPreview()} aria-pressed={shiny}
                        title={shiny ? 'Show normal artwork in your collection' : 'Show shiny artwork in your collection'}
                        aria-label={shiny ? 'Show normal artwork in collection' : 'Show shiny artwork in collection'}>
                        <Icon name="sparkles" />
                    </button>
                )}
                <button className="btn btn-secondary" type="button" onClick={() => api.openImportModal()}><Icon name="upload" /><span>Import</span></button>
                <MenuButton className="btn-secondary" icon="download" label={activeRegion ? `Export ${activeRegion.name}` : 'Export'} items={[
                    ['Export as JSON', () => api.exportCollection()],
                    ['Export as Showdown Mod', () => api.exportCollectionAsShowdownMod()],
                    ['Export as Essentials Mod', () => api.exportCollectionAsEssentialsMod()],
                    ['Export as Plain Text (.zip)', () => api.exportCollectionAsPlainTextZip()]
                ]} />
                <MenuButton className="btn-primary" icon="plus" label="Create" items={[
                    ['New Fakémon', () => api.createNewFakemon()],
                    ['New Folder', () => api.createFolder()],
                    ['New Custom Move', () => api.openLibraryEditorSheet('moves')],
                    ['New Custom Ability', () => api.openLibraryEditorSheet('abilities')],
                    ['New Custom Item', () => api.openLibraryEditorSheet('items')],
                    ['New Custom Type', () => api.openLibraryEditorSheet('types')],
                    ['New Region', () => api.createRegion()]
                ]} />
            </div>
        </div>
    );
}

// ---- search and sort ----

function Toolbar({ view, search, sort }: { view: CollectionTab; search: string; sort: { by: string; order: string; options: Array<[string, string]> } }) {
    // the field keeps what's typed itself; the grid follows a moment later
    const [text, setText] = useState(search);
    useEffect(() => { setText(search); }, [search]);
    const orders: Array<[string, string]> = view === 'fakemon' ? [['desc', 'Descending'], ['asc', 'Ascending']] : [['asc', 'Ascending'], ['desc', 'Descending']];
    return (
        <div className="search-bar collection-toolbar">
            <input type="text" id="search-input" placeholder={SEARCH_PLACEHOLDER[view]} value={text}
                onChange={e => { setText(e.target.value); api.setCollectionSearch(e.target.value); }} />
            <select id="collection-sort-by" aria-label="Sort collection by" value={sort.by} onChange={e => api.changeCollectionSort(e.target.value, sort.order)}>
                {sort.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <select id="collection-sort-order" aria-label="Sort direction" value={sort.order} onChange={e => api.changeCollectionSort(sort.by, e.target.value)}>
                {orders.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
        </div>
    );
}

// ---- the grid ----

function gridClass(layout: 'grid' | 'list') {
    return `collection-grid${layout === 'list' ? ' collection-list' : ''}`;
}

function SkeletonGrid({ layout }: { layout: 'grid' | 'list' }) {
    return <div id="collection-grid" className={gridClass(layout)}>{Array.from({ length: 8 }, (_, i) => <SkeletonCard key={i} />)}</div>;
}

function TypesGrid({ layout, search }: { layout: 'grid' | 'list'; search: string }) {
    return (
        <>
            <div id="collection-grid" className={gridClass(layout)} style={{ display: layout === 'list' ? 'flex' : 'grid' }}><TypeCards search={search} /></div>
            <div id="collection-extra"><TypesAfter search={search} /></div>
        </>
    );
}

const EMPTY: Record<string, [string, string, () => void]> = {
    fakemon: ['No Fakemon Found', 'Create Fakemon', () => api.createNewFakemon()],
    moves: ['No custom moves found', 'Create Custom Move', () => api.openLibraryEditorSheet('moves')],
    abilities: ['No custom abilities found', 'Create Custom Ability', () => api.openLibraryEditorSheet('abilities')],
    items: ['No custom items found', 'Create Custom Item', () => api.openLibraryEditorSheet('items')]
};

function ShowAllVanilla({ kind, total }: { kind: string; total: number }) {
    return <VanillaMoreCard total={total} onClick={() => api.showAllRegionVanilla(kind)} />;
}

function Grid({ layout }: { layout: 'grid' | 'list' }) {
    const { kind, search, folders, entries } = api.collectionListing();
    const inFolder = (x: { folderId?: string | null }) => !!x.folderId && !search;
    const vanillaPokemon: any[] = kind === 'fakemon' ? regionVanillaPokemon(search) : [];
    const vanillaLibrary = kind !== 'fakemon' ? regionVanillaLibrary(kind, search) : null;
    const nothing = !entries.length && !folders.length && !vanillaPokemon.length && !vanillaLibrary;
    // an empty collection still gets its "Add new" card; the message is for a search that found nothing
    if (search && nothing) {
        const [title, button, run] = EMPTY[kind];
        return (
            <div id="empty-collection" className="empty-state">
                <div className="icon"><Icon name="sparkles" /></div>
                <h3>{title}</h3>
                <p>Try a different search.</p>
                <button className="btn btn-primary" type="button" onClick={run}><Icon name="plus" />{button}</button>
            </div>
        );
    }
    return (
        <div id="collection-grid" className={gridClass(layout)} style={{ display: layout === 'list' ? 'flex' : 'grid' }}>
            {!search && <AddCard kind={kind} />}
            {folders.map(({ folder, count }: any) => <FolderCard key={folder.id} folder={folder} count={count} kind={kind} />)}
            {kind === 'fakemon'
                ? entries.map((f: any) => <FakemonCard key={f.id} f={f} layout={layout} inFolder={inFolder(f)} />)
                : entries.map((item: any) => <LibraryCard key={item.id} kind={kind as LibraryKind} item={item} inFolder={inFolder(item)} />)}
            {/* the main-game entries a region brings over, after its own */}
            {vanillaPokemon.map(p => <VanillaPokemonCard key={p.id} p={p} layout={layout} />)}
            {vanillaLibrary && vanillaLibrary.shown.map(([id, v]: [string, any]) => <VanillaLibraryCard key={id} kind={kind as LibraryKind} id={id} v={v} />)}
            {vanillaLibrary && vanillaLibrary.shown.length < vanillaLibrary.total && <ShowAllVanilla kind={kind} total={vanillaLibrary.total} />}
        </div>
    );
}
