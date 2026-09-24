// ==================== custom types ====================
// Types you invent (Cosmic, Sound, ...) for your Fakemon and moves. Each one
// has a name, a colour (or a two-colour gradient) and its matchups against
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
import { esc } from '../core/html.js';
import { POKEMON_TYPES, SELECTABLE_TYPES, TYPE_EFFECTIVENESS } from '../core/data.js';
import { iconSvg } from '../core/icons.js';

export const CUSTOM_TYPE_KIND = 'custom-type';
const VANILLA = POKEMON_TYPES.slice();          // the 18, captured before anything is added
/** Every main-game type: the 18, plus ??? (typeless) and Stellar (Tera). Both are neutral. */
export const ALL_VANILLA_TYPES = [...VANILLA, '???', 'Stellar'];
const MULTS = [0, 0.5, 1, 2];
const MULT_LABEL = { 0: '0', 0.5: '½', 1: '1', 2: '2' };
const NAME_RE = /^[A-Za-z][A-Za-z0-9-]{1,15}$/;
const TYPE_COLORS = ['#e07a5f', '#7c5cff', '#2bb3a8', '#e6a23c', '#3b82f6', '#c056d8', '#5aa469', '#d64f7a', '#6b7280'];
const ANGLES = [[90, 'Left to right'], [135, 'Diagonal'], [180, 'Top to bottom']];
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

