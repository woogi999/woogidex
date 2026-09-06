// ==================== Showdown hook compiler ====================
// Pokemon Showdown is MIT licensed (c) Guangcong Luo and contributors:
//     https://github.com/smogon/pokemon-showdown
//
// One place that turns a Showdown-shaped entry into this engine's
// { event: [handler] } table. Four callers use it and they must agree:
//
//   sd-abilities.js  the simulator's ability table
//   sd-items.js      the simulator's item table
//   raw code         an ability/move/item whose author wrote Showdown hooks by
//                    hand (see compileRawHooks below)
//   battle.js        via rawMoveEffects, for a hand-written custom MOVE, which
//                    goes down the move pipeline instead of the event table
//
// Nothing here is re-implemented Showdown logic. The entry's own functions are
// called, with this engine's objects wrapped in the facade Showdown's code
// reaches for. An entry is data plus functions; this module only ever calls
// them.
//
// The bridge is still partial -- Showdown has well over a hundred distinct
// hooks and this engine is a singles-only subset of its mechanics -- but the
// table below covers the ones people actually write, including the whole
// modify* family. A hook that is not mapped is skipped and NAMED to its author
// in the editor rather than silently doing nothing, and a mapped hook that
// reaches for unbridged API degrades to "this one effect does nothing" rather
// than taking the battle down.

import { pokeFacade, battleFacade, withEffect, Chain } from './sd-facade.js';

// ==================== argument shapes ====================
// Showdown's hooks take different argument lists, and which Pokemon comes
// first depends on whose effect it is. `self` is always the holder of the
// effect being run -- the Pokemon whose ability/item it is, or the user of the
// move -- and `foe` is the other one. A hook whose signature names the source
// first (every `onSource*` / `onFoe*`) is held by the target, so it gets them
// the other way round.
const ARGS = {
    none:            ()  => [],
    self:            (c) => [c.self],
    selfFoe:         (c) => [c.self, c.foe],
    selfFoeMove:     (c) => [c.self, c.foe, c.move],
    foeSelfMove:     (c) => [c.foe, c.self, c.move],
    dmgSelfFoeMove:  (c) => [c.damage, c.self, c.foe, c.move],
    valSelfFoeMove:  (c) => [c.value, c.self, c.foe, c.move],
    valFoeSelfMove:  (c) => [c.value, c.foe, c.self, c.move],
    moveSelfFoe:     (c) => [c.move, c.self, c.foe],
    moveFoeSelf:     (c) => [c.move, c.foe, c.self],
    typeSelf:        (c) => [c.move?.type, c.self],
    statusSelfFoeMove: (c) => [c.status, c.self, c.foe, c.move],
    // onEffectiveness(typeMod, target, type, move)
    effSelf:         (c) => [c.value, c.self, c.effType, c.move]
};

