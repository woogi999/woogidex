import { log } from './log.js';
import { state, api } from './app.js';
import { POKEMON_TYPES } from './data.js';

// ==================== ability block coding ====================
// a small Scratch-style visual coding surface for writing custom ability
// battle logic. a "program" is a plain-object AST stored on the custom
// ability itself (customAbilities[i].blocks), shaped like:
//
//   { trigger: 'switchIn', triggerParams: {}, body: [ ...blocks ] }
//
// a block is either:
//   { id, kind:'action', action:'boostStat', params:{...} }
//   { id, kind:'if', condition:'hpBelow', condParams:{...}, then:[...], else:null|[...] }
//
// two compilers below turn that AST into real starter code: one shaped
// like a Pokémon Showdown `BattleAbility` handler (abilities.ts), the
// other shaped like a modern (v20/v21-style) Pokémon Essentials
// `Battle::AbilityEffects` handler. Both are meant as a strong first draft
// to drop into a project and tweak, the same way this app's other exports
// already tell people to expect for anything mechanically custom.

// ==================== small helpers ====================
function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
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
// Volatiles are deliberately a catalog rather than free-text fields.  Each
// entry can also describe which state properties the effect exposes, so the
// generic battle-effect condition/action blocks can inspect things like
// Stockpile's layer count without needing a one-off Stockpile block.
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
const TRIGGERS = {
    switchIn: {
        label: 'This Pokémon switches in', icon: 'log-in', params: [],
        allowed: ['boostStat', 'dealDamage', 'healDamage', 'setStatus', 'cureStatus', 'setWeather', 'setTerrain', 'changeType', 'addVolatile', 'removeVolatile', 'setShield', 'showMessage'],
        sd: () => ({ header: 'onStart(pokemon) {', footer: '}', selfVar: 'pokemon', foeVar: 'foe', moveVar: null, preamble: 'const foe = pokemon.side.foe.active[0];' }),
        es: () => ({ adder: 'Battle::AbilityEffects::OnSwitchIn', args: 'ability, battler', selfVar: 'battler', foeVar: 'foe', moveVar: null, preamble: 'foe = battler.pbDirectOpposing rescue nil', footer: null })
    },
    statModify: {
        label: 'Calculating one of this Pokémon\u2019s stats', icon: 'trending-up',
        params: [{ key: 'stat', label: 'Stat', type: 'select', options: STATS.map(s => ({ value: s.id, label: s.label })), default: 'atk' }],
        allowed: ['multiplyStat', 'boostStat', 'healDamage', 'setStatus', 'showMessage'],
        sd: (ast) => ({ header: `onModify${cap(ast.triggerParams.stat || 'atk')}(value, pokemon, target, move) {`, footer: 'return value;\n\t\t}', selfVar: 'pokemon', foeVar: 'target', moveVar: 'move', preamble: '' }),
        es: (ast) => ({ adder: 'Battle::AbilityEffects::StatCalcFromAbility', args: 'ability, battler, stat, stageMul, stageDiv, value', selfVar: 'battler', foeVar: 'nil', moveVar: null, preamble: `next value if stat != :${STAT_ESSENTIALS[ast.triggerParams.stat || 'atk']}`, footer: 'next value' })
    },
    damagingHit: {
        label: 'This Pokémon is hit by a damaging move', icon: 'sword', params: [],
        allowed: ['boostStat', 'dealDamage', 'healDamage', 'setStatus', 'cureStatus', 'changeType', 'addVolatile', 'removeVolatile', 'setShield', 'showMessage'],
        sd: () => ({ header: 'onDamagingHit(damage, target, source, move) {', footer: '}', selfVar: 'target', foeVar: 'source', moveVar: 'move', preamble: '' }),
        es: () => ({ adder: 'Battle::AbilityEffects::AfterMoveUseFromTarget', args: 'ability, user, target, move, switchedBattlers, hpLost', selfVar: 'target', foeVar: 'user', moveVar: 'move', preamble: '', footer: null })
    },
    residual: {
        label: 'The end of each turn', icon: 'clock', params: [],
        allowed: ['boostStat', 'dealDamage', 'healDamage', 'setWeather', 'setTerrain', 'setStatus', 'cureStatus', 'changeType', 'addVolatile', 'removeVolatile', 'showMessage'],
        sd: () => ({ header: 'onResidual(pokemon) {', footer: '}', selfVar: 'pokemon', foeVar: 'foe', moveVar: null, preamble: 'const foe = pokemon.side.foe.active[0];' }),
        es: () => ({ adder: 'Battle::AbilityEffects::EndOfRoundEffect', args: 'ability, battler', selfVar: 'battler', foeVar: 'foe', moveVar: null, preamble: 'foe = battler.pbDirectOpposing rescue nil', footer: null })
    },
    moveImmunity: {
        label: 'This Pokémon is hit by a move of a chosen type', icon: 'shield',
        params: [{ key: 'type', label: 'Move Type', type: 'select', options: POKEMON_TYPES.map(t => ({ value: t, label: t })), default: 'Electric' }],
        allowed: ['boostStat', 'healDamage', 'setStatus', 'cureStatus', 'changeType', 'addVolatile', 'removeVolatile', 'showMessage'],
        sd: (ast) => ({ header: `onTryHit(target, source, move) {\n\t\t\tif (move.type !== '${ast.triggerParams.type || 'Electric'}') return;`, footer: 'return null;\n\t\t}', selfVar: 'target', foeVar: 'source', moveVar: 'move', preamble: '' }),
        es: (ast) => ({ adder: 'Battle::AbilityEffects::MoveImmunity', args: 'ability, user, target, move', selfVar: 'target', foeVar: 'user', moveVar: 'move', preamble: `next false if move.type != :${(ast.triggerParams.type || 'ELECTRIC').toUpperCase()}`, footer: 'next true' })
    },
    damageModify: {
        label: 'Calculating a move\u2019s damage', icon: 'percent',
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

Object.assign(CONDITIONS, {
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
    { label:'Battle Actions', color:'blue', items:['damage','heal','boostStat','setStatus','inflictStatus','changeType','changeAbility','changeForm','switchPokemon','setWeather','setTerrain','setWeatherTerrain','setHazard','removeHazard','clearTerrainWeather','changePriority','addVolatile','setVolatile','removeVolatile','setShield','multiplyStat','multiplyDamage','changeTypeToMoveType','resetStatStages','copyStatStages','setAbility','suppressAbility'] },
    { label:'Battle Effects', color:'blue', items:['applyBattleEffect','removeBattleEffect','setBattleEffectProperty'] },
    { label:'Other / Output', color:'gray', items:['cureStatus','showMessage','dealDamage','healDamage','setWeather','setTerrain','changeType'] }
];
const EVENT_GROUP = { label:'Events', color:'gold', items:['battleStart','switchInOut','turnStartEnd','beforeMove','onMove','onDamage','onDamagingHit','onFaint','onStatus','afterMove','onCriticalHit','onContact'] };
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
function findBlock(list, id) { const loc = locateBlock(list, id); return loc ? loc.list[loc.index] : null; }
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
        }
    });
    return lines;
}

