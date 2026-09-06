// ==================== move animations ====================
// Type-coloured battle FX for the scene, modelled on how Pokémon Showdown
// presents attacks: the attacker commits first, the effect lands on the
// defender, then result text floats. The shapes here are drawn entirely with
// CSS geometry (no sprite sheets), coloured per attacking type.
//
// Purely presentational: never touches battle state, safe under PvP lockstep.


// Per-type palette [core, glow]. Chosen to read instantly at 640x360.
export const TYPE_COLORS = {
    Normal:   ['#d8d8c0', '#f5f5dc'],
    Fire:     ['#ff6b35', '#ffd23f'],
    Water:    ['#3b82f6', '#7dd3fc'],
    Electric: ['#facc15', '#fef08a'],
    Grass:    ['#4ade80', '#bbf7d0'],
    Ice:      ['#a5f3fc', '#e0f2fe'],
    Fighting: ['#b91c1c', '#f87171'],
    Poison:   ['#a855f7', '#d8b4fe'],
    Ground:   ['#b45309', '#d97706'],
    Flying:   ['#93c5fd', '#e0e7ff'],
    Psychic:  ['#f472b6', '#fbcfe8'],
    Bug:      ['#84cc16', '#bef264'],
    Rock:     ['#78716c', '#a8a29e'],
    Ghost:    ['#7c3aed', '#c4b5fd'],
    Dragon:   ['#2563eb', '#60a5fa'],
    Dark:     ['#3f3f46', '#71717a'],
    Steel:    ['#9ca3af', '#e5e7eb'],
    Fairy:    ['#f9a8d4', '#fce7f3']
};

// How many particles each flavour throws. Kept modest so a 6-mon battle
// doesn't churn hundreds of nodes.
const FLAVOURS = {
    // type -> { shape, count }  shape: burst | beam | orb | wave | shard | wisp
    Fire: { shape: 'burst', count: 10 },
    Water: { shape: 'shard', count: 12 },
    Electric: { shape: 'bolt', count: 3 },
    Grass: { shape: 'shard', count: 10 },
    Ice: { shape: 'shard', count: 12 },
    Fighting: { shape: 'burst', count: 8 },
    Poison: { shape: 'orb', count: 8 },
    Ground: { shape: 'wave', count: 6 },
    Flying: { shape: 'wave', count: 7 },
    Psychic: { shape: 'ring', count: 3 },
    Bug: { shape: 'wisp', count: 8 },
    Rock: { shape: 'burst', count: 7 },
    Ghost: { shape: 'wisp', count: 6 },
    Dragon: { shape: 'beam', count: 1 },
    Dark: { shape: 'wisp', count: 7 },
    Steel: { shape: 'shard', count: 10 },
    Fairy: { shape: 'orb', count: 10 },
    Normal: { shape: 'burst', count: 8 }
};

// Which effect a move gets. Rather than naming several hundred moves one at a
// time, this reads the move data the engine already carries -- Showdown's own
// flags, drain, multihit and target -- so every vanilla move gets a shape that
// matches what it actually does, and so do custom moves built in the editor.
//
// First match wins; anything that matches nothing falls back to its type's
// entry in FLAVOURS, which is what the whole table used to do.
const SHAPE_RULES = [
    [m => m.flags?.sound,                              { shape: 'sound',  count: 4 }],
    [m => m.drain,                                     { shape: 'drain',  count: 9 }],
    [m => m.flags?.slicing || m.flags?.bite,           { shape: 'slash',  count: 3 }],
    [m => m.flags?.pulse || m.flags?.bullet,           { shape: 'orb',    count: 9 }],
    [m => m.flags?.punch,                              { shape: 'burst',  count: 9 }],
    // Recharge/charge moves are the game's cannons: Hyper Beam, Solar Beam,
    // Giga Impact, Meteor Beam, Sky Attack.
    [m => m.flags?.recharge || m.flags?.charge,        { shape: 'beam',   count: 1 }],
    [m => m.type === 'Ground' && String(m.target || '').startsWith('allAdjacent'),
                                                       { shape: 'quake',  count: 5 }],
    [m => m.multihit,                                  { shape: 'shard',  count: 12 }],
    [m => m.basePower >= 120,                          { shape: 'explode', count: 11 }],
    [m => m.flags?.wind,                               { shape: 'wave',   count: 7 }],
    [m => m.flags?.dance,                              { shape: 'ring',   count: 4 }],
    [m => m.flags?.contact && m.category === 'Physical', { shape: 'burst', count: 8 }]
];

