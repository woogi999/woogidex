// ==================== custom types ====================
// Types you invent (Cosmic, Sound, ...) for your Fakemon and moves. Each one
// has a name, a colour (or a gradient of any number of stops) and its matchups against
// every other type, and can belong to a region like everything else in the
// collection.
//
// A region can also have its own version of a main-game type (its Fire, say,
// with different matchups or colours). That is an entry with `vanillaOf`
// naming the type it replaces; it only applies inside that region -- its
// type chart, its exports, and the colours while you're looking at it.
//
// Storage: entries in state.folders with type 'custom-type', the same list
// regions live in (see js/features/regions.ts), so custom types travel with
// every save, JSON export/import and cloud backup without a schema change.
//
// Wiring: rather than teach every consumer about custom types, syncCustomTypes()
// writes them into the shared type data in place -- POKEMON_TYPES,
// SELECTABLE_TYPES and TYPE_EFFECTIVENESS from js/core/data.ts -- so the
// editor's weakness chart, the analysis tab, move suggestions and the battle
// engine all see them. It also writes a <style> rule per type so every
// existing `.type-<name>` pill and badge gets its colour.

import { log } from '../core/log.ts';
import { state, api } from '../core/app.ts';
import { confirmDialog } from '../core/confirm-dialog.ts';
import { esc } from '../core/html.ts';
import { openDialog } from '../app/dialogs.tsx';
import { POKEMON_TYPES, SELECTABLE_TYPES, TYPE_EFFECTIVENESS } from '../core/data.ts';
import { notify } from '../app/store.ts';
import type { CustomType } from '../app/types.ts';

export const CUSTOM_TYPE_KIND = 'custom-type' as const;
const VANILLA = POKEMON_TYPES.slice();          // the 18, captured before anything is added
/** Every main-game type: the 18, plus ??? (typeless) and Stellar (Tera). Both are neutral. */
export const ALL_VANILLA_TYPES = [...VANILLA, '???', 'Stellar'];
export const MULT_LABEL = { 0: '0', 0.5: '½', 1: '1', 2: '2', 4: '4' };
const NAME_RE = /^[A-Za-z][A-Za-z0-9-]{1,15}$/;
export const TYPE_COLORS = ['#e07a5f', '#7c5cff', '#2bb3a8', '#e6a23c', '#3b82f6', '#c056d8', '#5aa469', '#d64f7a', '#6b7280'];
export const ANGLES: Array<[number, string]> = [[90, 'Left to right'], [135, 'Diagonal'], [180, 'Top to bottom']];
export const MAX_STOPS = 8;
// Stellar is the one main-game type drawn as a gradient (css/controls.css .type-stellar)
const STELLAR_STOPS: Array<[string, number]> = [['#f06a8e', 0], ['#f5a55a', 28], ['#e8d35a', 48], ['#6cc8a0', 68], ['#5d8fe8', 88], ['#9a6cf0', 100]];
const VANILLA_GRADIENTS = { Stellar: { angle: 100, stops: STELLAR_STOPS.map(([color, pos]) => ({ color, pos })) } };
export const GRADIENT_PRESETS: Array<[string, number, Array<[string, number]>]> = [
    ['Stellar', 100, STELLAR_STOPS],
    ['Sunset', 90, [['#ff5f6d', 0], ['#ffc371', 100]]],
    ['Ocean', 135, [['#2193b0', 0], ['#6dd5ed', 100]]],
    ['Aurora', 90, [['#00c9a7', 0], ['#845ec2', 55], ['#d65db1', 100]]],
    ['Ember', 135, [['#7a1f1f', 0], ['#e2574c', 50], ['#f9c74f', 100]]],
    ['Metal', 180, [['#e5e7eb', 0], ['#9ca3af', 50], ['#4b5563', 100]]],
    ['Cosmic', 135, [['#0f0c29', 0], ['#302b63', 50], ['#24243e', 100]]]
];
// the main games' own colours, for a region's version of a type to start from
const VANILLA_COLORS = {
    Normal: '#A8A878', Fire: '#F08030', Water: '#6890F0', Electric: '#F8D030', Grass: '#78C850', Ice: '#98D8D8',
    Fighting: '#C03028', Poison: '#A040A0', Ground: '#E0C068', Flying: '#A890F0', Psychic: '#F85888', Bug: '#A8B820',
    Rock: '#B8A038', Ghost: '#705898', Dragon: '#7038F8', Dark: '#705848', Steel: '#B8B8D0', Fairy: '#EE99AC',
    '???': '#68A090', Stellar: '#40B5A5'
};

