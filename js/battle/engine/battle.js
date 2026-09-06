// ==================== battle engine ====================
// A deterministic singles battle simulator built around this site's own
// Fakemon data. Architecture follows Pokémon Showdown's shape - a seeded
// battle stepped one turn at a time, emitting a structured protocol log that
// the UI replays - but the implementation, data model and event system are
// ours, driven by BattleDex and the custom-ability interpreter.
//
// DETERMINISM IS THE CONTRACT. Both players run this exact code over the same
// seed and the same ordered action list and must reach byte-identical state.
// That means: no Math.random(), no Date.now(), no object-key iteration order
// dependence, no floating-point accumulation where an integer will do. Any
// divergence is a desync (see net/protocol.js, which hashes state each turn).
//
// Pure module: no DOM, no app.js. Node can run it directly for tests.

import { BattleRNG } from './rng.js';
import { calcStat, typeEffectiveness, toId, BOOST_IDS } from './dex.js';
import { compileProgram } from './ability-runtime.js';
import { builtinHandlers } from './builtin-abilities.js';
import { showdownAbilityHandlers } from './sd-abilities.js';
import { showdownItemHandlers } from './sd-items.js';
import { compileRawHooks, rawMoveEffects } from './sd-hooks.js';
import { showdownMoveEffects, runMoveHook, runConditionHook, DATA_FIELDS } from './sd-moves.js';
import { builtinItemHandlers } from './builtin-items.js';
import {
    calcDamage, modify, boostStat, boostAccuracy, critDenominator,
    multihitCount, orderActions
} from './mechanics.js';

// Bumped whenever a rules change makes two builds resolve the same turn
// differently. The handshake (net/protocol.js) refuses a battle across a
// mismatch, which is far better than letting it desync three turns in.
//   2 - pivot moves switch mid-turn; flinch before paralysis; confusion;
//       terrain effects; weather chips on its final turn.
//   3 - each side's chosen lead now travels in the hello, so both clients seat
//       the same Pokemon in front; an agreed sdItems:false actually takes
//       effect; the item flag joins the state hash. A build without these
//       looks identical to one with them right up until it desyncs, which is
//       exactly what a version bump is for.
export const ENGINE_VERSION = 3;

// Struggle: what a Pokemon does once it has nothing left to use. Nobody
// carries it, so the engine supplies it rather than the dex. Showdown's own
// numbers -- 50 BP physical, typeless (so nothing resists it and nothing is
// immune to it), never misses, and it costs its user a quarter of its maximum
// HP. Without it, a Pokemon out of PP had no legal action at all and the battle
// simply stopped: no move could be chosen and no switch was offered.
export const STRUGGLE_INDEX = -1;
export const STRUGGLE = Object.freeze({
    id: 'struggle', name: 'Struggle', type: '???', category: 'Physical',
    basePower: 50, accuracy: true, pp: 1, priority: 0,
    flags: Object.freeze({ contact: 1, protect: 1 }),
    desc: '', custom: false, target: 'normal', critRatio: 0,
    drain: null, recoil: null, heal: null, status: null, volatileStatus: null,
    boosts: null, secondaries: Object.freeze([]), multihit: null,
    weather: null, terrain: null, sideCondition: null, selfSwitch: null,
    self: null, willCrit: false, damage: null, forceSwitch: false,
    thawsTarget: false, sleepUsable: false, breaksProtect: false, ohko: false,
    ignoreImmunity: true, overrideOffensiveStat: null, overrideDefensiveStat: null,
    program: null, struggle: true
});

// Single source of truth for "can this move be picked right now", shared by
// choice validation, the bot and the move buttons so they can never disagree.
// A disable (Choice lock, Taunt-style effects) is ignored when it would leave
// the Pokemon with nothing to pick at all, since honouring the lock there would
// hang the turn. Running out of PP entirely is the other case, and that one is
// answered by Struggle (see mustStruggle).
export function canSelectMove(mon, index) {
    const slot = mon?.moves?.[index];
    if (!slot || slot.pp <= 0) return false;
    if (!slot.disabled && !moveLockedOut(mon, slot)) return true;
    // A lock that would leave the Pokemon with nothing at all to pick is
    // ignored rather than hanging the turn. Struggle answers "out of PP";
    // nothing answers "every move is locked out".
    return !mon.moves.some(s => s.pp > 0 && !s.disabled && !moveLockedOut(mon, s));
}



const STATUS_NAMES = { brn: 'burn', par: 'paralysis', psn: 'poison', tox: 'bad poison', slp: 'sleep', frz: 'freeze' };

// Moves name the weather and terrain they set after themselves; this engine
// names them for the player. One table here replaces the hand-written list of
// move ids _applyStatusMove used to carry, so every weather and terrain move
// works rather than only the five that had been spelled out.
const MOVE_WEATHER = {
    raindance: 'Rain', sunnyday: 'Sun', sandstorm: 'Sand',
    hail: 'Hail', snow: 'Hail', snowscape: 'Hail', chillyreception: 'Hail'
};
// Volatiles the engine keeps for its own bookkeeping. They are real state --
// they are in the snapshot and the hash like any other -- but they are not
// things that happen to a Pokemon, so they are never announced.
const SILENT_VOLATILES = new Set(['twoturnmove', 'stall']);

// Protect and its relatives get less likely to work the more they are leaned
// on. Showdown marks them with `stallingMove`, which reaches us through the
// move bridge (sd-moves.js DATA_FIELDS); this list is the fallback for when
// the bridge is unavailable, so spamming Protect still fails offline.
const STALLING_MOVES = new Set([
    'protect', 'detect', 'endure', 'kingsshield', 'spikyshield', 'banefulbunker',
    'obstruct', 'silktrap', 'burningbulwark', 'maxguard', 'craftyshield',
    'quickguard', 'wideguard'
]);

function isStallingMove(move) {
    if (!move) return false;
    return move.stallingMove === true || STALLING_MOVES.has(move.id);
}

// Volatiles worth announcing when they start but not when they lapse. Protect
// says "it protected itself!" as it goes up; mainline says nothing at all when
// the turn ends and it comes back down.
const SILENT_END_VOLATILES = new Set(['protect']);

const MOVE_TERRAIN = {
    electricterrain: 'Electric', grassyterrain: 'Grassy',
    mistyterrain: 'Misty', psychicterrain: 'Psychic'
};

// Side conditions that run out on a clock. Hazards are deliberately absent:
// Spikes and Stealth Rock stay until something clears them.
const SIDE_CONDITION_TURNS = {
    safeguard: 5, mist: 5, reflect: 5, lightscreen: 5, auroraveil: 5, tailwind: 4
};

// Volatiles that time out on their own, counted down at end of turn. Confusion
// is deliberately absent: it counts down on its holder's own move ATTEMPTS,
// not on the clock, and _confusionBlocks does that. Every one of these was
// being applied and then never expiring -- a single Taunt locked its target
// out of status moves for the rest of the battle.
const VOLATILE_TURNS = {
    taunt: 3, encore: 3, disable: 4, magnetrise: 5, embargo: 5, healblock: 5, yawn: 2
};

// Taunt forbids status moves; Disable forbids one named move; Encore forbids
// everything EXCEPT one named move. All three were stored as volatiles that
// nothing ever read, so none of them did anything at all.
export function moveLockedOut(mon, slot) {
    if (!mon || !slot) return false;
    const id = slot.move?.id;
    if (mon.volatiles?.taunt && slot.move?.category === 'Status') return true;
    if (mon.volatiles?.disable?.moveId && mon.volatiles.disable.moveId === id) return true;
    const encored = mon.volatiles?.encore?.moveId;
    if (encored && encored !== id) return true;
    return false;
}

export class Battle {
    // sides: [{ id, name, team: [{ fakemon, set }] }]
    // set:   { level, nature, ivs, evs, item, ability, moves:[names] }
    // `caps` is the shared ruleset the two clients agreed on before the first
    // turn (see net/protocol.js). Lockstep is only meaningful when both ends
    // are running the same rules, so if one player could not load Showdown's
    // move or ability table, BOTH battles are compiled without it rather than
    // one quietly diverging from the other.
    constructor({ seed, dex, sides, format = 'singles', timerMs = 150000,
                  trustLocalCode = false,
                  caps = { sdMoves: true, sdAbilities: true } }) {
        this.seed = String(seed);
        this.rng = new BattleRNG(this.seed);
        this.dex = dex;
        this.format = format;
        this.engineVersion = ENGINE_VERSION;
        this.turn = 0;
        this.log = [];
        this.globals = {};          // 'global variable' scope for ability blocks
        this.ended = false;
        this.winner = null;
        this.endReason = null;
        this.timerMs = timerMs;
        this.pendingSwitches = new Set();
        // True while a turn is part-run: a pivot suspended it mid-queue and
        // switchTo() will pick the rest of it back up. See _runQueue().
        this._midTurn = false;
        this.faintQueue = [];
        this.caps = {
            sdMoves: caps?.sdMoves !== false,
            sdAbilities: caps?.sdAbilities !== false,
            sdItems: caps?.sdItems !== false
        };
        // Whether hand-written code carried by a move, item or ability may be
        // compiled and run. True only for a battle whose every line came from
        // this browser (a bot battle); false whenever another player is
        // involved, because their code arrived over the network. See
        // sd-hooks.js compileRawHooks.
        this.trustLocalCode = !!trustLocalCode;
        // The last move used by anyone, which is the whole of what Copycat
        // copies. Distinct from a Pokemon's own lastMove.
        this.lastMove = null;
        // Depth guard for moves that call other moves (Metronome -> Sleep Talk).
        this._callDepth = 0;
        // Showdown's move handlers, compiled once per move id (see sd-moves.js).
        this._moveFx = new Map();
        this._movePrograms = new Map();
        // The actions still to resolve this turn, which is what Sucker Punch
        // and Payback interrogate through willMove().
        this._queue = [];

        this.field = { weather: null, weatherTurns: 0, weatherSource: null, terrain: null, terrainTurns: 0 };

        this.sides = sides.map((s, i) => this._buildSide(s, i));
        // Refuse to exist rather than start a battle that cannot be played.
        // Callers validate their packages, but a Battle is also constructed
        // from replays and reconnects, and a silent half-battle is worse than
        // a loud failure.
        for (const side of this.sides) {
            if (!side.team.length) throw new Error(`${side.name} has no Pokemon.`);
        }
        this.choices = [null, null];

        this.add('start', this.seed, ENGINE_VERSION);
        for (const side of this.sides) this.add('player', side.index, side.name);
    }

    // ---------------------------------------------------------------- setup
    _buildSide(raw, index) {
        const side = {
            index, id: raw.id ?? `p${index + 1}`, name: raw.name || `Player ${index + 1}`,
            team: [], activeIndex: 0, conditions: {}
        };
        side.team = (raw.team || []).map((entry, slot) => this._buildPokemon(entry, side, slot));
        // Lead choice: Showdown lets each player pick who starts at the front.
        // Validated against team size so a bad payload can't crash setup.
        const lead = Number(raw.lead);
        if (Number.isInteger(lead) && lead > 0 && lead < side.team.length && !side.team[lead].fainted) {
            side.activeIndex = lead;
        }
        return side;
    }