// The handful the rules genuinely cannot see, because the engine's move record
// doesn't carry the field that would give them away (Showdown's selfdestruct
// is not a flag) or because the move is iconic enough to deserve its own look.
const MOVE_FX = {
    explosion:    { shape: 'explode', count: 14 },
    selfdestruct: { shape: 'explode', count: 12 },
    mistyexplosion: { shape: 'explode', count: 12 },
    earthquake:   { shape: 'quake',   count: 5 },
    fissure:      { shape: 'quake',   count: 6 },
    thunder:      { shape: 'bolt',    count: 6 },
    thunderbolt:  { shape: 'bolt',    count: 4 },
    thunderwave:  { shape: 'bolt',    count: 2 },
    hydropump:    { shape: 'beam',    count: 1 },
    flamethrower: { shape: 'beam',    count: 1 },
    icebeam:      { shape: 'beam',    count: 1 },
    psychic:      { shape: 'ring',    count: 4 },
    surf:         { shape: 'wave',    count: 8 },
    rapidspin:    { shape: 'ring',    count: 3 }
};

// count scales a little with power so a 40 BP jab and a 110 BP slam don't
// throw identical amounts of debris.
function scaleCount(base, move) {
    if (base <= 1) return base;   // a beam is one beam at any power
    const power = Number(move?.basePower) || 0;
    if (!power) return base;
    return Math.max(1, Math.min(18, Math.round(base * (0.7 + power / 130))));
}

export function shapeFor(move, type) {
    const byName = move?.id ? MOVE_FX[move.id] : null;
    const hit = byName || SHAPE_RULES.find(([test]) => { try { return test(move || {}); } catch { return false; } })?.[1];
    if (hit) return { shape: hit.shape, count: scaleCount(hit.count, move) };
    return FLAVOURS[type] || FLAVOURS.Normal;
}

export const MOVE_FX_MS = 520;

// Finds the move object the engine logged, so the FX match what actually
// resolved rather than guessing from the name alone.
export function resolveMoveInfo(battle, sideIndex, moveName) {
    // battle.active(i) is the real API -- a side is a plain object with an
    // activeIndex, it has no .active() of its own. Calling it that way silently
    // returned null for every move, so every attack fell back to the Normal /
    // Physical default: no per-move effect, no type colour, and status moves
    // shook the screen because they looked Physical.
    const mon = battle?.active?.(sideIndex) || null;
    const slot = mon?.moves?.find(s => s.move?.name === moveName);
    if (slot?.move) return { name: moveName, type: slot.move.type, category: slot.move.category, move: slot.move };
    return { name: moveName, type: 'Normal', category: 'Physical', move: null };
}

function spawn(field, cls, styles, life) {
    const el = document.createElement('div');
    el.className = cls;
    // `el.style['--c1'] = x` is silently a no-op -- custom properties only
    // reach the CSSOM through setProperty. Every effect here is coloured and
    // positioned through --c1/--c2/--dx/--dy, so assigning them the ordinary
    // way meant they all fell back to the beige defaults on .ps-mfx, and the
    // shapes whose transform reads var(--dx) with no fallback produced an
    // invalid transform and never showed up at all.
    for (const [k, v] of Object.entries(styles)) {
        if (k.startsWith('--')) el.style.setProperty(k, v);
        else el.style[k] = v;
    }
    field.appendChild(el);
    setTimeout(() => el.remove(), life);
    return el;
}

