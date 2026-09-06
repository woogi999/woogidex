// Practice-opponent bot. Plays through the same Battle.choose() interface a
// human uses (real simulation, not special-cased), and draws randomness from
// the battle's own RNG so bot games stay reproducible/replayable. Single skill
// level (strongest). Each turn: predict the opponent's best move, check if
// that's lethal, score every move/switch on the same scale, take the best
// (breaking near-ties randomly).

import { typeEffectiveness } from './engine/dex.js';
import { canSelectMove, STRUGGLE_INDEX } from './engine/battle.js';

// scores are roughly "percent of target's remaining HP", so a switch worth 60
// is worth about the same as a 60% damage roll
const KO_BONUS = 60;          // securing a knockout
const SURVIVE_BONUS = 45;     // getting out of range of a knockout
const SWITCH_COST = 18;       // a switch gives the opponent a free turn

export function chooseBotAction(battle, sideIndex) {
    const me = battle.active(sideIndex);
    const foe = battle.active(1 - sideIndex);
    if (!me) return null;

    // forced replacement (faint, or pivoted out) -- must switch before moving again
    if (me.fainted || battle.needsSwitch(sideIndex)) {
        const idx = pickSwitchTarget(battle, sideIndex, foe);
        return idx === null ? null : { type: 'switch', index: idx };
    }

    if (battle.mustStruggle(sideIndex)) return { type: 'move', index: STRUGGLE_INDEX };

    const usable = me.moves.map((slot, index) => ({ slot, index }))
        .filter(m => canSelectMove(me, m.index));
    if (!usable.length) return null;

    const threat = predictThreat(battle, foe, me);
    const options = usable.map(({ slot, index }) => ({
        action: { type: 'move', index },
        score: scoreMove(battle, me, foe, slot.move, threat)
    }));

    // switches scored on the same scale so they compete directly with attacking
    for (const option of switchOptions(battle, sideIndex, foe, threat)) options.push(option);

    options.sort((a, b) => b.score - a.score);
    const best = options.filter(o => o.score >= options[0].score - 8);
    return best[battle.rng.random(best.length)].action;
}

// opponent's strongest option vs target, as raw damage; only public info, so prediction not cheating
function predictThreat(battle, foe, target) {
    if (!foe || !target) return { damage: 0, kills: false, type: null };
    let worst = { damage: 0, kills: false, type: null };
    for (const slot of foe.moves || []) {
        const move = slot.move;
        if (!move || move.category === 'Status') continue;
        const damage = estimateDamage(battle, foe, target, move);
        if (damage > worst.damage) worst = { damage, kills: damage >= target.hp, type: move.type };
    }
    return worst;
}

// rough damage estimate (not the real pipeline) -- only needs to rank options
function estimateDamage(battle, attacker, target, move) {
    const eff = typeEffectiveness(move.type, target.types);
    if (!eff || !move.basePower) return 0;
    const physical = move.category === 'Physical';
    const A = battle.getStat(attacker, physical ? 'atk' : 'spa');
    const D = battle.getStat(target, physical ? 'def' : 'spd');
    const levelFactor = Math.floor((2 * attacker.level) / 5) + 2;
    let dmg = Math.floor(Math.floor((levelFactor * move.basePower * A) / D) / 50) + 2;
    if (attacker.types.includes(move.type)) dmg = Math.floor(dmg * 1.5);
    dmg = Math.floor(dmg * eff);
    const hits = Array.isArray(move.multihit) ? 3 : (Number(move.multihit) || 1);
    dmg *= hits;
    if (typeof move.accuracy === 'number') dmg = Math.floor((dmg * move.accuracy) / 100);
    return dmg;
}

// every legal switch, scored like a move: worth what the replacement does NEXT
// turn, discounted because this turn is given away for free
function switchOptions(battle, sideIndex, foe, threat) {
    const side = battle.sides[sideIndex];
    const active = battle.active(sideIndex);
    const out = [];

    side.team.forEach((mon, index) => {
        if (mon.fainted || index === side.activeIndex) return;

        // percentage of opponent's remaining HP, same units as scoreMove
        let offence = 0;
        if (foe) {
            for (const slot of mon.moves || []) {
                if (!slot.move || slot.move.category === 'Status') continue;
                offence = Math.max(offence, estimateDamage(battle, mon, foe, slot.move));
            }
        }
        const offencePct = foe ? Math.min(100, (offence / Math.max(1, foe.hp)) * 100) : 0;

        // re-predicted against the replacement's own typing/bulk, not rescaled
        const incoming = predictThreat(battle, foe, mon);
        const incomingPct = Math.min(100, (incoming.damage / Math.max(1, mon.hp)) * 100);

        let score = offencePct * 0.6 - incomingPct * 0.35 - SWITCH_COST;

        if (threat.kills && !incoming.kills) score += SURVIVE_BONUS;
        if (incoming.kills) score -= 25;
        if (active && !threat.kills && offencePct < 20) score -= 20;

        out.push({ action: { type: 'switch', index }, score });
    });
    return out;
}

function scoreMove(battle, me, foe, move, threat) {
    if (!foe) return move.category === 'Status' ? 10 : 1;

    const eff = typeEffectiveness(move.type, foe.types);
    if (move.category === 'Status') {
        // about to be KO'd: only worth it if it saves or kills us/them (healing scored below)
        if (threat?.kills && !move.heal) return 1;
        let s = 12;
        if (move.status) s = foe.status ? 0 : 30;
        if (move.boosts) {
            const self = move.target === 'self';
            const target = self ? me : foe;
            const already = Object.keys(move.boosts).every(k => Math.abs(target.boosts[k] || 0) >= 6);
            s = already ? 0 : (self ? 26 : 22);
            if (self && me.hp < me.maxhp * 0.35) s -= 15;
        }
        if (move.id === 'stealthrock' || move.id === 'spikes' || move.id === 'toxicspikes') {
            s = foe.side.conditions[move.id] ? 0 : 28;
        }
        if (move.heal || move.id === 'recover' || move.id === 'roost') {
            s = me.hp < me.maxhp * 0.55 ? 40 : 0;
        }
        return s;
    }

    if (eff === 0) return 0;

    const dmg = estimateDamage(battle, me, foe, move);

    const pct = Math.min(100, (dmg / Math.max(1, foe.hp)) * 100);
    let score = pct;
    if (dmg >= foe.hp) {
        score += KO_BONUS;
        // among several knockouts, prefer the one most likely to actually land
        score += (typeof move.accuracy === 'number' ? move.accuracy : 100) / 10;
        if (move.priority > 0) score += 25;   // priority KO beats their move outright
        else if (threat?.kills) score -= 10;   // we both die; the KO is less certain
    } else if (threat?.kills) {
        score *= 0.7;   // can't prevent our own KO, so chip damage is worth less than switching out
    }
    return score;
}

function pickSwitchTarget(battle, sideIndex, foe, exclude = null) {
    const side = battle.sides[sideIndex];
    const options = side.team
        .map((mon, index) => ({ mon, index }))
        .filter(o => !o.mon.fainted && o.mon !== exclude && o.index !== side.activeIndex);
    if (!options.length) return null;
    if (!foe) return options[0].index;

    // prefer whoever resists the opponent's typing best and is healthiest
    const scored = options.map(o => {
        let resist = 0;
        for (const t of foe.types) resist += 1 / Math.max(0.25, typeEffectiveness(t, o.mon.types));
        return { index: o.index, score: resist * 10 + (o.mon.hp / o.mon.maxhp) * 20 };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].index;
}
