// ==================== regions ====================
// A region is a Fakedex project: Kanto, Galar, or whatever you are building.
// It holds your own Fakemon, custom moves, abilities, items and custom types
// (each has a regionId), plus a choice of what it brings over from the main
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

import { log } from '../core/log.js';
import { state, api } from '../core/app.js';
import { esc } from '../core/html.js';
import { POKEMON_TYPES } from '../core/data.js';
import { iconSvg } from '../core/icons.js';

export const REGION_TYPE = 'region';
const ACTIVE_KEY = 'woogidex.collection.region.v1';
/** "Things in no region": a filter, not a region. */
export const NO_REGION = '__none';

const REGION_COLORS = ['#7c5cff', '#e2574c', '#f09a36', '#e6c229', '#3fae5a', '#2bb3a8', '#3b82f6', '#c056d8', '#8a8f9c'];
// the 18, plus ??? (typeless) and Stellar (Tera), which are neutral both ways
const VANILLA_TYPES = [...POKEMON_TYPES.slice(0, 18), '???', 'Stellar'];

// ---- what a region brings over from the main games ----
export const POOL_KINDS = ['pokemon', 'moves', 'items', 'abilities', 'types'];
const POOL_LABEL = { pokemon: 'Pokémon', moves: 'Moves', items: 'Items', abilities: 'Abilities', types: 'Types' };
const POOL_ICON = { pokemon: 'paw-print', moves: 'zap', items: 'gem', abilities: 'sparkles', types: 'shapes' };
const DEFAULT_POOLS = { pokemon: 'none', moves: 'natdex', items: 'natdex', abilities: 'natdex', types: 'natdex' };
// Showdown's markers for things outside the National Dex
const NOT_NATDEX = new Set(['CAP', 'LGPE', 'Custom', 'Future', 'Pokestar', 'Gigantamax', 'Unobtainable']);

/** Every id the latest National Dex has, for one kind. */
function natdexEntries(kind) {
    if (kind === 'types') return VANILLA_TYPES.map(t => [t, { name: t }]);
    const source = { pokemon: state.sdPokedex, moves: state.sdMoves, items: state.sdItems, abilities: state.sdAbilities }[kind] || {};
    return Object.entries(source).filter(([, v]) => {
        if (!v || NOT_NATDEX.has(v.nonstandard)) return false;
        if (kind === 'pokemon') return v.num > 0 && !/Gmax|Totem/.test(v.forme || '');
        if (kind === 'moves') return !v.isZ && !v.isMax;
        if (kind === 'abilities') return (v.num ?? 1) > 0;
        return true;
    });
}

function poolOf(region, kind) {
    const p = region?.vanilla?.[kind];
    return { mode: p?.mode || DEFAULT_POOLS[kind], ids: Array.isArray(p?.ids) ? p.ids : [] };
}

/** The vanilla ids a region brings over, for one kind. */
export function regionPoolIds(region, kind) {
    const { mode, ids } = poolOf(region, kind);
    if (mode === 'none') return [];
    if (mode === 'custom') return ids.slice();
    return natdexEntries(kind).map(([id]) => id);
}

