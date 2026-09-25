// The cards My Collection's grid is made of: your Fakémon, custom moves,
// abilities and items, folders, the "Add new" tile, skeletons while storage
// loads, and the main-game entries a region brings over. Grid and list
// layouts share the same card; css/collection-cards.css restyles it for
// .collection-list.

import { useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { api, state } from '../../../core/app.ts';
import { Icon } from '../Icon.tsx';
import { closeCardMenus, toggleCardActionsFor, toggleCardExportFor, useCardMenus } from './menus.ts';
import type { CollectionTab, Fakemon, Folder, LibraryKind } from '../../types.ts';

type Layout = 'grid' | 'list';
type Handler = (event: MouseEvent) => void;

// ---- the action row every card has ----

/** One action button; the click never reaches the card underneath. */
export function ActionButton({ icon, title, onClick, className }: { icon: string; title: string; onClick: Handler; className?: string }) {
    return (
        <button type="button" className={className} title={title} aria-label={title}
            onClick={e => { e.stopPropagation(); onClick(e); }}>
            <Icon name={icon} size={14} />
        </button>
    );
}

/** A card's export button, with a menu of formats when there's more than one. */
export function ExportButton({ menuKey, formats }: { menuKey: string; formats: Array<[string, Handler]> }) {
    const { exports } = useCardMenus();
    if (formats.length === 1) {
        return <div className="collection-card-export-wrap"><ActionButton icon="download" title="Export" onClick={formats[0][1]} /></div>;
    }
    return (
        <div className="collection-card-export-wrap">
            <ActionButton icon="download" title="Export" onClick={() => toggleCardExportFor(menuKey)} />
            <div className="collection-card-export-menu" style={{ display: exports === menuKey ? 'block' : 'none' }}>
                {formats.map(([label, run]) => (
                    <button key={label} type="button" onClick={e => { e.stopPropagation(); closeCardMenus(); run(e); }}>{label}</button>
                ))}
            </div>
        </div>
    );
}

/** The row itself; on touch screens it hides behind a "..." button (css/mobile.css). */
export function CardActions({ menuKey, children }: { menuKey: string; children: ReactNode }) {
    const { actions } = useCardMenus();
    return (
        <div className={`card-actions${actions === menuKey ? ' open' : ''}`}>
            <button type="button" className="card-actions-toggle" title="Actions" aria-label="Actions"
                onClick={e => { e.preventDefault(); e.stopPropagation(); toggleCardActionsFor(menuKey); }}>
                <Icon name="more-horizontal" size={16} />
            </button>
            {children}
        </div>
    );
}

/** The card class list: pinned, and lifted above its neighbours while its actions are open. */
function useCardClass(menuKey: string, base: string, pinned?: boolean): string {
    const { actions } = useCardMenus();
    return `${base}${pinned ? ' pinned' : ''}${actions === menuKey ? ' actions-open' : ''}`;
}

const PinButton = ({ pinned, onClick }: { pinned?: boolean; onClick: Handler }) => (
    <ActionButton icon="pin" title={pinned ? 'Unpin' : 'Pin'} className={pinned ? 'pinned-btn' : ''} onClick={onClick} />
);

export function TypeBadge({ type, style }: { type?: string | null; style?: React.CSSProperties }) {
    if (!type) return null;
    return <span className={`type-badge type-${String(type).toLowerCase()}`} style={style}>{type}</span>;
}

// ---- Fakémon ----

function FakemonArt({ f }: { f: Fakemon }) {
    const shiny = state.collectionShinyPreview && f.shinyArtwork;
    const src = shiny ? f.shinyArtwork : f.artwork;
    return src
        ? <img src={src} alt={shiny ? `${f.name} shiny` : f.name} draggable={false} loading="lazy" decoding="async" />
        : <img className="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork" draggable={false} />;
}

function CloudBadge({ f }: { f: Fakemon }) {
    if (!api.isBackedUpToCloud?.(f)) return null;
    return <span className="card-cloud-badge" title="Backed up to your cloud backup"><Icon name="server" size={12} /></span>;
}

const FAKEMON_EXPORTS: Array<[string, string]> = [
    ['Export as PNG', 'exportCollectionFakemonAsPNG'],
    ['Export as Plain Text', 'exportCollectionFakemonAsPlainText'],
    ['Export as JSON', 'exportCollectionFakemonAsJSON'],
    ['Export as Showdown Mod', 'exportCollectionFakemonAsShowdown'],
    ['Export as Essentials Mod', 'exportCollectionFakemonAsEssentials']
];

function FakemonActions({ f, menuKey, inFolder }: { f: Fakemon; menuKey: string; inFolder: boolean }) {
    return (
        <CardActions menuKey={menuKey}>
            <PinButton pinned={f.pinned} onClick={e => api.toggleFakemonPin(f.id, e)} />
            <ActionButton icon="pencil" title="Edit" onClick={() => api.editFakemon(f.id)} />
            {inFolder && <ActionButton icon="folder-output" title="Remove from folder" onClick={e => api.moveFakemonOutOfFolder(f.id, e)} />}
            <ActionButton icon="copy" title="Duplicate" onClick={e => api.duplicateFakemon(f.id, e)} />
            <ActionButton icon="cloud-upload" title="Back up to cloud" onClick={e => api.backupFakemonToCloud(f.id, e)} />
            <ExportButton menuKey={menuKey} formats={FAKEMON_EXPORTS.map(([label, fn]) => [label, e => api[fn](f.id, e)])} />
            <ActionButton icon="trash-2" title="Delete" className="card-delete-btn" onClick={e => api.deleteFakemon(f.id, e)} />
        </CardActions>
    );
}

export function FakemonCard({ f, layout, inFolder }: { f: Fakemon; layout: Layout; inFolder: boolean }) {
    const menuKey = `fakemon:${f.id}`;
    const className = useCardClass(menuKey, `collection-card${layout === 'list' ? ' collection-list-card' : ''}`, f.pinned);
    const bst = api.getFakemonBST(f);
    const drag = {
        draggable: true,
        onDragStart: (e: DragEvent) => api.handleCardDragStart(f.id, e),
        onDragEnd: () => api.handleCardDragEnd()
    };
    const types = <div className="card-types"><TypeBadge type={f.type1} /><TypeBadge type={f.type2} /></div>;
    if (layout === 'list') {
        return (
            <div className={className} {...drag} onClick={() => api.previewFakemon(f.id)}>
                <FakemonActions f={f} menuKey={menuKey} inFolder={inFolder} />
                <div className="card-art"><FakemonArt f={f} /><CloudBadge f={f} /></div>
                <div className="card-number">{f.number || '#???'}</div>
                <div className="card-name">{f.name}</div>
                {types}
                <div className="card-bst" style={{ fontSize: 11, color: 'var(--text-muted)' }}>BST {bst}</div>
            </div>
        );
    }
    const showDate = api.getShowCollectionCardDate?.() !== false;
    return (
        <div className={className} {...drag} onClick={() => api.previewFakemon(f.id)}>
            <FakemonActions f={f} menuKey={menuKey} inFolder={inFolder} />
            <div className="card-art"><FakemonArt f={f} /><CloudBadge f={f} /><span className="card-number">{f.number || '#???'}</span></div>
            <div className="card-body">
                <div className="card-name" title={f.name}>{f.name}</div>
                <div className="card-meta-row">
                    <span className="card-bst"><em>BST</em>{bst}</span>
                    {showDate && <span className="card-date">{new Date(f.createdAt || 0).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>}
                </div>
                {types}
            </div>
        </div>
    );
}

// ---- custom moves, abilities and items ----

const CATEGORY_ICONS: Record<string, string> = { Physical: 'swords', Special: 'sparkle', Status: 'circle-dot' };
const SINGULAR: Record<LibraryKind, string> = { moves: 'move', abilities: 'ability', items: 'item' };

/**
 * A main-game item's emblem: its icon from Showdown's item sprite sheet, found
 * by the item's spritenum. Items without one fall back to Showdown's per-item
 * image, and then to the plain gem.
 */
export function ItemEmblem({ name, item }: { name: string; item?: any }) {
    const [failed, setFailed] = useState(false);
    const data = item || Object.values(state.sdItems || {}).find((i: any) => i.name === name) || null;
    const n = data?.spritenum;
    if (Number.isFinite(n)) {
        // the sheet is 16 icons of 24px a row
        return (
            <span className="library-emblem library-emblem-plain has-item-icon">
                <span className="item-icon-sheet" style={{ backgroundPosition: `${-(n % 16) * 24}px ${-Math.floor(n / 16) * 24}px` }} role="img" aria-label={name} />
            </span>
        );
    }
    const slug = String(name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    return (
        <span className={`library-emblem library-emblem-plain${slug && !failed ? ' has-item-icon' : ''}`}>
            {slug && !failed && <img className="item-icon-sprite" src={`https://play.pokemonshowdown.com/sprites/itemicons/${slug}.png`} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />}
            <Icon name="gem" />
        </span>
    );
}

/** What a move, ability or item card shows; the frame around it is shared. */
function libraryParts(kind: LibraryKind, item: any): { art: ReactNode; corner: string; pills: ReactNode | null; meta: ReactNode } {
    const artImg = item.artwork ? <img src={item.artwork} alt="" draggable={false} loading="lazy" decoding="async" /> : null;
    if (kind === 'moves') {
        const type = String(item.type || 'Normal');
        const category = String(item.category || 'Status');
        const acc = item.accuracy === true || item.accuracy === undefined || item.accuracy === false ? '—' : `${item.accuracy}%`;
        return {
            // the move's own image if it has one; otherwise the type's colour fills
            // the emblem and the category is its icon
            art: artImg || <span className={`library-emblem type-${type.toLowerCase()}`}><Icon name={CATEGORY_ICONS[category] || 'zap'} /></span>,
            corner: category,
            pills: <TypeBadge type={type} />,
            meta: <>
                <span className="card-bst"><em>BP</em>{item.basePower || '—'}</span>
                <span className="card-bst"><em>ACC</em>{acc}</span>
                <span className="card-bst"><em>PP</em>{item.pp || '—'}</span>
            </>
        };
    }
    // no stats to show: the description's first line takes the meta row
    const meta = <span className={`library-tile-desc${item.desc ? '' : ' is-empty'}`}>{item.desc || 'No description'}</span>;
    if (kind === 'items') {
        return {
            // a region's copy of a main-game item keeps the item's own icon
            art: artImg || (item.vanillaId
                ? <ItemEmblem name={state.sdItems?.[item.vanillaId]?.name || item.name} item={state.sdItems?.[item.vanillaId]} />
                : <span className="library-emblem library-emblem-plain"><Icon name="gem" /></span>),
            corner: '',
            pills: <span className="library-tag">{item.isMegaStone ? 'Mega Stone' : 'Item'}</span>,
            meta
        };
    }
    // no badge row for abilities: it only ever said "Ability"
    return { art: artImg || <span className="library-emblem library-emblem-plain"><Icon name="sparkles" /></span>, corner: '', pills: null, meta };
}

/** The shared frame of a library tile (yours or a main-game one). */
function LibraryTile({ className, onClick, title, actions, art, corner, tag, name, meta, pills, drag }: {
    className: string; onClick: () => void; title?: string; actions: ReactNode; art: ReactNode; corner?: string;
    tag?: string; name: string; meta: ReactNode; pills: ReactNode | null; drag?: object;
}) {
    return (
        <div className={className} onClick={onClick} title={title || undefined} {...drag}>
            {actions}
            <div className="card-art">{art}{corner && <span className="card-number library-tile-corner">{corner}</span>}{tag && <span className="vanilla-card-tag">{tag}</span>}</div>
            <div className="card-body">
                <div className="card-name" title={name}>{name}{tag && <span className="vanilla-card-tag vanilla-card-tag-inline">{tag}</span>}</div>
                <div className="card-meta-row">{meta}</div>
                {pills === null
                    // keeps the row's height, so ability cards stay the size of the others
                    ? <div className="card-types card-types-spacer" aria-hidden="true" />
                    : <div className="card-types">{pills}</div>}
            </div>
        </div>
    );
}

export function LibraryCard({ kind, item, inFolder }: { kind: LibraryKind; item: any; inFolder: boolean }) {
    const menuKey = `${kind}:${item.id}`;
    const className = useCardClass(menuKey, 'collection-card library-tile', item.pinned);
    const { art, corner, pills, meta } = libraryParts(kind, item);
    const open = () => api.openLibraryEditorSheet(kind, item.id);
    return (
        <LibraryTile
            className={className} onClick={open}
            // the full description is the tooltip; the tile keeps three lines like a Fakémon card
            title={String(item.desc || '').trim()}
            drag={{ draggable: true, onDragStart: (e: DragEvent) => api.handleLibraryCardDragStart(kind, item.id, e), onDragEnd: () => api.handleCardDragEnd() }}
            art={art} corner={corner} tag={item.vanillaId ? 'Edited' : ''} name={item.name} meta={meta} pills={pills}
            actions={
                <CardActions menuKey={menuKey}>
                    <PinButton pinned={item.pinned} onClick={e => api.toggleCustomLibraryPin(kind, item.id, e)} />
                    <ActionButton icon="pencil" title="Edit" onClick={open} />
                    {inFolder && <ActionButton icon="folder-output" title="Remove from folder" onClick={e => api.moveLibraryItemOutOfFolder(kind, item.id, e)} />}
                    <ActionButton icon="copy" title="Duplicate" onClick={e => api.duplicateCustomLibraryItem(kind, item.id, e)} />
                    <ExportButton menuKey={menuKey} formats={[['Export', () => api.exportCustomLibraryItem(SINGULAR[kind], item.id)]]} />
                    <ActionButton icon="trash-2" title="Delete" className="card-delete-btn" onClick={e => api.deleteCustomLibraryItem(kind, item.id, e)} />
                </CardActions>
            }
        />
    );
}

// ---- folders ----

const FOLDER_NOUN: Record<string, [string, string]> = {
    fakemon: ['Fakemon', 'Fakemon'], moves: ['Move', 'Moves'], abilities: ['Ability', 'Abilities'], items: ['Item', 'Items']
};

export function FolderCard({ folder, count, kind }: { folder: Folder; count: number; kind: CollectionTab }) {
    const menuKey = `folder:${folder.id}`;
    const [over, setOver] = useState(false);
    const className = useCardClass(menuKey, `collection-card folder-card${over ? ' drag-over' : ''}`, folder.pinned);
    const color = folder.color || null;
    const [one, many] = FOLDER_NOUN[kind] || FOLDER_NOUN.fakemon;
    return (
        <div className={className}
            style={color ? { borderColor: color, background: `color-mix(in srgb, ${color} 10%, var(--bg-panel))` } : undefined}
            onClick={() => api.openFolder(folder.id)}
            onDragOver={e => { e.preventDefault(); if (!over) setOver(true); }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
            onDrop={e => { setOver(false); api.dropOnFolder(folder.id, e); }}>
            <CardActions menuKey={menuKey}>
                <PinButton pinned={folder.pinned} onClick={e => api.toggleFolderPin(folder.id, e)} />
                <ActionButton icon="pencil" title="Rename / Color" onClick={e => api.renameFolder(folder.id, e)} />
                <ActionButton icon="trash-2" title="Delete" className="card-delete-btn" onClick={e => api.deleteFolder(folder.id, e)} />
            </CardActions>
            <div className="card-art folder-card-art" style={color ? { color } : undefined}><Icon name="folder" size={48} /></div>
            <div className="card-body">
                <div className="card-name">{folder.name}</div>
                <div className="card-bst">{count} {count === 1 ? one : many}</div>
            </div>
        </div>
    );
}

// ---- the first tile, and the loading state ----

const ADD_NEW: Record<CollectionTab, [string, () => void]> = {
    fakemon: ['Fakémon', () => api.createNewFakemon()],
    moves: ['move', () => api.openLibraryEditorSheet('moves')],
    abilities: ['ability', () => api.openLibraryEditorSheet('abilities')],
    items: ['item', () => api.openLibraryEditorSheet('items')],
    types: ['type', () => api.openLibraryEditorSheet('types')]
};

/** "Add new ...": the same action as the Create menu's matching item. */
export function AddCard({ kind }: { kind: CollectionTab }) {
    const [label, run] = ADD_NEW[kind];
    return (
        <button type="button" className="collection-card collection-add-card" onClick={run}>
            <span className="card-art"><span className="collection-add-icon"><Icon name="plus" /></span></span>
            <span className="card-body"><span className="card-name">Add new {label}</span></span>
        </button>
    );
}

/** The real card's shape, so the first paint has no layout shift once the cards arrive. */
export function SkeletonCard() {
    return (
        <div className="collection-card skel-card">
            <div className="card-art skel" />
            <div className="card-body">
                <div className="skel skel-text skel-name" />
                <div className="skel skel-text skel-bst" />
                <div className="card-types"><span className="skel skel-pill" /><span className="skel skel-pill" /></div>
            </div>
        </div>
    );
}

// ---- what a region brings over from the main games ----

type VanillaKind = 'pokemon' | LibraryKind;
const POKEMON_EXPORTS: Array<[string, string]> = [['png', 'PNG'], ['text', 'Plain Text'], ['json', 'JSON'], ['showdown', 'Showdown Mod'], ['essentials', 'Essentials Mod']];

function VanillaActions({ kind, id, menuKey }: { kind: VanillaKind; id: string; menuKey: string }) {
    const pinned = api.isVanillaPinned(kind, id);
    const pokemon = kind === 'pokemon';
    return (
        <CardActions menuKey={menuKey}>
            <PinButton pinned={pinned} onClick={e => api.toggleVanillaPin(kind, id, e)} />
            <ActionButton icon="pencil" title="Edit" onClick={() => pokemon ? api.editVanillaPokemonInRegion(id) : api.editVanillaInRegion(kind, id)} />
            <ActionButton icon="copy" title="Duplicate" onClick={e => pokemon ? api.duplicateVanillaPokemon(id, e) : api.duplicateVanillaEntry(kind, id, e)} />
            <ExportButton menuKey={menuKey} formats={pokemon
                ? POKEMON_EXPORTS.map(([format, label]) => [`Export as ${label}`, e => api.exportVanillaPokemon(id, format, e)])
                : [['Export', e => api.exportVanillaEntry(kind, id, e)]]} />
            <ActionButton icon="trash-2" title="Remove from region" className="card-delete-btn" onClick={e => api.removeVanillaFromRegion(kind, id, e)} />
        </CardActions>
    );
}

export function VanillaPokemonCard({ p, layout }: { p: any; layout: Layout }) {
    const menuKey = `vanilla-pokemon:${p.id}`;
    const className = useCardClass(menuKey, `collection-card vanilla-card${layout === 'list' ? ' collection-list-card' : ''}`, api.isVanillaPinned('pokemon', p.id));
    const sprite = api.getPokemonTemplateSprite?.(p) || '';
    const art = sprite ? <img src={sprite} alt={p.name} loading="lazy" decoding="async" /> : null;
    const number = `#${String(p.num).padStart(3, '0')}`;
    const bst = Object.values(p.stats || {}).reduce((a: number, b: any) => a + Number(b || 0), 0);
    const types = <div className="card-types">{(p.types || []).map((t: string) => <TypeBadge key={t} type={t} />)}</div>;
    const open = () => api.previewVanillaPokemonInRegion(p.id);
    if (layout === 'list') {
        return (
            <div className={className} onClick={open} title={p.name}>
                <VanillaActions kind="pokemon" id={p.id} menuKey={menuKey} />
                <div className="card-art">{art}</div>
                <div className="card-number">{number}</div>
                <div className="card-name">{p.name} <span className="vanilla-card-tag vanilla-card-tag-inline">Main games</span></div>
                {types}
                <div className="card-bst" style={{ fontSize: 11, color: 'var(--text-muted)' }}>BST {bst}</div>
            </div>
        );
    }
    return (
        <div className={className} onClick={open} title={p.name}>
            <VanillaActions kind="pokemon" id={p.id} menuKey={menuKey} />
            <div className="card-art">{art}<span className="card-number">{number}</span><span className="vanilla-card-tag">Main games</span></div>
            <div className="card-body"><div className="card-name">{p.name}</div><div className="card-meta-row"><span className="card-bst"><em>BST</em>{bst}</span></div>{types}</div>
        </div>
    );
}

export function VanillaLibraryCard({ kind, id, v }: { kind: LibraryKind; id: string; v: any }) {
    const menuKey = `vanilla-${kind}:${id}`;
    const className = useCardClass(menuKey, 'collection-card library-tile vanilla-card', api.isVanillaPinned(kind, id));
    let art: ReactNode, corner = '', meta: ReactNode, pills: ReactNode | null;
    if (kind === 'moves') {
        const type = String(v.type || 'Normal');
        art = <span className={`library-emblem type-${type.toLowerCase()}`}><Icon name={CATEGORY_ICONS[v.category] || 'zap'} /></span>;
        corner = v.category || '';
        const acc = v.accuracy === true ? '—' : `${v.accuracy}%`;
        meta = <><span className="card-bst"><em>BP</em>{v.basePower || '—'}</span><span className="card-bst"><em>ACC</em>{acc}</span><span className="card-bst"><em>PP</em>{v.pp || '—'}</span></>;
        pills = <TypeBadge type={type} />;
    } else {
        art = kind === 'items' ? <ItemEmblem name={v.name || id} item={v} /> : <span className="library-emblem library-emblem-plain"><Icon name="sparkles" /></span>;
        meta = <span className="library-tile-desc">{v.desc || 'No description'}</span>;
        pills = kind === 'items' ? <span className="library-tag">Item</span> : null;
    }
    return (
        <LibraryTile className={className} onClick={() => api.editVanillaInRegion(kind, id)} title={v.desc || v.name || id}
            art={art} corner={corner} tag="Main games" name={v.name || id} meta={meta} pills={pills}
            actions={<VanillaActions kind={kind} id={id} menuKey={menuKey} />} />
    );
}

/** "Show all": the main-game list starts with its first page. */
export function VanillaMoreCard({ total, onClick }: { total: number; onClick: () => void }) {
    return (
        <button type="button" className="collection-card vanilla-more-card" onClick={onClick}>
            <span className="card-art"><span className="collection-add-icon"><Icon name="chevron-down" /></span></span>
            <span className="card-body"><span className="card-name">Show all {total}</span><span className="library-tile-desc">From the main games</span></span>
        </button>
    );
}