// the main-game type symbols, white on transparent, in public/assets/types/
// (from github.com/duiker101/pokemon-type-svg-icons, "for any use"). ??? and
// Stellar have none, so they get a question mark and a sparkle (TypeIcon in
// js/app/components/collection/TypesTab.tsx).
export const TYPE_ICON_FILES = new Set(['bug', 'dark', 'dragon', 'electric', 'fairy', 'fighting', 'fire', 'flying', 'ghost',
    'grass', 'ground', 'ice', 'normal', 'poison', 'psychic', 'rock', 'steel', 'water']);

// ---- reading ----
function allEntries() {
    return (state.folders || []).filter(f => f && f.type === CUSTOM_TYPE_KIND);
}

/** Types you invented (not a region's version of a main-game type). */
export function getCustomTypes() {
    return allEntries().filter(t => !t.vanillaOf).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** A region's own versions of main-game types. */
export function getTypeOverrides(regionId) {
    if (!regionId) return [];
    return allEntries().filter(t => t.vanillaOf && String(t.regionId || '') === String(regionId));
}

export function customByName(name) {
    const key = String(name || '').toLowerCase();
    return getCustomTypes().find(t => t.name.toLowerCase() === key) || null;
}

/** A region's own version of a main-game type, if it has one. */
export function overrideFor(name, regionId) {
    return regionId ? getTypeOverrides(regionId).find(t => t.vanillaOf === name) || null : null;
}

/** Every type a matchup can involve: the 18, then custom ones. */
export function allMatchupTypes() {
    return [...VANILLA, ...getCustomTypes().map(t => t.name)];
}

export function isCustomType(name) { return !!customByName(name); }

/**
 * A gradient's stops, sorted, or null for a solid colour. Older saves hold a
 * two-colour gradient as { color2, angle } with `color` as the first stop.
 */
export function gradientStops(t) {
    const g = t?.gradient;
    if (!g) return null;
    if (Array.isArray(g.stops) && g.stops.length >= 2) {
        return g.stops
            .map(s => ({ color: String(s.color || '#888888'), pos: Math.max(0, Math.min(100, Number(s.pos) || 0)) }))
            .sort((a, b) => a.pos - b.pos);
    }
    if (g.color2) return [{ color: t.color, pos: 0 }, { color: g.color2, pos: 100 }];
    return null;
}

/** A type's fill: its colour, or its gradient. */
export function typeBackground(t) {
    if (!t) return '';
    const stops = gradientStops(t);
    if (!stops) return t.color;
    const angle = Number.isFinite(Number(t.gradient.angle)) ? Number(t.gradient.angle) : 90;
    return `linear-gradient(${angle}deg, ${stops.map(s => `${s.color} ${s.pos}%`).join(', ')})`;
}

// { angle, stops } in the current shape, whatever shape it was saved in
export function normalizeGradient(t) {
    const stops = gradientStops(t);
    if (!stops) return null;
    const angle = Number(t.gradient.angle);
    return { angle: Number.isFinite(angle) ? angle : 90, stops };
}

// names added to the shared chart by the last sync, so they can be told apart
// from (and taken back out of) the main-game rows
let injected: any[] = [];
let lastSignature = '';

/**
 * attacker vs defender. Inside a region, its own version of a type wins.
 * Then a custom attacker's offense row, then a custom defender's defense row,
 * then the main-game chart.
 * @param att @param def @param [regionId] @returns 
 */
export function matchup(att: string, def: string, regionId: string|null = null): number {
    const ao = overrideFor(att, regionId);
    if (ao && ao.matchups?.offense?.[def] !== undefined) return Number(ao.matchups.offense[def]);
    const dov = overrideFor(def, regionId);
    if (dov && dov.matchups?.defense?.[att] !== undefined) return Number(dov.matchups.defense[att]);
    const a = customByName(att);
    if (a && a.matchups?.offense?.[def] !== undefined) return Number(a.matchups.offense[def]);
    const d = customByName(def);
    if (d && d.matchups?.defense?.[att] !== undefined) return Number(d.matchups.defense[att]);
    if (a || d) return 1;
    return (injected.includes(att) || injected.includes(def)) ? 1 : (TYPE_EFFECTIVENESS[att]?.[def] ?? 1);
}

// ---- writing into the shared type data ----
export function syncCustomTypes(force = false) {
    const types = getCustomTypes();
    const all = allEntries();
    const signature = JSON.stringify(all.map(t => [t.name, t.vanillaOf, t.regionId, t.color, t.gradient, t.matchups]));
    if (!force && signature === lastSignature) return;
    lastSignature = signature;

    // take the previous sync back out
    for (const name of injected) {
        const i = POKEMON_TYPES.indexOf(name); if (i !== -1) POKEMON_TYPES.splice(i, 1);
        const j = SELECTABLE_TYPES.indexOf(name); if (j !== -1) SELECTABLE_TYPES.splice(j, 1);
        delete TYPE_EFFECTIVENESS[name];
        for (const row of Object.values<any>(TYPE_EFFECTIVENESS)) delete row[name];
    }
    injected = [];

    // matchups are read before any row is written, so custom-vs-custom resolves
    // from the custom definitions rather than a half-written chart
    const names = allMatchupTypes();
    const rows: Record<string, any> = {};
    for (const att of names) {
        for (const def of names) {
            if (!customByName(att) && !customByName(def)) continue;
            const m = matchup(att, def);
            if (m !== 1) (rows[att] ||= {})[def] = m;
        }
    }
    injected = types.map(t => t.name);
    for (const t of types) {
        POKEMON_TYPES.push(t.name);
        // custom ones sit before ??? and Stellar in every picker
        const at = SELECTABLE_TYPES.indexOf('???');
        SELECTABLE_TYPES.splice(at === -1 ? SELECTABLE_TYPES.length : at, 0, t.name);
        TYPE_EFFECTIVENESS[t.name] = {};
    }
    for (const [att, row] of Object.entries<any>(rows)) Object.assign(TYPE_EFFECTIVENESS[att] ||= {}, row);

    writeTypeStyles();
    refreshTypeMenus();
    log.debug('TYPES', 'Custom types synced', { count: types.length, regionVersions: all.length - types.length });
}

function cssEscape(s) {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-z0-9-]/gi, '\\$&');
}

