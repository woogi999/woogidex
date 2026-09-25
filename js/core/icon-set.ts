// The site's icons: Heroicons, solid style (js/core/icon-data.ts), drawn by
// js/app/components/Icon.tsx. Icons are named the app's way ("x", "trash-2");
// icon-data.ts maps those names onto Heroicons, and any Heroicon's own name
// works too.

import { HERO_PATHS, ICON_NAMES } from './icon-data.ts';

const FALLBACK = 'question-mark-circle';
const warned = new Set();

// Every other Heroicon lives in js/core/heroicons-all.ts, a separate chunk
// fetched the first time an icon outside icon-data.ts is asked for (badge
// icons are chosen by staff from the whole set). Until it arrives such an
// icon draws blank, and <Icon> redraws it once the set has arrived.
let allPaths: any = null;
let allLoading: any = null;
const allListeners = new Set<() => void>();

function lookup(name) {
    const hero = ICON_NAMES[name] || name;
    return HERO_PATHS[hero] || allPaths?.[hero] || null;
}

/** Loads every Heroicon; resolves once icons drawn before it arrived are filled in. */
export function loadAllIcons() {
    if (!allLoading) {
        allLoading = import('./heroicons-all.ts').then(m => {
            allPaths = m.ALL_HERO_PATHS;
            allListeners.forEach(fn => fn());
            return allPaths;
        });
    }
    return allLoading;
}

/** Every Heroicon name, for pickers. Loads the full set first. */
export async function allIconNames() {
    return Object.keys(await loadAllIcons());
}

/** Calls fn once the full set has loaded (React components re-render on it). */
export function onAllIconsLoaded(fn) {
    allListeners.add(fn);
    return () => allListeners.delete(fn);
}

/** Whether an icon can be drawn right now without the full set. */
export function isIconReady(name) {
    return !!lookup(name) || !!allPaths;
}

/** The Heroicon's inner markup for an app icon name. */
export function iconPathsFor(name) {
    const paths = lookup(name);
    if (paths) return paths;
    if (!allPaths) { loadAllIcons(); return ''; }
    if (!warned.has(name)) {
        warned.add(name);
        console.warn(`[icons] no icon named "${name}"; add it to js/core/icon-data.ts or use a Heroicon name`);
    }
    return HERO_PATHS[FALLBACK] || '';
}
