import { generateFakemonNames } from './name-generator.js';
import { state } from '../core/app.js';

// dice-button popover next to the name field; a rotating list of suggestions
// so a miss just re-rolls instead of committing to a single guess
let activePopover = null;

function closeNameRollPopover() {
    if (activePopover) {
        activePopover.remove();
        activePopover = null;
        document.removeEventListener('click', onOutsideClick);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onScroll);
    }
}

function onOutsideClick(e) {
    if (activePopover && !activePopover.contains(e.target) && e.target.id !== 'name-roll-btn') {
        closeNameRollPopover();
    }
}

// position:fixed doesn't track the anchor on scroll, so just close it
function onScroll() {
    closeNameRollPopover();
}

// the site uses CSS `zoom` for responsive scaling, which also rescales
// position:fixed descendants, so raw coordinates need correcting for it;
// this multiplies together every zoom level up the ancestor chain
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

function collectTraits() {
    const type1 = document.getElementById('fakemon-type1')?.value || '';
    const type2 = document.getElementById('fakemon-type2')?.value || '';
    const species = document.getElementById('fakemon-species')?.value || '';
    const ability = (state.abilities || []).map(a => a?.name || '').filter(Boolean).join(' ');
    const existingNames = (state.fakemonDB || []).map(f => f?.name).filter(Boolean);
    return { type1, type2, species, ability, theme: species, existingNames };
}

function rollNames() {
    const traits = collectTraits();
    return generateFakemonNames(traits, 6);
}

function applyRolledName(name) {
    const input = document.getElementById('fakemon-name');
    if (!input) return;
    input.value = name;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    closeNameRollPopover();
    input.focus();
}

function renderPopover(names, point) {
    closeNameRollPopover();
    const pop = document.createElement('div');
    pop.className = 'name-roll-popover';
    pop.innerHTML = `
        <div class="name-roll-popover-head">
            <span>Suggested names</span>
            <button type="button" class="name-roll-reroll" title="Reroll" aria-label="Reroll">
                <i data-lucide="dices"></i>
            </button>
        </div>
        <div class="name-roll-list">
            ${names.map(n => `<button type="button" class="name-roll-option">${n}</button>`).join('')}
        </div>
    `;
    document.body.appendChild(pop);

    // point.x/y are real (post-zoom) viewport pixels; offsetWidth/height and
    // any top/left we assign live in the popover's local pre-zoom space and
    // get rescaled by `zoom` on render, so convert to real units, do the math,
    // then divide back down. Position is computed once and doesn't follow the cursor.
    const zoom = getEffectiveZoom(pop);
    pop.style.position = 'fixed';

    const place = () => {
        const realWidth = pop.offsetWidth * zoom;
        const realHeight = pop.offsetHeight * zoom;
        const left = Math.min(Math.max(8, point.x), window.innerWidth - realWidth - 8);
        const top = Math.min(Math.max(8, point.y), window.innerHeight - realHeight - 8);
        pop.style.top = `${top / zoom}px`;
        pop.style.left = `${left / zoom}px`;
    };
    place();
    // re-run once laid out in case fonts/content shifted the size
    requestAnimationFrame(place);

    pop.querySelectorAll('.name-roll-option').forEach(btn => {
        btn.addEventListener('click', () => applyRolledName(btn.textContent));
    });
    pop.querySelector('.name-roll-reroll')?.addEventListener('click', () => {
        renderPopover(rollNames(), point);
    });

    if (typeof lucide !== 'undefined') lucide.createIcons();
    activePopover = pop;
    setTimeout(() => document.addEventListener('click', onOutsideClick), 0);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
}

function openNameRollPopover(event) {
    event?.stopPropagation();
    let point;
    if (event && typeof event.clientX === 'number') {
        point = { x: event.clientX, y: event.clientY + 10 };
    } else {
        const btn = event?.currentTarget || document.getElementById('name-roll-btn');
        const rect = btn?.getBoundingClientRect();
        point = rect ? { x: rect.left, y: rect.bottom + 6 } : { x: 20, y: 20 };
    }
    renderPopover(rollNames(), point);
}

export { openNameRollPopover, closeNameRollPopover };