// custom types everywhere; a region's version of a type only while that
// region is the one you're looking at (body[data-active-region], set by regions.ts)
function writeTypeStyles() {
    let tag = document.getElementById('custom-type-styles');
    if (!tag) {
        tag = document.createElement('style');
        tag.id = 'custom-type-styles';
        document.head.appendChild(tag);
    }
    const rule = (sel, t) => `${sel} { background: ${typeBackground(t)}; color: #fff; }`;
    tag.textContent = [
        ...getCustomTypes().map(t => rule(`.type-${cssEscape(t.name.toLowerCase())}`, t)),
        ...allEntries().filter(t => t.vanillaOf && t.regionId).map(t =>
            rule(`body[data-active-region="${cssEscape(t.regionId)}"] .type-${cssEscape(t.vanillaOf.toLowerCase())}`, t))
    ].join('\n');
}

// the pickers built once at boot need rebuilding when the list changes;
// the React ones (the editor's typing) just redraw
function refreshTypeMenus() {
    notify();
}

// ---- the editor ----
// The dialog is js/app/dialogs/customType.tsx. It edits a draft
// ({ name, color, gradient: { angle, stops } | null, desc, icon, offense,
// defense, vanillaOf }) and hands it back here to be saved.

/** Opens the editor on a custom type (by id), a region's version of a main-game type (entry), or a new type. */
export function openCustomTypeEditor(id = '', entry: any = null) {
    // a region's version of a main-game type arrives as an unsaved entry (editVanillaType)
    const editing = entry || (id ? allEntries().find(t => t.id === id) || null : null);
    openDialog('custom-type', { entry: editing });
}

/** The draft the editor starts from. */
export function customTypeDraft(editing) {
    return {
        name: editing?.name || '',
        color: editing?.color || TYPE_COLORS[getCustomTypes().length % TYPE_COLORS.length],
        gradient: normalizeGradient(editing),
        desc: editing?.desc || '',
        icon: editing?.icon || '',
        vanillaOf: editing?.vanillaOf || null,
        offense: { ...(editing?.matchups?.offense || {}) },
        defense: { ...(editing?.matchups?.defense || {}) }
    };
}

