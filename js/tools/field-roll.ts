import { POKEMON_TYPES } from '../core/data.ts';
import { EGG_GROUPS, editForm, form } from '../editor/draft.ts';
import { closeDialog, openDialog } from '../app/dialogs.tsx';

// The dice buttons beside the editor's fields. Each supplies what to suggest,
// how to word an option and what picking one does; the popover itself is
// js/app/dialogs/roll.tsx.

function closeFieldRollPopover() {
    closeDialog('roll');
}

/** Where the popover goes: under the cursor, or under the button when keyboard-pressed. */
export function rollPoint(event, fallbackBtnId) {
    if (event && typeof event.clientX === 'number' && (event.clientX || event.clientY)) {
        return { x: event.clientX, y: event.clientY + 10 };
    }
    const btn = event?.currentTarget || document.getElementById(fallbackBtnId);
    const rect = btn?.getBoundingClientRect();
    return rect ? { x: rect.left, y: rect.bottom + 6 } : { x: 20, y: 20 };
}

/**
 * @param point
 * @param generate
 * @param label
 * @param apply
 * @param [title]
 */
export function openRollPopover(point: { x: number, y: number }, generate: () => any[], label: (option: any) => string, apply: (option: any) => void, title: string = 'Suggestions') {
    closeDialog('roll');
    openDialog('roll', { point, title, generate, label, apply });
}

function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}



const SPECIES_WORDS = {
    Normal: ['Wild', 'Common', 'Roaming', 'Plain'],
    Fire: ['Flame', 'Ember', 'Blaze', 'Scorch', 'Cinder'],
    Water: ['Tide', 'Ripple', 'Wave', 'Bubble', 'Splash'],
    Electric: ['Volt', 'Spark', 'Static', 'Charge'],
    Grass: ['Seedling', 'Sprout', 'Bloom', 'Leaf'],
    Ice: ['Frost', 'Snow', 'Rime', 'Chill'],
    Fighting: ['Brawler', 'Combat', 'Fist'],
    Poison: ['Toxic', 'Venom', 'Sludge'],
    Ground: ['Burrow', 'Dust', 'Terra'],
    Flying: ['Gale', 'Wing', 'Sky'],
    Psychic: ['Mind', 'Dream', 'Oracle'],
    Bug: ['Larva', 'Swarm', 'Shell'],
    Rock: ['Boulder', 'Pebble', 'Crag'],
    Ghost: ['Spirit', 'Shade', 'Specter'],
    Dragon: ['Wyrm', 'Drake', 'Scale'],
    Dark: ['Shadow', 'Dusk', 'Night'],
    Steel: ['Iron', 'Alloy', 'Armor'],
    Fairy: ['Charm', 'Glimmer', 'Pixie']
};
const GENERIC_SPECIES_WORDS = ['Mystery', 'Odd', 'Wild', 'Curious', 'Rascal', 'Newcomer'];

function rollSpeciesOptions() {
    const type1 = form.type1 || '';
    const type2 = form.type2 || '';
    const typeWords = [...(SPECIES_WORDS[type1] || []), ...(SPECIES_WORDS[type2] || [])];
    const pool = [...new Set([...typeWords, ...GENERIC_SPECIES_WORDS])];
    return shuffle(pool).slice(0, 6).map(w => `${w} Pokémon`);
}

function openSpeciesRollPopover(event) {
    event?.stopPropagation();
    const point = rollPoint(event, 'species-roll-btn');
    openRollPopover(point, rollSpeciesOptions, label => label, (value) => {
        editForm({ species: value });
    });
}

function rollTypeOptions() {
    const results: any[] = [];
    const seen = new Set();
    let guard = 0;
    while (results.length < 6 && guard++ < 60) {
        const type1 = POKEMON_TYPES[Math.floor(Math.random() * POKEMON_TYPES.length)];
        let type2 = '';
        if (Math.random() < 0.55) {
            do {
                type2 = POKEMON_TYPES[Math.floor(Math.random() * POKEMON_TYPES.length)];
            } while (type2 === type1);
        }
        const key = `${type1}|${type2}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ type1, type2 });
    }
    return results;
}

function openTypesRollPopover(event) {
    event?.stopPropagation();
    const point = rollPoint(event, 'types-roll-btn');
    openRollPopover(
        point,
        rollTypeOptions,
        opt => opt.type2 ? `${opt.type1} / ${opt.type2}` : opt.type1,
        (opt) => {
            editForm({ type1: opt.type1, type2: opt.type2 || '' });
        }
    );
}

// derives a roughly-correlated weight from height, with enough variance that
// a fixed height doesn't always give the same weight
function rollHeightWeightOptions() {
    const results: any[] = [];
    for (let i = 0; i < 6; i++) {
        const heightM = +(0.2 + Math.random() * 2.3).toFixed(1);
        const density = 8 + Math.random() * 55; // plausible density range
        const weightKg = +Math.max(0.1, heightM ** 2.2 * density * (0.6 + Math.random() * 0.8)).toFixed(1);
        results.push({ heightM, weightKg });
    }
    return results;
}

function toDisplayUnit(valueM, kind) {
    // kind: 'height' -> m/ft, 'weight' -> kg/lb
    const unit = kind === 'height' ? form.heightUnit : form.weightUnit;
    let value = valueM;
    if (kind === 'height' && unit === 'ft') value = valueM * 3.28084;
    if (kind === 'weight' && unit === 'lb') value = valueM * 2.20462;
    return { value: parseFloat(value.toFixed(2)), unit };
}

function openHeightWeightRollPopover(event) {
    event?.stopPropagation();
    const point = rollPoint(event, 'measurements-roll-btn');
    openRollPopover(
        point,
        rollHeightWeightOptions,
        opt => {
            const h = toDisplayUnit(opt.heightM, 'height');
            const w = toDisplayUnit(opt.weightKg, 'weight');
            return `${h.value} ${h.unit} / ${w.value} ${w.unit}`;
        },
        (opt) => {
            const h = toDisplayUnit(opt.heightM, 'height');
            const w = toDisplayUnit(opt.weightKg, 'weight');
            editForm({ height: String(h.value), weight: String(w.value) });
        }
    );
}

function getEggGroupChoices() {
    return EGG_GROUPS.slice();
}

function rollEggGroupOptions() {
    const groups = getEggGroupChoices();
    if (!groups.length) return [];
    const results: any[] = [];
    const seen = new Set();
    let guard = 0;
    while (results.length < 6 && guard++ < 60) {
        const egg1 = groups[Math.floor(Math.random() * groups.length)];
        let egg2 = '';
        if (groups.length > 1 && Math.random() < 0.4) {
            do {
                egg2 = groups[Math.floor(Math.random() * groups.length)];
            } while (egg2 === egg1);
        }
        const key = `${egg1}|${egg2}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ egg1, egg2 });
    }
    return results;
}

function openEggGroupRollPopover(event) {
    event?.stopPropagation();
    const point = rollPoint(event, 'egg-roll-btn');
    openRollPopover(
        point,
        rollEggGroupOptions,
        opt => opt.egg2 ? `${opt.egg1} / ${opt.egg2}` : opt.egg1,
        (opt) => {
            editForm({ egg1: opt.egg1, egg2: opt.egg2 || '' });
        }
    );
}

export {
    closeFieldRollPopover,
    openSpeciesRollPopover,
    openTypesRollPopover,
    openHeightWeightRollPopover,
    openEggGroupRollPopover
};
