// The site's icons: Heroicons, solid style (js/core/icon-data.js).
//
// Markup across the app names icons with data-lucide="..." -- the attribute
// from the icon set this replaced -- and calls lucide.createIcons() after
// inserting HTML. Both are kept so none of those call sites had to change:
// window.lucide.createIcons() below swaps each <i data-lucide> for a Heroicon.

import { HERO_PATHS, ICON_NAMES } from './icon-data.js';

const FALLBACK = 'question-mark-circle';
const warned = new Set();

/** The Heroicon's inner markup for an app icon name. */
export function iconPathsFor(name) {
    const hero = ICON_NAMES[name] || (HERO_PATHS[name] ? name : null);
    if (!hero && !warned.has(name)) {
        warned.add(name);
        console.warn(`[icons] no icon mapped for "${name}"; add it to js/core/icon-data.js`);
    }
    return HERO_PATHS[hero] || HERO_PATHS[FALLBACK] || '';
}

/**
 * A complete <svg> element as markup.
 * @param {string} name app icon name (the old data-lucide name)
 * @param {{size?: number, className?: string, attrs?: string}} [opts]
 */
export function iconMarkup(name, { size = 24, className = '', attrs = '' } = {}) {
    // 24px unless told otherwise, like the icon set this replaced: an <svg>
    // with no size of its own would stretch to fill its container. CSS width
    // and height still win over these attributes.
    const dim = size && !/\bwidth=/.test(attrs) ? ` width="${size}" height="${size}"` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class="ui-icon icon-${name}${className ? ` ${className}` : ''}"${dim}${attrs}>${iconPathsFor(name)}</svg>`;
}

const KEEP = ['id', 'style', 'title', 'role', 'aria-label', 'aria-hidden', 'width', 'height'];

/** Replaces every <i data-lucide="..."> under `root` with its Heroicon. */
export function createIcons({ root = document } = {}) {
    const els = root.querySelectorAll ? root.querySelectorAll('[data-lucide]:not(svg)') : [];
    for (const el of els) {
        const name = el.getAttribute('data-lucide');
        const tpl = document.createElement('template');
        tpl.innerHTML = iconMarkup(name);
        const svg = tpl.content.firstElementChild;
        for (const cls of el.classList) svg.classList.add(cls);
        for (const attr of KEEP) {
            const v = el.getAttribute(attr);
            if (v !== null) svg.setAttribute(attr, v);
        }
        if (el.hasAttribute('aria-label')) svg.removeAttribute('aria-hidden');
        el.replaceWith(svg);
    }
}
