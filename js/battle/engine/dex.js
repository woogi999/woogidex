// ==================== battle dex ====================
// Turns the site's own data shapes (Fakemon records, custom moves/abilities,
// Showdown's move table) into the flat, frozen structures the battle engine
// consumes. Deliberately pure (no DOM/app.js) so it's unit-testable in Node,
// and the engine only ever reads Fakemon data through here.

import { TYPE_EFFECTIVENESS } from '../../core/data.js';

export const STAT_IDS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
export const BOOST_IDS = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];

import { toId } from '../../core/html.js';
export { toId };

// duplicated from data.js's NATURE_DATA, pre-converted to multipliers
const NATURE_MODS = {
    adamant: { atk: 1.1, spa: 0.9 }, bold: { def: 1.1, atk: 0.9 },
    brave: { atk: 1.1, spe: 0.9 }, calm: { spd: 1.1, atk: 0.9 },
    careful: { spd: 1.1, spa: 0.9 }, gentle: { spd: 1.1, def: 0.9 },
    hasty: { spe: 1.1, def: 0.9 }, impish: { def: 1.1, spa: 0.9 },
    jolly: { spe: 1.1, spa: 0.9 }, lax: { def: 1.1, spd: 0.9 },
    lonely: { atk: 1.1, def: 0.9 }, mild: { spa: 1.1, def: 0.9 },
    modest: { spa: 1.1, atk: 0.9 }, naive: { spe: 1.1, spd: 0.9 },
    naughty: { atk: 1.1, spd: 0.9 }, quiet: { spa: 1.1, spe: 0.9 },
    rash: { spa: 1.1, spd: 0.9 }, relaxed: { def: 1.1, spe: 0.9 },
    sassy: { spd: 1.1, spe: 0.9 }, timid: { spe: 1.1, atk: 0.9 }
    // bashful/docile/hardy/quirky/serious omitted: neutral
};

export function natureMultiplier(nature, stat) {
    return NATURE_MODS[toId(nature)]?.[stat] ?? 1;
}

