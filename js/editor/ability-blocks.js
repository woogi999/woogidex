import { log } from '../core/log.js';
import { state, api } from '../core/app.js';
import { POKEMON_TYPES } from '../core/data.js';
// the same parser the battle engine uses, so exporters and pasted code can
// never disagree about what a paste means
import { parseRawEntry } from '../battle/engine/sd-hooks.js';

// ==================== ability block coding ====================
// small Scratch-style visual coding surface for custom ability battle logic.
// a "program" is a plain-object AST on customAbilities[i].blocks:
//
//   { trigger: 'switchIn', triggerParams: {}, body: [ ...blocks ] }
//   { id, kind:'action', action:'boostStat', params:{...} }
//   { id, kind:'if', condition:'hpBelow', condParams:{...}, then:[...], else:null|[...] }
//
// two compilers turn that AST into starter code: a Pokémon Showdown
// `BattleAbility` handler, or a modern Pokémon Essentials
// `Battle::AbilityEffects` handler -- both meant to be dropped in and tweaked.

// ==================== small helpers ====================
import { esc as escapeHtml } from '../core/html.js';
function cap(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }
function uid() { return 'blk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function toShowdownAbilityId(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function toEssentialsAbilityId(name) { return String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, ''); }

// ==================== reference catalogs ====================
const STATS = [
    { id: 'atk', label: 'Attack' }, { id: 'def', label: 'Defense' },
    { id: 'spa', label: 'Sp. Atk' }, { id: 'spd', label: 'Sp. Def' }, { id: 'spe', label: 'Speed' }
];
const STAT_ESSENTIALS = { atk: 'ATTACK', def: 'DEFENSE', spa: 'SPECIAL_ATTACK', spd: 'SPECIAL_DEFENSE', spe: 'SPEED' };
const STATUSES = [
    { id: 'brn', label: 'Burn', es: 'BURN' }, { id: 'par', label: 'Paralysis', es: 'PARALYSIS' },
    { id: 'psn', label: 'Poison', es: 'POISON' }, { id: 'slp', label: 'Sleep', es: 'SLEEP' }, { id: 'frz', label: 'Freeze', es: 'FROZEN' }
];
const WEATHERS = [
    { id: 'Sun', label: 'Harsh Sunlight', sd: 'sunnyday' }, { id: 'Rain', label: 'Rain', sd: 'raindance' },
    { id: 'Sand', label: 'Sandstorm', sd: 'sandstorm' }, { id: 'Hail', label: 'Hail', sd: 'hail' }
];
const FRACTIONS = [{ id: '4', label: '1/4 max HP' }, { id: '8', label: '1/8 max HP' }, { id: '16', label: '1/16 max HP' }];
const TARGETS = [{ value: 'self', label: 'this Pokémon' }, { value: 'foe', label: 'the opposing Pokémon' }];
const TYPES = POKEMON_TYPES.map(t => ({ value: t, label: t }));
// a catalog rather than free-text; each entry can describe the state
// properties it exposes so generic battle-effect blocks can inspect them
// (e.g. Stockpile's layer count) without a one-off block per effect
const VOLATILES = [
    { value:'stockpile', label:'Stockpile', properties:[{value:'layers',label:'Stacks / layers'}] },
    { value:'substitute', label:'Substitute', properties:[{value:'hp',label:'HP'}] },
    { value:'leechseed', label:'Leech Seed', properties:[{value:'source',label:'Source'}] },
    { value:'taunt', label:'Taunt', properties:[{value:'duration',label:'Duration'},{value:'turns',label:'Turns remaining'}] },
    { value:'encore', label:'Encore', properties:[{value:'duration',label:'Duration'},{value:'turns',label:'Turns remaining'}] },
    { value:'confusion', label:'Confusion', properties:[{value:'duration',label:'Duration'},{value:'turns',label:'Turns remaining'}] },
    { value:'flinch', label:'Flinch' },
    { value:'protect', label:'Protect', properties:[{value:'streak',label:'Successive uses'}] },
    { value:'disable', label:'Disable', properties:[{value:'duration',label:'Duration'},{value:'move',label:'Disabled move'}] },
    { value:'torment', label:'Torment', properties:[{value:'duration',label:'Duration'}] },
    { value:'yawn', label:'Yawn', properties:[{value:'duration',label:'Duration'}] },
    { value:'ingrain', label:'Ingrain' },
    { value:'aqua-ring', label:'Aqua Ring' },
    { value:'focusenergy', label:'Focus Energy' },
    { value:'curse', label:'Curse' },
    { value:'perishsong', label:'Perish Song', properties:[{value:'duration',label:'Turns remaining'}] },
    { value:'magnetrise', label:'Magnet Rise', properties:[{value:'duration',label:'Duration'}] },
    { value:'telekinesis', label:'Telekinesis', properties:[{value:'duration',label:'Duration'}] },
    { value:'trapped', label:'Trapped' },
    { value:'bound', label:'Bound', properties:[{value:'duration',label:'Duration'},{value:'turns',label:'Turns remaining'}] },
    { value:'saltcure', label:'Salt Cure' },
    { value:'nightmare', label:'Nightmare' },
    { value:'aquaring', label:'Aqua Ring' },
    { value:'abilitysuppression', label:'Ability Suppression' },
    { value:'custom', label:'Custom volatile / effect' }
];
const VOLATILE_PROPERTY_OPTIONS = [
    {value:'exists',label:'Exists / is active'},
    {value:'layers',label:'Stacks / layers'},
    {value:'duration',label:'Duration'},
    {value:'turns',label:'Turns remaining'},
    {value:'counter',label:'Counter'},
    {value:'value',label:'Value'},
    {value:'custom',label:'Custom property'}
];
function volatilePropertyOptions(effectId) {
    const effect = VOLATILES.find(v => v.value === effectId);
    const specific = effect?.properties || [];
    const merged = [...specific];
    for (const option of VOLATILE_PROPERTY_OPTIONS) {
        if (!merged.some(x => x.value === option.value)) merged.push(option);
    }
    return merged;
}
const TERRAIN = [
    { value: 'Electric', label: 'Electric Terrain' }, { value: 'Grassy', label: 'Grassy Terrain' },
    { value: 'Misty', label: 'Misty Terrain' }, { value: 'Psychic', label: 'Psychic Terrain' }
];
const HAZARDS = [
    { value: 'toxicspikes', label: 'Toxic Spikes' }, { value: 'spikes', label: 'Spikes' },
    { value: 'stealthrock', label: 'Stealth Rock' }, { value: 'stickyweb', label: 'Sticky Web' }
];
const VALUE_REFS = [
    { value:'hp', label:'HP' }, { value:'maxhp', label:'Max HP' }, { value:'damage', label:'Damage Taken' },
    { value:'turn', label:'Turn Number' }, { value:'random', label:'Random Number' }, { value:'movePower', label:'Move Power' },
    { value:'statStage', label:'Stat Stage' }, { value:'status', label:'Status' }
];
const AMOUNT_BASES = [
    { value:'maxhp', label:'Max HP' },
    { value:'hp', label:'Current HP' },
    { value:'missinghp', label:'Missing HP' },
    { value:'damageTaken', label:'Damage Taken' }
];
const DAMAGE_AMOUNTS = [
    {value:'16',label:'1/16 max HP'},{value:'10',label:'1/10 max HP'},{value:'8',label:'1/8 max HP'},
    {value:'4',label:'1/4 max HP'},{value:'2',label:'1/2 max HP'},{value:'1',label:'Full max HP'}
];
function amountExpression(targetVar, params, ctx) {
    const pct = Number(params.percent);
    const n = Number.isFinite(pct) ? pct : 10;
    const basis = params.basis || 'maxhp';
    if (basis === 'hp') return `${targetVar}.hp * ${n} / 100`;
    if (basis === 'missinghp') return `(${targetVar}.maxhp - ${targetVar}.hp) * ${n} / 100`;
    if (basis === 'damageTaken') return `(damage || 0) * ${n} / 100`;
    return `${targetVar}.maxhp * ${n} / 100`;
}

// ==================== triggers (hat blocks) ====================
// sd()/es() return the shape codegen needs for that language: which
// callback/handler this is, what the in-scope variable names are, and any
// fixed pre/post lines the trigger itself requires.
import { mountIsland, unmountIsland } from '../react/island.jsx';
import { AbilityPalette } from '../react/AbilityPalette.jsx';
import { BlockBoard } from '../react/BlockBoard.jsx';
import { buildContainerRegistry, ensureBlockPosition } from './ability-board-model.js';

const TRIGGERS = {
    switchIn: {
        label: 'This Pokémon switches in', icon: 'log-in', kinds: ['ability', 'item'], params: [],
        allowed: ['boostStat', 'dealDamage', 'healDamage', 'setStatus', 'cureStatus', 'setWeather', 'setTerrain', 'changeType', 'addVolatile', 'removeVolatile', 'setShield', 'showMessage'],
        sd: () => ({ header: 'onStart(pokemon) {', footer: '}', selfVar: 'pokemon', foeVar: 'foe', moveVar: null, preamble: 'const foe = pokemon.side.foe.active[0];' }),
        es: () => ({ adder: 'Battle::AbilityEffects::OnSwitchIn', args: 'ability, battler', selfVar: 'battler', foeVar: 'foe', moveVar: null, preamble: 'foe = battler.pbDirectOpposing rescue nil', footer: null })
    },
    statModify: {
        label: 'Calculating one of this Pokémon\u2019s stats', icon: 'trending-up', kinds: ['ability', 'item'],
        params: [{ key: 'stat', label: 'Stat', type: 'select', options: STATS.map(s => ({ value: s.id, label: s.label })), default: 'atk' }],
        allowed: ['multiplyStat', 'boostStat', 'healDamage', 'setStatus', 'showMessage'],
        sd: (ast) => ({ header: `onModify${cap(ast.triggerParams.stat || 'atk')}(value, pokemon, target, move) {`, footer: 'return value;\n\t\t}', selfVar: 'pokemon', foeVar: 'target', moveVar: 'move', preamble: '' }),
        es: (ast) => ({ adder: 'Battle::AbilityEffects::StatCalcFromAbility', args: 'ability, battler, stat, stageMul, stageDiv, value', selfVar: 'battler', foeVar: 'nil', moveVar: null, preamble: `next value if stat != :${STAT_ESSENTIALS[ast.triggerParams.stat || 'atk']}`, footer: 'next value' })
    },
    damagingHit: {
        label: 'This Pokémon is hit by a damaging move', icon: 'sword', kinds: ['ability', 'item'], params: [],
        allowed: ['boostStat', 'dealDamage', 'healDamage', 'setStatus', 'cureStatus', 'changeType', 'addVolatile', 'removeVolatile', 'setShield', 'showMessage'],
        sd: () => ({ header: 'onDamagingHit(damage, target, source, move) {', footer: '}', selfVar: 'target', foeVar: 'source', moveVar: 'move', preamble: '' }),
        es: () => ({ adder: 'Battle::AbilityEffects::AfterMoveUseFromTarget', args: 'ability, user, target, move, switchedBattlers, hpLost', selfVar: 'target', foeVar: 'user', moveVar: 'move', preamble: '', footer: null })
    },
    residual: {
        label: 'The end of each turn', icon: 'clock', kinds: ['ability', 'item'], params: [],
        allowed: ['boostStat', 'dealDamage', 'healDamage', 'setWeather', 'setTerrain', 'setStatus', 'cureStatus', 'changeType', 'addVolatile', 'removeVolatile', 'showMessage'],
        sd: () => ({ header: 'onResidual(pokemon) {', footer: '}', selfVar: 'pokemon', foeVar: 'foe', moveVar: null, preamble: 'const foe = pokemon.side.foe.active[0];' }),
        es: () => ({ adder: 'Battle::AbilityEffects::EndOfRoundEffect', args: 'ability, battler', selfVar: 'battler', foeVar: 'foe', moveVar: null, preamble: 'foe = battler.pbDirectOpposing rescue nil', footer: null })
    },
    moveImmunity: {
        label: 'This Pokémon is hit by a move of a chosen type', icon: 'shield', kinds: ['ability', 'item'],
        params: [{ key: 'type', label: 'Move Type', type: 'select', options: POKEMON_TYPES.map(t => ({ value: t, label: t })), default: 'Electric' }],
        allowed: ['boostStat', 'healDamage', 'setStatus', 'cureStatus', 'changeType', 'addVolatile', 'removeVolatile', 'showMessage'],
        sd: (ast) => ({ header: `onTryHit(target, source, move) {\n\t\t\tif (move.type !== '${ast.triggerParams.type || 'Electric'}') return;`, footer: 'return null;\n\t\t}', selfVar: 'target', foeVar: 'source', moveVar: 'move', preamble: '' }),
        es: (ast) => ({ adder: 'Battle::AbilityEffects::MoveImmunity', args: 'ability, user, target, move', selfVar: 'target', foeVar: 'user', moveVar: 'move', preamble: `next false if move.type != :${(ast.triggerParams.type || 'ELECTRIC').toUpperCase()}`, footer: 'next true' })
    },
    switchOut: {
        label: 'This Pokémon switches out', icon: 'log-out', kinds: ['ability', 'item'], params: [],
        allowed: ['healDamage', 'cureStatus', 'boostStat', 'showMessage', 'restoreItem'],
        sd: () => ({ header: 'onSwitchOut(pokemon) {', footer: '}', selfVar: 'pokemon', foeVar: 'foe', moveVar: null, preamble: 'const foe = pokemon.side.foe.active[0];' }),
        es: () => ({ adder: 'Battle::AbilityEffects::OnSwitchOut', args: 'ability, battler, endOfBattle', selfVar: 'battler', foeVar: 'nil', moveVar: null, preamble: '', footer: null })
    },
    turnStart: {
        label: 'The start of each turn', icon: 'play', kinds: ['ability', 'item'], params: [],
        allowed: ['boostStat', 'dealDamage', 'healDamage', 'setStatus', 'cureStatus', 'setWeather', 'setTerrain', 'addVolatile', 'removeVolatile', 'showMessage'],
        sd: () => ({ header: 'onBeforeTurn(pokemon) {', footer: '}', selfVar: 'pokemon', foeVar: 'foe', moveVar: null, preamble: 'const foe = pokemon.side.foe.active[0];' }),
        es: () => ({ adder: 'Battle::AbilityEffects::StartOfRoundEffect', args: 'ability, battler', selfVar: 'battler', foeVar: 'nil', moveVar: null, preamble: '', footer: null })
    },
    beforeMove: {
        label: 'Just before this Pokémon moves', icon: 'chevrons-right', kinds: ['ability', 'item'], params: [],
        allowed: ['boostStat', 'healDamage', 'setStatus', 'cureStatus', 'changeType', 'addVolatile', 'removeVolatile', 'showMessage'],
        sd: () => ({ header: 'onBeforeMove(pokemon, target, move) {', footer: '}', selfVar: 'pokemon', foeVar: 'target', moveVar: 'move', preamble: '' }),
        es: () => ({ adder: 'Battle::AbilityEffects::OnStartUsingMove', args: 'ability, user, move, battle', selfVar: 'user', foeVar: 'nil', moveVar: 'move', preamble: '', footer: null })
    },
    afterMove: {
        label: 'Just after this Pokémon moves', icon: 'chevrons-left', kinds: ['ability', 'item'], params: [],
        allowed: ['boostStat', 'dealDamage', 'healDamage', 'setStatus', 'cureStatus', 'addVolatile', 'removeVolatile', 'switchPokemon', 'showMessage'],
        sd: () => ({ header: 'onAfterMove(pokemon, target, move) {', footer: '}', selfVar: 'pokemon', foeVar: 'target', moveVar: 'move', preamble: '' }),
        es: () => ({ adder: 'Battle::AbilityEffects::OnEndUsingMove', args: 'ability, user, targets, move, battle', selfVar: 'user', foeVar: 'nil', moveVar: 'move', preamble: '', footer: null })
    },
    onContact: {
        label: 'This Pokémon is hit by a contact move', icon: 'hand', kinds: ['ability', 'item'], params: [],
        allowed: ['boostStat', 'dealDamage', 'healDamage', 'setStatus', 'addVolatile', 'showMessage'],
        sd: () => ({ header: 'onDamagingHit(damage, target, source, move) {\n\t\t\tif (!move.flags[\'contact\']) return;', footer: '}', selfVar: 'target', foeVar: 'source', moveVar: 'move', preamble: '' }),
        es: () => ({ adder: 'Battle::AbilityEffects::AfterMoveUseFromTarget', args: 'ability, user, target, move, switchedBattlers, hpLost', selfVar: 'target', foeVar: 'user', moveVar: 'move', preamble: 'next if !move.contactMove?', footer: null })
    },
    onFaint: {
        label: 'This Pokémon faints', icon: 'skull', kinds: ['ability', 'item'], params: [],
        allowed: ['dealDamage', 'setWeather', 'setTerrain', 'boostStat', 'showMessage'],
        sd: () => ({ header: 'onFaint(pokemon) {', footer: '}', selfVar: 'pokemon', foeVar: 'foe', moveVar: null, preamble: 'const foe = pokemon.side.foe.active[0];' }),
        es: () => ({ adder: 'Battle::AbilityEffects::OnBeingHit', args: 'ability, user, target, move, battle', selfVar: 'target', foeVar: 'user', moveVar: 'move', preamble: 'next if !target.fainted?', footer: null })
    },
    onStatus: {
        label: 'This Pokémon is given a status', icon: 'alert-circle', kinds: ['ability', 'item'], params: [],
        allowed: ['cureStatus', 'boostStat', 'healDamage', 'showMessage'],
        sd: () => ({ header: 'onAfterSetStatus(status, target, source, effect) {', footer: '}', selfVar: 'target', foeVar: 'source', moveVar: null, preamble: '' }),
        es: () => ({ adder: 'Battle::AbilityEffects::OnStatusInflicted', args: 'ability, battler, user, status', selfVar: 'battler', foeVar: 'user', moveVar: null, preamble: '', footer: null })
    },
    moveUsed: {
        label: 'This move finishes being used', icon: 'zap', kinds: ['move'],
        allowed: ['boostStat', 'dealDamage', 'healDamage', 'setStatus', 'cureStatus', 'setWeather', 'setTerrain', 'addVolatile', 'removeVolatile', 'switchPokemon', 'showMessage', 'customCode'],
        sd: () => ({ header: 'onAfterMove(source, target, move) {', footer: '}', selfVar: 'source', foeVar: 'target', moveVar: 'move', preamble: '' }),
        es: () => ({ adder: 'Battle::MoveEffects::AfterMoveUse', args: 'move, user, targets, battle', selfVar: 'user', foeVar: 'targets[0]', moveVar: 'move', preamble: '', footer: null })
    },
    moveHit: {
        label: 'This move connects', icon: 'target', kinds: ['move'],
        allowed: ['boostStat', 'dealDamage', 'healDamage', 'setStatus', 'cureStatus', 'addVolatile', 'removeVolatile', 'setHazard', 'showMessage', 'customCode'],
        sd: () => ({ header: 'onHit(target, source, move) {', footer: '}', selfVar: 'source', foeVar: 'target', moveVar: 'move', preamble: '' }),
        es: () => ({ adder: 'Battle::MoveEffects::OnHit', args: 'move, user, target, battle', selfVar: 'user', foeVar: 'target', moveVar: 'move', preamble: '', footer: null })
    },
    accuracyModify: {
        label: 'Working out whether a move lands', icon: 'crosshair', kinds: ['ability', 'item'],
        params: [{ key: 'role', label: 'This Pokémon is', type: 'select', options: [
            { value: 'user', label: 'the one attacking' },
            { value: 'target', label: 'the one being aimed at' }
        ], default: 'user' }],
        allowed: ['multiplyAccuracy', 'showMessage'],
        sd: (ast) => (ast.triggerParams.role || 'user') === 'user'
            ? { header: 'onSourceModifyAccuracy(accuracy, target, source, move) {\n\t\t\tif (typeof accuracy !== \'number\') return accuracy;', footer: 'return accuracy;\n\t\t}', selfVar: 'source', foeVar: 'target', moveVar: 'move', preamble: '' }
            : { header: 'onModifyAccuracy(accuracy, target, source, move) {\n\t\t\tif (typeof accuracy !== \'number\') return accuracy;', footer: 'return accuracy;\n\t\t}', selfVar: 'target', foeVar: 'source', moveVar: 'move', preamble: '' },
        es: (ast) => (ast.triggerParams.role || 'user') === 'user'
            ? { adder: 'Battle::AbilityEffects::AccuracyCalcFromUser', args: 'ability, mods, user, target, move, type', selfVar: 'user', foeVar: 'target', moveVar: 'move', preamble: '', footer: null }
            : { adder: 'Battle::AbilityEffects::AccuracyCalcFromTarget', args: 'ability, mods, user, target, move, type', selfVar: 'target', foeVar: 'user', moveVar: 'move', preamble: '', footer: null }
    },
    statStageIgnore: {
        label: 'Counting stat stages in a damage roll', icon: 'eye-off', kinds: ['ability', 'item'],
        params: [
            { key: 'whose', label: 'Whose stages', type: 'select', options: [
                { value: 'foe', label: 'the other Pokémon\u2019s (Unaware)' },
                { value: 'self', label: 'this Pokémon\u2019s own' }
            ], default: 'foe' },
            { key: 'role', label: 'Which stages', type: 'select', options: [
                { value: 'any', label: 'all of them' },
                { value: 'offensive', label: 'attacking stats only' },
                { value: 'defensive', label: 'defending stats only' },
                { value: 'evasion', label: 'evasion only' }
            ], default: 'any' }
        ],
        allowed: ['ignoreStatStages', 'showMessage'],
        sd: (ast) => {
            const own = (ast.triggerParams.whose || 'foe') === 'self';
            return {
                // Showdown has no single "ignore stages" switch; Unaware is
                // written as onAnyModifyBoost, and this mirrors that shape
                header: `onAnyModifyBoost(boosts, pokemon) {\n\t\t\tconst holder = this.effectState.target;\n\t\t\tif (${own ? 'pokemon !== holder' : 'pokemon === holder'}) return;`,
                footer: '}', selfVar: 'holder', foeVar: 'pokemon', moveVar: null, preamble: ''
            };
        },
        es: (ast) => ({
            adder: 'Battle::AbilityEffects::DamageCalcFromTarget',
            args: 'ability, user, target, move, mults, baseDmg, type',
            selfVar: 'target', foeVar: 'user', moveVar: 'move',
            // Essentials hardcodes Unaware inside pbCalcDamage rather than
            // exposing a hook, so this is a starting point, not a drop-in
            preamble: '# NOTE: Essentials handles ignored stat stages inside pbCalcDamage.',
            footer: null
        })
    },
    // The -ate family: Pixilate, Aerilate, Refrigerate, Galvanize, Normalize.
    // All five are one hook -- rewrite a move's type as it is being used --
    // plus the 20% power bump that came with them in Gen 6.
    moveTypeChange: {
        label: 'This Pok\u00e9mon uses a move of a chosen type', icon: 'shuffle', kinds: ['ability', 'item'],
        params: [{ key: 'from', label: 'Move Type', type: 'select', options: [{ value: 'any', label: 'any type' }, ...TYPES], default: 'Normal' }],
        allowed: ['setMoveType', 'multiplyMovePower', 'setMovePower', 'multiplyDamage', 'showMessage'],
        sd: (ast) => {
            const from = ast.triggerParams.from || 'Normal';
            const guard = from === 'any' ? '' : `\n\t\t\tif (move.type !== '${from}') return;`;
            return { header: `onModifyType(move, pokemon, target) {${guard}`, footer: '}', selfVar: 'pokemon', foeVar: 'target', moveVar: 'move', preamble: '' };
        },
        es: (ast) => {
            const from = ast.triggerParams.from || 'Normal';
            return {
                adder: 'Battle::AbilityEffects::ModifyMoveBaseType', args: 'ability, user, move, type',
                selfVar: 'user', foeVar: 'nil', moveVar: 'move',
                // setMoveType writes `newType` rather than answering with
                // `next :TYPE` -- Ruby's next returns there and then, so
                // answering mid-body made every block after it unreachable.
                preamble: (from === 'any' ? '' : `next type if type != :${from.toUpperCase()}
    `) + 'newType = type',
                footer: 'next newType'
            };
        }
    },
    // Storm Drain, Lightning Rod, Sap Sipper, Motor Drive: a move of the named
    // type is pulled onto this Pok\u00e9mon and absorbed instead of landing.
    // A singles battle has no ally to pull it away from, so the sim runs the
    // absorbing half; the exported code carries the redirection with it.
    // The unopinionated version of moveImmunity/drawIn: the hook itself, with
    // no type baked in and nothing decided. Pair it with the `if` blocks and
    // the move-property checks to say which moves it should care about, and
    // with "absorb"/"draw in" to say what happens. Storm Drain built by hand
    // is: this event -> if move property type is Water -> raise Sp. Atk, absorb.
    moveIncoming: {
        label: 'A move is about to hit this Pok\u00e9mon', icon: 'shield-alert', kinds: ['ability', 'item'], params: [],
        allowed: ['absorbMove', 'redirectMove', 'boostStat', 'healDamage', 'dealDamage', 'setStatus',
                  'cureStatus', 'changeType', 'addVolatile', 'removeVolatile', 'setShield', 'showMessage'],
        sd: () => ({
            header: 'onTryHit(target, source, move) {',
            // no trailing `return null` -- whether the move is absorbed is the
            // body's decision here, which is the whole point of this event
            footer: '}', selfVar: 'target', foeVar: 'source', moveVar: 'move', preamble: ''
        }),
        es: () => ({
            adder: 'Battle::AbilityEffects::MoveImmunity', args: 'ability, user, target, move',
            selfVar: 'target', foeVar: 'user', moveVar: 'move', preamble: '', footer: 'next false'
        })
    },
    drawIn: {
        label: 'A move of a chosen type is drawn in by this Pok\u00e9mon', icon: 'magnet', kinds: ['ability'],
        params: [{ key: 'type', label: 'Move Type', type: 'select', options: TYPES, default: 'Water' }],
        allowed: ['boostStat', 'healDamage', 'cureStatus', 'addVolatile', 'removeVolatile', 'showMessage'],
        sd: (ast) => {
            const type = ast.triggerParams.type || 'Water';
            return {
                header: `onTryHit(target, source, move) {\n\t\t\tif (target === source || move.type !== '${type}') return;`,
                // The absorb and the redirect are one ability but two Showdown
                // hooks, so the second is emitted from the footer.
                footer: `return null;\n\t\t},\n\n\t\tonAnyRedirectTarget(target, source, source2, move) {\n\t\t\tif (move.type !== '${type}') return;\n\t\t\tconst holder = this.effectState.target;\n\t\t\tif (holder !== source && this.validTarget(holder, source, move.target)) return holder;\n\t\t}`,
                selfVar: 'target', foeVar: 'source', moveVar: 'move', preamble: ''
            };
        },
        es: (ast) => ({
            adder: 'Battle::AbilityEffects::MoveImmunity', args: 'ability, user, target, move',
            selfVar: 'target', foeVar: 'user', moveVar: 'move',
            // Essentials picks its target before abilities are consulted, so
            // the redirection half has no hook to bind to. The absorb ports.
            preamble: `next false if move.type != :${(ast.triggerParams.type || 'WATER').toUpperCase()}\n    # NOTE: Essentials has no redirection hook; this absorbs but does not pull.`,
            footer: 'next true'
        })
    },
    damageModify: {
        label: 'Calculating a move\u2019s damage', icon: 'percent', kinds: ['ability', 'item', 'move'],
        params: [{ key: 'direction', label: 'Direction', type: 'select', options: [{ value: 'dealing', label: 'This Pokémon is attacking' }, { value: 'receiving', label: 'This Pokémon is defending' }], default: 'dealing' }],
        allowed: ['multiplyDamage', 'dealDamage', 'boostStat', 'showMessage'],
        sd: (ast) => (ast.triggerParams.direction || 'dealing') === 'dealing'
            ? { header: 'onSourceModifyDamage(damage, source, target, move) {', footer: 'return damage;\n\t\t}', selfVar: 'source', foeVar: 'target', moveVar: 'move', preamble: '' }
            : { header: 'onModifyDamage(damage, source, target, move) {', footer: 'return damage;\n\t\t}', selfVar: 'target', foeVar: 'source', moveVar: 'move', preamble: '' },
        es: (ast) => (ast.triggerParams.direction || 'dealing') === 'dealing'
            ? { adder: 'Battle::AbilityEffects::DamageCalcFromUser', args: 'ability, user, target, move, mults, power, type', selfVar: 'user', foeVar: 'target', moveVar: 'move', preamble: '', footer: null }
            : { adder: 'Battle::AbilityEffects::DamageCalcFromTarget', args: 'ability, user, target, move, mults, baseDmg, type', selfVar: 'target', foeVar: 'user', moveVar: 'move', preamble: '', footer: null }
    }
};

// Older saved abilities (and the runtime's own trigger table) use a handful of
// alternative keys for the same events. They are kept as aliases so nothing
// already built is silently dropped by normalizeAbilityBlocks(); they simply do
// not appear in the palette, which offers the canonical name instead.
const TRIGGER_ALIASES = {
    battleStart: 'switchIn',
    switchInOut: 'switchIn',
    turnStartEnd: 'residual',
    onMove: 'afterMove',
    onDamage: 'damagingHit',
    onDamagingHit: 'damagingHit',
    onCriticalHit: 'damagingHit'
};
for (const [alias, target] of Object.entries(TRIGGER_ALIASES)) {
    if (!TRIGGERS[alias] && TRIGGERS[target]) TRIGGERS[alias] = { ...TRIGGERS[target], alias: target };
}

// ==================== conditions (for "if" blocks) ====================
const CONDITIONS = {
    hpBelow: {
        label: 'health is below __%', params: [{ key: 'value', type: 'number', default: 50, min: 1, max: 99 }],
        sd: (c, p) => `${c.selfVar}.hp <= ${c.selfVar}.maxhp * ${(p.value / 100).toFixed(2)}`,
        es: (c, p) => `${c.selfVar}.hp <= (${c.selfVar}.totalhp * ${p.value} / 100.0)`
    },
    hpAbove: {
        label: 'health is above __%', params: [{ key: 'value', type: 'number', default: 50, min: 1, max: 99 }],
        sd: (c, p) => `${c.selfVar}.hp > ${c.selfVar}.maxhp * ${(p.value / 100).toFixed(2)}`,
        es: (c, p) => `${c.selfVar}.hp > (${c.selfVar}.totalhp * ${p.value} / 100.0)`
    },
    hasStatus: {
        label: 'status is __', params: [{ key: 'status', type: 'select', options: [...STATUSES.map(s => ({ value: s.id, label: s.label })), { value: 'none', label: 'No status' }], default: 'brn' }],
        sd: (c, p) => p.status === 'none' ? `!${c.selfVar}.status` : `${c.selfVar}.status === '${p.status}'`,
        es: (c, p) => { const s = STATUSES.find(x => x.id === p.status); return `${c.selfVar}.status == :${s ? s.es : 'NONE'}`; }
    },
    weatherIs: {
        label: 'the environment is __', params: [{ key: 'weather', type: 'select', options: WEATHERS.map(w => ({ value: w.id, label: w.label })), default: 'Sun' }],
        sd: (c, p) => { const w = WEATHERS.find(x => x.id === p.weather); return `this.field.isWeather('${w ? w.sd : 'sunnyday'}')`; },
        es: (c, p) => `$field.weather == :${p.weather}`
    },
    terrainIs: {
        label: 'the terrain is __', params: [{ key: 'terrain', type: 'select', options: TERRAIN, default: 'Electric' }],
        sd: (c, p) => `this.field.isTerrain('${String(p.terrain || 'Electric').toLowerCase()}terrain')`,
        es: (c, p) => `$field.terrain == :${p.terrain || 'Electric'}`
    },
    moveTypeIs: {
        label: 'move type is __', params: [{ key: 'type', type: 'select', options: POKEMON_TYPES.map(t => ({ value: t, label: t })), default: 'Fire' }],
        sd: (c, p) => `${c.moveVar || 'move'}.type === '${p.type}'`,
        es: (c, p) => `${c.moveVar || 'move'}.type == :${p.type.toUpperCase()}`
    },
    moveCategoryIs: {
        label: 'move category is __', params: [{ key: 'category', type: 'select', options: [{ value: 'Physical', label: 'Physical' }, { value: 'Special', label: 'Special' }, { value: 'Status', label: 'Status' }], default: 'Physical' }],
        sd: (c, p) => `${c.moveVar || 'move'}.category === '${p.category}'`,
        es: (c, p) => p.category === 'Physical' ? `${c.moveVar || 'move'}.physicalMove?` : p.category === 'Special' ? `${c.moveVar || 'move'}.specialMove?` : `${c.moveVar || 'move'}.statusMove?`
    },
    moveMakesContact: {
        label: 'move has the contact flag', params: [],
        sd: (c) => `${c.moveVar || 'move'}.flags['contact']`,
        es: (c) => `${c.moveVar || 'move'}.contactMove?`
    },
    selfIsType: {
        label: 'type is __', params: [{ key: 'type', type: 'select', options: POKEMON_TYPES.map(t => ({ value: t, label: t })), default: 'Fire' }],
        sd: (c, p) => `${c.selfVar}.hasType('${p.type}')`,
        es: (c, p) => `${c.selfVar}.pbHasType?(:${p.type.toUpperCase()})`
    },
    randomChance: {
        label: 'random chance is __%', params: [{ key: 'value', type: 'number', default: 30, min: 1, max: 100 }],
        sd: (c, p) => `this.randomChance(${p.value}, 100)`,
        es: (c, p) => `battle.pbRandom(100) < ${p.value}`
    },
    randomChance: {
        label: 'random chance is __%', params: [{ key: 'value', type: 'number', default: 50, min: 1, max: 100 }],
        sd: (c, p) => `this.randomChance(${p.value}, 100)`,
        es: (c, p) => `rand(100) < ${p.value}`
    },
    turnAtLeast: {
        label: 'turn is at least __', params: [{ key: 'value', type: 'number', default: 1, min: 0, max: 999 }],
        sd: (c, p) => `this.turn >= ${p.value}`,
        es: (c, p) => `$battle.turnCount >= ${p.value}`
    },
    statStageAtLeast: {
        label: 'stat stage of __ is at least __', params: [
            { key: 'stat', type: 'select', options: STATS.map(s => ({ value: s.id, label: s.label })), default: 'atk' },
            { key: 'value', type: 'number', default: 1, min: -6, max: 6 }
        ],
        sd: (c, p) => `${c.selfVar}.boosts.${p.stat} >= ${p.value}`,
        es: (c, p) => `${c.selfVar}.statStages[:${STAT_ESSENTIALS[p.stat] || 'ATTACK'}] >= ${p.value}`
    },
    targetHasStatus: {
        label: 'target status is __', params: [{ key: 'status', type: 'select', options: [...STATUSES.map(s => ({ value: s.id, label: s.label })), { value: 'none', label: 'No status' }], default: 'brn' }],
        sd: (c, p) => p.status === 'none' ? `!${c.foeVar}.status` : `${c.foeVar}.status === '${p.status}'`,
        es: (c, p) => p.status === 'none' ? `${c.foeVar}.status == :NONE` : `${c.foeVar}.status == :${(STATUSES.find(s => s.id === p.status)?.es || 'BURN')}`
    },
    movePowerAtLeast: {
        label: 'move power is at least __', params: [{ key: 'value', type: 'number', default: 60, min: 0, max: 1000 }],
        sd: (c, p) => `${c.moveVar || 'move'}.basePower >= ${p.value}`,
        es: (c, p) => `${c.moveVar || 'move'}.power >= ${p.value}`
    },
    movePowerAtMost: {
        label: 'move power is at most __', params: [{ key: 'value', type: 'number', default: 60, min: 0, max: 1000 }],
        sd: (c, p) => `${c.moveVar || 'move'}.basePower <= ${p.value}`,
        es: (c, p) => `${c.moveVar || 'move'}.power <= ${p.value}`
    },
    movePriorityIs: {
        label: 'move priority is __', params: [{ key: 'value', type: 'number', default: 0, min: -7, max: 7 }],
        sd: (c, p) => `${c.moveVar || 'move'}.priority === ${Number(p.value) || 0}`,
        es: (c, p) => `${c.moveVar || 'move'}.priority == ${Number(p.value) || 0}`
    },
    movePriorityAtLeast: {
        label: 'move priority is at least __', params: [{ key: 'value', type: 'number', default: 1, min: -7, max: 7 }],
        sd: (c, p) => `${c.moveVar || 'move'}.priority >= ${Number(p.value) || 0}`,
        es: (c, p) => `${c.moveVar || 'move'}.priority >= ${Number(p.value) || 0}`
    },
    moveAccuracyAtLeast: {
        label: 'move accuracy is at least __%', params: [{ key: 'value', type: 'number', default: 90, min: 1, max: 100 }],
        sd: (c, p) => `typeof ${c.moveVar || 'move'}.accuracy === 'number' && ${c.moveVar || 'move'}.accuracy >= ${Number(p.value) || 0}`,
        es: (c, p) => `${c.moveVar || 'move'}.accuracy && ${c.moveVar || 'move'}.accuracy >= ${Number(p.value) || 0}`
    },
    moveHasRecoil: {
        label: 'move has recoil', params: [],
        sd: c => `!!${c.moveVar || 'move'}.recoil`,
        es: c => `(${c.moveVar || 'move'}.recoil && ${c.moveVar || 'move'}.recoil > 0)`
    },
    moveHasDrain: {
        label: 'move has drain/healing', params: [],
        sd: c => `!!${c.moveVar || 'move'}.drain`,
        es: c => `(${c.moveVar || 'move'}.drain && ${c.moveVar || 'move'}.drain > 0)`
    },
    moveHasSecondary: {
        label: 'move has a secondary effect', params: [],
        sd: c => `Array.isArray(${c.moveVar || 'move'}.secondaries) && ${c.moveVar || 'move'}.secondaries.length > 0`,
        es: c => `!!${c.moveVar || 'move'}.additionalEffect`
    },
    moveCritRatioAtLeast: {
        label: 'move critical-hit ratio is at least __', params: [{ key: 'value', type: 'number', default: 1, min: 0, max: 5 }],
        sd: (c, p) => `${c.moveVar || 'move'}.critRatio >= ${Number(p.value) || 0}`,
        es: c => `${c.moveVar || 'move'}.highCriticalRate?`
    },
    moveTargetIs: {
        label: 'move target is __', params: [{ key: 'target', type: 'text', default: 'normal' }],
        sd: (c, p) => `${c.moveVar || 'move'}.target === '${String(p.target || 'normal').replace(/'/g, "\\'")}'`,
        es: (c, p) => `${c.moveVar || 'move'}.target == :${String(p.target || 'normal').toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`
    },
    moveNameIs: {
        label: 'move name/id is __', params: [{ key: 'value', type: 'text', default: 'tackle' }],
        sd: (c, p) => {
            const value = String(p.value || 'tackle').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
            return `${c.moveVar || 'move'}.id === '${value}'`;
        },
        es: (c, p) => {
            const value = String(p.value || 'tackle').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
            return `${c.moveVar || 'move'}.id == :${value}`;
        }
    },
    stockpileStacksAtLeast: {
        label: 'stockpile stacks are at least __ on __', params: [
            { key: 'value', type: 'number', default: 1, min: 0, max: 3 },
            { key: 'target', type: 'select', options: TARGETS, default: 'self' }
        ],
        sd: (c, p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return `(${t}.volatiles['stockpile']?.layers || 0) >= ${Number(p.value) || 0}`;
        },
        es: (c, p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return `(${t}.effects[PBEffects::Stockpile] || 0) >= ${Number(p.value) || 0}`;
        }
    },
    stockpileStacksExactly: {
        label: 'stockpile stacks are exactly __ on __', params: [
            { key: 'value', type: 'number', default: 1, min: 0, max: 3 },
            { key: 'target', type: 'select', options: TARGETS, default: 'self' }
        ],
        sd: (c, p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return `(${t}.volatiles['stockpile']?.layers || 0) === ${Number(p.value) || 0}`;
        },
        es: (c, p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return `(${t}.effects[PBEffects::Stockpile] || 0) == ${Number(p.value) || 0}`;
        }
    },
    hasVolatile: {
        label: '__ has volatile effect __', params: [
            { key: 'volatile', type: 'select', options: VOLATILES, default: 'stockpile' },
            { key: 'target', type: 'select', options: TARGETS, default: 'self' }
        ],
        sd: (c, p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            const v = String(p.volatile || 'stockpile').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
            return `!!${t}.volatiles['${v}']`;
        },
        es: (c, p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            const v = String(p.volatile || 'stockpile').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
            return `!!${t}.effects[PBEffects::${v}]`;
        }
    }

};

// ==================== generalized battle-effect / move inspection ====================
// These blocks deliberately accept a custom property/effect id so the editor is
// not tied to a short hard-coded list. The generated code follows the native
// Showdown / Essentials object models as far as this starter-code generator can.
const MOVE_PROPERTY_OPTIONS = [
    {value:'id',label:'Move ID / name'},
    {value:'type',label:'Type'},
    {value:'category',label:'Category'},
    {value:'basePower',label:'Base Power'},
    {value:'accuracy',label:'Accuracy'},
    {value:'priority',label:'Priority'},
    {value:'target',label:'Target'},
    {value:'critRatio',label:'Critical-hit ratio'},
    {value:'flags.contact',label:'Contact flag'},
    {value:'flags.sound',label:'Sound flag'},
    {value:'flags.bite',label:'Bite flag'},
    {value:'flags.punch',label:'Punch flag'},
    {value:'flags.pulse',label:'Pulse flag'},
    {value:'flags.bullet',label:'Bullet flag'},
    {value:'flags.powder',label:'Powder flag'},
    {value:'flags.recharge',label:'Recharge flag'},
    {value:'flags.wind',label:'Wind flag'},
    {value:'flags.heal',label:'Heal flag'},
    {value:'flags.protect',label:'Protect flag'},
    {value:'flags.reflectable',label:'Reflectable flag'},
    {value:'flags.defrost',label:'Defrost flag'},
    {value:'flags.dance',label:'Dance flag'}
];
const BATTLE_EFFECT_PROPERTIES = VOLATILE_PROPERTY_OPTIONS;
const BATTLE_EFFECT_OPS = [
    {value:'==',label:'='},{value:'!=',label:'!='},{value:'>',label:'>'},
    {value:'<',label:'<'},{value:'>=',label:'>='},{value:'<=',label:'<='}
];
const BATTLE_EFFECT_TARGETS = TARGETS;
// The sdHandler templates below need real tabs and newlines in their output;
// this keeps those escapes out of the template literals themselves.
function tokNL(text) {
    return text.replace(/@NL@/g, '\n').replace(/@T3@/g, '\t\t\t').replace(/@T2@/g, '\t\t');
}

function safeEffectId(value) {
    return String(value || 'customEffect').trim().replace(/[^A-Za-z0-9_:-]/g, '');
}
function safeProperty(value) {
    return String(value || 'value').trim().replace(/[^A-Za-z0-9_$]/g, '');
}
function movePropertyExpression(c, p, lang) {
    const m = c.moveVar || 'move';
    const prop = String(p.property || 'basePower');
    if (lang === 'sd') {
        if (prop.startsWith('flags.')) return `${m}.flags?.['${prop.slice(6)}']`;
        if (prop === 'id') return `${m}.id`;
        return `${m}.${prop}`;
    }
    if (prop.startsWith('flags.')) return `${m}.flags[${JSON.stringify(prop.slice(6)).toUpperCase()}]`;
    if (prop === 'id') return `${m}.id`;
    return `${m}.${prop}`;
}
function battleEffectExpression(c, p, lang) {
    const t = p.target === 'foe' ? c.foeVar : c.selfVar;
    const id = safeEffectId(p.effect);
    const prop = p.property === 'custom' ? safeProperty(p.customProperty) : (p.property || 'exists');
    if (lang === 'sd') {
        const base = `${t}.volatiles?.['${id}']`;
        return prop === 'exists' ? `!!${base}` : `${base}?.${prop}`;
    }
    const base = `${t}.effects[:${id.toUpperCase()}]`;
    return prop === 'exists' ? `!!${base}` : `${base}&.${prop}`;
}

// Anything about a Pokemon worth comparing a number against. The point of
// this list is that one block covers what would otherwise be twenty.
const POKEMON_PROPERTY_OPTIONS = [
    {value:'hp',label:'Current HP'},
    {value:'maxhp',label:'Max HP'},
    {value:'hpPercent',label:'HP (% of max)'},
    {value:'level',label:'Level'},
    {value:'weight',label:'Weight (kg)'},
    {value:'atk',label:'Attack (actual value)'},
    {value:'def',label:'Defense (actual value)'},
    {value:'spa',label:'Sp. Atk (actual value)'},
    {value:'spd',label:'Sp. Def (actual value)'},
    {value:'spe',label:'Speed (actual value)'},
    {value:'boost.atk',label:'Attack stage'},
    {value:'boost.def',label:'Defense stage'},
    {value:'boost.spa',label:'Sp. Atk stage'},
    {value:'boost.spd',label:'Sp. Def stage'},
    {value:'boost.spe',label:'Speed stage'},
    {value:'boost.accuracy',label:'Accuracy stage'},
    {value:'boost.evasion',label:'Evasion stage'},
    {value:'positiveBoosts',label:'Number of raised stats'},
    {value:'negativeBoosts',label:'Number of lowered stats'},
    {value:'movesMade',label:'Moves made since switching in'}
];

function pokemonPropertyExpression(c, p, lang) {
    const t = p.target === 'foe' ? c.foeVar : c.selfVar;
    const prop = String(p.property || 'hp');
    if (lang === 'sd') {
        if (prop.startsWith('boost.')) return `(${t}.boosts?.${prop.slice(6)} || 0)`;
        if (prop === 'hpPercent') return `(${t}.hp * 100 / ${t}.maxhp)`;
        if (prop === 'positiveBoosts') return `Object.values(${t}.boosts || {}).filter(v => v > 0).length`;
        if (prop === 'negativeBoosts') return `Object.values(${t}.boosts || {}).filter(v => v < 0).length`;
        if (prop === 'movesMade') return `(${t}.activeMoveActions || 0)`;
        if (['atk','def','spa','spd','spe'].includes(prop)) return `${t}.getStat('${prop}')`;
        if (prop === 'weight') return `${t}.getWeight()`;
        return `${t}.${prop}`;
    }
    const ES_STAT = { atk:'ATTACK', def:'DEFENSE', spa:'SPECIAL_ATTACK', spd:'SPECIAL_DEFENSE', spe:'SPEED',
                      accuracy:'ACCURACY', evasion:'EVASION' };
    if (prop.startsWith('boost.')) return `(${t}.stages[:${ES_STAT[prop.slice(6)] || 'ATTACK'}] || 0)`;
    if (prop === 'hpPercent') return `(${t}.hp * 100.0 / ${t}.totalhp)`;
    if (prop === 'positiveBoosts') return `${t}.stages.values.count { |v| v > 0 }`;
    if (prop === 'negativeBoosts') return `${t}.stages.values.count { |v| v < 0 }`;
    if (prop === 'movesMade') return `${t}.turnCount`;
    if (['atk','def','spa','spd','spe'].includes(prop)) return `${t}.${prop}`;
    if (prop === 'weight') return `${t}.pbWeight`;
    if (prop === 'maxhp') return `${t}.totalhp`;
    return `${t}.${prop}`;
}

Object.assign(CONDITIONS, {
    // ---- blanket checks ----
    // These exist so a new idea does not need a new block. One comparison
    // block over a list of properties covers what the hpBelow/statStageAtLeast
    // family covers one case at a time.
    alwaysTrue: {
        label: 'always', params: [],
        sd: () => 'true', es: () => 'true'
    },
    pokemonPropertyCompare: {
        label: '__ __ __ __', params: [
            {key:'target',type:'select',options:TARGETS,default:'self'},
            {key:'property',type:'select',options:POKEMON_PROPERTY_OPTIONS,default:'hpPercent'},
            {key:'op',type:'select',options:BATTLE_EFFECT_OPS,default:'<='},
            {key:'value',type:'number',default:50}
        ],
        sd: (c,p) => `(${pokemonPropertyExpression(c,p,'sd')}) ${p.op || '<='} (${Number(p.value) || 0})`,
        es: (c,p) => `(${pokemonPropertyExpression(c,p,'es')}) ${p.op || '<='} (${Number(p.value) || 0})`
    },
    isFasterThan: {
        label: '__ is faster than __', params: [
            {key:'target',type:'select',options:TARGETS,default:'self'},
            {key:'other',type:'select',options:TARGETS,default:'foe'}
        ],
        sd: (c,p) => {
            const a = p.target === 'foe' ? c.foeVar : c.selfVar;
            const b = p.other === 'foe' ? c.foeVar : c.selfVar;
            return `(${a}.getStat('spe') > ${b}.getStat('spe'))`;
        },
        es: (c,p) => {
            const a = p.target === 'foe' ? c.foeVar : c.selfVar;
            const b = p.other === 'foe' ? c.foeVar : c.selfVar;
            return `(${a}.spe > ${b}.spe)`;
        }
    },
    isType: {
        label: '__ is __ type', params: [
            {key:'target',type:'select',options:TARGETS,default:'self'},
            {key:'type',type:'select',options:TYPES,default:'Water'}
        ],
        sd: (c,p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return `${t}.hasType('${p.type || 'Water'}')`;
        },
        es: (c,p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return `${t}.pbHasType?(:${String(p.type || 'Water').toUpperCase()})`;
        }
    },
    hasAbility: {
        label: '__ has ability __', params: [
            {key:'target',type:'select',options:TARGETS,default:'foe'},
            {key:'ability',type:'text',default:'Levitate'}
        ],
        sd: (c,p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return `${t}.hasAbility('${toShowdownAbilityId(p.ability || '')}')`;
        },
        es: (c,p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return `${t}.hasActiveAbility?(:${String(p.ability || '').toUpperCase().replace(/[^A-Z0-9]/g, '')})`;
        }
    },
    hasItem: {
        label: '__ is holding __', params: [
            {key:'target',type:'select',options:TARGETS,default:'self'},
            {key:'item',type:'text',default:'Leftovers'}
        ],
        sd: (c,p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            const item = String(p.item || '').trim();
            return item ? `${t}.hasItem('${toShowdownAbilityId(item)}')` : `!!${t}.item`;
        },
        es: (c,p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            const item = String(p.item || '').trim();
            return item ? `${t}.hasActiveItem?(:${item.toUpperCase().replace(/[^A-Z0-9]/g, '')})` : `${t}.item`;
        }
    },
    movePropertyCompare: {
        label: 'move property __ __ __',
        params: [
            {key:'property',type:'select',options:MOVE_PROPERTY_OPTIONS,default:'basePower'},
            {key:'op',type:'select',options:BATTLE_EFFECT_OPS,default:'>='},
            {key:'value',type:'text',default:'60'}
        ],
        sd: (c,p) => `(${movePropertyExpression(c,p,'sd')}) ${p.op || '>='} (${p.value || '0'})`,
        es: (c,p) => `(${movePropertyExpression(c,p,'es')}) ${p.op || '>='} (${p.value || '0'})`
    },
    movePropertyIs: {
        label: 'move property __ is __',
        params: [
            {key:'property',type:'select',options:MOVE_PROPERTY_OPTIONS,default:'type'},
            {key:'value',type:'text',default:'Fire'}
        ],
        sd: (c,p) => `(${movePropertyExpression(c,p,'sd')}) === ${JSON.stringify(p.value || '')}`,
        es: (c,p) => `(${movePropertyExpression(c,p,'es')}) == :${String(p.value || '').toUpperCase()}`
    },
    battleEffectCompare: {
        label: '__ has volatile/effect __ property __ __ __',
        params: [
            {key:'target',type:'select',options:BATTLE_EFFECT_TARGETS,default:'self'},
            {key:'effect',type:'select',options:VOLATILES,default:'stockpile'},
            {key:'property',type:'dynamic-select',options:BATTLE_EFFECT_PROPERTIES,default:'exists',dynamic:'volatile-property'},
            {key:'customProperty',type:'text',default:'layers'},
            {key:'op',type:'select',options:BATTLE_EFFECT_OPS,default:'>='},
            {key:'value',type:'text',default:'1'}
        ],
        sd: (c,p) => `(${battleEffectExpression(c,p,'sd')}) ${p.op || '>='} (${p.value || 'true'})`,
        es: (c,p) => `(${battleEffectExpression(c,p,'es')}) ${p.op || '>='} (${p.value || 'true'})`
    },
    battleEffectActive: {
        label: '__ has volatile/effect __',
        params: [
            {key:'target',type:'select',options:BATTLE_EFFECT_TARGETS,default:'self'},
            {key:'effect',type:'select',options:VOLATILES,default:'stockpile'}
        ],
        sd: (c,p) => battleEffectExpression(c,{...p,property:'exists'},'sd'),
        es: (c,p) => battleEffectExpression(c,{...p,property:'exists'},'es')
    },
    battleEffectStacksAtLeast: {
        label: '__ has at least __ stack(s) of volatile/effect __',
        params: [
            {key:'target',type:'select',options:BATTLE_EFFECT_TARGETS,default:'self'},
            {key:'effect',type:'select',options:VOLATILES,default:'stockpile'},
            {key:'value',type:'number',default:1,min:0,max:99}
        ],
        sd: (c,p) => `(((${battleEffectExpression(c,{...p,property:'layers'},'sd')}) || 0) >= ${Number(p.value)||0})`,
        es: (c,p) => `(((${battleEffectExpression(c,{...p,property:'layers'},'es')}) || 0) >= ${Number(p.value)||0})`
    }
});

// ==================== actions ====================
const ACTIONS = {
    boostStat: {
        label: 'Change __ by __ stage(s) on __', params: [
            { key: 'stat', type: 'select', options: STATS.map(s => ({ value: s.id, label: s.label })), default: 'atk' },
            { key: 'stages', type: 'number', default: 1, min: -6, max: 6 },
            { key: 'target', type: 'select', options: TARGETS, default: 'self' }
        ],
        sd: (c, p) => { const t = p.target === 'foe' ? c.foeVar : c.selfVar; return [`this.boost({ ${p.stat}: ${p.stages} }, ${t});`]; },
        es: (c, p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar; const st = STAT_ESSENTIALS[p.stat] || 'ATTACK'; const up = Number(p.stages) >= 0;
            return [`if ${t} && ${t}.statStages[:${st}] ${up ? '<' : '>'} ${up ? 6 : -6}`,
                `  ${t}.statStages[:${st}] = [${t}.statStages[:${st}] + (${p.stages}), ${up ? 6 : -6}].${up ? 'min' : 'max'}`,
                `  battle.pbCommonAnimation("${up ? 'StatUp' : 'StatDown'}", ${t})`, 'end'];
        }
    },
    // boostStat above changes a STAGE (-6..+6); these two change the
    // underlying stat NUMBER itself, as Power Trick/Guard Split do
    setStatValue: {
        label: 'Set stat __ on __ to __', params: [
            { key: 'stat', type: 'select', options: STATS.map(s => ({ value: s.id, label: s.label })), default: 'atk' },
            { key: 'target', type: 'select', options: TARGETS, default: 'self' },
            { key: 'value', type: 'number', default: 100, min: 1 }
        ],
        sd: (c, p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return [`${t}.storedStats.${p.stat || 'atk'} = Math.max(1, ${Number(p.value) || 1});`];
        },
        es: (c, p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar; const st = STAT_ESSENTIALS[p.stat] || 'ATTACK';
            return [`${t}.stats[:${st}] = [${Number(p.value) || 1}, 1].max if ${t}`];
        }
    },
    changeStatValue: {
        label: 'Change stat __ on __ by __', params: [
            { key: 'stat', type: 'select', options: STATS.map(s => ({ value: s.id, label: s.label })), default: 'atk' },
            { key: 'target', type: 'select', options: TARGETS, default: 'self' },
            { key: 'mode', type: 'select', options: [{ value: 'percent', label: '% of its current value' }, { value: 'flat', label: 'flat points' }], default: 'percent' },
            { key: 'value', type: 'number', default: 50, step: 1 }
        ],
        sd: (c, p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar; const st = p.stat || 'atk'; const v = Number(p.value) || 0;
            const expr = p.mode === 'flat'
                ? `${t}.storedStats.${st} + (${v})`
                : `Math.floor(${t}.storedStats.${st} * (1 + (${v}) / 100))`;
            return [`${t}.storedStats.${st} = Math.max(1, ${expr});`];
        },
        es: (c, p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar; const st = STAT_ESSENTIALS[p.stat] || 'ATTACK'; const v = Number(p.value) || 0;
            const expr = p.mode === 'flat'
                ? `${t}.stats[:${st}] + (${v})`
                : `(${t}.stats[:${st}] * (1 + (${v}) / 100.0)).floor`;
            return [`${t}.stats[:${st}] = [${expr}, 1].max if ${t}`];
        }
    },
    dealDamage: {
        label: 'Change health by __% of __ on __', params: [
            { key: 'percent', type: 'number', default: 10, min: 0, max: 1000, step: 1 },
            { key: 'basis', type: 'select', options: AMOUNT_BASES, default: 'maxhp' },
            { key: 'target', type: 'select', options: TARGETS, default: 'foe' }
        ],
        sd: (c, p) => { const t = p.target === 'foe' ? c.foeVar : c.selfVar; return [`this.damage(${amountExpression(t,p,c)}, ${t}, ${c.selfVar});`]; },
        es: (c, p) => { const t = p.target === 'foe' ? c.foeVar : c.selfVar; return [`if ${t}`, `  battle.pbReduceHP(${t}, ${amountExpression(t,p,c)})`, `  battle.pbDisplay(_INTL("{1} was hurt!", ${t}.name))`, 'end']; }
    },
    healDamage: {
        label: 'Restore health by __% of __ on __', params: [
            { key: 'percent', type: 'number', default: 25, min: 0, max: 1000, step: 1 },
            { key: 'basis', type: 'select', options: AMOUNT_BASES, default: 'maxhp' },
            { key: 'target', type: 'select', options: TARGETS, default: 'self' }
        ],
        sd: (c, p) => { const t = p.target === 'foe' ? c.foeVar : c.selfVar; return [`this.heal(${amountExpression(t,p,c)}, ${t});`]; },
        es: (c, p) => { const t = p.target === 'foe' ? c.foeVar : c.selfVar; return [`${t}.pbRecoverHP(${amountExpression(t,p,c)}) if ${t}`]; }
    },
    setStatus: {
        label: 'Set status on __ to __', params: [
            { key: 'status', type: 'select', options: STATUSES.map(s => ({ value: s.id, label: s.label })), default: 'brn' },
            { key: 'target', type: 'select', options: TARGETS, default: 'foe' }
        ],
        sd: (c, p) => { const t = p.target === 'foe' ? c.foeVar : c.selfVar; return [`${t}.trySetStatus('${p.status}', ${c.selfVar});`]; },
        es: (c, p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar; const s = STATUSES.find(x => x.id === p.status);
            return [`if ${t} && ${t}.status == :NONE`, `  ${t}.status = :${s ? s.es : 'BURN'}`, `  ${t}.statusCount = 0`, `  battle.scene.pbRefreshOne(${t}.index) rescue nil`, 'end'];
        }
    },
    cureStatus: {
        label: 'Clear status on __', params: [{ key: 'target', type: 'select', options: TARGETS, default: 'self' }],
        sd: (c, p) => { const t = p.target === 'foe' ? c.foeVar : c.selfVar; return [`${t}.cureStatus();`]; },
        es: (c, p) => { const t = p.target === 'foe' ? c.foeVar : c.selfVar; return [`${t}.status = :NONE`, `${t}.statusCount = 0`]; }
    },
    setWeather: {
        label: 'Set the environment to __', params: [{ key: 'weather', type: 'select', options: WEATHERS.map(w => ({ value: w.id, label: w.label })), default: 'Sun' }],
        sd: (c, p) => { const w = WEATHERS.find(x => x.id === p.weather); return [`this.field.setWeather('${w ? w.sd : 'sunnyday'}');`]; },
        es: (c, p) => [`battle.pbStartWeather(${c.selfVar}.index, :${p.weather}, false, false)`]
    },
    multiplyStat: {
        label: 'Change the current value by factor __', params: [{ key: 'factor', type: 'number', step: 0.1, default: 2 }],
        sd: (c, p) => [`value = Math.floor(value * ${p.factor});`],
        es: (c, p) => [`value = (value * ${p.factor}).floor`]
    },
    multiplyAccuracy: {
        label: 'Change the move\u2019s accuracy by factor __', params: [{ key: 'factor', type: 'number', step: 0.1, default: 1.3 }],
        sd: (c, p) => [`accuracy = Math.floor(accuracy * ${p.factor});`],
        es: (c, p) => [`mods[:accuracy_multiplier] *= ${p.factor}`]
    },
    customCode: {
        label: 'Run this code: __', params: [{ key: 'code', type: 'code', default: '', placeholder: 'this.heal(self.maxhp / 8, self);' }],
        // Spliced straight into the export, which is the point of the block.
        sd: (c, p) => String(p.code || '').split('\n'),
        es: (c, p) => String(p.code || '').split('\n')
    },
    ignoreStatStages: {
        label: 'Ignore those stat stages', params: [],
        sd: (c) => [`for (const stat of ['atk','def','spa','spd','spe','accuracy','evasion']) boosts[stat] = 0;`, `void ${c.selfVar};`],
        es: () => ['# handled by the surrounding damage calculation']
    },
    restoreItem: {
        label: 'Give back the item __ last used up', params: [{ key: 'target', type: 'select', options: TARGETS, default: 'self' }],
        sd: (c, p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return [`if (${t} && !${t}.item && ${t}.lastItem) {`,
                    `\tconst back = ${t}.lastItem;`,
                    `\t${t}.lastItem = '';`,
                    `\t${t}.setItem(back);`,
                    `\tthis.add('-item', ${t}, this.dex.items.get(back), '[from] ability: Recycle');`,
                    `}`];
        },
        es: (c, p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return [`if ${t} && !${t}.item && ${t}.recycleItem`,
                    `  ${t}.item = ${t}.recycleItem`,
                    `  ${t}.setRecycleItem(nil)`,
                    `  battle.pbDisplay(_INTL("{1} found one {2}!", ${t}.pbThis, ${t}.itemName))`,
                    'end'];
        }
    },
    multiplyDamage: {
        label: 'Change damage by factor __', params: [{ key: 'factor', type: 'number', step: 0.1, default: 0.5 }],
        sd: (c, p) => [`damage = Math.floor(damage * ${p.factor});`],
        es: (c, p) => [`mults[:power_multiplier] *= ${p.factor}`]
    },
    setTerrain: {
        label: 'Set the terrain to __', params: [{ key: 'terrain', type: 'select', options: TERRAIN, default: 'Electric' }],
        sd: (c, p) => [`this.field.setTerrain('${String(p.terrain || 'Electric').toLowerCase()}terrain');`],
        es: (c, p) => [`battle.pbStartTerrain(${c.selfVar}.index, :${p.terrain || 'Electric'}, false)`]
    },
    changeType: {
        label: 'Change type of __ to __', params: [
            { key: 'target', type: 'select', options: TARGETS, default: 'self' },
            { key: 'type', type: 'select', options: TYPES, default: 'Normal' }
        ],
        sd: (c, p) => { const t = p.target === 'foe' ? c.foeVar : c.selfVar; return [`${t}.setType('${p.type || 'Normal'}');`]; },
        es: (c, p) => { const t = p.target === 'foe' ? c.foeVar : c.selfVar; return [`${t}.pbChangeTypes([:${String(p.type || 'Normal').toUpperCase()}]) if ${t}`]; }
    },
    changeTypeToMoveType: {
        label: 'Change type of __ to the current move type', params: [
            { key: 'target', type: 'select', options: TARGETS, default: 'self' }
        ],
        sd: (c, p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return [`if (${c.moveVar || 'move'} && ${c.moveVar || 'move'}.type) ${t}.setType(${c.moveVar || 'move'}.type);`];
        },
        es: (c, p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return [`${t}.pbChangeTypes([${c.moveVar || 'move'}.type]) if ${t} && ${c.moveVar || 'move'}`];
        }
    },
    resetStatStages: {
        label: 'Reset stat stages on __', params: [{ key:'target', type:'select', options:TARGETS, default:'self' }],
        sd: (c,p) => { const t=p.target==='foe'?c.foeVar:c.selfVar; return [`this.clearBoosts(${t});`]; },
        es: (c,p) => { const t=p.target==='foe'?c.foeVar:c.selfVar; return [`${t}.stages = {ATTACK: 0, DEFENSE: 0, SPECIAL_ATTACK: 0, SPECIAL_DEFENSE: 0, SPEED: 0, ACCURACY: 0, EVASION: 0} if ${t}`]; }
    },
    copyStatStages: {
        label: 'Copy stat stages from __ to __', params: [
            { key:'from', type:'select', options:TARGETS, default:'foe' },
            { key:'to', type:'select', options:TARGETS, default:'self' }
        ],
        sd: (c,p) => { const a=p.from==='foe'?c.foeVar:c.selfVar; const b=p.to==='foe'?c.foeVar:c.selfVar; return [`${b}.boosts = { ...${a}.boosts };`]; },
        es: (c,p) => { const a=p.from==='foe'?c.foeVar:c.selfVar; const b=p.to==='foe'?c.foeVar:c.selfVar; return [`${b}.stages = ${a}.stages.dup if ${a} && ${b}`]; }
    },
    setAbility: {
        label: 'Set ability of __ to __', params: [
            { key:'target', type:'select', options:TARGETS, default:'self' },
            { key:'ability', type:'text', default:'abilityName' }
        ],
        sd: (c,p) => { const t=p.target==='foe'?c.foeVar:c.selfVar; return [`${t}.setAbility('${String(p.ability||'abilityName').replace(/'/g, "\\'")}');`]; },
        es: (c,p) => { const t=p.target==='foe'?c.foeVar:c.selfVar; return [`${t}.ability = :${toEssentialsAbilityId(p.ability||'abilityName')} if ${t}`]; }
    },
    suppressAbility: {
        label: 'Suppress ability of __', params: [{ key:'target', type:'select', options:TARGETS, default:'foe' }],
        sd: (c,p) => { const t=p.target==='foe'?c.foeVar:c.selfVar; return [`${t}.ability = '';`]; },
        es: (c,p) => { const t=p.target==='foe'?c.foeVar:c.selfVar; return [`${t}.ability = nil if ${t}`]; }
    },
    addVolatile: {
        label: 'Apply effect __ to __', params: [
            { key: 'volatile', type: 'select', options: VOLATILES, default: 'flinch' },
            { key: 'target', type: 'select', options: TARGETS, default: 'foe' }
        ],
        sd: (c, p) => { const t = p.target === 'foe' ? c.foeVar : c.selfVar; return [`${t}.addVolatile('${p.volatile || 'flinch'}');`]; },
        es: (c, p) => { const t = p.target === 'foe' ? c.foeVar : c.selfVar; return [`${t}.addVolatile(:${p.volatile || 'flinch'}) if ${t}`]; }
    },
    removeVolatile: {
        label: 'Remove effect __ from __', params: [
            { key: 'volatile', type: 'select', options: VOLATILES, default: 'flinch' },
            { key: 'target', type: 'select', options: TARGETS, default: 'self' }
        ],
        sd: (c, p) => { const t = p.target === 'foe' ? c.foeVar : c.selfVar; return [`${t}.removeVolatile('${p.volatile || 'flinch'}');`]; },
        es: (c, p) => { const t = p.target === 'foe' ? c.foeVar : c.selfVar; return [`${t}.removeVolatile(:${p.volatile || 'flinch'}) if ${t}`]; }
    },
    applyBattleEffect: {
        label: 'Apply volatile/effect __ to __', category: 'Battle Effects',
        params: [
            {key:'effect',type:'select',options:VOLATILES,default:'stockpile'},
            {key:'target',type:'select',options:BATTLE_EFFECT_TARGETS,default:'foe'}
        ],
        sd: (c,p) => { const t=p.target==='foe'?c.foeVar:c.selfVar; return [`${t}.addVolatile('${safeEffectId(p.effect)}');`]; },
        es: (c,p) => { const t=p.target==='foe'?c.foeVar:c.selfVar; return [`${t}.addVolatile(:${safeEffectId(p.effect).toUpperCase()}) if ${t}`]; }
    },
    removeBattleEffect: {
        label: 'Remove volatile/effect __ from __', category: 'Battle Effects',
        params: [
            {key:'effect',type:'select',options:VOLATILES,default:'stockpile'},
            {key:'target',type:'select',options:BATTLE_EFFECT_TARGETS,default:'self'}
        ],
        sd: (c,p) => { const t=p.target==='foe'?c.foeVar:c.selfVar; return [`${t}.removeVolatile('${safeEffectId(p.effect)}');`]; },
        es: (c,p) => { const t=p.target==='foe'?c.foeVar:c.selfVar; return [`${t}.removeVolatile(:${safeEffectId(p.effect).toUpperCase()}) if ${t}`]; }
    },
    setBattleEffectProperty: {
        label: 'Set volatile/effect __ property __ to __', category: 'Battle Effects',
        params: [
            {key:'effect',type:'select',options:VOLATILES,default:'stockpile'},
            {key:'property',type:'select',options:VOLATILE_PROPERTY_OPTIONS.filter(x=>x.value!=='exists' && x.value!=='custom'),default:'layers'},
            {key:'value',type:'text',default:'1'},
            {key:'target',type:'select',options:BATTLE_EFFECT_TARGETS,default:'self'}
        ],
        sd: (c,p) => { const t=p.target==='foe'?c.foeVar:c.selfVar; const id=safeEffectId(p.effect); const prop=safeProperty(p.property); return [`if (${t}.volatiles?.['${id}']) ${t}.volatiles['${id}'].${prop} = ${p.value || '0'};`]; },
        es: (c,p) => { const t=p.target==='foe'?c.foeVar:c.selfVar; const id=safeEffectId(p.effect).toUpperCase(); const prop=safeProperty(p.property); return [`if ${t} && ${t}.effects[:${id}]`, `  ${t}.effects[:${id}].${prop} = ${p.value || '0'}`, `end`]; }
    },
    setShield: {
        label: 'Protect __', params: [{ key: 'target', type: 'select', options: TARGETS, default: 'self' }],
        sd: (c, p) => { const t = p.target === 'foe' ? c.foeVar : c.selfVar; return [`${t}.addVolatile('protect');`]; },
        es: (c, p) => { const t = p.target === 'foe' ? c.foeVar : c.selfVar; return [`${t}.addVolatile(:Protect) if ${t}`]; }
    },
    showMessage: {
        label: 'Show a message: __', params: [{ key: 'text', type: 'text', default: 'It activated!' }],
        sd: (c) => [`this.add('-activate', ${c.selfVar}, 'ability: ' + this.effect.name);`],
        es: (c, p) => [`battle.pbDisplay(_INTL("${String(p.text || '').replace(/"/g, '\\"')}"))`]
    }
};


// ==================== generalized Scratch-style block catalog ====================
// The visual editor intentionally exposes a broader, engine-neutral vocabulary.
// Blocks that cannot be translated perfectly to every target are emitted as
// clearly marked starter-code comments rather than being silently discarded.
const GENERIC_VALUE_OPTIONS = [
    { value: 'number', label: 'Number' }, { value: 'boolean', label: 'Boolean' },
    { value: 'string', label: 'String' }, { value: 'pokemon', label: 'Pokemon' },
    { value: 'move', label: 'Move' }, { value: 'ability', label: 'Ability' },
    { value: 'item', label: 'Item' }, { value: 'stat', label: 'Stat' },
    { value: 'hp', label: 'HP' }, { value: 'maxhp', label: 'Max HP' },
    { value: 'damage', label: 'Damage Taken' }, { value: 'random', label: 'Random Number' },
    { value: 'turn', label: 'Turn Number' }
];
const VARIABLE_SCOPES = [
    { value: 'local', label: 'Local Variable' },
    { value: 'global', label: 'Global / Battle Variable' }
];
const COMPARE_OPS = [
    { value: '==', label: '=' }, { value: '>', label: '>' }, { value: '<', label: '<' },
    { value: '>=', label: '>=' }, { value: '<=', label: '<=' }
];

Object.assign(TRIGGERS, {
    beforeMove: {
        label: 'Before this Pokémon uses a move', icon: 'zap', params: [], allowed: [],
        sd: () => ({ header: 'onPrepareHit(source, target, move) {', footer: '}', selfVar: 'source', foeVar: 'target', moveVar: 'move', preamble: '' }),
        es: () => ({ adder: 'Battle::AbilityEffects::BeforeMove', args: 'ability, user, targets, move, showAnimation', selfVar: 'user', foeVar: 'targets&.first', moveVar: 'move', preamble: '', footer: null })
    },
    battleStart: {
        label: 'On Battle Start', icon: 'play-circle', params: [], allowed: [],
        sd: () => ({ header: 'onStart(pokemon) {', footer: '}', selfVar: 'pokemon', foeVar: 'pokemon.side.foe.active[0]', moveVar: null, preamble: '' }),
        es: () => ({ adder: 'Battle::AbilityEffects::OnSwitchIn', args: 'ability, battler', selfVar: 'battler', foeVar: 'battler.pbDirectOpposing rescue nil', moveVar: null, preamble: '', footer: null })
    },
    switchInOut: {
        label: 'On Switch In / Out', icon: 'repeat-2', params: [{ key: 'direction', label: 'Event', type: 'select', options: [{ value: 'in', label: 'Switch In' }, { value: 'out', label: 'Switch Out' }], default: 'in' }], allowed: [],
        sd: ast => ast.triggerParams.direction === 'out'
            ? { header: 'onSwitchOut(pokemon) {', footer: '}', selfVar: 'pokemon', foeVar: 'pokemon.side.foe.active[0]', moveVar: null, preamble: '' }
            : { header: 'onStart(pokemon) {', footer: '}', selfVar: 'pokemon', foeVar: 'pokemon.side.foe.active[0]', moveVar: null, preamble: '' },
        es: () => ({ adder: 'Battle::AbilityEffects::OnSwitchIn', args: 'ability, battler', selfVar: 'battler', foeVar: 'battler.pbDirectOpposing rescue nil', moveVar: null, preamble: '', footer: null })
    },
    turnStartEnd: {
        label: 'On Turn Start / End', icon: 'clock-3', params: [{ key: 'phase', label: 'Phase', type: 'select', options: [{ value: 'start', label: 'Turn Start' }, { value: 'end', label: 'Turn End' }], default: 'start' }], allowed: [],
        sd: ast => ast.triggerParams.phase === 'start'
            ? { header: 'onTurnStart(source) {', footer: '}', selfVar: 'source', foeVar: 'source.side.foe.active[0]', moveVar: null, preamble: '' }
            : { header: 'onResidual(pokemon) {', footer: '}', selfVar: 'pokemon', foeVar: 'pokemon.side.foe.active[0]', moveVar: null, preamble: '' },
        es: () => ({ adder: 'Battle::AbilityEffects::EndOfRoundEffect', args: 'ability, battler', selfVar: 'battler', foeVar: 'battler.pbDirectOpposing rescue nil', moveVar: null, preamble: '', footer: null })
    },
    onMove: {
        label: 'On Move', icon: 'swords', params: [{ key: 'phase', label: 'Phase', type: 'select', options: [{ value: 'use', label: 'Move Used' }, { value: 'hit', label: 'Move Hits' }], default: 'use' }], allowed: [],
        sd: () => ({ header: 'onAfterMove(source, target, move) {', footer: '}', selfVar: 'source', foeVar: 'target', moveVar: 'move', preamble: '' }),
        es: () => ({ adder: 'Battle::AbilityEffects::AfterMoveUseFromUser', args: 'ability, user, target, move, switchedBattlers, hitNum, canSwitch', selfVar: 'user', foeVar: 'target', moveVar: 'move', preamble: '', footer: null })
    },
    onDamage: {
        label: 'On Damage', icon: 'heart-crack', params: [], allowed: [],
        sd: () => ({ header: 'onDamagingHit(damage, target, source, move) {', footer: '}', selfVar: 'target', foeVar: 'source', moveVar: 'move', preamble: '' }),
        es: () => ({ adder: 'Battle::AbilityEffects::AfterMoveUseFromTarget', args: 'ability, user, target, move, switchedBattlers, hpLost', selfVar: 'target', foeVar: 'user', moveVar: 'move', preamble: '', footer: null })
    },
    onFaint: {
        label: 'On Faint', icon: 'skull', params: [], allowed: [],
        sd: () => ({ header: 'onFaint(pokemon, source, effect) {', footer: '}', selfVar: 'pokemon', foeVar: 'source', moveVar: null, preamble: '' }),
        es: () => ({ adder: 'Battle::AbilityEffects::OnSwitchOut', args: 'ability, battler', selfVar: 'battler', foeVar: 'battler.pbDirectOpposing rescue nil', moveVar: null, preamble: '', footer: null })
    },
    onStatus: {
        label: 'On Status Change', icon: 'circle-alert', params: [], allowed: [],
        sd: () => ({ header: 'onSetStatus(status, target, source, effect) {', footer: '}', selfVar: 'target', foeVar: 'source', moveVar: null, preamble: '' }),
        es: () => ({ adder: 'Battle::AbilityEffects::OnSwitchIn', args: 'ability, battler', selfVar: 'battler', foeVar: 'battler.pbDirectOpposing rescue nil', moveVar: null, preamble: '', footer: null })
    }
});

Object.assign(CONDITIONS, {
    moveIsDamaging: {
        label: 'move is damaging', params: [],
        sd: c => `${c.moveVar || 'move'}.category !== 'Status'`,
        es: c => `${c.moveVar || 'move'} && !${c.moveVar || 'move'}.statusMove?`
    },
    moveHasFlag: {
        label: 'move has flag __', params: [{key:'flag',type:'select',options:[
            {value:'contact',label:'Contact'}, {value:'bite',label:'Bite'}, {value:'bullet',label:'Bullet'},
            {value:'sound',label:'Sound'}, {value:'powder',label:'Powder'}, {value:'punch',label:'Punch'},
            {value:'pulse',label:'Pulse'}, {value:'recharge',label:'Recharge'}, {value:'wind',label:'Wind'},
            {value:'heal',label:'Heal'}, {value:'protect',label:'Protect'}, {value:'reflectable',label:'Reflectable'},
            {value:'defrost',label:'Defrost'}, {value:'dance',label:'Dance'}
        ],default:'contact'}],
        sd: (c,p) => `${c.moveVar || 'move'}.flags['${p.flag || 'contact'}']`,
        es: (c,p) => `${c.moveVar || 'move'}.flags[:${String(p.flag || 'contact').toUpperCase()}]`
    },
    targetIsFainted: {
        label: 'target is fainted', params: [],
        sd: c => `${c.foeVar || 'foe'}.fainted`,
        es: c => `${c.foeVar || 'foe'} && ${c.foeVar || 'foe'}.fainted?`
    },
    compare: {
        label: 'compare __ __ __', params: [
            { key: 'left', type: 'text', default: 'HP' },
            { key: 'op', type: 'select', options: COMPARE_OPS, default: '>' },
            { key: 'right', type: 'text', default: '0' }
        ],
        sd: (c,p) => `(${p.left || '0'}) ${p.op || '>'} (${p.right || '0'})`,
        es: (c,p) => `(${p.left || '0'}) ${p.op || '>'} (${p.right || '0'})`
    },
    and: {
        label: 'AND (left and right)', params: [
            { key: 'left', type: 'text', default: 'HP > 0' }, { key: 'right', type: 'text', default: 'Turn > 1' }
        ],
        sd: (c,p) => `(${p.left || 'true'}) && (${p.right || 'true'})`, es: (c,p) => `(${p.left || 'true'}) && (${p.right || 'true'})`
    },
    or: {
        label: 'OR (left or right)', params: [
            { key: 'left', type: 'text', default: 'HP > 0' }, { key: 'right', type: 'text', default: 'Turn > 1' }
        ],
        sd: (c,p) => `(${p.left || 'false'}) || (${p.right || 'false'})`, es: (c,p) => `(${p.left || 'false'}) || (${p.right || 'false'})`
    },
    not: {
        label: 'NOT __', params: [{ key: 'value', type: 'text', default: 'HP <= 0' }],
        sd: (c,p) => `!(${p.value || 'false'})`, es: (c,p) => `!(${p.value || 'false'})`
    }
});

function genericCodeComment(label, params) {
    const bits = Object.entries(params || {}).map(([k,v]) => `${k}=${v}`).join(', ');
    return [`// ${label}${bits ? ` (${bits})` : ''}`];
}
function genericAction(label, template, params, sdExtra, esExtra) {
    return { label: template || label, category: label, params: params || [], sd: (c,p) => sdExtra ? sdExtra(c,p) : genericCodeComment(label,p), es: (c,p) => esExtra ? esExtra(c,p) : genericCodeComment(label,p) };
}

Object.assign(ACTIONS, {
    setVariable: genericAction('Set Variable', 'Set Variable __ to __', [{key:'name',type:'text',default:'myVariable'},{key:'value',type:'text',default:'0'}]),
    changeVariable: genericAction('Change Variable', 'Set Variable __ to __', [{key:'name',type:'text',default:'myVariable'},{key:'amount',type:'number',default:1}], null, null),
    getVariable: genericAction('Get Variable', 'Get Variable __', [{key:'name',type:'text',default:'myVariable'}]),
    localVariable: genericAction('Local Variable', 'Local Variable __', [{key:'name',type:'text',default:'localValue'},{key:'value',type:'text',default:'0'}]),
    globalVariable: genericAction('Global / Battle Variable', 'Global / Battle Variable __', [{key:'name',type:'text',default:'battleValue'},{key:'value',type:'text',default:'0'}]),
    numberValue: genericAction('Number', 'Number __', [{key:'value',type:'number',default:0}]),
    booleanValue: genericAction('Boolean', 'Boolean __', [{key:'value',type:'select',options:[{value:'true',label:'True'},{value:'false',label:'False'}],default:'true'}]),
    stringValue: genericAction('String', 'String __', [{key:'value',type:'text',default:'text'}]),
    pokemonValue: genericAction('Pokemon', 'Pokemon __', [{key:'value',type:'text',default:'self'}]),
    moveValue: genericAction('Move', 'Move __', [{key:'value',type:'text',default:'currentMove'}]),
    abilityValue: genericAction('Ability', 'Ability __', [{key:'value',type:'text',default:'currentAbility'}]),
    itemValue: genericAction('Item', 'Item __', [{key:'value',type:'text',default:'heldItem'}]),
    statValue: genericAction('Stat', 'Stat __', [{key:'value',type:'select',options:STATS.map(s=>({value:s.id,label:s.label})),default:'atk'}]),
    hpValue: genericAction('HP', 'HP of __', [{key:'target',type:'select',options:TARGETS,default:'self'}]),
    maxHpValue: genericAction('Max HP', 'Max HP of __', [{key:'target',type:'select',options:TARGETS,default:'self'}]),
    damageTakenValue: genericAction('Damage Taken', 'Damage Taken'),
    randomNumberValue: genericAction('Random Number', 'Random Number from __ to __', [{key:'min',type:'number',default:1},{key:'max',type:'number',default:100}]),
    turnNumberValue: genericAction('Turn Number', 'Turn Number'),
    callFunction: genericAction('Call Function', 'Call Function __', [{key:'name',type:'text',default:'myFunction'},{key:'args',type:'text',default:''}]),
    returnValue: genericAction('Return', 'Return __', [{key:'value',type:'text',default:''}]),
    parameters: genericAction('Parameters', 'Parameters __', [{key:'value',type:'text',default:'param1, param2'}]),
    getProperty: genericAction('Get Property', 'Get Property __ from __', [{key:'property',type:'select',options:VALUE_REFS,default:'hp'},{key:'target',type:'select',options:TARGETS,default:'self'}]),
    setProperty: genericAction('Set Property', 'Set Property __ on __ to __', [{key:'property',type:'select',options:VALUE_REFS,default:'hp'},{key:'target',type:'select',options:TARGETS,default:'self'},{key:'value',type:'number',default:0}]),
    repeat: genericAction('Repeat', 'Repeat __ times', [{key:'count',type:'number',default:2,min:1,max:100}]),
    forEach: genericAction('For Each', 'For Each __ in __', [{key:'item',type:'text',default:'pokemon'},{key:'collection',type:'text',default:'team'}]),
    damage: genericAction('Damage', 'Damage __ by __% of __', [
        {key:'target',type:'select',options:TARGETS,default:'foe'},
        {key:'percent',type:'number',default:10,min:0,max:1000,step:1},
        {key:'basis',type:'select',options:AMOUNT_BASES,default:'maxhp'}
    ], (c,p)=>{const t=p.target==='foe'?c.foeVar:c.selfVar; return [`this.damage(${amountExpression(t,p,c)}, ${t}, ${c.selfVar});`];}),
    heal: genericAction('Heal', 'Heal __ by __% of __', [
        {key:'target',type:'select',options:TARGETS,default:'self'},
        {key:'percent',type:'number',default:25,min:0,max:1000,step:1},
        {key:'basis',type:'select',options:AMOUNT_BASES,default:'maxhp'}
    ], (c,p)=>{const t=p.target==='foe'?c.foeVar:c.selfVar; return [`this.heal(${amountExpression(t,p,c)}, ${t});`];}),
    setHazard: genericAction('Entry Hazard', 'Set __ on __ side', [{key:'hazard',type:'select',options:HAZARDS,default:'toxicspikes'},{key:'target',type:'select',options:[{value:'self',label:'this side'},{value:'foe',label:'opposing side'}],default:'foe'}], (c,p)=>{const side=p.target==='foe'?`${c.foeVar}.side`:`${c.selfVar}.side`; const h=p.hazard||'toxicspikes'; return [`this.addSideCondition('${h}', ${side});`];}, (c,p)=>[`# Set entry hazard ${p.hazard||'toxicspikes'} on ${p.target||'foe'} side (wire to your Essentials hazard API)`]),
    inflictStatus: genericAction('Inflict Status', 'Inflict Status __ on __', [{key:'status',type:'select',options:STATUSES.map(s=>({value:s.id,label:s.label})),default:'brn'},{key:'target',type:'select',options:TARGETS,default:'foe'}], (c,p)=>{const t=p.target==='foe'?c.foeVar:c.selfVar; return [`${t}.trySetStatus('${p.status||'brn'}', ${c.selfVar});`];}),
    changeAbility: genericAction('Change Ability', 'Change Ability of __ to __', [{key:'target',type:'select',options:TARGETS,default:'self'},{key:'ability',type:'text',default:'abilityName'}]),
    changeForm: genericAction('Change Form', 'Change Form of __ to __', [{key:'target',type:'select',options:TARGETS,default:'self'},{key:'form',type:'text',default:'1'}]),
    switchPokemon: genericAction('Switch', 'Switch __', [{key:'target',type:'select',options:TARGETS,default:'self'}]),
    setWeatherTerrain: genericAction('Set Weather / Terrain', 'Set Weather / Terrain __ to __', [{key:'kind',type:'select',options:[{value:'weather',label:'Weather'},{value:'terrain',label:'Terrain'}],default:'weather'},{key:'value',type:'select',options:[...WEATHERS.map(w=>({value:w.id,label:w.label})), ...TERRAIN.map(t=>({value:t.value,label:t.label}))],default:'Sun'}]),
    compareLogic: genericAction('Compare', 'Compare __ __ __', [{key:'left',type:'text',default:'HP'},{key:'op',type:'select',options:COMPARE_OPS,default:'>'},{key:'right',type:'text',default:'0'}]),
    andLogic: genericAction('AND', 'AND __ with __', [{key:'left',type:'text',default:'true'},{key:'right',type:'text',default:'true'}]),
    orLogic: genericAction('OR', 'OR __ with __', [{key:'left',type:'text',default:'false'},{key:'right',type:'text',default:'false'}]),
    notLogic: genericAction('NOT', 'NOT __', [{key:'value',type:'text',default:'false'}]),
    removeHazard: genericAction('Remove Entry Hazard', 'Remove __ from __ side', [{key:'hazard',type:'select',options:HAZARDS,default:'toxicspikes'},{key:'target',type:'select',options:[{value:'self',label:'this side'},{value:'foe',label:'opposing side'}],default:'self'}], (c,p)=>{const side=p.target==='foe'?`${c.foeVar}.side`:`${c.selfVar}.side`; return [`this.removeSideCondition('${p.hazard||'toxicspikes'}', ${side});`];}),
    changePriority: genericAction('Change Move Priority', 'Change move priority by __', [{key:'amount',type:'number',default:1,min:-7,max:7}], (c,p)=>[`this.add('-ability', ${c.selfVar}, 'priority ${Number(p.amount)||0}');`]),
    clearTerrainWeather: genericAction('Clear Environment', 'Clear the current weather / terrain', [], (c)=>[`this.field.clearWeather();`, `this.field.clearTerrain();`]),
    setVolatile: genericAction('Set Effect', 'Apply effect __ to __', [{key:'volatile',type:'select',options:VOLATILES,default:'flinch'},{key:'target',type:'select',options:TARGETS,default:'foe'}], (c,p)=>{const t=p.target==='foe'?c.foeVar:c.selfVar; return [`${t}.addVolatile('${p.volatile||'flinch'}');`];})
});


// ==================== extended ability actions ====================
Object.assign(ACTIONS, {
    // Half of an -ate ability. The other half is multiplyMovePower, and they
    // are two blocks because they are two things: plenty of abilities change a
    // move's type without touching its power, and vice versa.
    setMoveType: {
        label: 'Make this move __ type',
        category: 'Battle Actions',
        params: [{ key: 'type', type: 'select', options: TYPES, default: 'Fairy' }],
        sd: (c, p) => [`${c.moveVar || 'move'}.type = '${p.type || 'Fairy'}';`],
        // the ModifyMoveBaseType handler hands `newType` back at the end
        es: (_c, p) => [`newType = :${String(p.type || 'Fairy').toUpperCase()}`]
    },
    multiplyMovePower: {
        label: 'Multiply this move\u2019s power by __%',
        category: 'Battle Actions',
        params: [{ key: 'percent', type: 'number', default: 120, min: 0, max: 1000, step: 1 }],
        sd: (c, p) => {
            const mv = c.moveVar || 'move';
            return [`${mv}.basePower = Math.floor(${mv}.basePower * ${((Number(p.percent) || 100) / 100).toFixed(4)});`];
        },
        es: (c, p) => {
            const mv = c.moveVar || 'move';
            return [`${mv}.baseDamage = (${mv}.baseDamage * ${((Number(p.percent) || 100) / 100).toFixed(4)}).floor if ${mv}.respond_to?(:baseDamage=)`];
        }
    },
    // The two halves of what the drawIn preset does in one piece, as blocks you
    // can put behind whatever condition you like.
    absorbMove: {
        label: 'Absorb the move (this Pok\u00e9mon is not hit)',
        category: 'Battle Actions',
        params: [],
        sd: () => ['return null;'],
        es: () => ['next true']
    },
    redirectMove: {
        label: 'Draw in __ moves aimed at anyone else',
        category: 'Battle Actions',
        params: [{ key: 'type', type: 'select', options: [{ value: 'any', label: 'all' }, ...TYPES], default: 'Water' }],
        // Redirection is a different Showdown hook from the one this block sits
        // in, so it emits a sibling handler rather than a statement -- see
        // sdHandler/collectExtraHandlers in the compilers below.
        sd: (_c, p) => [`// draws in ${p.type === 'any' ? 'all' : (p.type || 'Water')} moves -- see onAnyRedirectTarget below`],
        sdHandler: (_c, p) => {
            const type = p.type || 'Water';
            const guard = type === 'any' ? '' : tokNL(`@NL@@T3@if (move.type !== '${type}') return;`);
            return tokNL(`@T2@onAnyRedirectTarget(target, source, source2, move) {${guard}@NL@@T3@const holder = this.effectState.target;@NL@@T3@if (holder !== source && this.validTarget(holder, source, move.target)) return holder;@NL@@T2@}`);
        },
        // Essentials picks its target before abilities are consulted, so there
        // is no hook to bind the redirection to.
        es: (_c, p) => [`# NOTE: Essentials has no redirection hook; ${p.type === 'any' ? 'all' : (p.type || 'Water')} moves cannot be pulled here.`]
    },
    setTypeFromMove: {
        label: 'Change type of __ to the current move type',
        category: 'Battle Actions',
        params: [{key:'target',type:'select',options:TARGETS,default:'self'}],
        sd: (c,p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return [`${t}.setType(${c.moveVar || 'move'}.type);`];
        },
        es: (c,p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return [`${t}.pbChangeTypes([${c.moveVar || 'move'}.type]) if ${t} && ${c.moveVar || 'move'}`];
        }
    },
    resetStatStages: {
        label: 'Reset stat stages on __',
        category: 'Battle Actions',
        params: [{key:'target',type:'select',options:TARGETS,default:'self'}],
        sd: (c,p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return [`${t}.clearBoosts();`];
        },
        es: (c,p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return [`${t}.pbResetStatStages if ${t}`];
        }
    },
    setAbility: {
        label: 'Set ability of __ to __',
        category: 'Battle Actions',
        params: [
            {key:'target',type:'select',options:TARGETS,default:'self'},
            {key:'ability',type:'text',default:'abilityName'}
        ],
        sd: (c,p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return [`${t}.setAbility('${String(p.ability || 'abilityName').replace(/'/g,"\\\\'")}');`];
        },
        es: (c,p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return [`${t}.ability = :${String(p.ability || 'abilityName').toUpperCase()}`];
        }
    },
    suppressAbility: {
        label: 'Suppress ability of __',
        category: 'Battle Actions',
        params: [{key:'target',type:'select',options:TARGETS,default:'foe'}],
        sd: (c,p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return [`${t}.addVolatile?.('abilitysuppression');`];
        },
        es: (c,p) => {
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return [`${t}.addVolatile(:AbilitySuppression) if ${t}`];
        }
    },
    copyStatStages: {
        label: 'Copy stat stages from __ to __',
        category: 'Battle Actions',
        params: [
            {key:'source',type:'select',options:TARGETS,default:'foe'},
            {key:'target',type:'select',options:TARGETS,default:'self'}
        ],
        sd: (c,p) => {
            const s = p.source === 'foe' ? c.foeVar : c.selfVar;
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return [`${t}.boosts = { ...${s}.boosts };`];
        },
        es: (c,p) => {
            const s = p.source === 'foe' ? c.foeVar : c.selfVar;
            const t = p.target === 'foe' ? c.foeVar : c.selfVar;
            return [`${t}.stages = ${s}.stages.dup if ${t} && ${s}`];
        }
    },
    setMovePower: {
        label: 'Set current move power to __',
        category: 'Battle Actions',
        params: [{key:'power',type:'number',default:60,min:0,max:1000}],
        sd: (c,p) => [`${c.moveVar || 'move'}.basePower = ${Number(p.power) || 0};`],
        es: (c,p) => [`${c.moveVar || 'move'}.baseDamage = ${Number(p.power) || 0}`]
    },
    multiplyDamageTaken: {
        label: 'Multiply damage by __%',
        category: 'Battle Actions',
        params: [{key:'percent',type:'number',default:50,min:0,max:1000}],
        sd: (c,p) => [`// Damage multiplier: ${Number(p.percent) || 100}% (use from a damage-calculation trigger)`],
        es: (c,p) => [`# Damage multiplier: ${Number(p.percent) || 100}% (use from a damage-calculation trigger)`]
    },
    addSideCondition: {
        label: 'Add side condition __ to __ side',
        category: 'Battle Actions',
        params: [
            {key:'condition',type:'text',default:'customCondition'},
            {key:'target',type:'select',options:[{value:'self',label:'this side'},{value:'foe',label:'opposing side'}],default:'foe'}
        ],
        sd: (c,p) => {
            const side = p.target === 'foe' ? `${c.foeVar}.side` : `${c.selfVar}.side`;
            return [`this.addSideCondition('${String(p.condition || 'customCondition').replace(/'/g,"\\\\'")}', ${side});`];
        },
        es: (c,p) => {
            const side = p.target === 'foe' ? `${c.foeVar}.side` : `${c.selfVar}.side`;
            return [`${side}.addSideCondition(:${String(p.condition || 'customCondition').toUpperCase()})`];
        }
    },
    removeSideCondition: {
        label: 'Remove side condition __ from __ side',
        category: 'Battle Actions',
        params: [
            {key:'condition',type:'text',default:'customCondition'},
            {key:'target',type:'select',options:[{value:'self',label:'this side'},{value:'foe',label:'opposing side'}],default:'foe'}
        ],
        sd: (c,p) => {
            const side = p.target === 'foe' ? `${c.foeVar}.side` : `${c.selfVar}.side`;
            return [`this.removeSideCondition('${String(p.condition || 'customCondition').replace(/'/g,"\\\\'")}', ${side});`];
        },
        es: (c,p) => {
            const side = p.target === 'foe' ? `${c.foeVar}.side` : `${c.selfVar}.side`;
            return [`${side}.removeSideCondition(:${String(p.condition || 'customCondition').toUpperCase()})`];
        }
    }
});


// ==================== working variable actions ====================
// Variables compile to real local battle-script state instead of comments.
// `name` is sanitized because it becomes part of generated source.
function abilityVariableName(name) {
    const raw = String(name || 'value').trim();
    return raw.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^[0-9]/, '_$&') || 'value';
}

