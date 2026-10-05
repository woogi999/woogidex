// One avatar, painted onto a canvas (js/core/art-shield.ts) from masked bytes
// when the person has them, or from their picture URL when they don't (Google
// and Discord pictures, uploads from before masking) -- either way never a
// plain <img src> to right-click and save. A plain <img> only if painting
// fails; with no picture at all, their initial.
//
// The canvas sits inside a box carrying the caller's class, so the class's
// size is the avatar's size. A bare canvas is as big as its image (up to
// 2048px) wherever a class does not pin both dimensions, which is how one
// profile picture could blow up a post or a chat.

import { useEffect, useRef, useState } from 'react';
import { cachedAvatar, requestAvatar } from '../../core/avatar.ts';
import { paintShieldedCanvas } from '../../core/art-shield.ts';

interface AvatarProps { userId?: string | null; url?: string | null; name?: string; className?: string; }

export function Avatar({ userId, url = '', name = '', className = 'community-mini-avatar' }: AvatarProps) {
    // the module cache is the source of truth, read every render: a reused
    // component showing someone else, or a fresh upload (dropCachedAvatar),
    // picks up the right face instead of keeping the last one in state
    const cached = userId ? cachedAvatar(userId) : '';
    const [, rerender] = useState(0);
    const [broken, setBroken] = useState('');     // the source that failed to draw or load
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const masked = cached && cached !== broken ? cached : '';
    // the URL is painted too, but only once the masked lookup has answered,
    // so a face with masked bytes never downloads its bucket copy as well
    const source = masked || (cached !== undefined && url && url !== broken ? url : '');

    useEffect(() => {
        if (!userId || cached !== undefined) return;
        let live = true;
        requestAvatar(userId).then(() => { if (live) rerender(n => n + 1); });
        return () => { live = false; };
    }, [userId, cached]);

    useEffect(() => {
        if (canvasRef.current && source) paintShieldedCanvas(canvasRef.current, source).then(ok => { if (!ok) setBroken(source); }, () => setBroken(source));
    }, [source]);

    if (source) return <span className={`${className} avatar-frame`}><canvas ref={canvasRef} className="shielded-art avatar-art" role="img" aria-label="" /></span>;
    // painting failed (the host refused a cross-origin read): show it unshielded rather than not at all
    if (url && broken === url) return <img className={className} src={url} alt="" />;
    return <span className={`${className} ${className}-fallback`}>{String(name || '?').charAt(0).toUpperCase()}</span>;
}