/** Whether the editor offers Delete (or, for a region's version, "Use the original"). */
export function canDeleteCustomType(editing) {
    // an unsaved region version has nothing to undo yet
    return !!editing && (!editing.vanillaOf || isSaved(editing));
}

/** A fresh gradient from the draft's colour, for switching Gradient on. */
export function startGradient(color) {
    const second = TYPE_COLORS.find(c => c !== color) || '#3b82f6';
    return { angle: 90, stops: [{ color, pos: 0 }, { color: second, pos: 100 }] };
}

/** The colour a gradient has at a position, so a new stop doesn't change the look. */
export function colorAt(stops, pos) {
    const hex = c => { const m = /^#?([0-9a-f]{6})$/i.exec(c); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : null; };
    const right = stops.findIndex(s => s.pos >= pos);
    if (right <= 0) return stops[right === -1 ? stops.length - 1 : 0].color;
    const a = stops[right - 1], b = stops[right];
    const ca = hex(a.color), cb = hex(b.color);
    if (!ca || !cb) return a.color;
    const t = b.pos === a.pos ? 0 : (pos - a.pos) / (b.pos - a.pos);
    return '#' + ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

// ---- matchups: each type sorted into how effective it is ----
export const MATCHUP_GROUPS: Array<[number, string, string]> = [
    [4, 'Extremely effective', '×4'],
    [2, 'Super effective', '×2'],
    [1, 'Neutral', '×1'],
    [0.5, 'Not very effective', '×½'],
    [0, 'Immune', '×0']
];

/** Every type the draft is compared against, with the key its matchup is stored under, both ways. */
export function customTypeMatchups(draft, editing) {
    const others = draft.vanillaOf
        ? allMatchupTypes().filter(t => t !== draft.vanillaOf)
        : [...VANILLA, ...getCustomTypes().filter(t => t !== editing).map(t => t.name)];
    const selfKey = draft.vanillaOf || '__self';
    // a region's version starts from the main-game numbers; a new type from 1
    const base = (att, def) => (draft.vanillaOf ? matchup(att, def) : 1);
    const offense: Array<{ key: string; name: string; value: any; self?: boolean }> = others.map(other => ({ key: other, name: other, value: draft.offense[other] ?? base(draft.vanillaOf || '', other) }));
    // against itself it's one number both ways, so it only appears on the attacking board
    offense.push({ key: selfKey, name: draft.name || draft.vanillaOf || 'Itself', self: true, value: draft.offense[selfKey] ?? base(draft.vanillaOf || '', draft.vanillaOf) });
    const defense = others.map(other => ({
        key: other, name: other,
        value: draft.defense[other] ?? (draft.vanillaOf ? base(other, draft.vanillaOf) : (customByName(other)?.matchups?.offense?.[editing?.name] ?? 1))
    }));
    return { offense, defense };
}

/** The group a multiplier belongs in (anything unusual reads as neutral). */
export function matchupGroupOf(value) {
    const v = Number(value);
    return MATCHUP_GROUPS.find(([m]) => m === v) ? v : 1;
}

/** The draft with one matchup moved to another group. */
export function withMatchup(draft, kind, other, mult) {
    const map = { ...(kind === 'offense' ? draft.offense : draft.defense) };
    // a region's version keeps explicit 1s: they can undo a main-game weakness
    if (mult === 1 && !draft.vanillaOf) delete map[other]; else map[other] = mult;
    return { ...draft, [kind]: map };
}

/**
 * Saves the editor's draft over `editing` (or as a new type).
 * @returns a problem to show, or '' once it's saved
 */
export function saveCustomTypeDraft(editing, draft, regionIds: any[] = []): string {
    const desc = String(draft.desc || '').trim();
    const matchups = { offense: { ...draft.offense }, defense: { ...draft.defense } };
    const gradient = draft.gradient ? { angle: Number(draft.gradient.angle) || 0, stops: draft.gradient.stops.map(s => ({ color: s.color, pos: s.pos })) } : null;
    const look = { color: gradient ? gradient.stops[0].color : draft.color, gradient, icon: draft.icon || '' };

    if (draft.vanillaOf) {
        const regionName = api.getActiveRegion?.()?.name || 'The region';
        const candidate = { ...editing, desc, ...look, matchups };
        // only a real change makes it the region's own version (and marks it Edited)
        if (sameAsVanilla(candidate)) {
            const wasSaved = isSaved(editing);
            if (wasSaved) state.folders = (state.folders || []).filter(f => f !== editing);
            apply(wasSaved ? `${regionName}'s ${draft.vanillaOf} is back to the original.` : 'No changes to save.');
            return '';
        }
        Object.assign(editing, candidate, { updatedAt: Date.now() });
        if (!isSaved(editing)) state.folders = [...(state.folders || []), editing];
        apply(`${regionName}'s ${draft.vanillaOf} saved.`);
        return '';
    }

    const name = String(draft.name || '').trim();
    if (!NAME_RE.test(name)) return 'Type names are 2 to 16 letters, numbers or dashes, starting with a letter.';
    const clash = [...ALL_VANILLA_TYPES, ...getCustomTypes().filter(t => t !== editing).map(t => t.name)]
        .find(t => t.toLowerCase() === name.toLowerCase());
    if (clash) return `There is already a type called ${clash}.`;

    // the row against itself was edited under a placeholder key
    if (matchups.offense.__self !== undefined) { matchups.offense[name] = matchups.offense.__self; delete matchups.offense.__self; }
    const regionId = regionIds[0] || null;
    const oldName = editing?.name;
    if (editing) {
        Object.assign(editing, { name, desc, ...look, regionId, regionIds, matchups, updatedAt: Date.now() });
        if (oldName && oldName !== name) renameTypeEverywhere(oldName, name);
    } else {
        state.folders = [...(state.folders || []), {
            id: newTypeId(), type: CUSTOM_TYPE_KIND, name, desc, ...look, regionId, regionIds, matchups, createdAt: Date.now()
        }];
        log.info('TYPES', 'Created a custom type', { name });
    }
    apply(editing ? `${name} saved.` : `${name} created. It's now in every type picker.`);
    return '';
}

// after any change: the shared type data, storage, and whatever shows types
function apply(message) {
    syncCustomTypes(true);
    api.saveToStorage?.();
    api.renderCollection?.();
    api.updatePreview?.();
    api.showToast?.(message, 'success');
}

// a renamed type keeps every Fakemon, move and matchup that used the old name
function renameTypeEverywhere(from, to) {
    const swap = v => (v === from ? to : v);
    (state.fakemonDB || []).forEach(f => { f.type1 = swap(f.type1); f.type2 = swap(f.type2); });
    (state.customMoves || []).forEach(m => { m.type = swap(m.type); });
    for (const t of allEntries()) {
        for (const map of [t.matchups?.offense, t.matchups?.defense]) {
            if (map && map[from] !== undefined) { map[to] = map[from]; delete map[from]; }
        }
    }
}

/**
 * Deletes a custom type, or puts a region back on the original main-game type.
 * @returns whether it went (a confirm can say no)
 */
export async function deleteCustomType(editing): Promise<boolean> {
    if (!editing) return false;
    if (editing.vanillaOf) {
        // "Use the original": the region goes back to the main-game type
        state.folders = (state.folders || []).filter(f => f !== editing);
        apply(`Back to the original ${editing.vanillaOf}.`);
        return true;
    }
    const users = (state.fakemonDB || []).filter(f => f.type1 === editing.name || f.type2 === editing.name).length
        + (state.customMoves || []).filter(m => m.type === editing.name).length;
    const confirmFirst = api.getConfirmBeforeDelete?.() !== false;
    if (confirmFirst && !await confirmDialog({ title: `Delete the ${editing.name} type?`, message: users ? `${users} Fakémon and moves use it. They keep the name, but it won't have a colour or matchups any more.` : 'Nothing uses it yet.' })) return false;
    const name = editing.name;
    state.folders = (state.folders || []).filter(f => f !== editing);
    for (const t of allEntries()) {
        delete t.matchups?.offense?.[name];
        delete t.matchups?.defense?.[name];
    }
    apply(`Deleted ${name}.`);
    return true;
}

// a main-game type as it is, in the shape of a region's version of it
function vanillaTypeEntry(name, regionId) {
    const offense: Record<string, any> = {}, defense: Record<string, any> = {};
    for (const other of allMatchupTypes()) {
        offense[other] = matchup(name, other);
        defense[other] = matchup(other, name);
    }
    const gradient = VANILLA_GRADIENTS[name] ? JSON.parse(JSON.stringify(VANILLA_GRADIENTS[name])) : null;
    return {
        id: newTypeId(),
        type: CUSTOM_TYPE_KIND, name, vanillaOf: name, regionId,
        color: gradient ? gradient.stops[0].color : (VANILLA_COLORS[name] || '#888888'), gradient, desc: '', icon: '',
        matchups: { offense, defense }, createdAt: Date.now()
    };
}

function isSaved(entry) {
    return (state.folders || []).includes(entry);
}

// whether a region's version would change nothing about the main-game type
function sameAsVanilla(entry) {
    const base = vanillaTypeEntry(entry.vanillaOf, entry.regionId);
    const look = t => JSON.stringify([typeBackground(t), t.icon || '', String(t.desc || '').trim()]);
    if (look(entry) !== look(base)) return false;
    // matchups are compared as the chart reads them, so an explicit 1 equals a missing one
    for (const other of allMatchupTypes()) {
        for (const side of ['offense', 'defense']) {
            const mine = entry.matchups?.[side]?.[other];
            const orig = base.matchups[side][other];
            if ((mine === undefined ? orig : Number(mine)) !== orig) return false;
        }
    }
    return true;
}

/**
 * A region's own version of a main-game type, created on first edit from the
 * main-game matchups, then opened in the editor.
 */
export function editVanillaType(name) {
    const region = api.getActiveRegion?.();
    if (!region) {
        api.showToast?.(`Pick a region in the sidebar to give it its own version of ${name}.`, 'info');
        return;
    }
    // opening it changes nothing: the region's version is only kept once saved with a change
    const entry = overrideFor(name, region.id) || vanillaTypeEntry(name, region.id);
    openCustomTypeEditor(entry.id, entry);
}

// ---- the card actions on the Types tab ----
function findType(id) { return getCustomTypes().find(t => t.id === id) || null; }

// the first free name like Cosmic-2, kept inside the 16-character limit
function freeTypeName(base) {
    const taken = new Set([...ALL_VANILLA_TYPES, ...getCustomTypes().map(t => t.name)].map(n => n.toLowerCase()));
    for (let i = 2; i < 100; i++) {
        const suffix = `-${i}`;
        const name = String(base).replace(/[^A-Za-z0-9-]/g, '').slice(0, 16 - suffix.length) + suffix;
        if (!taken.has(name.toLowerCase())) return name;
    }
    return `Type-${Date.now().toString(36).slice(-5)}`;
}

function newTypeId() { return `ctype_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

export function toggleCustomTypePin(id, event) {
    event?.stopPropagation();
    const t = findType(id);
    if (!t) return;
    t.pinned = !t.pinned;
    api.saveToStorage?.();
    api.renderCollection?.();
    api.showToast?.(t.pinned ? `"${t.name}" pinned!` : `"${t.name}" unpinned!`, 'success');
}

export function duplicateCustomType(id, event) {
    event?.stopPropagation();
    const t = findType(id);
    if (!t) return;
    const copy = { ...JSON.parse(JSON.stringify(t)), id: newTypeId(), name: freeTypeName(t.name), pinned: false, createdAt: Date.now() };
    // its matchup against itself follows the new name
    if (copy.matchups?.offense?.[t.name] !== undefined) copy.matchups.offense[copy.name] = copy.matchups.offense[t.name];
    state.folders = [...(state.folders || []), copy];
    apply(`${t.name} duplicated as ${copy.name}.`);
}

/** A main-game type as a new custom type of your own. */
export function duplicateVanillaType(name, event) {
    event?.stopPropagation();
    const region = api.getActiveRegion?.();
    const base = overrideFor(name, region?.id) || vanillaTypeEntry(name, region?.id || null);
    const copy: CustomType = {
        id: newTypeId(), type: CUSTOM_TYPE_KIND, name: freeTypeName(name), desc: base.desc || '',
        color: base.color, gradient: base.gradient ? JSON.parse(JSON.stringify(base.gradient)) : null, icon: base.icon || '',
        regionId: region?.id || null, regionIds: region ? [region.id] : [],
        matchups: JSON.parse(JSON.stringify(base.matchups)), createdAt: Date.now()
    };
    state.folders = [...(state.folders || []), copy];
    apply(`${copy.name} created from ${name}.`);
}

function downloadType(entry) {
    const { id, regionId, regionIds, vanillaOf, pinned, ...type } = entry;
    const payload = { format: 'woogidex-custom-type', version: 1, exportedAt: new Date().toISOString(), item: type };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${String(type.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'type'}-custom-type.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    api.showToast?.(`${type.name} exported!`, 'success');
}

export function exportCustomType(id, event) {
    event?.stopPropagation();
    const t = findType(id);
    if (t) downloadType(t);
}

export function exportVanillaType(name, event) {
    event?.stopPropagation();
    const region = api.getActiveRegion?.();
    downloadType(overrideFor(name, region?.id) || vanillaTypeEntry(name, null));
}

/** Adds a type from an exported file; a name that's taken gets a free one. */
export function importCustomTypeEntry(item) {
    if (!item?.name) throw new Error('Invalid custom type.');
    const clash = [...ALL_VANILLA_TYPES, ...getCustomTypes().map(t => t.name)].some(n => n.toLowerCase() === String(item.name).toLowerCase());
    const region = api.getActiveRegion?.();
    const entry = {
        ...JSON.parse(JSON.stringify(item)), id: newTypeId(), type: CUSTOM_TYPE_KIND,
        name: clash ? freeTypeName(item.name) : item.name,
        regionId: region?.id || null, regionIds: region ? [region.id] : [], createdAt: Date.now()
    };
    delete entry.vanillaOf;
    state.folders = [...(state.folders || []), entry];
    syncCustomTypes(true);
    return entry;
}

export function deleteCustomTypeById(id, event) {
    event?.stopPropagation();
    deleteCustomType(findType(id));
}

// ---- the Types tab ----
// Drawn by js/app/components/collection/TypesTab.tsx; these are the numbers on its cards.

/**
 * How many types this one hits super-effectively, and how many hit it.
 * @param name @param [regionId]
 */
export function typeStrength(name: string, regionId: string|null = null) {
    const all = [...ALL_VANILLA_TYPES, ...getCustomTypes().map(t => t.name)].filter(x => x !== name);
    return {
        strong: all.filter(d => matchup(name, d, regionId) >= 2).length,
        weak: all.filter(a => matchup(a, name, regionId) >= 2).length
    };
}

/** How many of your Fakémon have the type. */
export function typeUserCount(name) {
    return (state.fakemonDB || []).filter(f => !f.pendingVanilla && (f.type1 === name || f.type2 === name)).length;
}

// ---- exports: Showdown typechart.ts and Essentials types.txt ----
// Showdown damageTaken codes; it has no ×4 for a single type, so that exports as a weakness
const SD_CODE = m => (m >= 2 ? 1 : m === 0.5 ? 2 : m === 0 ? 3 : 0);

/**
 * A Showdown mod typechart: every type, custom ones included, using the
 * region's own versions of main-game types when it has any.
 * @returns null when nothing differs from the main games
 */
export function buildShowdownTypechart(customList, regionId: any = null): string|null {
    if (!customList?.length && !getTypeOverrides(regionId).length) return null;
    const all = [...VANILLA, ...(customList || []).map(t => t.name)];
    const lines = all.map(def => {
        const taken = all.map(att => `${JSON.stringify(att)}: ${SD_CODE(matchup(att, def, regionId))}`).join(', ');
        return `\t${def.toLowerCase().replace(/[^a-z0-9]/g, '')}: {\n\t\tname: ${JSON.stringify(def)},\n\t\tdamageTaken: { ${taken} },\n\t},`;
    });
    return `// Generated by Woogidex: every type in this mod, custom ones included.\n// damageTaken: 0 = normal, 1 = weakness, 2 = resistance, 3 = immunity.\nexport const TypeChart: import('../../../sim/dex-data').ModdedTypeDataTable = {\n${lines.join('\n')}\n};\n`;
}

/** Pokemon Essentials PBS/types.txt entries for the custom types only. */
export function buildEssentialsTypes(customList, regionId: any = null) {
    if (!customList?.length) return null;
    const id = n => n.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const all = allMatchupTypes();
    return customList.map((t, i) => {
        const from = m => all.filter(a => matchup(a, t.name, regionId) === m).map(id).join(',');
        const lines = [`[${id(t.name)}]`, `Name = ${t.name}`, `IconPosition = ${19 + i}`];
        if (from(2)) lines.push(`Weaknesses = ${from(2)}`);
        if (from(0.5)) lines.push(`Resistances = ${from(0.5)}`);
        if (from(0)) lines.push(`Immunities = ${from(0)}`);
        return lines.join('\r\n');
    }).join('\r\n#-------------------------------\r\n') + '\r\n';
}
