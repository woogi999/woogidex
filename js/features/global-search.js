// ==================== global search ====================
// The search box in the header, and the /search?q= results page behind it.
// Both look through the same things:
//   - places and actions: every page, plus the things you'd otherwise dig
//     through a menu for (New Fakemon, Dark mode, Sign in...)
//   - your own collection: Fakemon, folders, regions, custom moves /
//     abilities / items, all already in memory
//   - Community Hub posts, by name, species or creator -- signed in only,
//     since the hub itself asks you to sign in to open a post
// The dropdown shows a few of each as you type; Enter opens the results page
// with everything (like Facebook). Arrowing onto a suggestion and pressing
// Enter still opens that suggestion directly.

import { log } from '../core/log.js';
import { state, api } from '../core/app.js';
import { esc } from '../core/html.js';
import { basePath } from '../core/router.js';
import { shieldedArtHtml } from '../core/art-shield.js';

const DROPDOWN_LIMIT = 5;
const PAGE_LIMIT = 60;
const COMMUNITY_DROPDOWN_LIMIT = 6;
const COMMUNITY_PAGE_LIMIT = 40;
const COMMUNITY_DEBOUNCE_MS = 250;

// ---- places and actions ----
// keywords widen what a place answers to; `when` hides it if it doesn't apply
const PLACES = [
    { title: 'My Collection', sub: 'Your Fakémon and folders', icon: 'library', keywords: 'home fakemon folders library', run: () => api.showCollection?.() },
    { title: 'Community Hub', sub: 'See what others are making', icon: 'users', keywords: 'community hub feed', run: () => api.openCommunityHub?.() },
    { title: 'Browse Fakémon', sub: 'Community Hub', icon: 'layout-grid', keywords: 'browse community explore', run: () => api.openCommunityHub?.({ panel: 'browse' }) },
    { title: 'Events and contests', sub: 'Community Hub', icon: 'trophy', keywords: 'events contests vote', run: () => api.openCommunityHub?.({ panel: 'events' }) },
    { title: 'My uploads', sub: 'Community Hub', icon: 'upload', keywords: 'uploads published publish', run: () => api.openCommunityHub?.({ panel: 'uploads' }) },
    { title: 'Battle', sub: 'Battle your Fakémon', icon: 'swords', keywords: 'battle fight simulator team', run: () => api.openBattle?.() },
    { title: 'Updates', sub: "What's new in Woogidex", icon: 'newspaper', keywords: 'updates changelog news whats new', run: () => api.openUpdatesPage?.('updates') },
    { title: 'Credits', sub: 'Who makes Woogidex', icon: 'badge-info', keywords: 'credits about team', run: () => api.openUpdatesPage?.('credits') },
    { title: 'Settings', sub: 'Appearance, data and account', icon: 'settings', keywords: 'settings preferences options backup', run: () => api.openSettings?.() },
    { title: 'My profile', sub: 'Your public page', icon: 'user', keywords: 'profile account me', when: () => !!state.user, run: () => api.showProfileView?.() },
    { title: 'Terms of Service', sub: 'Policy', icon: 'scroll-text', keywords: 'terms tos legal', run: () => api.openTermsPage?.() },
    { title: 'Privacy Policy', sub: 'Policy', icon: 'shield', keywords: 'privacy policy legal data', run: () => api.openPrivacyPage?.() },
    { title: 'Community Rules', sub: 'Policy', icon: 'list-checks', keywords: 'rules guidelines community', run: () => api.openCommunityRulesModal?.() }
];
const ACTIONS = [
    { title: 'New Fakémon', sub: 'Create', icon: 'plus', keywords: 'create new fakemon add make', run: () => api.createNewFakemon?.() },
    { title: 'New folder', sub: 'Create', icon: 'folder-plus', keywords: 'create new folder', run: () => { api.showCollection?.(); api.createFolder?.(); } },
    { title: 'New region', sub: 'Create', icon: 'map', keywords: 'create new region dex', run: () => { api.showCollection?.(); api.createRegion?.(); } },
    { title: 'New custom move', sub: 'Create', icon: 'zap', keywords: 'create new custom move', run: () => { api.showCollection?.(); api.openLibraryEditorSheet?.('moves'); } },
    { title: 'New custom ability', sub: 'Create', icon: 'sparkles', keywords: 'create new custom ability', run: () => { api.showCollection?.(); api.openLibraryEditorSheet?.('abilities'); } },
    { title: 'New custom item', sub: 'Create', icon: 'gem', keywords: 'create new custom item', run: () => { api.showCollection?.(); api.openLibraryEditorSheet?.('items'); } },
    { title: 'New custom type', sub: 'Create', icon: 'shapes', keywords: 'create new custom type', run: () => { api.showCollection?.(); api.openCustomTypeEditor?.(); } },
    { title: 'Import Fakémon', sub: 'From a file', icon: 'file-input', keywords: 'import upload file json', run: () => { api.showCollection?.(); api.openImportModal?.(); } },
    { title: 'Dark mode', sub: 'Switch the theme', icon: 'moon', keywords: 'dark light theme mode night', run: () => api.toggleDarkMode?.() },
    { title: 'Sign in', sub: 'Account', icon: 'log-in', keywords: 'sign in login log account', when: () => !state.user, run: () => api.openAuthModal?.('signin') },
    { title: 'Sign out', sub: 'Account', icon: 'log-out', keywords: 'sign out logout log', when: () => !!state.user, run: () => api.handleSignOutClick?.() }
];
// what the box offers before you type anything
const QUICK = ['New Fakémon', 'My Collection', 'Community Hub', 'Battle', 'Updates'];

