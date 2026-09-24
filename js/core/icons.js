// Icons as inline SVG strings, for markup built as a string and set with
// innerHTML in places where running lucide.createIcons() afterwards is easy
// to forget (the evolution board redraws on every drag). Same Heroicons as
// everywhere else (js/core/icon-set.js).

import { iconMarkup, iconPathsFor } from './icon-set.js';

/**
 * @param {string} name app icon name
 * @param {number} [size] px; defaults to 1em so it follows the text size
 * @returns {string} an <svg> element as markup
 */
export function iconSvg(name, size = 0) {
    return size ? iconMarkup(name, { size }) : iconMarkup(name, { attrs: ' width="1em" height="1em"' });
}

/** The inner paths only, for placing inside an existing <svg>. */
export function iconPaths(name) {
    return iconPathsFor(name);
}
