// ==================== standard item runtime ====================
// Built-in implementations for well-known held items, using the same event
// seam abilities use (see battle.js runEvent / builtin-abilities.js). The
// item editor is descriptive-only, so this table is what makes Leftovers
// actually heal, Choice Band actually lock, etc. Custom items stay
// flavor-only, same as a custom ability with no assigned block program.
import { toId } from './dex.js';
import { modify } from './mechanics.js';

// 4096ths, rounded half-up like mainline; plain *1.3/*1.2 + floor disagrees
// with mainline on about half of all damage values.
const LIFE_ORB = [5325, 4096];
const EXPERT_BELT = [4915, 4096];

const VALUE_EVENTS = new Set(['modifyDamageDealt', 'modifyDamageTaken', 'modifyStat']);

const STATUS_BERRY = {
    cheriberry: 'par', chestoberry: 'slp', pechaberry: 'psn',
    rawstberry: 'brn', aspearberry: 'frz', persimberry: null   // confusion not modeled
};
const ITEM_LABEL = {
    cheriberry: 'Cheri Berry', chestoberry: 'Chesto Berry', pechaberry: 'Pecha Berry',
    rawstberry: 'Rawst Berry', aspearberry: 'Aspear Berry'
};

const ITEM_IMPLS = {
    // ---------- passive residual ----------
    leftovers: {
        residual: (_p, ctx) => ctx.battle.heal(Math.floor(ctx.self.maxhp / 16), ctx.self, 'Leftovers')
    },
    blacksludge: {
        residual: (_p, ctx) => {
            if (ctx.self.types.includes('Poison')) ctx.battle.heal(Math.floor(ctx.self.maxhp / 16), ctx.self, 'Black Sludge');
            else ctx.battle.damage(Math.max(1, Math.floor(ctx.self.maxhp / 8)), ctx.self, null, 'Black Sludge');
        }
    },

    // ---------- offensive boosters ----------
    lifeorb: {
        modifyDamageDealt: (_p, ctx) => (ctx.move?.category !== 'Status' ? modify(ctx.value, LIFE_ORB) : ctx.value),
        afterMoveHit: (_p, ctx) => {
            if (ctx.damage > 0) ctx.battle.damage(Math.max(1, Math.floor(ctx.self.maxhp / 10)), ctx.self, null, 'Life Orb');
        }
    },
    expertbelt: {
        modifyDamageDealt: (_p, ctx) => (ctx.eff > 1 ? modify(ctx.value, EXPERT_BELT) : ctx.value)
    },

    // ---------- choice lock ----------
    choiceband: { modifyStat: (_p, ctx) => (ctx.stat === 'atk' ? modify(ctx.value, 1.5) : ctx.value), ...choiceLockHandlers() },
    choicespecs: { modifyStat: (_p, ctx) => (ctx.stat === 'spa' ? modify(ctx.value, 1.5) : ctx.value), ...choiceLockHandlers() },
    choicescarf: { modifyStat: (_p, ctx) => (ctx.stat === 'spe' ? modify(ctx.value, 1.5) : ctx.value), ...choiceLockHandlers() },

    // ---------- damage reduction / defensive ----------
    focussash: {
        modifyDamageTaken: (_p, ctx) => {
            if (ctx.self.hp === ctx.self.maxhp && ctx.value >= ctx.self.hp) {
                ctx.battle.add('-activate', ctx.battle.ref(ctx.self), 'Focus Sash');
                ctx.battle.consumeItem(ctx.self, 'Focus Sash');
                return ctx.self.hp - 1;
            }
            return ctx.value;
        }
    },
    rockyhelmet: {
        damagingHit: (_p, ctx) => {
            const foe = ctx.battle.foeOf(ctx.self);
            if (ctx.move?.flags?.contact && foe && !foe.fainted) {
                ctx.battle.damage(Math.max(1, Math.floor(foe.maxhp / 6)), foe, ctx.self, 'Rocky Helmet');
            }
        }
    },

    // ---------- recovery berry ----------
    sitrusberry: {
        afterDamage: (_p, ctx) => {
            if (ctx.self.hp > 0 && ctx.self.hp <= Math.floor(ctx.self.maxhp / 2)) {
                ctx.battle.heal(Math.floor(ctx.self.maxhp / 4), ctx.self, 'Sitrus Berry');
                ctx.battle.consumeItem(ctx.self, 'Sitrus Berry');
            }
        }
    }
};

// generated from STATUS_BERRY so adding one is a one-line table edit
for (const [id, status] of Object.entries(STATUS_BERRY)) {
    if (!status) continue;
    ITEM_IMPLS[id] = {
        setStatus: (_p, ctx) => {
            if (ctx.status === status) {
                ctx.battle.cureStatus(ctx.self, ITEM_LABEL[id]);
                ctx.battle.consumeItem(ctx.self, ITEM_LABEL[id]);
            }
        }
    };
}
// cures anything, so defined directly rather than via the table above
ITEM_IMPLS.lumberry = {
    setStatus: (_p, ctx) => {
        ctx.battle.cureStatus(ctx.self, 'Lum Berry');
        ctx.battle.consumeItem(ctx.self, 'Lum Berry');
    }
};

// shared by all three Choice items: lock into the move just used, release on switch out
function choiceLockHandlers() {
    return {
        // matched by id, not identity - the active move is a per-use copy of the dex entry
        afterMove: (_p, ctx) => {
            for (const slot of ctx.self.moves) slot.disabled = slot.move.id !== ctx.move?.id;
        },
        switchOut: (_p, ctx) => {
            for (const slot of ctx.self.moves) slot.disabled = false;
        }
    };
}

// null when this table has no implementation (item does nothing, as before)
export function builtinItemHandlers(itemName) {
    const id = toId(itemName);
    const impl = ITEM_IMPLS[id];
    if (!impl) return null;
    const out = {};
    for (const [event, fn] of Object.entries(impl)) {
        const handler = (ctx) => fn(null, ctx);
        handler.isValueEvent = VALUE_EVENTS.has(event);
        handler.isItem = true;
        out[event] = [handler];
    }
    return out;
}
