// Hooks shared by the React pages.

import { useSyncExternalStore } from 'react';
import { currentRoute, onRouteChange, type Route } from '../core/router.ts';

let lastHref = '';
let lastRoute: Route = { name: '', param: '' };

// useSyncExternalStore needs the same object back until something changes
function routeSnapshot(): Route {
    const href = window.location.href;
    if (href !== lastHref) {
        lastHref = href;
        lastRoute = currentRoute();
    }
    return lastRoute;
}

/** The route the address bar names; re-renders on navigation and back/forward. */
export function useRoute(): Route {
    return useSyncExternalStore(onRouteChange, routeSnapshot);
}

/** The ?name= value from the address bar, kept in step like useRoute(). */
export function useQueryParam(name: string): string {
    useRoute();
    return new URLSearchParams(window.location.search).get(name) || '';
}
