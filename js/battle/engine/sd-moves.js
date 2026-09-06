// ==================== Showdown move bridge ====================
// Runs Pokemon Showdown's own move handlers instead of re-implementing them
// here. Showdown is MIT licensed (c) Guangcong Luo and contributors:
//     https://github.com/smogon/pokemon-showdown
//
// This is the same trick sd-abilities.js plays, for the same reason. The move
// table this site loads (play.pokemonshowdown.com/data/moves.json) is the
// CLIENT's copy, and the client has no simulator in it -- every callback is
// either stripped or flattened to a sentinel:
//
//     gyroball:        { basePower: 0, basePowerCallback: true }   <- useless
//     firstimpression: { priority: 2 }                             <- onTry gone
//     wickedblow:      { willCrit: true }                          <- never read
//
// which is why moves were base power and a type and nothing else. The
// simulator's table is a different file and its entries are real functions:
//
//     gyroball: { basePowerCallback(pokemon, target) {
//         let power = Math.floor(25 * target.getStat('spe') / pokemon.getStat('spe')) + 1;
//         ...
//     } }
//
// So this fetches the compiled simulator table and hands those functions to
// battle.js at the points in the move pipeline where they belong. ~950 moves,
// none of them hand-written here.
//
// The bridge is partial by design, exactly as the ability bridge is. A handler
// that reaches for an unbridged part of Showdown's object model is caught and
// skipped -- the move still fires as plain damage, and never takes the battle
// down mid-turn.

import { toId } from '../../core/html.js';
import {
    loadShowdownTable, pokeFacade, battleFacade, Chain, fingerprint, sdDataUrl,
    SD_VERSION, withEffect
} from './sd-facade.js';


// Plain (non-function) effect fields the client's copy either drops or cannot
// express. These are merged onto the move for one use, so they can never
// overwrite a Fakemon's own custom move data -- only non-custom moves are
// bridged at all (see battle.js `_moveEffects`).
export const DATA_FIELDS = [
    'willCrit',          // Wicked Blow, Frost Breath, Storm Throw
    'critRatio',         // Stone Edge, Night Slash, Leaf Blade
    'damage',            // Seismic Toss / Night Shade ('level'), Sonic Boom (20)
    'secondaries',       // the full list, where the client keeps only `secondary`
    'self',              // Close Combat's own Def/SpD drop, Draco Meteor's SpA drop
    'selfSwitch',        // U-turn, Volt Switch, Flip Turn
    'forceSwitch',       // Whirlwind, Dragon Tail, Circle Throw
    'ignoreImmunity',    // Thousand Arrows
    'ignoreAbility',     // Moongeist Beam, Sunsteel Strike
    'breaksProtect',     // Feint, Hyperspace Fury
    'thawsTarget',       // Scald, Steam Eruption
    'sleepUsable',       // Snore, Sleep Talk
    'ohko',              // Fissure, Sheer Cold
    'multihit',          // the client keeps this, but the sim's is authoritative
    'drain', 'recoil', 'heal',
    'status', 'volatileStatus', 'boosts',
    'weather', 'terrain', 'sideCondition',
    'overrideOffensiveStat',   // Body Press (uses Def), Psyshock
    'overrideDefensiveStat',
    'stallingMove'       // Protect / Detect / Endure
];

// Callbacks this engine's move pipeline has a place to call.
const HOOKS = [
    'basePowerCallback', 'damageCallback',
    'onTry', 'onTryMove', 'onTryImmunity', 'onTryHit',
    'onModifyMove', 'onBasePower', 'onEffectiveness',
    'onHit', 'onAfterHit', 'onAfterMove', 'onMoveFail'
];

// Hooks that live on a move's `condition` -- the state a move leaves behind on
// the Pokemon using it. For the charge moves this is the whole of what makes
// Dig and Fly different from a slow attack: while the volatile is up, most
// moves cannot reach you, and the two that can hit twice as hard.
const CONDITION_HOOKS = ['onInvulnerability', 'onSourceModifyDamage'];

let tablePromise = null;
let TABLE = null;
let MOVE_LIST = null;
let FINGERPRINT = null;

