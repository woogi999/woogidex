// ==================== custom ability runtime (the adapter) ====================
// ability-blocks.js already stores every custom ability as a plain-object AST:
//
//   { version:3, triggers:[ {kind:'event', trigger:'damagingHit',
//                            triggerParams:{}, body:[ ...blocks ]} ], loose:[] }
//   block := {kind:'action', action:'healDamage', params:{...}}
//          | {kind:'if', condition:'hpBelow', condParams:{...}, then:[], else:[]}
//
// and ships two *codegen* backends for it: TRIGGERS[x].sd() emits Pokémon
// Showdown TypeScript, TRIGGERS[x].es() emits Pokémon Essentials Ruby. Both
// produce source text for people to paste into another project - neither one
// runs.
//
// This file is the third backend: an INTERPRETER over the same AST, executing
// against live battle state. Nothing about the editor, the stored format, or
// the two export paths changes. Adding a new block to ability-blocks.js means
// adding one entry to ACTION_RUNTIME / CONDITION_RUNTIME below, not touching
// the battle engine.
//
// Why interpret instead of eval()ing the generated Showdown code:
//   1. That code targets Showdown's API (this.boost, pokemon.side.foe...),
//      which this engine does not implement.
//   2. Custom abilities come from other players over the network in a
//      multiplayer battle. Running attacker-authored strings through eval() or
//      new Function() would be remote code execution. An interpreter over a
//      fixed opcode table can only ever do what the table allows.
//
// Deliberately dependency-free (no app.js / no DOM) so it runs in Node tests.

import { toId } from './dex.js';

// ---------------------------------------------------------------------------
// trigger mapping: AST trigger key -> engine event(s)
// ---------------------------------------------------------------------------
// `event`  : the engine event name this handler binds to.
// `filter` : optional (triggerParams, ctx) => boolean, for triggers that only
//            fire under a parameterised condition (a chosen stat, move type…).
// `resolve`: for triggers whose target event depends on triggerParams.
const TRIGGER_MAP = {
    switchIn:    { event: 'switchIn' },
    switchOut:   { event: 'switchOut' },
    battleStart: { event: 'switchIn' },
    switchInOut: { resolve: p => (p.direction === 'out' ? 'switchOut' : 'switchIn') },
    residual:    { event: 'residual' },
    turnStart:   { event: 'turnStart' },
    turnStartEnd:{ resolve: p => (p.phase === 'start' ? 'turnStart' : 'residual') },
    damagingHit: { event: 'damagingHit' },
    onDamage:    { event: 'damagingHit' },
    onDamagingHit:{ event: 'damagingHit' },
    onContact:   { event: 'damagingHit', filter: (_p, ctx) => !!ctx.move?.flags?.contact },
    onCriticalHit:{ event: 'damagingHit', filter: (_p, ctx) => !!ctx.crit },
    beforeMove:  { event: 'beforeMove' },
    onMove:      { resolve: p => (p.phase === 'hit' ? 'afterMoveHit' : 'afterMove') },
    afterMove:   { event: 'afterMove' },
    onFaint:     { event: 'faint' },
    onStatus:    { event: 'setStatus' },
    // Move-only. A custom move's program is run by the engine with its USER as
    // `self` (see battle.js _runMoveEvent), so these two bind to the same event
    // names an ability would use and simply arrive from a different caller.
    moveUsed:    { event: 'afterMove' },
    moveHit:     { event: 'afterMoveHit' },
    // Value-returning events. The engine feeds ctx.value in and takes it back
    // out, so multiplyStat / multiplyDamage actually change the number.
    // `whose` narrows this to the holder's OWN stat. The engine asks the same
    // question twice now -- once of the Pokemon whose stat it is, once of its
    // opponent, so Showdown's onSourceModifyAtk family has somewhere to bind
    // (see battle.js getStat) -- and a block program means the first of those.
    statModify:  { event: 'modifyStat', filter: (p, ctx) => ctx.whose !== 'foe' && (!p.stat || p.stat === ctx.stat), value: true },
    damageModify:{ resolve: p => (p.direction === 'receiving' ? 'modifyDamageTaken' : 'modifyDamageDealt'), value: true },
    moveImmunity:{ event: 'tryHit', filter: (p, ctx) => !!ctx.move && ctx.move.type === (p.type || 'Electric'), immunity: true },
    // Storm Drain and Lightning Rod. The redirection they are named for needs
    // an ally to pull the move away from, and this engine only runs singles,
    // so what is left here is the absorb -- which is the whole of what those
    // abilities do one-on-one anyway. The exported code carries both halves.
    drawIn:      { event: 'tryHit', filter: (p, ctx) => !!ctx.move && ctx.move.type === (p.type || 'Water'), immunity: true },
    // Same hook as the two presets above, with nothing decided for you: it
    // fires for every incoming move and the body says (via the absorb action)
    // whether this one gets through. `canImmune` rather than `immunity` is the
    // difference between "this event means immunity" and "this event may
    // choose it".
    moveIncoming:{ event: 'tryHit', canImmune: true },
    // The -ate abilities. Not a value event: the body rewrites the move object
    // the engine is holding, which is the per-use copy (battle.js _activeMove),
    // so nothing leaks into the next use of the same move.
    moveTypeChange: {
        event: 'modifyType',
        filter: (p, ctx) => ctx.role === 'user' && !!ctx.move
            && (!p.from || p.from === 'any' || ctx.move.type === p.from)
    },
    // Compound Eyes and Sand Veil both live here. The engine asks twice per
    // move -- once as the attacker, once as the target -- and `role` says which
    // call this is, so an ability only ever applies from its own side.
    accuracyModify: {
        event: 'modifyAccuracy', value: true,
        filter: (p, ctx) => ctx.role === (p.role || 'user')
    },
    // Unaware and its mirror image. `whose` picks which of the two Pokemon's
    // stages this handler is being asked about; `role` narrows it to one half
    // of the damage roll (or to evasion) when the author wants that.
    statStageIgnore: {
        event: 'ignoreBoosts', value: true,
        filter: (p, ctx) => ctx.whose === (p.whose || 'foe')
            && (!p.role || p.role === 'any' || p.role === ctx.role)
    }
};