// ==================== the hook table ====================
// event : the engine event this hook binds to (see battle.js runEvent).
// args  : which argument shape above to call it with.
// kind  : what the return value means.
//           'void'   ignored (the hook acted through this.* instead)
//           'number' a replacement number, or this.chainModify()
//           'any'    a replacement value of any type (an array, an object)
//           'block'  false/null means "do not do this"
//           'immune' false/null means "this Pokemon is immune"
// stat  : narrows a modifyStat hook to one stat.
// role  : narrows a two-sided event to one side of it ('user' | 'target').
// whose : for modifyStat, whether the hook speaks about its holder's own stat
//         (the default) or its opponent's ('foe', every onSource*/onFoe*).
export const HOOK_SPECS = {
    // ---------------------------------------------------------- lifecycle
    onStart:              { event: 'switchIn',  args: 'self' },
    onSwitchIn:           { event: 'switchIn',  args: 'self' },
    onAnySwitchIn:        { event: 'switchIn',  args: 'self' },
    onSwitchOut:          { event: 'switchOut', args: 'self' },
    onBeforeSwitchOut:    { event: 'switchOut', args: 'self' },
    onEnd:                { event: 'switchOut', args: 'self' },
    onFaint:              { event: 'faint',     args: 'self' },
    onAnyFaint:           { event: 'faint',     args: 'self' },

    // ------------------------------------------------------ turn structure
    onResidual:           { event: 'residual',  args: 'self' },
    onWeather:            { event: 'weather',   args: 'self' },
    // Berries and Focus Sash react to HP changing, which is what this engine
    // fires afterDamage for.
    onUpdate:             { event: 'afterDamage', args: 'self' },
    onTurnStart:          { event: 'turnStart', args: 'self' },
    onBeforeTurn:         { event: 'turnStart', args: 'self' },
    onDisableMove:        { event: 'disableMove', args: 'self' },
    onTrapPokemon:        { event: 'trapPokemon', args: 'self' },
    onFoeTrapPokemon:     { event: 'trapPokemon', args: 'self' },

    // -------------------------------------------------------- using a move
    onBeforeMove:         { event: 'beforeMove', args: 'selfFoeMove' },
    onFoeBeforeMove:      { event: 'beforeMove', args: 'foeSelfMove' },
    onModifyType:         { event: 'modifyType', args: 'moveSelfFoe', role: 'user' },
    onModifyMove:         { event: 'modifyMove', args: 'moveSelfFoe', role: 'user' },
    onAnyModifyMove:      { event: 'modifyMove', args: 'moveSelfFoe' },
    onFoeModifyMove:      { event: 'modifyMove', args: 'moveFoeSelf', role: 'target' },
    onModifyPriority:     { event: 'modifyPriority', args: 'valSelfFoeMove', kind: 'number' },
    onFractionalPriority: { event: 'modifyPriority', args: 'valSelfFoeMove', kind: 'number' },
    onPrepareHit:         { event: 'prepareHit', args: 'selfFoeMove' },
    onFlinch:             { event: 'flinch', args: 'self', kind: 'block' },

    // -------------------------------------------------------------- accuracy
    // Both sides get a say. Compound Eyes sharpens its holder's own aim
    // (onSourceModifyAccuracy, holder is the attacker); Sand Veil blurs the aim
    // taken AT its holder (onModifyAccuracy, holder is the target).
    onModifyAccuracy:       { event: 'modifyAccuracy', args: 'valSelfFoeMove', kind: 'number', role: 'target' },
    onSourceModifyAccuracy: { event: 'modifyAccuracy', args: 'valFoeSelfMove', kind: 'number', role: 'user' },
    onAccuracy:             { event: 'modifyAccuracy', args: 'valSelfFoeMove', kind: 'number' },

    // ----------------------------------------------------------------- stats
    onModifyAtk:  { event: 'modifyStat', args: 'valSelfFoeMove', kind: 'number', stat: 'atk' },
    onModifyDef:  { event: 'modifyStat', args: 'valSelfFoeMove', kind: 'number', stat: 'def' },
    onModifySpA:  { event: 'modifyStat', args: 'valSelfFoeMove', kind: 'number', stat: 'spa' },
    onModifySpD:  { event: 'modifyStat', args: 'valSelfFoeMove', kind: 'number', stat: 'spd' },
    onModifySpe:  { event: 'modifyStat', args: 'valSelfFoeMove', kind: 'number', stat: 'spe' },
    // The onSource / onFoe family speaks about the OTHER Pokemon's stat, so it
    // binds to the same event asked from the other direction (see getStat).
    onSourceModifyAtk: { event: 'modifyStat', args: 'valFoeSelfMove', kind: 'number', stat: 'atk', whose: 'foe' },
    onSourceModifyDef: { event: 'modifyStat', args: 'valFoeSelfMove', kind: 'number', stat: 'def', whose: 'foe' },
    onSourceModifySpA: { event: 'modifyStat', args: 'valFoeSelfMove', kind: 'number', stat: 'spa', whose: 'foe' },
    onSourceModifySpD: { event: 'modifyStat', args: 'valFoeSelfMove', kind: 'number', stat: 'spd', whose: 'foe' },
    onSourceModifySpe: { event: 'modifyStat', args: 'valFoeSelfMove', kind: 'number', stat: 'spe', whose: 'foe' },
    onFoeModifyAtk:    { event: 'modifyStat', args: 'valFoeSelfMove', kind: 'number', stat: 'atk', whose: 'foe' },
    onFoeModifyDef:    { event: 'modifyStat', args: 'valFoeSelfMove', kind: 'number', stat: 'def', whose: 'foe' },
    onFoeModifySpA:    { event: 'modifyStat', args: 'valFoeSelfMove', kind: 'number', stat: 'spa', whose: 'foe' },
    onFoeModifySpD:    { event: 'modifyStat', args: 'valFoeSelfMove', kind: 'number', stat: 'spd', whose: 'foe' },
    onFoeModifySpe:    { event: 'modifyStat', args: 'valFoeSelfMove', kind: 'number', stat: 'spe', whose: 'foe' },

    // ---------------------------------------------------------------- boosts
    onTryBoost:       { event: 'tryBoost',   args: 'valSelfFoeMove', kind: 'any' },
    onAfterBoost:     { event: 'afterBoost', args: 'valSelfFoeMove' },
    onAfterEachBoost: { event: 'afterBoost', args: 'valSelfFoeMove' },

    // ---------------------------------------------------------- power/damage
    onBasePower:       { event: 'modifyBasePower', args: 'valSelfFoeMove', kind: 'number', role: 'user' },
    onAllyBasePower:   { event: 'modifyBasePower', args: 'valSelfFoeMove', kind: 'number', role: 'user' },
    onAnyBasePower:    { event: 'modifyBasePower', args: 'valSelfFoeMove', kind: 'number' },
    onSourceBasePower: { event: 'modifyBasePower', args: 'valFoeSelfMove', kind: 'number', role: 'target' },
    onFoeBasePower:    { event: 'modifyBasePower', args: 'valFoeSelfMove', kind: 'number', role: 'target' },
    onModifyCritRatio: { event: 'modifyCritRatio', args: 'valSelfFoeMove', kind: 'number' },
    onCriticalHit:     { event: 'criticalHit', args: 'selfFoeMove', kind: 'block' },
    onEffectiveness:   { event: 'effectiveness', args: 'effSelf', kind: 'number' },
    onModifyDamage:       { event: 'modifyDamageDealt', args: 'valSelfFoeMove', kind: 'number' },
    onAnyModifyDamage:    { event: 'modifyDamageDealt', args: 'valSelfFoeMove', kind: 'number' },
    onSourceModifyDamage: { event: 'modifyDamageTaken', args: 'valFoeSelfMove', kind: 'number' },
    // Sturdy and Focus Sash: the last word before HP actually comes off.
    onDamage:          { event: 'damage', args: 'dmgSelfFoeMove', kind: 'number' },
    onAnyDamage:       { event: 'damage', args: 'dmgSelfFoeMove', kind: 'number' },
    onTryHeal:         { event: 'tryHeal', args: 'dmgSelfFoeMove', kind: 'number' },
    onModifySecondaries: { event: 'modifySecondaries', args: 'valSelfFoeMove', kind: 'any' },

    // ------------------------------------------------------------- being hit
    onDamagingHit:     { event: 'damagingHit', args: 'dmgSelfFoeMove' },
    onAnyDamagingHit:  { event: 'damagingHit', args: 'dmgSelfFoeMove' },
    onAfterDamage:     { event: 'damagingHit', args: 'dmgSelfFoeMove' },
    onAfterMove:       { event: 'afterMove', args: 'selfFoeMove' },
    onAfterMoveSecondary:     { event: 'afterMoveHit', args: 'selfFoeMove' },
    onAfterMoveSecondarySelf: { event: 'afterMoveHit', args: 'selfFoeMove' },
    // A move entry pasted into the ability or item box still does something
    // sensible rather than nothing at all.
    onHit:             { event: 'afterMoveHit', args: 'selfFoeMove' },

    // -------------------------------------------------------------- immunity
    onImmunity:        { event: 'tryHit', args: 'typeSelf', kind: 'immune' },
    onTryHit:          { event: 'tryHit', args: 'selfFoeMove', kind: 'immune' },
    onFoeTryMove:      { event: 'tryHit', args: 'selfFoeMove', kind: 'immune' },

    // ---------------------------------------------------------------- status
    // Showdown's onSetStatus REFUSES a status (Immunity, Insomnia and Limber
    // all return false from it), so it has to be asked before the status
    // lands. The engine's own post-hoc setStatus event is what
    // onAfterSetStatus and the block editor's "when statused" trigger bind to.
    onSetStatus:       { event: 'trySetStatus', args: 'statusSelfFoeMove', kind: 'block' },
    onTrySetStatus:    { event: 'trySetStatus', args: 'statusSelfFoeMove', kind: 'block' },
    onAfterSetStatus:  { event: 'setStatus', args: 'statusSelfFoeMove' }
};

