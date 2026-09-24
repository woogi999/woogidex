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
// regions live in (see js/features/regions.js), so custom types travel with
// every save, JSON export/import and cloud backup without a schema change.
//
// Wiring: rather than teach every consumer about custom types, syncCustomTypes()
// writes them into the shared type data in place -- POKEMON_TYPES,
// SELECTABLE_TYPES and TYPE_EFFECTIVENESS from js/core/data.js -- so the
// editor's weakness chart, the analysis tab, move suggestions and the battle
// engine all see them. It also writes a <style> rule per type so every
// existing `.type-<name>` pill and badge gets its colour.

import { log } from '../core/log.js';
import { state, api } from '../core/app.js';
import { confirmDialog } from '../core/confirm-dialog.js';
import { esc } from '../core/html.js';
import { POKEMON_TYPES, SELECTABLE_TYPES, TYPE_EFFECTIVENESS } from '../core/data.js';
import { iconSvg } from '../core/icons.js';

export const CUSTOM_TYPE_KIND = 'custom-type';
const VANILLA = POKEMON_TYPES.slice();          // the 18, captured before anything is added
/** Every main-game type: the 18, plus ??? (typeless) and Stellar (Tera). Both are neutral. */
export const ALL_VANILLA_TYPES = [...VANILLA, '???', 'Stellar'];
const MULT_LABEL = { 0: '0', 0.5: '½', 1: '1', 2: '2', 4: '4' };
const NAME_RE = /^[A-Za-z][A-Za-z0-9-]{1,15}$/;
const TYPE_COLORS = ['#e07a5f', '#7c5cff', '#2bb3a8', '#e6a23c', '#3b82f6', '#c056d8', '#5aa469', '#d64f7a', '#6b7280'];
const ANGLES = [[90, 'Left to right'], [135, 'Diagonal'], [180, 'Top to bottom']];
// an arrow pointing the way the gradient runs (CSS angles: 90deg is left to right)
const angleArrow = deg => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" style="transform:rotate(${deg - 90}deg)"><path d="M4 12h15M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const MAX_STOPS = 8;
// Stellar is the one main-game type drawn as a gradient (css/controls.css .type-stellar)
const STELLAR_STOPS = [['#f06a8e', 0], ['#f5a55a', 28], ['#e8d35a', 48], ['#6cc8a0', 68], ['#5d8fe8', 88], ['#9a6cf0', 100]];
const VANILLA_GRADIENTS = { Stellar: { angle: 100, stops: STELLAR_STOPS.map(([color, pos]) => ({ color, pos })) } };
const GRADIENT_PRESETS = [
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
// Stellar have none, so they get a question mark and a sparkle.
const TYPE_ICON_FILES = new Set(['bug', 'dark', 'dragon', 'electric', 'fairy', 'fighting', 'fire', 'flying', 'ghost',
    'grass', 'ground', 'ice', 'normal', 'poison', 'psychic', 'rock', 'steel', 'water']);

/** The symbol inside a type's emblem: an uploaded icon, the main-game symbol, or its initials. */
export function typeIconHtml(name, entry = null) {
    if (entry?.icon) return `<img src="${esc(entry.icon)}" alt="" draggable="false">`;
    const key = String(name).toLowerCase();
    if (TYPE_ICON_FILES.has(key)) return `<img src="assets/types/${key}.svg" alt="" draggable="false">`;
    if (name === 'Stellar') return iconSvg('sparkles');
    if (name === '???') return '<span class="type-emblem-text">?</span>';
    return `<span class="type-emblem-text">${esc(String(name).slice(0, 2))}</span>`;
}

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

function customByName(name) {
    const key = String(name || '').toLowerCase();
    return getCustomTypes().find(t => t.name.toLowerCase() === key) || null;
}

function overrideFor(name, regionId) {
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
function normalizeGradient(t) {
    const stops = gradientStops(t);
    if (!stops) return null;
    const angle = Number(t.gradient.angle);
    return { angle: Number.isFinite(angle) ? angle : 90, stops };
}

// names added to the shared chart by the last sync, so they can be told apart
// from (and taken back out of) the main-game rows
let injected = [];
let lastSignature = '';

/**
 * attacker vs defender. Inside a region, its own version of a type wins.
 * Then a custom attacker's offense row, then a custom defender's defense row,
 * then the main-game chart.
 */
export function matchup(att, def, regionId = null) {
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
        for (const row of Object.values(TYPE_EFFECTIVENESS)) delete row[name];
    }
    injected = [];

    // matchups are read before any row is written, so custom-vs-custom resolves
    // from the custom definitions rather than a half-written chart
    const names = allMatchupTypes();
    const rows = {};
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
    for (const [att, row] of Object.entries(rows)) Object.assign(TYPE_EFFECTIVENESS[att] ||= {}, row);

    writeTypeStyles();
    refreshTypeMenus();
    log.debug('TYPES', 'Custom types synced', { count: types.length, regionVersions: all.length - types.length });
}

function cssEscape(s) {
    return window.CSS?.escape ? CSS.escape(s) : String(s).replace(/[^a-z0-9-]/gi, '\\$&');
}

// custom types everywhere; a region's version of a type only while that
// region is the one you're looking at (body[data-active-region], set by regions.js)
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

// the pickers built once at boot need rebuilding when the list changes
function refreshTypeMenus() {
    const makeOption = (type, id) => type
        ? `<div class="type-dropdown-option" onclick="selectType('${id}', '${esc(type)}'); event.stopPropagation();"><span class="type-pill type-${esc(type.toLowerCase())}">${esc(type)}</span></div>`
        : `<div class="type-dropdown-option" onclick="selectType('${id}', ''); event.stopPropagation();"><span>None</span></div>`;
    for (const id of ['type1', 'type2']) {
        const menu = document.getElementById(`${id}-menu`);
        if (menu) menu.innerHTML = makeOption('', id) + SELECTABLE_TYPES.map(t => makeOption(t, id)).join('');
    }
    const learnsetTypeMenu = document.getElementById('learnset-filter-type-menu');
    if (learnsetTypeMenu && api.buildTypeMenuOptions) {
        learnsetTypeMenu.innerHTML = api.buildTypeMenuOptions(t => `selectLearnsetTypeFilter('${t}')`, true, 'All Types');
    }
    // the custom move form builds its menu once, on first open; empty it so it rebuilds
    const moveMenu = document.getElementById('custom-move-type-menu');
    if (moveMenu) moveMenu.innerHTML = '';
}

// ---- the editor panel ----
let editing = null;       // the entry being edited, or null for a new one
let draft = null;         // { name, color, gradient: { angle, stops } | null, desc, offense, defense, vanillaOf }
let selectedStop = 0;     // which gradient stop the colour swatches edit
let lastGradient = null;  // a gradient switched off and back on comes back as it was

export function openCustomTypeEditor(id = '', entry = null) {
    // a region's version of a main-game type arrives as an unsaved entry (editVanillaType)
    editing = entry || (id ? allEntries().find(t => t.id === id) || null : null);
    const vanillaOf = editing?.vanillaOf || null;
    selectedStop = 0;
    lastGradient = null;
    pickedChip = null;
    draft = {
        name: editing?.name || '',
        color: editing?.color || TYPE_COLORS[getCustomTypes().length % TYPE_COLORS.length],
        gradient: normalizeGradient(editing),
        desc: editing?.desc || '',
        vanillaOf,
        offense: { ...(editing?.matchups?.offense || {}) },
        defense: { ...(editing?.matchups?.defense || {}) }
    };
    const modal = document.getElementById('custom-type-modal');
    if (!modal) return;
    document.getElementById('custom-type-modal-title').textContent = vanillaOf
        ? `${api.getActiveRegion?.()?.name || 'This region'}'s ${vanillaOf}`
        : (editing ? 'Edit custom type' : 'New custom type');
    const nameInput = document.getElementById('custom-type-name');
    nameInput.value = draft.name;
    // a region's version of Fire is still called Fire
    nameInput.disabled = !!vanillaOf;
    document.getElementById('custom-type-desc').value = draft.desc;
    const del = document.getElementById('custom-type-delete-btn');
    // an unsaved region version has nothing to undo yet
    del.style.display = editing && (!vanillaOf || isSaved(editing)) ? '' : 'none';
    // a region's version isn't deleted so much as undone
    del.innerHTML = `<i data-lucide="${vanillaOf ? 'rotate-ccw' : 'trash-2'}"></i><span>${vanillaOf ? 'Use the original' : 'Delete'}</span>`;
    // a region's version belongs to that region by definition
    const assign = document.querySelector('#custom-type-modal .region-assign');
    if (assign) assign.hidden = !!vanillaOf;
    api.fillEntityRegionSelect?.('custom-type-region', editing || api.defaultRegionForNewFakemon?.() || '');
    api.setEntityArt?.('custom-type', editing?.icon || '');
    renderTypeColorOptions();
    renderMatchupEditor();
    modal.classList.add('active', 'as-sheet');
    if (typeof lucide !== 'undefined') lucide.createIcons();
    if (!vanillaOf) setTimeout(() => nameInput.focus(), 60);
}

function colorSwatches(current, handler) {
    return TYPE_COLORS.map(hex => `<button type="button" class="color-option${hex === current ? ' selected' : ''}" style="background-color:${hex}" aria-label="Colour ${hex}" onclick="${handler}('${hex}')"></button>`).join('')
        + `<label class="color-option color-option-custom${TYPE_COLORS.includes(current) ? '' : ' selected'}" title="Pick any colour" style="background-color:${TYPE_COLORS.includes(current) ? 'transparent' : esc(current)}"><i data-lucide="pipette"></i><input type="color" value="${esc(current)}" oninput="${handler}(this.value)"></label>`;
}

// the stops, left to right, as the bar under the editor shows them
function stopsBarBackground(stops) {
    return `linear-gradient(90deg, ${stops.map(s => `${s.color} ${s.pos}%`).join(', ')})`;
}

function renderTypeColorOptions() {
    const host = document.getElementById('custom-type-colors');
    if (!host) return;
    const g = draft.gradient;
    const mode = `<div class="seg type-fill-mode" role="radiogroup" aria-label="Fill">
            <button type="button" role="radio" aria-checked="${!g}" class="seg-btn${g ? '' : ' on'}" onclick="toggleCustomTypeGradient(false)">Solid</button>
            <button type="button" role="radio" aria-checked="${!!g}" class="seg-btn${g ? ' on' : ''}" onclick="toggleCustomTypeGradient(true)">Gradient</button>
        </div>`;
    if (!g) {
        host.innerHTML = `${mode}<div class="type-color-row">${colorSwatches(draft.color, 'setCustomTypeColor')}</div>`;
    } else {
        selectedStop = Math.min(selectedStop, g.stops.length - 1);
        const stop = g.stops[selectedStop];
        host.innerHTML = `${mode}
        <div class="type-gradient-opts">
            <span class="type-gradient-label">Presets</span>
            <div class="type-gradient-presets">${GRADIENT_PRESETS.map(([label, angle, stops], i) => {
                const bg = `linear-gradient(${angle}deg, ${stops.map(([c, p]) => `${c} ${p}%`).join(', ')})`;
                return `<button type="button" class="type-gradient-preset" style="background:${bg}" title="${label}" aria-label="${label} preset" onclick="applyTypeGradientPreset(${i})"></button>`;
            }).join('')}</div>
            <span class="type-gradient-label">Stops <small>click the bar to add one, drag to move</small></span>
            <div class="type-gradient-bar" id="type-gradient-bar" style="background:${stopsBarBackground(g.stops)}" onpointerdown="typeGradientBarDown(event)">
                ${g.stops.map((s, i) => `<button type="button" class="type-gradient-stop${i === selectedStop ? ' on' : ''}" style="left:${s.pos}%;--stop:${esc(s.color)}" aria-label="Stop ${i + 1} at ${s.pos}%" data-stop="${i}" onpointerdown="typeGradientStopDown(event, ${i})"></button>`).join('')}
            </div>
            <div class="type-gradient-stop-edit">
                <span class="type-gradient-label">Stop ${selectedStop + 1} colour</span>
                <div class="type-color-row">${colorSwatches(stop.color, 'setCustomTypeStopColor')}</div>
                <div class="type-gradient-stop-row">
                    <label class="type-gradient-pos">Position <input type="number" min="0" max="100" value="${stop.pos}" onchange="setCustomTypeStopPos(this.value)">%</label>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="removeCustomTypeStop()" ${g.stops.length <= 2 ? 'disabled' : ''}><i data-lucide="trash-2"></i><span>Remove stop</span></button>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="reverseCustomTypeGradient()"><i data-lucide="refresh-cw"></i><span>Reverse</span></button>
                </div>
            </div>
            <span class="type-gradient-label">Direction</span>
            <div class="type-gradient-angle">
                <div class="seg">${ANGLES.map(([deg, label]) => `<button type="button" class="seg-btn${Number(g.angle) === deg ? ' on' : ''}" title="${label}" aria-label="${label}" onclick="setCustomTypeAngle(${deg})">${angleArrow(deg)}</button>`).join('')}</div>
                <input type="range" min="0" max="360" step="5" value="${Number(g.angle)}" aria-label="Angle in degrees" oninput="setCustomTypeAngle(this.value, true)">
                <span class="type-gradient-angle-value" id="type-gradient-angle-value">${Number(g.angle)}°</span>
            </div>
        </div>`;
    }
    paintTypePreviews();
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// the live previews only; cheap enough to run on every drag frame
function paintTypePreviews() {
    const bg = typeBackground(draft);
    const preview = document.getElementById('custom-type-preview');
    if (preview) {
        preview.textContent = draft.name || 'Preview';
        preview.style.background = bg;
    }
    // the icon previews on the type's own colour, where it will actually sit
    const iconPreview = document.getElementById('custom-type-art-preview');
    if (iconPreview) iconPreview.style.background = bg;
    // the self row of the matchup table shows the type's colour too
    document.querySelectorAll('#custom-type-matchups .type-badge[data-self]').forEach(el => { el.style.background = bg; });
}

// the first stop doubles as the type's plain colour, for anything that only takes one
function syncColorFromStops() {
    if (draft.gradient) draft.color = draft.gradient.stops[0].color;
}

export function setCustomTypeColor(hex) { draft.color = hex; renderTypeColorOptions(); }
export function setCustomTypeStopColor(hex) {
    const stop = draft.gradient?.stops[selectedStop];
    if (!stop) return;
    stop.color = hex;
    syncColorFromStops();
    renderTypeColorOptions();
}
export function setCustomTypeStopPos(value) {
    const stop = draft.gradient?.stops[selectedStop];
    if (!stop) return;
    stop.pos = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    sortStopsKeepingSelection(stop);
    renderTypeColorOptions();
}
export function setCustomTypeAngle(deg, live = false) {
    if (!draft.gradient) return;
    draft.gradient.angle = Number(deg) || 0;
    if (live) {
        // dragging the slider: repaint without rebuilding the slider under the pointer
        const label = document.getElementById('type-gradient-angle-value');
        if (label) label.textContent = `${draft.gradient.angle}°`;
        document.querySelectorAll('.type-gradient-angle .seg-btn').forEach((b, i) => b.classList.toggle('on', ANGLES[i][0] === draft.gradient.angle));
        paintTypePreviews();
        return;
    }
    renderTypeColorOptions();
}
export function toggleCustomTypeGradient(on) {
    if (on && !draft.gradient) {
        const second = TYPE_COLORS.find(c => c !== draft.color) || '#3b82f6';
        draft.gradient = lastGradient || { angle: 90, stops: [{ color: draft.color, pos: 0 }, { color: second, pos: 100 }] };
        selectedStop = 0;
        syncColorFromStops();
    } else if (!on && draft.gradient) {
        lastGradient = draft.gradient;
        draft.gradient = null;
    }
    renderTypeColorOptions();
}
export function applyTypeGradientPreset(index) {
    const preset = GRADIENT_PRESETS[index];
    if (!preset) return;
    draft.gradient = { angle: preset[1], stops: preset[2].map(([color, pos]) => ({ color, pos })) };
    selectedStop = 0;
    syncColorFromStops();
    renderTypeColorOptions();
}
export function removeCustomTypeStop() {
    const g = draft.gradient;
    if (!g || g.stops.length <= 2) return;
    g.stops.splice(selectedStop, 1);
    selectedStop = Math.max(0, selectedStop - 1);
    syncColorFromStops();
    renderTypeColorOptions();
}
export function reverseCustomTypeGradient() {
    const g = draft.gradient;
    if (!g) return;
    g.stops = g.stops.map(s => ({ color: s.color, pos: 100 - s.pos })).reverse();
    selectedStop = g.stops.length - 1 - selectedStop;
    syncColorFromStops();
    renderTypeColorOptions();
}

function sortStopsKeepingSelection(stop) {
    draft.gradient.stops.sort((a, b) => a.pos - b.pos);
    selectedStop = draft.gradient.stops.indexOf(stop);
    syncColorFromStops();
}

// the colour a gradient has at a position, so a new stop doesn't change the look
function colorAt(stops, pos) {
    const hex = c => { const m = /^#?([0-9a-f]{6})$/i.exec(c); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : null; };
    const right = stops.findIndex(s => s.pos >= pos);
    if (right <= 0) return stops[right === -1 ? stops.length - 1 : 0].color;
    const a = stops[right - 1], b = stops[right];
    const ca = hex(a.color), cb = hex(b.color);
    if (!ca || !cb) return a.color;
    const t = b.pos === a.pos ? 0 : (pos - a.pos) / (b.pos - a.pos);
    return '#' + ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

function barPos(event) {
    const bar = document.getElementById('type-gradient-bar');
    const rect = bar.getBoundingClientRect();
    return Math.max(0, Math.min(100, Math.round(((event.clientX - rect.left) / rect.width) * 100)));
}

/** Clicking empty bar adds a stop there, in the colour the gradient already has at that spot. */
export function typeGradientBarDown(event) {
    const g = draft?.gradient;
    if (!g || event.target.closest('.type-gradient-stop')) return;
    if (g.stops.length >= MAX_STOPS) { api.showToast?.(`A gradient can have up to ${MAX_STOPS} stops.`, 'info'); return; }
    const pos = barPos(event);
    const stop = { color: colorAt(g.stops, pos), pos };
    g.stops.push(stop);
    sortStopsKeepingSelection(stop);
    renderTypeColorOptions();
    // carry straight on into a drag, so click-and-drag places it in one go
    const handle = document.querySelector(`.type-gradient-stop[data-stop="${selectedStop}"]`);
    if (handle) typeGradientStopDown(event, selectedStop, handle);
}

/** Dragging a stop along the bar; only the previews repaint until it's let go. */
export function typeGradientStopDown(event, index, handleEl = null) {
    const g = draft?.gradient;
    if (!g) return;
    event.preventDefault();
    event.stopPropagation();
    const stop = g.stops[index];
    if (selectedStop !== index) {
        selectedStop = index;
        renderTypeColorOptions();
    }
    const handle = handleEl || document.querySelector(`.type-gradient-stop[data-stop="${index}"]`);
    const bar = document.getElementById('type-gradient-bar');
    if (!handle || !bar) return;
    handle.setPointerCapture?.(event.pointerId);
    const move = e => {
        stop.pos = barPos(e);
        handle.style.left = `${stop.pos}%`;
        bar.style.background = stopsBarBackground([...g.stops].sort((a, b) => a.pos - b.pos));
        const posInput = document.querySelector('.type-gradient-pos input');
        if (posInput) posInput.value = stop.pos;
        paintTypePreviews();
    };
    const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        sortStopsKeepingSelection(stop);
        renderTypeColorOptions();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
}

export function customTypeNameInput(value) {
    draft.name = value.trim();
    const preview = document.getElementById('custom-type-preview');
    if (preview) preview.textContent = draft.name || 'Preview';
    renderMatchupEditor();
}

// ---- matchups: drag each type into how effective it is ----
// Two boards, one per direction, each with five groups. A type chip is dragged
// (mouse or finger) from one group to another; tapping a chip and then a
// group does the same, for anyone who'd rather not drag.
const MATCHUP_GROUPS = [
    [4, 'Extremely effective', '×4'],
    [2, 'Super effective', '×2'],
    [1, 'Neutral', '×1'],
    [0.5, 'Not very effective', '×½'],
    [0, 'Immune', '×0']
];
let pickedChip = null;    // { kind, key } picked by a tap, waiting for a group

// every type this one is compared against, with the key its matchup is stored under
function matchupEntries() {
    const others = draft.vanillaOf
        ? allMatchupTypes().filter(t => t !== draft.vanillaOf)
        : [...VANILLA, ...getCustomTypes().filter(t => t !== editing).map(t => t.name)];
    const selfKey = draft.vanillaOf || '__self';
    // a region's version starts from the main-game numbers; a new type from 1
    const base = (att, def) => (draft.vanillaOf ? matchup(att, def) : 1);
    const offense = others.map(other => ({ key: other, name: other, value: draft.offense[other] ?? base(draft.vanillaOf || '', other) }));
    // against itself it's one number both ways, so it only appears on the attacking board
    offense.push({ key: selfKey, name: draft.name || draft.vanillaOf || 'Itself', self: true, value: draft.offense[selfKey] ?? base(draft.vanillaOf || '', draft.vanillaOf) });
    const defense = others.map(other => ({
        key: other, name: other,
        value: draft.defense[other] ?? (draft.vanillaOf ? base(other, draft.vanillaOf) : (customByName(other)?.matchups?.offense?.[editing?.name] ?? 1))
    }));
    return { offense, defense };
}

function groupOf(value) {
    const v = Number(value);
    return MATCHUP_GROUPS.find(([m]) => m === v) ? v : 1;
}

function matchupBoard(kind, entries) {
    const self = esc(draft.name || draft.vanillaOf || 'this type');
    const title = kind === 'offense' ? `When ${self} attacks` : `When ${self} is attacked`;
    const hint = kind === 'offense' ? 'How much damage its moves do to each type.' : 'How much damage each type does to it.';
    const chip = e => {
        const picked = pickedChip && pickedChip.kind === kind && pickedChip.key === e.key;
        const style = e.self ? ` data-self style="background:${esc(typeBackground(draft))}"` : '';
        return `<button type="button" class="type-badge type-group-chip type-${esc(e.self ? '' : e.name.toLowerCase())}${picked ? ' picked' : ''}"${style}
            data-kind="${kind}" data-key="${esc(e.key)}" onpointerdown="typeChipPointerDown(event)" aria-label="${esc(e.name)}${e.self ? ' (itself)' : ''}">${esc(e.name)}</button>`;
    };
    return `<section class="type-group-board" data-kind="${kind}">
        <header><h4>${title}</h4><p>${hint}</p></header>
        ${MATCHUP_GROUPS.map(([m, label, short]) => {
            const inGroup = entries.filter(e => groupOf(e.value) === m);
            return `<div class="type-group-zone mult-${String(m).replace('.', '')}" data-kind="${kind}" data-mult="${m}" onclick="dropPickedTypeChip(this)">
                <div class="type-group-label"><strong>${short}</strong><span>${label}</span><em>${inGroup.length}</em></div>
                <div class="type-group-chips">${inGroup.map(chip).join('') || '<span class="type-group-empty">Drop types here</span>'}</div>
            </div>`;
        }).join('')}
    </section>`;
}

function renderMatchupEditor() {
    const host = document.getElementById('custom-type-matchups');
    if (!host || !draft) return;
    const { offense, defense } = matchupEntries();
    host.innerHTML = `<div class="type-group-boards">${matchupBoard('offense', offense)}${matchupBoard('defense', defense)}</div>`;
}

export function setCustomTypeMatchup(kind, other, mult) {
    if (!draft) return;
    const map = kind === 'offense' ? draft.offense : draft.defense;
    // a region's version keeps explicit 1s: they can undo a main-game weakness
    if (mult === 1 && !draft.vanillaOf) delete map[other]; else map[other] = mult;
    renderMatchupEditor();
}

/** Tap a chip, then a group: the no-drag way to move one. */
export function dropPickedTypeChip(zone) {
    if (!pickedChip || zone.dataset.kind !== pickedChip.kind) return;
    const { kind, key } = pickedChip;
    pickedChip = null;
    setCustomTypeMatchup(kind, key, Number(zone.dataset.mult));
}

/** Drags a chip to another group; a press that doesn't move is a tap. */
export function typeChipPointerDown(event) {
    const chip = event.currentTarget;
    const kind = chip.dataset.kind, key = chip.dataset.key;
    event.stopPropagation();
    const startX = event.clientX, startY = event.clientY;
    let ghost = null, over = null;
    const zoneAt = (x, y) => {
        const el = document.elementFromPoint(x, y)?.closest('.type-group-zone');
        return el && el.dataset.kind === kind ? el : null;
    };
    const move = e => {
        if (!ghost) {
            if (Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
            ghost = chip.cloneNode(true);
            ghost.classList.add('type-group-ghost');
            document.body.appendChild(ghost);
            chip.classList.add('dragging');
        }
        e.preventDefault();
        ghost.style.left = `${e.clientX}px`;
        ghost.style.top = `${e.clientY}px`;
        const zone = zoneAt(e.clientX, e.clientY);
        if (zone !== over) { over?.classList.remove('drag-over'); over = zone; over?.classList.add('drag-over'); }
    };
    const up = e => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        over?.classList.remove('drag-over');
        chip.classList.remove('dragging');
        if (ghost) {
            ghost.remove();
            const zone = e.type === 'pointerup' ? zoneAt(e.clientX, e.clientY) : null;
            if (zone) { pickedChip = null; setCustomTypeMatchup(kind, key, Number(zone.dataset.mult)); }
            return;
        }
        // a tap: pick it up (or put it back down)
        pickedChip = pickedChip && pickedChip.kind === kind && pickedChip.key === key ? null : { kind, key };
        renderMatchupEditor();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
}

export function saveCustomType() {
    const desc = document.getElementById('custom-type-desc').value.trim();
    const matchups = { offense: { ...draft.offense }, defense: { ...draft.defense } };
    const gradient = draft.gradient ? { angle: Number(draft.gradient.angle) || 0, stops: draft.gradient.stops.map(s => ({ color: s.color, pos: s.pos })) } : null;
    const look = { color: gradient ? gradient.stops[0].color : draft.color, gradient, icon: api.readEntityArt?.('custom-type') || '' };

    if (draft.vanillaOf) {
        const regionName = api.getActiveRegion?.()?.name || 'The region';
        const candidate = { ...editing, desc, ...look, matchups };
        // only a real change makes it the region's own version (and marks it Edited)
        if (sameAsVanilla(candidate)) {
            const wasSaved = isSaved(editing);
            if (wasSaved) state.folders = (state.folders || []).filter(f => f !== editing);
            editing = null;
            closeAndApply(wasSaved ? `${regionName}'s ${draft.vanillaOf} is back to the original.` : 'No changes to save.');
            return;
        }
        Object.assign(editing, candidate, { updatedAt: Date.now() });
        if (!isSaved(editing)) state.folders = [...(state.folders || []), editing];
        closeAndApply(`${regionName}'s ${draft.vanillaOf} saved.`);
        return;
    }

    const name = document.getElementById('custom-type-name').value.trim();
    if (!NAME_RE.test(name)) {
        api.showToast?.('Type names are 2 to 16 letters, numbers or dashes, starting with a letter.', 'error');
        return;
    }
    const clash = [...ALL_VANILLA_TYPES, ...getCustomTypes().filter(t => t !== editing).map(t => t.name)]
        .find(t => t.toLowerCase() === name.toLowerCase());
    if (clash) { api.showToast?.(`There is already a type called ${clash}.`, 'error'); return; }

    // the row against itself was edited under a placeholder key
    if (matchups.offense.__self !== undefined) { matchups.offense[name] = matchups.offense.__self; delete matchups.offense.__self; }
    const regionIds = api.readRegionSelect?.('custom-type-region') || [];
    const regionId = regionIds[0] || null;
    const oldName = editing?.name;
    const wasNew = !editing;
    if (editing) {
        Object.assign(editing, { name, desc, ...look, regionId, regionIds, matchups, updatedAt: Date.now() });
        if (oldName && oldName !== name) renameTypeEverywhere(oldName, name);
    } else {
        state.folders = [...(state.folders || []), {
            id: `ctype_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            type: CUSTOM_TYPE_KIND, name, desc, ...look, regionId, regionIds, matchups, createdAt: Date.now()
        }];
        log.info('TYPES', 'Created a custom type', { name });
    }
    closeAndApply(wasNew ? `${name} created. It's now in every type picker.` : `${name} saved.`);
}

function closeAndApply(message) {
    document.getElementById('custom-type-modal')?.classList.remove('active');
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

export async function deleteCustomType() {
    if (!editing) return;
    if (editing.vanillaOf) {
        // "Use the original": the region goes back to the main-game type
        const name = editing.vanillaOf;
        state.folders = (state.folders || []).filter(f => f !== editing);
        editing = null;
        closeAndApply(`Back to the original ${name}.`);
        return;
    }
    const users = (state.fakemonDB || []).filter(f => f.type1 === editing.name || f.type2 === editing.name).length
        + (state.customMoves || []).filter(m => m.type === editing.name).length;
    const confirmFirst = api.getConfirmBeforeDelete?.() !== false;
    if (confirmFirst && !await confirmDialog({ title: `Delete the ${editing.name} type?`, message: users ? `${users} Fakémon and moves use it. They keep the name, but it won't have a colour or matchups any more.` : 'Nothing uses it yet.' })) return;
    const name = editing.name;
    state.folders = (state.folders || []).filter(f => f !== editing);
    for (const t of allEntries()) {
        delete t.matchups?.offense?.[name];
        delete t.matchups?.defense?.[name];
    }
    editing = null;
    closeAndApply(`Deleted ${name}.`);
}

/**
 * A region's own version of a main-game type, created on first edit from the
 * main-game matchups, then opened in the editor.
 */
// a main-game type as it is, in the shape of a region's version of it
function vanillaTypeEntry(name, regionId) {
    const offense = {}, defense = {};
    for (const other of allMatchupTypes()) {
        offense[other] = matchup(name, other);
        defense[other] = matchup(other, name);
    }
    const gradient = VANILLA_GRADIENTS[name] ? JSON.parse(JSON.stringify(VANILLA_GRADIENTS[name])) : null;
    return {
        id: `ctype_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
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

// ---- card actions: the same row every other collection card has ----
const TOGGLE = '<button type="button" class="card-actions-toggle" onclick="toggleCardActions(this, event)" title="Actions" aria-label="Actions"><i data-lucide="more-horizontal" style="width:16px;height:16px;"></i></button>';
const actionIcon = n => `<i data-lucide="${n}" style="width:14px;height:14px;"></i>`;

function typeActions({ pinned, pin, edit, duplicate, exportFn, remove, removeTitle = 'Delete' }) {
    return `<div class="card-actions">${TOGGLE}
        <button class="${pinned ? 'pinned-btn' : ''}" onclick="${pin}" title="${pinned ? 'Unpin' : 'Pin'}">${actionIcon('pin')}</button>
        <button onclick="${edit}; event.stopPropagation();" title="Edit">${actionIcon('pencil')}</button>
        <button onclick="${duplicate}" title="Duplicate">${actionIcon('copy')}</button>
        <div class="collection-card-export-wrap"><button onclick="${exportFn}" title="Export">${actionIcon('download')}</button></div>
        <button class="card-delete-btn" onclick="${remove}" title="${removeTitle}">${actionIcon('trash-2')}</button>
    </div>`;
}

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
    closeAndApply(`${t.name} duplicated as ${copy.name}.`);
}

/** A main-game type as a new custom type of your own. */
export function duplicateVanillaType(name, event) {
    event?.stopPropagation();
    const region = api.getActiveRegion?.();
    const base = overrideFor(name, region?.id) || vanillaTypeEntry(name, region?.id || null);
    const copy = {
        id: newTypeId(), type: CUSTOM_TYPE_KIND, name: freeTypeName(name), desc: base.desc || '',
        color: base.color, gradient: base.gradient ? JSON.parse(JSON.stringify(base.gradient)) : null, icon: base.icon || '',
        regionId: region?.id || null, regionIds: region ? [region.id] : [],
        matchups: JSON.parse(JSON.stringify(base.matchups)), createdAt: Date.now()
    };
    state.folders = [...(state.folders || []), copy];
    closeAndApply(`${copy.name} created from ${name}.`);
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
    const t = findType(id);
    if (!t) return;
    editing = t;
    deleteCustomType();
}

// ---- the Types tab ----
function summary(name, regionId) {
    const all = [...ALL_VANILLA_TYPES, ...getCustomTypes().map(t => t.name)].filter(x => x !== name);
    const strong = all.filter(d => matchup(name, d, regionId) >= 2).length;
    const weak = all.filter(a => matchup(a, name, regionId) >= 2).length;
    return `<span class="card-bst"><em>STRONG</em>${strong}</span><span class="card-bst"><em>WEAK</em>${weak}</span>`;
}

function typeCard({ name, bg, onclick, tag, desc, regionId, entry = null, actions = '', pinned = false }) {
    const users = (state.fakemonDB || []).filter(f => !f.pendingVanilla && (f.type1 === name || f.type2 === name)).length;
    const style = bg ? ` style="background:${esc(bg)}"` : '';
    return `<div class="collection-card library-tile type-tile${pinned ? ' pinned' : ''}" onclick="${onclick}"${desc ? ` title="${esc(desc)}"` : ''}>
        ${actions}
        <div class="card-art"><span class="library-emblem type-emblem type-${esc(name.toLowerCase())}"${style}>${typeIconHtml(name, entry)}</span><span class="card-number library-tile-corner">${users} Fakémon</span>${tag ? `<span class="vanilla-card-tag">${tag}</span>` : ''}</div>
        <div class="card-body">
            <div class="card-name">${esc(name)}</div>
            <div class="card-meta-row">${summary(name, regionId)}</div>
            <div class="card-types"><span class="type-badge type-${esc(name.toLowerCase())}"${style}>${esc(name)}</span></div>
        </div>
    </div>`;
}

/**
 * The Types tab: the add card, your custom types, the main-game types the
 * view covers (a region's own versions in place of the originals), and a
 * chart of all of them underneath.
 * @param {{search: string, list: object[], vanilla: string[], regionId: string|null}} opts
 */
export function typesTabParts({ search = '', list, vanilla = ALL_VANILLA_TYPES, regionId = null, vanillaCards = true }) {
    const q = search.trim().toLowerCase();
    const match = n => !q || n.toLowerCase().includes(q);
    const add = q ? '' : `<button type="button" class="collection-card collection-add-card" onclick="openCustomTypeEditor()">
        <span class="card-art"><span class="collection-add-icon"><i data-lucide="plus"></i></span></span>
        <span class="card-body"><span class="card-name">Add new type</span></span>
    </button>`;
    const byPin = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    const custom = list.filter(t => match(t.name) || String(t.desc || '').toLowerCase().includes(q)).sort(byPin).map(t => {
        const id = esc(t.id);
        return typeCard({
            name: t.name, bg: typeBackground(t), onclick: `openCustomTypeEditor('${id}')`, desc: t.desc, regionId, entry: t, pinned: !!t.pinned,
            actions: typeActions({
                pinned: !!t.pinned, pin: `toggleCustomTypePin('${id}', event)`, edit: `openCustomTypeEditor('${id}')`,
                duplicate: `duplicateCustomType('${id}', event)`, exportFn: `exportCustomType('${id}', event)`,
                remove: `deleteCustomTypeById('${id}', event)`
            })
        });
    });
    const mainGame = (vanillaCards ? vanilla : []).filter(match)
        .map(name => ({ name, pinned: !!api.isVanillaPinned?.('types', name) }))
        .sort(byPin)
        .map(({ name, pinned }) => {
            const o = overrideFor(name, regionId);
            const n = esc(name);
            return typeCard({
                name, bg: o ? typeBackground(o) : '', regionId, entry: o, pinned,
                onclick: `editVanillaType('${n}')`,
                tag: o ? 'Edited' : 'Main games', desc: o?.desc || '',
                actions: typeActions({
                    pinned, pin: `toggleVanillaPin('types','${n}', event)`, edit: `editVanillaType('${n}')`,
                    duplicate: `duplicateVanillaType('${n}', event)`, exportFn: `exportVanillaType('${n}', event)`,
                    remove: `removeVanillaFromRegion('types','${n}', event)`, removeTitle: 'Remove from region'
                })
            });
        });
    const shownNames = [...vanilla, ...list.map(t => t.name)];
    const empty = q && !custom.length && !mainGame.length ? `<p class="types-empty">No types match “${esc(search)}”.</p>` : '';
    return { cards: add + custom.join('') + mainGame.join(''), after: empty + typeChartHtml(shownNames, regionId) };
}

/** Attacker rows by defender columns, for the given types. */
export function typeChartHtml(types, regionId = null) {
    if (!types.length) return '';
    const cell = (a, d) => {
        const m = matchup(a, d, regionId);
        return `<td class="chart-cell mult-${String(m).replace('.', '')}" title="${esc(a)} vs ${esc(d)}: ${m}×">${m === 1 ? '' : MULT_LABEL[m]}</td>`;
    };
    const badge = t => `<span class="type-badge type-${esc(t.toLowerCase())}">${esc(t)}</span>`;
    return `<section class="type-chart-section">
        <header class="search-section-head"><h2>Type chart</h2><span class="type-chart-key"><span class="chart-cell mult-4">4</span> extremely <span class="chart-cell mult-2">2</span> super effective <span class="chart-cell mult-05">½</span> not very <span class="chart-cell mult-0">0</span> no effect</span></header>
        <div class="type-chart-scroll">
            <table class="type-chart">
                <thead><tr><th class="type-chart-corner"><span>Attacking</span><span>Defending</span></th>${types.map(t => `<th class="type-chart-col">${badge(t)}</th>`).join('')}</tr></thead>
                <tbody>${types.map(a => `<tr><th class="type-chart-row">${badge(a)}</th>${types.map(d => cell(a, d)).join('')}</tr>`).join('')}</tbody>
            </table>
        </div>
    </section>`;
}

// ---- exports: Showdown typechart.ts and Essentials types.txt ----
// Showdown damageTaken codes; it has no ×4 for a single type, so that exports as a weakness
const SD_CODE = m => (m >= 2 ? 1 : m === 0.5 ? 2 : m === 0 ? 3 : 0);

/**
 * A Showdown mod typechart: every type, custom ones included, using the
 * region's own versions of main-game types when it has any.
 * @returns {string|null} null when nothing differs from the main games
 */
export function buildShowdownTypechart(customList, regionId = null) {
    if (!customList?.length && !getTypeOverrides(regionId).length) return null;
    const all = [...VANILLA, ...(customList || []).map(t => t.name)];
    const lines = all.map(def => {
        const taken = all.map(att => `${JSON.stringify(att)}: ${SD_CODE(matchup(att, def, regionId))}`).join(', ');
        return `\t${def.toLowerCase().replace(/[^a-z0-9]/g, '')}: {\n\t\tname: ${JSON.stringify(def)},\n\t\tdamageTaken: { ${taken} },\n\t},`;
    });
    return `// Generated by Woogidex: every type in this mod, custom ones included.\n// damageTaken: 0 = normal, 1 = weakness, 2 = resistance, 3 = immunity.\nexport const TypeChart: import('../../../sim/dex-data').ModdedTypeDataTable = {\n${lines.join('\n')}\n};\n`;
}

/** Pokemon Essentials PBS/types.txt entries for the custom types only. */
export function buildEssentialsTypes(customList, regionId = null) {
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
