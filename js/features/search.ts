// ==================== what search looks through ====================
// Shared by the header's search box (js/features/global-search.ts) and the
// /search?q= results page (js/app/pages/SearchPage.tsx):
//   - places and actions: every page, plus the things you'd otherwise dig
//     through a menu for (New Fakemon, Dark mode, Sign in...)
//   - your own collection: Fakemon, folders, regions, custom moves /
//     abilities / items, all already in memory
//   - Community Hub posts, by name, species or creator -- signed in only,
//     since the hub itself asks you to sign in to open a post

import { state, api } from '../core/app.ts';

export interface SearchResult {
    title: string;
    sub?: string;
    icon?: string;
    /** an image to show instead of the icon */
    art?: string;
    /** a Community Hub post, whose artwork is fetched separately */
    publishedId?: string;
    score: number;
    run: () => void;
}

interface Entry { title: string; sub: string; icon: string; keywords: string; when?: () => boolean; run: () => void; }

export const DROPDOWN_LIMIT = 5;
export const PAGE_LIMIT = 60;
export const COMMUNITY_DROPDOWN_LIMIT = 6;
export const COMMUNITY_PAGE_LIMIT = 40;

// ---- places and actions ----
// keywords widen what a place answers to; `when` hides it if it doesn't apply
export const PLACES: Entry[] = [
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
    { title: 'Feedback & bug reports', sub: 'Tell us what’s wrong or what you’d like', icon: 'message-circle-warning', keywords: 'feedback bug report issue idea suggestion', run: () => api.openFeedbackModal?.() },
    { title: 'Terms of Service', sub: 'Policy', icon: 'scroll-text', keywords: 'terms tos legal', run: () => api.openTermsPage?.() },
    { title: 'Privacy Policy', sub: 'Policy', icon: 'shield', keywords: 'privacy policy legal data', run: () => api.openPrivacyPage?.() },
    { title: 'Community Rules', sub: 'Policy', icon: 'list-checks', keywords: 'rules guidelines community', run: () => api.openCommunityRulesModal?.() }
];
export const ACTIONS: Entry[] = [
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
/** what the box offers before you type anything */
export const QUICK = ['New Fakémon', 'My Collection', 'Community Hub', 'Battle', 'Updates'];

export type GroupKey = 'fakemon' | 'library' | 'community' | 'pages';
/** the result groups, in display order; the page's filter tabs use the keys */
export const GROUPS: Array<[GroupKey, string]> = [
    ['fakemon', 'Your Fakémon'],
    ['library', 'Your library'],
    ['community', 'Community Hub'],
    ['pages', 'Pages and actions']
];

// ---- matching ----
export function norm(text: unknown): string {
    // accents off so "fakemon" finds "Fakémon"
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** 0 for no match, higher is better: title prefix > word prefix > anywhere > keyword. */
export function score(query: string, title: unknown, extra: unknown = ''): number {
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

/**
 * Where the query matches inside the title, as [before, match, after], or
 * null when it doesn't (or accents make the positions unreliable).
 */
export function matchParts(title: string, query: string): [string, string, string] | null {
    const text = String(title || '');
    const at = norm(text).indexOf(norm(query));
    if (!query || at === -1 || norm(text).length !== text.length) return null;
    const end = at + norm(query).length;
    return [text.slice(0, at), text.slice(at, end), text.slice(end)];
}

function top(list: SearchResult[], n: number): SearchResult[] {
    return list.filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, n);
}

// ---- result sources ----
export function placeResults(query: string, limit: number): SearchResult[] {
    const all = [...ACTIONS, ...PLACES].filter(p => !p.when || p.when());
    return top(all.map(p => ({ ...p, score: score(query, p.title, p.keywords) })), limit);
}

/** The places the box offers before anything is typed. */
export function quickResults(): SearchResult[] {
    return QUICK.map(t => [...ACTIONS, ...PLACES].find(p => p.title === t)).filter((p): p is Entry => !!p).map(p => ({ ...p, score: 1 }));
}

function regionNames(entry: any): string {
    const regions: any[] = api.getRegions?.() || [];
    return (api.entryRegionIds?.(entry) || []).map((id: string) => regions.find(r => String(r.id) === id)?.name).filter(Boolean).join(', ');
}

export function fakemonResults(query: string, limit: number): SearchResult[] {
    return top((state.fakemonDB || []).filter(f => !f.pendingVanilla).map(f => ({
        title: f.name || 'Unnamed',
        sub: [f.number, [f.type1, f.type2].filter(Boolean).join(' / '), f.species, regionNames(f)].filter(Boolean).join(' · '),
        art: f.artwork || '',
        icon: 'circle-dashed',
        score: score(query, f.name, `${f.species || ''} ${f.type1 || ''} ${f.type2 || ''} ${f.number || ''} ${regionNames(f)}`),
        run: () => api.editFakemon?.(f.id)
    })), limit);
}

export function libraryResults(query: string, limit: number): SearchResult[] {
    const kinds: Array<['moves' | 'abilities' | 'items', any[], string, string]> = [
        ['moves', state.customMoves, 'Custom move', 'zap'],
        ['abilities', state.customAbilities, 'Custom ability', 'sparkles'],
        ['items', state.customItems, 'Custom item', 'gem']
    ];
    const rows: SearchResult[] = [];
    for (const [kind, list, label, icon] of kinds) {
        for (const item of list || []) {
            if (item.pendingVanilla) continue;
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
function communityPattern(query: string): string {
    const cleaned = String(query || '').replace(/[,()%_*\\]/g, ' ').trim().replace(/\s+/g, ' ');
    return cleaned ? `%${cleaned}%` : '';
}

export async function communityResults(query: string, limit: number): Promise<SearchResult[]> {
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
    return top((data || []).map((row: any) => ({
        title: row.name || 'Unnamed',
        sub: [`by ${row.author_name || 'someone'}`, [row.type1, row.type2].filter(Boolean).join(' / ')].filter(Boolean).join(' · '),
        icon: 'globe',
        publishedId: row.id,
        // author matches rank under name/species matches
        score: Math.max(score(query, row.name, row.species), score(query, row.author_name) / 2, 1),
        run: () => api.openPublishedMonById?.(row.id)
    })), limit);
}

/** Everything in memory, synchronously. */
export function localGroups(query: string, limit: number): Record<Exclude<GroupKey, 'community'>, SearchResult[]> {
    return {
        fakemon: fakemonResults(query, limit),
        library: libraryResults(query, limit),
        pages: placeResults(query, limit)
    };
}
