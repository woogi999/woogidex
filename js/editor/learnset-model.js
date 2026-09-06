// ==================== ability slots and learnset order ====================
// Ability-slot and learnset-sort rules, split out of renderAbilities()/
// renderLearnset() so they're testable without building markup.

/**
 * Which slot an ability sits in, by how many the Fakemon has. Positional
 * rather than stored, since adding a third ability turns the second one
 * from Hidden into ordinary.
 *
 *   1 ability -- no label
 *   2 or 3    -- last one is Hidden
 *   4         -- third is Hidden, fourth is Event
 *
 * @returns {'Hidden'|'Event'|''} '' for an ordinary slot
 */
export function abilityRole(index, count) {
    if (count >= 2 && count <= 3 && index === count - 1) return 'Hidden';
    if (count === 4 && index === 2) return 'Hidden';
    if (count === 4 && index === 3) return 'Event';
    return '';
}

// ==================== learnset filtering and sorting ====================

/**
 * Text search across the fields someone would actually type: the move's name,
 * its type, its category, and how it is learned. One box, not four.
 */
function matchesQuery(move, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return (move.name || '').toLowerCase().includes(q)
        || (move.type || '').toLowerCase().includes(q)
        || (move.category || '').toLowerCase().includes(q)
        || (move.learnMethod || '').toLowerCase().includes(q);
}

const CATEGORY_ORDER = { Physical: 0, Special: 1, Status: 2 };
const METHOD_ORDER = { level: 0, egg: 1, tm: 2, none: 3 };

/** Default order: custom moves first, then by learn method, then level; ties fall back to name. */
function defaultCompare(a, b, isCustomMove) {
    const customA = isCustomMove(a.m);
    const customB = isCustomMove(b.m);
    if (customA !== customB) return customA ? -1 : 1;
    if (customA && customB) return (a.m.name || '').localeCompare(b.m.name || '');

    const ma = a.m.learnMethod || 'none';
    const mb = b.m.learnMethod || 'none';
    const byMethod = (METHOD_ORDER[ma] ?? 3) - (METHOD_ORDER[mb] ?? 3);
    if (byMethod !== 0) return byMethod;

    if (ma === 'level' && a.m.level && b.m.level) return (a.m.level || 0) - (b.m.level || 0);
    return (a.m.name || '').localeCompare(b.m.name || '');
}

/**
 * Filters and orders the learnset for display. Entries keep their original index, since edits/removals are addressed by it -- sorting must never renumber the underlying data.
 *
 * @param {Array} learnset
 * @param {object} opts
 * @param {string} [opts.query]
 * @param {string} [opts.typeFilter]
 * @param {string} [opts.catFilter]
 * @param {string} [opts.sortMode] 'default' | 'name' | 'type' | 'power' | 'category'
 * @param {'asc'|'desc'} [opts.order] ignored for the default order, which has
 *   its own meaning and reads as nonsense reversed
 * @param {(move) => boolean} [opts.isCustomMove]
 * @returns {{m: object, i: number}[]}
 */
export function prepareLearnset(learnset, {
    query = '', typeFilter = '', catFilter = '',
    sortMode = 'default', order = 'asc',
    isCustomMove = () => false
} = {}) {
    let entries = (learnset || []).map((m, i) => ({ m, i }));

    entries = entries.filter(({ m }) => matchesQuery(m, query));
    if (typeFilter) entries = entries.filter(({ m }) => (m.type || '') === typeFilter);
    if (catFilter) entries = entries.filter(({ m }) => (m.category || '') === catFilter);

    const byName = (a, b) => (a.m.name || '').localeCompare(b.m.name || '');
    const compare = {
        name: byName,
        type: (a, b) => (a.m.type || '').localeCompare(b.m.type || '') || byName(a, b),
        power: (a, b) => (a.m.basePower || 0) - (b.m.basePower || 0) || byName(a, b),
        category: (a, b) =>
            (CATEGORY_ORDER[a.m.category] ?? 3) - (CATEGORY_ORDER[b.m.category] ?? 3) || byName(a, b)
    }[sortMode];

    entries.sort(compare || ((a, b) => defaultCompare(a, b, isCustomMove)));
    if (order === 'desc' && sortMode !== 'default') entries.reverse();

    return entries;
}

/** How a move's accuracy reads. `true` means "never misses", which is not 100%. */
export function accuracyText(accuracy) {
    if (accuracy === true || accuracy === false || accuracy === undefined || accuracy === null) return '-';
    return `${accuracy}%`;
}