Object.assign(ACTIONS, {
    setVariable: {
        label: 'Set variable __ to __',
        category: 'Variables',
        params: [
            {key:'name',type:'text',default:'value'},
            {key:'value',type:'text',default:'0'}
        ],
        sd: (c,p) => {
            const n = abilityVariableName(p.name);
            return [`const ${n} = ${p.value || '0'};`];
        },
        es: (c,p) => {
            const n = abilityVariableName(p.name);
            return [`${n} = ${p.value || '0'}`];
        }
    },
    changeVariable: {
        label: 'Change variable __ by __',
        category: 'Variables',
        params: [
            {key:'name',type:'text',default:'value'},
            {key:'amount',type:'text',default:'1'}
        ],
        sd: (c,p) => {
            const n = abilityVariableName(p.name);
            return [`${n} += ${p.amount || '1'};`];
        },
        es: (c,p) => {
            const n = abilityVariableName(p.name);
            return [`${n} += ${p.amount || '1'}`];
        }
    },
    getVariable: {
        label: 'Get variable __',
        category: 'Variables',
        params: [{key:'name',type:'text',default:'value'}],
        sd: (c,p) => [abilityVariableName(p.name)],
        es: (c,p) => [abilityVariableName(p.name)]
    },
    localVariable: {
        label: 'Declare local variable __',
        category: 'Variables',
        params: [
            {key:'name',type:'text',default:'value'},
            {key:'value',type:'text',default:'0'}
        ],
        sd: (c,p) => {
            const n = abilityVariableName(p.name);
            return [`let ${n} = ${p.value || '0'};`];
        },
        es: (c,p) => {
            const n = abilityVariableName(p.name);
            return [`${n} = ${p.value || '0'}`];
        }
    },
    globalVariable: {
        label: 'Set persistent variable __ to __',
        category: 'Variables',
        params: [
            {key:'name',type:'text',default:'value'},
            {key:'value',type:'text',default:'0'}
        ],
        sd: (c,p) => {
            const n = abilityVariableName(p.name);
            return [`this.effectState = this.effectState || {};`, `this.effectState.${n} = ${p.value || '0'};`];
        },
        es: (c,p) => {
            const n = abilityVariableName(p.name);
            return [`battler.effects[:AbilityVariables] ||= {};`, `battler.effects[:AbilityVariables][:${n}] = ${p.value || '0'}`];
        }
    }
});

