// ==================== Showdown object-model facade ====================
// Pokemon Showdown is MIT licensed (c) Guangcong Luo and contributors:
//     https://github.com/smogon/pokemon-showdown
//
// Showdown's ability and move handlers are written against its own Pokemon and
// Battle classes. This module is the single adapter that presents this engine's
// objects with the surface those handlers actually reach for, so the ability
// bridge (sd-abilities.js) and the move bridge (sd-moves.js) speak to one
// facade instead of drifting apart with two.
//
// The facade is partial ON PURPOSE. Anything Showdown reaches for that is not
// mapped here throws, and each bridge catches that per handler and degrades to
// "this effect does nothing" -- never to a broken battle. Widening the facade
// is how a previously-unsupported effect starts working; nothing else moves.
//
// Pure module: no DOM, no app.js, no network beyond loadShowdownTable's fetch.

import { cachedFetch } from '../../core/net-cache.js';
import { toId } from '../../core/html.js';
import { modify, Chain } from './mechanics.js';
import { typeEffectiveness } from './dex.js';
import { showdownMoveEntry, showdownMoveList } from './sd-moves.js';

// The one Showdown release both bridges compile against. PINNED on purpose:
// two clients in a lockstep battle must be running the same rules, and an
// unpinned `npm/pokemon-showdown` would hand one of them a newer table than
// the other the day upstream publishes. Bump deliberately, never incidentally.
export const SD_VERSION = '0.11.11';

// Built on demand rather than as a module-level constant: sd-moves.js imports
// this module and this module imports it back (for the move lookups Showdown's
// handlers need), and a cycle like that leaves a `const` uninitialised for
// whichever side evaluates first. A function is not read until it is called.
export function sdDataUrl(file) {
    return `https://cdn.jsdelivr.net/npm/pokemon-showdown@${SD_VERSION}/dist/data/${file}.js`;
}