// The table is fetched from a PINNED release (see sd-facade.js SD_VERSION),
// not a floating one: both players compile their battle from it, and lockstep
// requires them to be compiling from the same table. An unpinned
// `npm/pokemon-showdown` would hand one client a newer one than the other the
// day upstream publishes, and their simulations would part ways mid-battle.
// The handshake in battle-ui.js is the backstop for whatever pinning misses.
export function loadShowdownMoves() {
    if (TABLE) return Promise.resolve(TABLE);
    tablePromise ||= loadShowdownTable(
        sdDataUrl('moves'),
        (exports) => exports.Moves || exports.BattleMovedex,
        'gyroball'
    ).then(table => { TABLE = table; return TABLE; })
        .catch(err => {
            tablePromise = null;
            console.warn('[BATTLE] Showdown moves unavailable, effects stay descriptive', err);
            return null;
        });
    return tablePromise;
}

export function showdownMovesLoaded() { return !!TABLE; }

// Identifies WHICH move table this client is holding, so two clients can check
// they are running the same rules before a turn is played. The pinned version
// alone is not enough -- a stale CDN copy or a partial parse would still differ --
// so the id list itself is what gets hashed.
export function movesFingerprint() {
    if (!TABLE) return '';
    FINGERPRINT ||= fingerprint(`${SD_VERSION}|${Object.keys(TABLE).sort().join(',')}`);
    return FINGERPRINT;
}

// ---------------------------------------------------------------- lookups
// A flat descriptor of one move, which is the shape Showdown's own handlers
// expect when they call this.dex.moves.get(). Deliberately data-only: the
// handlers read fields off it, they never call back into it.
function entry(id) {
    const m = TABLE?.[id];
    if (!m) return null;
    return {
        id, num: m.num || 0, name: m.name || id,
        type: m.type || 'Normal', category: m.category || 'Status',
        basePower: m.basePower || 0, accuracy: m.accuracy, pp: m.pp || 5,
        priority: m.priority || 0, target: m.target || 'normal',
        flags: m.flags || {}, isNonstandard: m.isNonstandard || null,
        isZ: m.isZ || false, isMax: m.isMax || false
    };
}

export function showdownMoveEntry(idOrMove) {
    if (!TABLE) return null;
    if (idOrMove && typeof idOrMove === 'object') return entry(toId(idOrMove.id || idOrMove.name)) || idOrMove;
    return entry(toId(idOrMove));
}