export const RUNTIME_EVENTS = [
    'switchIn', 'switchOut', 'turnStart', 'residual', 'beforeMove', 'afterMove',
    'afterMoveHit', 'damagingHit', 'faint', 'setStatus', 'modifyStat',
    'modifyDamageDealt', 'modifyDamageTaken', 'tryHit', 'modifyType',
    'modifyAccuracy', 'ignoreBoosts', 'afterDamage'
];

// ---------------------------------------------------------------------------
// helpers shared by conditions and actions
// ---------------------------------------------------------------------------
function pick(ctx, which) {
    return which === 'foe' ? ctx.foe : ctx.self;
}
function n(v, fallback = 0) {
    const x = Number(v);
    return Number.isFinite(x) ? x : fallback;
}
// Mirrors amountExpression() in ability-blocks.js so the interpreted result
// matches what the exported Showdown/Essentials code would compute.
function amountOf(target, params, ctx) {
    const pct = n(params.percent, 10);
    const basis = params.basis || 'maxhp';
    if (!target) return 0;
    if (basis === 'hp') return Math.floor((target.hp * pct) / 100);
    if (basis === 'missinghp') return Math.floor(((target.maxhp - target.hp) * pct) / 100);
    if (basis === 'damageTaken') return Math.floor((n(ctx.damage, 0) * pct) / 100);
    return Math.floor((target.maxhp * pct) / 100);
}

