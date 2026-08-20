import { POKEMON_TYPES } from './data.js';

// generic dice-button popover, shared by all the "roll" fields below. This is
// the same fixed-position, zoom-corrected, scroll-closing popover used for
// the name field (see name-roll.js) - kept as a self-contained copy here so
// each field can supply its own generator/label/apply logic.
let activePopover = null;

function closeFieldRollPopover() {
    if (activePopover) {
        activePopover.remove();
        activePopover = null;
        document.removeEventListener('click', onOutsideClick);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onScroll);
    }
}

function onOutsideClick(e) {
    if (activePopover && !activePopover.contains(e.target) && !e.target.closest('.name-roll-btn')) {
        closeFieldRollPopover();
    }
}

function onScroll() {
    closeFieldRollPopover();
}

// see name-roll.js for why this correction is needed - the site scales
// itself with CSS `zoom`, which also rescales position:fixed offsets.
function getEffectiveZoom(el) {
    let zoom = 1;
    let node = el;
    while (node && node !== document.documentElement) {
        const z = parseFloat(getComputedStyle(node).zoom);
        if (!Number.isNaN(z) && z > 0) zoom *= z;
        node = node.parentElement;
    }
    return zoom;
}

function renderFieldRollPopover(anchorBtn, generate, formatLabel, onApply) {
    closeFieldRollPopover();
    const options = generate();
    const pop = document.createElement('div');
    pop.className = 'name-roll-popover';
    pop.innerHTML = `
        <div class="name-roll-popover-head">
            <span>Suggestions</span>
            <button type="button" class="name-roll-reroll" title="Reroll" aria-label="Reroll">
                <i data-lucide="dices"></i>
            </button>
        </div>
        <div class="name-roll-list">
            ${options.map((opt, i) => `<button type="button" class="name-roll-option" data-idx="${i}">${formatLabel(opt)}</button>`).join('')}
        </div>
    `;
    document.body.appendChild(pop);

    const rect = anchorBtn.getBoundingClientRect();
    const zoom = getEffectiveZoom(pop);
    pop.style.position = 'fixed';

    const place = () => {
        const realWidth = pop.offsetWidth * zoom;
        const desiredLeft = Math.min(
            Math.max(8, rect.right - realWidth),
            window.innerWidth - realWidth - 8
        );
        pop.style.top = `${(rect.bottom + 6) / zoom}px`;
        pop.style.left = `${desiredLeft / zoom}px`;
    };
    place();
    requestAnimationFrame(place);

    pop.querySelectorAll('.name-roll-option').forEach(btn => {
        btn.addEventListener('click', () => {
            onApply(options[Number(btn.dataset.idx)]);
            closeFieldRollPopover();
        });
    });
    pop.querySelector('.name-roll-reroll')?.addEventListener('click', () => {
        renderFieldRollPopover(anchorBtn, generate, formatLabel, onApply);
    });

    if (typeof lucide !== 'undefined') lucide.createIcons();
    activePopover = pop;
    setTimeout(() => document.addEventListener('click', onOutsideClick), 0);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
}

function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function fireInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

function fireChange(el) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ==================== species / category ====================

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
    const type1 = document.getElementById('fakemon-type1')?.value || '';
    const type2 = document.getElementById('fakemon-type2')?.value || '';
    const typeWords = [...(SPECIES_WORDS[type1] || []), ...(SPECIES_WORDS[type2] || [])];
    const pool = [...new Set([...typeWords, ...GENERIC_SPECIES_WORDS])];
    return shuffle(pool).slice(0, 6).map(w => `${w} Pokémon`);
}

function openSpeciesRollPopover(event) {
    event?.stopPropagation();
    const btn = event?.currentTarget || document.getElementById('species-roll-btn');
    if (!btn) return;
    renderFieldRollPopover(btn, rollSpeciesOptions, label => label, (value) => {
        const input = document.getElementById('fakemon-species');
        if (!input) return;
        input.value = value;
        fireInput(input);
    });
}

// ==================== types ====================

function rollTypeOptions() {
    const results = [];
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
    const btn = event?.currentTarget || document.getElementById('types-roll-btn');
    if (!btn) return;
    renderFieldRollPopover(
        btn,
        rollTypeOptions,
        opt => opt.type2 ? `${opt.type1} / ${opt.type2}` : opt.type1,
        (opt) => {
            window.selectType?.('type1', opt.type1);
            window.selectType?.('type2', opt.type2 || '');
        }
    );
}

// ==================== height / weight ====================

// generates a plausible height (m) then derives a roughly-correlated weight
// (kg) from it, with enough random variance that a fixed height doesn't
// always come out with the same weight.
function rollHeightWeightOptions() {
    const results = [];
    for (let i = 0; i < 6; i++) {
        const heightM = +(0.2 + Math.random() * 2.3).toFixed(1);
        const density = 8 + Math.random() * 55; // rough plausible-density range
        const weightKg = +Math.max(0.1, heightM ** 2.2 * density * (0.6 + Math.random() * 0.8)).toFixed(1);
        results.push({ heightM, weightKg });
    }
    return results;
}

function toDisplayUnit(valueM, kind) {
    // kind: 'height' -> m/ft, 'weight' -> kg/lb
    const unitSelect = document.getElementById(kind === 'height' ? 'height-unit' : 'weight-unit');
    const unit = unitSelect?.value || (kind === 'height' ? 'm' : 'kg');
    let value = valueM;
    if (kind === 'height' && unit === 'ft') value = valueM * 3.28084;
    if (kind === 'weight' && unit === 'lb') value = valueM * 2.20462;
    return { value: parseFloat(value.toFixed(2)), unit };
}

function openHeightWeightRollPopover(event) {
    event?.stopPropagation();
    const btn = event?.currentTarget || document.getElementById('measurements-roll-btn');
    if (!btn) return;
    renderFieldRollPopover(
        btn,
        rollHeightWeightOptions,
        opt => {
            const h = toDisplayUnit(opt.heightM, 'height');
            const w = toDisplayUnit(opt.weightKg, 'weight');
            return `${h.value} ${h.unit} / ${w.value} ${w.unit}`;
        },
        (opt) => {
            const heightInput = document.getElementById('fakemon-height');
            const weightInput = document.getElementById('fakemon-weight');
            if (heightInput) {
                const h = toDisplayUnit(opt.heightM, 'height');
                heightInput.value = h.value;
                heightInput.dataset.lastUnit = h.unit;
                fireInput(heightInput);
            }
            if (weightInput) {
                const w = toDisplayUnit(opt.weightKg, 'weight');
                weightInput.value = w.value;
                weightInput.dataset.lastUnit = w.unit;
                fireInput(weightInput);
            }
        }
    );
}

// ==================== egg groups ====================

function getEggGroupChoices() {
    const select = document.getElementById('fakemon-egg1');
    if (!select) return [];
    return Array.from(select.options).map(o => o.value).filter(Boolean);
}

function rollEggGroupOptions() {
    const groups = getEggGroupChoices();
    if (!groups.length) return [];
    const results = [];
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
    const btn = event?.currentTarget || document.getElementById('egg-roll-btn');
    if (!btn) return;
    renderFieldRollPopover(
        btn,
        rollEggGroupOptions,
        opt => opt.egg2 ? `${opt.egg1} / ${opt.egg2}` : opt.egg1,
        (opt) => {
            const egg1 = document.getElementById('fakemon-egg1');
            const egg2 = document.getElementById('fakemon-egg2');
            if (egg1) { egg1.value = opt.egg1; fireChange(egg1); }
            if (egg2) { egg2.value = opt.egg2 || ''; fireChange(egg2); }
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