// Move-pipeline hooks. These are not ability events at all -- they belong to
// the move executor in battle.js, which calls them at named points in the
// pipeline (see sd-moves.js runMoveHook). Raw code on a CUSTOM MOVE is routed
// here instead of through the ability table above, which is what lets someone
// paste a whole Showdown move entry and have onModifyMove, onBasePower,
// basePowerCallback, onHit and the rest actually run.
export const MOVE_HOOKS = [
    'basePowerCallback', 'damageCallback',
    'onTry', 'onTryMove', 'onTryImmunity', 'onTryHit',
    'onModifyMove', 'onBasePower', 'onEffectiveness',
    'onHit', 'onAfterHit', 'onAfterMove', 'onMoveFail'
];

// Hooks that live on a move's `condition` -- the state a move leaves behind on
// the Pokemon using it.
export const MOVE_CONDITION_HOOKS = ['onInvulnerability', 'onSourceModifyDamage'];

// Kept as a name->event map for anything that only wants to ask "does this
// engine have somewhere to put this hook".
export const HOOK_EVENTS = Object.fromEntries(
    Object.entries(HOOK_SPECS).map(([hook, spec]) => [hook, spec.event])
);

// Every hook name this bridge can do something with, for either kind of entry.
export function supportedHooks(kind = 'ability') {
    const names = kind === 'move'
        ? [...MOVE_HOOKS, ...MOVE_CONDITION_HOOKS, ...Object.keys(HOOK_SPECS)]
        : Object.keys(HOOK_SPECS);
    return [...new Set(names)].sort();
}