function getAbilityEvents(ast) {
    if (Array.isArray(ast?.triggers)) return ast.triggers;
    if (ast?.trigger && TRIGGERS[ast.trigger]) return [{ kind:'event', trigger:ast.trigger, triggerParams:ast.triggerParams || {}, body:ast.body || [] }];
    return [];
}
function compileShowdownEvent(ev) {
    const def = TRIGGERS[ev.trigger]; if (!def) return '';
    const t = def.sd(ev); const ctx = { selfVar:t.selfVar, foeVar:t.foeVar, moveVar:t.moveVar };
    const body = compileBody(ev.body || [], ctx, 'sd', 3);
    const preamble = t.preamble ? `\t\t\t${t.preamble}\n` : '';
    return `\t\t${t.header}\n${preamble}${body.length ? body.join('\n') : '\t\t\t// (empty event)'}\n\t\t${t.footer}`;
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
    if (!events.length) return null;
    const id = toShowdownAbilityId(ability.name);
    const desc = String(ability.desc || '').replace(/"/g, '\\"');
    const groups = new Map();
    events.forEach(ev => {
        const def = TRIGGERS[ev.trigger]; if (!def) return;
        const t = def.sd(ev); const ctx = { selfVar:t.selfVar, foeVar:t.foeVar, moveVar:t.moveVar };
        const body = compileBody(ev.body || [], ctx, 'sd', 3);
        const key = `${t.header}|||${t.footer}`;
        if (!groups.has(key)) groups.set(key, { t, bodies: [] });
        groups.get(key).bodies.push(...body);
        if (t.preamble) groups.get(key).preamble = t.preamble;
    });
    const handlers = [...groups.values()].map(({t,bodies,preamble}) => {
        const pre = preamble ? `\t\t\t${preamble}\n` : '';
        return `\t\t${t.header}\n${pre}${bodies.length ? bodies.join('\n') : '\t\t\t// (empty event)'}\n\t\t${t.footer}`;
    }).join('\n\n');
    return `\t${id || 'customability'}: {\n\t\tname: "${String(ability.name || '').replace(/"/g, '\\"')}",\n\t\tshortDesc: "${desc}",\n${handlers}\n\t},`;
}

function compileEssentialsAbility(ability) {
    const ast = ability && ability.blocks; const events = getAbilityEvents(ast);
    if (!events.length) return null;
    return events.map((ev,i)=>compileEssentialsEvent(ev,i)).filter(Boolean).join('\n\n');
}

function collectUsedCustomAbilitiesWithCode(fakemonList) {
    const seen = new Map();
    (fakemonList || []).forEach(f => (f.abilities || []).forEach(a => {
        if (a && (a.source === 'custom' || a.custom) && a.customId) {
            const lib = (state.customAbilities || []).find(x => x.id === a.customId);
            if (lib && lib.blocks && ((Array.isArray(lib.blocks.triggers) && lib.blocks.triggers.length) || lib.blocks.trigger) && !seen.has(lib.id)) seen.set(lib.id, lib);
        }
    }));
    return [...seen.values()];
}

function buildShowdownAbilitiesFile(fakemonList) {
    const abilities = collectUsedCustomAbilitiesWithCode(fakemonList);
    if (!abilities.length) return null;
    const entries = abilities.map(compileShowdownAbility).filter(Boolean);
    if (!entries.length) return null;
    return `// Made with Woogidex! Ability logic generated from the ability block editor.\n// Drop this into data/mods/<modname>/abilities.ts alongside pokedex.ts.\n// This is a strong starting point - read it over before using it live.\nexport const Abilities: {[k: string]: Partial<import('../../../sim/dex-abilities').AbilityData>} = {\n${entries.join('\n')}\n};\n`;
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
let abAbilityId = null;   // customAbilities[].id currently being edited
let abContainerRegistry = {};
let abDragId = null;
let abDragGrabOffset = null; // where the cursor grabbed the currently-dragged block, relative to its top-left
let abPreviewTab = 'sd';
let abPrevViewId = null;  // which top-level view ('editor-view' / 'collection-view') to restore on close

// opens the ability block editor as its own full page/view - the same way
// clicking a Fakemon swaps the collection view out for the editor view -
// rather than as a small modal. the ability library modal (where the button
// lives) is closed first and reopened again once the user backs out, so the
// name/description fields are still right there to keep editing.
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

function openAbilityBlockEditor(customAbilityId) {
    if (!customAbilityId) { api.showToast('Save the ability first, then add its battle code.', 'info'); return; }
    const ability = (state.customAbilities || []).find(a => a.id === customAbilityId);
    if (!ability) { api.showToast('Could not find that ability.', 'error'); return; }
    abAbilityId = customAbilityId;
    abState = normalizeAbilityBlocks(ability.blocks);
    getAbilityRootEvents().forEach(ev => normalizeAbilityIfBranches(ev.body));
    abPreviewTab = 'sd';

    document.getElementById('custom-ability-modal')?.classList.remove('active');
    document.getElementById('custom-entity-chooser-modal')?.classList.remove('active');
    abPrevViewId = document.getElementById('editor-view') && document.getElementById('editor-view').style.display !== 'none' ? 'editor-view' : 'collection-view';
    // Entering the ability editor is itself a top-level navigation transition,
    // but we must preserve this editor's state while activating its view.
    const view = api.activateTopLevelView?.('ability-block-editor-view', { preserveAbilityEditor: true })
        || document.getElementById('ability-block-editor-view');
    if (view) view.style.display = 'block';

    const titleEl = document.getElementById('ability-block-editor-title');
    if (titleEl) titleEl.textContent = `Code "${ability.name}"`;
    renderAbilityBlockEditor();
    api.setRoute?.(`ability-editor/${encodeURIComponent(customAbilityId)}`, `Code ${ability.name}`);
    if (typeof lucide !== 'undefined') lucide.createIcons();
    requestAnimationFrame(updateAbilityBoardConnections);
}
function onTopLevelNavigation() {
    // Called by the central app navigator whenever another full-page route is
    // activated. This is deliberately a lifecycle hook rather than something
    // every sidebar button has to know about. The editor's Back button uses
    // closeAbilityBlockEditor() instead, so it can restore the ability library.
    const view = document.getElementById('ability-block-editor-view');
    if (!view || view.style.display === 'none') return;
    view.style.display = 'none';
    document.getElementById('custom-ability-modal')?.classList.remove('active');
    document.getElementById('custom-entity-chooser-modal')?.classList.remove('active');
    abState = null;
    abAbilityId = null;
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
    // hop back into the ability library modal so the user can keep editing
    // the name/description right where they left off.
    if (abAbilityId) api.openCustomAbilityLibraryModal?.(abAbilityId);
    abState = null; abAbilityId = null; abContainerRegistry = {}; abPrevViewId = null;
}
function saveAbilityBlockEditor() {
    if (!abState || !abAbilityId) return;
    const ability = (state.customAbilities || []).find(a => a.id === abAbilityId);
    if (!ability) return;
    ability.blocks = JSON.parse(JSON.stringify(normalizeAbilityBlocks(abState)));
    api.saveToStorage?.();
    api.showToast?.('Ability battle code saved!', 'success');
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
function deleteAbilityBlockById(id) {
    return removeAbilityBlock(id);
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
function disconnectAbilityBlock(id) {
    if (!abState || !id) return false;
    const block = findAbilityBlock(id);
    const loc = locateAbilityBlock(id);
    if (!block || !loc) return false;

    const workspace = document.getElementById('ab-workspace');
    const el = document.querySelector(`.ab-block[data-id="${CSS.escape(id)}"]`);

    let x = block.pos?.x || 24;
    let y = block.pos?.y || 24;

    if (workspace && el) {
        const wr = workspace.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        x = er.left - wr.left + workspace.scrollLeft;
        y = er.top - wr.top + workspace.scrollTop;
    }

    const changed = detachAbilityBlockToBoard(id, x, y);
    if (changed) {
        renderAbilityBlockEditor();
        requestAnimationFrame(updateAbilityBoardConnections);
    }
    return changed;
}

function detachAbilityBlockToBoard(id, x, y) {
    if (!abState || !id) return false;
    const block = findAbilityBlock(id);
    const loc = locateAbilityBlock(id);
    if (!block || !loc) return false;
    // Event blocks already live directly on the board (in the root events
    // list) — dragging one around the workspace should just reposition it,
    // never demote it into the loose/unattached list, or it stops being
    // recognized as an event trigger.
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
function renderParamControl(pdef, value, onChangeAttr, currentValues = {}) {
    if (pdef.type === 'select' || pdef.type === 'dynamic-select') {
        let options = pdef.options || [];
        if (pdef.dynamic === 'volatile-property') options = volatilePropertyOptions(currentValues.effect || currentValues.volatile || 'stockpile');
        const opts = options.map(o => `<option value="${escapeHtml(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
        return `<select class="ab-inline-input" onchange="${onChangeAttr}" onclick="event.stopPropagation()">${opts}</select>`;
    }
    if (pdef.type === 'number') {
        return `<input type="number" class="ab-inline-input ab-inline-number" value="${value}" ${pdef.min !== undefined ? `min="${pdef.min}"` : ''} ${pdef.max !== undefined ? `max="${pdef.max}"` : ''} ${pdef.step ? `step="${pdef.step}"` : ''} onchange="${onChangeAttr}" onclick="event.stopPropagation()">`;
    }
    return `<input type="text" class="ab-inline-input ab-inline-text" value="${escapeHtml(value ?? '')}" onchange="${onChangeAttr}" onclick="event.stopPropagation()">`;
}
function renderParamLabel(template, paramDefs, values, onChangeAttrBuilder) {
    let i = 0;
    const parts = template.split('__');
    return parts.map((chunk, idx) => {
        if (idx === parts.length - 1) return escapeHtml(chunk);
        const pdef = paramDefs[i]; i++;
        if (!pdef) return escapeHtml(chunk);
        const control = renderParamControl(pdef, (values || {})[pdef.key], onChangeAttrBuilder(pdef.key), values || {});
        return escapeHtml(chunk) + control;
    }).join('');
}


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
// Blocks are placed on a persistent Scratch/whiteboard-style workspace. Their
// visual x/y position is presentation-only; the AST array still controls
// execution order, so moving a block around never silently changes behavior.
let abPointerDrag = null;

function ensureBlockPosition(block, index = 0, depth = 0) {
    if (!block.pos || !Number.isFinite(Number(block.pos.x)) || !Number.isFinite(Number(block.pos.y))) {
        const col = index % 3;
        const row = Math.floor(index / 3);
        block.pos = {
            x: depth ? 12 : 28 + col * 230,
            y: depth ? 12 + row * 96 : 28 + row * 118
        };
    }
    block.pos.x = Number(block.pos.x) || 0;
    block.pos.y = Number(block.pos.y) || 0;
    return block.pos;
}

function getAbilityBlockById(id) {
    return abState ? findAbilityBlock(id) : null;
}

function getAbilityBlockParentContainer(blockId) {
    const loc = locateAbilityBlock(blockId);
    return loc ? loc.list : null;
}

function getAbilityDragSurface(containerId) {
    if (containerId === 'root') return document.getElementById('ab-workspace');
    return document.querySelector(`.ab-container[data-container-id="${CSS.escape(containerId)}"]`);
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

function renderPalette(allowed) {
    const eventItems = EVENT_GROUP.items.filter(key => TRIGGERS[key]);
    return `<aside class="ab-palette">
        <div class="ab-palette-title">Blocks</div>
        <div class="ab-palette-help">Drag orange Events onto the board. Each event gets its own Scratch-style stack, so one ability can react to many triggers.</div>
        <div class="ab-palette-group ab-palette-events"><div class="ab-palette-label">Events</div>${eventItems.map(key => {
            const t = TRIGGERS[key];
            return `<button type="button" draggable="true" class="ab-palette-item ab-event-item" ondragstart="handlePaletteEventDragStart(event,'${key}')" onclick="event.stopPropagation(); addAbilityEvent('${key}')"><span class="ab-palette-dot"></span>${escapeHtml(t.label)}</button>`;
        }).join('')}</div>
        ${BLOCK_GROUPS.map(group => {
            const items = group.items.filter(type => type === 'if' ? true : !!ACTIONS[type]);
            if (!items.length) return '';
            return `<div class="ab-palette-group"><div class="ab-palette-label">${escapeHtml(group.label)}</div>${items.map(type => {
                const label = type === 'if' ? 'If / Else' : (ACTIONS[type]?.label || type).replace(/__+/g, '…');
                return `<button type="button" draggable="true" class="ab-palette-item ab-palette-${group.color}" ondragstart="handlePaletteDragStart(event,'${type}')" onclick="addAbilityBlock('root','${type}')"><span class="ab-palette-dot"></span>${escapeHtml(label)}</button>`;
            }).join('')}</div>`;
        }).join('')}
        <div class="ab-palette-tip"><strong>Tip</strong><br>Events are executable roots. Drag actions into an event stack. Add as many event triggers as you need.</div>
    </aside>`;
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

function getConnectionType(block) {
    if (!block) return 'statement';
    if (block.kind === 'if') return 'control';
    return 'statement';
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

function renderConnectionSlot(containerId, label = 'Drop a block here') {
    return `<div class="ab-connection-slot" data-container-id="${escapeHtml(containerId)}" data-accept="statement" ondragover="handleConnectionDragOver(event,'${containerId}')" ondragleave="handleConnectionDragLeave(event)" ondrop="handleConnectionDrop(event,'${containerId}')"><span class="ab-slot-notch"></span><span>${escapeHtml(label)}</span></div>`;
}

function renderContainer(list, containerId, allowed, depth) {
    abContainerRegistry[containerId] = list;
    const free = containerId === 'root';
    list.forEach((b, i) => ensureBlockPosition(b, i, depth));
    const blocksHtml = list.map((b, i) => renderBlock(b, allowed, depth, containerId, i)).join('');
    // Root is an open whiteboard, while nested containers expose a real Scratch-like socket.
    return `<div class="ab-container ${free ? 'ab-free-container' : 'ab-nested-container'}" data-container-id="${escapeHtml(containerId)}" data-depth="${depth}">${blocksHtml}${free ? '' : renderConnectionSlot(containerId, list.length ? 'Drop another block here' : 'Drop a block inside')}</div>`;
}

function getBlockCategory(action) {
    for (const group of BLOCK_GROUPS) if (group.items.includes(action)) return group.label;
    return ACTIONS[action]?.category || 'Battle Actions';
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

function renderEventBlock(block, index) {
    const def = TRIGGERS[block.trigger]; if (!def) return '';
    ensureBlockPosition(block, index, 0);
    const params = (def.params || []).map(p => renderParamControl(p, (block.triggerParams || {})[p.key], `updateAbilityEventParam('${block.id}','${p.key}',this.value)`)).join(' ');
    return `<div class="ab-block ab-event-block" data-id="${block.id}" draggable="false" onpointerdown="startAbilityBlockMove(event,'${block.id}','root')" ondragstart="handleBlockConnectionDragStart(event,'${block.id}')" ondragend="handleBlockConnectionDragEnd(event)" ondragover="allowWorkspaceDrop(event)" ondrop="handleWorkspaceDrop(event)" style="left:${block.pos.x}px;top:${block.pos.y}px">
        <div class="ab-trigger-hat"><span class="ab-block-drag"><i data-lucide="grip-vertical"></i></span><i data-lucide="${def.icon || 'zap'}"></i><strong>When</strong><span>${escapeHtml(def.label)}</span>${params}<span class="ab-block-controls"><button type="button" title="Delete event" onclick="event.stopPropagation(); removeAbilityBlock('${block.id}')"><i data-lucide="trash-2"></i></button></span></div>
        <div class="ab-event-body">${renderContainer(block.body || [], block.id + ':body', Object.keys(ACTIONS), 1)}</div>
    </div>`;
}

function renderActionBlock(block, containerId, index) {
    const def = ACTIONS[block.action]; if (!def) return '';
    ensureBlockPosition(block, index, containerId === 'root' ? 0 : 1);
    const labelHtml = renderParamLabel(def.label, def.params, block.params, (key) => `updateAbilityBlockParam('${block.id}','${key}',this.value)`);
    return `<div class="ab-block ab-action-block ab-category-${escapeHtml(getBlockCategory(block.action)).toLowerCase().replace(/[^a-z0-9]+/g,'-')}" data-id="${block.id}" draggable="false" onpointerdown="startAbilityBlockMove(event,'${block.id}','${containerId}')" ondragstart="handleBlockConnectionDragStart(event,'${block.id}')" ondragend="handleBlockConnectionDragEnd(event)" ondragover="allowWorkspaceDrop(event)" ondrop="handleWorkspaceDrop(event)" ${containerId === 'root' || containerId === 'loose' || containerId === 'root-events' ? `style=\"left:${block.pos.x}px;top:${block.pos.y}px\"` : ''}>
        <div class="ab-block-main">
            <span class="ab-block-drag" title="Drag anywhere on the block"><i data-lucide="grip-vertical"></i></span>
            <span class="ab-block-text"><strong class="ab-block-kind">${escapeHtml(getBlockCategory(block.action))}</strong> ${labelHtml}</span>
            <span class="ab-block-controls">
                <button type="button" title="Move earlier" onclick="event.stopPropagation(); moveAbilityBlock('${block.id}',-1)"><i data-lucide="chevron-up"></i></button>
                <button type="button" title="Move later" onclick="event.stopPropagation(); moveAbilityBlock('${block.id}',1)"><i data-lucide="chevron-down"></i></button>
                <button type="button" title="Delete block" onclick="event.stopPropagation(); removeAbilityBlock('${block.id}')"><i data-lucide="trash-2"></i></button>
            </span>
        </div>
        <span class="ab-block-bottom-connector" aria-hidden="true"></span>
    </div>`;
}

function renderIfBlock(block, allowed, depth, containerId, index) {
    const def = CONDITIONS[block.condition] || CONDITIONS[Object.keys(CONDITIONS)[0]];
    ensureBlockPosition(block, index, containerId === 'root' ? 0 : 1);
    const condSelect = `<select class="ab-inline-input" onchange="updateAbilityIfCondition('${block.id}',this.value)" onclick="event.stopPropagation()">${Object.entries(CONDITIONS).map(([key, c]) => `<option value="${key}" ${key === block.condition ? 'selected' : ''}>${escapeHtml(c.label.replace(/__/g, '\u2026'))}</option>`).join('')}</select>`;
    const paramControls = (def.params || []).map(p => renderParamControl(p, (block.condParams || {})[p.key], `updateAbilityIfCondParam('${block.id}','${p.key}',this.value)`)).join(' ');
    const elseToggle = '';
    if (!Array.isArray(block.else)) block.else = [];
    return `<div class="ab-block ab-if-block" data-id="${block.id}" draggable="false" onpointerdown="startAbilityBlockMove(event,'${block.id}','${containerId}')" ondragstart="handleBlockConnectionDragStart(event,'${block.id}')" ondragend="handleBlockConnectionDragEnd(event)" ondragover="allowWorkspaceDrop(event)" ondrop="handleWorkspaceDrop(event)" ${containerId === 'root' || containerId === 'loose' || containerId === 'root-events' ? `style=\"left:${block.pos.x}px;top:${block.pos.y}px\"` : ''}>
        <span class="ab-block-top-connector" aria-hidden="true"></span>
        <div class="ab-block-main">
            <span class="ab-block-drag" title="Drag anywhere on the block"><i data-lucide="grip-vertical"></i></span>
            <span class="ab-block-text"><strong class="ab-block-kind">Control</strong> If ${condSelect} ${paramControls}</span>
            <span class="ab-block-controls">
                <button type="button" title="Move earlier" onclick="event.stopPropagation(); moveAbilityBlock('${block.id}',-1)"><i data-lucide="chevron-up"></i></button>
                <button type="button" title="Move later" onclick="event.stopPropagation(); moveAbilityBlock('${block.id}',1)"><i data-lucide="chevron-down"></i></button>
                <button type="button" title="Delete block" onclick="event.stopPropagation(); removeAbilityBlock('${block.id}')"><i data-lucide="trash-2"></i></button>
            </span>
        </div>
        <div class="ab-if-then"><span class="ab-if-label">then</span>${renderContainer(block.then, block.id + ':then', allowed, depth + 1)}</div>
        <div class="ab-if-else"><span class="ab-if-label">else</span>${renderContainer(block.else, block.id + ':else', allowed, depth + 1)}</div>
        <span class="ab-block-bottom-connector" aria-hidden="true"></span>
    </div>`;
}
function renderBlock(block, allowed, depth, containerId, index) {
    if (block.kind === 'event') return renderEventBlock(block, index);
    if (block.kind === 'action') return renderActionBlock(block, containerId, index);
    if (block.kind === 'if') return renderIfBlock(block, allowed, depth, containerId, index);
    return '';
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
    const libAbility = (state.customAbilities || []).find(a => a.id === abAbilityId);
    const previewAbility = { name: libAbility?.name || 'CustomAbility', desc: libAbility?.desc || '', blocks: abState };
    try { sdEl.textContent = compileShowdownAbility(previewAbility) || '// Add some blocks to see generated code.'; }
    catch (e) { sdEl.textContent = '// Could not generate preview: ' + e.message; }
    try { esEl.textContent = compileEssentialsAbility(previewAbility) || '# Add some blocks to see generated code.'; }
    catch (e) { esEl.textContent = '# Could not generate preview: ' + e.message; }
}

function updateAbilityBoardConnections() {
    const workspace = document.getElementById('ab-workspace');
    const svg = document.getElementById('ab-board-connections');
    if (!workspace || !svg || !abState) return;
    const blocks = getAbilityRootEvents();
    const rootRect = workspace.getBoundingClientRect();
    const paths = [];
    for (let i = 0; i < blocks.length - 1; i++) {
        const a = workspace.querySelector(`.ab-block[data-id=\"${CSS.escape(blocks[i].id)}\"]`);
        const b = workspace.querySelector(`.ab-block[data-id=\"${CSS.escape(blocks[i + 1].id)}\"]`);
        if (!a || !b) continue;
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        const x1 = ar.left - rootRect.left + ar.width / 2;
        const y1 = ar.top - rootRect.top + ar.height;
        const x2 = br.left - rootRect.left + br.width / 2;
        const y2 = br.top - rootRect.top;
        const mid = y1 + Math.max(18, (y2 - y1) / 2);
        paths.push(`<path d=\"M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}\" class=\"ab-connector-line\" marker-end=\"url(#ab-arrow)\" />`);
    }
    svg.innerHTML = `<defs><marker id=\"ab-arrow\" viewBox=\"0 0 10 10\" refX=\"8\" refY=\"5\" markerWidth=\"5\" markerHeight=\"5\" orient=\"auto-start-reverse\"><path d=\"M 0 0 L 10 5 L 0 10 z\" fill=\"currentColor\"/></marker></defs>${paths.join('')}`;
}

function renderAbilityBlockEditor() {
    if (!abState) return;
    renderAbilityTriggerRow();
    abContainerRegistry = {};
    const canvas = document.getElementById('ability-block-canvas');
    if (canvas) {
        const allowed = Object.keys(ACTIONS);
        const loose = getAbilityLooseBlocks();
        abContainerRegistry['root-events'] = getAbilityRootEvents();
        abContainerRegistry['loose'] = loose;
        const eventHtml = getAbilityRootEvents().map((b,i) => renderBlock(b, allowed, 0, 'root-events', i)).join('');
        const looseHtml = loose.map((b,i) => renderBlock(b, allowed, 0, 'loose', i)).join('');
        canvas.innerHTML = `<div class="ab-board-shell">${renderPalette(allowed)}<div class="ab-workspace-scroll"><div class="ab-workspace" id="ab-workspace" ondragover="allowWorkspaceDrop(event)" ondrop="handleWorkspaceDrop(event)"><svg class="ab-board-connections" id="ab-board-connections" aria-hidden="true"></svg><div class="ab-container ab-event-root-container" data-container-id="root-events">${eventHtml}</div><div class="ab-container ab-loose-container" data-container-id="loose">${looseHtml}</div></div></div></div>`;
    }
    updateAbilityBlockPreview();
    setAbilityBlockPreviewTab(abPreviewTab);
    if (typeof lucide !== 'undefined') lucide.createIcons();
    requestAnimationFrame(updateAbilityBoardConnections);
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
    openAbilityBlockEditor, closeAbilityBlockEditor, onTopLevelNavigation, hideAbilityBlockEditorForNavigation, saveAbilityBlockEditor,
    setAbilityBlockTrigger, updateAbilityTriggerParam,
    addAbilityBlock, removeAbilityBlock, moveAbilityBlock,
    updateAbilityBlockParam, updateAbilityIfCondition, updateAbilityIfCondParam,
    addAbilityElse, removeAbilityElse, setAbilityBlockPreviewTab,
    startAbilityBlockMove, moveAbilityBlockPointer, finishAbilityBlockMove,
    handlePaletteDragStart, handlePaletteEventDragStart, handleWorkspaceDrop, allowWorkspaceDrop,
    buildShowdownAbilitiesFile, buildEssentialsAbilitiesFile,
    compileShowdownAbility, compileEssentialsAbility
};
