// React arrives as islands: one self-contained piece of UI gets a React root,
// while everything around it stays vanilla and keeps talking to it through
// window globals, as before.
//
// Rules that keep this safe:
//   * An island's container must be a leaf for old code -- nothing outside
//     React may write to its innerHTML, or the two will fight.
//   * views.js mounts pages via innerHTML, which destroys any React root
//     inside it, so page islands must mount through onViewMounted(), not at
//     import time. Shell islands (modals, sidebar) can mount anytime.
//   * Roots are cached per element so re-mounting re-renders in place instead
//     of leaking a duplicate root.
//   * Icons go through <Icon>, not lucide.createIcons() -- see Icon.jsx.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { log } from '../core/log.js';

const roots = new Map();   // element -> React root

/**
 * Renders a component into an element, creating its root on first call and
 * re-using it afterwards.
 *
 * @param {string|HTMLElement} target  element, or the id of one
 * @param {Function} Component
 * @param {object} [props]
 * @returns {import('react-dom/client').Root|null} null if the element is absent
 */
export function mountIsland(target, Component, props = {}) {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) {
        log.warn('REACT', 'Island target is not in the DOM', { target: String(target) });
        return null;
    }

    // A container replaced by innerHTML elsewhere leaves a dead root pointing
    // at a detached node -- drop those before looking, so a re-mount doesn't reuse one.
    for (const [node, root] of roots) {
        if (!node.isConnected) { root.unmount(); roots.delete(node); }
    }

    let root = roots.get(el);
    if (!root) {
        // Clear whatever old code left here so React doesn't reconcile against
        // markup it didn't create.
        el.innerHTML = '';
        root = createRoot(el);
        roots.set(el, root);
        log.debug('REACT', 'Island mounted', { id: el.id || '(anonymous)' });
    }

    root.render(
        <StrictMode>
            <Component {...props} />
        </StrictMode>
    );
    return root;
}

/**
 * Tears an island down and forgets its root. Only needed when the container
 * itself is about to be removed or rewritten by non-React code.
 * @param {string|HTMLElement} target
 */
export function unmountIsland(target) {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return;
    const root = roots.get(el);
    if (!root) return;
    root.unmount();
    roots.delete(el);
    log.debug('REACT', 'Island unmounted', { id: el.id || '(anonymous)' });
}

/** Which elements currently host an island. Exposed for tests and logging. */
export function mountedIslands() {
    return [...roots.keys()].map(el => el.id || '(anonymous)');
}
