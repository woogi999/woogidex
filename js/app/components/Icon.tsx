// The site's icons (Heroicons, solid; see js/core/icon-set.ts).

import { useSyncExternalStore, type SVGProps } from 'react';
import { iconPathsFor, isIconReady, onAllIconsLoaded } from '../../core/icon-set.ts';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'dangerouslySetInnerHTML'> & {
    /** an app icon name (js/core/icon-data.ts) or any Heroicon name */
    name: string;
    size?: number | string;
};

export function Icon({ name, size = 24, className, ...rest }: IconProps) {
    // an icon outside the bundled set re-renders once the full set has loaded
    useSyncExternalStore(onAllIconsLoaded, () => isIconReady(name));
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="currentColor"
            className={['ui-icon', `icon-${name}`, className].filter(Boolean).join(' ')}
            aria-hidden
            // the paths come from our own generated tables, never from user data
            dangerouslySetInnerHTML={{ __html: iconPathsFor(name) }}
            {...rest}
        />
    );
}
