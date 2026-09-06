// Port of Pokémon Showdown's damage arithmetic (MIT licensed), rewritten against
// this engine's own data shapes. Mainline computes in fixed point at 1/4096 with
// half-up rounding, not floats -- plain multiply-and-floor disagrees with it on
// item/ability modifiers (e.g. Life Orb [5325,4096]) roughly half the time, and
// Chain exists to apply that fixed-point math once across stacked modifiers.
// Pure functions only: no battle state, no RNG, no DOM (testable, safe under PvP lockstep).

// truncate toward zero, staying in integer space (Showdown's `trunc`)
export function tr(num, bits = 0) {
    if (bits) return (num >>> 0) % (2 ** bits);
    return Math.trunc(num);
}

// one modifier applied at 1/4096 precision, rounding half-up
export function modify(value, numerator, denominator = 1) {
    if (Array.isArray(numerator)) [numerator, denominator] = numerator;
    const modifier = tr((numerator * 4096) / denominator);
    return tr((tr(value * modifier) + 2047) / 4096);
}

// stacked modifiers chained in fixed point, rounded once at the end (4096 = 1x)
export class Chain {
    constructor() { this.value = 4096; }
    add(numerator, denominator = 1) {
        if (Array.isArray(numerator)) [numerator, denominator] = numerator;
        const next = tr((numerator * 4096) / denominator);
        this.value = (this.value * next + 2048) >> 12;
        return this;
    }
    apply(value) { return tr((tr(value * this.value) + 2047) / 4096); }
}

// the 85%-100% damage roll; roll16 passed in (0..15) to keep this pure
export function randomizer(baseDamage, roll16) {
    return tr(tr(baseDamage * (100 - roll16)) / 100);
}

// stat stages: multiply for raises, divide for drops, both truncated (so -1 Atk isn't just 0.67x)
const BOOST_TABLE = [1, 1.5, 2, 2.5, 3, 3.5, 4];
export function boostStat(stat, stage) {
    const s = Math.max(-6, Math.min(6, stage | 0));
    return s >= 0 ? tr(stat * BOOST_TABLE[s]) : tr(stat / BOOST_TABLE[-s]);
}

// accuracy stages use thirds rather than halves
export function boostAccuracy(accuracy, stage) {
    const s = Math.max(-6, Math.min(6, stage | 0));
    return s > 0 ? tr((accuracy * (3 + s)) / 3) : tr((accuracy * 3) / (3 - s));
}

// crit odds by stage (gen 7+): 1/24, 1/8, 1/2, then guaranteed
export const CRIT_DENOMINATORS = [24, 8, 2];
export function critDenominator(critRatio) {
    const stage = Math.max(0, Number(critRatio) || 0);
    return stage >= 3 ? 1 : CRIT_DENOMINATORS[stage];
}

// 2-5 hit moves: 2/3 hits at 35% each, 4/5 hits at 15% each (avg 3.1, not a uniform 3.5)
export function multihitCount(multihit, roll100, rollRange) {
    if (!Array.isArray(multihit)) return Number(multihit) || 1;
    if (multihit[0] === 2 && multihit[1] === 5) {
        return roll100 < 35 ? 2 : roll100 < 70 ? 3 : roll100 < 85 ? 4 : 5;
    }
    return rollRange(multihit[0], multihit[1]);
}

// damage pipeline in mainline's order; plain numbers so it's checkable against known Showdown outputs
export function calcDamage({
    level, basePower, attack, defense,
    isCrit = false, critModifier = 1.5,
    stab = 1, typeMod = 1, isBurned = false, roll16 = 0,
    weatherMod = 1, chain = null
}) {
    if (!basePower) return 0;

    let damage = tr(tr(tr(tr((2 * level) / 5 + 2) * basePower * attack) / defense) / 50);
    damage += 2;

    // weather is a damage modifier here (mainline onWeatherModifyDamage), not folded
    // into base power -- folding it into base power rounds at the wrong point
    if (weatherMod !== 1) damage = modify(damage, weatherMod);

    if (isCrit) damage = tr(damage * critModifier);
    damage = randomizer(damage, roll16);
    if (stab !== 1) damage = modify(damage, stab);

    // effectiveness applied one power-of-two step at a time with truncation between, per mainline
    let steps = Math.round(Math.log2(typeMod || 1));
    for (; steps > 0; steps--) damage = tr(damage * 2);
    for (; steps < 0; steps++) damage = tr(damage / 2);
    if (typeMod === 0) return 0;

    if (isBurned) damage = modify(damage, 0.5);
    if (chain) damage = chain.apply(damage);

    return Math.max(1, damage);
}

// priority, then speed, then a coin flip drawn BEFORE sorting -- drawing it inside
// the comparator would make RNG call count depend on sort impl and desync clients
export function orderActions(actions, drawTiebreak) {
    return actions
        .map(a => ({ a, tie: drawTiebreak() }))
        .sort((x, y) =>
            (y.a.priority - x.a.priority) ||
            (y.a.speed - x.a.speed) ||
            (x.tie - y.tie))
        .map(x => x.a);
}
