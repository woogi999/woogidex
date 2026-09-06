// Badge label/tooltip come from a staff-editable table, so they must be
// escaped -- React does this automatically, unlike the old innerHTML version.
// Class names / data attributes kept identical since css/profile.css styles
// the tooltip off data-badge-name / data-badge-description.

import { BADGES } from '../core/data.js';
import { Icon } from './Icon.jsx';

/** @param {{badgeKey: string, size?: number}} props */
export function Badge({ badgeKey, size = 14 }) {
    const b = BADGES[badgeKey];
    if (!b) return null;     // key from a newer site version
    return (
        <span
            className="profile-badge-tooltip"
            data-badge-name={b.label}
            data-badge-description={b.tooltip}
            tabIndex={0}
        >
            <Icon
                name={b.icon}
                size={size}
                className="profile-badge"
                style={{ width: size, height: size, color: b.color }}
                aria-label={b.label}
            />
        </span>
    );
}

/**
 * A user's badges. Safe with an empty or missing array.
 * @param {{badgeKeys?: string[], size?: number}} props
 */
export function BadgeRow({ badgeKeys, size = 14 }) {
    if (!badgeKeys || !badgeKeys.length) return null;
    return (
        <span className="profile-badge-row">
            {badgeKeys.map(k => <Badge key={k} badgeKey={k} size={size} />)}
        </span>
    );
}
