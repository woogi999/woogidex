import { generateFakemonNames } from './name-generator.js';
import { state } from './app.js';

// small popover UI for the dice button next to the name field. keeps a
// short rotating list of suggestions so a click that doesn't land on a name
// the user likes just re-rolls, rather than committing to a single guess.
let activePopover = null;

function closeNameRollPopover() {
    if (activePopover) {
        activePopover.remove();
        activePopover = null;
        document.removeEventListener('click', onOutsideClick);
    }
}

function onOutsideClick(e) {
    if (activePopover && !activePopover.contains(e.target) && e.target.id !== 'name-roll-btn') {
        closeNameRollPopover();
    }
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

function renderPopover(names, anchorBtn) {
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

    const rect = anchorBtn.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = `${rect.bottom + 6}px`;
    pop.style.left = `${Math.max(8, rect.right - pop.offsetWidth)}px`;
    // clamp after we know actual width
    requestAnimationFrame(() => {
        const w = pop.offsetWidth;
        pop.style.left = `${Math.min(Math.max(8, rect.right - w), window.innerWidth - w - 8)}px`;
    });

    pop.querySelectorAll('.name-roll-option').forEach(btn => {
        btn.addEventListener('click', () => applyRolledName(btn.textContent));
    });
    pop.querySelector('.name-roll-reroll')?.addEventListener('click', () => {
        renderPopover(rollNames(), anchorBtn);
    });

    if (typeof lucide !== 'undefined') lucide.createIcons();
    activePopover = pop;
    setTimeout(() => document.addEventListener('click', onOutsideClick), 0);
}

function openNameRollPopover(event) {
    event?.stopPropagation();
    const btn = event?.currentTarget || document.getElementById('name-roll-btn');
    if (!btn) return;
    renderPopover(rollNames(), btn);
}

export { openNameRollPopover, closeNameRollPopover };