const VALUE_KINDS = new Set(['number', 'any']);

// ==================== compiling an entry ====================
// Compiles one entry's hooks. `label` names it in warnings and is what the
// facade reports as the active effect; `isItem` marks the handlers so ability
// suppression (Gastro Acid, Neutralizing Gas) leaves them alone. `skip` drops
// hook names another compiler has already claimed -- a custom move's own
// onAfterMove belongs to the move pipeline, and binding it here as well would
// fire it twice.
export function compileHookTable(entry, label = '', { isItem = false, skip = null } = {}) {
    if (!entry || typeof entry !== 'object') return null;
    const out = {};

    for (const [hook, spec] of Object.entries(HOOK_SPECS)) {
        if (skip && skip.has(hook)) continue;
        const fn = entry[hook];
        if (typeof fn !== 'function') continue;

        const build = ARGS[spec.args] || ARGS.none;
        const isValue = VALUE_KINDS.has(spec.kind);
        const wantsFoeStat = spec.whose === 'foe';
        const handler = (ctx) => {
            // A stat hook only speaks for its own stat, a two-sided hook only
            // for its own side of the question, and an onSource*/onFoe* stat
            // hook only about its opponent's stat rather than its own.
            if (spec.stat && ctx.stat !== spec.stat) return ctx.value;
            if (spec.role && ctx.role && ctx.role !== spec.role) return ctx.value;
            if (spec.event === 'modifyStat' && (ctx.whose === 'foe') !== wantsFoeStat) return ctx.value;

            const effectState = (ctx.self._sdEffectState ||= {});
            // Showdown writes most multipliers as this.chainModify(x) with no
            // return value at all, so a chain is threaded through and read
            // back out when the hook returned nothing itself.
            const chain = spec.kind === 'number' ? new Chain() : null;
            const self = pokeFacade(ctx.self, ctx.battle);
            const foe = pokeFacade(ctx.foe, ctx.battle);
            const scope = battleFacade(ctx.battle, effectState, chain);
            try {
                const args = build({ ...ctx, self, foe });
                const result = withEffect(ctx.battle, label, () => fn.apply(scope, args));
                switch (spec.kind) {
                    case 'number':
                        if (result === false) return false;
                        if (Number.isFinite(result)) return result;
                        if (chain && chain.value !== 4096 && Number.isFinite(ctx.value)) return chain.apply(ctx.value);
                        return ctx.value;
                    case 'any':
                        return result === undefined ? ctx.value : result;
                    case 'immune':
                        return result === false || result === null ? 'immune' : undefined;
                    case 'block':
                        return result === false || result === null ? false : undefined;
                    default:
                        return undefined;
                }
            } catch (err) {
                console.warn(`[BATTLE] ${label}.${hook} needs unbridged API`, err.message);
                return isValue ? ctx.value : undefined;
            }
        };
        handler.isValueEvent = isValue;
        handler.isImmunity = spec.kind === 'immune';
        handler.isBlocking = spec.kind === 'block';
        handler.isItem = isItem;
        handler.hookName = hook;
        (out[spec.event] ||= []).push(handler);
    }

    return Object.keys(out).length ? out : null;
}