// ---------------------------------------------------------------------------
// condition semantics - keyed by the same ids as CONDITIONS in ability-blocks.js
// ---------------------------------------------------------------------------
const CONDITION_RUNTIME = {
    hpBelow:   (p, ctx) => ctx.self.hp <= ctx.self.maxhp * (n(p.value, 50) / 100),
    hpAbove:   (p, ctx) => ctx.self.hp > ctx.self.maxhp * (n(p.value, 50) / 100),
    hasStatus: (p, ctx) => (p.status === 'none' ? !ctx.self.status : ctx.self.status === p.status),
    targetHasStatus: (p, ctx) => (p.status === 'none' ? !ctx.foe?.status : ctx.foe?.status === p.status),
    weatherIs: (p, ctx) => ctx.battle.field.weather === (p.weather || 'Sun'),
    terrainIs: (p, ctx) => ctx.battle.field.terrain === (p.terrain || 'Electric'),
    hasVolatile: (p, ctx) => !!pick(ctx, p.target)?.volatiles?.[toId(p.volatile || 'stockpile')],
    moveTypeIs: (p, ctx) => ctx.move?.type === p.type,
    moveCategoryIs: (p, ctx) => ctx.move?.category === p.category,
    moveMakesContact: (_p, ctx) => !!ctx.move?.flags?.contact,
    moveHasFlag: (p, ctx) => !!ctx.move?.flags?.[p.flag || 'contact'],
    moveIsDamaging: (_p, ctx) => !!ctx.move && ctx.move.category !== 'Status',
    selfIsType: (p, ctx) => (ctx.self.types || []).includes(p.type),
    randomChance: (p, ctx) => ctx.battle.rng.chance(n(p.value, 50), 100),
    turnAtLeast: (p, ctx) => ctx.battle.turn >= n(p.value, 1),
    statStageAtLeast: (p, ctx) => (ctx.self.boosts?.[p.stat || 'atk'] || 0) >= n(p.value, 1),
    movePowerAtLeast: (p, ctx) => n(ctx.move?.basePower, 0) >= n(p.value, 0),
    movePowerAtMost: (p, ctx) => n(ctx.move?.basePower, 0) <= n(p.value, 0),
    movePriorityIs: (p, ctx) => n(ctx.move?.priority, 0) === n(p.value, 0),
    movePriorityAtLeast: (p, ctx) => n(ctx.move?.priority, 0) >= n(p.value, 0),
    moveAccuracyAtLeast: (p, ctx) => typeof ctx.move?.accuracy === 'number' && ctx.move.accuracy >= n(p.value, 0),
    moveHasRecoil: (_p, ctx) => !!ctx.move?.recoil,
    moveHasDrain: (_p, ctx) => !!ctx.move?.drain,
    moveHasSecondary: (_p, ctx) => Array.isArray(ctx.move?.secondaries) && ctx.move.secondaries.length > 0,
    moveCritRatioAtLeast: (p, ctx) => n(ctx.move?.critRatio, 0) >= n(p.value, 0),
    moveTargetIs: (p, ctx) => ctx.move?.target === (p.target || 'normal'),
    moveNameIs: (p, ctx) => toId(ctx.move?.name) === toId(p.value),
    targetIsFainted: (_p, ctx) => !!ctx.foe?.fainted,
    stockpileStacksAtLeast: (p, ctx) => n(pick(ctx, p.target)?.volatiles?.stockpile?.layers, 0) >= n(p.value, 0),
    stockpileStacksExactly: (p, ctx) => n(pick(ctx, p.target)?.volatiles?.stockpile?.layers, 0) === n(p.value, 0),
    // ---- blanket checks ----
    alwaysTrue: () => true,
    pokemonPropertyCompare: (p, ctx) => {
        const mon = pick(ctx, p.target);
        const prop = String(p.property || 'hp');
        // the five real stat values go through the engine so stages, items and
        // abilities are all counted, exactly as a damage roll would see them
        const left = ['atk', 'def', 'spa', 'spd', 'spe'].includes(prop)
            ? (mon ? ctx.battle.getStat(mon, prop) : 0)
            : pokemonProperty(mon, prop);
        return compareOp(left, p.op, n(p.value, 0));
    },
    isFasterThan: (p, ctx) => {
        const a = pick(ctx, p.target), b = pick(ctx, p.other || 'foe');
        if (!a || !b) return false;
        return ctx.battle.getStat(a, 'spe') > ctx.battle.getStat(b, 'spe');
    },
    isType: (p, ctx) => (pick(ctx, p.target)?.types || []).includes(p.type),
    hasAbility: (p, ctx) => toId(pick(ctx, p.target)?.ability?.name || pick(ctx, p.target)?.ability) === toId(p.ability),
    hasItem: (p, ctx) => {
        const item = pick(ctx, p.target)?.item;
        const wanted = String(p.item || '').trim();
        return wanted ? toId(item?.name || item) === toId(wanted) : !!item;
    },
    // The editor has offered these three since the generalised move/effect
    // inspection went in, but there was no runtime for any of them, so an
    // ability built on one behaved as though the check had said "no".
    movePropertyCompare: (p, ctx) => compareOp(moveProperty(ctx.move, p.property), p.op, readValue(p.value, ctx)),
    movePropertyIs: (p, ctx) => {
        const actual = moveProperty(ctx.move, p.property);
        const wanted = String(p.value ?? '');
        // ids and names compare case/punctuation-insensitively; everything
        // else is a plain value comparison
        if (p.property === 'id' || p.property === 'name') return toId(actual) === toId(wanted);
        return String(actual) === wanted;
    },
    battleEffectActive: (p, ctx) => !!pick(ctx, p.target)?.volatiles?.[toId(p.effect || 'stockpile')],
    battleEffectCompare: (p, ctx) => compareOp(battleEffectProperty(pick(ctx, p.target), p), p.op, readValue(p.value, ctx)),
    battleEffectStacksAtLeast: (p, ctx) =>
        n(pick(ctx, p.target)?.volatiles?.[toId(p.effect || 'stockpile')]?.layers, 0) >= n(p.value, 0),

    // The free-text logic blocks (compare/and/or/not) accept arbitrary strings
    // in the editor because their codegen just splices them into the output.
    // An interpreter cannot evaluate arbitrary source safely, so these resolve
    // through a tiny whitelisted expression reader instead (see readValue).
    compare: (p, ctx) => {
        const l = readValue(p.left, ctx), r = readValue(p.right, ctx);
        switch (p.op) {
            case '>': return l > r; case '<': return l < r;
            case '>=': return l >= r; case '<=': return l <= r;
            default: return l === r;
        }
    },
    and: (p, ctx) => truthy(readValue(p.left, ctx)) && truthy(readValue(p.right, ctx)),
    or: (p, ctx) => truthy(readValue(p.left, ctx)) || truthy(readValue(p.right, ctx)),
    not: (p, ctx) => !truthy(readValue(p.value, ctx))
};