    _buildPokemon(entry, side, slot) {
        const species = this.dex.getSpecies(entry.fakemon);
        const set = entry.set || {};
        const level = clamp(Number(set.level) || 100, 1, 100);
        const ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31, ...(set.ivs || {}) };
        const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...(set.evs || {}) };
        const nature = set.nature || 'Serious';

        const stats = {};
        for (const st of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
            stats[st] = calcStat(st, species.baseStats[st], ivs[st], evs[st], level, nature);
        }

        // Ability: the set names one of the species' ability slots. Fall back
        // to the first slot so a team saved before an ability rename still
        // loads instead of entering battle with no ability at all.
        const abilityRef = (species.abilities || []).find(a => toId(a.name) === toId(set.ability))
            || species.abilities?.[0] || null;
        const ability = abilityRef ? this.dex.getAbility(abilityRef) : null;

        const moves = (set.moves || []).filter(Boolean).slice(0, 4).map(name => {
            const m = this.dex.getMove(name);
            return { move: m, pp: m.pp, maxpp: m.pp, disabled: false };
        });

        const item = set.item ? this.dex.getItem(set.item) : null;

        const pokemon = {
            side, slot, species, level, nature, ivs, evs,
            name: species.name,
            baseStats: species.baseStats,
            stats,
            maxhp: stats.hp,
            hp: stats.hp,
            types: [...species.types],
            baseTypes: [...species.types],
            status: null,
            statusData: {},
            boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
            volatiles: {},
            moves,
            ability,
            abilityHandlers: this._compileAbility(ability),
            item,
            itemHandlers: this._compileItem(item),
            fainted: false,
            isActive: false,
            switchedInTurn: 0,
            lastMove: null,
            // What this Pokemon last used up, for Recycle and anything built
            // on the same idea. Never cleared on a switch: an ability that
            // gives an item back on entry has to still know what it was.
            lastConsumedItem: null,
            damageTakenThisTurn: 0,
            // Read by Showdown's move callbacks: "only works on your first turn
            // out" (First Impression, Fake Out) tests activeMoveActions,
            // Payback tests newlySwitched, Avalanche tests attackedBy.
            activeMoveActions: 0,
            newlySwitched: false,
            moveThisTurn: false,
            attackedBy: []
        };
        return pokemon;
    }

    // Applies the ruleset the two clients settled on. Only legal before the
    // first turn -- after that the battles have already diverged and the state
    // hash is the thing that catches it, not this.
    setCaps(caps) {
        if (this.turn > 0) return false;
        // All three flags, every time. Rebuilding this object from only two of
        // them dropped sdItems on the floor: an agreed sdItems:false never took
        // effect, so a client whose opponent had no item table kept running
        // Showdown's item handlers and diverged on the first Life Orb chip.
        const next = {
            sdMoves: caps?.sdMoves !== false,
            sdAbilities: caps?.sdAbilities !== false,
            sdItems: caps?.sdItems !== false
        };
        if (next.sdMoves === this.caps.sdMoves
            && next.sdAbilities === this.caps.sdAbilities
            && next.sdItems === this.caps.sdItems) return true;
        this.caps = next;
        this._moveFx.clear();
        for (const side of this.sides) {
            for (const mon of side.team) mon.abilityHandlers = this._compileAbility(mon.ability);
        }
        return true;
    }

    // Seats a side's lead before the battle starts. Each client only knows its
    // own player's pick at construction time, so the opponent's arrives later
    // over the wire (see the ruleset handshake in battle-ui.js) and lands here.
    // Turn 0 only: after that both clients have already simulated from whoever
    // was in front, and moving them would be the desync rather than the fix.
    setLead(sideIndex, index) {
        if (this.turn > 0) return false;
        const side = this.sides[sideIndex];
        const i = Number(index);
        if (!side || !Number.isInteger(i) || i < 0 || i >= side.team.length) return false;
        if (side.team[i].fainted) return false;
        side.activeIndex = i;
        return true;
    }

    // ------------------------------------------------------------- accessors
    active(sideIndex) {
        const side = this.sides[sideIndex];
        return side.team[side.activeIndex] || null;
    }
    sideOf(pokemon) { return pokemon?.side || null; }
    foeOf(pokemon) { return this.active(1 - pokemon.side.index); }
    add(...parts) { this.log.push(parts); return this; }

    // -------------------------------------------------------------- protocol
    // Structured protocol entry, Showdown-style: ['-damage', 'p1a', hp, maxhp].
    ref(pokemon) { return `p${pokemon.side.index + 1}${String.fromCharCode(97)}`; }

    // ==================== state mutation API ====================
    // Everything below is what ability-runtime.js (and the move executor)
    // calls. Keeping every mutation behind these methods is what makes the
    // battle reproducible and loggable.

    // What caused a heal or a hit, as the { id, name, effectType } shape a
    // Showdown handler expects to be handed. Everything in this engine names
    // its cause with a string -- a move's name, 'brn', 'Sandstorm', 'recoil' --
    // so the move table is what decides whether that string is a move.
    _damageEffect(why) {
        const name = String(why || '');
        if (!name) return null;
        const move = this.dex.getMove(name);
        return {
            id: toId(name), name,
            effectType: move && !move.unknown ? 'Move' : 'Status'
        };
    }

    setHP(pokemon, hp) {
        pokemon.hp = clamp(Math.floor(hp), 0, pokemon.maxhp);
        if (pokemon.hp === 0) this._queueFaint(pokemon);
    }

    damage(amount, target, source = null, why = '') {
        if (!target || target.fainted) return 0;
        // Sturdy, Focus Sash and every "survive on 1 HP" effect are written as
        // onDamage: it is asked with the damage about to be dealt and may
        // shrink it, or return false to call the whole thing off.
        //
        // Handed a real effect rather than null, because almost every stock
        // handler gates on `effect.effectType === 'Move'` -- Focus Sash is
        // supposed to catch a hit and not a burn, and with nothing to read it
        // would quietly decline to catch either.
        const vetted = this.runEvent('damage', target, {
            value: Math.floor(amount), damage: Math.floor(amount),
            move: this._damageEffect(why)
        });
        if (vetted === false) return 0;
        if (Number.isFinite(vetted)) amount = vetted;
        if (amount <= 0) return 0;
        const amt = Math.max(1, Math.floor(amount));
        const dealt = Math.min(amt, target.hp);
        target.hp -= dealt;
        target.damageTakenThisTurn += dealt;
        // Avalanche and Revenge double their power off who hit you this turn.
        // Bounded so a long battle cannot grow this without limit.
        if (source) {
            target.attackedBy.push({ source, damage: dealt, thisTurn: true, move: why });
            if (target.attackedBy.length > 8) target.attackedBy.shift();
        }
        this.add('-damage', this.ref(target), target.hp, target.maxhp, why || undefined, dealt);
        if (target.hp <= 0) this._queueFaint(target);
        // Fires for every source of HP loss (moves, hazards, weather, residual),
        // which is what an HP-threshold item like Sitrus Berry needs to react to
        // consistently rather than only when hit by a move.
        this.runEvent('afterDamage', target, { amount: dealt });
        return dealt;
    }

    heal(amount, target, why = '') {
        if (!target || target.fainted || target.hp >= target.maxhp) return 0;
        // Heal Block and its kin are written as onTryHeal, which may reduce
        // the amount or refuse it outright.
        const vetted = this.runEvent('tryHeal', target, {
            value: Math.floor(amount), damage: Math.floor(amount),
            move: this._damageEffect(why)
        });
        if (vetted === false) return 0;
        if (Number.isFinite(vetted)) amount = vetted;
        if (amount <= 0) return 0;
        const healed = Math.min(Math.max(1, Math.floor(amount)), target.maxhp - target.hp);
        target.hp += healed;
        this.add('-heal', this.ref(target), target.hp, target.maxhp, why || undefined, healed);
        return healed;
    }

    boost(target, boosts, source = null, why = '') {
        if (!target || target.fainted) return;
        // Clear Body, White Smoke and Big Pecks all work by deleting entries
        // out of the boost object before it is applied, which is exactly what
        // Showdown's onTryBoost is handed. A copy, so a handler editing it
        // cannot reach back into the move's own data.
        const requested = { ...(boosts || {}) };
        const vetted = this.runEvent('tryBoost', target, { value: requested, move: null });
        if (vetted === false) return;
        const applied = (vetted && typeof vetted === 'object') ? vetted : requested;
        const landed = {};
        for (const [stat, delta] of Object.entries(applied)) {
            if (!BOOST_IDS.includes(stat) || !delta) continue;
            const before = target.boosts[stat] || 0;
            const after = clamp(before + Number(delta), -6, 6);
            if (after === before) {
                this.add('-boostfail', this.ref(target), stat, Number(delta) > 0 ? 'up' : 'down');
                continue;
            }
            target.boosts[stat] = after;
            this.add(Number(delta) > 0 ? '-boost' : '-unboost', this.ref(target), stat, Math.abs(after - before), why || undefined);
            landed[stat] = after - before;
        }
        if (Object.keys(landed).length) this.runEvent('afterBoost', target, { value: landed, move: null });
    }

    clearBoosts(target) {
        if (!target) return;
        for (const k of BOOST_IDS) target.boosts[k] = 0;
        this.add('-clearboost', this.ref(target));
    }

    trySetStatus(target, status, source = null, why = '') {
        if (!target || target.fainted || target.status) return false;
        // Safeguard turns away anything the OTHER side tries to inflict, and
        // nothing a Pokemon does to itself (Rest, Toxic Orb).
        if (target.side.conditions.safeguard && source && source.side !== target.side) {
            this.add('-activate', this.ref(target), 'Safeguard');
            return false;
        }
        // Terrain protects whatever is standing on it: Misty from every status,
        // Electric from sleep alone.
        if (this._isGrounded(target)) {
            if (this.field.terrain === 'Misty') {
                this.add('-activate', this.ref(target), 'Misty Terrain');
                return false;
            }
            if (this.field.terrain === 'Electric' && status === 'slp') {
                this.add('-activate', this.ref(target), 'Electric Terrain');
                return false;
            }
        }
        // Type-based status immunities.
        if (status === 'brn' && target.types.includes('Fire')) return this._immune(target, 'brn');
        if ((status === 'psn' || status === 'tox') && (target.types.includes('Poison') || target.types.includes('Steel'))) return this._immune(target, status);
        if (status === 'par' && target.types.includes('Electric')) return this._immune(target, 'par');
        if (status === 'frz' && target.types.includes('Ice')) return this._immune(target, 'frz');
        // Immunity, Insomnia, Limber, Water Veil and every status-refusing
        // ability is written as onSetStatus returning false. Asked here, while
        // refusing it still means something -- the engine's own `setStatus`
        // event below stays where it is, because it is what the block editor's
        // "when statused" trigger and onAfterSetStatus bind to.
        if (this.runEvent('trySetStatus', target, { status, move: null }) === false) {
            return this._immune(target, status);
        }

        target.status = status;
        target.statusData = { turns: 0 };
        // Sleep runs 1-3 turns; rolled now so the duration is part of the
        // deterministic stream rather than decided later.
        if (status === 'slp') target.statusData.duration = this.rng.range(1, 3);
        if (status === 'tox') target.statusData.stage = 1;
        this.add('-status', this.ref(target), status, why || undefined);
        this.runEvent('setStatus', target, { status });
        return true;
    }

    _immune(target, status) {
        this.add('-immune', this.ref(target), status);
        return false;
    }

    cureStatus(target, why = '') {
        if (!target || !target.status) return;
        const had = target.status;
        target.status = null;
        target.statusData = {};
        this.add('-curestatus', this.ref(target), had, why || undefined);
    }

    setTypes(target, types, why = '', { quiet = false } = {}) {
        if (!target) return;
        target.types = (types || []).filter(Boolean);
        if (!target.types.length) target.types = ['Normal'];
        // Showdown's own handlers (Soak, Conversion, Camouflage) announce the
        // change themselves, so the bridge asks for silence rather than
        // printing the same line twice.
        if (!quiet) this.add('-start', this.ref(target), 'typechange', target.types.join('/'), why || undefined);
    }

    // Returns the id of the ability that was replaced. Showdown's move
    // handlers (Role Play, Doodle) read that as "did the swap take".
    setAbility(target, name) {
        if (!target) return '';
        const had = toId(target.ability?.name || '');
        const ab = this.dex.getAbility(name);
        if (!ab || toId(ab.name) === had) return '';
        target.ability = ab;
        target.abilityHandlers = this._compileAbility(ab);
        this.add('-ability', this.ref(target), ab?.name || '');
        return had;
    }

    // Single-use items (berries, Focus Sash) call this on themselves once
    // they've fired. Recompiling to {} means they genuinely stop doing
    // anything rather than just being flagged inert.
    consumeItem(target, why = '') {
        if (!target || !target.item) return;
        const used = target.item;
        target.item = null;
        target.itemHandlers = {};
        // Remembered so Recycle -- and any ability built to do the same on
        // switch-in -- has something to give back.
        target.lastConsumedItem = used;
        this.add('-enditem', this.ref(target), why || used.name || '');
    }

    // Hands back whatever this Pokemon last used up. Refuses when it is already
    // holding something, so an ability cannot conjure a second item.
    restoreItem(target, why = '') {
        if (!target || target.fainted || target.item || !target.lastConsumedItem) return false;
        target.item = target.lastConsumedItem;
        target.itemHandlers = this._compileItem(target.item);
        target.lastConsumedItem = null;
        this.add('-item', this.ref(target), target.item.name || '', why || undefined);
        return true;
    }

    addVolatile(target, id, data = {}) {
        if (!target || target.fainted) return false;
        const key = toId(id) || 'effect';
        const silent = data.silent || SILENT_VOLATILES.has(key);
        if (target.volatiles[key]) {
            // Stacking effects (Stockpile) deepen instead of re-applying.
            if ('layers' in target.volatiles[key]) target.volatiles[key].layers = Math.min(3, target.volatiles[key].layers + 1);
            return false;
        }
        // Inner Focus writes its whole effect as onFlinch returning false.
        if (key === 'flinch' && this.runEvent('flinch', target) === false) return false;
        target.volatiles[key] = { id: key, layers: 1, turns: 0, ...data, silent };
        const v = target.volatiles[key];
        // Confusion runs 2-5 of its holder's turns. Rolled here so its length
        // is part of the deterministic stream rather than decided later, the
        // same way sleep's duration is.
        if (key === 'confusion' && data.duration === undefined) v.duration = this.rng.range(2, 5);
        else if (VOLATILE_TURNS[key] && data.duration === undefined) v.duration = VOLATILE_TURNS[key];
        // Disable and Encore both name the move their target last used --
        // Showdown's own conditions read pokemon.lastMove in onStart, and
        // without it neither volatile locked out anything at all.
        if ((key === 'disable' || key === 'encore') && !v.moveId) v.moveId = target.lastMove?.id || null;
        if (!silent) this.add('-start', this.ref(target), key);
        return true;
    }

    removeVolatile(target, id) {
        const key = toId(id);
        if (!target?.volatiles[key]) return false;
        const silent = target.volatiles[key].silent || SILENT_END_VOLATILES.has(key);
        delete target.volatiles[key];
        if (!silent) this.add('-end', this.ref(target), key);
        return true;
    }

    setWeather(weather, source = null, why = '') {
        if (!weather) {
            // The ending weather is named in the entry so the log can say "the
            // rain stopped" rather than "the weather cleared".
            if (this.field.weather) this.add('-weather', 'none', this.field.weather);
            this.field.weather = null; this.field.weatherTurns = 0;
            return;
        }
        this.field.weather = weather;
        this.field.weatherTurns = 5;
        this.field.weatherSource = source ? this.ref(source) : null;
        this.add('-weather', weather, why || undefined);
    }

    setTerrain(terrain, source = null, why = '') {
        if (!terrain) {
            if (this.field.terrain) this.add('-fieldend', `${this.field.terrain} Terrain`);
            this.field.terrain = null; this.field.terrainTurns = 0;
            return;
        }
        this.field.terrain = terrain;
        this.field.terrainTurns = 5;
        this.add('-fieldstart', `${terrain} Terrain`, why || undefined);
    }

    addSideCondition(side, id, layers = 1) {
        if (!side) return false;
        const key = toId(id);
        const max = key === 'spikes' ? 3 : key === 'toxicspikes' ? 2 : 1;
        const cur = side.conditions[key];
        if (cur && cur.layers >= max) return false;
        side.conditions[key] = {
            id: key,
            layers: cur ? cur.layers + layers : layers,
            // Screens, Mist, Tailwind and Safeguard run out; hazards do not.
            turns: SIDE_CONDITION_TURNS[key] || 0
        };
        this.add('-sidestart', `p${side.index + 1}`, key, side.conditions[key].layers);
        return true;
    }

    removeSideCondition(side, id) {
        const key = toId(id);
        if (!side?.conditions[key]) return false;
        delete side.conditions[key];
        this.add('-sideend', `p${side.index + 1}`, key);
        return true;
    }

    requestForcedSwitch(pokemon) {
        if (pokemon && !pokemon.fainted) this.pendingSwitches.add(pokemon);
    }

    // What a Pokemon is still about to do this turn. Sucker Punch fails on a
    // target that is not attacking and Payback doubles once the target has
    // already moved, so both ask this. Null once the action has been taken.
    // Everything still queued to happen this turn, in resolution order.
    pendingActions() {
        return this._queue.map(a => ({ choice: 'move', move: a.slot.move, pokemon: a.mon }));
    }

    willMove(pokemon) {
        const pending = this._queue.find(a => a.mon === pokemon);
        return pending ? { choice: 'move', move: pending.slot.move } : null;
    }

    // ==================== event dispatch ====================
    // Fires an event at one Pokémon's ability (and, later, its item). This is
    // the single seam custom abilities plug into - everything the interpreter
    // can do flows through the mutation API above.
    // Custom block-built abilities compile via compileProgram; standard
    // Showdown-style abilities resolve against the builtin table. Both are
    // merged so a custom ability named "Levitate" still floats.
    // Resolution order: a block-editor program always wins, then Showdown's
    // own handler for that ability, then this project's small builtin table as
    // the fallback for when the Showdown data did not load.
    _compileAbility(ability) {
        const own = this._mergeHandlers(
            compileProgram(ability?.program, ability?.name || ''),
            this._rawHandlers(ability)
        );
        if (ability?.custom) return own;
        const name = ability?.name || '';
        const stock = (this.caps.sdAbilities ? showdownAbilityHandlers(name) : null) || builtinHandlers(name);
        return this._mergeHandlers(own, stock);
    }

    // Items resolve exactly the way abilities do now: the author's own block
    // program and hand-written code first, then Showdown's real handler for a
    // standard item, then the builtin table for when that could not be fetched.
    // A custom item used to be flavour-only and a standard one outside the
    // builtin list did nothing at all.
    _compileItem(item) {
        if (!item) return {};
        // An item's handlers are marked as an item's, so ability suppression
        // (Gastro Acid, Neutralizing Gas) leaves a held item alone.
        const own = this._mergeHandlers(
            markAsItem(compileProgram(item.program, item.name || '')),
            this._rawHandlers(item, { isItem: true })
        );
        if (item.custom) return own;
        const name = item.name || '';
        const stock = (this.caps.sdItems !== false ? showdownItemHandlers(name) : null)
            || builtinItemHandlers(name);
        return this._mergeHandlers(own, stock);
    }

    // Hand-written Showdown hooks, compiled only when this battle is allowed to
    // trust the code it is holding. See sd-hooks.js compileRawHooks for why
    // that gate exists and why both clients of a PvP battle skip it together.
    _rawHandlers(entity, opts = {}) {
        if (!entity?.rawCode || !this.trustLocalCode) return null;
        return compileRawHooks(entity.rawCode, entity.name || '', opts);
    }

    // A custom move's hand-written code, compiled for the MOVE pipeline. This
    // is what lets someone paste a whole Showdown move entry -- onModifyMove,
    // basePowerCallback, onHit, a secondaries block, a drain fraction -- and
    // have it run down the same path one of Showdown's own moves does, rather
    // than only the handful of hooks an ABILITY happens to share with a move.
    // Same trust gate as everything else hand-written.
    _rawMoveFx(move) {
        if (!move?.rawCode || !this.trustLocalCode) return null;
        return rawMoveEffects(move.rawCode, move.name || '', DATA_FIELDS);
    }

    // Two { event: [handler] } tables into one, keeping both sides' handlers.
    _mergeHandlers(a, b) {
        if (!b) return a || {};
        const merged = { ...(a || {}) };
        for (const [event, handlers] of Object.entries(b)) {
            merged[event] = [...(merged[event] || []), ...handlers];
        }
        return merged;
    }

    runEvent(eventName, pokemon, extra = {}) {
        if (!pokemon) return undefined;
        const handlers = [...(pokemon.abilityHandlers?.[eventName] || []), ...(pokemon.itemHandlers?.[eventName] || [])];
        if (!handlers.length) return extra.value;
        const ctx = {
            battle: this,
            self: pokemon,
            foe: this.foeOf(pokemon),
            move: extra.move || null,
            damage: extra.damage || 0,
            stat: extra.stat || null,
            crit: !!extra.crit,
            eff: extra.eff ?? null,
            status: extra.status || null,
            // Which side of a two-sided question this call is asking about.
            // Compound Eyes only sharpens its OWN aim and Sand Veil only blurs
            // when it is the one being aimed at, so a handler has to be able to
            // tell which of the two calls it is answering.
            role: extra.role || null,
            whose: extra.whose || null,
            // Which single type of a dual-typed target an effectiveness
            // question is about, so onEffectiveness can answer per type.
            effType: extra.effType || null,
            value: extra.value,
            vars: {},
            immune: false
        };
        let result = extra.value;
        for (const h of handlers) {
            // Abilities are suppressed by Gastro Acid / Neutralizing Gas style
            // effects; checked per-handler so suppression applied mid-turn
            // takes effect immediately. Items aren't subject to this.
            if (pokemon.volatiles.abilitysuppression && !h.isItem) continue;
            const out = h(ctx);
            if (h.isImmunity && out === 'immune') return 'immune';
            // Showdown writes a refusal as a plain `return false` (Immunity
            // turning down a poisoning, Inner Focus turning down a flinch).
            // A blocking handler is the only kind allowed to end the event.
            if (h.isBlocking && out === false) return false;
            if (h.isValueEvent && out !== undefined) { result = out; ctx.value = out; }
        }
        return result;
    }

    // ==================== stats ====================
    getStat(pokemon, stat, { ignoreBoosts = false, crit = false } = {}) {
        let value = pokemon.stats[stat];
        if (!ignoreBoosts) {
            const stage = clamp(pokemon.boosts[stat] || 0, -6, 6);
            // Crits ignore the defender's positive defense drops and the
            // attacker's negative attack drops, matching mainline behaviour.
            const useStage = crit ? (stat === 'atk' || stat === 'spa' ? Math.max(0, stage) : Math.min(0, stage)) : stage;
            value = boostStat(value, useStage);
        }
        if (stat === 'spe' && pokemon.status === 'par') value = modify(value, 0.5);
        // Let custom abilities modify the stat (statModify trigger).
        const modified = this.runEvent('modifyStat', pokemon, { stat, value, whose: 'self' });
        // The onSourceModify* / onFoeModify* family is held by the OTHER
        // Pokemon and speaks about this one's stat, so the same question is put
        // to the opponent -- with `whose` saying which of the two stats is
        // being weighed, so a handler only answers about the one it means.
        //
        // Guarded, because that second question is asked of a Pokemon whose
        // handler is free to read a stat itself (Gyro Ball and Electro Ball
        // both do), and answering it by asking the other side again is a loop
        // with nothing to stop it. Inside one, the foe simply does not get a
        // say -- which is the same answer it would give with no handler.
        this._statDepth ||= 0;
        let fromFoe;
        if (this._statDepth === 0) {
            this._statDepth++;
            try {
                fromFoe = this.runEvent('modifyStat', this.foeOf(pokemon), {
                    stat, value: Number.isFinite(modified) ? modified : value, whose: 'foe'
                });
            } finally {
                this._statDepth--;
            }
        }
        const settled = Number.isFinite(fromFoe) ? fromFoe
            : (Number.isFinite(modified) ? modified : value);
        return Math.max(1, Math.floor(settled));
    }

    // ==================== turn flow ====================
    // choice: {type:'move', index} | {type:'switch', index} | {type:'forfeit'}
    choose(sideIndex, choice) {
        if (this.ended) return false;
        if (!this._validateChoice(sideIndex, choice)) return false;
        this.choices[sideIndex] = choice;
        return true;
    }

    _validateChoice(sideIndex, choice) {
        const side = this.sides[sideIndex];
        const mon = this.active(sideIndex);
        if (!choice || !side) return false;
        if (choice.type === 'forfeit') return true;
        if (choice.type === 'switch') {
            const target = side.team[choice.index];
            return !!target && !target.fainted && choice.index !== side.activeIndex;
        }
        if (choice.type === 'move') {
            if (!mon || mon.fainted) return false;
            if (choice.index === STRUGGLE_INDEX) return this.mustStruggle(sideIndex);
            return canSelectMove(mon, choice.index);
        }
        return false;
    }

    bothChosen() { return this.choices.every(Boolean); }

    // Runs one full turn from the two queued choices. Returns the log entries
    // produced by this turn so the caller can stream them to the UI.
    runTurn() {
        if (this.ended) return [];
        const logStart = this.log.length;
        this.turn++;
        this.add('turn', this.turn);

        // A pivot requested last turn is either honoured before this one runs
        // or is moot. Clearing it here means a replacement the UI never asked
        // for can never leave a side stuck owing a switch forever.
        this.pendingSwitches.clear();

        const forfeit = this.choices.findIndex(c => c?.type === 'forfeit');
        if (forfeit >= 0) {
            this._end(1 - forfeit, 'forfeit');
            return this.log.slice(logStart);
        }

        for (const s of this.sides) { const m = this.active(s.index); if (m) m.damageTakenThisTurn = 0; }

        // 1. switches resolve before any move, in side order.
        for (let i = 0; i < 2; i++) {
            if (this.choices[i]?.type === 'switch') this._switchIn(i, this.choices[i].index);
        }

        // 2. turn-start ability hooks.
        for (let i = 0; i < 2; i++) this.runEvent('turnStart', this.active(i));

        // Move locks and switch traps are re-asked every turn rather than
        // remembered, so an ability that stops applying (its holder switched,
        // or was suppressed) stops locking the same turn it stops applying.
        // Whatever an ability disabled last turn is released first, so this
        // never accumulates.
        for (let i = 0; i < 2; i++) {
            const mon = this.active(i);
            if (!mon) continue;
            for (const slot of mon.moves) if (slot.disabledByEvent) { slot.disabled = false; slot.disabledByEvent = false; }
            mon.trapped = false;
            this.runEvent('disableMove', mon);
            this.runEvent('trapPokemon', mon);
        }

        // 3. moves, ordered by priority then effective speed then a coin flip.
        const movers = [];
        for (let i = 0; i < 2; i++) {
            if (this.choices[i]?.type !== 'move') continue;
            const mon = this.active(i);
            if (!mon || mon.fainted) continue;
            let slot = this.choices[i].index === STRUGGLE_INDEX
                ? this._struggleSlot()
                : mon.moves[this.choices[i].index];
            // Mid-charge, the move that is already underway is the only thing
            // this Pokemon can do -- whatever choice arrived over the wire.
            const charging = mon.volatiles.twoturnmove?.moveId;
            if (charging) slot = mon.moves.find(s => s.move.id === charging) || slot;
            // Encore overrides the choice the same way a charge does: whatever
            // arrived, the encored move is the only thing that can happen.
            const encored = mon.volatiles.encore?.moveId;
            if (!charging && encored) slot = mon.moves.find(s => s.move.id === encored) || slot;
            if (!slot) continue;
            // Prankster, Gale Wings, Quick Claw and Triage all move a move up
            // or down the queue, and all of them are written as
            // onModifyPriority / onFractionalPriority.
            let priority = slot.move.priority || 0;
            const shifted = this.runEvent('modifyPriority', mon, { move: slot.move, value: priority });
            if (Number.isFinite(shifted)) priority = shifted;
            movers.push({ side: i, mon, slot, priority, speed: this.getStat(mon, 'spe') });
        }
        // The speed-tie coin flip is drawn once per action up front. Drawing it
        // inside the comparator made the number of RNG calls depend on the
        // engine's sort implementation, which would desynchronise two clients
        // replaying the same seed.
        const ordered = orderActions(movers, () => this.rng.random(1 << 30));
        this._queue = [...ordered];
        this._midTurn = true;

        // A pivot suspends the turn here rather than at the end of it; the
        // replacement's arrival (switchTo) resumes what is left.
        if (!this._runQueue()) return this.log.slice(logStart);

        this._endTurn();
        return this.log.slice(logStart);
    }

    // Runs whatever is left of this turn's action queue. Returns false when the
    // turn has been SUSPENDED for a pivot.
    //
    // U-turn, Volt Switch and Flip Turn take their user off the field the
    // moment the move connects, and everything still to happen that turn
    // happens against the Pokemon that comes in -- not the one that left.
    // Deferring the switch to the end of the turn, as this used to, meant the
    // opponent's move still hit the pivoting Pokemon and the replacement
    // arrived a turn late, which is not how pivoting works at all.
    _runQueue() {
        while (this._queue.length && !this.ended) {
            // Off the queue before it runs, so a move never sees itself as
            // something its user has yet to do.
            const m = this._queue.shift();
            if (m.mon.fainted) continue;
            this._executeMove(m.mon, m.slot);
            this._resolveFaints();
            if (this._pivotPending()) return false;
        }
        return true;
    }

    // A side owes the field an IMMEDIATE replacement: it pivoted out, is still
    // standing, and has somewhere to pivot to. A faint is deliberately not this
    // -- gen 5 onwards sends that replacement in once the turn is over, which
    // is what the end-of-turn needsSwitch() flow already does.
    _pivotPending() {
        return this.sides.some(side => {
            const mon = this.active(side.index);
            return !!mon && !mon.fainted && this.pendingSwitches.has(mon)
                && side.team.some(m => !m.fainted && m !== mon);
        });
    }

    _endTurn() {
        this._midTurn = false;
        // 4. end of turn: weather, status, ability residuals.
        if (!this.ended) this._residual();
        this._resolveFaints();

        this._queue = [];
        // "This turn" flags age out here, so next turn's Payback and Avalanche
        // read the turn that actually just happened.
        for (const side of this.sides) {
            for (const m of side.team) {
                m.newlySwitched = false;
                m.moveThisTurn = false;
                for (const e of m.attackedBy) e.thisTurn = false;
            }
        }

        this.choices = [null, null];
    }

    // ---------------------------------------------------------------- moves
    // Showdown's own move handlers, compiled once per move id. A custom move is
    // the block editor's and is never overridden by the bridge -- the same
    // precedence _compileAbility gives a custom ability.
    // A custom move's OWN logic: the block program its author built plus any
    // hand-written hooks. Moves could carry a program (dex.js has read one off
    // `blocks` all along) and nothing ever ran it, so a move built in the block
    // editor did exactly nothing beyond its data fields.
    //
    // Compiled once per move and cached, the same way _moveEffects caches
    // Showdown's handlers.
    _moveProgram(move) {
        if (!move) return null;
        const key = move.id || move.name || '';
        if (this._movePrograms.has(key)) return this._movePrograms.get(key);
        const compiled = this._mergeHandlers(
            compileProgram(move.program, move.name || ''),
            // `kind: 'move'` leaves the move-pipeline hooks alone -- _rawMoveFx
            // below claims those, and binding onAfterMove in both places would
            // fire it twice for the same move.
            this._rawHandlers(move, { kind: 'move' })
        );
        const value = Object.keys(compiled).length ? compiled : null;
        this._movePrograms.set(key, value);
        return value;
    }

    // Runs one of the move's own events. `self` is whoever used it, so every
    // block that says "this Pokemon" means its user, and "the opposing
    // Pokemon" means what it was aimed at.
    _runMoveEvent(event, user, target, extra = {}) {
        const handlers = this._moveProgram(extra.move)?.[event];
        if (!handlers?.length) return extra.value;
        const ctx = {
            battle: this, self: user, foe: target,
            move: extra.move || null, damage: extra.damage || 0,
            stat: null, crit: !!extra.crit, eff: extra.eff ?? null,
            status: null, role: null, whose: null,
            value: extra.value, vars: {}, immune: false
        };
        let result = extra.value;
        for (const h of handlers) {
            const out = h(ctx);
            if (h.isValueEvent && out !== undefined) { result = out; ctx.value = out; }
        }
        return result;
    }

    _moveEffects(move) {
        // Struggle is the engine's own, implemented here in full, so it does
        // not go through the bridge for a second opinion.
        if (!move || move.struggle) return null;
        const key = move.id || move.name || '';
        if (this._moveFx.has(key)) return this._moveFx.get(key);
        // A custom move is never overridden by Showdown's table -- the same
        // precedence _compileAbility gives a custom ability -- but it does get
        // the pipeline, so its author's own hand-written entry runs there.
        const fx = move.custom
            ? this._rawMoveFx(move)
            : (this.caps.sdMoves ? showdownMoveEffects(move.id) : null);
        this._moveFx.set(key, fx);
        return fx;
    }

    // Metronome, Sleep Talk, Copycat, Assist, Me First and Nature Power all
    // finish by running a DIFFERENT move from inside the one being used. The
    // synthetic slot means the called move spends no PP and does not count as
    // the user's action -- it is not something they chose.
    //
    // Depth-limited, because a called move can call another (Metronome rolling
    // Sleep Talk) and nothing in the data stops that going round forever.
    useMove(moveOrId, user, target = null) {
        if (!user || user.fainted || this.ended || this._callDepth >= 2) return false;
        const id = (moveOrId && typeof moveOrId === 'object') ? (moveOrId.id || moveOrId.name) : moveOrId;
        const move = this.dex.getMove(id);
        if (!move || move.unknown) return false;
        this._callDepth++;
        try {
            this._executeMove(user, { move, pp: 1, maxpp: 1, disabled: false, called: true },
                target || this.foeOf(user));
        } finally {
            this._callDepth--;
        }
        return true;
    }

    // One mutable copy of the move per use. Showdown's onModifyMove rewrites
    // the move being used (Weather Ball's type, Acrobatics' power), and that
    // must never leak into the next use or into another Pokemon's copy of it.
    // The dex entry itself stays frozen.
    _activeMove(move, fx) {
        const active = { ...move, secondaries: [...(move.secondaries || [])] };
        if (fx) Object.assign(active, fx.data);
        return active;
    }

    // Thin wrapper so `lastMove` advances only once the move is done. Copycat
    // reads it mid-move and must see the PREVIOUS move; there are too many
    // early exits below to update it reliably at the end of the body.
    _executeMove(user, slot, forcedTarget = null) {
        try {
            this._runMove(user, slot, forcedTarget);
        } finally {
            this.lastMove = slot.move;
        }
    }

    _runMove(user, slot, forcedTarget = null) {
        const fx = this._moveEffects(slot.move);
        const move = this._activeMove(slot.move, fx);
        const target = forcedTarget || this.foeOf(user);
        // What the move acts ON. For a self-targeting move (Sleep Talk,
        // Conversion, Swords Dance) that is its own user, and Showdown hands
        // its handlers exactly that -- reading the foe instead had Sleep Talk
        // calling a move out of the opponent's move slots.
        let acting = target;
        const hook = (name, extra = {}, fallback = undefined) =>
            runMoveHook(fx, name, { battle: this, user, target: acting, move, ...extra }, fallback);
        // A called move (Metronome's pick) is not the user's own action, and a
        // charge move's second turn was already paid for on its first.
        const called = !!slot.called;
        const releasing = user.volatiles.twoturnmove?.moveId === move.id;

        // Pre-move status gates -- skipped for a called move, which has already
        // been through them as part of the move that called it. Re-running them
        // meant Sleep Talk's pick was itself blocked by the sleep it needs.
        if (!called) {
        if (user.status === 'slp') {
            user.statusData.turns = (user.statusData.turns || 0) + 1;
            if (user.statusData.turns > (user.statusData.duration || 1)) {
                this.cureStatus(user, 'slp');
            } else if (!move.sleepUsable) {
                // Snore and Sleep Talk are the moves that work while asleep.
                this.add('cant', this.ref(user), 'slp');
                return;
            }
        }
        if (user.status === 'frz') {
            if (this.rng.chance(20, 100)) this.cureStatus(user, 'frz');
            else { this.add('cant', this.ref(user), 'frz'); return; }
        }
        // Mainline's order is sleep/freeze, then flinch, then confusion, then
        // paralysis (Showdown's onBeforeMove priorities 10, 8, 3, 1). Checking
        // paralysis first, as this used to, both showed the wrong message and
        // drew a paralysis roll for a Pokemon that was never going to move.
        if (user.volatiles.flinch) {
            this.add('cant', this.ref(user), 'flinch');
            this.removeVolatile(user, 'flinch');
            return;
        }
        if (user.volatiles.taunt && slot.move.category === 'Status') {
            this.add('cant', this.ref(user), 'taunt', slot.move.name);
            return;
        }
        if (user.volatiles.confusion && this._confusionBlocks(user)) return;
        if (user.status === 'par' && this.rng.chance(25, 100)) {
            this.add('cant', this.ref(user), 'par');
            return;
        }
        }

        if (!called && !releasing) slot.pp = Math.max(0, slot.pp - 1);
        user.lastMove = move;
        user.moveThisTurn = move.id;
        // Counts moves made since switching in, which is the whole of what
        // "only works on your first turn out" means to First Impression.
        if (!called) user.activeMoveActions++;
        if (move.struggle) this.add('-activate', this.ref(user), 'struggle');
        this.add('move', this.ref(user), move.name, target ? this.ref(target) : '');
        this.runEvent('beforeMove', user, { move });

        // Showdown lets a move rewrite itself before anything else reads it,
        // which can include where it points. `move` here is the per-use copy
        // (_activeMove), so everything below reads the rewritten version and
        // nothing leaks into the next use of the same move.
        //
        // Both sides are asked, in Showdown's order: type first (Pixilate,
        // Normalize, Aerilate), then the move as a whole (Serene Grace, Sheer
        // Force, Long Reach). The user's own effects speak as 'user' and the
        // target's as 'target', so onModifyMove and onFoeModifyMove each apply
        // from the side they belong to.
        hook('onModifyType');
        this.runEvent('modifyType', user, { move, role: 'user' });
        hook('onModifyMove');
        this.runEvent('modifyMove', user, { move, role: 'user' });
        if (target) this.runEvent('modifyMove', target, { move, role: 'target' });
        if (move.target === 'self') acting = user;

        // "Fails unless ..." -- First Impression, Sucker Punch, Burn Up.
        // A two-turn move reports its charge turn exactly the way a move
        // reports failure, so the volatile it just set is what tells the two
        // apart. Solar Beam skips the charge in sun by never setting it.
        if (moveFailed(hook('onTry')) || moveFailed(hook('onTryMove'))) {
            if (this._beginCharge(user, move)) return;
            this.add('-fail', this.ref(user), move.name);
            hook('onMoveFail');
            return;
        }
        if (releasing) this._endCharge(user);

        // Protect used twice in a row usually fails, and a third time almost
        // always does. Checked after onTry so a move that was going to fail
        // for its own reasons doesn't spend the counter.
        if (isStallingMove(move) && !this._stallCheck(user)) {
            this.add('-fail', this.ref(user), move.name);
            hook('onMoveFail');
            return;
        }

        if (!target || target.fainted) {
            if (move.category === 'Status') this._applyStatusMove(user, user, move, fx);
            return;
        }

        // Psychic Terrain refuses any increased-priority move aimed at a
        // Pokemon standing on it -- Extreme Speed, Sucker Punch, Prankster's
        // status moves. It does not stop a Pokemon hitting itself.
        if (this.field.terrain === 'Psychic' && (move.priority || 0) > 0
            && target !== user && this._isGrounded(target)) {
            this.add('-activate', this.ref(target), 'Psychic Terrain');
            return;
        }

        // Protect blocks damaging and most status moves outright -- except for
        // the handful written to go through it.
        if (target.volatiles.protect && move.flags?.protect !== false && !move.breaksProtect) {
            this.add('-activate', this.ref(target), 'protect');
            return;
        }
        if (move.breaksProtect) this.removeVolatile(target, 'protect');

        // A target partway through Dig or Fly is off the field for everything
        // except the handful of moves written to reach it.
        if (this._isSemiInvulnerable(target, move)) {
            this.add('-miss', this.ref(user), this.ref(target));
            return;
        }

        // Type-based ability immunity (moveImmunity trigger).
        if (this.runEvent('tryHit', target, { move }) === 'immune') {
            this.add('-immune', this.ref(target), move.type);
            return;
        }

        // Dream Eater only hits a sleeper; Endeavor only a healthier target.
        if (hook('onTryImmunity', {}, true) === false) {
            this.add('-immune', this.ref(target), move.type);
            return;
        }
        if (moveFailed(hook('onTryHit'))) {
            this.add('-fail', this.ref(user), move.name);
            hook('onMoveFail');
            return;
        }

        if (move.category === 'Status') {
            // A substitute turns away anything aimed at the Pokemon behind it.
            // A move aimed at its own user (Swords Dance, Substitute itself)
            // is not aimed at anybody's substitute.
            if (acting !== user && this._substituteFor(target, user, move)) {
                this.add('-activate', this.ref(target), 'Substitute', 'block');
                return;
            }
            if (!this._accuracyCheck(user, target, move)) return;
            this._applyStatusMove(user, acting, move, fx);
            this._runMoveEvent('afterMoveHit', user, target, { move });
            this._applySelfEffects(user, target, move);
            this._runMoveEvent('afterMove', user, target, { move });
            hook('onAfterMove');
            this.runEvent('afterMove', user, { move });
            return;
        }

        const eff = this._effectiveness(move, target, fx);
        if (eff === 0 && !move.ignoreImmunity) {
            this.add('-immune', this.ref(target), move.type);
            return;
        }
        if (!this._accuracyCheck(user, target, move)) return;

        // Seismic Toss, Super Fang, Sonic Boom and Endeavor never touch the
        // damage formula; null here means "this is an ordinary damaging move".
        const fixed = this._fixedDamage(user, target, move, fx);
        if (fixed !== null && fixed <= 0) {
            this.add('-fail', this.ref(user), move.name);
            hook('onMoveFail');
            return;
        }

        // Everything that wants to act once, on the way in, rather than per
        // hit -- an animation, a one-off cost, a self-inflicted condition.
        hook('onPrepareHit');
        this.runEvent('prepareHit', user, { move });

        // The hit count was being read from the move object rather than from
        // move.multihit, which made Number(move) NaN and quietly collapsed
        // every multi-hit move to a single hit.
        const hits = move.multihit ? this._rollMultihit(move.multihit) : 1;
        let totalDealt = 0;
        let hitSubstitute = false;
        for (let i = 0; i < hits; i++) {
            if (target.fainted) break;
            let damage = fixed, crit = false;
            if (fixed === null) ({ damage, crit } = this._calcDamage(user, target, move, eff, fx));
            const sub = this._substituteFor(target, user, move);
            if (sub) hitSubstitute = true;
            const dealt = sub
                ? this._damageSubstitute(sub, target, damage)
                : this.damage(damage, target, user, move.name);
            totalDealt += dealt;
            // Effectiveness is a property of the move, so it is said once. A
            // crit is rolled per hit, so it is said per hit -- announcing it
            // only on the first meant a multi-hit move's later crits landed
            // silently.
            if (crit) this.add('-crit', this.ref(target));
            if (i === 0) {
                if (eff > 1) this.add('-supereffective', this.ref(target));
                else if (eff < 1) this.add('-resisted', this.ref(target));
            }
            // The defender's ability reacts to being hit -- this is the hook a
            // "heal based on damage taken" custom ability rides on. A hit its
            // substitute took is not a hit on the Pokemon, so nothing of its
            // own reacts to it.
            if (!sub) this.runEvent('damagingHit', target, { move, damage: dealt, crit });
        }
        if (hits > 1) this.add('-hitcount', this.ref(target), hits);

        // Mainline ROUNDS drain, recoil and Struggle's self-damage; it does not
        // floor them (Showdown: clampIntRange(Math.round(...), 1)). Flooring
        // was one point light on roughly half of all of them.
        if (move.drain && totalDealt > 0) {
            this.heal(Math.max(1, Math.round(totalDealt * move.drain[0] / move.drain[1])), user, 'drain');
        }
        if (move.recoil && totalDealt > 0) {
            this.damage(Math.max(1, Math.round(totalDealt * move.recoil[0] / move.recoil[1])), user, user, 'recoil');
        }

        // Struggle costs its user a quarter of its maximum HP for having had to
        // resort to it -- recoil in its own right, not the move's.
        if (move.struggle && totalDealt > 0) {
            this.damage(Math.max(1, Math.round(user.maxhp / 4)), user, user, 'recoil');
        }

        // Scald and Steam Eruption thaw what they hit, before the burn rolls.
        if (move.thawsTarget && target.status === 'frz') this.cureStatus(target, move.name);

        this._runMoveEvent('afterMoveHit', user, target, { move, damage: totalDealt, eff });
        this._applySecondaries(user, target, move, hitSubstitute);
        // Close Combat's own stat drop, U-turn's exit, Dragon Tail's shove.
        this._applySelfEffects(user, target, move);
        // Knock Off's item removal and everything else Showdown writes as a
        // straight onHit rather than as data.
        hook('onHit');
        hook('onAfterHit');
        hook('onAfterMove');
        this._runMoveEvent('afterMove', user, target, { move, damage: totalDealt, eff });
        this.runEvent('afterMoveHit', user, { move, damage: totalDealt });
        this.runEvent('afterMove', user, { move, damage: totalDealt });
    }

    // The stall counter behind Protect's diminishing returns. The first use
    // always works; each consecutive one is a third as likely as the last,
    // down to 1/729. The counter lives in a volatile with a two-turn duration
    // rather than a plain field, so that skipping a turn (or switching out,
    // which clears volatiles) resets it -- exactly the two ways mainline lets
    // a Pokemon earn a fresh Protect.
    _stallCheck(user) {
        const v = user.volatiles.stall;
        if (!v) {
            this.addVolatile(user, 'stall', { duration: 2, counter: 3 });
            return true;
        }
        const counter = v.counter || 3;
        if (!this.rng.chance(1, counter)) {
            // A failed stall move resets the odds, so the next one is free.
            this.removeVolatile(user, 'stall');
            return false;
        }
        v.counter = Math.min(729, counter * 3);
        // Still stalling: the clock starts over rather than lapsing this turn.
        v.turns = 0;
        return true;
    }

    // Confusion. It was being applied as a volatile by Confuse Ray, Swagger,
    // Outrage and every secondary that sets it -- and then doing nothing at
    // all, because nothing ever read it. Counts down on its holder's own turns
    // (2-5 of them), and one turn in three the holder hits itself instead: a
    // typeless 40 BP physical hit off its own Attack against its own Defense,
    // which cannot crit and cannot miss. Returns true when the move is lost.
    _confusionBlocks(user) {
        const v = user.volatiles.confusion;
        v.turns = (v.turns || 0) + 1;
        if (v.turns > (v.duration || 1)) {
            this.removeVolatile(user, 'confusion');
            return false;
        }
        this.add('-activate', this.ref(user), 'confusion');
        if (!this.rng.chance(33, 100)) return false;
        const damage = calcDamage({
            level: user.level,
            basePower: 40,
            attack: this.getStat(user, 'atk'),
            defense: this.getStat(user, 'def'),
            isBurned: user.status === 'brn',
            roll16: this.rng.random(16)
        });
        this.damage(Math.max(1, damage), user, user, 'confusion');
        return true;
    }

    // ------------------------------------------------------------ substitute
    // A quarter of the user's maximum HP becomes a decoy that soaks damage and
    // turns away status until it breaks. It used to be added as a bare
    // volatile: it cost nothing, absorbed nothing and blocked nothing.
    trySubstitute(user) {
        if (user.volatiles.substitute) { this.add('-fail', this.ref(user), 'Substitute'); return false; }
        const cost = Math.floor(user.maxhp / 4);
        // Exactly a quarter is not enough -- mainline needs the user to survive
        // paying for it.
        if (cost < 1 || user.hp <= cost) { this.add('-fail', this.ref(user), 'Substitute'); return false; }
        this.damage(cost, user, null, 'Substitute');
        this.addVolatile(user, 'substitute', { hp: cost });
        return true;
    }

    // The substitute standing between this move and its target, or null. Sound
    // moves and anything flagged bypasssub go straight past one, and a move can
    // never be stopped by its own user's.
    _substituteFor(target, user, move) {
        if (!target?.volatiles?.substitute || target === user) return null;
        if (move?.flags?.bypasssub || move?.flags?.sound || move?.infiltrates) return null;
        return target.volatiles.substitute;
    }

    // Damage aimed at a substitute stops at it. The hit still counts for drain
    // and recoil, exactly as mainline has it, but the Pokemon behind it takes
    // nothing and its own on-being-hit ability never fires.
    _damageSubstitute(sub, target, amount) {
        const dealt = Math.min(Math.max(1, Math.floor(amount)), sub.hp);
        sub.hp -= dealt;
        if (sub.hp <= 0) this.removeVolatile(target, 'substitute');
        else this.add('-activate', this.ref(target), 'Substitute', 'damage');
        return dealt;
    }

    // ------------------------------------------------------------- charging
    // Showdown's charge moves all share one onTryMove: remove the move's own
    // volatile and fire if it was there, otherwise announce the charge, set
    // `twoturnmove`, and report failure. This turns that reported failure into
    // a real charge turn -- and adds the move-id volatile the handler will
    // look for next turn, which Showdown's own condition would have set.
    _beginCharge(user, move) {
        if (!user.volatiles.twoturnmove) return false;
        user.volatiles.twoturnmove.moveId = move.id;
        user.volatiles[move.id] = { id: move.id, layers: 1, turns: 0, silent: true };
        // Locked in until it fires. This is the same disable the Choice items
        // use, so the move buttons and the bot already understand it.
        for (const s of user.moves) s.disabled = s.move.id !== move.id;
        return true;
    }

    _endCharge(user) {
        const id = user.volatiles.twoturnmove?.moveId;
        delete user.volatiles.twoturnmove;
        if (id) delete user.volatiles[id];
        for (const s of user.moves) s.disabled = false;
    }

    // While Dig or Fly is charging, its own condition decides what can still
    // reach its user -- Earthquake reaches something underground, nothing else
    // does. An unbridged or absent condition means "no protection".
    _isSemiInvulnerable(target, move) {
        const chargingId = target?.volatiles?.twoturnmove?.moveId;
        if (!chargingId) return false;
        const fx = this._moveEffects(this.dex.getMove(chargingId));
        if (!fx?.condition?.onInvulnerability) return false;
        return runConditionHook(fx, 'onInvulnerability',
            { battle: this, user: target, target: null, move }, undefined) === false;
    }

    // Effectiveness one defending type at a time, because that is the shape
    // Showdown's onEffectiveness hook expects -- Freeze-Dry's "Water does not
    // resist this" is a statement about a single type, not about the product.
    //
    // Showdown also counts effectiveness in powers of two (-1 resists, 0
    // neutral, +1 super effective) rather than as the multiplier this engine
    // works in, so each step is converted before the hook sees it and back
    // afterwards. Immunity is not a step on that scale and skips the hook.
    _effectiveness(move, target, fx) {
        let mult = 1;
        for (const t of target.types) {
            const step = typeEffectiveness(move.type, [t]);
            if (step === 0) return 0;
            const exponent = Math.round(Math.log2(step));
            let out = runMoveHook(fx, 'onEffectiveness',
                { battle: this, user: null, target, move, value: exponent, type: t }, exponent);
            // The target's own ability/item gets the same question the move
            // got, once per type it has -- which is what an ability that
            // rewrites its holder's weaknesses is written as.
            const fromHolder = this.runEvent('effectiveness', target, {
                move, value: Number.isFinite(out) ? out : exponent, effType: t
            });
            if (Number.isFinite(fromHolder)) out = fromHolder;
            mult *= 2 ** (Number.isFinite(out) ? out : exponent);
        }
        return mult;
    }

    // Fixed damage, or null when the move goes through the formula like a
    // normal one. Zero is a real answer (Endeavor against a healthier target)
    // and means the move fails.
    _fixedDamage(user, target, move, fx) {
        const fromCallback = runMoveHook(fx, 'damageCallback',
            { battle: this, user, target, move }, undefined);
        if (Number.isFinite(fromCallback)) return Math.max(0, Math.trunc(fromCallback));
        if (move.ohko) return target.hp;
        if (move.damage === 'level') return user.level;
        if (Number.isFinite(move.damage)) return Math.max(0, Math.trunc(move.damage));
        return null;
    }

    // Showdown's `self` block is the move acting on its own user once it has
    // connected: Close Combat's Def/SpD drop, Draco Meteor's SpA drop.
    _applySelfEffects(user, target, move) {
        const self = move.self;
        if (self && !user.fainted) {
            if (self.boosts) this.boost(user, self.boosts, user, move.name);
            if (self.volatileStatus) this.addVolatile(user, self.volatileStatus);
            if (self.sideCondition) this.addSideCondition(user.side, self.sideCondition);
        }
        // U-turn and Volt Switch leave once they have connected. The UI's
        // existing "this side owes a replacement" flow prompts for the incoming
        // Pokemon, the same way it does after a faint.
        if (move.selfSwitch && !user.fainted) this.requestForcedSwitch(user);
        // Dragon Tail and Whirlwind choose the replacement themselves, as
        // mainline does, so neither player is asked.
        if (move.forceSwitch && target && !target.fainted) this._forceSwitchOut(target);
    }

    _forceSwitchOut(mon) {
        const side = mon.side;
        const options = side.team
            .map((m, i) => i)
            .filter(i => !side.team[i].fainted && i !== side.activeIndex);
        if (!options.length) return;
        this._switchIn(side.index, options[this.rng.random(options.length)]);
    }

    _rollMultihit(multihit) {
        return multihitCount(multihit, this.rng.random(100), (lo, hi) => this.rng.range(lo, hi));
    }

    // Crit odds by stage (gen 7+): 1/24, 1/8, 1/2, then guaranteed. The old
    // check collapsed every raised stage into 1/8, so a high-crit move stacked
    // with Focus Energy critted far less than it should.
    _rollCrit(critRatio) {
        const denom = critDenominator(critRatio);
        return denom === 1 || this.rng.chance(1, denom);
    }

    _accuracyCheck(user, target, move) {
        if (move.accuracy === true) return true;
        // Unaware and friends can strike the evasion side of this out.
        const evasion = this._boostsIgnored(target, user, 'evasion', move) ? 0 : (target.boosts.evasion || 0);
        const stage = clamp((user.boosts.accuracy || 0) - evasion, -6, 6);
        let acc = boostAccuracy(Number(move.accuracy), stage);

        // Both sides get a say on whether the move lands, the same way both
        // sides get a say on damage: Compound Eyes and Hustle move the
        // attacker's aim, Sand Veil and Snow Cloak blur the target. `role`
        // tells a handler which of the two calls it is answering, so an
        // ability only ever applies from the side it belongs to.
        const fromUser = this.runEvent('modifyAccuracy', user, { move, value: acc, role: 'user' });
        if (Number.isFinite(fromUser)) acc = fromUser;
        const fromTarget = this.runEvent('modifyAccuracy', target, { move, value: acc, role: 'target' });
        if (Number.isFinite(fromTarget)) acc = fromTarget;
        acc = clamp(Math.floor(acc), 1, 100);

        if (this.rng.random(100) < acc) return true;
        this.add('-miss', this.ref(user), this.ref(target));
        return false;
    }

    // "Should this Pokemon's stat stages be counted at all?" -- asked once for
    // each side of a damage calculation, and once for evasion.
    //
    // Both the owner of the stages and its opponent get a say, and that is the
    // whole difference between Unaware (which ignores the OTHER one's stages)
    // and an ability that ignores its own: the handler answers on `whose`.
    //   role  : 'offensive' | 'defensive' | 'evasion'
    //   whose : 'self' when the holder owns the stages being weighed,
    //           'foe'  when its opponent does.
    _boostsIgnored(owner, other, role, move) {
        if (!owner) return false;
        if (this.runEvent('ignoreBoosts', owner, { role, whose: 'self', move, value: false }) === true) return true;
        if (!other) return false;
        return this.runEvent('ignoreBoosts', other, { role, whose: 'foe', move, value: false }) === true;
    }

    // Damage runs through mechanics.js, which follows mainline's order and its
    // fixed-point rounding rather than multiplying floats and flooring.
    _calcDamage(user, target, move, eff, fx = null) {
        const physical = move.category === 'Physical';
        // Super Luck and the Scope Lens family sharpen the odds; both are
        // written as onModifyCritRatio.
        let critRatio = move.critRatio || 0;
        const sharpened = this.runEvent('modifyCritRatio', user, { move, value: critRatio });
        if (Number.isFinite(sharpened)) critRatio = sharpened;

        // Wicked Blow and Frost Breath declare the crit instead of rolling for
        // it. Skipping the roll rather than rolling and discarding it is what
        // keeps both clients drawing the same values from the shared seed.
        let crit = move.willCrit ? true : this._rollCrit(critRatio);
        // Battle Armor and Shell Armor refuse the crit outright, which
        // Showdown writes as onCriticalHit returning false on the TARGET.
        if (crit && this.runEvent('criticalHit', target, { move }) === false) crit = false;

        // Body Press attacks with Defense; Psyshock hits the physical side.
        const offStat = move.overrideOffensiveStat || (physical ? 'atk' : 'spa');
        const defStat = move.overrideDefensiveStat || (physical ? 'def' : 'spd');
        const A = this.getStat(user, offStat, {
            crit, ignoreBoosts: this._boostsIgnored(user, target, 'offensive', move)
        });
        const D = this.getStat(target, defStat, {
            crit, ignoreBoosts: this._boostsIgnored(target, user, 'defensive', move)
        });

        // Gyro Ball, Grass Knot, Electro Ball and the rest work their power out
        // from live battle state rather than carrying a fixed number.
        let power = move.basePower;
        const computed = runMoveHook(fx, 'basePowerCallback',
            { battle: this, user, target, move }, undefined);
        if (Number.isFinite(computed)) power = Math.max(0, Math.trunc(computed));

        // Facade, Brine and Knock Off scale on top of whatever the power ended
        // up as; Showdown writes these as this.chainModify().
        const scaled = runMoveHook(fx, 'onBasePower',
            { battle: this, user, target, move, value: power }, power);
        if (Number.isFinite(scaled)) power = Math.max(0, Math.trunc(scaled));

        // Technician, Iron Fist, Sheer Force, Life Orb and the type gems are
        // all onBasePower on the attacker; Heatproof and the resist berries
        // are onSourceBasePower on the defender. Both sides get asked, tagged
        // with which of the two calls this is.
        const fromUser = this.runEvent('modifyBasePower', user, { move, value: power, role: 'user' });
        if (Number.isFinite(fromUser)) power = Math.max(0, Math.trunc(fromUser));
        const fromTarget = this.runEvent('modifyBasePower', target, { move, value: power, role: 'target' });
        if (Number.isFinite(fromTarget)) power = Math.max(0, Math.trunc(fromTarget));
        // A custom move's own hand-written onBasePower rides the same event.
        const fromMovePower = this._runMoveEvent('modifyBasePower', user, target, { move, value: power });
        if (Number.isFinite(fromMovePower)) power = Math.max(0, Math.trunc(fromMovePower));

        // Terrain IS a base-power modifier in mainline (the terrain condition's
        // own onBasePower), unlike weather -- see _terrainPowerMod.
        const terrainMod = this._terrainPowerMod(user, target, move);
        if (terrainMod !== 1) power = modify(power, terrainMod);

        let damage = calcDamage({
            level: user.level,
            basePower: power,
            attack: A,
            defense: D,
            isCrit: crit,
            stab: user.types.includes(move.type) ? 1.5 : 1,
            typeMod: eff,
            isBurned: user.status === 'brn' && physical,
            // Rain and sun. A DAMAGE modifier, not a base-power one -- see the
            // note in mechanics.js calcDamage.
            weatherMod: this._weatherDamageMod(move),
            // 0..15: mainline draws this and subtracts, giving 85%-100%.
            roll16: this.rng.random(16)
        });

        // Earthquake against something underground, Gust against something in
        // the air: the charging move's own condition doubles it.
        const chargingId = target.volatiles.twoturnmove?.moveId;
        if (chargingId) {
            const chargeFx = this._moveEffects(this.dex.getMove(chargingId));
            const boosted = runConditionHook(chargeFx, 'onSourceModifyDamage',
                { battle: this, user, target, move, value: damage }, damage);
            if (Number.isFinite(boosted)) damage = boosted;
        }

        // Custom abilities (and items) get to modify damage on both sides.
        const fromMove = this._runMoveEvent('modifyDamageDealt', user, target, { move, value: damage, crit, eff });
        if (Number.isFinite(fromMove)) damage = fromMove;
        const dealt = this.runEvent('modifyDamageDealt', user, { move, value: damage, crit, eff });
        if (Number.isFinite(dealt)) damage = dealt;
        const taken = this.runEvent('modifyDamageTaken', target, { move, value: damage, crit, eff });
        if (Number.isFinite(taken)) damage = taken;

        return { damage: Math.max(1, Math.trunc(damage)), crit };
    }

    // Rain and sun, as mainline's onWeatherModifyDamage.
    _weatherDamageMod(move) {
        if (this.field.weather === 'Rain') {
            if (move.type === 'Water') return 1.5;
            if (move.type === 'Fire') return 0.5;
        } else if (this.field.weather === 'Sun') {
            if (move.type === 'Fire') return 1.5;
            if (move.type === 'Water') return 0.5;
        }
        return 1;
    }

    // Terrain only reaches a Pokemon standing ON it. This engine has no
    // Levitate or Air Balloon, so "grounded" is simply "not a Flying type" --
    // the same test the entry hazards already use.
    _isGrounded(mon) { return !!mon && !mon.types.includes('Flying'); }

    // The four terrains were being set and announced and then doing nothing:
    // no power boost, no sleep block, no Grassy healing. Mainline puts the
    // power part on the terrain's own onBasePower, which is why it lives with
    // base power rather than with the weather modifier above.
    _terrainPowerMod(user, target, move) {
        const terrain = this.field.terrain;
        if (!terrain) return 1;
        if (terrain === 'Grassy') {
            if (move.type === 'Grass' && this._isGrounded(user)) return 1.3;
            // Grassy Terrain softens the ground-shaking moves for everything
            // standing in it.
            if (['earthquake', 'bulldoze', 'magnitude'].includes(move.id) && this._isGrounded(target)) return 0.5;
            return 1;
        }
        if (terrain === 'Electric') return move.type === 'Electric' && this._isGrounded(user) ? 1.3 : 1;
        if (terrain === 'Psychic') return move.type === 'Psychic' && this._isGrounded(user) ? 1.3 : 1;
        if (terrain === 'Misty') return move.type === 'Dragon' && this._isGrounded(target) ? 0.5 : 1;
        return 1;
    }

    _applyStatusMove(user, target, move, fx = null) {
        let did = false;
        // A self-targeting move applies everything to its user, not just its
        // boosts -- Shell Smash's stat drops and Substitute's volatile were
        // both landing on the opponent.
        const t = move.target === 'self' ? user : target;
        if (move.boosts) { this.boost(t, move.boosts, user, move.name); did = true; }
        if (move.status) { this.trySetStatus(t, move.status, user, move.name); did = true; }
        if (move.volatileStatus === 'substitute') { this.trySubstitute(t); did = true; }
        else if (move.volatileStatus) { this.addVolatile(t, move.volatileStatus); did = true; }
        if (move.heal) { this.heal(Math.floor(user.maxhp * move.heal[0] / move.heal[1]), user, move.name); did = true; }
        // Weather, terrain and hazards all come off the move's own data now.
        // The list of move ids this used to carry double-applied anything the
        // data already covered -- Recover healed a full bar rather than half,
        // because both the heal field and its hardcoded branch fired.
        if (move.weather && MOVE_WEATHER[toId(move.weather)]) {
            this.setWeather(MOVE_WEATHER[toId(move.weather)], user, move.name); did = true;
        }
        if (move.terrain && MOVE_TERRAIN[toId(move.terrain)]) {
            this.setTerrain(MOVE_TERRAIN[toId(move.terrain)], user, move.name); did = true;
        }
        if (move.sideCondition) {
            const onFoe = move.target === 'foeSide';
            this.addSideCondition(onFoe ? target.side : user.side, move.sideCondition); did = true;
        }

        const id = move.id;
        if (id === 'rest') {
            if (user.hp < user.maxhp) {
                this.cureStatus(user); user.status = 'slp';
                user.statusData = { turns: 0, duration: 2 };
                this.add('-status', this.ref(user), 'slp', move.name);
                this.heal(user.maxhp, user, move.name); did = true;
            }
        } else if (id === 'defog') {
            for (const s of this.sides) for (const k of Object.keys(s.conditions)) this.removeSideCondition(s, k);
            did = true;
        }
        // Showdown writes plenty of status moves entirely as onHit (Belly Drum,
        // Haze, Pain Split), with no data fields at all to read.
        //
        // Substitute is the exception: trySubstitute() above already charged
        // for it, and Showdown's own onHit charges again through directDamage,
        // which would take half the user's HP instead of a quarter.
        if (fx?.hooks?.onHit && move.volatileStatus !== 'substitute') {
            const out = runMoveHook(fx, 'onHit', { battle: this, user, target: t, move }, undefined);
            // Showdown reports a move that could not do its thing (Camouflage
            // with nothing to change into) as false; that is not a success.
            if (out !== false) did = true;
        }
        if (!did) this.add('-activate', this.ref(user), move.name);
    }

    _applySecondaries(user, target, move, hitSubstitute = false) {
        // Shield Dust drops every secondary aimed at its holder and Serene
        // Grace doubles their odds; both are written as onModifySecondaries,
        // which is handed the list and returns the one to actually roll. Asked
        // of the attacker first (its own move's effects) and then the target.
        let list = move.secondaries || [];
        const fromUser = this.runEvent('modifySecondaries', user, { move, value: list, role: 'user' });
        if (Array.isArray(fromUser)) list = fromUser;
        const fromTarget = this.runEvent('modifySecondaries', target, { move, value: list, role: 'target' });
        if (Array.isArray(fromTarget)) list = fromTarget;
        for (const sec of list) {
            if (!sec) continue;
            if (!this.rng.chance(sec.chance ?? 100, 100)) continue;
            const t = sec.self ? user : target;
            if (t.fainted) continue;
            // A burn or a flinch never reaches through a substitute, though
            // the move's effect on its own user still happens.
            if (hitSubstitute && !sec.self) continue;
            if (sec.status) this.trySetStatus(t, sec.status, user, move.name);
            if (sec.volatileStatus) this.addVolatile(t, sec.volatileStatus);
            if (sec.boosts) this.boost(t, sec.boosts, user, move.name);
        }
    }

    // ------------------------------------------------------------- residual
    _residual() {
        // Weather chip damage.
        if (this.field.weather) {
            // Chip damage happens on the weather's LAST turn too. Decrementing
            // first and skipping the damage when it hit zero, as this used to,
            // cost every sandstorm and every hail a full turn of damage: five
            // turns of weather only ever chipped four times.
            if (this.field.weather === 'Sand') {
                for (const s of this.sides) {
                    const m = this.active(s.index);
                    if (m && !m.fainted && !['Rock', 'Ground', 'Steel'].some(t => m.types.includes(t))) {
                        this.damage(Math.floor(m.maxhp / 16), m, null, 'Sandstorm');
                    }
                }
            } else if (this.field.weather === 'Hail') {
                for (const s of this.sides) {
                    const m = this.active(s.index);
                    if (m && !m.fainted && !m.types.includes('Ice')) this.damage(Math.floor(m.maxhp / 16), m, null, 'Hail');
                }
            }
            // Dry Skin, Solar Power, Ice Body and Rain Dish are all written as
            // onWeather, which mainline runs as part of the weather's own
            // residual rather than the Pokemon's.
            for (const s of this.sides) {
                const m = this.active(s.index);
                if (m && !m.fainted) this.runEvent('weather', m);
            }
            if (--this.field.weatherTurns <= 0) {
                this.add('-weather', 'none', this.field.weather);
                this.field.weather = null;
            }
        }
        // Grassy Terrain restores a sixteenth to everything standing in it,
        // before it counts itself down.
        if (this.field.terrain === 'Grassy') {
            for (const s of this.sides) {
                const m = this.active(s.index);
                if (m && !m.fainted && this._isGrounded(m)) this.heal(Math.floor(m.maxhp / 16), m, 'Grassy Terrain');
            }
        }
        if (this.field.terrain && --this.field.terrainTurns <= 0) {
            this.add('-fieldend', `${this.field.terrain} Terrain`); this.field.terrain = null;
        }

        // Status chip, then ability residuals - ordered by speed so the faster
        // Pokémon's end-of-turn ability resolves first, as in mainline.
        const order = [this.active(0), this.active(1)].filter(m => m && !m.fainted)
            .sort((a, b) => this.getStat(b, 'spe') - this.getStat(a, 'spe'));

        for (const m of order) {
            if (m.fainted) continue;
            if (m.status === 'brn') this.damage(Math.floor(m.maxhp / 16), m, null, 'brn');
            else if (m.status === 'psn') this.damage(Math.floor(m.maxhp / 8), m, null, 'psn');
            else if (m.status === 'tox') {
                const stage = m.statusData.stage || 1;
                this.damage(Math.floor((m.maxhp * stage) / 16), m, null, 'tox');
                m.statusData.stage = Math.min(15, stage + 1);
            }
            if (m.volatiles.leechseed && !m.fainted) {
                const drained = this.damage(Math.floor(m.maxhp / 8), m, null, 'Leech Seed');
                const foe = this.foeOf(m);
                if (foe && !foe.fainted) this.heal(drained, foe, 'Leech Seed');
            }
        }
        // Protect only lasts the turn it was used.
        for (const m of order) if (m.volatiles.protect) this.removeVolatile(m, 'protect');
        // Taunt, Encore, Disable and the rest of the timed volatiles count down
        // here, and the side's screens and Safeguard count down with them.
        for (const m of order) this._tickVolatiles(m);
        for (const side of this.sides) this._tickSideConditions(side);
        for (const m of order) if (!m.fainted) this.runEvent('residual', m);
    }

    _tickVolatiles(mon) {
        if (!mon) return;
        for (const key of Object.keys(mon.volatiles)) {
            const v = mon.volatiles[key];
            // Confusion counts on its holder's move attempts, not on the clock.
            if (!v?.duration || key === 'confusion') continue;
            v.turns = (v.turns || 0) + 1;
            if (v.turns >= v.duration) this.removeVolatile(mon, key);
        }
    }

    _tickSideConditions(side) {
        for (const key of Object.keys(side.conditions)) {
            const c = side.conditions[key];
            if (!c?.turns) continue;          // hazards stay until cleared
            c.turns--;
            if (c.turns <= 0) this.removeSideCondition(side, key);
        }
    }

    // --------------------------------------------------------------- faints
    _queueFaint(pokemon) {
        if (!pokemon.fainted && !this.faintQueue.includes(pokemon)) this.faintQueue.push(pokemon);
    }

    _resolveFaints() {
        while (this.faintQueue.length) {
            const mon = this.faintQueue.shift();
            if (mon.fainted || mon.hp > 0) continue;
            mon.fainted = true;
            mon.hp = 0;
            this.add('faint', this.ref(mon));
            this.runEvent('faint', mon);
        }
        for (const side of this.sides) {
            // `[].every()` is true, so a side that was built with no Pokemon at
            // all counted as swept and handed the other side an instant win the
            // moment anything resolved. A side with nothing on it was never in
            // the battle to lose it -- that is a setup fault, not a result.
            if (!side.team.length) continue;
            if (side.team.every(m => m.fainted)) { this._end(1 - side.index, 'sweep'); return; }
        }
    }

    // True when this side has nothing left to use and must Struggle. Being out
    // of PP is not a reason for a battle to stop having legal moves in it.
    mustStruggle(sideIndex) {
        const mon = this.active(sideIndex);
        if (!mon || mon.fainted) return false;
        return !mon.moves.some((_, i) => canSelectMove(mon, i));
    }

    // The throwaway slot Struggle is used from. It is not one of the Pokemon's
    // four, so it has no PP to spend and nothing to remember.
    _struggleSlot() {
        return { move: STRUGGLE, pp: 1, maxpp: 1, disabled: false };
    }

    // True when a side must send out a replacement before the next turn --
    // because its active Pokemon fainted, or because it used U-turn and owes
    // the field a pivot. Only reported while a legal replacement exists, so a
    // side can never be left owing a switch it cannot make.
    needsSwitch(sideIndex) {
        if (this.ended) return false;
        const mon = this.active(sideIndex);
        if (!mon || mon.fainted) return true;
        if (!this.pendingSwitches.has(mon)) return false;
        return this.sides[sideIndex].team.some(m => !m.fainted && m !== mon);
    }

    _switchIn(sideIndex, teamIndex) {
        const side = this.sides[sideIndex];
        const outgoing = side.team[side.activeIndex];
        const incoming = side.team[teamIndex];
        if (!incoming || incoming.fainted) return false;
        // Nothing left the field if the Pokemon coming in is the one already out
        // (replacing a fainted lead, or a forced re-send). Firing switchOut on it
        // would run Regenerator, release a Choice lock and reset the toxic
        // counter for a Pokemon that never moved.
        if (outgoing && outgoing !== incoming && !outgoing.fainted) {
            this.runEvent('switchOut', outgoing);
            outgoing.isActive = false;
            // Boosts and most volatiles are shed on switch.
            for (const k of BOOST_IDS) outgoing.boosts[k] = 0;
            outgoing.volatiles = {};
            // Bad poison restarts at 1/16 when its holder switches out. Keeping
            // the counter meant a Pokemon could pivot out and back and resume
            // taking 15/16 damage.
            if (outgoing.status === 'tox') outgoing.statusData.stage = 1;
        }
        side.activeIndex = teamIndex;
        incoming.isActive = true;
        incoming.switchedInTurn = this.turn;
        // "First turn out" is measured from here, and nothing that hit the
        // previous occupant counts against the Pokemon replacing it.
        incoming.activeMoveActions = 0;
        incoming.newlySwitched = true;
        incoming.attackedBy = [];
        this.pendingSwitches.delete(outgoing);
        this.pendingSwitches.delete(incoming);
        this.add('switch', this.ref(incoming), incoming.name, `${incoming.hp}/${incoming.maxhp}`, side.name);
        this._applyEntryHazards(incoming);
        if (!incoming.fainted) this.runEvent('switchIn', incoming);
        return true;
    }

    // Public switch used for replacing a fainted Pokémon between turns, and for
    // sending in a pivot's replacement mid-turn.
    switchTo(sideIndex, teamIndex) {
        const ok = this._switchIn(sideIndex, teamIndex);
        this._resolveFaints();
        // A pivot left the turn suspended part-way through its queue. Now that
        // the replacement is on the field, the rest of the turn plays out
        // against it. Both clients reach this the same way -- locally through
        // the switch panel, remotely through MSG.SWITCH -- so the resumed turn
        // stays in lockstep.
        if (ok && this._midTurn && !this._pivotPending() && this._runQueue()) this._endTurn();
        return ok;
    }

    _applyEntryHazards(mon) {
        const c = mon.side.conditions;
        const grounded = !mon.types.includes('Flying');
        if (c.stealthrock) {
            const eff = typeEffectiveness('Rock', mon.types);
            this.damage(Math.max(1, Math.floor((mon.maxhp * eff) / 8)), mon, null, 'Stealth Rock');
        }
        if (c.spikes && grounded && !mon.fainted) {
            const denom = [0, 8, 6, 4][Math.min(3, c.spikes.layers)];
            this.damage(Math.floor(mon.maxhp / denom), mon, null, 'Spikes');
        }
        if (c.toxicspikes && grounded && !mon.fainted) {
            if (mon.types.includes('Poison')) this.removeSideCondition(mon.side, 'toxicspikes');
            else this.trySetStatus(mon, c.toxicspikes.layers >= 2 ? 'tox' : 'psn', null, 'Toxic Spikes');
        }
        if (c.stickyweb && grounded && !mon.fainted) this.boost(mon, { spe: -1 }, null, 'Sticky Web');
    }

    _end(winnerIndex, reason) {
        if (this.ended) return;
        this.ended = true;
        this.winner = winnerIndex;
        this.endReason = reason;
        this.add('win', this.sides[winnerIndex].name, reason);
    }

    forfeit(sideIndex) { this._end(1 - sideIndex, 'forfeit'); }

    // ==================== serialisation ====================
    // Compact, order-stable snapshot used both for the desync hash and for
    // rehydrating a spectator/reconnecting client. Key order is fixed by the
    // literal below rather than by Object.keys, so two clients always hash the
    // same string.
    snapshot() {
        return {
            v: this.engineVersion, seed: this.seed, turn: this.turn,
            // Whether the turn is part-run. Two clients that disagree about
            // that disagree about everything that follows.
            mt: this._midTurn ? 1 : 0,
            // Part of the agreed ruleset, so a mismatch shows up in the very
            // first hash rather than whenever an effect happens to differ.
            caps: [this.caps.sdMoves ? 1 : 0, this.caps.sdAbilities ? 1 : 0, this.caps.sdItems ? 1 : 0],
            rng: this.rng.getState(),
            field: { w: this.field.weather, wt: this.field.weatherTurns, t: this.field.terrain, tt: this.field.terrainTurns },
            ended: this.ended, winner: this.winner,
            sides: this.sides.map(s => ({
                a: s.activeIndex,
                c: Object.keys(s.conditions).sort().map(k => [k, s.conditions[k].layers]),
                t: s.team.map(m => ({
                    n: m.name, hp: m.hp, mx: m.maxhp, st: m.status || '',
                    b: BOOST_IDS.map(k => m.boosts[k] || 0),
                    ty: m.types.join('/'),
                    v: Object.keys(m.volatiles).sort(),
                    pp: m.moves.map(x => x.pp),
                    f: m.fainted ? 1 : 0
                }))
            }))
        };
    }

    // FNV-1a over the canonical snapshot. Cheap to compute every turn and
    // enough to catch any divergence between the two clients.
    stateHash() {
        return fnv1a(JSON.stringify(this.snapshot()));
    }

    // What this client built, broken into the four things the two clients have
    // to have agreed on before turn one: the dice, the rosters, who is in front,
    // and the ruleset. Deliberately NOT one combined hash -- a single number can
    // only ever say "these differ", and the whole point is to be able to tell a
    // player which of the four went wrong. See net/protocol.js setupMismatch.
    //
    // Everything read here is engine-visible state. Nothing presentational
    // (artwork, dex numbers, nicknames the engine does not use) goes in, because
    // those legitimately differ between the two clients -- the battle row's copy
    // of a team has its pictures stripped and the local copy does not.
    setupDigest() {
        return {
            seed: fnv1a(String(this.seed)),
            leads: this.sides.map(s => s.activeIndex).join(','),
            caps: `${this.caps.sdMoves ? 1 : 0}${this.caps.sdAbilities ? 1 : 0}${this.caps.sdItems ? 1 : 0}`,
            teams: fnv1a(this.sides.map(side => side.team.map(m => [
                m.name,
                m.level,
                m.maxhp,
                ['atk', 'def', 'spa', 'spd', 'spe'].map(k => m.stats[k]).join('/'),
                m.types.join('/'),
                m.ability?.name || '-',
                m.item?.name || '-',
                m.moves.map(x => `${x.move?.name || '-'}:${x.maxpp}`).join(',')
            ].join('|')).join(';')).join('#'))
        };
    }
}

// FNV-1a, hex. The one hash this engine uses, for both the per-turn state and
// the pre-battle setup digest.
function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Flags a compiled handler table as belonging to a held item rather than an
// ability, which is what keeps ability suppression from switching an item off.
function markAsItem(handlers) {
    for (const list of Object.values(handlers || {})) for (const h of list) h.isItem = true;
    return handlers;
}

// Showdown's move gates report failure as `false` (onTry, onHit) or as `null`
// (onTryMove, onTryHit); undefined always means "carry on".
function moveFailed(result) { return result === false || result === null; }

export { STATUS_NAMES };