// ==================== hand-written Showdown hooks ====================
// The "just let me write the code" option in the move / item / ability
// editors. What goes in the box is meant to be as close to "whatever you found
// on Showdown" as it can be -- see parseRawEntry for everything that counts as
// valid input.
//
// SECURITY: this is compiled with new Function, so it is only ever run when the
// battle says it trusts the code it is holding -- see Battle's `trustLocalCode`
// (true for a battle against the bot, where every line is the player's own and
// runs in their own browser; false for anything involving another player, where
// the code arrived over the network and running it would be remote code
// execution). Both clients of a PvP battle skip it, so skipping is symmetric
// and the two simulations stay in step.
export function compileRawHooks(source, label = '', { isItem = false, kind = 'ability' } = {}) {
    const parsed = parseRawEntry(source);
    if (!parsed.ok || !parsed.entry) {
        if (String(source || '').trim()) {
            console.warn(`[BATTLE] ${label || 'raw code'} did not compile: ${parsed.error}`);
        }
        return null;
    }
    // On a move, the move pipeline has already claimed its own hooks.
    const skip = kind === 'move' ? new Set(MOVE_HOOKS) : null;
    return compileHookTable(parsed.entry, label || 'custom code', { isItem, skip });
}

// The same source, compiled for the MOVE pipeline instead: the shape
// showdownMoveEffects() returns, so battle.js can run a hand-written move down
// exactly the path it runs one of Showdown's own down -- data fields included,
// which is what makes a pasted `secondaries` or `drain` block work.
//
// `dataFields` is the list of effect fields worth lifting off the entry. The
// caller passes sd-moves' own list rather than this module keeping a second
// copy that could drift from it.
export function rawMoveEffects(source, name = '', dataFields = []) {
    const parsed = parseRawEntry(source);
    if (!parsed.ok || !parsed.entry) return null;
    const raw = parsed.entry;

    const data = {};
    for (const field of dataFields) {
        if (raw[field] !== undefined && typeof raw[field] !== 'function') data[field] = raw[field];
    }
    // Showdown writes a lone extra effect as `secondary` and only uses
    // `secondaries` for moves that have more than one.
    if (!data.secondaries && raw.secondary) data.secondaries = [raw.secondary];
    if (raw.flags?.charge) data.isCharging = true;

    const hooks = {};
    for (const hook of MOVE_HOOKS) {
        if (typeof raw[hook] === 'function') hooks[hook] = raw[hook];
    }
    const condition = {};
    for (const hook of MOVE_CONDITION_HOOKS) {
        if (typeof raw.condition?.[hook] === 'function') condition[hook] = raw.condition[hook];
    }
    if (!Object.keys(data).length && !Object.keys(hooks).length && !Object.keys(condition).length) return null;
    return { id: raw.id || '', name: raw.name || name || 'custom move', data, hooks, condition };
}