// the result groups, in display order; the page's filter tabs use the keys
const GROUPS = [
    ['fakemon', 'Your Fakémon'],
    ['library', 'Your library'],
    ['community', 'Community Hub'],
    ['pages', 'Pages and actions']
];

// ---- matching ----
function norm(text) {
    // accents off so "fakemon" finds "Fakémon"
    return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/** 0 for no match, higher is better: title prefix > word prefix > anywhere > keyword. */
function score(query, title, extra = '') {
    const q = norm(query);
    const t = norm(title);
    if (!q) return 0;
    if (t === q) return 100;
    if (t.startsWith(q)) return 80;
    if (t.split(/[\s\-_/]+/).some(word => word.startsWith(q))) return 60;
    if (t.includes(q)) return 40;
    if (norm(extra).includes(q)) return 20;
    return 0;
}

/** The title with the matched run wrapped in <mark>, escaped either way. */
function highlight(title, query) {
    const text = String(title || '');
    const at = norm(text).indexOf(norm(query));
    // only safe to slice when normalising didn't change the length
    if (!query || at === -1 || norm(text).length !== text.length) return esc(text);
    const end = at + norm(query).length;
    return `${esc(text.slice(0, at))}<mark>${esc(text.slice(at, end))}</mark>${esc(text.slice(end))}`;
}

function top(list, n) {
    return list.filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, n);
}

// ---- result sources ----
function placeResults(query, limit) {
    const all = [...ACTIONS, ...PLACES].filter(p => !p.when || p.when());
    return top(all.map(p => ({ ...p, score: score(query, p.title, p.keywords) })), limit);
}

function fakemonResults(query, limit) {
    const regionName = entry => (api.entryRegionIds?.(entry) || []).map(id => (api.getRegions?.() || []).find(r => String(r.id) === id)?.name).filter(Boolean).join(', ');
    return top((state.fakemonDB || []).map(f => ({
        title: f.name || 'Unnamed',
        sub: [f.number, [f.type1, f.type2].filter(Boolean).join(' / '), f.species, regionName(f)].filter(Boolean).join(' · '),
        art: f.artwork || '',
        icon: 'circle-dashed',
        score: score(query, f.name, `${f.species || ''} ${f.type1 || ''} ${f.type2 || ''} ${f.number || ''} ${regionName(f)}`),
        run: () => api.editFakemon?.(f.id)
    })), limit);
}

