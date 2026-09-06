// Deterministic RNG: both players replay the same seed + action list, so every
// roll must be bit-identical across machines. Rules out Math.random(); uses
// sfc32 (uint32-only ops keep it bit-identical across JS runtimes).

const MASK = 0xffffffff;

export class BattleRNG {
    // seed: string or array of 4 uint32s; strings are hashed to spread entropy across all 4 words
    constructor(seed) {
        const s = Array.isArray(seed) ? seed.slice(0, 4) : hashSeed(String(seed ?? 'woogidex'));
        this.a = s[0] >>> 0;
        this.b = s[1] >>> 0;
        this.c = s[2] >>> 0;
        this.d = s[3] >>> 0;
        this.calls = 0;
        // warm-up: avoids correlated first outputs from closely-related seeds
        for (let i = 0; i < 12; i++) this.nextUint32();
        this.calls = 0;
    }

    nextUint32() {
        this.calls++;
        let { a, b, c, d } = this;
        const t = (a + b) >>> 0;
        a = (b ^ (b >>> 9)) >>> 0;
        b = (c + (c << 3)) >>> 0;
        c = ((c << 21) | (c >>> 11)) >>> 0;
        d = (d + 1) >>> 0;
        const t2 = (t + d) >>> 0;
        c = (c + t2) >>> 0;
        this.a = a; this.b = b; this.c = c; this.d = d;
        return t2 >>> 0;
    }

    // uniform int in [0, max); rejection sampling avoids modulo bias
    random(max) {
        const m = Math.floor(max);
        if (!Number.isFinite(m) || m <= 1) return 0;
        const limit = Math.floor(MASK / m) * m;
        let v;
        do { v = this.nextUint32(); } while (v >= limit);
        return v % m;
    }

    range(min, max) {
        return min + this.random(max - min + 1);
    }

    // mirrors Showdown's randomChance() semantics
    chance(numerator, denominator) {
        return this.random(denominator) < numerator;
    }

    // deterministic Fisher-Yates
    shuffle(list) {
        for (let i = list.length - 1; i > 0; i--) {
            const j = this.random(i + 1);
            [list[i], list[j]] = [list[j], list[i]];
        }
        return list;
    }

    // lets a replay jump to an arbitrary turn without replaying prior rolls
    getState() { return { a: this.a, b: this.b, c: this.c, d: this.d, calls: this.calls }; }
    setState(s) { this.a = s.a >>> 0; this.b = s.b >>> 0; this.c = s.c >>> 0; this.d = s.d >>> 0; this.calls = s.calls || 0; }
}

// FNV-1a hash, then 4 decorrelated draws (hashing the string 4x would give identical words)
function hashSeed(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    const out = [];
    for (let i = 0; i < 4; i++) {
        h ^= h << 13; h >>>= 0;
        h ^= h >>> 17;
        h ^= h << 5;  h >>>= 0;
        out.push(h >>> 0);
    }
    return out;
}

export { hashSeed };