/** A type's fill: its colour, or its gradient. */
export function typeBackground(t) {
    if (!t) return '';
    return t.gradient?.color2
        ? `linear-gradient(${Number(t.gradient.angle) || 90}deg, ${t.color}, ${t.gradient.color2})`
        : t.color;
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
let draft = null;         // { name, color, gradient, desc, offense, defense, vanillaOf }

export function openCustomTypeEditor(id = '') {
    editing = id ? allEntries().find(t => t.id === id) || null : null;
    const vanillaOf = editing?.vanillaOf || null;
    draft = {
        name: editing?.name || '',
        color: editing?.color || TYPE_COLORS[getCustomTypes().length % TYPE_COLORS.length],
        gradient: editing?.gradient ? { ...editing.gradient } : null,
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
    del.style.display = editing ? '' : 'none';
    // a region's version isn't deleted so much as undone
    del.innerHTML = `<i data-lucide="${vanillaOf ? 'rotate-ccw' : 'trash-2'}"></i><span>${vanillaOf ? 'Use the original' : 'Delete'}</span>`;
    // a region's version belongs to that region by definition
    const assign = document.querySelector('#custom-type-modal .region-assign');
    if (assign) assign.hidden = !!vanillaOf;
    api.fillEntityRegionSelect?.('custom-type-region', editing ? editing.regionId : (api.defaultRegionForNewFakemon?.() || ''));
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

function renderTypeColorOptions() {
    const host = document.getElementById('custom-type-colors');
    if (!host) return;
    const g = draft.gradient;
    host.innerHTML = `<div class="type-color-row">${colorSwatches(draft.color, 'setCustomTypeColor')}</div>
        <label class="type-gradient-toggle"><input type="checkbox" ${g ? 'checked' : ''} onchange="toggleCustomTypeGradient(this.checked)"><span>Gradient</span></label>
        ${g ? `<div class="type-gradient-opts">
            <span class="type-gradient-label">Second colour</span>
            <div class="type-color-row">${colorSwatches(g.color2, 'setCustomTypeColor2')}</div>
            <span class="type-gradient-label">Direction</span>
            <div class="seg">${ANGLES.map(([deg, label]) => `<button type="button" class="seg-btn${Number(g.angle) === deg ? ' on' : ''}" onclick="setCustomTypeAngle(${deg})">${label}</button>`).join('')}</div>
        </div>` : ''}`;
    const preview = document.getElementById('custom-type-preview');
    if (preview) {
        preview.textContent = draft.name || 'Preview';
        preview.style.background = typeBackground(draft);
    }
    // the icon previews on the type's own colour, where it will actually sit
    const iconPreview = document.getElementById('custom-type-art-preview');
    if (iconPreview) iconPreview.style.background = typeBackground(draft);
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

export function setCustomTypeColor(hex) { draft.color = hex; renderTypeColorOptions(); }
export function setCustomTypeColor2(hex) { if (draft.gradient) draft.gradient.color2 = hex; renderTypeColorOptions(); }
export function setCustomTypeAngle(deg) { if (draft.gradient) draft.gradient.angle = deg; renderTypeColorOptions(); }
export function toggleCustomTypeGradient(on) {
    draft.gradient = on ? { color2: TYPE_COLORS.find(c => c !== draft.color) || '#3b82f6', angle: 90 } : null;
    renderTypeColorOptions();
}

export function customTypeNameInput(value) {
    draft.name = value.trim();
    const preview = document.getElementById('custom-type-preview');
    if (preview) preview.textContent = draft.name || 'Preview';
    renderMatchupEditor();
}

function segmented(kind, other, value) {
    return `<div class="type-mult-seg" role="radiogroup" aria-label="${kind === 'offense' ? 'Against' : 'From'} ${esc(other)}">${MULTS.map(m =>
        `<button type="button" role="radio" aria-checked="${m === value}" class="type-mult mult-${String(m).replace('.', '')}${m === value ? ' on' : ''}" onclick="setCustomTypeMatchup('${kind}', '${esc(other)}', ${m})">${MULT_LABEL[m]}</button>`).join('')}</div>`;
}

function renderMatchupEditor() {
    const host = document.getElementById('custom-type-matchups');
    if (!host || !draft) return;
    const self = draft.name || 'this type';
    // a region's version compares against everything, including the type it replaces
    const others = draft.vanillaOf
        ? allMatchupTypes().filter(t => t !== draft.vanillaOf)
        : [...VANILLA, ...getCustomTypes().filter(t => t !== editing).map(t => t.name)];
    const rows = [...others, ...(draft.name ? [draft.name] : [])];
    // a region's version starts from the main-game numbers; a new type from 1
    const base = (att, def) => (draft.vanillaOf ? matchup(att, def) : 1);
    const selfKey = draft.vanillaOf || '__self';
    host.innerHTML = `
        <div class="type-matchup-head"><span>Type</span><span>${esc(self)} attacking it</span><span>It attacking ${esc(self)}</span></div>
        ${rows.map(other => {
            const isSelf = other === draft.name;
            const key = isSelf ? selfKey : other;
            const off = draft.offense[key] ?? base(draft.vanillaOf || '', isSelf ? draft.vanillaOf : other);
            const def = isSelf ? null : (draft.defense[other] ?? (draft.vanillaOf
                ? base(other, draft.vanillaOf)
                : (customByName(other)?.matchups?.offense?.[editing?.name] ?? 1)));
            const badgeStyle = isSelf ? ` style="background:${esc(typeBackground(draft))}"` : '';
            return `<div class="type-matchup-row">
                <span class="type-badge type-${esc(isSelf ? '' : other.toLowerCase())}"${badgeStyle}>${esc(other)}</span>
                ${segmented('offense', key, off)}
                ${isSelf ? '<span class="type-matchup-same">same as left</span>' : segmented('defense', other, def)}
            </div>`;
        }).join('')}`;
}

export function setCustomTypeMatchup(kind, other, mult) {
    if (!draft) return;
    const map = kind === 'offense' ? draft.offense : draft.defense;
    // a region's version keeps explicit 1s: they can undo a main-game weakness
    if (mult === 1 && !draft.vanillaOf) delete map[other]; else map[other] = mult;
    renderMatchupEditor();
}

export function saveCustomType() {
    const desc = document.getElementById('custom-type-desc').value.trim();
    const matchups = { offense: { ...draft.offense }, defense: { ...draft.defense } };
    const look = { color: draft.color, gradient: draft.gradient ? { ...draft.gradient } : null, icon: api.readEntityArt?.('custom-type') || '' };

    if (draft.vanillaOf) {
        Object.assign(editing, { desc, ...look, matchups, updatedAt: Date.now() });
        closeAndApply(`${api.getActiveRegion?.()?.name || 'The region'}'s ${draft.vanillaOf} saved.`);
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
    const regionId = document.getElementById('custom-type-region')?.value || null;
    const oldName = editing?.name;
    const wasNew = !editing;
    if (editing) {
        Object.assign(editing, { name, desc, ...look, regionId, matchups, updatedAt: Date.now() });
        if (oldName && oldName !== name) renameTypeEverywhere(oldName, name);
    } else {
        state.folders = [...(state.folders || []), {
            id: `ctype_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            type: CUSTOM_TYPE_KIND, name, desc, ...look, regionId, matchups, createdAt: Date.now()
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

export function deleteCustomType() {
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
    if (confirmFirst && !window.confirm(`Delete the ${editing.name} type?${users ? ` ${users} Fakémon and moves use it; they'll keep the name, but it won't have a colour or matchups any more.` : ''}`)) return;
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
export function editVanillaType(name) {
    const region = api.getActiveRegion?.();
    if (!region) {
        api.showToast?.(`Pick a region in the sidebar to give it its own version of ${name}.`, 'info');
        return;
    }
    let entry = overrideFor(name, region.id);
    if (!entry) {
        const offense = {}, defense = {};
        for (const other of allMatchupTypes()) {
            offense[other] = matchup(name, other);
            defense[other] = matchup(other, name);
        }
        entry = {
            id: `ctype_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            type: CUSTOM_TYPE_KIND, name, vanillaOf: name, regionId: region.id,
            color: VANILLA_COLORS[name] || '#888888', gradient: null, desc: '',
            matchups: { offense, defense }, createdAt: Date.now()
        };
        state.folders = [...(state.folders || []), entry];
        api.saveToStorage?.();
        syncCustomTypes(true);
    }
    openCustomTypeEditor(entry.id);
}

// ---- the Types tab ----
function summary(name, regionId) {
    const all = [...ALL_VANILLA_TYPES, ...getCustomTypes().map(t => t.name)].filter(x => x !== name);
    const strong = all.filter(d => matchup(name, d, regionId) === 2).length;
    const weak = all.filter(a => matchup(a, name, regionId) === 2).length;
    return `<span class="card-bst"><em>STRONG</em>${strong}</span><span class="card-bst"><em>WEAK</em>${weak}</span>`;
}

function typeCard({ name, bg, onclick, tag, desc, regionId, entry = null }) {
    const users = (state.fakemonDB || []).filter(f => f.type1 === name || f.type2 === name).length;
    const style = bg ? ` style="background:${esc(bg)}"` : '';
    return `<div class="collection-card library-tile type-tile" onclick="${onclick}"${desc ? ` title="${esc(desc)}"` : ''}>
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
    const custom = list.filter(t => match(t.name) || String(t.desc || '').toLowerCase().includes(q)).map(t =>
        typeCard({ name: t.name, bg: typeBackground(t), onclick: `openCustomTypeEditor('${esc(t.id)}')`, desc: t.desc, regionId, entry: t }));
    const mainGame = (vanillaCards ? vanilla : []).filter(match).map(name => {
        const o = overrideFor(name, regionId);
        return typeCard({
            name, bg: o ? typeBackground(o) : '', regionId, entry: o,
            onclick: `editVanillaType('${esc(name)}')`,
            tag: o ? 'Edited' : 'Main games', desc: o?.desc || ''
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
        <header class="search-section-head"><h2>Type chart</h2><span class="type-chart-key"><span class="chart-cell mult-2">2</span> super effective <span class="chart-cell mult-05">½</span> not very <span class="chart-cell mult-0">0</span> no effect</span></header>
        <div class="type-chart-scroll">
            <table class="type-chart">
                <thead><tr><th class="type-chart-corner"><span>Attacking</span><span>Defending</span></th>${types.map(t => `<th class="type-chart-col">${badge(t)}</th>`).join('')}</tr></thead>
                <tbody>${types.map(a => `<tr><th class="type-chart-row">${badge(a)}</th>${types.map(d => cell(a, d)).join('')}</tr>`).join('')}</tbody>
            </table>
        </div>
    </section>`;
}

// ---- exports: Showdown typechart.ts and Essentials types.txt ----
const SD_CODE = m => (m === 2 ? 1 : m === 0.5 ? 2 : m === 0 ? 3 : 0);   // Showdown damageTaken codes

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
