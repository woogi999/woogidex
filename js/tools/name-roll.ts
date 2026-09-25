import { generateFakemonNames } from './name-generator.ts';
import { state } from '../core/app.ts';
import { editForm, form } from '../editor/draft.ts';
import { closeDialog } from '../app/dialogs.tsx';
import { openRollPopover, rollPoint } from './field-roll.ts';

// dice-button popover next to the name field; a rotating list of suggestions
// so a miss just re-rolls instead of committing to a single guess

function closeNameRollPopover() {
    closeDialog('roll');
}

function collectTraits() {
    const type1 = form.type1 || '';
    const type2 = form.type2 || '';
    const species = form.species || '';
    const ability = (state.abilities || []).map(a => a?.name || '').filter(Boolean).join(' ');
    const existingNames = (state.fakemonDB || []).map(f => f?.name).filter(Boolean);
    return { type1, type2, species, ability, theme: species, existingNames };
}

function rollNames() {
    const traits = collectTraits();
    return generateFakemonNames(traits, 6);
}

function applyRolledName(name) {
    editForm({ name });
    document.getElementById('fakemon-name')?.focus();
}

function openNameRollPopover(event) {
    event?.stopPropagation();
    openRollPopover(rollPoint(event, 'name-roll-btn'), rollNames, name => name, applyRolledName, 'Suggested names');
}

export { openNameRollPopover, closeNameRollPopover };