function truthy(v) { return !(v === false || v === 0 || v === '' || v === null || v === undefined); }

// Shared by the comparison blocks. Mirrors BATTLE_EFFECT_OPS in
// ability-blocks.js, which is the list the editor offers.
function compareOp(left, op, right) {
    switch (op) {
        case '!=': return left !== right;
        case '>':  return left > right;
        case '<':  return left < right;
        case '<=': return left <= right;
        case '>=': return left >= right;
        default:   return left === right;      // '=='
    }
}

// Mirrors pokemonPropertyExpression() in ability-blocks.js, so the interpreted
// answer matches what the exported code would compute.
function pokemonProperty(mon, property) {
    if (!mon) return 0;
    const prop = String(property || 'hp');
    if (prop.startsWith('boost.')) return n(mon.boosts?.[prop.slice(6)], 0);
    const boosts = Object.values(mon.boosts || {});
    switch (prop) {
        case 'hpPercent':      return mon.maxhp ? (mon.hp * 100) / mon.maxhp : 0;
        case 'positiveBoosts': return boosts.filter(v => v > 0).length;
        case 'negativeBoosts': return boosts.filter(v => v < 0).length;
        case 'movesMade':      return n(mon.activeMoveActions, 0);
        // weight lives on the species record, not the battler
        case 'weight':         return n(mon.species?.weightkg ?? mon.weightkg, 0);
        default:               return n(mon[prop], 0);
    }
}

// Mirrors movePropertyExpression(). Returns the raw value, not a number: a
// flag is a boolean and a type is a string.
function moveProperty(move, property) {
    if (!move) return undefined;
    const prop = String(property || 'basePower');
    if (prop.startsWith('flags.')) return !!move.flags?.[prop.slice(6)];
    return move[prop];
}

// Mirrors battleEffectExpression().
function battleEffectProperty(mon, p) {
    const v = mon?.volatiles?.[toId(p.effect || 'stockpile')];
    const prop = p.property === 'custom' ? String(p.customProperty || 'layers') : String(p.property || 'exists');
    if (prop === 'exists') return !!v;
    return v ? v[prop] : undefined;
}

// Whitelisted reader for the free-text value fields. Supports numbers, a small
// set of named battle values, and `name op number` comparisons. Anything it
// doesn't recognise returns 0 rather than executing - no eval, ever.
function readValue(raw, ctx) {
    if (raw === null || raw === undefined) return 0;
    if (typeof raw === 'number') return raw;
    const s = String(raw).trim();
    if (!s) return 0;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (/^true$/i.test(s)) return true;
    if (/^false$/i.test(s)) return false;
    const cmp = s.match(/^(.+?)\s*(>=|<=|==|=|>|<)\s*(.+)$/);
    if (cmp) {
        const l = readValue(cmp[1], ctx), r = readValue(cmp[3], ctx);
        switch (cmp[2]) {
            case '>': return l > r; case '<': return l < r;
            case '>=': return l >= r; case '<=': return l <= r;
            default: return l === r;
        }
    }
    const named = {
        hp: ctx.self.hp, maxhp: ctx.self.maxhp, 'max hp': ctx.self.maxhp,
        damage: n(ctx.damage, 0), 'damage taken': n(ctx.damage, 0),
        turn: ctx.battle.turn, 'turn number': ctx.battle.turn,
        level: ctx.self.level, 'move power': n(ctx.move?.basePower, 0),
        'foe hp': ctx.foe?.hp ?? 0, 'foe maxhp': ctx.foe?.maxhp ?? 0
    }[s.toLowerCase()];
    if (named !== undefined) return named;
    // Variables written by setVariable blocks live on the ability's own scope.
    if (ctx.vars && s in ctx.vars) return ctx.vars[s];
    return 0;
}

