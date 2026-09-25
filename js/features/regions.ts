// ==================== regions ====================
// A region is a Fakedex project: Kanto, Galar, or whatever you are building.
// It holds your own Fakemon, custom moves, abilities, items and custom types
// (each has regionIds -- it can be in several -- with regionId kept as the
// first of them for older saves), plus a choice of what it brings over from the main
// games -- vanilla Pokemon, moves, items, abilities and types. By default
// that is no Pokemon, and the latest National Dex for the rest.
//
// In My Collection's sidebar: pick a region to see only what is in it; drag a
// Fakemon onto one to move it there; open Region details for its name,
// tagline, banner, bio, what it brings over, and to export it on its own.
// With a region picked, the collection's Export menu exports just that region.
//
// Storage: a region is an entry in state.folders with type 'region'. That
// list already travels with every local save, JSON export/import (ids are
// remapped) and cloud backup, so regions get all three without a new table
// or column. Folder views only ever list their own types, so a region never
// shows up as a folder.

import { log } from '../core/log.ts';
import { state, api } from '../core/app.ts';
import { confirmDialog } from '../core/confirm-dialog.ts';
import { esc } from '../core/html.ts';
import { POKEMON_TYPES } from '../core/data.ts';
import { notify } from '../app/store.ts';
import type { Region } from '../app/types.ts';
import { openDialog } from '../app/dialogs.tsx';
import { MOVE_FLAG_OPTIONS } from '../editor/learnset-model.ts';

export const REGION_TYPE = 'region' as const;
const ACTIVE_KEY = 'woogidex.collection.region.v1';
/** "Things in no region": a filter, not a region. */
export const NO_REGION = '__none';

export const REGION_COLORS = ['#7c5cff', '#e2574c', '#f09a36', '#e6c229', '#3fae5a', '#2bb3a8', '#3b82f6', '#c056d8', '#8a8f9c'];
// the 18, plus ??? (typeless) and Stellar (Tera), which are neutral both ways
const VANILLA_TYPES = [...POKEMON_TYPES.slice(0, 18), '???', 'Stellar'];

// ---- what a region brings over from the main games ----
export const POOL_KINDS = ['pokemon', 'moves', 'items', 'abilities', 'types'];
export const POOL_LABEL = { pokemon: 'Pokémon', moves: 'Moves', items: 'Items', abilities: 'Abilities', types: 'Types' };
export const POOL_ICON = { pokemon: 'paw-print', moves: 'zap', items: 'gem', abilities: 'sparkles', types: 'shapes' };
export const DEFAULT_POOLS = { pokemon: 'none', moves: 'natdex', items: 'natdex', abilities: 'natdex', types: 'natdex' };
// Showdown's markers for things outside the National Dex
const NOT_NATDEX = new Set(['CAP', 'LGPE', 'Custom', 'Future', 'Pokestar', 'Gigantamax', 'Unobtainable']);

/** Every id the latest National Dex has, for one kind. */
export function natdexEntries(kind) {
    if (kind === 'types') return VANILLA_TYPES.map(t => [t, { name: t }]);
    const source = { pokemon: state.sdPokedex, moves: state.sdMoves, items: state.sdItems, abilities: state.sdAbilities }[kind] || {};
    return Object.entries<any>(source).filter(([, v]) => {
        if (!v || NOT_NATDEX.has(v.nonstandard)) return false;
        if (kind === 'pokemon') return v.num > 0 && !/Gmax|Totem/.test(v.forme || '');
        if (kind === 'moves') return !v.isZ && !v.isMax;
        if (kind === 'abilities') return (v.num ?? 1) > 0;
        return true;
    });
}

export function poolOf(region, kind) {
    const p = region?.vanilla?.[kind];
    return { mode: p?.mode || DEFAULT_POOLS[kind], ids: Array.isArray(p?.ids) ? p.ids : [] };
}

/** The vanilla ids a region brings over, for one kind. */
export function regionPoolIds(region, kind) {
    const { mode, ids } = poolOf(region, kind);
    if (mode === 'none') return [];
    if (mode === 'custom') return ids.slice();
    return natdexEntries(kind).map(([id]: any[]) => id);
}

export function poolSummary(region, kind) {
    const { mode, ids } = poolOf(region, kind);
    if (mode === 'none') return 'None';
    if (mode === 'custom') return `${ids.length} chosen`;
    const n = natdexEntries(kind).length;
    return n ? `National Dex (${n})` : 'National Dex';
}