function libraryResults(query, limit) {
    const kinds = [
        ['moves', state.customMoves, 'Custom move', 'zap'],
        ['abilities', state.customAbilities, 'Custom ability', 'sparkles'],
        ['items', state.customItems, 'Custom item', 'gem']
    ];
    const rows = [];
    for (const [kind, list, label, icon] of kinds) {
        for (const item of list || []) {
            rows.push({
                title: item.name || 'Unnamed',
                sub: item.type ? `${label} · ${item.type}` : label,
                art: kind === 'items' ? (item.artwork || '') : '',
                icon,
                score: score(query, item.name, item.desc),
                run: () => { api.showCollection?.(); api.openLibraryEditorSheet?.(kind, item.id); }
            });
        }
    }
    for (const folder of state.folders || []) {
        if (folder.type === 'region' || folder.type === 'custom-type') continue;
        const kind = folder.type || 'fakemon';
        rows.push({
            title: folder.name || 'Folder',
            sub: `Folder · ${kind === 'fakemon' ? 'Fakémon' : kind.charAt(0).toUpperCase() + kind.slice(1)}`,
            icon: 'folder',
            score: score(query, folder.name),
            run: () => { api.showCollection?.(); api.setCollectionView?.(kind); api.openFolder?.(folder.id); }
        });
    }
    for (const t of api.getCustomTypes?.() || []) {
        rows.push({
            title: t.name, sub: 'Custom type', icon: 'shapes',
            score: score(query, t.name, t.desc),
            run: () => { api.showCollection?.(); api.openCustomTypeEditor?.(t.id); }
        });
    }
    for (const region of api.getRegions?.() || []) {
        rows.push({
            title: region.name || 'Region',
            sub: 'Region',
            icon: 'map',
            score: score(query, region.name),
            run: () => { api.showCollection?.(); api.selectRegion?.(region.id); }
        });
    }
    return top(rows, limit);
}

// commas and parentheses are PostgREST's own syntax inside or=(...); % and _
// are LIKE wildcards. None of them are worth searching for, so they go.
function communityPattern(query) {
    const cleaned = String(query || '').replace(/[,()%_*\\]/g, ' ').trim().replace(/\s+/g, ' ');
    return cleaned ? `%${cleaned}%` : '';
}

async function communityResults(query, limit) {
    const pattern = communityPattern(query);
    if (!pattern || !state.user) return [];
    const client = await api.getClient?.();
    if (!client) return [];
    // same slim columns as the feed: no images, no full fakemon_data
    const { data, error } = await client
        .from('published_mons')
        .select('id, author_name, fakemon_data->>name, fakemon_data->>species, fakemon_data->>type1, fakemon_data->>type2')
        .or(`fakemon_data->>name.ilike.${pattern},fakemon_data->>species.ilike.${pattern},author_name.ilike.${pattern}`)
        .order('activity_at', { ascending: false })
        .limit(limit * 2);
    if (error) throw error;
    return top((data || []).map(row => ({
        title: row.name || 'Unnamed',
        sub: [`by ${row.author_name || 'someone'}`, [row.type1, row.type2].filter(Boolean).join(' / ')].filter(Boolean).join(' · '),
        icon: 'globe',
        publishedId: row.id,
        // author matches rank under name/species matches
        score: Math.max(score(query, row.name, row.species), score(query, row.author_name) / 2, 1),
        run: () => api.openPublishedMonById?.(row.id)
    })), limit);
}

/** Everything local, synchronously: [[key, label, results], ...]. */
function localGroups(query, limit) {
    return {
        fakemon: fakemonResults(query, limit),
        library: libraryResults(query, limit),
        pages: placeResults(query, limit)
    };
}

// ---- shared row markup ----
function thumbHtml(r) {
    if (r.art) return `<span class="gs-thumb is-art"><img src="${esc(r.art)}" alt="" loading="lazy" decoding="async"></span>`;
    // community artwork arrives later (requestCardArtwork); the icon holds the slot
    const hook = r.publishedId ? ` data-community-art="${esc(r.publishedId)}"` : '';
    return `<span class="gs-thumb"${hook}><i data-lucide="${esc(r.icon || 'search')}"></i></span>`;
}

