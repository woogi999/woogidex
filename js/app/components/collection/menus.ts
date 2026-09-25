// Which collection card has its actions (phones: behind the "..." button) or
// its export menu open. Only one of each at a time, across every card on the
// page, and a click anywhere else closes them, so it lives outside the cards.

import { useSyncExternalStore } from 'react';

type Menus = { actions: string | null; exports: string | null };
let menus: Menus = { actions: null, exports: null };
const listeners = new Set<() => void>();

function set(next: Partial<Menus>) {
    const merged = { ...menus, ...next };
    if (merged.actions === menus.actions && merged.exports === menus.exports) return;
    menus = merged;
    listeners.forEach(fn => fn());
}

export function toggleCardActionsFor(key: string): void {
    set({ actions: menus.actions === key ? null : key, exports: null });
}

export function toggleCardExportFor(key: string): void {
    set({ exports: menus.exports === key ? null : key });
}

export function closeCardMenus(): void {
    set({ actions: null, exports: null });
}

export function useCardMenus(): Menus {
    return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => menus);
}

// a click outside a card's actions closes them; outside its export menu, that
document.addEventListener('click', event => {
    const target = event.target as Element | null;
    if (!target?.closest?.('.card-actions')) set({ actions: null, exports: null });
    else if (!target.closest('.collection-card-export-wrap')) set({ exports: null });
});
