// Community Hub feed filter/sort (extracted from renderCommunityGrid()).
// A Fakemon with no dex number sorts last in either direction (placed at
// Infinity, not zero). Ties break by name, and the direction flag applies to
// the tiebreak too, so reversing the sort mirrors the grid exactly.

/**
 * A published mon's dex number as a number, or Infinity if it does not have one.
 */
export function getCommunityDexNumber(mon) {
    const n = parseInt(String(mon?.number || '').replace(/^#/, ''), 10);
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * Whether a feed row matches the hub's search box. Searches the Fakemon's name,
 * species and types as well as the author, because "show me everything by X"
 * and "show me the fire ones" are both things people type into it.
 */
export function matchesCommunitySearch(row, search) {
    if (!search) return true;
    const mon = row.fakemon_data || {};
    const text = `${mon.name || ''} ${mon.species || ''} ${mon.type1 || ''} ${mon.type2 || ''} ${row.author_name || ''}`;
    return text.toLowerCase().includes(String(search).toLowerCase());
}

const time = v => new Date(v || 0).getTime();

const SORT_KEYS = {
    activity: (a, b) => time(a.activity_at || a.published_at) - time(b.activity_at || b.published_at),
    likes: (a, b) => Number(a.like_count || 0) - Number(b.like_count || 0),
    comments: (a, b) => Number(a.comment_count || 0) - Number(b.comment_count || 0),
    views: (a, b) => Number(a.view_count || 0) - Number(b.view_count || 0),
    name: (a, b) => String(a.fakemon_data?.name || '').localeCompare(String(b.fakemon_data?.name || '')),
    author: (a, b) => String(a.author_name || '').localeCompare(String(b.author_name || '')),
    number: (a, b) => getCommunityDexNumber(a.fakemon_data) - getCommunityDexNumber(b.fakemon_data),
    published: (a, b) => time(a.published_at) - time(b.published_at)
};

/**
 * Filters and sorts the feed. Returns a new array -- rows are shared with the
 * detail view and artwork cache, so never mutated in place.
 *
 * @param {Array} rows
 * @param {{search?: string, sortBy?: string, sortOrder?: 'asc'|'desc'}} [prefs]
 */
export function prepareCommunityFeed(rows, { search = '', sortBy = 'published', sortOrder = 'desc' } = {}) {
    const compare = SORT_KEYS[sortBy] || SORT_KEYS.published;
    const dir = sortOrder === 'asc' ? 1 : -1;

    return (rows || [])
        .filter(row => matchesCommunitySearch(row, search))
        .slice()
        .sort((a, b) => {
            const result = compare(a, b) || SORT_KEYS.name(a, b);
            return result * dir;
        });
}

/** The message shown when the grid has nothing in it, which depends on why. */
export function emptyFeedMessage(search) {
    return search
        ? 'No Fakemon matched your search.'
        : 'Nobody has published a Fakemon yet - be the first!';
}

/**
 * One-line badge for posts bundling multiple Fakemon (evolution line, Mega,
 * formes). Prefers the most interesting fact over listing everything; falls
 * back to a raw count.
 *
 * @returns {string|null} null for an ordinary single-Fakemon post
 */
export function evoBadgeLabel(row) {
    const members = Array.isArray(row?.family_snapshots) ? row.family_snapshots : [];
    if (members.length < 2) return null;

    // Megas/forme changes aren't stages -- a Mega alone isn't "2-Stage"
    const stages = new Set(members.filter(m => !m.isMega && !m.isFormeChange).map(m => m.stage || 1));
    const bits = [];
    if (stages.size > 1) bits.push(`${stages.size}-Stage`);
    if (members.some(m => m.isMega)) bits.push('Has Mega');
    if (members.some(m => m.isFormeChange)) bits.push('Has Forme Change');
    if (!bits.length) bits.push(`${members.length} Forms`);
    return bits.join(' \u00b7 ');
}
