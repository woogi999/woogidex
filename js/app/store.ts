// React's view of the app's state.
//
// The data itself stays in the one mutable `state` object (js/core/app.ts)
// that the storage, battle and analysis code already read and write. React
// components read from it directly; whatever changes it calls notify(), and
// every component using useStore() re-renders. One version number instead of
// per-field subscriptions keeps this impossible to get subtly wrong, and the
// app is small enough that re-rendering the visible page is cheap.

import { useSyncExternalStore } from 'react';

type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;
let queued = false;

/**
 * Tells React the shared state changed. Several calls in one tick (a save
 * touches the collection, the manifest and the sidebar) become one render.
 */
export function notify(): void {
    version++;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
        queued = false;
        listeners.forEach(fn => fn());
    });
}

/**
 * notify(), but the components re-render before this returns. For values a
 * controlled input shows: React puts an input back to its current value right
 * after the keystroke's event, so the new value has to be there by then.
 */
export function notifySync(): void {
    version++;
    listeners.forEach(fn => fn());
}

export function subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** Re-renders the calling component whenever notify() runs; returns the version. */
export function useStore(): number {
    return useSyncExternalStore(subscribe, () => version);
}

// ---- pages being opened ----
// A React page stays mounted while hidden, so "when it opens" is a counter
// the page shell bumps each time it shows the page; an effect keyed on it
// runs on every visit (refetching what may have changed meanwhile).
const shown = new Map<string, number>();

/** Called by the page shell whenever it shows a page. */
export function markViewShown(viewId: string): void {
    shown.set(viewId, (shown.get(viewId) || 0) + 1);
    notify();
}

/** How many times the page has been shown; changes on every visit. */
export function useViewShown(viewId: string): number {
    useStore();
    return shown.get(viewId) || 0;
}