// Give every event the same broad visual vocabulary. The target-specific
// compiler may still emit starter comments for operations that need engine
// customization.
Object.values(TRIGGERS).forEach(t => { t.allowed = Object.keys(ACTIONS); });

const BLOCK_GROUPS = [
    { label:'Logic', color:'purple', items:['if','repeat','forEach','compareLogic','variableCompare','andLogic','orLogic','notLogic'] },
    { label:'Variables', color:'orange', items:['setVariable','changeVariable','getVariable','localVariable','globalVariable'] },
    { label:'Values', color:'green', items:['numberValue','booleanValue','stringValue','pokemonValue','moveValue','abilityValue','itemValue','statValue','hpValue','maxHpValue','damageTakenValue','randomNumberValue','turnNumberValue'] },
    { label:'Functions', color:'cyan', items:['callFunction','returnValue','parameters','getProperty','setProperty'] },
    { label:'Battle Actions', color:'blue', items:['damage','heal','boostStat','setStatValue','changeStatValue','setStatus','inflictStatus','changeType','changeAbility','changeForm','switchPokemon','setWeather','setTerrain','setWeatherTerrain','setHazard','removeHazard','clearTerrainWeather','changePriority','addVolatile','setVolatile','removeVolatile','setShield','changeTypeToMoveType','setMoveType','multiplyMovePower','setMovePower','absorbMove','redirectMove','resetStatStages','copyStatStages','setAbility','suppressAbility'] },
    { label:'Battle Effects', color:'blue', items:['applyBattleEffect','removeBattleEffect','setBattleEffectProperty'] },
    { label:'Items', color:'blue', items:['restoreItem'] },
    { label:'Raw Code', color:'gray', items:['customCode'] },
    { label:'Calculation', color:'blue', items:['multiplyStat','multiplyDamage','multiplyAccuracy','ignoreStatStages'] },
    { label:'Other / Output', color:'gray', items:['cureStatus','showMessage','dealDamage','healDamage','setWeather','setTerrain','changeType'] }
];
// The palette listed twelve event keys, and TRIGGERS defined none of them --
// they were the runtime's alias names, not the editor's. The intersection was
// empty, so the Events group rendered blank and no event block could be added
// at all. These are the canonical keys, every one of which TRIGGERS defines.
const EVENT_GROUP = { label:'Events', color:'gold', items:[
    'switchIn', 'switchOut', 'turnStart', 'residual',
    'beforeMove', 'afterMove', 'damagingHit', 'onContact', 'onFaint', 'onStatus',
    'statModify', 'damageModify', 'accuracyModify', 'statStageIgnore', 'moveImmunity',
    'moveTypeChange', 'moveIncoming', 'drawIn',
    'moveUsed', 'moveHit'
] };
const EVENT_KEYS = new Set(EVENT_GROUP.items);