function poolSummary(region, kind) {
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
let regionPage = null;
let draggingOver = null;

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

/** @returns {boolean} whether this Fakemon / move / ability / item / type shows under the active region */
export function entryInActiveRegion(entry) {
    const active = getActiveRegionId();
    if (!active) return true;
    if (active === NO_REGION) return !entry.regionId || !regionById(entry.regionId);
    return String(entry.regionId || '') === String(active);
}
// the name pokedex.js already calls
export const fakemonInActiveRegion = entryInActiveRegion;

function countIn(regionId) {
    return (state.fakemonDB || []).filter(f => regionId === NO_REGION
        ? (!f.regionId || !regionById(f.regionId))
        : String(f.regionId || '') === String(regionId)).length;
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
    try { localStorage.setItem(ACTIVE_KEY, activeRegionId); } catch { /* not remembered */ }
    regionPage = page;
    closeRegionDrawer();
    // National Dex counts and main-game Pokemon need the Showdown data
    if (!state.sdLoaded) api.fetchShowdownData?.().then(() => { if (regionPage) renderRegionDetails(); });
    api.renderCollection?.();
    renderRegionSidebar();
    window.scrollTo({ top: 0 });
}

export function openRegionDetails(id = null) { openRegionPage('details', id); }
export function openRegionAnalytics(id = null) { openRegionPage('analytics', id); }

export function closeRegionDetails() {
    regionPage = null;
    api.renderCollection?.();
    renderRegionSidebar();
}

// ---- the phone drawer ----
export function toggleRegionDrawer(force) {
    const open = force ?? !document.body.classList.contains('region-drawer-open');
    document.body.classList.toggle('region-drawer-open', open);
    const btn = document.getElementById('collection-regions-btn');
    btn?.setAttribute('aria-expanded', String(open));
}
export function closeRegionDrawer() { toggleRegionDrawer(false); }

// ---- creating ----
let createColor = REGION_COLORS[0];

export function createRegion() {
    createColor = REGION_COLORS[getRegions().length % REGION_COLORS.length];
    const modal = document.getElementById('region-modal');
    if (!modal) return;
    document.getElementById('region-name-input').value = '';
    document.getElementById('region-tagline-input').value = '';
    for (const kind of POOL_KINDS) {
        const select = document.getElementById(`region-pool-${kind}`);
        if (select) select.value = DEFAULT_POOLS[kind];
    }
    renderColorOptions('region-color-options', createColor, 'selectRegionColor');
    closeRegionDrawer();
    modal.classList.add('active');
    setTimeout(() => document.getElementById('region-name-input')?.focus(), 50);
}

function renderColorOptions(hostId, selected, handler) {
    const host = document.getElementById(hostId);
    if (!host) return;
    host.innerHTML = REGION_COLORS.map(hex => `<button type="button" class="color-option${hex === selected ? ' selected' : ''}" style="background-color:${hex}" aria-label="Colour ${hex}" onclick="${handler}('${hex}')"></button>`).join('');
}

export function selectRegionColor(hex) {
    createColor = hex;
    renderColorOptions('region-color-options', createColor, 'selectRegionColor');
}

function nameClash(name, exceptId = null) {
    return getRegions().find(r => r.id !== exceptId && String(r.name).trim().toLowerCase() === name.toLowerCase());
}

export function saveRegionFromModal() {
    const name = document.getElementById('region-name-input')?.value.trim() || '';
    const tagline = document.getElementById('region-tagline-input')?.value.trim() || '';
    if (!name) { api.showToast?.('Give the region a name first.', 'error'); return; }
    const clash = nameClash(name);
    if (clash) { api.showToast?.(`You already have a region called ${clash.name}.`, 'error'); return; }
    const vanilla = {};
    for (const kind of POOL_KINDS) vanilla[kind] = { mode: document.getElementById(`region-pool-${kind}`)?.value || DEFAULT_POOLS[kind], ids: [] };
    const region = {
        id: `region_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        type: REGION_TYPE, name, tagline, bio: '', banner: '', color: createColor, vanilla, createdAt: Date.now()
    };
    state.folders = [...(state.folders || []), region];
    log.info('REGIONS', 'Created a region', { name });
    api.closeModal?.('region-modal');
    api.saveToStorage?.();
    selectRegion(region.id);
    api.showToast?.(`${name} created. Open Region details to add a banner and bio.`, 'success');
}

export function deleteActiveRegion() {
    const region = getActiveRegion();
    if (!region) return;
    const count = countIn(region.id);
    const confirmFirst = api.getConfirmBeforeDelete?.() !== false;
    if (confirmFirst && !window.confirm(`Delete the region "${region.name}"?${count ? ` Its ${count} Fakémon stay in your collection, just without a region.` : ''} Its moves, abilities, items and types stay too.`)) return;
    const lists = [state.fakemonDB, state.customMoves, state.customAbilities, state.customItems, state.folders];
    lists.forEach(list => (list || []).forEach(x => { if (x && String(x.regionId || '') === String(region.id)) x.regionId = null; }));
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

export function setEntryRegion(kind, entryId, regionId) {
    const entry = (listFor(kind) || []).find(x => String(x.id) === String(entryId));
    if (!entry) return;
    const target = regionId === NO_REGION ? null : (regionById(regionId)?.id || null);
    if ((entry.regionId || null) === target) return;
    entry.regionId = target;
    entry.updatedAt = Date.now();
    api.saveToStorage?.();
    renderRegionSidebar();
    api.renderCollection?.();
    api.showToast?.(target ? `${entry.name} is now in ${regionById(target).name}.` : `${entry.name} no longer has a region.`, 'success');
}
export function setFakemonRegion(fakemonId, regionId) { setEntryRegion('fakemon', fakemonId, regionId); }

export function handleRegionDragOver(event) {
    if (!api.getDraggedFakemonId?.() && !api.getDraggedLibraryItem?.()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const row = event.currentTarget;
    if (draggingOver !== row) { draggingOver?.classList.remove('drag-over'); draggingOver = row; row.classList.add('drag-over'); }
}

export function handleRegionDragLeave(event) {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    event.currentTarget.classList.remove('drag-over');
    if (draggingOver === event.currentTarget) draggingOver = null;
}

export function handleRegionDrop(regionId, event) {
    event.preventDefault();
    event.currentTarget.classList.remove('drag-over');
    draggingOver = null;
    const lib = api.getDraggedLibraryItem?.();
    if (lib) setEntryRegion(lib.kind, lib.id, regionId);
    else {
        const id = api.getDraggedFakemonId?.() || event.dataTransfer?.getData('text/plain');
        if (id) setEntryRegion('fakemon', id, regionId);
    }
    api.handleCardDragEnd?.();
}

// ---- the "Add to region" button in every editor ----
// Each editor (Fakemon, move, ability, item, type) has one in its header. It
// writes into a hidden <select> next to it, which the editor's save reads
// (applyEntityRegion) -- so the button works the same before and after the
// first save. The label names the region once one is chosen.
function refreshRegionAssign(select) {
    const wrap = select?.closest('.region-assign');
    if (!wrap) return;
    const region = regionById(select.value);
    const label = wrap.querySelector('.region-assign-label');
    if (label) label.textContent = region ? region.name : 'Add to region';
    const btn = wrap.querySelector('.region-assign-btn');
    btn?.classList.toggle('has-region', !!region);
    btn?.style.setProperty('--region-color', region?.color || 'transparent');
}

function fillSelectOptions(select) {
    const regions = getRegions();
    const keep = select.value;
    select.innerHTML = `<option value="">No region</option>${regions.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}`;
    select.value = regions.some(r => r.id === keep) ? keep : '';
}

export function fillEntityRegionSelect(selectId, regionId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    fillSelectOptions(select);
    select.value = regionById(regionId)?.id || '';
    refreshRegionAssign(select);
}

export function applyEntityRegion(entry, selectId) {
    const select = document.getElementById(selectId);
    if (!entry || !select) return;
    entry.regionId = select.value || null;
}

let openAssignMenu = null;
function closeAssignMenu() {
    if (!openAssignMenu) return;
    openAssignMenu.hidden = true;
    openAssignMenu.previousElementSibling?.setAttribute('aria-expanded', 'false');
    openAssignMenu = null;
    document.removeEventListener('mousedown', onAssignOutside, true);
}
function onAssignOutside(event) {
    if (openAssignMenu && !openAssignMenu.parentElement.contains(event.target)) closeAssignMenu();
}

export function toggleRegionAssignMenu(btn, event) {
    event?.stopPropagation();
    const wrap = btn.closest('.region-assign');
    const menu = wrap?.querySelector('.region-assign-menu');
    const select = wrap?.querySelector('select');
    if (!menu || !select) return;
    if (openAssignMenu === menu) { closeAssignMenu(); return; }
    closeAssignMenu();
    fillSelectOptions(select);
    const current = select.value;
    const item = (id, name, color) => `<button type="button" class="region-assign-item${current === id ? ' on' : ''}" data-id="${esc(id)}">
        ${color ? `<span class="region-dot" style="--region-color:${esc(color)}"></span>` : '<i data-lucide="circle-dashed"></i>'}
        <span>${esc(name)}</span>${current === id ? '<i data-lucide="check" class="region-assign-check"></i>' : ''}</button>`;
    menu.innerHTML = `<div class="region-assign-title">Region</div>`
        + getRegions().map(r => item(r.id, r.name, r.color || REGION_COLORS[0])).join('')
        + item('', 'No region', '')
        + `<div class="region-assign-divider"></div><button type="button" class="region-assign-item" data-new="1"><i data-lucide="plus"></i><span>New region</span></button>`;
    menu.onclick = (e) => {
        const target = e.target.closest('.region-assign-item');
        if (!target) return;
        closeAssignMenu();
        if (target.dataset.new) { createRegion(); return; }
        select.value = target.dataset.id || '';
        refreshRegionAssign(select);
        select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    openAssignMenu = menu;
    document.addEventListener('mousedown', onAssignOutside, true);
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ---- the sidebar ----
function rowHtml({ id, name, color, count, icon, active, editable, droppable }) {
    const dropAttrs = droppable
        ? ` ondragover="handleRegionDragOver(event)" ondragleave="handleRegionDragLeave(event)" ondrop="handleRegionDrop('${esc(id)}', event)"` : '';
    const mark = color
        ? `<span class="region-dot" style="--region-color:${esc(color)}"></span>`
        : `<i data-lucide="${icon}"></i>`;
    return `<div class="region-row${active ? ' active' : ''}"${dropAttrs}>
        <button type="button" class="region-row-main" onclick="selectRegion(${id ? `'${esc(id)}'` : 'null'})" ${active ? 'aria-current="true"' : ''}>
            ${mark}<span class="region-row-name">${esc(name)}</span><span class="region-row-count">${count}</span>
        </button>
        ${editable ? `<button type="button" class="region-row-edit" onclick="openRegionDetails('${esc(id)}')" title="${esc(name)} details" aria-label="${esc(name)} details"><i data-lucide="settings-2"></i></button>` : ''}
    </div>`;
}

export function renderRegionSidebar() {
    const host = document.getElementById('region-list');
    const active = getActiveRegionId();
    // css/regions.css and custom-types.js key a region's own type colours off this
    if (getActiveRegion()) document.body.dataset.activeRegion = getActiveRegion().id;
    else delete document.body.dataset.activeRegion;
    const regions = getRegions();
    if (host) {
        const rows = [rowHtml({ id: null, name: 'All', icon: 'layout-grid', count: (state.fakemonDB || []).length, active: !active })];
        for (const r of regions) {
            const isActive = active === r.id;
            rows.push(rowHtml({ id: r.id, name: r.name, color: r.color || REGION_COLORS[0], count: countIn(r.id), active: isActive && !regionPage, editable: true, droppable: true }));
            // the way into a region's own page, under the region you're in
            if (isActive) {
                rows.push(`<button type="button" class="region-subrow${regionPage === 'details' ? ' active' : ''}" onclick="openRegionDetails()"><i data-lucide="book-open"></i><span>Region details</span></button>`);
                rows.push(`<button type="button" class="region-subrow${regionPage === 'analytics' ? ' active' : ''}" onclick="openRegionAnalytics()"><i data-lucide="chart-bar"></i><span>Analytics</span></button>`);
            }
        }
        if (regions.length) {
            rows.push(rowHtml({ id: NO_REGION, name: 'No region', icon: 'circle-dashed', count: countIn(NO_REGION), active: active === NO_REGION, droppable: true }));
        }
        host.innerHTML = rows.join('');
    }
    renderRegionSelects();
    // the phone button that opens the drawer names where you are
    const label = document.getElementById('collection-regions-label');
    if (label) label.textContent = getActiveRegion()?.name || (active === NO_REGION ? 'No region' : 'All');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// the editor's Region field
function renderRegionSelects() {
    const editorSelect = document.getElementById('fakemon-region');
    if (editorSelect) {
        fillSelectOptions(editorSelect);
        refreshRegionAssign(editorSelect);
    }
}

/** Sets the editor's Region field (loading a Fakemon, or a fresh one). */
export function setEditorRegion(regionId) {
    renderRegionSelects();
    const select = document.getElementById('fakemon-region');
    if (select) { select.value = regionById(regionId)?.id || ''; refreshRegionAssign(select); }
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
const showAllVanilla = {};            // kind -> true once "Show all" was pressed
const CATEGORY_ICON = { Physical: 'swords', Special: 'sparkle', Status: 'circle-dot' };

function vanillaSource(kind) {
    return { moves: state.sdMoves, items: state.sdItems, abilities: state.sdAbilities }[kind] || {};
}

/** The region's own edited copy of a main-game entry, if it has one. */
function editedCopy(kind, vanillaId, region) {
    return (listFor(kind) || []).find(x => x.vanillaId === vanillaId && String(x.regionId || '') === String(region.id)) || null;
}

function vanillaTile(kind, id, v) {
    const name = esc(v.name || id);
    const onclick = `editVanillaInRegion('${kind}','${esc(id)}')`;
    let art, corner = '', meta = '', pills = '';
    if (kind === 'moves') {
        const type = String(v.type || 'Normal');
        art = `<span class="library-emblem type-${esc(type.toLowerCase())}">${iconSvg(CATEGORY_ICON[v.category] || 'zap')}</span>`;
        corner = esc(v.category || '');
        const acc = v.accuracy === true ? '—' : `${v.accuracy}%`;
        meta = `<span class="card-bst"><em>BP</em>${v.basePower || '—'}</span><span class="card-bst"><em>ACC</em>${esc(acc)}</span><span class="card-bst"><em>PP</em>${v.pp || '—'}</span>`;
        pills = `<span class="type-badge type-${esc(type.toLowerCase())}">${esc(type)}</span>`;
    } else {
        art = `<span class="library-emblem library-emblem-plain">${iconSvg(kind === 'items' ? 'gem' : 'sparkles')}</span>`;
        meta = `<span class="library-tile-desc">${esc(v.desc || 'No description')}</span>`;
        pills = kind === 'items' ? '<span class="library-tag">Item</span>' : '';
    }
    const typesRow = kind === 'abilities'
        ? '<div class="card-types card-types-spacer" aria-hidden="true"></div>'
        : `<div class="card-types">${pills}</div>`;
    return `<div class="collection-card library-tile vanilla-card" onclick="${onclick}" title="${esc(v.desc || v.name || id)}">
        <div class="card-art">${art}${corner ? `<span class="card-number library-tile-corner">${corner}</span>` : ''}<span class="vanilla-card-tag">Main games</span></div>
        <div class="card-body"><div class="card-name">${name}</div><div class="card-meta-row">${meta}</div>${typesRow}</div>
    </div>`;
}

/**
 * Cards for the main-game moves / items / abilities a region brings over,
 * after its own. Ones the region has its own copy of are left out (the copy
 * shows among its own entries). The first VANILLA_PAGE show until "Show all".
 */
export function regionVanillaLibraryCards(kind, search = '') {
    const region = getActiveRegion();
    if (!region || !['moves', 'items', 'abilities'].includes(kind)) return '';
    const q = search.trim().toLowerCase();
    const source = vanillaSource(kind);
    const ids = regionPoolIds(region, kind)
        .filter(id => source[id] && !editedCopy(kind, id, region))
        .filter(id => !q || String(source[id].name).toLowerCase().includes(q))
        .sort((a, b) => String(source[a].name).localeCompare(String(source[b].name)));
    if (!ids.length) return '';
    const shown = showAllVanilla[kind] || q ? ids : ids.slice(0, VANILLA_PAGE);
    const more = shown.length < ids.length
        ? `<button type="button" class="collection-card vanilla-more-card" onclick="showAllRegionVanilla('${kind}')"><span class="card-art"><span class="collection-add-icon">${iconSvg('chevron-down')}</span></span><span class="card-body"><span class="card-name">Show all ${ids.length}</span><span class="library-tile-desc">From the main games</span></span></button>` : '';
    return shown.map(id => vanillaTile(kind, id, source[id])).join('') + more;
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
    let copy = editedCopy(kind, id, region);
    if (!copy) {
        const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const base = { name: v.name || id, desc: v.desc || '', vanillaId: id, regionId: region.id, source: 'custom', custom: true, createdAt: Date.now() };
        if (kind === 'moves') {
            copy = {
                ...base, id: `cm_${stamp}`,
                type: v.type || 'Normal', category: v.category || 'Status',
                basePower: v.basePower || 0, accuracy: v.accuracy === true ? 100 : (v.accuracy || 100),
                pp: v.pp || 10, priority: v.priority || 0, flags: { ...(v.flags || {}) }
            };
            state.customMoves.push(copy);
        } else if (kind === 'abilities') {
            copy = { ...base, id: `ca_${stamp}` };
            state.customAbilities.push(copy);
        } else {
            copy = { ...base, id: `ci_${stamp}`, artwork: '', isMegaStone: false };
            state.customItems.push(copy);
        }
        api.saveToStorage?.();
        api.showToast?.(`This is ${region.name}'s own ${copy.name}. Changes only apply in ${region.name}; delete it to go back to the original.`, 'info');
    }
    api.openLibraryEditorSheet?.(kind, copy.id);
    api.renderCollection?.();
}

/** What the Types tab shows for the current view. */
export function typesTabArgs() {
    const active = getActiveRegionId();
    const region = getActiveRegion();
    const custom = api.getCustomTypes?.() || [];
    if (region) return { list: custom.filter(t => String(t.regionId || '') === String(region.id)), vanilla: regionPoolIds(region, 'types'), regionId: region.id, vanillaCards: true };
    // outside a region the main-game types can't be edited, so only yours get cards;
    // the chart still shows how they meet every main-game type
    if (active === NO_REGION) return { list: custom.filter(t => !t.regionId || !regionById(t.regionId)), vanilla: VANILLA_TYPES, regionId: null, vanillaCards: false };
    return { list: custom, vanilla: VANILLA_TYPES, regionId: null, vanillaCards: false };
}

/** Cards for the vanilla Pokemon a region brings over, after its Fakemon. */
export function regionVanillaPokemonCards(search = '') {
    const region = getActiveRegion();
    if (!region) return '';
    const q = search.trim().toLowerCase();
    // one the region already has its own version of shows as that Fakemon instead
    const ids = regionPoolIds(region, 'pokemon').filter(id => state.sdPokedex?.[id] && !regionPokemonCopy(id, region));
    const mons = ids.map(id => state.sdPokedex[id]).filter(p => !q || p.name.toLowerCase().includes(q));
    if (!mons.length || poolOf(region, 'pokemon').mode === 'none') return '';
    return mons.slice(0, 400).map(p => {
        const sprite = api.getPokemonTemplateSprite?.(p) || '';
        const types = (p.types || []).map(t => `<span class="type-badge type-${esc(t.toLowerCase())}">${esc(t)}</span>`).join('');
        return `<div class="collection-card vanilla-card" onclick="editVanillaPokemonInRegion('${esc(p.id)}')" title="${esc(p.name)}: click to make ${esc(region.name)}'s own version">
            <div class="card-art">${sprite ? `<img src="${esc(sprite)}" alt="${esc(p.name)}" loading="lazy" decoding="async">` : ''}<span class="card-number">#${String(p.num).padStart(3, '0')}</span><span class="vanilla-card-tag">Main games</span></div>
            <div class="card-body"><div class="card-name">${esc(p.name)}</div><div class="card-meta-row"><span class="card-bst"><em>BST</em>${Object.values(p.stats || {}).reduce((a, b) => a + b, 0)}</span></div><div class="card-types">${types}</div></div>
        </div>`;
    }).join('');
}

function regionPokemonCopy(speciesId, region) {
    return (state.fakemonDB || []).find(f => f.vanillaId === speciesId && String(f.regionId || '') === String(region.id)) || null;
}

/**
 * Editing a main-game Pokemon inside a region makes the region's own Fakemon
 * from it (the usual template, so its stats, moves, abilities and evolution
 * line come along), then opens it. The original is untouched elsewhere.
 */
export async function editVanillaPokemonInRegion(speciesId) {
    const region = getActiveRegion();
    if (!region || !state.sdPokedex?.[speciesId]) return;
    const copy = regionPokemonCopy(speciesId, region);
    if (copy) { api.editFakemon?.(copy.id); return; }
    const nameInput = document.getElementById('new-fakemon-name');
    if (nameInput) nameInput.value = '';
    // the new Fakemon starts in the region you're looking at (defaultRegionForNewFakemon)
    await api.usePokemonTemplate?.(speciesId);
    api.showToast?.(`This is ${region.name}'s own ${state.sdPokedex[speciesId].name}. Changes only apply in ${region.name}.`, 'info');
}

// ---- Region details ----
let saveTimer = null;
function saveSoon(message = 'Saved') {
    clearTimeout(saveTimer);
    const status = document.getElementById('region-details-status');
    if (status) status.textContent = 'Saving…';
    saveTimer = setTimeout(() => {
        api.saveToStorage?.();
        renderRegionSidebar();
        api.renderBreadcrumb?.();
        if (status) status.textContent = message;
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
    renderColorOptions('region-details-colors', hex, 'setRegionDetailsColor');
    const banner = document.getElementById('region-details-banner');
    if (banner && !region.banner) banner.style.setProperty('--region-color', hex);
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
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            region.banner = canvas.toDataURL('image/jpeg', 0.86);
            saveSoon();
            renderRegionDetails();
        };
        img.onerror = () => api.showToast?.('That image could not be read.', 'error');
        img.src = reader.result;
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

export function renderRegionDetails() {
    const host = document.getElementById('region-details');
    const region = getActiveRegion();
    if (!host || !region) return;
    if (regionPage === 'analytics') {
        host.innerHTML = api.regionAnalyticsHtml?.(region) || '';
        if (typeof lucide !== 'undefined') lucide.createIcons();
        return;
    }
    const counts = {
        fakemon: (state.fakemonDB || []).filter(f => f.regionId === region.id).length,
        moves: (state.customMoves || []).filter(x => x.regionId === region.id).length,
        abilities: (state.customAbilities || []).filter(x => x.regionId === region.id).length,
        items: (state.customItems || []).filter(x => x.regionId === region.id).length,
        types: (api.getCustomTypes?.() || []).filter(x => x.regionId === region.id).length
    };
    const poolRow = kind => {
        const { mode } = poolOf(region, kind);
        const seg = [['none', 'None'], ['natdex', 'National Dex'], ['custom', 'Choose']].map(([m, label]) =>
            `<button type="button" class="seg-btn${mode === m ? ' on' : ''}" aria-pressed="${mode === m}" onclick="setRegionPoolMode('${kind}', '${m}')">${label}</button>`).join('');
        return `<div class="region-pool-row">
            <span class="region-pool-icon"><i data-lucide="${POOL_ICON[kind]}"></i></span>
            <span class="region-pool-name"><strong>${POOL_LABEL[kind]}</strong><small>${esc(poolSummary(region, kind))}</small></span>
            <div class="seg">${seg}</div>
            ${mode === 'custom' ? `<button type="button" class="btn btn-secondary btn-sm" onclick="openRegionPicker('${kind}')">Edit list</button>` : '<span class="region-pool-spacer"></span>'}
        </div>`;
    };
    host.innerHTML = `
        <div class="region-details-banner${region.banner ? ' has-image' : ''}" id="region-details-banner" style="--region-color:${esc(region.color || REGION_COLORS[0])}${region.banner ? `;background-image:url('${region.banner}')` : ''}">
            <div class="region-details-banner-actions">
                <label class="btn btn-secondary btn-sm"><i data-lucide="image-up"></i><span>${region.banner ? 'Change banner' : 'Add banner'}</span><input type="file" accept="image/*" hidden onchange="uploadRegionBanner(event)"></label>
                ${region.banner ? '<button type="button" class="btn btn-secondary btn-sm" onclick="removeRegionBanner()"><i data-lucide="x"></i><span>Remove</span></button>' : ''}
            </div>
            <div class="region-details-banner-title">
                <h2>${esc(region.name)}</h2>
                ${region.tagline ? `<p>${esc(region.tagline)}</p>` : ''}
            </div>
        </div>

        <div class="region-details-grid">
            <div class="region-details-main">
                <section class="region-details-section">
                    <header><h3>About</h3><span class="region-details-status" id="region-details-status"></span></header>
                    <div class="form-group"><label for="region-details-name">Name</label>
                        <input type="text" id="region-details-name" maxlength="40" value="${esc(region.name)}" oninput="regionDetailsInput('name', this.value)"></div>
                    <div class="form-group"><label for="region-details-tagline">Tagline</label>
                        <input type="text" id="region-details-tagline" maxlength="90" value="${esc(region.tagline || '')}" placeholder="One line, like a game's box art" oninput="regionDetailsInput('tagline', this.value)"></div>
                    <div class="form-group"><label for="region-details-bio">Bio</label>
                        <textarea id="region-details-bio" rows="6" maxlength="4000" placeholder="Its history, its landmarks, its legends..." oninput="regionDetailsInput('bio', this.value)">${esc(region.bio || '')}</textarea></div>
                    <div class="form-group"><label>Colour</label><div id="region-details-colors" class="color-options"></div></div>
                </section>

                <section class="region-details-section">
                    <header><h3>From the main games</h3></header>
                    <p class="region-details-help">What ${esc(region.name)} brings over from the official games, next to what you make. It's included when you export the region.</p>
                    <div class="region-pools">${POOL_KINDS.map(poolRow).join('')}</div>
                </section>
            </div>

            <aside class="region-details-side">
                <section class="region-details-section">
                    <header><h3>In this region</h3></header>
                    <dl class="region-counts">
                        ${[['fakemon', 'Fakémon'], ['moves', 'Moves'], ['abilities', 'Abilities'], ['items', 'Items'], ['types', 'Types']].map(([k, label]) =>
                            `<div><dt>${label}</dt><dd><button type="button" onclick="closeRegionDetails(); setCollectionView('${k}')">${counts[k]}</button></dd></div>`).join('')}
                    </dl>
                </section>
                <section class="region-details-section">
                    <header><h3>Export ${esc(region.name)}</h3></header>
                    <p class="region-details-help">Only this region: its Fakémon, moves, abilities, items and types.</p>
                    <div class="region-export-list">
                        <button type="button" class="btn btn-secondary" onclick="exportCollection()"><i data-lucide="file-json"></i>JSON (to import)</button>
                        <button type="button" class="btn btn-secondary" onclick="exportCollectionAsShowdownMod()"><i data-lucide="package"></i>Showdown mod</button>
                        <button type="button" class="btn btn-secondary" onclick="exportCollectionAsEssentialsMod()"><i data-lucide="package"></i>Essentials mod</button>
                        <button type="button" class="btn btn-secondary" onclick="exportCollectionAsPlainTextZip()"><i data-lucide="file-text"></i>Plain text (.zip)</button>
                    </div>
                </section>
                <button type="button" class="btn btn-secondary region-delete-btn region-details-delete" onclick="deleteActiveRegion()"><i data-lucide="trash-2"></i>Delete region</button>
            </aside>
        </div>`;
    renderColorOptions('region-details-colors', region.color, 'setRegionDetailsColor');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ---- choosing individual vanilla entries ----
let pickerKind = null;
let pickerSelected = null;

export function openRegionPicker(kind) {
    const region = getActiveRegion();
    if (!region) return;
    if (!state.sdLoaded && kind !== 'types') {
        api.showToast?.('The main-games data is still loading. Try again in a moment.', 'info');
        api.fetchShowdownData?.();
        return;
    }
    pickerKind = kind;
    pickerSelected = new Set(poolOf(region, kind).mode === 'custom' ? poolOf(region, kind).ids : regionPoolIds(region, kind));
    document.getElementById('region-picker-title').textContent = `Choose ${POOL_LABEL[kind].toLowerCase()} for ${region.name}`;
    const search = document.getElementById('region-picker-search');
    if (search) search.value = '';
    renderRegionPicker();
    document.getElementById('region-picker-modal')?.classList.add('active');
    setTimeout(() => search?.focus(), 50);
}

function pickerEntries() {
    const entries = natdexEntries(pickerKind);
    // anything chosen earlier that isn't in the National Dex list still shows
    const known = new Set(entries.map(([id]) => id));
    for (const id of pickerSelected) if (!known.has(id)) entries.push([id, { name: id }]);
    return entries.sort((a, b) => String(a[1].name).localeCompare(String(b[1].name)));
}

export function renderRegionPicker() {
    const host = document.getElementById('region-picker-list');
    if (!host || !pickerKind) return;
    const q = (document.getElementById('region-picker-search')?.value || '').trim().toLowerCase();
    const shown = pickerEntries().filter(([id, v]) => !q || String(v.name).toLowerCase().includes(q) || id.includes(q));
    host.innerHTML = shown.map(([id, v]) => {
        const extra = pickerKind === 'pokemon' ? `#${String(v.num).padStart(3, '0')}` : pickerKind === 'moves' ? `${esc(v.type || '')} · ${esc(v.category || '')}` : '';
        return `<label class="region-picker-row"><input type="checkbox" value="${esc(id)}" ${pickerSelected.has(id) ? 'checked' : ''} onchange="toggleRegionPickerEntry(this.value, this.checked)"><span>${esc(v.name)}</span>${extra ? `<small>${extra}</small>` : ''}</label>`;
    }).join('') || '<p class="region-picker-empty">Nothing matches.</p>';
    const count = document.getElementById('region-picker-count');
    if (count) count.textContent = `${pickerSelected.size} chosen`;
}

export function toggleRegionPickerEntry(id, on) {
    if (on) pickerSelected.add(id); else pickerSelected.delete(id);
    const count = document.getElementById('region-picker-count');
    if (count) count.textContent = `${pickerSelected.size} chosen`;
}

export function regionPickerSelectShown(on) {
    document.querySelectorAll('#region-picker-list input[type="checkbox"]').forEach(cb => {
        cb.checked = on;
        if (on) pickerSelected.add(cb.value); else pickerSelected.delete(cb.value);
    });
    const count = document.getElementById('region-picker-count');
    if (count) count.textContent = `${pickerSelected.size} chosen`;
}

export function saveRegionPicker() {
    const region = getActiveRegion();
    if (!region || !pickerKind) return;
    region.vanilla ||= {};
    region.vanilla[pickerKind] = { mode: 'custom', ids: [...pickerSelected] };
    api.closeModal?.('region-picker-modal');
    saveSoon();
    renderRegionDetails();
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
    const mine = x => x && String(x.regionId || '') === String(region.id);
    const customTypes = (api.getCustomTypes?.() || []).filter(mine);
    const pools = {};
    for (const kind of POOL_KINDS) pools[kind] = { mode: poolOf(region, kind).mode, ids: regionPoolIds(region, kind) };
    return {
        region,
        slug: String(region.name).toLowerCase().replace(/[^a-z0-9]+/g, '') || 'region',
        fakemonDB: (state.fakemonDB || []).filter(mine),
        customMoves: (state.customMoves || []).filter(mine),
        customAbilities: (state.customAbilities || []).filter(mine),
        customItems: (state.customItems || []).filter(mine),
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
