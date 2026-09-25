// Artwork that shouldn't be trivially liftable, drawn onto a canvas rather
// than shown as an <img> (see js/core/art-shield.ts).

import { useEffect, useRef } from 'react';
import { paintShieldedCanvas } from '../../core/art-shield.ts';

export function ShieldedArt({ src, alt = '', className = '' }: { src: string; alt?: string; className?: string }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        if (ref.current && src) paintShieldedCanvas(ref.current, src);
    }, [src]);
    if (!src) return null;
    return <canvas ref={ref} className={`shielded-art ${className}`.trim()} role="img" aria-label={alt} />;
}
