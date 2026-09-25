// ==================== global search ====================
// The search box in the header. What it looks through is js/features/search.ts;
// the box and its dropdown are js/app/shell/GlobalSearch.tsx, and the full
// /search?q= results page is js/app/pages/SearchPage.tsx.
// The dropdown shows a few of each kind as you type; Enter opens the results
// page with everything (like Facebook). Arrowing onto a suggestion and
// pressing Enter still opens that suggestion directly.

import { api } from '../core/app.ts';
import { navigateRoute } from '../core/router.ts';
import { notify } from '../app/store.ts';

// Whether the box is open (on phones it folds into an icon), plus counters
// the box watches: a bump to focusSeq focuses it, to clearSeq empties it.
const searchBox = { open: false, focusSeq: 0, clearSeq: 0 };

/** What the header's search box is told to do; see the counters above. */
export function globalSearchState() { return searchBox; }

function openGlobalSearch() {
    searchBox.open = true;
    searchBox.focusSeq++;
    notify();
}

function closeGlobalSearch({ clear = false }: { clear?: any } = {}) {
    if (clear) searchBox.clearSeq++;
    if (!searchBox.open && !clear) return;
    searchBox.open = false;
    notify();
}

// ==================== the results page ====================
// the filter tab a search asked for; the page takes it when the query changes
let pendingFilter = 'all';

/** The filter the last openSearchPage() asked for, once. */
export function takeSearchFilter() {
    const filter = pendingFilter;
    pendingFilter = 'all';
    return filter;
}

/**
 * Opens /search?q=<query>. The page reads the query from the address, so
 * it can be reloaded, shared, and gone back to.
 * @param query
 * @param {{filter?: string}} [options]
 */
function openSearchPage(query: string = '', options: Record<string, any> = {}) {
    const q = String(query || '').trim();
    pendingFilter = options.filter || 'all';
    closeGlobalSearch({ clear: true });
    api.activateTopLevelView?.('search-view');
    api.setPageTitle?.(q ? `${q} · Search` : 'Search');
    // each search is its own history entry
    navigateRoute(`search${q ? `?q=${encodeURIComponent(q)}` : ''}`);
}

// "/" jumps to search from anywhere that isn't already a text field
document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    const t = event.target as Element | null;
    if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    openGlobalSearch();
});

export { openGlobalSearch, closeGlobalSearch, openSearchPage };