export function calcStat(stat, base, iv, ev, level, nature) {
    const b = Number(base) || 0;
    const i = clamp(Number(iv ?? 31), 0, 31);
    const e = clamp(Number(ev ?? 0), 0, 252);
    const lv = clamp(Number(level) || 100, 1, 100);
    if (stat === 'hp') {
        // Shedinja-style 1 HP base stat is preserved as-is rather than run through the formula.
        if (b === 1) return 1;
        return Math.floor(((2 * b + i + Math.floor(e / 4)) * lv) / 100) + lv + 10;
    }
    const raw = Math.floor(((2 * b + i + Math.floor(e / 4)) * lv) / 100) + 5;
    return Math.floor(raw * natureMultiplier(nature, stat));
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// unknown types resolve to neutral rather than throwing
export function typeEffectiveness(attackingType, defendingTypes) {
    let mult = 1;
    const row = TYPE_EFFECTIVENESS[attackingType];
    if (!row) return 1;
    for (const def of defendingTypes || []) {
        if (!def) continue;
        const m = row[def];
        if (m !== undefined) mult *= m;
    }
    return mult;
}

export class BattleDex {
    constructor({ sdMoves = {}, customMoves = [], customAbilities = [], customItems = [], sdItems = {}, sdAbilities = {} } = {}) {
        this.sdMoves = sdMoves;
        this.sdItems = sdItems;
        this.sdAbilities = sdAbilities;
        this.customMoves = new Map();
        this.customAbilities = new Map();
        this.customItems = new Map();
        // indexed by both stable id and normalised name: team sets store moves by
        // name, a Fakemon's learnset stores customId - both must resolve here
        for (const m of customMoves || []) {
            if (!m) continue;
            if (m.id) this.customMoves.set(String(m.id), m);
            if (m.name) this.customMoves.set(toId(m.name), m);
        }
        for (const a of customAbilities || []) {
            if (!a) continue;
            if (a.id) this.customAbilities.set(String(a.id), a);
            if (a.name) this.customAbilities.set(toId(a.name), a);
        }
        for (const it of customItems || []) {
            if (!it) continue;
            if (it.id) this.customItems.set(String(it.id), it);
            if (it.name) this.customItems.set(toId(it.name), it);
        }
        this._moveCache = new Map();
    }

    // ---------- moves ----------
    // custom moves win over Showdown moves of the same name
    getMove(nameOrId) {
        const key = String(nameOrId ?? '');
        if (this._moveCache.has(key)) return this._moveCache.get(key);
        const id = toId(key);
        const custom = this.customMoves.get(key) || this.customMoves.get(id);
        const move = custom ? normalizeCustomMove(custom, id) : normalizeSdMove(this.sdMoves[id], id, key);
        this._moveCache.set(key, move);
        return move;
    }

    // ---------- abilities ----------
    // returns { id, name, desc, program }; program is the block AST when
    // built in the block editor, else null. ability-runtime.js compiles program into handlers.
    getAbility(nameOrIdOrRef) {
        if (!nameOrIdOrRef) return null;
        // a Fakemon's abilities[] entry: {name, source:'custom'|'sd', customId?, desc}
        if (typeof nameOrIdOrRef === 'object') {
            const ref = nameOrIdOrRef;
            const lib = (ref.customId && this.customAbilities.get(String(ref.customId)))
                || this.customAbilities.get(toId(ref.name));
            if (lib) return customAbilityEntry(lib);
            return sdAbilityEntry(ref.name, this.sdAbilities[toId(ref.name)]);
        }
        const key = String(nameOrIdOrRef);
        const lib = this.customAbilities.get(key) || this.customAbilities.get(toId(key));
        if (lib) return customAbilityEntry(lib);
        return sdAbilityEntry(key, this.sdAbilities[toId(key)]);
    }

    // ---------- items ----------
    getItem(nameOrId) {
        if (!nameOrId) return null;
        const key = String(nameOrId);
        const custom = this.customItems.get(key) || this.customItems.get(toId(key));
        if (custom) {
            return Object.freeze({
                id: toId(custom.name || custom.id), name: custom.name || 'Custom Item',
                desc: custom.desc || '', custom: true,
                program: custom.blocks || null, rawCode: custom.rawCode || ''
            });
        }
        const sd = this.sdItems[toId(key)];
        return Object.freeze({
            id: toId(key), name: sd?.name || key, desc: sd?.desc || '',
            custom: false, program: null, rawCode: ''
        });
    }

    // ---------- species ----------
    // the Fakemon record flattened to just what battle needs; sourceId lets
    // replays point back at the Fakemon even after it's later edited
    getSpecies(fakemon) {
        if (!fakemon) return null;
        const types = [fakemon.type1, fakemon.type2].filter(Boolean);
        return Object.freeze({
            sourceId: String(fakemon.id ?? ''),
            id: toId(fakemon.name) || 'fakemon',
            name: fakemon.name || 'Unnamed',
            types: Object.freeze(types.length ? types : ['Normal']),
            baseStats: Object.freeze({
                hp: num(fakemon.stats?.hp, 1), atk: num(fakemon.stats?.atk, 1), def: num(fakemon.stats?.def, 1),
                spa: num(fakemon.stats?.spa, 1), spd: num(fakemon.stats?.spd, 1), spe: num(fakemon.stats?.spe, 1)
            }),
            abilities: Object.freeze((fakemon.abilities || []).filter(a => a && a.name)),
            learnset: Object.freeze(fakemon.learnset || []),
            // kg; sd-facade converts to the hectograms Showdown uses (for Low Kick/Grass Knot)
            weightkg: Number(fakemon.weightkg) || 0,
            artwork: fakemon.artwork || '',
            shinyArtwork: fakemon.shinyArtwork || '',
            number: fakemon.number || ''
        });
    }
}

function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeCustomMove(m, fallbackId) {
    return Object.freeze({
        id: toId(m.name) || fallbackId,
        name: m.name || 'Custom Move',
        type: m.type || 'Normal',
        category: m.category || 'Status',
        basePower: Number(m.basePower) || 0,
        // "never misses": Showdown uses accuracy===true, editor uses 0/blank; normalise both to true
        accuracy: m.accuracy === true || !Number(m.accuracy) ? true : Number(m.accuracy),
        pp: Number(m.pp) || 10,
        priority: Number(m.priority) || 0,
        flags: Object.freeze({ ...(m.flags || {}) }),
        desc: m.desc || '',
        custom: true,
        target: m.target || (m.category === 'Status' ? 'self' : 'normal'),
        critRatio: Number(m.critRatio) || 0,
        drain: m.drain || null,
        recoil: m.recoil || null,
        heal: m.heal || null,
        status: m.status || null,
        volatileStatus: m.volatileStatus || null,
        boosts: m.boosts || null,
        secondaries: Object.freeze(m.secondaries || []),
        multihit: m.multihit || null,
        // see SD_MOVE_FIELDS
        weather: m.weather || null,
        terrain: m.terrain || null,
        sideCondition: m.sideCondition || null,
        selfSwitch: m.selfSwitch || null,
        self: m.self || null,
        willCrit: m.willCrit || false,
        damage: m.damage ?? null,
        forceSwitch: m.forceSwitch || false,
        thawsTarget: m.thawsTarget || false,
        sleepUsable: m.sleepUsable || false,
        breaksProtect: m.breaksProtect || false,
        ohko: m.ohko || false,
        ignoreImmunity: m.ignoreImmunity || false,
        overrideOffensiveStat: m.overrideOffensiveStat || null,
        overrideDefensiveStat: m.overrideDefensiveStat || null,
        program: m.blocks || null,
        // hand-written hooks; only run when trusted - see sd-hooks.js compileRawHooks
        rawCode: m.rawCode || ''
    });
}

// Every field of a Showdown move record the engine actually reads. The move
// loader slims moves.json to keep entries small and used to drop several of
// these fields, silently breaking self-targeting/drain/recoil/etc. Both sides
// read this list so they can't drift apart again; scene.test.mjs asserts it
// covers normalizeSdMove.
export const SD_MOVE_FIELDS = [
    'name', 'type', 'category', 'basePower', 'accuracy', 'pp', 'priority',
    'flags', 'desc', 'shortDesc', 'target', 'critRatio', 'drain', 'recoil',
    'heal', 'status', 'volatileStatus', 'boosts', 'secondaries', 'secondary',
    'multihit',
    // kept as plain data so moves still behave correctly if the simulator table (sd-moves.js) can't be reached
    'weather', 'terrain', 'sideCondition', 'selfSwitch', 'self', 'willCrit',
    'damage', 'forceSwitch', 'thawsTarget', 'sleepUsable', 'breaksProtect',
    'ohko', 'ignoreImmunity', 'overrideOffensiveStat', 'overrideDefensiveStat'
];

function normalizeSdMove(sd, id, originalName) {
    if (!sd) {
        // unknown move - inert 0-power Normal move keeps the battle running instead of desyncing
        return Object.freeze({
            id, name: originalName || id || 'Unknown Move', type: 'Normal', category: 'Status',
            basePower: 0, accuracy: true, pp: 5, priority: 0, flags: Object.freeze({}),
            desc: '', custom: false, target: 'self', critRatio: 0, drain: null, recoil: null,
            heal: null, status: null, volatileStatus: null, boosts: null,
            secondaries: Object.freeze([]), multihit: null, weather: null, terrain: null,
            sideCondition: null, selfSwitch: null, self: null, willCrit: false, damage: null,
            forceSwitch: false, thawsTarget: false, sleepUsable: false, breaksProtect: false,
            ohko: false, ignoreImmunity: false, overrideOffensiveStat: null,
            overrideDefensiveStat: null, program: null, rawCode: '', unknown: true
        });
    }
    return Object.freeze({
        id,
        name: sd.name || id,
        type: sd.type || 'Normal',
        category: sd.category || 'Status',
        basePower: Number(sd.basePower) || 0,
        accuracy: sd.accuracy === true ? true : (Number(sd.accuracy) || true),
        pp: Number(sd.pp) || 5,
        priority: Number(sd.priority) || 0,
        flags: Object.freeze({ ...(sd.flags || {}) }),
        desc: sd.desc || '',
        custom: false,
        target: sd.target || 'normal',
        critRatio: Number(sd.critRatio) || 0,
        drain: sd.drain || null,
        recoil: sd.recoil || null,
        heal: sd.heal || null,
        status: sd.status || null,
        volatileStatus: sd.volatileStatus || null,
        boosts: sd.boosts || null,
        secondaries: Object.freeze(sd.secondaries || (sd.secondary ? [sd.secondary] : [])),
        multihit: sd.multihit || null,
        // see SD_MOVE_FIELDS
        weather: sd.weather || null,
        terrain: sd.terrain || null,
        sideCondition: sd.sideCondition || null,
        selfSwitch: sd.selfSwitch || null,
        self: sd.self || null,
        willCrit: sd.willCrit || false,
        damage: sd.damage ?? null,
        forceSwitch: sd.forceSwitch || false,
        thawsTarget: sd.thawsTarget || false,
        sleepUsable: sd.sleepUsable || false,
        breaksProtect: sd.breaksProtect || false,
        ohko: sd.ohko || false,
        ignoreImmunity: sd.ignoreImmunity || false,
        overrideOffensiveStat: sd.overrideOffensiveStat || null,
        overrideDefensiveStat: sd.overrideDefensiveStat || null,
        program: null,
        rawCode: ''
    });
}

function customAbilityEntry(lib) {
    const program = lib.blocks && (Array.isArray(lib.blocks.triggers) ? lib.blocks.triggers.length : lib.blocks.trigger)
        ? lib.blocks : null;
    return Object.freeze({
        id: toId(lib.name) || String(lib.id || ''),
        libId: String(lib.id || ''),
        name: lib.name || 'Custom Ability',
        desc: lib.desc || '',
        custom: true,
        program,
        rawCode: lib.rawCode || ''
    });
}

function sdAbilityEntry(name, sd) {
    return Object.freeze({
        id: toId(name), libId: '', name: sd?.name || name || '',
        desc: sd?.desc || '', custom: false, program: null, rawCode: ''
    });
}