// ---------------------------------------------------------------------------
// action semantics - keyed by the same ids as ACTIONS in ability-blocks.js
// ---------------------------------------------------------------------------
// Each takes (params, ctx) and mutates real battle state through the engine's
// API. `ctx.value` is the in/out number for value-returning events.
const ACTION_RUNTIME = {
    boostStat: (p, ctx) => {
        const t = pick(ctx, p.target);
        if (t) ctx.battle.boost(t, { [p.stat || 'atk']: n(p.stages, 1) }, ctx.self, ctx.abilityName);
    },
    // boostStat above moves a STAGE. These two move the stat NUMBER underneath
    // it (`mon.stats`, the same field getStat() reads before applying stages) -
    // what Power Trick and Guard Split actually do, and what a stage change
    // cannot express since there is nothing to swap or copy on a stage.
    setStatValue: (p, ctx) => {
        const t = pick(ctx, p.target);
        if (t?.stats) t.stats[p.stat || 'atk'] = Math.max(1, Math.floor(n(p.value, 100)));
    },
    changeStatValue: (p, ctx) => {
        const t = pick(ctx, p.target);
        if (!t?.stats) return;
        const stat = p.stat || 'atk';
        const current = n(t.stats[stat], 1);
        const amount = n(p.value, 0);
        const next = p.mode === 'flat' ? current + amount : current * (1 + amount / 100);
        t.stats[stat] = Math.max(1, Math.floor(next));
    },
    dealDamage: (p, ctx) => {
        const t = pick(ctx, p.target || 'foe');
        if (t) ctx.battle.damage(amountOf(t, p, ctx), t, ctx.self, ctx.abilityName);
    },
    damage: (p, ctx) => ACTION_RUNTIME.dealDamage(p, ctx),
    healDamage: (p, ctx) => {
        const t = pick(ctx, p.target || 'self');
        if (t) ctx.battle.heal(amountOf(t, p, ctx), t, ctx.abilityName);
    },
    heal: (p, ctx) => ACTION_RUNTIME.healDamage(p, ctx),
    setStatus: (p, ctx) => {
        const t = pick(ctx, p.target || 'foe');
        if (t) ctx.battle.trySetStatus(t, p.status || 'brn', ctx.self, ctx.abilityName);
    },
    inflictStatus: (p, ctx) => ACTION_RUNTIME.setStatus(p, ctx),
    cureStatus: (p, ctx) => {
        const t = pick(ctx, p.target || 'self');
        if (t) ctx.battle.cureStatus(t, ctx.abilityName);
    },
    setWeather: (p, ctx) => ctx.battle.setWeather(p.weather || 'Sun', ctx.self, ctx.abilityName),
    setTerrain: (p, ctx) => ctx.battle.setTerrain(p.terrain || 'Electric', ctx.self, ctx.abilityName),
    setWeatherTerrain: (p, ctx) => {
        if ((p.kind || 'weather') === 'terrain') ctx.battle.setTerrain(p.value, ctx.self, ctx.abilityName);
        else ctx.battle.setWeather(p.value, ctx.self, ctx.abilityName);
    },
    clearTerrainWeather: (_p, ctx) => { ctx.battle.setWeather(null, ctx.self); ctx.battle.setTerrain(null, ctx.self); },
    // The two value-modifying actions. These are the reason ctx.value exists:
    // statModify / damageModify events read it back out after the body runs.
    multiplyStat: (p, ctx) => { ctx.value = Math.floor(n(ctx.value, 0) * n(p.factor, 1)); },
    multiplyDamage: (p, ctx) => { ctx.value = Math.floor(n(ctx.value, 0) * n(p.factor, 1)); },
    multiplyAccuracy: (p, ctx) => { ctx.value = Math.floor(n(ctx.value, 0) * n(p.factor, 1)); },
    // The whole body of an "ignore stat stages" ability: the trigger has
    // already decided WHOSE stages and WHICH, so all this has to say is yes.
    ignoreStatStages: (_p, ctx) => { ctx.value = true; },
    // Recycle, as an ability. The engine remembers what a Pokemon used up (see
    // consumeItem) precisely so this can hand it back.
    restoreItem: (p, ctx) => {
        const t = pick(ctx, p.target || 'self');
        if (t) ctx.battle.restoreItem(t, ctx.abilityName);
    },
    changeType: (p, ctx) => {
        const t = pick(ctx, p.target);
        if (t) ctx.battle.setTypes(t, [p.type || 'Normal'], ctx.abilityName);
    },
    // These three write to the active move copy (battle.js _activeMove), so a
    // rewrite lasts for this one use and never leaks into the next.
    setMoveType: (p, ctx) => { if (ctx.move) ctx.move.type = p.type || 'Fairy'; },
    multiplyMovePower: (p, ctx) => {
        if (!ctx.move) return;
        ctx.move.basePower = Math.floor(n(ctx.move.basePower, 0) * (n(p.percent, 100) / 100));
    },
    setMovePower: (p, ctx) => {
        if (ctx.move) ctx.move.basePower = Math.max(0, Math.floor(n(p.power, 0)));
    },
    // The body half of an absorbing ability. tryHit reads ctx.immune back out
    // (see compileProgram) and the engine turns that into "it doesn't affect
    // <mon>", so everything after this in the body still runs -- which is what
    // lets Storm Drain raise Sp. Atk on the way.
    absorbMove: (_p, ctx) => { ctx.immune = true; },
    // Redirection needs an ally to pull the move away from and this engine
    // only runs singles, so there is nothing to move it off. Absorbing is the
    // one-on-one equivalent and what the block's own text promises; the
    // exported code carries the real onAnyRedirectTarget hook.
    redirectMove: (p, ctx) => {
        if (!ctx.move) return;
        if (p.type && p.type !== 'any' && ctx.move.type !== p.type) return;
        ctx.immune = true;
    },
    multiplyDamageTaken: (p, ctx) => { ctx.value = Math.floor(n(ctx.value, 0) * (n(p.percent, 100) / 100)); },
    addSideCondition: (p, ctx) => {
        const side = (p.target || 'foe') === 'foe' ? ctx.battle.sideOf(ctx.foe) : ctx.battle.sideOf(ctx.self);
        if (side) ctx.battle.addSideCondition(side, toId(p.condition || 'reflect'));
    },
    removeSideCondition: (p, ctx) => {
        const side = (p.target || 'foe') === 'foe' ? ctx.battle.sideOf(ctx.foe) : ctx.battle.sideOf(ctx.self);
        if (side) ctx.battle.removeSideCondition(side, toId(p.condition || 'reflect'));
    },
    changeTypeToMoveType: (p, ctx) => {
        const t = pick(ctx, p.target);
        if (t && ctx.move?.type) ctx.battle.setTypes(t, [ctx.move.type], ctx.abilityName);
    },
    setTypeFromMove: (p, ctx) => ACTION_RUNTIME.changeTypeToMoveType(p, ctx),
    resetStatStages: (p, ctx) => {
        const t = pick(ctx, p.target);
        if (t) ctx.battle.clearBoosts(t);
    },
    copyStatStages: (p, ctx) => {
        const from = pick(ctx, p.from || p.source || 'foe');
        const to = pick(ctx, p.to || p.target || 'self');
        if (from && to) to.boosts = { ...from.boosts };
    },
    setAbility: (p, ctx) => {
        const t = pick(ctx, p.target);
        if (t) ctx.battle.setAbility(t, p.ability || '');
    },
    changeAbility: (p, ctx) => ACTION_RUNTIME.setAbility(p, ctx),
    suppressAbility: (p, ctx) => {
        const t = pick(ctx, p.target || 'foe');
        if (t) ctx.battle.addVolatile(t, 'abilitysuppression');
    },
    addVolatile: (p, ctx) => {
        const t = pick(ctx, p.target || 'foe');
        if (t) ctx.battle.addVolatile(t, p.volatile || 'flinch');
    },
    setVolatile: (p, ctx) => ACTION_RUNTIME.addVolatile(p, ctx),
    removeVolatile: (p, ctx) => {
        const t = pick(ctx, p.target || 'self');
        if (t) ctx.battle.removeVolatile(t, p.volatile || 'flinch');
    },
    applyBattleEffect: (p, ctx) => {
        const t = pick(ctx, p.target || 'foe');
        if (t) ctx.battle.addVolatile(t, p.effect || 'stockpile');
    },
    removeBattleEffect: (p, ctx) => {
        const t = pick(ctx, p.target || 'self');
        if (t) ctx.battle.removeVolatile(t, p.effect || 'stockpile');
    },
    setBattleEffectProperty: (p, ctx) => {
        const t = pick(ctx, p.target || 'self');
        const v = t?.volatiles?.[p.effect || 'stockpile'];
        if (v) v[String(p.property || 'layers').replace(/[^a-zA-Z0-9_]/g, '')] = readValue(p.value, ctx);
    },
    setShield: (p, ctx) => {
        const t = pick(ctx, p.target || 'self');
        if (t) ctx.battle.addVolatile(t, 'protect');
    },
    setHazard: (p, ctx) => {
        const side = (p.target || 'foe') === 'foe' ? ctx.battle.sideOf(ctx.foe) : ctx.battle.sideOf(ctx.self);
        if (side) ctx.battle.addSideCondition(side, p.hazard || 'toxicspikes');
    },
    removeHazard: (p, ctx) => {
        const side = (p.target || 'self') === 'foe' ? ctx.battle.sideOf(ctx.foe) : ctx.battle.sideOf(ctx.self);
        if (side) ctx.battle.removeSideCondition(side, p.hazard || 'toxicspikes');
    },
    switchPokemon: (p, ctx) => {
        const t = pick(ctx, p.target || 'self');
        if (t) ctx.battle.requestForcedSwitch(t);
    },
    showMessage: (p, ctx) => ctx.battle.add('-message', String(p.text ?? '')),
    // The "let me write it myself" block. Compiled with new Function, so it
    // runs ONLY when the battle says it trusts the code it is holding: in a
    // battle against the bot every line is the player's own, running in their
    // own browser. In a battle against another player the code arrived over the
    // network and running it would be remote code execution, so both clients
    // skip it - together, which is what keeps the two simulations in step.
    customCode: (p, ctx) => {
        if (!ctx.battle.trustLocalCode) return;
        const src = String(p.code || '');
        if (!src.trim()) return;
        if (!CUSTOM_CODE.has(src)) {
            let fn = null;
            try {
                // eslint-disable-next-line no-new-func
                fn = new Function('battle', 'self', 'foe', 'move', 'damage', 'vars', `"use strict";\n${src}`);
            } catch (err) {
                console.warn('[battle] custom code block did not compile:', err?.message || err);
            }
            CUSTOM_CODE.set(src, fn);
        }
        const fn = CUSTOM_CODE.get(src);
        if (fn) fn(ctx.battle, ctx.self, ctx.foe, ctx.move, n(ctx.damage, 0), ctx.vars);
    },
    // Variable blocks. Scope is per-ability-activation for 'local' and
    // per-battle for 'global', matching how the editor labels them.
    setVariable: (p, ctx) => { varScope(p, ctx)[p.name || 'myVariable'] = readValue(p.value, ctx); },
    localVariable: (p, ctx) => { ctx.vars[p.name || 'localValue'] = readValue(p.value, ctx); },
    globalVariable: (p, ctx) => { ctx.battle.globals[p.name || 'battleValue'] = readValue(p.value, ctx); },
    changeVariable: (p, ctx) => {
        const scope = varScope(p, ctx); const k = p.name || 'myVariable';
        scope[k] = n(scope[k], 0) + n(p.amount, 1);
    },
    changePriority: (p, ctx) => { ctx.priorityBonus = n(ctx.priorityBonus, 0) + n(p.amount, 0); },
    setProperty: (p, ctx) => {
        const t = pick(ctx, p.target);
        if (!t) return;
        if (p.property === 'hp') ctx.battle.setHP(t, n(p.value, t.hp));
        else if (p.property === 'statStage') t.boosts.atk = n(p.value, 0);
    }
    // Pure "value" blocks (numberValue, hpValue, getVariable, …) and the
    // structural ones (callFunction, parameters, returnValue) have no
    // standalone side effect - they exist to be read by the fields above, so
    // they intentionally have no runtime entry and no-op if placed loose.
};

