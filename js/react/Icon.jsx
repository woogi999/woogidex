// The React side of the site's icons (Heroicons, solid; see js/core/icon-set.js).
// lucide.createIcons() swaps <i> elements for <svg>, which conflicts with
// React's own reconciliation, so components render the SVG directly.

import { createElement } from 'react';
import { iconPathsFor } from '../core/icon-set.js';

/**
 * @param {{name: string, size?: number, className?: string}} props
 *   name is the same string the HTML would put in data-lucide.
 */
export function Icon({ name, size = 24, className, ...rest }) {
    return createElement('svg', {
        xmlns: 'http://www.w3.org/2000/svg',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'currentColor',
        className: ['ui-icon', `icon-${name}`, className].filter(Boolean).join(' '),
        'aria-hidden': true,
        // the paths come from our own generated table, never from user data
        dangerouslySetInnerHTML: { __html: iconPathsFor(name) },
        ...rest
    });
}