// Every move, in a fixed order. Metronome picks from this, so the ORDER is
// part of the shared rules: Showdown sorts by dex number, and so does this,
// with the id as the tie-break so the sort is total rather than merely stable.
// Two clients holding the same table therefore always draw the same move.
export function showdownMoveList() {
    if (!TABLE) return [];
    MOVE_LIST ||= Object.keys(TABLE)
        .map(entry)
        .filter(Boolean)
        .sort((a, b) => (a.num - b.num) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return MOVE_LIST;
}

// ---------------------------------------------------------------- compile
// Turns one Showdown move into { data, hooks, condition } for battle.js.
// `data` is merged onto the move for a single use; `hooks` are called at the
// matching point in the pipeline; `condition` is consulted while the move's
// own volatile is up. Returns null when the move has none of the three, so
// battle.js keeps its fast path for the many moves that are just damage.
export function showdownMoveEffects(moveId) {
    if (!TABLE) return null;
    const id = toId(moveId);
    const raw = TABLE[id];
    if (!raw) return null;

    const data = {};
    for (const field of DATA_FIELDS) {
        if (raw[field] !== undefined && typeof raw[field] !== 'function') data[field] = raw[field];
    }
    // Showdown's raw table writes a lone extra effect as `secondary` and only
    // uses `secondaries` for moves that have more than one; it folds the two
    // together when it builds its dex. This engine reads the list, so fold here.
    if (!data.secondaries && raw.secondary) data.secondaries = [raw.secondary];
    // Every two-turn move carries this flag, which is what tells the engine to
    // expect a charge turn rather than reading the failure as a real one.
    if (raw.flags?.charge) data.isCharging = true;

    const hooks = {};
    for (const hook of HOOKS) {
        if (typeof raw[hook] === 'function') hooks[hook] = raw[hook];
    }

    const condition = {};
    for (const hook of CONDITION_HOOKS) {
        if (typeof raw.condition?.[hook] === 'function') condition[hook] = raw.condition[hook];
    }

    if (!Object.keys(data).length && !Object.keys(hooks).length && !Object.keys(condition).length) return null;
    return { id, name: raw.name || moveId, data, hooks, condition };
}

// ------------------------------------------------------------------- call
// Invokes one bridged callback. `battle`, `user`, `target` and `move` are this
// engine's own objects; the facades are built here so callers never see
// Showdown's object model. `fallback` is what a handler that cannot run
// returns, which is always "change nothing".
//
// A chain is threaded through for the hooks Showdown writes as
// `this.chainModify(2)` rather than as a return value (onBasePower is the big
// one), so the multiplier survives back to the caller in 4096ths.
export function runMoveHook(fx, hook, ctx, fallback) {
    return invoke(fx?.hooks?.[hook], fx, hook, ctx, fallback);
}

// The same, for a hook that lives on the move's lingering condition rather
// than on the move itself.
export function runConditionHook(fx, hook, ctx, fallback) {
    return invoke(fx?.condition?.[hook], fx, hook, ctx, fallback);
}

function invoke(fn, fx, hook, { battle, user, target, move, value, type }, fallback) {
    if (typeof fn !== 'function') return fallback;

    const chain = new Chain();
    const effectState = (move._sdEffectState ||= {});
    const scope = battleFacade(battle, effectState, chain);
    const self = pokeFacade(user, battle);
    const foe = pokeFacade(target, battle);

    try {
        const out = withEffect(battle, move.name,
            () => callHook(fn, scope, hook, { self, foe, move, value, type }));
        // A hook that only chain-modified reports its multiplier that way.
        if (out === undefined && chain.value !== 4096 && Number.isFinite(value)) {
            return chain.apply(value);
        }
        return out === undefined ? fallback : out;
    } catch (err) {
        // A move reaching for part of Showdown's object model this bridge does
        // not cover degrades to that one effect doing nothing, rather than
        // taking the battle down mid-turn.
        console.warn(`[BATTLE] ${fx.name}.${hook} needs unbridged API`, err.message);
        return fallback;
    }
}

// Showdown's move callbacks take different argument lists; this supplies each
// one the arguments its own signature expects.
function callHook(fn, scope, hook, { self, foe, move, value, type }) {
    switch (hook) {
        // (user, target, move) -> base power
        case 'basePowerCallback':
            return fn.call(scope, self, foe, move);
        // (user, target) -> fixed damage
        case 'damageCallback':
            return fn.call(scope, self, foe);
        // (user, target, move) -> false/null to fail the move
        case 'onTry':
        case 'onTryMove':
            return fn.call(scope, self, foe, move);
        // (target, user, move) -> false to make the target immune
        case 'onTryImmunity':
        case 'onTryHit':
        case 'onHit':
        case 'onAfterHit':
        case 'onMoveFail':
            return fn.call(scope, foe, self, move);
        // (move, user, target) -> mutates the move in place
        case 'onModifyMove':
            return fn.call(scope, move, self, foe);
        // (basePower, user, target, move) -> number, or this.chainModify(x)
        case 'onBasePower':
            return fn.call(scope, value, self, foe, move);
        // (typeMod, target, type, move) -> replacement effectiveness
        case 'onEffectiveness':
            return fn.call(scope, value, foe, type, move);
        // (user, target, move)
        case 'onAfterMove':
            return fn.call(scope, self, foe, move);
        // condition hooks: (target, source, move). `self` is the Pokemon whose
        // condition it is (the one underground), `foe` the one attacking it.
        case 'onInvulnerability':
            return fn.call(scope, self, foe, move);
        case 'onSourceModifyDamage':
            return fn.call(scope, value, foe, self, move);
        default:
            return undefined;
    }
}