// ==================== AST helpers ====================
function makeActionBlock(type) {
    const def = ACTIONS[type]; if (!def) return null;
    const params = {}; (def.params || []).forEach(p => params[p.key] = p.default);
    return { id: uid(), kind: 'action', action: type, params };
}
function makeIfBlock() {
    const firstKey = Object.keys(CONDITIONS)[0]; const def = CONDITIONS[firstKey];
    const condParams = {}; (def.params || []).forEach(p => condParams[p.key] = p.default);
    return { id: uid(), kind: 'if', condition: firstKey, condParams, then: [], else: [] };
}
function makeEventBlock(trigger) {
    const def = TRIGGERS[trigger] || TRIGGERS.switchIn;
    const params = {}; (def.params || []).forEach(p => params[p.key] = p.default);
    return { id: uid(), kind: 'event', trigger: trigger || 'switchIn', triggerParams: params, body: [], pos: { x: 24, y: 24 } };
}
function normalizeAbilityBlocks(raw) {
    const src = raw ? JSON.parse(JSON.stringify(raw)) : null;
    if (src && Array.isArray(src.triggers)) {
        src.triggers = src.triggers.filter(e => e && TRIGGERS[e.trigger]).map((e,i) => {
            e.kind = 'event'; e.body = Array.isArray(e.body) ? e.body : []; e.triggerParams = e.triggerParams || {};
            (TRIGGERS[e.trigger].params || []).forEach(p => { if (!(p.key in e.triggerParams)) e.triggerParams[p.key] = p.default; });
            e.pos = e.pos || { x: 24 + (i%3)*360, y: 24 + Math.floor(i/3)*260 };
            return e;
        });
        if (!src.triggers.length) src.triggers = [makeEventBlock('switchIn')];
        src.loose = Array.isArray(src.loose) ? src.loose : [];
        return src;
    }
    const key = src?.trigger && TRIGGERS[src.trigger] ? src.trigger : 'switchIn';
    const ev = makeEventBlock(key);
    ev.body = Array.isArray(src?.body) ? src.body : [];
    ev.triggerParams = src?.triggerParams || ev.triggerParams;
    return { version: 3, triggers: [ev], loose: [] };
}
function getAbilityRootEvents() { return Array.isArray(abState?.triggers) ? abState.triggers : []; }
function getAbilityLooseBlocks() { return Array.isArray(abState?.loose) ? abState.loose : (abState ? (abState.loose = []) : []); }
function locateAbilityBlock(id) {
    for (const ev of getAbilityRootEvents()) {
        if (ev.id === id) return { list: getAbilityRootEvents(), index: getAbilityRootEvents().indexOf(ev) };
        const hit = locateBlock(ev.body || [], id);
        if (hit) return hit;
    }
    const loose = getAbilityLooseBlocks();
    const li = loose.findIndex(b => b.id === id);
    if (li >= 0) return { list: loose, index: li };
    return null;
}
function findAbilityBlock(id) { const loc = locateAbilityBlock(id); return loc ? loc.list[loc.index] : null; }
function locateBlock(list, id) {
    for (let i = 0; i < list.length; i++) {
        if (list[i].id === id) return { list, index: i };
        if (list[i].kind === 'if') {
            const inThen = locateBlock(list[i].then, id); if (inThen) return inThen;
            if (list[i].else) { const inElse = locateBlock(list[i].else, id); if (inElse) return inElse; }
        }
    }
    return null;
}
function pruneInvalidBlocks(list, allowed) {
    let changed = false;
    for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i];
        if (b.kind === 'action' && !allowed.includes(b.action)) { list.splice(i, 1); changed = true; continue; }
        if (b.kind === 'if') {
            if (pruneInvalidBlocks(b.then || [], allowed)) changed = true;
            if (pruneInvalidBlocks(b.else || [], allowed)) changed = true;
        }
    }
    return changed;
}