// ==================== lenient parsing ====================
// What people actually paste is rarely "the inside of an entry". It is a whole
// file off GitHub, an export statement, a TypeScript entry with its type
// annotations still on, one keyed entry lifted out of a dex table, or the
// object literal with its braces left on. All of those describe the same
// thing, so all of them are accepted: each candidate rewrite below is tried in
// turn and the first that both parses AND yields something entry-shaped wins.
//
// Returns { ok, entry, error, autoFixed, fixedText, via }.
export function parseRawEntry(source) {
    const text = String(source || '').trim();
    if (!text) return { ok: true, entry: null };

    let firstError = null;
    for (const candidate of rewriteCandidates(text)) {
        const attempt = evaluateEntry(candidate.text);
        if (!attempt.ok) { firstError ||= attempt.error; continue; }
        const entry = unwrapEntry(attempt.entry);
        if (!entry) { firstError ||= 'nothing in here looks like an entry'; continue; }
        return {
            ok: true, entry, via: candidate.via,
            autoFixed: candidate.text !== text,
            // Only a rewrite that is still the same KIND of source is safe to
            // write back into the textarea; unwrapping an export is not.
            fixedText: candidate.canonical ? candidate.text : undefined
        };
    }
    return { ok: false, error: firstError || 'syntax error' };
}

// Every form of the source worth trying, cheapest and most likely first.
function* rewriteCandidates(text) {
    // 1. the documented form: bare hooks, no surrounding braces
    yield { text, via: 'hooks' };

    // 2. the same with a missing comma / stray semicolon repaired
    const fix = autoFixRawHookSource(text);
    if (fix.fixed) yield { text: fix.text, via: 'hooks', canonical: true };

    // 3. an object literal, an export, an assignment, or a whole module: take
    //    what is between the outermost braces.
    const stripped = stripWrapper(text);
    if (stripped !== null) {
        yield { text: stripped, via: 'object' };
        const objFix = autoFixRawHookSource(stripped);
        if (objFix.fixed) yield { text: objFix.text, via: 'object' };
    }

    // 4. TypeScript: parameter and variable type annotations removed. Tried
    //    last because the strip is textual, so a source that parses without it
    //    never sees it.
    const noTypes = stripTypeAnnotations(text);
    if (noTypes !== text) {
        yield { text: noTypes, via: 'hooks' };
        const tsFix = autoFixRawHookSource(noTypes);
        if (tsFix.fixed) yield { text: tsFix.text, via: 'hooks' };
        const tsStripped = stripWrapper(noTypes);
        if (tsStripped !== null) {
            yield { text: tsStripped, via: 'object' };
            const both = autoFixRawHookSource(tsStripped);
            if (both.fixed) yield { text: both.text, via: 'object' };
        }
    }
}

// Compiles one candidate. The body is always wrapped in braces here, so a
// candidate is the INSIDE of an object either way.
function evaluateEntry(body) {
    try {
        // eslint-disable-next-line no-new-func
        const entry = new Function(`"use strict"; return ({ ${body} });`)();
        return { ok: true, entry };
    } catch (err) {
        return { ok: false, error: describeCompileError(err) };
    }
}

