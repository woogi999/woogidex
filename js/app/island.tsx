// Mounts a React component into an element the page shell owns. The pages
// already rebuilt in React live in the old shell's page containers this way
// until the shell itself is React (see js/app/mount.tsx).
//
// Rules that keep this safe:
//   * An island's container belongs to React: nothing else may write its innerHTML.
//   * Roots are cached per element, so mounting again re-renders in place.

import { StrictMode, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { log } from '../core/log.ts';

const roots = new Map<Element, Root>();

/**
 * Renders a component into an element (or the id of one), creating its root
 * the first time and reusing it afterwards.
 * @returns null when the element isn't in the document
 */
export function mountIsland<P extends object>(target: string | Element, Component: ComponentType<P>, props: P = {} as P, { sync = false } = {}): Root | null {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) {
        log.warn('REACT', 'Island target is not in the DOM', { target: String(target) });
        return null;
    }
    // a container replaced by innerHTML elsewhere leaves a dead root behind
    for (const [node, root] of roots) {
        if (!node.isConnected) { root.unmount(); roots.delete(node); }
    }
    let root = roots.get(el);
    if (!root) {
        // whatever old code left here would confuse React's reconciliation
        el.innerHTML = '';
        root = createRoot(el);
        roots.set(el, root);
        log.debug('REACT', 'Island mounted', { id: el.id || '(anonymous)' });
    }
    const render = () => root!.render(<StrictMode><Component {...props} /></StrictMode>);
    // sync: the markup is in the document when this returns, for code that reaches into it right away
    if (sync) flushSync(render); else render();
    return root;
}

/** Tears an island down, for a container about to be removed or rewritten. */
export function unmountIsland(target: string | Element): void {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return;
    roots.get(el)?.unmount();
    roots.delete(el);
}