// ---- reading ----
export function getRegions() {
    return (state.folders || []).filter(f => f && f.type === REGION_TYPE)
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function regionById(id) {
    return getRegions().find(r => String(r.id) === String(id)) || null;
}

let activeRegionId = (() => {
    try { return localStorage.getItem(ACTIVE_KEY) || null; } catch { return null; }
})();
// a region's own page, when one is open: 'details' or 'analytics'
let regionPage: any = null;

/** The region page showing instead of the grid: 'details', 'analytics' or null. */
export function getRegionPage() {
    return getActiveRegion() ? regionPage : null;
}

/** The region the collection is filtered to: an id, NO_REGION, or null for all. */
export function getActiveRegionId() {
    if (activeRegionId && activeRegionId !== NO_REGION && !regionById(activeRegionId)) activeRegionId = null;
    return activeRegionId;
}

/** The active region's record, or null (also null for "No region"). */
export function getActiveRegion() {
    const id = getActiveRegionId();
    return id && id !== NO_REGION ? regionById(id) : null;
}

/**
 * The regions an entry (Fakemon, move, ability, item, type or folder) is in.
 * Older saves only have regionId; newer ones have regionIds, with regionId
 * mirroring the first so anything that reads one region still works.
 */
export function entryRegionIds(entry): string[] {
    if (!entry) return [];
    const ids = Array.isArray(entry.regionIds) ? entry.regionIds : (entry.regionId ? [entry.regionId] : []);
    return [...new Set<string>(ids.filter(Boolean).map(String))];
}

/** Sets an entry's regions, keeping regionId in step. */
export function setEntryRegionIds(entry, ids) {
    if (!entry) return;
    const clean = [...new Set((ids || []).filter(Boolean).map(String))];
    entry.regionIds = clean;
    entry.regionId = clean[0] || null;
}

/** @returns whether the entry is in that region (NO_REGION: in none that exists) */
export function entryInRegion(entry, regionId): boolean {
    const ids = entryRegionIds(entry);
    if (regionId === NO_REGION) return !ids.some(id => regionById(id));
    return ids.includes(String(regionId));
}

/** @returns whether this Fakemon / move / ability / item / type / folder shows under the active region */
export function entryInActiveRegion(entry): boolean {
    const active = getActiveRegionId();
    if (!active) return true;
    return entryInRegion(entry, active);
}
// the name pokedex.ts already calls
export const fakemonInActiveRegion = entryInActiveRegion;

/** How many of your Fakémon are in a region (or, for NO_REGION, in none). */
export function countIn(regionId) {
    return (state.fakemonDB || []).filter(f => !f.pendingVanilla && entryInRegion(f, regionId)).length;
}

// ---- choosing ----
export function selectRegion(id) {
    activeRegionId = id || null;
    regionPage = null;
    try {
        if (activeRegionId) localStorage.setItem(ACTIVE_KEY, activeRegionId);
        else localStorage.removeItem(ACTIVE_KEY);
    } catch { /* private mode: the choice just isn't remembered */ }
    state.currentFolderId = null;
    closeRegionDrawer();
    api.renderCollection?.();
    renderRegionSidebar();
}

export function isRegionDetailsOpen() {
    return !!regionPage && !!getActiveRegion();
}

function openRegionPage(page, id) {
    if (id) activeRegionId = id;
    if (!getActiveRegion()) return;
    try { localStorage.setItem(ACTIVE_KEY, String(activeRegionId)); } catch { /* not remembered */ }
    regionPage = page;
    closeRegionDrawer();
    // National Dex counts and main-game Pokemon need the Showdown data
    if (!state.sdLoaded) api.fetchShowdownData?.().then(() => { if (regionPage) notify(); });
    api.renderCollection?.();
    renderRegionSidebar();
    window.scrollTo({ top: 0 });
}

export function openRegionDetails(id: any = null) { openRegionPage('details', id); }
export function openRegionAnalytics(id: any = null) { openRegionPage('analytics', id); }

export function closeRegionDetails() {
    regionPage = null;
    api.renderCollection?.();
    renderRegionSidebar();
}

// ---- the phone drawer ----
export function toggleRegionDrawer(force) {
    const open = force ?? !document.body.classList.contains('region-drawer-open');
    document.body.classList.toggle('region-drawer-open', open);
    notify();
}
export function closeRegionDrawer() { toggleRegionDrawer(false); }
export function isRegionDrawerOpen() { return document.body.classList.contains('region-drawer-open'); }

// ---- creating ----
export function createRegion() {
    closeRegionDrawer();
    openDialog('region-create', { color: REGION_COLORS[getRegions().length % REGION_COLORS.length] });
}

function nameClash(name, exceptId: any = null) {
    return getRegions().find(r => r.id !== exceptId && String(r.name).trim().toLowerCase() === name.toLowerCase());
}

/**
 * Makes a region from the New region dialog and switches to it.
 * @returns a problem to show, or '' once it's made
 */
export function createRegionFrom({ name = '', tagline = '', color = REGION_COLORS[0], pools = {} }: { name?: any; tagline?: any; color?: any; pools?: any }): string {
    name = String(name).trim();
    tagline = String(tagline).trim();
    if (!name) return 'Give the region a name first.';
    const clash = nameClash(name);
    if (clash) return `You already have a region called ${clash.name}.`;
    const vanilla: Record<string, any> = {};
    for (const kind of POOL_KINDS) vanilla[kind] = { mode: pools[kind] || DEFAULT_POOLS[kind], ids: [] as any[] };
    const region: Region = {
        id: `region_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        type: REGION_TYPE, name, tagline, bio: '', banner: '', color, vanilla, createdAt: Date.now()
    };
    state.folders = [...(state.folders || []), region];
    log.info('REGIONS', 'Created a region', { name });
    api.saveToStorage?.();
    selectRegion(region.id);
    api.showToast?.(`${name} created. Open Region details to add a banner and bio.`, 'success');
    return '';
}

export async function deleteActiveRegion() {
    const region = getActiveRegion();
    if (!region) return;
    const count = countIn(region.id);
    const confirmFirst = api.getConfirmBeforeDelete?.() !== false;
    if (confirmFirst && !await confirmDialog({ title: `Delete the region “${region.name}”?`, message: `${count ? `Its ${count} Fakémon stay in your collection, just without this region. ` : ''}Its moves, abilities, items and types stay too.` })) return;
    const lists = [state.fakemonDB, state.customMoves, state.customAbilities, state.customItems, state.folders];
    lists.forEach(list => (list || []).forEach(x => { if (x && entryInRegion(x, region.id)) setEntryRegionIds(x, entryRegionIds(x).filter(id => id !== String(region.id))); }));
    state.folders = (state.folders || []).filter(f => f !== region);
    activeRegionId = null;
    regionPage = null;
    api.saveToStorage?.();
    selectRegion(null);
    api.showToast?.(`Deleted ${region.name}.`, 'info');
}

// ---- moving things between regions ----
function listFor(kind) {
    return kind === 'moves' ? state.customMoves : kind === 'abilities' ? state.customAbilities : kind === 'items' ? state.customItems : state.fakemonDB;
}

// Dropping onto a region adds it (an entry can be in several); dropping onto
// "No region" takes it out of all of them.
export function setEntryRegion(kind, entryId, regionId) {
    const entry = (listFor(kind) || []).find(x => String(x.id) === String(entryId));
    if (!entry) return;
    const target = regionId === NO_REGION ? null : (regionById(regionId)?.id || null);
    const current = entryRegionIds(entry);
    if (target ? current.includes(String(target)) : !current.length) return;
    setEntryRegionIds(entry, target ? [...current, target] : []);
    entry.updatedAt = Date.now();
    api.saveToStorage?.();
    renderRegionSidebar();
    api.renderCollection?.();
    api.showToast?.(target ? `${entry.name} is now in ${regionById(target)?.name}.` : `${entry.name} no longer has a region.`, 'success');
}
export function setFakemonRegion(fakemonId, regionId) { setEntryRegion('fakemon', fakemonId, regionId); }

/** Whether a collection card is being dragged (the sidebar's rows accept one). */
export function isDraggingCard() {
    return !!(api.getDraggedFakemonId?.() || api.getDraggedLibraryItem?.());
}

/** A card let go over a sidebar row. */
export function dropOnRegion(regionId, event) {
    event.preventDefault();
    const lib = api.getDraggedLibraryItem?.();
    if (lib) setEntryRegion(lib.kind, lib.id, regionId);
    else {
        const id = api.getDraggedFakemonId?.() || event.dataTransfer?.getData('text/plain');
        if (id) setEntryRegion('fakemon', id, regionId);
    }
    api.handleCardDragEnd?.();
}

// ---- the sidebar ----
// The rows themselves are js/app/components/collection/RegionSidebar.tsx.
export function renderRegionSidebar() {
    // css/regions.css and custom-types.ts key a region's own type colours off this
    const active = getActiveRegion();
    if (active) document.body.dataset.activeRegion = active.id;
    else delete document.body.dataset.activeRegion;
    notify();
}

/** New things start in the region you're looking at. */
export function defaultRegionForNewFakemon() {
    return getActiveRegion()?.id || null;
}

/** The heading line under "My Collection": the region's colour, name and tagline. */
export function activeRegionBreadcrumb() {
    const active = getActiveRegionId();
    if (!active) return null;
    if (active === NO_REGION) return { name: 'No region', color: '', description: 'Things that are not in any region yet.' };
    const r = regionById(active);
    return r ? { name: r.name, color: r.color || '', description: r.tagline || r.description || '', banner: r.banner || '' } : null;
}

// ---- in the collection tabs ----
const VANILLA_PAGE = 48;              // main-game cards shown before "Show all"
const showAllVanilla: Record<string, any> = {};            // kind -> true once "Show all" was pressed
const CATEGORY_ICON = { Physical: 'swords', Special: 'sparkle', Status: 'circle-dot' };

function vanillaSource(kind) {
    return { moves: state.sdMoves, items: state.sdItems, abilities: state.sdAbilities }[kind] || {};
}

// A region's copy of a main-game entry starts out *pending*: it exists so the
// editor has something to open, but it isn't the region's own version until a
// save actually changes something. Pending copies never reach storage (see
// saveToStorage) and don't show as "Edited" -- the main-game card stays put.
function anyCopy(kind, vanillaId, region) {
    return (listFor(kind) || []).find(x => x.vanillaId === vanillaId && String(x.regionId || '') === String(region.id)) || null;
}

/** The region's own edited copy of a main-game entry, if it has one. */
function editedCopy(kind, vanillaId, region) {
    const copy = anyCopy(kind, vanillaId, region);
    return copy && !copy.pendingVanilla ? copy : null;
}

/** Whether an entry is a region copy nobody has changed yet. */
export function isPendingVanilla(entry) {
    return !!entry?.pendingVanilla;
}

// what a fresh copy of a main-game entry looks like, before any edits
function vanillaBaseCopy(kind, id, v, regionId) {
    const base = { name: v.name || id, desc: v.desc || '', vanillaId: id, regionId, source: 'custom', custom: true };
    if (kind === 'moves') {
        return {
            ...base,
            type: v.type || 'Normal', category: v.category || 'Status',
            basePower: v.basePower || 0, accuracy: v.accuracy === true ? 100 : (v.accuracy || 100),
            pp: v.pp || 10, priority: v.priority || 0, flags: { ...(v.flags || {}) }
        };
    }
    if (kind === 'items') return { ...base, artwork: '', isMegaStone: false };
    return base;
}

// battle code only counts once there is some: an empty board is the default
function blockSignature(blocks) {
    if (!blocks) return '';
    const n = (blocks.triggers || []).reduce((sum, t) => sum + (t?.body?.length || 0), 0) + (blocks.loose?.length || 0);
    return n ? JSON.stringify(blocks) : '';
}

// the flags the move form can set; anything else can't have been edited there
function editableMoveFlags() {
    return MOVE_FLAG_OPTIONS.map(([flag]) => flag);
}

function copySignature(kind, x) {
    const common = [x.name || '', String(x.desc || '').trim(), x.artwork || '', x.rawCode || '', blockSignature(x.blocks), x.regionId || ''];
    if (kind === 'moves') {
        const keys = editableMoveFlags() || Object.keys(x.flags || {});
        const flags = keys.filter(k => x.flags?.[k]).sort().join(',');
        return JSON.stringify([...common, x.type, x.category, Number(x.basePower) || 0, Number(x.accuracy) || 0, Number(x.pp) || 0, Number(x.priority) || 0, flags]);
    }
    if (kind === 'items') return JSON.stringify([...common, !!x.isMegaStone]);
    return JSON.stringify(common);
}

/**
 * Called by the move / ability / item editors (and the block editor) after a
 * save: a region copy that now matches the original goes back to pending, one
 * that differs becomes the region's own version.
 * @returns whether the entry is (still) unedited
 */
export function settleVanillaCopy(kind, entry): boolean {
    if (!entry?.vanillaId) return false;
    const v = vanillaSource(kind)[entry.vanillaId];
    if (!v) { delete entry.pendingVanilla; return false; }
    const unchanged = copySignature(kind, entry) === copySignature(kind, vanillaBaseCopy(kind, entry.vanillaId, v, entry.regionId || null));
    if (unchanged) entry.pendingVanilla = true; else delete entry.pendingVanilla;
    return unchanged;
}

/** Drops pending copies (not the one still open, if given) so they can't pile up. */
export function discardPendingVanillaCopies(keepId: any = null) {
    for (const key of ['customMoves', 'customAbilities', 'customItems']) {
        if (Array.isArray(state[key]) && state[key].some(x => x?.pendingVanilla && String(x.id) !== String(keepId))) {
            state[key] = state[key].filter(x => !x?.pendingVanilla || String(x.id) === String(keepId));
        }
    }
}

// ---- pins for main-game entries, kept on the region ----
function vanillaPins(region, kind) {
    return Array.isArray(region?.vanillaPins?.[kind]) ? region.vanillaPins[kind] : [];
}

export function isVanillaPinned(kind, id) {
    return vanillaPins(getActiveRegion(), kind).includes(id);
}

export function toggleVanillaPin(kind, id, event) {
    event?.stopPropagation();
    const region = getActiveRegion();
    if (!region) return;
    const pins = vanillaPins(region, kind);
    const on = !pins.includes(id);
    region.vanillaPins = { ...(region.vanillaPins || {}), [kind]: on ? [...pins, id] : pins.filter(x => x !== id) };
    api.saveToStorage?.();
    api.renderCollection?.();
    const name = (kind === 'pokemon' ? state.sdPokedex : vanillaSource(kind))?.[id]?.name || id;
    api.showToast?.(on ? `"${name}" pinned!` : `"${name}" unpinned!`, 'success');
}

/** Takes a main-game entry out of what the region brings over. */
export async function removeVanillaFromRegion(kind, id, event) {
    event?.stopPropagation();
    const region = getActiveRegion();
    if (!region) return;
    const name = (kind === 'pokemon' ? state.sdPokedex : vanillaSource(kind))?.[id]?.name || id;
    const confirmFirst = api.getConfirmBeforeDelete?.() !== false;
    if (confirmFirst && !await confirmDialog({ title: `Remove ${name} from ${region.name}?`, message: 'It stays in the main games; you can bring it back from Region details.', confirmLabel: 'Remove' })) return;
    region.vanilla ||= {};
    region.vanilla[kind] = { mode: 'custom', ids: regionPoolIds(region, kind).filter(x => x !== id) };
    if (region.vanillaPins?.[kind]) region.vanillaPins[kind] = region.vanillaPins[kind].filter(x => x !== id);
    api.saveToStorage?.();
    api.renderCollection?.();
    api.showToast?.(`${name} removed from ${region.name}.`, 'info');
}

/** A new custom entry of your own, starting from a main-game one. */
export function duplicateVanillaEntry(kind, id, event) {
    event?.stopPropagation();
    const region = getActiveRegion();
    const v = vanillaSource(kind)[id];
    if (!region || !v) return;
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const copy = { ...vanillaBaseCopy(kind, id, v, region.id), name: `${v.name || id} Copy`, id: `${{ moves: 'cm', abilities: 'ca', items: 'ci' }[kind]}_${stamp}`, createdAt: Date.now() };
    delete copy.vanillaId;
    listFor(kind).push(copy);
    api.saveToStorage?.();
    api.renderCollection?.();
    api.showToast?.(`${v.name || id} duplicated!`, 'success');
}

/** Downloads a main-game entry in the same format as a custom one, so it imports as one. */
export function exportVanillaEntry(kind, id, event) {
    event?.stopPropagation();
    const v = vanillaSource(kind)[id];
    if (!v) return;
    const item = { ...vanillaBaseCopy(kind, id, v, null), id };
    delete item.vanillaId;
    delete item.regionId;
    const noun = { moves: 'move', abilities: 'ability', items: 'item' }[kind];
    const payload = { format: `woogidex-custom-${noun}`, version: 1, exportedAt: new Date().toISOString(), item };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${String(item.name).replace(/[^a-z0-9-_]+/gi, '-').toLowerCase() || noun}-custom-${noun}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    api.showToast?.(`${item.name} exported!`, 'success');
}

/**
 * The main-game moves / items / abilities a region brings over, after its
 * own. Ones the region has its own copy of are left out (the copy shows among
 * its own entries). The first VANILLA_PAGE show until "Show all".
 */
export function regionVanillaLibrary(kind, search = ''): { shown: Array<[string, any]>, total: number } | null {
    const region = getActiveRegion();
    if (!region || !['moves', 'items', 'abilities'].includes(kind)) return null;
    const q = search.trim().toLowerCase();
    const source = vanillaSource(kind);
    const ids = regionPoolIds(region, kind)
        .filter(id => source[id] && !editedCopy(kind, id, region))
        .filter(id => !q || String(source[id].name).toLowerCase().includes(q))
        .sort((a, b) => String(source[a].name).localeCompare(String(source[b].name)));
    if (!ids.length) return null;
    // pinned ones lead, like pinned entries of your own
    const pins = vanillaPins(region, kind);
    ids.sort((a, b) => (pins.includes(b) ? 1 : 0) - (pins.includes(a) ? 1 : 0));
    const shown = showAllVanilla[kind] || q ? ids : ids.slice(0, VANILLA_PAGE);
    return { shown: shown.map(id => [id, source[id]]), total: ids.length };
}

export function showAllRegionVanilla(kind) {
    showAllVanilla[kind] = true;
    api.renderCollection?.();
}

/**
 * Editing a main-game move / item / ability inside a region makes the
 * region's own copy (marked with vanillaId), then opens it in the usual
 * editor. The original is untouched everywhere else; deleting the copy puts
 * the original back.
 */
export function editVanillaInRegion(kind, id) {
    const region = getActiveRegion();
    const v = vanillaSource(kind)[id];
    if (!region || !v) return;
    let copy = anyCopy(kind, id, region);
    discardPendingVanillaCopies(copy?.id);
    if (!copy) {
        const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const prefix = { moves: 'cm', abilities: 'ca', items: 'ci' }[kind];
        // not saved: it only becomes the region's own version once a save changes it
        copy = { ...vanillaBaseCopy(kind, id, v, region.id), id: `${prefix}_${stamp}`, createdAt: Date.now(), pendingVanilla: true };
        listFor(kind).push(copy);
    }
    api.openLibraryEditorSheet?.(kind, copy.id);
}

/** What the Types tab shows for the current view. */
export function typesTabArgs() {
    const active = getActiveRegionId();
    const region = getActiveRegion();
    const custom = api.getCustomTypes?.() || [];
    if (region) return { list: custom.filter(t => entryInRegion(t, region.id)), vanilla: regionPoolIds(region, 'types'), regionId: region.id, vanillaCards: true };
    // outside a region the main-game types can't be edited, so only yours get cards;
    // the chart still shows how they meet every main-game type
    if (active === NO_REGION) return { list: custom.filter(t => entryInRegion(t, NO_REGION)), vanilla: VANILLA_TYPES, regionId: null as any, vanillaCards: false };
    return { list: custom, vanilla: VANILLA_TYPES, regionId: null as any, vanillaCards: false };
}

/** The main-game Pokémon a region brings over, shown after its Fakémon. */
export function regionVanillaPokemon(search = '') {
    const region = getActiveRegion();
    if (!region || poolOf(region, 'pokemon').mode === 'none') return [];
    const q = search.trim().toLowerCase();
    // one the region already has its own version of shows as that Fakemon instead
    const pins = vanillaPins(region, 'pokemon');
    const ids = regionPoolIds(region, 'pokemon').filter(id => state.sdPokedex?.[id] && !regionPokemonCopy(id, region))
        .sort((a, b) => (pins.includes(b) ? 1 : 0) - (pins.includes(a) ? 1 : 0));
    return ids.map(id => state.sdPokedex[id]).filter(p => !q || p.name.toLowerCase().includes(q)).slice(0, 400);
}

// a pending copy (opened, never changed) doesn't replace the main-game card
function regionPokemonCopy(speciesId, region, { includePending = false }: { includePending?: any } = {}) {
    return (state.fakemonDB || []).find(f => f.vanillaId === speciesId && String(f.regionId || '') === String(region.id)
        && (includePending || !f.pendingVanilla)) || null;
}

/**
 * The quick preview a Fakemon card opens, for a main-game Pokemon. It shows
 * the region's version (pending unless it was already edited) without opening
 * the editor; its Edit button goes on to edit it.
 */
let previewing = false;
export async function previewVanillaPokemonInRegion(speciesId) {
    const region = getActiveRegion();
    if (!region || !state.sdPokedex?.[speciesId] || previewing) return;
    const copy = regionPokemonCopy(speciesId, region);
    if (copy) { api.previewFakemon?.(copy.id); return; }
    previewing = true;
    try {
        // fills the editor's form while it stays hidden, where nothing autosaves,
        // so previewing creates nothing at all
        await api.usePokemonTemplate?.(speciesId, { background: true });
        api.openBoardPreview?.(() => editVanillaPokemonInRegion(speciesId));
    } finally {
        previewing = false;
    }
}

/** A Fakemon of your own, starting from a main-game Pokemon (not the region's version of it). */
export async function duplicateVanillaPokemon(speciesId, event) {
    event?.stopPropagation();
    const p = state.sdPokedex?.[speciesId];
    if (!p) return;
    await api.usePokemonTemplate?.(speciesId, { asCopy: true, name: `${p.name} Copy` });
}

/** Opens the region's (pending) version and exports it; nothing is saved by doing so. */
export async function exportVanillaPokemon(speciesId, format, event) {
    event?.stopPropagation();
    api.closeCollectionFakemonExportMenus?.();
    await editVanillaPokemonInRegion(speciesId, { quiet: true });
    const run = { png: 'exportAsPNG', text: 'openPlainTextExportModal', json: 'exportAsJSON', showdown: 'exportShowdownMod', essentials: 'exportEssentialsMod' }[format];
    await api[run]?.();
}

/**
 * Editing a main-game Pokemon inside a region makes the region's own Fakemon
 * from it (the usual template, so its stats, moves, abilities and evolution
 * line come along), then opens it. The original is untouched elsewhere.
 */
export async function editVanillaPokemonInRegion(speciesId, { quiet = false }: { quiet?: any } = {}) {
    const region = getActiveRegion();
    if (!region || !state.sdPokedex?.[speciesId]) return;
    const copy = regionPokemonCopy(speciesId, region, { includePending: true });
    if (copy) { api.editFakemon?.(copy.id); return; }
    // the new Fakemon starts in the region you're looking at (defaultRegionForNewFakemon),
    // pending until something in it actually changes (see autoSave in storage.ts)
    await api.usePokemonTemplate?.(speciesId, { pendingVanilla: true });
    if (!quiet) api.showToast?.(`Changes you make to ${state.sdPokedex[speciesId].name} only apply in ${region.name}.`, 'info');
}

// ---- Region details ----
// The page is js/app/components/collection/RegionDetails.tsx; edits save a moment after typing stops.
let saveTimer: any = null;
let detailsStatus = '';
export function regionDetailsStatus() { return detailsStatus; }
function saveSoon(message = 'Saved') {
    clearTimeout(saveTimer);
    detailsStatus = 'Saving…';
    notify();
    saveTimer = setTimeout(() => {
        api.saveToStorage?.();
        renderRegionSidebar();
        detailsStatus = message;
        notify();
    }, 400);
}

export function regionDetailsInput(field, value) {
    const region = getActiveRegion();
    if (!region) return;
    if (field === 'name') {
        const name = value.trim();
        if (!name) return;
        if (nameClash(name, region.id)) { api.showToast?.('Another region already has that name.', 'error'); return; }
        region.name = name;
    } else if (field === 'tagline' || field === 'bio') {
        region[field] = value;
    }
    region.updatedAt = Date.now();
    saveSoon();
}

export function setRegionDetailsColor(hex) {
    const region = getActiveRegion();
    if (!region) return;
    region.color = hex;
    saveSoon();
}

export function setRegionPoolMode(kind, mode) {
    const region = getActiveRegion();
    if (!region) return;
    region.vanilla ||= {};
    const current = poolOf(region, kind);
    // switching to "Choose" starts from whatever was in the pool before
    const ids = mode === 'custom' && current.mode !== 'custom' ? regionPoolIds(region, kind) : current.ids;
    region.vanilla[kind] = { mode, ids };
    saveSoon();
    renderRegionDetails();
    if (mode === 'custom') openRegionPicker(kind);
}

// banners are downscaled on the way in: a phone photo would otherwise be
// megabytes in every save and backup
export function uploadRegionBanner(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    const region = getActiveRegion();
    if (!file || !region) return;
    if (!file.type.startsWith('image/')) { api.showToast?.('Pick an image file for the banner.', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => {
        const img = new Image();
        img.onload = () => {
            const maxW = 1600, maxH = 600;
            const scale = Math.min(1, maxW / img.width, maxH / img.height);
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
            region.banner = canvas.toDataURL('image/jpeg', 0.86);
            saveSoon();
            renderRegionDetails();
        };
        img.onerror = () => api.showToast?.('That image could not be read.', 'error');
        img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
}

export function removeRegionBanner() {
    const region = getActiveRegion();
    if (!region) return;
    region.banner = '';
    saveSoon();
    renderRegionDetails();
}

/** Redraws the region page; kept for callers that changed a region. */
export function renderRegionDetails() {
    notify();
}

// ---- choosing individual vanilla entries ----
export function openRegionPicker(kind) {
    const region = getActiveRegion();
    if (!region) return;
    if (!state.sdLoaded && kind !== 'types') {
        api.showToast?.('The main-games data is still loading. Try again in a moment.', 'info');
        api.fetchShowdownData?.();
        return;
    }
    const { mode, ids } = poolOf(region, kind);
    openDialog('region-picker', { kind, regionName: region.name, initial: mode === 'custom' ? ids : regionPoolIds(region, kind) });
}

/** Everything the picker lists: the National Dex, plus anything chosen earlier that isn't in it. */
export function regionPickerEntries(kind, selected) {
    const entries = natdexEntries(kind);
    const known = new Set(entries.map(([id]: any[]) => id));
    for (const id of selected) if (!known.has(id)) entries.push([id, { name: id }]);
    return entries.sort((a, b) => String(a[1].name).localeCompare(String(b[1].name)));
}

/** The picker's Done: exactly these entries come over. */
export function saveRegionPool(kind, ids) {
    const region = getActiveRegion();
    if (!region) return;
    region.vanilla ||= {};
    region.vanilla[kind] = { mode: 'custom', ids: [...ids] };
    saveSoon();
    api.renderCollection?.();
}

// ---- export scope ----
/**
 * With a region picked, every collection export is that region's: this is
 * what exportCollection / the Showdown, Essentials and plain-text exporters
 * read instead of the whole collection. null means "the whole collection".
 */
export function getExportScope() {
    const region = getActiveRegion();
    if (!region) return null;
    const mine = x => x && entryInRegion(x, region.id);
    const customTypes = (api.getCustomTypes?.() || []).filter(mine);
    const pools: Record<string, any> = {};
    for (const kind of POOL_KINDS) pools[kind] = { mode: poolOf(region, kind).mode, ids: regionPoolIds(region, kind) };
    return {
        region,
        slug: String(region.name).toLowerCase().replace(/[^a-z0-9]+/g, '') || 'region',
        fakemonDB: (state.fakemonDB || []).filter(x => mine(x) && !x.pendingVanilla),
        customMoves: (state.customMoves || []).filter(x => mine(x) && !x.pendingVanilla),
        customAbilities: (state.customAbilities || []).filter(x => mine(x) && !x.pendingVanilla),
        customItems: (state.customItems || []).filter(x => mine(x) && !x.pendingVanilla),
        customTypes,
        pools
    };
}

/** region.json for the mod exports: what it is and what it brings over. */
export function regionManifest(scope) {
    const r = scope.region;
    return JSON.stringify({
        format: 'woogidex-region', version: 1,
        name: r.name, tagline: r.tagline || '', bio: r.bio || '',
        mainGames: Object.fromEntries(POOL_KINDS.map(k => [k, { mode: scope.pools[k].mode, ids: scope.pools[k].ids }])),
        customTypes: scope.customTypes.map(t => ({ name: t.name, color: t.color, gradient: t.gradient || null, matchups: t.matchups })),
        // the region's own versions of main-game types
        editedTypes: (api.getTypeOverrides?.(r.id) || []).map(t => ({ type: t.vanillaOf, color: t.color, gradient: t.gradient || null, matchups: t.matchups })),
        editedFromMainGames: {
            moves: scope.customMoves.filter(m => m.vanillaId).map(m => m.vanillaId),
            abilities: scope.customAbilities.filter(m => m.vanillaId).map(m => m.vanillaId),
            items: scope.customItems.filter(m => m.vanillaId).map(m => m.vanillaId)
        }
    }, null, 2);
}