function rowHtml(r, index, query, extraClass = '') {
    return `<button type="button" class="gs-item${extraClass}" role="option" id="gs-opt-${index}" data-index="${index}" aria-selected="false">
        ${thumbHtml(r)}
        <span class="gs-text"><span class="gs-title">${highlight(r.title, query)}</span>${r.sub ? `<span class="gs-sub">${esc(r.sub)}</span>` : ''}</span>
    </button>`;
}

// paints community thumbnails into any rows that are still on the screen
function paintCommunityArt(root) {
    root.querySelectorAll('[data-community-art]').forEach(slot => {
        const id = slot.dataset.communityArt;
        api.requestCardArtwork?.(id).then(art => {
            if (!art || !slot.isConnected) return;
            slot.classList.add('is-art');
            slot.innerHTML = shieldedArtHtml(art, { alt: '' });
        }).catch(() => {});
    });
}

// ==================== the dropdown ====================
let results = [];        // flat list, in display order, for the keyboard
let activeIndex = -1;
let communityTimer = null;
let searchSeq = 0;       // bumps per keystroke; a late community answer checks it
const els = {};

function render(groups, query, communityStatus = '') {
    results = [];
    let html = '';
    for (const [label, list] of groups) {
        if (!list.length) continue;
        html += `<div class="gs-group-label">${esc(label)}</div>`;
        for (const r of list) {
            html += rowHtml(r, results.length, query);
            results.push(r);
        }
    }
    if (communityStatus) html += `<div class="gs-status">${esc(communityStatus)}</div>`;
    if (!results.length && !communityStatus) html = `<div class="gs-empty">Nothing matches “${esc(query)}”.</div>`;
    // the way to the full results page, like Facebook's "Search for ..." row
    if (query) {
        html += `<button type="button" class="gs-item gs-see-all" data-see-all="1"><span class="gs-thumb"><i data-lucide="search"></i></span><span class="gs-text"><span class="gs-title">See all results for “${esc(query)}”</span></span></button>`;
    }
    els.results.innerHTML = html;
    activeIndex = -1;
    els.input.removeAttribute('aria-activedescendant');
    showResults(true);
    if (typeof lucide !== 'undefined') lucide.createIcons();
    paintCommunityArt(els.results);
}

function showResults(open) {
    els.results.hidden = !open;
    els.input.setAttribute('aria-expanded', String(open));
}

function setActive(index) {
    const items = els.results.querySelectorAll('.gs-item[data-index]');
    if (!items.length) return;
    activeIndex = (index + items.length) % items.length;
    items.forEach((el, i) => {
        const on = i === activeIndex;
        el.classList.toggle('is-active', on);
        el.setAttribute('aria-selected', String(on));
        if (on) el.scrollIntoView({ block: 'nearest' });
    });
    els.input.setAttribute('aria-activedescendant', `gs-opt-${activeIndex}`);
}

function runResult(r) {
    if (!r) return;
    closeGlobalSearch({ clear: true });
    try { r.run(); } catch (err) { log.error('SEARCH', 'Search result action failed', { title: r.title, error: String(err) }); }
}

function syncClearButton() {
    if (els.clear) els.clear.hidden = !els.input.value;
}