// ==================== compilers ====================
function compileBody(list, ctx, lang, indent) {
    const pad = '\t'.repeat(indent);
    const lines = [];
    (list || []).forEach(block => {
        if (block.kind === 'if') {
            const cdef = CONDITIONS[block.condition]; if (!cdef) return;
            const expr = lang === 'sd' ? cdef.sd(ctx, block.condParams || {}) : cdef.es(ctx, block.condParams || {});
            if (lang === 'sd') {
                lines.push(`${pad}if (${expr}) {`);
                lines.push(...compileBody(block.then, ctx, lang, indent + 1));
                if (block.else && block.else.length) { lines.push(`${pad}} else {`); lines.push(...compileBody(block.else, ctx, lang, indent + 1)); }
                lines.push(`${pad}}`);
            } else {
                lines.push(`${pad}if ${expr}`);
                lines.push(...compileBody(block.then, ctx, lang, indent + 1));
                if (block.else && block.else.length) { lines.push(`${pad}else`); lines.push(...compileBody(block.else, ctx, lang, indent + 1)); }
                lines.push(`${pad}end`);
            }
        } else if (block.kind === 'action') {
            const def = ACTIONS[block.action]; if (!def) return;
            const stmts = lang === 'sd' ? def.sd(ctx, block.params || {}) : def.es(ctx, block.params || {});
            stmts.forEach(s => lines.push(`${pad}${s}`));
            // A few effects are not a statement inside the handler they are
            // written in -- redirection is its own Showdown hook. Those
            // actions hand back a whole sibling handler, collected here and
            // emitted next to the one being built (see compileShowdownAbility).
            if (lang === 'sd' && def.sdHandler && ctx.extraHandlers) {
                const extra = def.sdHandler(ctx, block.params || {});
                if (extra && !ctx.extraHandlers.includes(extra)) ctx.extraHandlers.push(extra);
            }
        }
    });
    return lines;
}