// `export const Abilities = { ... };`, `module.exports = { ... }`,
// `export default { ... }`, `const x = { ... }` and a bare `{ ... }` all
// reduce to the text between the outermost braces. Returns null when what
// precedes the first brace is not a wrapper -- `onStart(p) { ... }` has a
// brace too, and its contents are a function body, not an entry.
function stripWrapper(text) {
    const open = text.indexOf('{');
    const close = text.lastIndexOf('}');
    if (open === -1 || close <= open) return null;
    const head = text.slice(0, open);
    const isWrapper = /^\s*$/.test(head)
        || /=\s*$/.test(head)
        || /(^|[\s;])(export|module\.exports|exports\.\w+|const|let|var|return|default)\b[^{]*$/.test(head);
    if (!isWrapper) return null;
    const body = text.slice(open + 1, close);
    return body === text ? null : body;
}

// Removes TypeScript annotations: `: SomeType` on parameters, `as const`, and
// `satisfies X`. Deliberately conservative -- it only strips an annotation
// inside a parameter list that is followed by a `,`, `)` or `=`, which is
// where a type can actually sit, and never touches a string or a comment.
function stripTypeAnnotations(text) {
    let out = '';
    let i = 0;
    let depth = 0;          // paren depth, so parameter lists are recognisable
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
            const seg = readComment(text, i);
            out += seg; i += seg.length; continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            const seg = readString(text, i);
            out += seg; i += seg.length; continue;
        }
        if (ch === '(') { depth++; out += ch; i++; continue; }
        if (ch === ')') { depth = Math.max(0, depth - 1); out += ch; i++; continue; }
        const asConst = /^\s+as\s+const\b/.exec(text.slice(i));
        if (asConst) { i += asConst[0].length; continue; }
        const satisfies = /^\s+satisfies\s+[A-Za-z_$][\w$.]*(\s*<[^<>]*>)?/.exec(text.slice(i));
        if (satisfies) { i += satisfies[0].length; continue; }
        if (ch === ':' && depth > 0) {
            const rest = text.slice(i + 1);
            const m = /^\s*[A-Za-z_$][\w$.]*(\s*<[^<>]*>)?(\s*\[\s*\])*(\s*\|\s*[A-Za-z_$][\w$.]*(\s*<[^<>]*>)?(\s*\[\s*\])*)*\s*(?=[,)=])/.exec(rest);
            if (m) { i += 1 + m[0].length; continue; }
        }
        out += ch; i++;
    }
    return out;
}

function readComment(text, i) {
    if (text[i + 1] === '/') {
        const end = text.indexOf('\n', i);
        return end === -1 ? text.slice(i) : text.slice(i, end);
    }
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? text.slice(i) : text.slice(i, end + 2);
}

function readString(text, i) {
    const quote = text[i];
    let j = i + 1;
    while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === quote) { j++; break; }
        j++;
    }
    return text.slice(i, j);
}

// A dex table is `{ myability: { onStart() {} } }` and a single entry is
// `{ onStart() {} }`. Both are things people paste, so an object with no hooks
// of its own but exactly one object-valued member is unwrapped -- repeatedly,
// since `{ Abilities: { myability: { ... } } }` is also a thing people paste.
function unwrapEntry(entry) {
    let current = entry;
    for (let depth = 0; depth < 4; depth++) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
        if (hasAnyHook(current)) return current;
        const objectKeys = Object.keys(current).filter(k => current[k] && typeof current[k] === 'object' && !Array.isArray(current[k]));
        if (objectKeys.length !== 1) break;
        current = current[objectKeys[0]];
    }
    // Data-only is a legitimate entry for a move (someone pasting nothing but
    // a `secondaries` block), so an object with no hooks is still returned
    // rather than refused. An empty one is not.
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
    return Object.keys(current).length ? current : null;
}

function hasAnyHook(entry) {
    return Object.keys(entry).some(k => typeof entry[k] === 'function'
        && (k in HOOK_SPECS || MOVE_HOOKS.includes(k) || /^on[A-Z]/.test(k) || k.endsWith('Callback')));
}