// Compiled custom-code blocks, keyed by their source. Compiling the same block
// once per activation would be wasteful and would hide a syntax error behind a
// warning printed every single turn.
const CUSTOM_CODE = new Map();

function varScope(p, ctx) {
    return (p.scope === 'global') ? ctx.battle.globals : ctx.vars;
}

// ---------------------------------------------------------------------------
// compiler: AST -> { event: [handler] }
// ---------------------------------------------------------------------------
export function compileProgram(program, abilityName = '') {
    const handlers = {};
    if (!program) return handlers;
    // Accept both the current v3 shape and the older single-trigger shape,
    // exactly like normalizeAbilityBlocks() in ability-blocks.js does.
    const events = Array.isArray(program.triggers)
        ? program.triggers
        : (program.trigger ? [{ trigger: program.trigger, triggerParams: program.triggerParams || {}, body: program.body || [] }] : []);

    for (const ev of events) {
        const map = TRIGGER_MAP[ev.trigger];
        if (!map) continue; // unknown//future trigger: ignored, never fatal
        const params = ev.triggerParams || {};
        const eventName = map.resolve ? map.resolve(params) : map.event;
        if (!eventName) continue;
        const body = Array.isArray(ev.body) ? ev.body : [];
        const handler = (ctx) => {
            if (map.filter && !map.filter(params, ctx)) return undefined;
            ctx.vars = ctx.vars || {};
            ctx.abilityName = abilityName;
            runBody(body, ctx);
            // Two ways to be immune. For the presets (moveImmunity, drawIn)
            // the trigger firing IS the immunity -- its filter already checked
            // the move type, and their generated Showdown code ends in an
            // unconditional `return null`. For the raw moveIncoming event it
            // is the absorb action in the body that decides, which is what
            // ctx.immune carries. This used to read ctx.immune alone, which
            // nothing set, so an absorbing ability ran its body (the Storm
            // Drain boost) and then took the hit anyway.
            if (map.immunity) return 'immune';
            if (map.canImmune) return ctx.immune ? 'immune' : undefined;
            return map.value ? ctx.value : undefined;
        };
        handler.isValueEvent = !!map.value;
        handler.isImmunity = !!map.immunity;
        (handlers[eventName] ||= []).push(handler);
    }
    return handlers;
}