// Radial scatter around a point given in % of the field box.
function pointAt(slotRect, fieldRect) {
    return {
        x: ((slotRect.left + slotRect.width / 2) - fieldRect.left) / fieldRect.width * 100,
        y: ((slotRect.top + slotRect.height * 0.72) - fieldRect.top) / fieldRect.height * 100
    };
}

/**
 * Plays the attack FX for one move. Returns total ms the caller should wait.
 * @param {{field:Element}} els  scene element refs
 * @param {Element} attackerSlot  attacker's .ps-slot
 * @param {Element} targetSlot    defender's .ps-slot
 * @param {{type:string,category:string}} info
 */
export function playMoveFX(els, attackerSlot, targetSlot, info) {
    if (!els?.field || !attackerSlot || !targetSlot) return 0;
    const fieldRect = els.field.getBoundingClientRect();
    const tgt = pointAt(targetSlot.getBoundingClientRect(), fieldRect);
    const src = pointAt(attackerSlot.getBoundingClientRect(), fieldRect);
    const [c1, c2] = TYPE_COLORS[info.type] || TYPE_COLORS.Normal;
    const flavour = shapeFor(info.move, info.type);
    const life = MOVE_FX_MS + 400;

    const named = info.move && (MOVE_FX[info.move.id] || info.move.flags?.sound || info.move.flags?.dance);
    if (info.category === 'Status' && !named) {
        // A soft aura settling over the target instead of an impact.
        spawn(els.field, 'ps-mfx ps-status-orb',
            { left: `${tgt.x}%`, top: `${tgt.y}%`, '--c1': c1, '--c2': c2 }, life);
        return MOVE_FX_MS;
    }

    switch (flavour.shape) {
        case 'beam':
            // Straight energy lance from attacker to defender.
            spawn(els.field, 'ps-mfx ps-beam', {
                left: `${src.x}%`, top: `${src.y}%`,
                width: `${Math.hypot(tgt.x - src.x, tgt.y - src.y)}%`,
                '--angle': `${Math.atan2(tgt.y - src.y, tgt.x - src.x)}rad`,
                '--c1': c1, '--c2': c2
            }, life);
            break;
        case 'bolt':
            for (let i = 0; i < flavour.count; i++) {
                setTimeout(() => spawn(els.field, 'ps-mfx ps-bolt',
                    { left: `${tgt.x + (Math.random() * 14 - 7)}%`, top: `${tgt.y - Math.random() * 22}%`, '--c1': c1, '--c2': c2 }, 380),
                    i * 90);
            }
            break;
        case 'ring':
            for (let i = 0; i < flavour.count; i++) {
                setTimeout(() => spawn(els.field, 'ps-mfx ps-ring',
                    { left: `${tgt.x}%`, top: `${tgt.y}%`, '--c1': c1, '--c2': c2 }, 700), i * 130);
            }
            break;
        case 'wave':
            for (let i = 0; i < flavour.count; i++) {
                const dir = src.x < tgt.x ? 1 : -1;
                spawn(els.field, 'ps-mfx ps-wave', {
                    left: `${src.x + dir * (i + 1) * ((tgt.x - src.x) / (flavour.count + 1))}%`,
                    top: `${src.y + (i + 1) * ((tgt.y - src.y) / (flavour.count + 1))}%`,
                    '--c1': c1, '--c2': c2
                }, 600);
            }
            break;
        case 'slash':
            // Diagonal claw streaks raked across the target, alternating angle.
            for (let i = 0; i < flavour.count; i++) {
                setTimeout(() => spawn(els.field, 'ps-mfx ps-slash', {
                    left: `${tgt.x}%`, top: `${tgt.y}%`,
                    '--rot': `${(i % 2 ? 28 : -28) + (Math.random() * 12 - 6)}deg`,
                    '--c1': c1, '--c2': c2
                }, 460), i * 85);
            }
            break;
        case 'sound':
            // Concentric rings pushed out from the ATTACKER -- sound travels.
            for (let i = 0; i < flavour.count; i++) {
                setTimeout(() => spawn(els.field, 'ps-mfx ps-sound',
                    { left: `${src.x}%`, top: `${src.y}%`, '--c1': c1, '--c2': c2 }, 620), i * 110);
            }
            break;
        case 'quake':
            // Shockwave ridges rolling out along the ground under the target.
            for (let i = 0; i < flavour.count; i++) {
                setTimeout(() => spawn(els.field, 'ps-mfx ps-quake', {
                    left: `${tgt.x}%`, top: `${tgt.y + 2}%`,
                    '--c1': c1, '--c2': c2
                }, 620), i * 95);
            }
            break;
        case 'drain':
            // Motes lifted off the target and pulled back to the attacker.
            for (let i = 0; i < flavour.count; i++) {
                spawn(els.field, 'ps-mfx ps-drain', {
                    left: `${tgt.x + (Math.random() * 16 - 8)}%`, top: `${tgt.y + (Math.random() * 12 - 6)}%`,
                    '--dx': `${src.x - tgt.x}%`, '--dy': `${src.y - tgt.y}%`,
                    '--c1': c1, '--c2': c2,
                    'animation-delay': `${Math.random() * 220}ms`
                }, life + 220);
            }
            break;
        case 'explode':
            spawn(els.field, 'ps-mfx ps-blast', { left: `${tgt.x}%`, top: `${tgt.y}%`, '--c1': c1, '--c2': c2 }, 700);
            for (let i = 0; i < flavour.count; i++) {
                const a = (i / flavour.count) * Math.PI * 2;
                spawn(els.field, 'ps-mfx ps-burst', {
                    left: `${tgt.x}%`, top: `${tgt.y}%`,
                    '--dx': `${Math.cos(a) * 26}%`, '--dy': `${Math.sin(a) * 22}%`,
                    '--c1': c1, '--c2': c2,
                    'animation-delay': `${Math.random() * 90}ms`
                }, life);
            }
            break;
        case 'shard':
            for (let i = 0; i < flavour.count; i++) {
                const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 14;
                spawn(els.field, 'ps-mfx ps-shard', {
                    left: `${tgt.x}%`, top: `${tgt.y}%`,
                    '--dx': `${Math.cos(a) * r}%`, '--dy': `${Math.sin(a) * r - 6}%`,
                    '--rot': `${Math.random() * 360}deg`, '--c1': c1, '--c2': c2,
                    'animation-delay': `${Math.random() * 120}ms`
                }, life);
            }
            break;
        case 'wisp':
            for (let i = 0; i < flavour.count; i++) {
                spawn(els.field, 'ps-mfx ps-wisp', {
                    left: `${tgt.x + (Math.random() * 20 - 10)}%`, top: `${tgt.y}%`,
                    '--dx': `${Math.random() * 16 - 8}%`, '--c1': c1, '--c2': c2,
                    'animation-delay': `${Math.random() * 200}ms`
                }, life);
            }
            break;
        default: // burst
            for (let i = 0; i < flavour.count; i++) {
                const a = (i / flavour.count) * Math.PI * 2;
                spawn(els.field, 'ps-mfx ps-burst', {
                    left: `${tgt.x}%`, top: `${tgt.y}%`,
                    '--dx': `${Math.cos(a) * 13}%`, '--dy': `${Math.sin(a) * 13}%`,
                    '--c1': c1, '--c2': c2
                }, life);
            }
    }
    // Impact flash on the defender regardless of shape.
    spawn(els.field, 'ps-mfx ps-impact', { left: `${tgt.x}%`, top: `${tgt.y}%`, '--c1': c1 }, 420);
    return MOVE_FX_MS;
}