// Turns the raw parser exception into something short enough to show next to
// a textarea rather than a full engine error string.
function describeCompileError(err) {
    const msg = String(err?.message || 'syntax error');
    if (/unexpected identifier/i.test(msg) || /unexpected string/i.test(msg) || /unexpected number/i.test(msg)) return 'missing a comma between two hooks';
    if (/unexpected token '?;'?/i.test(msg)) return 'use a comma, not a semicolon, between hooks';
    if (/unexpected end of input/i.test(msg)) return 'missing a closing bracket somewhere';
    if (/unexpected token '?\}'?/i.test(msg)) return 'an extra or misplaced closing bracket';
    return msg;
}

// Mechanically repairs the two mistakes that make up almost every "it should
// just work" report from this box: a comma missing between two hooks, and a
// semicolon typed where a comma belongs. Only ever touches text sitting at
// the top level between hooks - never anything inside a hook's own body - so
// a `;` a Pokemon script legitimately writes stays untouched.
export function autoFixRawHookSource(source) {
    const text = String(source || '');
    let depth = 0;
    let atBoundary = false;
    let out = '';
    let fixed = false;
    let i = 0;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        // comments pass through unchanged and never count as a boundary token
        if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
            const seg = readComment(text, i);
            out += seg; i += seg.length; continue;
        }
        // strings pass through unchanged
        if (ch === '"' || ch === "'" || ch === '`') {
            const seg = readString(text, i);
            out += seg; i += seg.length; continue;
        }
        if (depth === 0) {
            if (/\s/.test(ch)) { out += ch; i++; continue; }
            if (ch === ';') {
                // a semicolon can never validly separate object members
                out += ','; i++; fixed = true; atBoundary = false; continue;
            }
            if (ch !== ',' && ch !== '}' && atBoundary) {
                out += ','; fixed = true;
            }
            atBoundary = false;
        }
        if (ch === '{' || ch === '(' || ch === '[') depth++;
        else if (ch === '}' || ch === ')' || ch === ']') {
            depth--;
            // a hook's function body closing brace is what actually ends a
            // member; a closing paren from its argument list is not.
            if (depth === 0 && ch === '}') atBoundary = true;
        }
        out += ch; i++;
    }
    return { text: out, fixed };
}

// Reports whether a piece of hand-written code parses, what it binds, and what
// is wrong when it does not. The editors call this so a typo is caught while it
// is being written rather than in the middle of a battle.
//
// `kind` decides which hooks count as supported: a move gets the move pipeline
// as well as the shared event table, so onBasePower in a move is not reported
// as unsupported when it is exactly what a move should be using.
export function checkRawHooks(source, kind = 'ability') {
    const text = String(source || '').trim();
    if (!text) return { ok: true, hooks: [], unknown: [], data: [] };

    const parsed = parseRawEntry(text);
    if (!parsed.ok) return { ok: false, error: parsed.error, hooks: [], unknown: [], data: [] };
    const entry = parsed.entry || {};

    const supported = new Set(supportedHooks(kind));
    const all = Object.keys(entry).filter(k => typeof entry[k] === 'function');
    const hooks = all.filter(h => supported.has(h));
    const unknown = all.filter(h => !supported.has(h));
    // Non-function members are data (basePower, secondaries, boosts...). On a
    // move they are applied; anywhere else they are inert, and saying so is
    // more use to the author than silence.
    const data = Object.keys(entry).filter(k => typeof entry[k] !== 'function' && k !== 'condition');
    const conditionHooks = Object.keys(entry.condition || {})
        .filter(k => typeof entry.condition[k] === 'function' && MOVE_CONDITION_HOOKS.includes(k));

    return {
        ok: true, hooks, unknown, data, conditionHooks,
        via: parsed.via,
        autoFixed: !!parsed.autoFixed,
        fixedText: parsed.fixedText
    };
}
