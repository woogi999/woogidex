// One avatar, painted from masked bytes when the person has them and falling
// back to their public bucket URL when they do not. See js/core/avatar.js for
// why avatars stopped being a plain <img src>.

import { useEffect, useRef, useState } from 'react';
import { requestAvatar, cachedAvatar } from '../core/avatar.js';
import { paintShieldedCanvas } from '../core/art-shield.js';

/**
 * @param {object} props
 * @param {string} props.userId     whose face this is
 * @param {string} [props.url]      public-bucket fallback, for anyone with no masked copy
 * @param {string} [props.name]     for the initial-letter circle when there is neither
 * @param {string} [props.className]
 */
export function Avatar({ userId, url = '', name = '', className = 'community-mini-avatar' }) {
    const [masked, setMasked] = useState(() => cachedAvatar(userId) || '');
    const canvasRef = useRef(null);

    useEffect(() => {
        if (!userId || masked) return;
        let live = true;
        requestAvatar(userId).then(value => { if (live && value) setMasked(value); });
        return () => { live = false; };
    }, [userId, masked]);

    useEffect(() => {
        if (canvasRef.current && masked) paintShieldedCanvas(canvasRef.current, masked).catch(() => {});
    }, [masked]);

    if (masked) {
        return <canvas ref={canvasRef} className={`shielded-art avatar-art ${className}`} role="img" aria-label="" />;
    }
    if (url) return <img className={className} src={url} alt="" />;
    return (
        <span className={`${className} ${className}-fallback`}>
            {String(name || '?').charAt(0).toUpperCase()}
        </span>
    );
}