function runBody(body, ctx, depth = 0) {
    // Guard against a pathological AST (deep nesting from a corrupted import)
    // locking up the tab mid-battle.
    if (depth > 32) return;
    for (const block of body || []) {
        if (!block) continue;
        if (block.kind === 'if') {
            const cond = CONDITION_RUNTIME[block.condition];
            // An unrecognised condition is treated as false rather than true:
            // failing closed can't accidentally trigger a damaging effect.
            const ok = cond ? !!safe(() => cond(block.condParams || {}, ctx), false) : false;
            runBody(ok ? block.then : block.else, ctx, depth + 1);
        } else if (block.kind === 'action') {
            const fn = ACTION_RUNTIME[block.action];
            if (fn) safe(() => fn(block.params || {}, ctx), undefined);
            // else: a block with no runtime meaning (a pure value block, or one
            // added to the editor after this table). Skipped silently so new
            // editor blocks can never crash a live battle.
        }
    }
}

// One misbehaving ability must not take down the whole battle - a thrown
// handler is contained, logged onto the battle, and the turn continues.
function safe(fn, fallback) {
    try { return fn(); } catch (err) {
        if (typeof console !== 'undefined') console.warn('[battle] ability block failed:', err?.message || err);
        return fallback;
    }
}

// Dev helper: which block ids in the editor's catalog have no runtime yet.
// Call with the ACTIONS/CONDITIONS objects from ability-blocks.js.
export function coverageReport(ACTIONS = {}, CONDITIONS = {}, TRIGGERS = {}) {
    return {
        missingActions: Object.keys(ACTIONS).filter(k => !(k in ACTION_RUNTIME)),
        missingConditions: Object.keys(CONDITIONS).filter(k => !(k in CONDITION_RUNTIME)),
        missingTriggers: Object.keys(TRIGGERS).filter(k => !(k in TRIGGER_MAP))
    };
}

export { ACTION_RUNTIME, CONDITION_RUNTIME, TRIGGER_MAP };
