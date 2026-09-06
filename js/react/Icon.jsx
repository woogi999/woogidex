// lucide.createIcons() replaces <i> elements with <svg>, which conflicts with
// React's own reconciliation. So we render the SVG directly from lucide's icon data.

import { createElement } from 'react';
import { icons } from 'lucide';

// data-lucide names are kebab-case; the exported keys are PascalCase.
function toPascal(name) {
    return String(name).replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
}

/**
 * @param {{name: string, size?: number, className?: string}} props
 *   name is the same string the HTML would put in data-lucide.
 */
export function Icon({ name, size = 24, className, ...rest }) {
    const shape = icons[toPascal(name)];
    if (!shape) {
        console.warn(`[REACT] no lucide icon named "${name}"`);
        return null;
    }
    return createElement(
        'svg',
        {
            xmlns: 'http://www.w3.org/2000/svg',
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            className: ['lucide', `lucide-${name}`, className].filter(Boolean).join(' '),
            'aria-hidden': true,
            ...rest
        },
        shape.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))
    );
}