function getAbilityEvents(ast) {
    if (Array.isArray(ast?.triggers)) return ast.triggers;
    if (ast?.trigger && TRIGGERS[ast.trigger]) return [{ kind:'event', trigger:ast.trigger, triggerParams:ast.triggerParams || {}, body:ast.body || [] }];
    return [];
}
function compileEssentialsEvent(ev, index = 0) {
    const def = TRIGGERS[ev.trigger]; if (!def) return '';
    const t = def.es(ev); const ctx = { selfVar:t.selfVar, foeVar:t.foeVar, moveVar:t.moveVar };
    const body = compileBody(ev.body || [], ctx, 'es', 2);
    const lines=[];
    lines.push(`${t.adder}.add(:${toEssentialsAbilityId(ev.trigger)}_${index + 1},`);
    lines.push(`  proc { |${t.args}|`);
    if (t.preamble) lines.push(`    ${t.preamble}`);
    if (body.length) body.forEach(l=>lines.push(`    ${l}`)); else lines.push('    # (empty event)');
    if (t.footer) lines.push(`    ${t.footer}`);
    lines.push('  }'); lines.push(')');
    return lines.join('\n');
}
function compileShowdownAbility(ability) {
    const ast = ability && ability.blocks; const events = getAbilityEvents(ast);
    const written = showdownSourceFromRaw(ability?.rawCode);
    // Hand-written only: emit it as the entry's body. Showdown hook syntax is
    // exactly what the box asked for, so there is nothing to translate.
    if (!events.length) {
        if (!written) return null;
        const rawId = toShowdownAbilityId(ability.name);
        const rawDesc = String(ability.desc || '').replace(/"/g, '\\"');
        return `\t${rawId || 'customability'}: {\n\t\tname: "${String(ability.name || '').replace(/"/g, '\\"')}",\n\t\tshortDesc: "${rawDesc}",\n${written}\n\t},`;
    }
    const id = toShowdownAbilityId(ability.name);
    const desc = String(ability.desc || '').replace(/"/g, '\\"');
    const groups = new Map();
    // filled by compileBody for actions that are their own hook rather than a
    // line inside someone else's
    const extraHandlers = [];
    events.forEach(ev => {
        const def = TRIGGERS[ev.trigger]; if (!def) return;
        const t = def.sd(ev); const ctx = { selfVar:t.selfVar, foeVar:t.foeVar, moveVar:t.moveVar, extraHandlers };
        const body = compileBody(ev.body || [], ctx, 'sd', 3);
        const key = `${t.header}|||${t.footer}`;
        if (!groups.has(key)) groups.set(key, { t, bodies: [] });
        groups.get(key).bodies.push(...body);
        if (t.preamble) groups.get(key).preamble = t.preamble;
    });
    const handlers = [...groups.values()].map(({t,bodies,preamble}) => {
        const pre = preamble ? `\t\t\t${preamble}\n` : '';
        return `\t\t${t.header}\n${pre}${bodies.length ? bodies.join('\n') : '\t\t\t// (empty event)'}\n\t\t${t.footer}`;
    // These are members of an object literal: joined on a bare
    // newline they emitted TypeScript that would not parse.
    }).join(',\n\n');
    const withExtras = extraHandlers.length
        ? [handlers, ...extraHandlers].filter(Boolean).join(',\n\n')
        : handlers;
    // Blocks AND hand-written code: both go in, blocks first, so neither is
    // quietly dropped because the other existed.
    const body = written ? `${withExtras},\n${written}` : withExtras;
    return `\t${id || 'customability'}: {\n\t\tname: "${String(ability.name || '').replace(/"/g, '\\"')}",\n\t\tshortDesc: "${desc}",\n${body}\n\t},`;
}

// ==================== custom moves and items as mod files ====================
// a mod folder needs moves.ts/items.ts next to abilities.ts, or a signature
// move exports as a name that resolves to nothing
function compileShowdownMove(move) {
    const id = toShowdownAbilityId(move.name);
    if (!id) return null;
    const esc = (v) => String(v || '').replace(/"/g, '\\"');
    const fields = [
        `\t\tnum: -1,`,
        `\t\tname: "${esc(move.name)}",`,
        `\t\ttype: "${esc(move.type || 'Normal')}",`,
        `\t\tcategory: "${esc(move.category || 'Status')}",`,
        `\t\tbasePower: ${Number(move.basePower) || 0},`,
        `\t\taccuracy: ${move.accuracy === true || move.accuracy === null ? 'true' : (Number(move.accuracy) || 100)},`,
        `\t\tpp: ${Number(move.pp) || 10},`,
        `\t\tpriority: ${Number(move.priority) || 0},`,
        `\t\tflags: ${JSON.stringify(move.flags || {})},`,
        `\t\tshortDesc: "${esc(move.desc)}",`,
        `\t\ttarget: "normal",`
    ];
    const blockBody = compileShowdownMoveBlocks(move);
    if (blockBody) fields.push(blockBody + ',');
    const written = showdownSourceFromRaw(move.rawCode);
    if (written) fields.push(written);
    return `\t${id}: {\n${fields.join('\n')}\n\t},`;
}

// A move's block program uses the same compiler an ability's does -- the AST,
// the triggers and both backends are shared (see abKind) -- so this is only
// here to reuse it without duplicating the grouping logic.
function compileShowdownMoveBlocks(move) {
    const events = getAbilityEvents(move?.blocks);
    if (!events.length) return null;
    const groups = new Map();
    const extraHandlers = [];
    events.forEach(ev => {
        const def = TRIGGERS[ev.trigger]; if (!def) return;
        const t = def.sd(ev); const ctx = { selfVar: t.selfVar, foeVar: t.foeVar, moveVar: t.moveVar, extraHandlers };
        const body = compileBody(ev.body || [], ctx, 'sd', 3);
        const key = `${t.header}|||${t.footer}`;
        if (!groups.has(key)) groups.set(key, { t, bodies: [] });
        groups.get(key).bodies.push(...body);
        if (t.preamble) groups.get(key).preamble = t.preamble;
    });
    if (!groups.size) return null;
    const handlers = [...groups.values()].map(({ t, bodies, preamble }) => {
        const pre = preamble ? `\t\t\t${preamble}\n` : '';
        return `\t\t${t.header}\n${pre}${bodies.length ? bodies.join('\n') : '\t\t\t// (empty event)'}\n\t\t${t.footer}`;
    // These are members of an object literal: joined on a bare
    // newline they emitted TypeScript that would not parse.
    }).join(',\n\n');
    return [handlers, ...extraHandlers].filter(Boolean).join(',\n\n');
}

function compileShowdownItem(item) {
    const id = toShowdownAbilityId(item.name);
    if (!id) return null;
    const esc = (v) => String(v || '').replace(/"/g, '\\"');
    const fields = [
        `\t\tnum: -1,`,
        `\t\tname: "${esc(item.name)}",`,
        `\t\tshortDesc: "${esc(item.desc)}",`
    ];
    const blockBody = compileShowdownMoveBlocks(item);
    if (blockBody) fields.push(blockBody + ',');
    const written = showdownSourceFromRaw(item.rawCode);
    if (written) fields.push(written);
    return `\t${id}: {\n${fields.join('\n')}\n\t},`;
}

function buildShowdownMovesFile(fakemonList) {
    const moves = collectUsedCustomMovesWithCode(fakemonList);
    if (!moves.length) return null;
    const entries = moves.map(compileShowdownMove).filter(Boolean);
    if (!entries.length) return null;
    return `// Made with Woogidex! Custom move logic from the move editor.\n// Drop this into data/mods/<modname>/moves.ts alongside pokedex.ts.\n// This is a strong starting point - read it over before using it live.\nexport const Moves: {[k: string]: Partial<import('../../../../sim/dex-moves').MoveData>} = {\n${entries.join('\n')}\n};\n`;
}

function buildShowdownItemsFile(fakemonList) {
    const items = collectUsedCustomItemsWithCode(fakemonList);
    if (!items.length) return null;
    const entries = items.map(compileShowdownItem).filter(Boolean);
    if (!entries.length) return null;
    return `// Made with Woogidex! Custom item logic from the item editor.\n// Drop this into data/mods/<modname>/items.ts alongside pokedex.ts.\n// This is a strong starting point - read it over before using it live.\nexport const Items: {[k: string]: Partial<import('../../../../sim/dex-items').ItemData>} = {\n${entries.join('\n')}\n};\n`;
}

function compileEssentialsAbility(ability) {
    const ast = ability && ability.blocks; const events = getAbilityEvents(ast);
    if (!events.length) return null;
    return events.map((ev,i)=>compileEssentialsEvent(ev,i)).filter(Boolean).join('\n\n');
}

// worth exporting if it has EITHER a block program or hand-written code --
// only the first used to count, silently dropping raw-code-box entries
function hasExportableCode(lib) {
    if (!lib) return false;
    const blocks = lib.blocks;
    const hasBlocks = !!blocks && ((Array.isArray(blocks.triggers) && blocks.triggers.length) || blocks.trigger);
    return !!hasBlocks || !!String(lib.rawCode || '').trim();
}

function collectUsedCustomAbilitiesWithCode(fakemonList) {
    const seen = new Map();
    (fakemonList || []).forEach(f => (f.abilities || []).forEach(a => {
        if (a && (a.source === 'custom' || a.custom) && a.customId) {
            const lib = (state.customAbilities || []).find(x => x.id === a.customId);
            if (hasExportableCode(lib) && !seen.has(lib.id)) seen.set(lib.id, lib);
        }
    }));
    return [...seen.values()];
}

// The same, for the other two libraries. A custom move is referenced from a
// Fakemon's learnset and a custom item from its sample sets, so each is found
// where it is actually used rather than exporting the whole library.
function collectUsedCustomMovesWithCode(fakemonList) {
    const seen = new Map();
    (fakemonList || []).forEach(f => (f.learnset || []).forEach(m => {
        if (!m || !(m.source === 'custom' || m.custom)) return;
        const lib = (state.customMoves || []).find(x => x.id === m.customId)
            || (state.customMoves || []).find(x => String(x.name || '').toLowerCase() === String(m.name || '').toLowerCase());
        if (hasExportableCode(lib) && !seen.has(lib.id)) seen.set(lib.id, lib);
    }));
    return [...seen.values()];
}

function collectUsedCustomItemsWithCode(fakemonList) {
    const seen = new Map();
    (fakemonList || []).forEach(f => (f.sampleSets || []).forEach(set => {
        if (!set || set.itemCustom !== true) return;
        const lib = (state.customItems || []).find(x => x.id === set.itemCustomId)
            || (state.customItems || []).find(x => String(x.name || '').toLowerCase() === String(set.item || '').toLowerCase());
        if (hasExportableCode(lib) && !seen.has(lib.id)) seen.set(lib.id, lib);
    }));
    return [...seen.values()];
}

// ==================== hand-written code, on its way back out ====================
// the raw-code box accepts many shapes (see parseRawEntry in
// js/battle/engine/sd-hooks.js); a mod file needs one canonical shape, so the
// entry is parsed and rewritten rather than pasted through. functions are
// re-serialised from their own source to keep method-shorthand and arrow forms.
function showdownSourceFromRaw(rawCode, indent = '\t\t') {
    const parsed = parseRawEntry(rawCode);
    if (!parsed.ok || !parsed.entry) return null;
    const lines = [];
    for (const [key, value] of Object.entries(parsed.entry)) {
        if (typeof value === 'function') {
            const src = String(value).trim();
            // Method shorthand already carries its own name; a function
            // expression or an arrow does not, so it is given one.
            const member = src.startsWith(`${key}(`) || src.startsWith(`${key} (`)
                ? src
                : `${key}: ${src}`;
            lines.push(member.split('\n').map((l, i) => (i === 0 ? indent + l : indent + l)).join('\n') + ',');
        } else {
            let json;
            try { json = JSON.stringify(value); } catch { continue; }
            if (json === undefined) continue;
            lines.push(`${indent}${key}: ${json},`);
        }
    }
    return lines.length ? lines.join('\n') : null;
}

function buildShowdownAbilitiesFile(fakemonList) {
    const abilities = collectUsedCustomAbilitiesWithCode(fakemonList);
    if (!abilities.length) return null;
    const entries = abilities.map(compileShowdownAbility).filter(Boolean);
    if (!entries.length) return null;
    return `// Made with Woogidex! Ability logic generated from the ability block editor.\n// Drop this into data/mods/<modname>/abilities.ts alongside pokedex.ts.\n// This is a strong starting point - read it over before using it live.\nexport const Abilities: {[k: string]: Partial<import('../../../../sim/dex-abilities').AbilityData>} = {\n${entries.join('\n')}\n};\n`;
}

function buildEssentialsAbilitiesFile(fakemonList) {
    const abilities = collectUsedCustomAbilitiesWithCode(fakemonList);
    if (!abilities.length) return null;
    const entries = abilities.map(compileEssentialsAbility).filter(Boolean);
    if (!entries.length) return null;
    return `#-------------------------------------------------------------------------\n# Made with Woogidex! Ability logic generated from the ability block editor.\n# Targets the modern Battle::AbilityEffects API used by recent Pokemon\n# Essentials versions (v20/v21-style). Method and argument names can differ\n# a little between Essentials versions/forks - if something doesn't compile,\n# compare against an existing ability in your copy of Essentials and adjust.\n# Paste this into its own script section (e.g. "Woogidex Abilities"),\n# placed above Main in the script editor.\n#-------------------------------------------------------------------------\n\n${entries.join('\n\n')}\n`;
}

// ==================== editor UI state ====================
let abState = null;       // AST currently being edited
let abAbilityId = null;   // library entry id currently being edited
// Which library that id lives in. The whiteboard, the AST format, the
// interpreter and both codegen backends are identical for all three; only the
// list the entry is saved back into and the events on offer differ.
let abKind = 'ability';   // 'ability' | 'move' | 'item'
let abContainerRegistry = {};
let abDragId = null;
let abDragGrabOffset = null; // where the cursor grabbed the currently-dragged block, relative to its top-left
let abPreviewTab = 'sd';
let abPrevViewId = null;  // which top-level view ('editor-view' / 'collection-view') to restore on close

// opens the ability block editor as its own full page/view rather than a
// small modal; the ability library modal is closed first and reopened once
// the user backs out, so the name/description fields are still there
function normalizeAbilityIfBranches(list) {
    (list || []).forEach(block => {
        if (block && block.kind === 'if') {
            if (!Array.isArray(block.then)) block.then = [];
            if (!Array.isArray(block.else)) block.else = [];
            normalizeAbilityIfBranches(block.then);
            normalizeAbilityIfBranches(block.else);
        }
    });
}

// The library one kind of entry lives in, and the words used about it.
const AB_KINDS = {
    ability: { list: () => state.customAbilities, noun: 'ability', Noun: 'Ability' },
    move:    { list: () => state.customMoves,     noun: 'move',    Noun: 'Move' },
    item:    { list: () => state.customItems,     noun: 'item',    Noun: 'Item' }
};
function abKindInfo(kind = abKind) { return AB_KINDS[kind] || AB_KINDS.ability; }
function abEntry(id = abAbilityId, kind = abKind) {
    return (abKindInfo(kind).list() || []).find(x => x.id === id) || null;
}

function openMoveBlockEditor(id) { openAbilityBlockEditor(id, 'move'); }
function openItemBlockEditor(id) { openAbilityBlockEditor(id, 'item'); }

function openAbilityBlockEditor(customAbilityId, kind = 'ability') {
    const info = abKindInfo(kind);
    if (!customAbilityId) { api.showToast(`Save the ${info.noun} first, then add its battle code.`, 'info'); return; }
    const ability = (info.list() || []).find(a => a.id === customAbilityId);
    if (!ability) { api.showToast(`Could not find that ${info.noun}.`, 'error'); return; }
    abKind = kind;
    abAbilityId = customAbilityId;
    abState = normalizeAbilityBlocks(ability.blocks);
    getAbilityRootEvents().forEach(ev => normalizeAbilityIfBranches(ev.body));
    abPreviewTab = 'sd';

    document.getElementById('custom-ability-modal')?.classList.remove('active');
    document.getElementById('custom-move-modal')?.classList.remove('active');
    document.getElementById('custom-item-modal')?.classList.remove('active');
    document.getElementById('custom-entity-chooser-modal')?.classList.remove('active');
    abPrevViewId = document.getElementById('editor-view') && document.getElementById('editor-view').style.display !== 'none' ? 'editor-view' : 'collection-view';
    // Entering the ability editor is itself a top-level navigation transition,
    // but we must preserve this editor's state while activating its view.
    const view = api.activateTopLevelView?.('ability-block-editor-view', { preserveAbilityEditor: true })
        || document.getElementById('ability-block-editor-view');
    if (view) view.style.display = 'block';

    const titleEl = document.getElementById('ability-block-editor-title');
    if (titleEl) titleEl.textContent = `Code "${ability.name}"`;
    const kindEl = document.getElementById('ability-block-editor-kind');
    if (kindEl) kindEl.textContent = info.Noun;
    renderAbilityBlockEditor();
    api.setRoute?.(`ability-editor/${encodeURIComponent(customAbilityId)}`, `Code ${ability.name}`);
    if (typeof lucide !== 'undefined') lucide.createIcons();
}
function onTopLevelNavigation() {
    // called by the central app navigator whenever another full-page route
    // activates; the editor's Back button uses closeAbilityBlockEditor()
    // instead, so it can restore the ability library.
    const view = document.getElementById('ability-block-editor-view');
    if (!view || view.style.display === 'none') return;
    view.style.display = 'none';
    document.getElementById('custom-ability-modal')?.classList.remove('active');
    document.getElementById('custom-entity-chooser-modal')?.classList.remove('active');
    abState = null;
    abAbilityId = null;
    abKind = 'ability';
    abContainerRegistry = {};
    abPrevViewId = null;
}

// Backwards-compatible alias for older callers; new navigation should use the
// central activateTopLevelView() lifecycle in app.js.
function hideAbilityBlockEditorForNavigation() { onTopLevelNavigation(); }

function closeAbilityBlockEditor() {
    const view = document.getElementById('ability-block-editor-view');
    if (view) view.style.display = 'none';
    const restoreId = abPrevViewId || 'collection-view';
    const restoreEl = document.getElementById(restoreId);
    if (restoreEl) restoreEl.style.display = 'block';
    if (restoreId === 'editor-view') api.setRoute?.(`editor/${encodeURIComponent(state.editingId || '')}`, null);
    else api.setRoute?.('collection', null);
    // hop back into the library modal this came from so the user can keep
    // editing the name/description right where they left off.
    if (abAbilityId) {
        if (abKind === 'move') api.openCustomMoveLibraryModal?.(abAbilityId);
        else if (abKind === 'item') api.openCustomItemModal?.(abAbilityId);
        else api.openCustomAbilityLibraryModal?.(abAbilityId);
    }
    abState = null; abAbilityId = null; abKind = 'ability'; abContainerRegistry = {}; abPrevViewId = null;
}
function saveAbilityBlockEditor() {
    if (!abState || !abAbilityId) return;
    const entry = abEntry();
    if (!entry) return;
    entry.blocks = JSON.parse(JSON.stringify(normalizeAbilityBlocks(abState)));
    api.saveToStorage?.();
    api.showToast?.(`${abKindInfo().Noun} battle code saved!`, 'success');
    closeAbilityBlockEditor();
}

function setAbilityBlockTrigger(key) {
    // Legacy API: selecting an event now adds a new event stack instead of
    // replacing the first trigger. This preserves multi-trigger abilities.
    addAbilityEvent(key);
}

function updateAbilityTriggerParam(key, rawValue) {
    if (!abState) return;
    const ev = abState.triggers?.[0];
    if (!ev) return;
    const def = TRIGGERS[ev.trigger];
    const pdef = (def?.params || []).find(p => p.key === key);
    ev.triggerParams[key] = pdef && pdef.type === 'number' ? Number(rawValue) : rawValue;
    renderAbilityBlockEditor();
}

function addAbilityBlock(containerId, type) {
    if (!abState) return;
    const block = type === 'if' ? makeIfBlock() : makeActionBlock(type);
    if (!block) return;
    // Palette clicks create unattached blocks on the whiteboard. They never
    // silently insert themselves into the first event; the user chooses the
    // event/branch by dragging the block there.
    if (containerId === 'root' || containerId === 'loose') {
        const loose = getAbilityLooseBlocks();
        block.pos = { x: 80 + (loose.length % 3) * 280, y: 80 + Math.floor(loose.length / 3) * 140 };
        loose.push(block);
    } else {
        const arr = abContainerRegistry[containerId];
        if (!arr) return;
        arr.push(block);
    }
    renderAbilityBlockEditor();
}

function removeAbilityBlock(id) {
    if (!abState || !id) return false;
    const loc = locateAbilityBlock(id);
    if (!loc || !Array.isArray(loc.list) || loc.index < 0) return false;
    loc.list.splice(loc.index, 1);
    if (abDragId === id) abDragId = null;
    if (abPointerDrag?.id === id) abPointerDrag = null;
    renderAbilityBlockEditor();
    return true;
}

function detachAbilityBlockToBoard(id, x, y) {
    if (!abState || !id) return false;
    const block = findAbilityBlock(id);
    const loc = locateAbilityBlock(id);
    if (!block || !loc) return false;
    // event blocks live directly on the board; dragging one should just
    // reposition it, never demote it into the loose/unattached list
    if (block.kind === 'event' || loc.list === getAbilityLooseBlocks()) {
        block.pos = { x: Math.max(12, Number(x) || 12), y: Math.max(12, Number(y) || 12) };
        return true;
    }
    loc.list.splice(loc.index, 1);
    block.pos = { x: Math.max(12, Number(x) || 12), y: Math.max(12, Number(y) || 12) };
    getAbilityLooseBlocks().push(block);
    return true;
}
function moveAbilityBlock(id, dir) {
    if (!abState) return;
    const loc = locateAbilityBlock(id);
    if (!loc) return;
    const newIndex = loc.index + Number(dir);
    if (newIndex < 0 || newIndex >= loc.list.length) return;
    const [item] = loc.list.splice(loc.index, 1);
    loc.list.splice(newIndex, 0, item);
    renderAbilityBlockEditor();
}
function updateAbilityBlockParam(id, key, rawValue) {
    if (!abState) return;
    const block = findAbilityBlock(id); if (!block) return;
    const def = ACTIONS[block.action]; const pdef = (def?.params || []).find(p => p.key === key);
    block.params[key] = pdef && pdef.type === 'number' ? Number(rawValue) : rawValue;
    renderAbilityBlockEditor();
}
function updateAbilityIfCondition(id, conditionId) {
    if (!abState || !CONDITIONS[conditionId]) return;
    const block = findAbilityBlock(id); if (!block) return;
    block.condition = conditionId;
    const def = CONDITIONS[conditionId];
    const params = {}; (def.params || []).forEach(p => params[p.key] = p.default);
    block.condParams = params;
    renderAbilityBlockEditor();
}
function updateAbilityIfCondParam(id, key, rawValue) {
    if (!abState) return;
    const block = findAbilityBlock(id); if (!block) return;
    const def = CONDITIONS[block.condition]; const pdef = (def?.params || []).find(p => p.key === key);
    block.condParams[key] = pdef && pdef.type === 'number' ? Number(rawValue) : rawValue;
    renderAbilityBlockEditor();
}
function addAbilityElse(id) {
    if (!abState) return;
    const block = findAbilityBlock(id);
    if (block && block.kind === 'if') { block.else = Array.isArray(block.else) ? block.else : []; renderAbilityBlockEditor(); }
}
function removeAbilityElse(id) {
    // Else is a permanent Scratch-style branch. Keep the API for old callers,
    // but clear its contents rather than removing the branch.
    if (!abState) return;
    const block = findAbilityBlock(id);
    if (block && block.kind === 'if') { block.else = []; renderAbilityBlockEditor(); }
}
function setAbilityBlockPreviewTab(tab) {
    abPreviewTab = tab;
    document.querySelectorAll('.ability-block-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
    const sd = document.getElementById('ability-block-code-sd'); const es = document.getElementById('ability-block-code-es');
    if (sd) sd.style.display = tab === 'sd' ? 'block' : 'none';
    if (es) es.style.display = tab === 'es' ? 'block' : 'none';
}

// ==================== rendering ====================
// the board is a React island now (js/react/BlockBoard.jsx); render*
// functions live there as components, and non-markup decisions moved to
// ./ability-board-model.js


(function ensureAbilityPointerDragCSS() {
    if (document.getElementById('ab-pointer-drag-css')) return;
    const style = document.createElement('style');
    style.id = 'ab-pointer-drag-css';
    style.textContent = `
        #ab-workspace { position: relative; }
        #ab-workspace .ab-block { touch-action: none; }
        #ab-workspace .ab-block.ab-dragging { cursor: grabbing; }
    `;
    document.head.appendChild(style);
})();

// ==================== freeform whiteboard interaction ====================
// visual x/y position is presentation-only; the AST array still controls
// execution order, so moving a block never silently changes behavior
let abPointerDrag = null;

function getAbilityBlockById(id) {
    return abState ? findAbilityBlock(id) : null;
}



function startAbilityBlockMove(event, id, containerId) {
    if (!abState || event.button !== 0) return;

    // Never start a drag when the user clicked an actual control.
    if (event.target.closest('button, input, select, textarea, a')) return;

    const block = getAbilityBlockById(id);
    const el = event.currentTarget?.closest?.('.ab-block');
    if (!block || !el) return;

    const rect = el.getBoundingClientRect();
    const workspace = document.getElementById('ab-workspace');
    if (!workspace) return;

    abPointerDrag = {
        id,
        containerId,
        pointerId: event.pointerId,
        grabX: event.clientX - rect.left,
        grabY: event.clientY - rect.top,
        originalPosition: el.style.position,
        originalLeft: el.style.left,
        originalTop: el.style.top,
        originalWidth: el.style.width,
        originalZIndex: el.style.zIndex,
        originalPointerEvents: el.style.pointerEvents,
        el,
        moved: false
    };

    // While dragging, fixed positioning makes the visual block independent
    // of whichever nested .ab-container it came from.
    el.style.position = 'fixed';
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.zIndex = '10000';
    el.style.pointerEvents = 'none';
    el.classList.add('ab-dragging');

    try { el.setPointerCapture(event.pointerId); } catch (e) {}
    highlightConnectionTargets(block, true);
    event.preventDefault();
    event.stopPropagation();
}

function moveAbilityBlockPointer(event) {
    const drag = abPointerDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;

    const dx = event.clientX - (drag.el.getBoundingClientRect().left + drag.grabX);
    const dy = event.clientY - (drag.el.getBoundingClientRect().top + drag.grabY);

    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;

    const block = getAbilityBlockById(drag.id);
    const el = drag.el || document.querySelector(`.ab-block[data-id="${CSS.escape(drag.id)}"]`);
    if (!block || !el) return;

    // Exact screen-space position. This is what makes the block follow the
    // pointer instead of jumping to the top-left of a nested container.
    const left = event.clientX - drag.grabX;
    const top = event.clientY - drag.grabY;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    // Keep board coordinates synchronized for loose blocks / detach.
    const workspace = document.getElementById('ab-workspace');
    if (workspace) {
        const wr = workspace.getBoundingClientRect();
        block.pos = block.pos || { x: 12, y: 12 };
        block.pos.x = Math.max(12, event.clientX - wr.left + workspace.scrollLeft - drag.grabX);
        block.pos.y = Math.max(12, event.clientY - wr.top + workspace.scrollTop - drag.grabY);
    }

    highlightConnectionTargets(block, true);
}

function finishAbilityBlockMove(event) {
    const drag = abPointerDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;

    const id = drag.id;
    const block = getAbilityBlockById(id);
    const el = drag.el;

    const under = document.elementFromPoint(event.clientX, event.clientY);
    const slot = under?.closest?.('.ab-connection-slot');

    let movedInto = false;
    if (slot && block) {
        const cid = slot.dataset.containerId;
        if (
            isValidStatementDrop(block, cid) &&
            !collectDescendantContainerIdsForDrop(block).includes(cid)
        ) {
            movedInto = moveBlockIntoContainer(id, cid);
        }
    }

    // If a connected block was dragged out and not dropped on a socket,
    // detach it onto the main whiteboard.
    if (
        !movedInto &&
        block &&
        drag.moved &&
        drag.containerId !== 'root' &&
        drag.containerId !== 'loose'
    ) {
        const workspace = document.getElementById('ab-workspace');
        if (workspace) {
            const wr = workspace.getBoundingClientRect();
            detachAbilityBlockToBoard(
                id,
                event.clientX - wr.left + workspace.scrollLeft - drag.grabX,
                event.clientY - wr.top + workspace.scrollTop - drag.grabY
            );
        }
    } else if (!movedInto && block && (drag.containerId === 'root' || drag.containerId === 'loose')) {
        // Root/loose blocks simply retain their new board position.
        const workspace = document.getElementById('ab-workspace');
        if (workspace) {
            const wr = workspace.getBoundingClientRect();
            block.pos = {
                x: Math.max(12, event.clientX - wr.left + workspace.scrollLeft - drag.grabX),
                y: Math.max(12, event.clientY - wr.top + workspace.scrollTop - drag.grabY)
            };
        }
    }

    if (el) {
        el.classList.remove('ab-dragging');
        el.style.position = drag.originalPosition || '';
        el.style.left = drag.originalLeft || '';
        el.style.top = drag.originalTop || '';
        el.style.width = drag.originalWidth || '';
        el.style.zIndex = drag.originalZIndex || '';
        el.style.pointerEvents = drag.originalPointerEvents || '';
    }

    try { el?.releasePointerCapture?.(event.pointerId); } catch (e) {}

    highlightConnectionTargets(null, false);
    abPointerDrag = null;
    renderAbilityBlockEditor();
}

document.addEventListener('keydown', (event) => {
    if (!abState) return;
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    const active = document.activeElement;
    if (active && active.closest('input,select,textarea,[contenteditable="true"]')) return;
    const id = abDragId || abPointerDrag?.id;
    if (id) {
        event.preventDefault();
        removeAbilityBlock(id);
    }
});

document.addEventListener('pointermove', moveAbilityBlockPointer);
document.addEventListener('pointerup', finishAbilityBlockMove);
document.addEventListener('pointercancel', finishAbilityBlockMove);





function handlePaletteDragStart(event, type) {
    abDragGrabOffset = null;
    try { event.dataTransfer.setData('text/ability-block', type); event.dataTransfer.effectAllowed = 'copy'; } catch (e) {}
}
function handleWorkspaceDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    const workspace = document.getElementById('ab-workspace');
    if (!workspace || !abState) return;
    let type = '', eventType = '', id = '';
    try {
        type = event.dataTransfer.getData('text/ability-block');
        eventType = event.dataTransfer.getData('text/ability-event');
        id = event.dataTransfer.getData('text/ability-block-id') || event.dataTransfer.getData('text/plain') || abDragId || '';
    } catch (e) { id = abDragId || ''; }
    const rect = workspace.getBoundingClientRect();
    // Use the offset captured where the user actually grabbed the block (if
    // any) so it lands under the cursor instead of snapping its top-left
    // corner to a fixed offset regardless of grab point.
    const offset = abDragGrabOffset || { x: 90, y: 24 };
    const x = Math.max(12, event.clientX - rect.left + workspace.scrollLeft - offset.x);
    const y = Math.max(12, event.clientY - rect.top + workspace.scrollTop - offset.y);
    if (eventType) {
        const block = makeEventBlock(eventType);
        if (block) { block.pos = { x, y }; getAbilityRootEvents().push(block); }
    } else if (id) {
        // A block released on the board is explicitly detached from its current
        // event/branch and becomes a loose whiteboard block. This is the
        // inverse of snapping it into a connection slot.
        detachAbilityBlockToBoard(id, x, y);
    } else if (type) {
        const block = type === 'if' ? makeIfBlock() : makeActionBlock(type);
        if (block) { block.pos = { x, y }; getAbilityLooseBlocks().push(block); }
    }
    abDragId = null;
    abDragGrabOffset = null;
    renderAbilityBlockEditor();
}
function allowWorkspaceDrop(event) {
    event.preventDefault();
    try {
        event.dataTransfer.dropEffect = (event.dataTransfer.getData('text/ability-block-id') || abDragId) ? 'move' : 'copy';
    } catch (e) {}
}

// the editor's chrome, built once per session; palette and workspace are
// React from here on, so this markup never needs regenerating (unlike the
// old canvas.innerHTML assignment, which threw away scroll position/dropdowns)
const BOARD_SHELL = `<div class="ab-board-shell">`
    + `<aside class="ab-palette" id="ab-palette-island"></aside>`
    + `<div class="ab-workspace-scroll">`
    + `<div class="ab-workspace" id="ab-workspace" ondragover="allowWorkspaceDrop(event)" ondrop="handleWorkspaceDrop(event)"></div>`
    + `</div></div>`;

function mountAbilityPalette() {
    mountIsland('ab-palette-island', AbilityPalette, {
        kind: abKind,
        tables: { TRIGGERS, ACTIONS, BLOCK_GROUPS, EVENT_GROUP }
    });
}

function mountAbilityBoard() {
    mountIsland('ab-workspace', BlockBoard, {
        events: getAbilityRootEvents(),
        loose: getAbilityLooseBlocks(),
        tables: {
            TRIGGERS, ACTIONS, CONDITIONS, BLOCK_GROUPS,
            // Some parameter dropdowns depend on a sibling parameter's value
            // (which properties a volatile effect exposes, for instance), so the
            // board asks rather than being handed a fixed list.
            resolveOptions: (pdef, values) => pdef.dynamic === 'volatile-property'
                ? volatilePropertyOptions(values.effect || values.volatile || 'stockpile')
                : (pdef.options || [])
        }
    });
}

function addAbilityEvent(trigger) {
    if (!abState || !TRIGGERS[trigger]) return;
    const events = getAbilityRootEvents();
    const block = makeEventBlock(trigger);
    block.pos = { x: 32 + (events.length % 3) * 360, y: 32 + Math.floor(events.length / 3) * 280 };
    events.push(block);
    renderAbilityBlockEditor();
}

function handlePaletteEventDragStart(event, trigger) {
    abDragGrabOffset = null;
    try { event.dataTransfer.setData('text/ability-event', trigger); event.dataTransfer.effectAllowed='copy'; } catch(e) {}
}


function isValidStatementDrop(block, containerId) {
    if (!block) return false;
    if (containerId === 'root') return block.kind === 'event';
    return block.kind === 'action' || block.kind === 'if';
}

function collectDescendantContainerIdsForDrop(block, out = []) {
    if (!block) return out;
    if (block.kind === 'event') { out.push(block.id + ':body'); (block.body || []).forEach(child => collectDescendantContainerIdsForDrop(child, out)); return out; }
    if (block.kind !== 'if') return out;
    out.push(block.id + ':then');
    (block.then || []).forEach(child => collectDescendantContainerIdsForDrop(child, out));
    if (block.else) {
        out.push(block.id + ':else');
        block.else.forEach(child => collectDescendantContainerIdsForDrop(child, out));
    }
    return out;
}

function moveBlockIntoContainer(blockId, containerId, beforeId = null) {
    if (!abState || !blockId || !containerId) return false;
    const block = findAbilityBlock(blockId);
    if (!block || containerId === 'root' && !isValidStatementDrop(block, containerId)) return false;
    if (collectDescendantContainerIdsForDrop(block).includes(containerId)) return false;
    const dest = abContainerRegistry[containerId];
    const loc = locateAbilityBlock(blockId);
    if (!dest || !loc) return false;
    const [item] = loc.list.splice(loc.index, 1);
    let idx = dest.length;
    if (beforeId) {
        const found = dest.findIndex(x => x.id === beforeId);
        if (found >= 0) idx = found;
    }
    // If moving within the same list, account for the removed item.
    if (loc.list === dest && loc.index < idx) idx--;
    dest.splice(Math.max(0, idx), 0, item);
    item.pos = item.pos || { x: 12, y: 12 };
    return true;
}

function handleBlockConnectionDragStart(event, id) {
    abDragId = id;
    // Remember exactly where within the block the user grabbed it, so
    // dropping it lands under the cursor instead of snapping to a fixed
    // offset (which produced the "weird snapping" jump-on-drop bug).
    const rect = event.currentTarget.getBoundingClientRect();
    abDragGrabOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    try {
        event.dataTransfer.setData('text/ability-block-id', id);
        event.dataTransfer.setData('text/plain', id);
        event.dataTransfer.effectAllowed = 'move';
    } catch (e) {}
    const block = getAbilityBlockById(id);
    highlightConnectionTargets(block, true);
    event.currentTarget.classList.add('ab-dragging');
}
function handleBlockConnectionDragEnd(event) {
    event.currentTarget.classList.remove('ab-dragging');
    highlightConnectionTargets(null, false);
    abDragId = null;
    abDragGrabOffset = null;
}

function getDraggedAbilityBlockId(event) {
    if (abDragId) return abDragId;
    try { return event?.dataTransfer?.getData('text/ability-block-id') || ''; } catch (e) { return ''; }
}
function handleConnectionDragOver(event, containerId) {
    event.preventDefault();
    event.stopPropagation();
    const slot = event.currentTarget;
    const type = slot.dataset.accept || 'statement';
    const id = getDraggedAbilityBlockId(event);
    const dragging = id ? getAbilityBlockById(id) : null;
    let paletteType = ''; let paletteEvent = '';
    try { paletteType = event.dataTransfer.getData('text/ability-block'); paletteEvent = event.dataTransfer.getData('text/ability-event'); } catch (e) {}
    const paletteBlock = paletteType ? (paletteType === 'if' ? makeIfBlock() : makeActionBlock(paletteType)) : (paletteEvent ? makeEventBlock(paletteEvent) : null);
    const candidate = dragging || paletteBlock;
    if (candidate && type === 'statement' && isValidStatementDrop(candidate, containerId) && (!dragging || !collectDescendantContainerIdsForDrop(dragging).includes(containerId))) {
        event.dataTransfer.dropEffect = dragging ? 'move' : 'copy';
        slot.classList.add('ab-drop-valid');
        slot.classList.remove('ab-drop-invalid');
    } else {
        event.dataTransfer.dropEffect = 'none';
        slot.classList.add('ab-drop-invalid');
        slot.classList.remove('ab-drop-valid');
    }
}
function handleConnectionDragLeave(event) {
    event.currentTarget.classList.remove('ab-drop-valid','ab-drop-invalid');
}
function handleConnectionDrop(event, containerId) {
    event.preventDefault();
    event.stopPropagation();
    let id = ''; let type = ''; let eventType = '';
    try {
        id = event.dataTransfer.getData('text/ability-block-id') || event.dataTransfer.getData('text/plain');
        type = event.dataTransfer.getData('text/ability-block'); eventType = event.dataTransfer.getData('text/ability-event');
    } catch (e) {}
    if (id) {
        const block = getAbilityBlockById(id);
        if (block && isValidStatementDrop(block, containerId) && !collectDescendantContainerIdsForDrop(block).includes(containerId)) {
            moveBlockIntoContainer(id, containerId);
        }
    } else if (eventType && containerId === 'root') {
        const block = makeEventBlock(eventType); if (block) abContainerRegistry[containerId]?.push(block);
    } else if (type) {
        const block = type === 'if' ? makeIfBlock() : makeActionBlock(type);
        if (block && isValidStatementDrop(block, containerId)) abContainerRegistry[containerId]?.push(block);
    }
    event.currentTarget.classList.remove('ab-drop-valid','ab-drop-invalid');
    abDragId = null;
    renderAbilityBlockEditor();
}

function highlightConnectionTargets(block, active) {
    document.querySelectorAll('.ab-connection-slot').forEach(slot => {
        const cid = slot.dataset.containerId;
        const valid = active && block && isValidStatementDrop(block, cid) && !collectDescendantContainerIdsForDrop(block).includes(cid);
        slot.classList.toggle('ab-connect-available', !!valid);
        slot.classList.toggle('ab-connect-unavailable', !!active && !valid);
    });
}

function renderAbilityTriggerRow() {
    // The old summary/header duplicated information already visible on the
    // whiteboard. Keep the lifecycle hook for compatibility, but render nothing.
    const row = document.getElementById('ability-block-trigger-row');
    if (row) row.innerHTML = '';
}
function updateAbilityEventParam(id, key, rawValue) {
    const ev = findAbilityBlock(id); if (!ev || ev.kind !== 'event') return;
    const p = (TRIGGERS[ev.trigger]?.params || []).find(x => x.key === key);
    ev.triggerParams[key] = p?.type === 'number' ? Number(rawValue) : rawValue; renderAbilityBlockEditor();
}

function updateAbilityBlockPreview() {
    const sdEl = document.getElementById('ability-block-code-sd');
    const esEl = document.getElementById('ability-block-code-es');
    if (!sdEl || !esEl || !abState) return;
    const libAbility = abEntry();
    const previewAbility = { name: libAbility?.name || `Custom${abKindInfo().Noun}`, desc: libAbility?.desc || '', blocks: abState };
    try { sdEl.textContent = compileShowdownAbility(previewAbility) || '// Add some blocks to see generated code.'; }
    catch (e) { sdEl.textContent = '// Could not generate preview: ' + e.message; }
    try { esEl.textContent = compileEssentialsAbility(previewAbility) || '# Add some blocks to see generated code.'; }
    catch (e) { esEl.textContent = '# Could not generate preview: ' + e.message; }
}

function renderAbilityBlockEditor() {
    if (!abState) return;
    renderAbilityTriggerRow();

    // Drop targets are resolved through this registry, so it has to describe the
    // whole tree before anything is drawn -- not as a side effect of drawing it.
    abContainerRegistry = buildContainerRegistry({
        'root-events': getAbilityRootEvents(),
        loose: getAbilityLooseBlocks()
    });

    const canvas = document.getElementById('ability-block-canvas');
    if (canvas && !canvas.querySelector('#ab-workspace')) canvas.innerHTML = BOARD_SHELL;

    mountAbilityPalette();
    mountAbilityBoard();
    updateAbilityBlockPreview();
    setAbilityBlockPreviewTab(abPreviewTab);
}

// Inline event attributes in the rendered block HTML execute in the window scope.
// These functions live in an ES module, so explicitly expose the interaction API.
Object.assign(window, {
    handleConnectionDragOver,
    handleConnectionDragLeave,
    handleConnectionDrop,
    handleBlockConnectionDragStart,
    handleBlockConnectionDragEnd,
    onTopLevelNavigation, hideAbilityBlockEditorForNavigation,
    handlePaletteDragStart, handlePaletteEventDragStart, addAbilityEvent, updateAbilityEventParam,
    handleWorkspaceDrop,
    allowWorkspaceDrop,
    startAbilityBlockMove,
    moveAbilityBlockPointer,
    finishAbilityBlockMove,
    setAbilityBlockTrigger,
    updateAbilityTriggerParam,
    addAbilityBlock,
    removeAbilityBlock,
    moveAbilityBlock,
    updateAbilityBlockParam,
    updateAbilityIfCondition,
    updateAbilityIfCondParam,
    addAbilityElse,
    removeAbilityElse,
    setAbilityBlockPreviewTab
});


export {
    openAbilityBlockEditor, openMoveBlockEditor, openItemBlockEditor, closeAbilityBlockEditor, onTopLevelNavigation, hideAbilityBlockEditorForNavigation, saveAbilityBlockEditor,
    setAbilityBlockTrigger, updateAbilityTriggerParam,
    addAbilityBlock, removeAbilityBlock, moveAbilityBlock,
    updateAbilityBlockParam, updateAbilityIfCondition, updateAbilityIfCondParam,
    addAbilityElse, removeAbilityElse, setAbilityBlockPreviewTab,
    startAbilityBlockMove, moveAbilityBlockPointer, finishAbilityBlockMove,
    handlePaletteDragStart, handlePaletteEventDragStart, handleWorkspaceDrop, allowWorkspaceDrop,
    buildShowdownAbilitiesFile, buildEssentialsAbilitiesFile,
    buildShowdownMovesFile, buildShowdownItemsFile, hasExportableCode,
    compileShowdownAbility, compileShowdownMove, compileShowdownItem, compileEssentialsAbility
};
