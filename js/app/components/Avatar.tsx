// One avatar, painted from masked bytes when the person has them and falling
// back to their public bucket URL when they don't (see js/core/avatar.ts for
// why avatars stopped being a plain <img src>). With neither, their initial.

import { useEffect, useRef, useState } from 'react';
import { cachedAvatar, requestAvatar } from '../../core/avatar.ts';
import { paintShieldedCanvas } from '../../core/art-shield.ts';

interface AvatarProps { userId?: string | null; url?: string | null; name?: string; className?: string; }

export function Avatar({ userId, url = '', name = '', className = 'community-mini-avatar' }: AvatarProps) {
    const [masked, setMasked] = useState<string>(() => (userId && cachedAvatar(userId)) || '');
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!userId || masked) return;
        let live = true;
        requestAvatar(userId).then((value: string) => { if (live && value) setMasked(value); });
        return () => { live = false; };
    }, [userId, masked]);

    useEffect(() => {
        if (canvasRef.current && masked) paintShieldedCanvas(canvasRef.current, masked).catch(() => {});
    }, [masked]);

    if (masked) return <canvas ref={canvasRef} className={`shielded-art avatar-art ${className}`} role="img" aria-label="" />;
    if (url) return <img className={className} src={url} alt="" />;
    return <span className={`${className} ${className}-fallback`}>{String(name || '?').charAt(0).toUpperCase()}</span>;
}