function update() {
    syncClearButton();
    const query = els.input.value.trim();
    const seq = ++searchSeq;
    clearTimeout(communityTimer);

    if (!query) {
        const quick = QUICK.map(t => [...ACTIONS, ...PLACES].find(p => p.title === t)).filter(Boolean);
        render([['Go to', quick]], '');
        return;
    }

    const g = localGroups(query, DROPDOWN_LIMIT);
    const local = [['Your Fakémon', g.fakemon], ['Your library', g.library], ['Pages and actions', g.pages]];
    if (!state.user) {
        render(local, query, 'Sign in to search Community Hub posts too.');
        return;
    }
    render(local, query, 'Searching the Community Hub…');
    communityTimer = setTimeout(async () => {
        let community = [];
        let status = '';
        try { community = await communityResults(query, COMMUNITY_DROPDOWN_LIMIT); }
        catch (err) {
            log.warn('SEARCH', 'Community search failed', { error: String(err?.message || err) });
            status = 'The Community Hub could not be searched right now.';
        }
        if (seq !== searchSeq) return; // typed on since; this answer is stale
        render([...local.slice(0, 2), ['Community Hub', community], local[2]], query, status);
    }, COMMUNITY_DEBOUNCE_MS);
}

function openGlobalSearch() {
    els.root?.classList.add('open');
    els.input?.focus();
}

function closeGlobalSearch({ clear = false } = {}) {
    clearTimeout(communityTimer);
    searchSeq++;
    if (clear && els.input) { els.input.value = ''; syncClearButton(); }
    els.root?.classList.remove('open');
    if (els.results) showResults(false);
    if (document.activeElement === els.input) els.input.blur();
}

// ==================== the results page ====================
const page = { query: '', filter: 'all', groups: null, communityStatus: '', seq: 0 };

/**
 * Opens /search?q=<query>. Runs the full search (bigger limits than the
 * dropdown, community included when signed in).
 * @param {string} query
 * @param {{filter?: string}} [options]
 */
async function openSearchPage(query = '', options = {}) {
    const q = String(query || '').trim();
    page.query = q;
    page.filter = options.filter || 'all';
    closeGlobalSearch({ clear: true });
    api.activateTopLevelView?.('search-view');
    api.setPageTitle?.(q ? `${q} · Search` : 'Search');
    // the query lives in ?q= so the page can be reloaded and shared
    try {
        const url = `${basePath()}search${q ? `?q=${encodeURIComponent(q)}` : ''}`;
        history.replaceState(null, '', url);
    } catch { /* file://: the page still works, the address bar just doesn't follow */ }

    const input = document.getElementById('search-page-input');
    if (input && input.value !== q) input.value = q;

    const seq = ++page.seq;
    const g = q ? localGroups(q, PAGE_LIMIT) : { fakemon: [], library: [], pages: [] };
    page.groups = { ...g, community: [] };
    page.communityStatus = q && state.user ? 'loading' : (q ? 'signed-out' : '');
    renderSearchPage();
    if (!q || !state.user) return;
    try {
        const community = await communityResults(q, COMMUNITY_PAGE_LIMIT);
        if (seq !== page.seq) return;
        page.groups.community = community;
        page.communityStatus = '';
    } catch (err) {
        if (seq !== page.seq) return;
        log.warn('SEARCH', 'Community search failed', { error: String(err?.message || err) });
        page.communityStatus = 'error';
    }
    renderSearchPage();
}

function setSearchFilter(filter) {
    page.filter = filter;
    renderSearchPage();
}

