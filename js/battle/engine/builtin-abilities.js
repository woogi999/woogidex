// ==================== standard ability runtime ====================
// Built-in implementations for well-known Showdown-style abilities, using the
// engine's own event seam (see battle.js runEvent). Custom block-built
// abilities keep flowing through compileProgram(); this table covers the rest.
import { toId } from './dex.js';

// runEvent only hands us the defender's ctx, so recover the attacker from the battle sides
function attackerOf(ctx) {
    const foe = ctx.battle.foeOf(ctx.self);
    return foe && !foe.fainted ? foe : null;
}

const VALUE_EVENTS = new Set(['modifyDamageDealt', 'modifyDamageTaken', 'modifyStat', 'modifyAccuracy', 'ignoreBoosts']);

const ABILITY_IMPLS = {
    // ---------- type immunity on being targeted ----------
    levitate: {
        tryHit: (_p, ctx) => {
            if (ctx.move?.type === 'Ground') {
                ctx.battle.add('-immune', ctx.battle.ref(ctx.self), 'Levitate');
                ctx.immune = true;
            }
        }
    },
    flashfire: {
        tryHit: (_p, ctx) => {
            if (ctx.move?.type === 'Fire') {
                ctx.battle.addVolatile(ctx.self, 'flashfire');
                ctx.battle.add('-message', 'It was drawn into the Flash Fire!');
                ctx.immune = true;
            }
        }
    },
    waterabsorb: {
        tryHit: (_p, ctx) => {
            if (ctx.move?.type === 'Water') {
                ctx.battle.heal(Math.floor(ctx.self.maxhp / 4), ctx.self, 'Water Absorb');
                ctx.immune = true;
            }
        }
    },
    dryskin: {
        tryHit: (_p, ctx) => {
            if (ctx.move?.type === 'Water') {
                ctx.battle.heal(Math.floor(ctx.self.maxhp / 4), ctx.self, 'Dry Skin');
                ctx.immune = true;
            }
        },
        residual: (_p, ctx) => {
            if (ctx.battle.field.weather === 'Sun') ctx.battle.damage(Math.floor(ctx.self.maxhp / 8), ctx.self, null, 'Dry Skin');
            else if (ctx.battle.field.weather === 'Rain') ctx.battle.heal(Math.floor(ctx.self.maxhp / 8), ctx.self, 'Dry Skin');
        }
    },
    voltabsorb: {
        tryHit: (_p, ctx) => {
            if (ctx.move?.type === 'Electric') {
                ctx.battle.heal(Math.floor(ctx.self.maxhp / 4), ctx.self, 'Volt Absorb');
                ctx.immune = true;
            }
        }
    },
    motordrive: {
        tryHit: (_p, ctx) => {
            if (ctx.move?.type === 'Electric') {
                ctx.battle.boost(ctx.self, { spe: 1 }, ctx.self, 'Motor Drive');
                ctx.immune = true;
            }
        }
    },
    lightningrod: {
        tryHit: (_p, ctx) => {
            if (ctx.move?.type === 'Electric') {
                ctx.battle.boost(ctx.self, { spa: 1 }, ctx.self, 'Lightning Rod');
                ctx.immune = true;
            }
        }
    },
    stormdrain: {
        tryHit: (_p, ctx) => {
            if (ctx.move?.type === 'Water') {
                ctx.battle.boost(ctx.self, { spa: 1 }, ctx.self, 'Storm Drain');
                ctx.immune = true;
            }
        }
    },

    // ---------- damage reduction ----------
    thickfat: {
        modifyDamageTaken: (_p, ctx) =>
            (ctx.move && (ctx.move.type === 'Fire' || ctx.move.type === 'Ice')) ? Math.floor(ctx.value * 0.5) : ctx.value
    },
    heatproof: {
        modifyDamageTaken: (_p, ctx) => (ctx.move?.type === 'Fire' ? Math.floor(ctx.value * 0.5) : ctx.value)
    },

    // ---------- contact punishment ----------
    static: {
        damagingHit: (_p, ctx) => {
            const atk = attackerOf(ctx);
            if (ctx.move?.flags?.contact && atk && ctx.battle.rng.chance(30, 100)) ctx.battle.trySetStatus(atk, 'par', ctx.self, 'Static');
        }
    },
    flamebody: {
        damagingHit: (_p, ctx) => {
            const atk = attackerOf(ctx);
            if (ctx.move?.flags?.contact && atk && ctx.battle.rng.chance(30, 100)) ctx.battle.trySetStatus(atk, 'brn', ctx.self, 'Flame Body');
        }
    },
    poisonpoint: {
        damagingHit: (_p, ctx) => {
            const atk = attackerOf(ctx);
            if (ctx.move?.flags?.contact && atk && ctx.battle.rng.chance(30, 100)) ctx.battle.trySetStatus(atk, 'psn', ctx.self, 'Poison Point');
        }
    },
    effectspore: {
        damagingHit: (_p, ctx) => {
            const atk = attackerOf(ctx);
            if (!ctx.move?.flags?.contact || !atk || !ctx.battle.rng.chance(30, 100)) return;
            const roll = ctx.battle.rng.random(3);
            ctx.battle.trySetStatus(atk, ['psn', 'par', 'slp'][roll], ctx.self, 'Effect Spore');
        }
    },
    cutecharm: {
        damagingHit: (_p, ctx) => {
            const atk = attackerOf(ctx);
            if (ctx.move?.flags?.contact && atk && ctx.battle.rng.chance(30, 100)) ctx.battle.boost(atk, { atk: -1 }, ctx.self, 'Cute Charm');
        }
    },
    roughskin: {
        damagingHit: (_p, ctx) => {
            const atk = attackerOf(ctx);
            if (ctx.move?.flags?.contact && atk) ctx.battle.damage(Math.max(1, Math.floor(atk.maxhp / 8)), atk, ctx.self, 'Rough Skin');
        }
    },
    ironbarbs: {
        damagingHit: (_p, ctx) => {
            const atk = attackerOf(ctx);
            if (ctx.move?.flags?.contact && atk) ctx.battle.damage(Math.max(1, Math.floor(atk.maxhp / 8)), atk, ctx.self, 'Iron Barbs');
        }
    },

    // ---------- stat stages ----------
    intimidate: {
        switchIn: (_p, ctx) => { if (ctx.foe) ctx.battle.boost(ctx.foe, { atk: -1 }, ctx.self, 'Intimidate'); }
    },
    sturdy: {
        modifyDamageTaken: (_p, ctx) => {
            if (ctx.self.hp === ctx.self.maxhp && ctx.value >= ctx.self.hp) {
                ctx.battle.add('-activate', ctx.battle.ref(ctx.self), 'Sturdy');
                return ctx.self.hp - 1;
            }
            return ctx.value;
        }
    },

    // ---------- speed modifiers ----------
    swiftswim:   { modifyStat: (_p, ctx) => (ctx.stat === 'spe' && ctx.battle.field.weather === 'Rain' ? Math.floor(ctx.value * 2) : ctx.value) },
    chlorophyll: { modifyStat: (_p, ctx) => (ctx.stat === 'spe' && ctx.battle.field.weather === 'Sun' ? Math.floor(ctx.value * 2) : ctx.value) },
    sandrush:    { modifyStat: (_p, ctx) => (ctx.stat === 'spe' && ctx.battle.field.weather === 'Sand' ? Math.floor(ctx.value * 2) : ctx.value) },
    slushrush:   { modifyStat: (_p, ctx) => (ctx.stat === 'spe' && ctx.battle.field.weather === 'Hail' ? Math.floor(ctx.value * 2) : ctx.value) },
    quickfeet:   { modifyStat: (_p, ctx) => (ctx.stat === 'spe' && ctx.self.status ? Math.floor(ctx.value * 1.5) : ctx.value) },

    // ---------- attack / defense modifiers ----------
    guts:        { modifyStat: (_p, ctx) => (ctx.stat === 'atk' && ctx.self.status ? Math.floor(ctx.value * 1.5) : ctx.value) },
    marvelscale: { modifyStat: (_p, ctx) => (ctx.stat === 'def' && ctx.self.status ? Math.floor(ctx.value * 1.5) : ctx.value) },
    hugepower:   { modifyStat: (_p, ctx) => (ctx.stat === 'atk' ? Math.floor(ctx.value * 2) : ctx.value) },
    purepower:   { modifyStat: (_p, ctx) => (ctx.stat === 'atk' ? Math.floor(ctx.value * 2) : ctx.value) },

    // ---------- terrain-riding speed (Swift Swim equivalents) ----------
    surgesurfer: { modifyStat: (_p, ctx) => (ctx.stat === 'spe' && ctx.battle.field.terrain === 'Electric' ? Math.floor(ctx.value * 2) : ctx.value) },
    grasspelt:   { modifyStat: (_p, ctx) => (ctx.stat === 'def' && ctx.battle.field.terrain === 'Grassy' ? Math.floor(ctx.value * 1.5) : ctx.value) },

    // ---------- stat stages ignored ----------
    // 'foe' = ignores the opponent's stages; an own-stage-ignoring ability would use 'self'
    unaware: { ignoreBoosts: (_p, ctx) => (ctx.whose === 'foe' ? true : ctx.value) },

    // ---------- accuracy ----------
    compoundeyes: { modifyAccuracy: (_p, ctx) => (ctx.role === 'user' ? Math.floor(ctx.value * 1.3) : ctx.value) },
    victorystar:  { modifyAccuracy: (_p, ctx) => (ctx.role === 'user' ? Math.floor(ctx.value * 1.1) : ctx.value) },
    hustle: {
        modifyStat: (_p, ctx) => (ctx.stat === 'atk' ? Math.floor(ctx.value * 1.5) : ctx.value),
        // physical moves lose a fifth of their aim as the tradeoff
        modifyAccuracy: (_p, ctx) =>
            (ctx.role === 'user' && ctx.move?.category === 'Physical' ? Math.floor(ctx.value * 0.8) : ctx.value)
    },
    sandveil:  { modifyAccuracy: (_p, ctx) => (ctx.role === 'target' && ctx.battle.field.weather === 'Sand' ? Math.floor(ctx.value * 0.8) : ctx.value) },
    snowcloak: { modifyAccuracy: (_p, ctx) => (ctx.role === 'target' && ctx.battle.field.weather === 'Hail' ? Math.floor(ctx.value * 0.8) : ctx.value) },
    tangledfeet: { modifyAccuracy: (_p, ctx) => (ctx.role === 'target' && ctx.self.volatiles.confusion ? Math.floor(ctx.value * 0.5) : ctx.value) },

    // ---------- item memory ----------
    harvest: { switchIn: (_p, ctx) => { ctx.battle.restoreItem(ctx.self, 'Harvest'); } },

    // ---------- weather setters on entry ----------
    drizzle:     { switchIn: (_p, ctx) => ctx.battle.setWeather('Rain', ctx.self, 'Drizzle') },
    drought:     { switchIn: (_p, ctx) => ctx.battle.setWeather('Sun', ctx.self, 'Drought') },
    sandstream:  { switchIn: (_p, ctx) => ctx.battle.setWeather('Sand', ctx.self, 'Sand Stream') },
    snowwarning: { switchIn: (_p, ctx) => ctx.battle.setWeather('Hail', ctx.self, 'Snow Warning') }
};

// null when this table has no implementation (ability does nothing, never a crash)
export function builtinHandlers(abilityName) {
    const impl = ABILITY_IMPLS[toId(abilityName)];
    if (!impl) return null;
    const out = {};
    for (const [event, fn] of Object.entries(impl)) {
        const handler = (ctx) => fn(null, ctx);
        handler.isValueEvent = VALUE_EVENTS.has(event);
        handler.isImmunity = event === 'tryHit';
        out[event] = [handler];
    }
    return out;
}
