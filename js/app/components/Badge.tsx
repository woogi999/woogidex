// Badges beside a name. Label and tooltip come from a staff-editable table;
// React escapes them. Class names and data attributes match what
// css/profile.css styles the tooltip from.

import type { CSSProperties } from 'react';
import { BADGES } from '../../core/data.ts';
import type { BadgeDefinition } from '../types.ts';
import { Icon } from './Icon.tsx';

const badgeDefs = BADGES as Record<string, BadgeDefinition>;

interface BadgeIconProps { badge: BadgeDefinition; size?: number; className?: string; style?: CSSProperties; }

/** A badge's own picture: its uploaded image when it has one, else its Heroicon. */
export function BadgeIcon({ badge, size = 14, className = 'profile-badge', style }: BadgeIconProps) {
    if (badge.image) {
        return <img src={badge.image} className={`${className} profile-badge-image`.trim()} style={{ width: size, height: size, ...style }} alt={badge.label} draggable={false} />;
    }
    return (
        <Icon name={badge.icon || 'star'} size={size} className={className}
            style={{ width: size, height: size, color: badge.color, ...style }} aria-label={badge.label} />
    );
}

export function Badge({ badgeKey, size = 14 }: { badgeKey: string; size?: number }) {
    const b = badgeDefs[badgeKey];
    if (!b) return null;     // a key from a newer version of the site
    return (
        <span className="profile-badge-tooltip" data-badge-name={b.label} data-badge-description={b.tooltip} tabIndex={0}>
            <BadgeIcon badge={b} size={size} />
        </span>
    );
}

/** A user's badges. Safe with an empty or missing list. */
export function BadgeRow({ badgeKeys, size = 14 }: { badgeKeys?: string[] | null; size?: number }) {
    if (!badgeKeys?.length) return null;
    return (
        <span className="profile-badge-row">
            {badgeKeys.map(k => <Badge key={k} badgeKey={k} size={size} />)}
        </span>
    );
}

export function badgeDefinition(key: string): BadgeDefinition | undefined {
    return badgeDefs[key];
}
