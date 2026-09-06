// ==================== what the block palette should show ====================
// Palette filtering logic, split from ability-blocks.js so it's testable
// without reading generated HTML.
//
// * Events are filtered by kind (ability/move/item) via TRIGGERS[key].kinds,
//   defaulting to ability-only.
// * Action groups drop anything with no definition, so a typo in
//   BLOCK_GROUPS produces a missing button rather than a dead one.
// * "if" has no ACTIONS entry but is always allowed through.

/** @typedef {{key: string, label: string}} PaletteEvent */
/** @typedef {{type: string, label: string}} PaletteItem */
/** @typedef {{label: string, color: string, items: PaletteItem[]}} PaletteGroup */

/**
 * @param {object} tables
 * @param {object} tables.TRIGGERS
 * @param {object} tables.ACTIONS
 * @param {Array}  tables.BLOCK_GROUPS
 * @param {object} tables.EVENT_GROUP
 * @param {'ability'|'move'|'item'} kind what is being coded
 * @returns {{events: PaletteEvent[], groups: PaletteGroup[]}}
 */
export function buildPaletteModel({ TRIGGERS, ACTIONS, BLOCK_GROUPS, EVENT_GROUP }, kind) {
    const events = (EVENT_GROUP?.items || [])
        .filter(key => {
            const t = TRIGGERS?.[key];
            return t && (t.kinds || ['ability']).includes(kind);
        })
        .map(key => ({ key, label: TRIGGERS[key].label }));

    const groups = (BLOCK_GROUPS || [])
        .map(group => ({
            label: group.label,
            color: group.color,
            items: (group.items || [])
                .filter(type => (type === 'if' ? true : !!ACTIONS?.[type]))
                .map(type => ({ type, label: paletteItemLabel(type, ACTIONS) }))
        }))
        .filter(group => group.items.length > 0);

    return { events, groups };
}

/** Visible name of an action button; turns "raise __ by __" into "raise … by …". */
export function paletteItemLabel(type, ACTIONS) {
    if (type === 'if') return 'If / Else';
    return String(ACTIONS?.[type]?.label || type).replace(/__+/g, '…');
}