// FNV-1a, the same hash battle.js uses for its per-turn state. Cheap, stable
// across engines, and only ever compared for equality -- this identifies a
// dataset, it does not secure anything.
export function fingerprint(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------- loading
// Showdown's *simulator* data files are esbuild CommonJS bundles whose entries
// are real functions -- unlike the client's data files, which are descriptive
// only and are why abilities and moves did nothing beyond their text. The
// bundles define data and functions and nothing else (no I/O, no globals), so
// they are run against a stub module object rather than imported.
export async function loadShowdownTable(url, pick, probeKey) {
    const res = await cachedFetch(url, { maxAgeMs: 7 * 86400000 });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    const code = await res.text();
    const module = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function('exports', 'module', 'require', code)(module.exports, module, () => ({}));
    const table = pick(module.exports);
    if (!table || !table[probeKey]) throw new Error('unexpected table shape');
    return table;
}

// ------------------------------------------------------------ field/side
// This engine names weather and terrain for the player ('Rain', 'Electric');
// Showdown names them after the move that set them. Translating here is what
// lets Thunder never miss in rain and Growth raise two stages in sun.
const WEATHER_IDS = { Rain: 'raindance', Sun: 'sunnyday', Sand: 'sandstorm', Hail: 'hail' };
const TERRAIN_IDS = {
    Electric: 'electricterrain', Grassy: 'grassyterrain',
    Misty: 'mistyterrain', Psychic: 'psychicterrain'
};
const nameOf = (map, value) => map[value] || '';
const matches = (id, want) => !!id && (Array.isArray(want) ? want : [want]).some(w => toId(w) === id);

function fieldFacade(battle) {
    return {
        get weather() { return nameOf(WEATHER_IDS, battle.field.weather); },
        get terrain() { return nameOf(TERRAIN_IDS, battle.field.terrain); },
        get weatherState() { return { id: nameOf(WEATHER_IDS, battle.field.weather) }; },
        get terrainState() { return { id: nameOf(TERRAIN_IDS, battle.field.terrain) }; },
        effectiveWeather: () => nameOf(WEATHER_IDS, battle.field.weather),
        isWeather: (w) => matches(nameOf(WEATHER_IDS, battle.field.weather), w),
        isTerrain: (t) => matches(nameOf(TERRAIN_IDS, battle.field.terrain), t),
        // Trick Room, Gravity and the rest are not modelled in this engine, so
        // a move asking after them is truthfully told there are none.
        getPseudoWeather: () => null,
        clearWeather: () => battle.setWeather(null),
        clearTerrain: () => battle.setTerrain(null),
        pseudoWeather: {},
        // Drought, Drizzle, Sand Stream, Snow Warning and every terrain setter
        // are written as this.field.setWeather / setTerrain from onStart.
        setWeather: (w) => {
            const name = Object.keys(WEATHER_IDS).find(k => matches(WEATHER_IDS[k], w));
            if (!name) return false;
            battle.setWeather(name, null, effectOf(battle));
            return true;
        },
        setTerrain: (t) => {
            const name = Object.keys(TERRAIN_IDS).find(k => matches(TERRAIN_IDS[k], t));
            if (!name) return false;
            battle.setTerrain(name, null, effectOf(battle));
            return true;
        },
        // Trick Room, Gravity, Wonder Room and the rest are not modelled, so
        // adding one is truthfully reported as "that did not take" rather than
        // silently claiming a field effect that will never be read.
        addPseudoWeather: () => false,
        removePseudoWeather: () => false,
        suppressingWeather: () => false,
        // The engine's own field object stays reachable for anything that has
        // a reason to read it directly.
        raw: battle.field
    };
}

function sideFacade(side, battle) {
    if (!side) return null;
    if (side._sdFacade) return side._sdFacade;
    const f = {
        get n() { return side.index; },
        get index() { return side.index; },
        get name() { return side.name; },
        get team() { return side.team; },
        get pokemon() { return side.team.map(m => pokeFacade(m, battle)); },
        get active() { return [pokeFacade(battle.active(side.index), battle)].filter(Boolean); },
        get foe() { return sideFacade(battle.sides[1 - side.index], battle); },
        get sideConditions() { return side.conditions; },
        getSideCondition: (id) => side.conditions[toId(id)] || null,
        addSideCondition: (id) => battle.addSideCondition(side, toId(id)),
        removeSideCondition: (id) => battle.removeSideCondition(side, toId(id)),
        foeSidesWithConditions: () => [sideFacade(battle.sides[1 - side.index], battle)],
        activeTeam: () => [pokeFacade(battle.active(side.index), battle)].filter(Boolean),
        _side: side
    };
    Object.defineProperty(side, '_sdFacade', { value: f, enumerable: false, configurable: true });
    return f;
}

// ---------------------------------------------------------------- Pokemon
// Memoised per Pokemon: Showdown handlers compare participants by identity
// (Avalanche checks `p.source === target`), so one Pokemon must always present
// the same facade object.
export function pokeFacade(mon, battle) {
    if (!mon) return null;
    if (mon._sdFacade) return mon._sdFacade;
    const f = {
        get hp() { return mon.hp; },
        get maxhp() { return mon.maxhp; },
        get baseMaxhp() { return mon.maxhp; },
        get fainted() { return mon.fainted; },
        get isActive() { return mon.isActive; },
        get name() { return mon.name; },
        get level() { return mon.level; },
        get status() { return mon.status || ''; },
        get types() { return mon.types; },
        get boosts() { return mon.boosts; },
        get volatiles() { return mon.volatiles; },
        get side() { return sideFacade(mon.side, battle); },
        effectiveWeather: () => nameOf(WEATHER_IDS, battle.field.weather),
        get species() { return mon.species; },
        get storedStats() { return mon.stats; },
        get item() { return mon.item ? toId(mon.item.name) : ''; },
        get ability() { return toId(mon.ability?.name || ''); },
        // Move-effect state. `activeMoveActions` is what "first turn out only"
        // moves (First Impression, Fake Out) test; `newlySwitched` is what
        // Payback tests; `attackedBy` is what Avalanche tests.
        get activeMoveActions() { return mon.activeMoveActions || 0; },
        get newlySwitched() { return !!mon.newlySwitched; },
        get moveThisTurn() { return mon.moveThisTurn || false; },
        get attackedBy() {
            return (mon.attackedBy || []).map(e => ({
                source: pokeFacade(e.source, battle), damage: e.damage,
                thisTurn: e.thisTurn, move: e.move
            }));
        },
        hasType: (type) => (Array.isArray(type) ? type : [type]).some(t => mon.types.includes(t)),
        hasAbility: (name) => (Array.isArray(name) ? name : [name]).some(n => toId(n) === toId(mon.ability?.name || '')),
        hasItem: (name) => (Array.isArray(name) ? name : [name]).some(n => toId(n) === toId(mon.item?.name || '')),
        heal: (amount) => battle.heal(Math.floor(amount), mon, effectOf(battle)),
        damage: (amount) => battle.damage(Math.floor(amount), mon, null, effectOf(battle)),
        setStatus: (status) => battle.trySetStatus(mon, status, mon, effectOf(battle)),
        cureStatus: () => battle.cureStatus(mon, mon.status),
        addVolatile: (id) => battle.addVolatile(mon, id),
        removeVolatile: (id) => battle.removeVolatile(mon, id),
        clearBoosts: () => { for (const k of Object.keys(mon.boosts)) mon.boosts[k] = 0; },
        getStat: (stat) => battle.getStat(mon, stat),
        getTypes: () => mon.types,
        // Showdown reads the return value as "did the change take", so these
        // report success rather than returning nothing (Soak and Conversion
        // both fail themselves outright on a falsy answer).
        setType: (types) => {
            battle.setTypes(mon, Array.isArray(types) ? types : [types], 'move', { quiet: true });
            return true;
        },
        // Ability flags (failroleplay, cantsuppress) are not modelled here, so
        // an empty set is the honest answer: nothing is specially protected.
        getAbility: () => ({ id: toId(mon.ability?.name || ''), name: mon.ability?.name || '', flags: {} }),
        setAbility: (ability) => battle.setAbility(mon, typeof ability === 'string' ? ability : ability?.name),
        // Singles only, so a Pokemon's allies are just itself.
        alliesAndSelf: () => [f],
        addType: (type) => { battle.setTypes(mon, [...mon.types, type], 'move', { quiet: true }); return true; },
        allies: () => [],
        adjacentFoes: () => [pokeFacade(battle.foeOf(mon), battle)].filter(Boolean),
        get moveSlots() {
            return mon.moves.map(s => ({
                id: s.move.id, move: s.move.name, pp: s.pp, maxpp: s.maxpp, disabled: s.disabled
            }));
        },
        getLastDamagedBy: () => (mon.attackedBy || []).filter(e => e.damage > 0).pop() || null,
        // Showdown weighs in hectograms; the editor stores kilograms.
        getWeight: () => Math.max(1, Math.round((mon.species?.weightkg || 0) * 10)),
        getUndynamaxedHP: (hp) => (hp === undefined ? mon.hp : hp),
        getItem: () => (mon.item ? { id: toId(mon.item.name), name: mon.item.name } : { id: '', name: '' }),
        takeItem: () => {
            if (!mon.item) return null;
            const had = { id: toId(mon.item.name), name: mon.item.name };
            battle.consumeItem(mon, had.name);
            return had;
        },
        positiveBoosts: () => Object.values(mon.boosts).reduce((n, v) => n + (v > 0 ? v : 0), 0),

        // ---- per-effect scratch space. Showdown keeps an ability's and an
        // item's own state in these, and a handler that stores a counter in
        // one is a handler that throws without them.
        get abilityState() { return (mon._sdAbilityState ||= { id: toId(mon.ability?.name || ''), target: f }); },
        get itemState() { return (mon._sdItemState ||= { id: toId(mon.item?.name || ''), target: f }); },
        get m() { return (mon._sdScratch ||= {}); },

        // ---- identity and set data
        get baseSpecies() { return mon.species; },
        get set() { return mon.set || {}; },
        get gender() { return mon.gender || 'N'; },
        get happiness() { return 255; },
        get position() { return 0; },
        getSlot: () => battle.ref(mon),
        // Not modelled, and saying so plainly is what keeps a handler that
        // checks for them from taking a branch this engine cannot honour.
        get illusion() { return null; },
        get terastallized() { return null; },
        get transformed() { return false; },
        get isStarted() { return true; },

        // ---- turn state
        get lastMove() { return mon.lastMove || null; },
        get moveLastTurnResult() { return mon.moveLastTurnResult ?? true; },
        get hurtThisTurn() { return mon.damageTakenThisTurn > 0 ? mon.damageTakenThisTurn : null; },
        get timesAttacked() { return (mon.attackedBy || []).length; },
        get trapped() { return !!mon.trapped; },
        set trapped(v) { mon.trapped = !!v; },
        get switchFlag() { return !!mon.switchFlag; },
        set switchFlag(v) { mon.switchFlag = v; },

        // ---- boosts and status, the rest of the verbs
        clearBoost: (stat) => { if (stat in mon.boosts) mon.boosts[stat] = 0; },
        setBoost: (boosts) => { for (const [k, v] of Object.entries(boosts || {})) if (k in mon.boosts) mon.boosts[k] = v; },
        trySetStatus: (status, source) => battle.trySetStatus(mon, status, unwrap(source) || mon, effectOf(battle)),
        clearStatus: () => battle.cureStatus(mon, mon.status),
        faint: () => battle.setHP(mon, 0),
        getHealth: () => ({ hp: mon.hp, maxhp: mon.maxhp }),
        getVolatile: (id) => mon.volatiles[toId(id)] || null,

        // ---- moves
        disableMove: (id) => {
            const slot = mon.moves.find(sl => sl.move.id === toId(id) || toId(sl.move.name) === toId(id));
            // Flagged as the event's doing so the turn loop can release it
            // again next turn -- see battle.js runTurn.
            if (slot) { slot.disabled = true; slot.disabledByEvent = true; }
        },
        deductPP: (moveId, amount = 1) => {
            const slot = mon.moves.find(sl => sl.move.id === toId(moveId) || toId(sl.move.name) === toId(moveId));
            if (!slot) return 0;
            const spent = Math.min(slot.pp, amount);
            slot.pp -= spent;
            return spent;
        },
        getMoveHitData: () => ({ crit: false, typeMod: 0, zBrokeProtect: false }),
        isGrounded: () => !mon.types.includes('Flying'),
        isSemiInvulnerable: () => !!mon.volatiles.twoturnmove,
        runEffectiveness: (move) => {
            const step = typeEffectiveness(move?.type, mon.types);
            return step === 0 ? 0 : Math.round(Math.log2(step));
        },

        // ---- items
        // Nothing in this engine hands a Pokemon a new item mid-battle, so a
        // handler that tries is told it did not take rather than believing it.
        setItem: () => false,
        useItem: () => (mon.item ? battle.consumeItem(mon, mon.item.name) : false),
        eatItem: () => (mon.item ? battle.consumeItem(mon, mon.item.name) : false),

        // ---- forme and transform: not modelled, and a handler is told so
        // rather than being allowed to believe a change it can never see.
        formeChange: () => false,
        transformInto: () => false,

        toString: () => battle.ref(mon),
        _mon: mon
    };
    Object.defineProperty(mon, '_sdFacade', { value: f, enumerable: false, configurable: true });
    return f;
}

// Unwraps a facade back to this engine's Pokemon, so mutation methods accept
// whichever of the two a handler happens to hand them.
export const unwrap = (x) => (x && x._mon) ? x._mon : x;

// The effect currently running through the bridge, so anything it heals or
// damages is attributed to it by name ("restored a little HP using its
// Leftovers!") instead of to a generic "ability". Set around each handler call
// and restored afterwards, so a handler that calls another cannot leak its
// name into the caller's.
export function withEffect(battle, name, fn) {
    const previous = battle._effectName;
    battle._effectName = name || previous || '';
    try { return fn(); } finally { battle._effectName = previous; }
}

const effectOf = (battle) => battle._effectName || '';

// ----------------------------------------------------------------- Battle
// `this` inside any Showdown handler is the Battle. `chain`, when supplied,
// collects this.chainModify() calls so a caller that expects a multiplier
// (onBasePower) can read one out; without it chainModify is inert and handlers
// that return their modifier directly still work.
export function battleFacade(battle, effectState, chain = null) {
    return {
        effectState,
        get field() { return fieldFacade(battle); },
        get sides() { return battle.sides.map(x => sideFacade(x, battle)); },
        // Protocol entries are structured data that gets hashed for desync
        // detection and replayed by the UI, so a facade handed to add() is
        // reduced to its player ref rather than serialised as an object.
        add: (...args) => battle.add(...args.map(a => (a && a._mon) ? battle.ref(a._mon) : a)),
        random: (n) => (n === undefined ? battle.rng.random(0x100000000) / 0x100000000 : battle.rng.random(n)),
        randomChance: (num, den) => battle.rng.chance(num, den),
        boost: (boosts, target) => battle.boost(unwrap(target), boosts, null, effectOf(battle)),
        heal: (amount, target) => battle.heal(Math.floor(amount), unwrap(target), effectOf(battle)),
        damage: (amount, target) => battle.damage(Math.floor(amount), unwrap(target), null, effectOf(battle)),
        directDamage: (amount, target) => battle.damage(Math.floor(amount), unwrap(target), null, effectOf(battle)),
        chainModify: (num, den) => { if (chain) chain.add(num, den); },
        modify,
        trunc: Math.trunc,
        clampIntRange: (num, min = 0, max = Infinity) =>
            Math.min(max, Math.max(min, Math.trunc(Number(num) || 0))),
        getAllActive: () => battle.sides.map(s => pokeFacade(battle.active(s.index), battle)).filter(Boolean),
        // Sucker Punch and Payback ask whether a Pokemon has yet to move this
        // turn. battle.js keeps the remaining ordered actions in _queue.
        queue: {
            willMove: (target) => battle.willMove(unwrap(target)),
            get list() { return battle.pendingActions(); }
        },
        // "Is there anyone left on the bench to send out." Teleport and the
        // pivoting moves ask before they bother trying.
        canSwitch: (side) => {
            const s = side?._side || side;
            const idx = s ? s.index : 0;
            return battle.sides[idx].team.filter(m => !m.fainted).length - 1;
        },
        // Knock Off gates on "can this item be taken at all". Nothing in this
        // engine makes an item untakeable, so the answer is always yes.
        // Showdown's convention is that both of these hand back the relay
        // variable they were given, so a handler written as
        // `damage = this.runEvent('Damage', target, ..., damage)` gets its own
        // number back rather than `true` -- which it would then use as one.
        singleEvent: (_name, _effect, _state, _target, _source, _sourceEffect, relay) =>
            (relay === undefined ? true : relay),
        // Contact is a move flag here, which is the only thing that decides it.
        checkMoveMakesContact: (move) => !!move?.flags?.contact,
        // Charge moves ask permission to charge (Power Herb would answer here).
        // Nothing in this engine refuses, so they always may.
        runEvent: (_name, _target, _source, _effect, relay) => (relay === undefined ? true : relay),
        // Showdown's "this did not work, but do not print a failure" sentinel.
        NOT_FAIL: '',
        // Metronome, Sleep Talk, Copycat, Assist, Me First and Nature Power all
        // finish by running a DIFFERENT move from inside the one being used.
        actions: {
            useMove: (move, pokemon, opts) =>
                battle.useMove(move, unwrap(pokemon), unwrap(opts?.target)),
            runMove: (move, pokemon, opts) =>
                battle.useMove(move, unwrap(pokemon), unwrap(opts?.target)),
            // Showdown asks this before switching someone in mid-turn. The
            // pivot moves are handled by the engine itself, so the answer here
            // only has to be "nothing stopped you".
            runSwitch: () => true,
            canMegaEvo: () => null, canTerastallize: () => null
        },
        // The last move anyone used this battle, which is the whole of what
        // Copycat copies.
        get lastMove() { return showdownMoveEntry(battle.lastMove?.id || '') || null; },
        addMove: (...args) => battle.add(...args.map(a => (a && a._mon) ? battle.ref(a._mon) : a)),
        // Nothing in this engine suppresses an ability from outside it, so the
        // answer a handler is checking for is always no.
        suppressingAbility: () => false,
        // Purely cosmetic in Showdown (debug log, battle hint text, animation
        // attribution). Silently accepted so a handler that only wanted to
        // annotate itself still completes.
        debug: () => {}, hint: () => {}, attrLastMove: () => {},
        // Drawn from the battle's own seed, never Math.random, so a move that
        // picks at random still resolves identically on both clients.
        sample: (list) => (list?.length ? list[battle.rng.random(list.length)] : undefined),
        // Real lookups, not pass-throughs: Metronome filters the whole table by
        // flag and Conversion reads the type off another move entirely, so
        // handing these back their own argument told them nothing.
        // Generation, and the rule table a handler checks before reaching for
        // a mechanic. Nothing here is a Gen 9 format with clauses, so every
        // question about one is answered "no rule about that".
        gen: 9,
        ruleTable: { has: () => false, valueRules: new Map() },
        toID: toId,
        getCategory: (move) => (typeof move === 'object' ? move?.category : showdownMoveEntry(move)?.category) || 'Status',
        // The effect currently running, which handlers read to name themselves
        // in a message or to compare against what triggered them.
        get effect() { return { id: toId(effectOf(battle)), name: effectOf(battle) }; },
        get effectState() { return effectState; },
        // Showdown's damage handlers read this.event.modifier; nothing in this
        // engine multiplies through it, so a neutral one keeps them running.
        event: { modifier: 1 },
        faint: (target) => battle.setHP(unwrap(target), 0),
        // Ending the battle outright is the engine's own decision, made from
        // the faint queue. A handler asking for it is accepted and ignored
        // rather than allowed to end a battle from inside a stat calculation.
        win: () => {}, tie: () => {}, faintMessages: () => {}, swapPosition: () => false,
        // Both spellings of "run this other move now" reach the same place.
        useMove: (move, pokemon, opts) => battle.useMove(move, unwrap(pokemon), unwrap(opts?.target)),
        dex: {
            moves: {
                get: (m) => showdownMoveEntry(m) || { id: toId(m), flags: {} },
                all: () => showdownMoveList()
            },
            abilities: { get: (a) => ({ id: toId(a), name: String(a || ''), flags: {} }) },
            items: { get: (i) => ({ id: toId(i), name: String(i || ''), isBerry: /berry$/i.test(String(i || '')), flags: {} }) },
            species: { get: (sp) => (typeof sp === 'object' ? sp : { id: toId(sp), name: String(sp || ''), types: [] }) },
            types: {
                get: (t) => ({
                    id: toId(t), name: String(t || ''),
                    damageTaken: {},
                    // The type chart is the whole of what a type "is" here.
                    effectiveType: String(t || '')
                })
            },
            getEffectiveness: (type, target) => {
                const attacking = (type && type.type) ? type.type : type;
                const types = Array.isArray(target) ? target : (target?.types || [target]);
                const step = typeEffectiveness(attacking, types);
                return step === 0 ? 0 : Math.round(Math.log2(step));
            },
            // Immunity here means the type chart, which is the only kind this
            // engine has.
            getImmunity: (type, target) => {
                const attacking = (type && type.type) ? type.type : type;
                const types = Array.isArray(target) ? target : (target?.types || [target]);
                return typeEffectiveness(attacking, types) !== 0;
            },
            getActiveMove: (m) => showdownMoveEntry(m) || m
        },
        _battle: battle
    };
}

export { Chain };