function renderSearchPage() {
    const host = document.getElementById('search-page-results');
    const tabs = document.getElementById('search-page-tabs');
    const title = document.getElementById('search-page-subtitle');
    if (!host || !page.groups) return;
    const q = page.query;
    if (title) title.textContent = q ? `Results for “${q}”` : 'Search your collection, pages and the Community Hub.';

    const count = key => page.groups[key]?.length || 0;
    const total = GROUPS.reduce((n, [key]) => n + count(key), 0);
    if (tabs) {
        tabs.innerHTML = [['all', 'All', total], ...GROUPS.map(([key, label]) => [key, label.replace(/^Your /, '').replace(/^./, c => c.toUpperCase()), count(key)])]
            .map(([key, label, n]) => `<button type="button" role="tab" class="tab${page.filter === key ? ' active' : ''}" aria-selected="${page.filter === key}" onclick="setSearchFilter('${key}')">${esc(label)}${q ? `<span class="search-tab-count">${n}</span>` : ''}</button>`)
            .join('');
    }

    if (!q) {
        host.innerHTML = `<div class="search-page-empty"><i data-lucide="search"></i><p>Type something to search for.</p></div>`;
        if (typeof lucide !== 'undefined') lucide.createIcons();
        return;
    }

    const flat = [];
    const section = ([key, label], cap) => {
        const list = page.groups[key] || [];
        let status = '';
        if (key === 'community') {
            if (page.communityStatus === 'loading') status = 'Searching the Community Hub…';
            else if (page.communityStatus === 'signed-out') status = 'Sign in to search Community Hub posts.';
            else if (page.communityStatus === 'error') status = 'The Community Hub could not be searched right now.';
        }
        if (!list.length && !status) return '';
        const shown = cap ? list.slice(0, cap) : list;
        const rows = shown.map(r => { flat.push(r); return rowHtml(r, flat.length - 1, q, ' search-row'); }).join('');
        const more = cap && list.length > cap
            ? `<button type="button" class="btn btn-secondary btn-sm search-see-more" onclick="setSearchFilter('${key}')">See all ${list.length}</button>` : '';
        return `<section class="search-section">
            <header class="search-section-head"><h2>${esc(label)}</h2>${more}</header>
            ${rows ? `<div class="search-list">${rows}</div>` : ''}
            ${status ? `<p class="search-section-status">${esc(status)}</p>` : ''}
        </section>`;
    };

    const html = page.filter === 'all'
        ? GROUPS.map(g => section(g, 6)).join('')
        : section(GROUPS.find(([key]) => key === page.filter) || GROUPS[0], 0);
    host.innerHTML = html || `<div class="search-page-empty"><i data-lucide="search-x"></i><p>Nothing matches “${esc(q)}”.</p><span>Check the spelling, or try a shorter word.</span></div>`;
    host.onclick = (event) => {
        const item = event.target.closest('.gs-item[data-index]');
        if (item) runResult(flat[Number(item.dataset.index)]);
    };
    if (typeof lucide !== 'undefined') lucide.createIcons();
    paintCommunityArt(host);
}

function submitSearchPage(event) {
    event?.preventDefault?.();
    openSearchPage(document.getElementById('search-page-input')?.value || '', { filter: page.filter });
}

// ==================== wiring ====================
function init() {
    els.root = document.getElementById('global-search');
    els.input = document.getElementById('global-search-input');
    els.results = document.getElementById('global-search-results');
    els.clear = document.getElementById('global-search-clear');
    if (!els.root || !els.input || !els.results) return;

    els.input.addEventListener('input', update);
    els.input.addEventListener('focus', () => { els.root.classList.add('open'); update(); });
    els.input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive(activeIndex + 1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(activeIndex - 1); }
        else if (event.key === 'Enter') {
            event.preventDefault();
            // a highlighted suggestion opens itself; otherwise Enter means "search"
            if (activeIndex !== -1) runResult(results[activeIndex]);
            else if (els.input.value.trim()) openSearchPage(els.input.value);
        }
        else if (event.key === 'Escape') { event.preventDefault(); closeGlobalSearch(); }
    });
    els.clear?.addEventListener('mousedown', (event) => {
        // mousedown so the input keeps focus and the list stays open
        event.preventDefault();
        els.input.value = '';
        update();
        els.input.focus();
    });
    // mousedown, not click: a click would blur the input first and close the list
    els.results.addEventListener('mousedown', (event) => {
        const item = event.target.closest('.gs-item');
        if (!item) return;
        event.preventDefault();
        if (item.dataset.seeAll) openSearchPage(els.input.value);
        else runResult(results[Number(item.dataset.index)]);
    });
    document.addEventListener('mousedown', (event) => {
        if (!els.root.contains(event.target)) closeGlobalSearch();
    });
    // "/" jumps to search from anywhere that isn't already a text field
    document.addEventListener('keydown', (event) => {
        if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
        const t = event.target;
        if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
        event.preventDefault();
        openGlobalSearch();
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

export { openGlobalSearch, closeGlobalSearch, openSearchPage, setSearchFilter, submitSearchPage };
