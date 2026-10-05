import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { frameCount } from '../../core/art-shield.ts';
import { api } from '../../core/app.ts';
import { Icon } from '../components/Icon.tsx';
import { Modal } from '../components/Modal.tsx';
import { openDialog, registerDialog, type DialogProps } from '../dialogs.tsx';

// ==================== cropping a picture ====================
// Drag to move, slider or wheel to zoom; the crop is baked into the file
// before upload, at the source's own pixels (no resampling, so pixel art stays
// crisp). Animated images skip it: a canvas keeps one frame.

const CROP_MAX_SIDE = 2048;              // only ever scales down past this

/** Opens the cropper for `file`, or hands an animated one straight back. */
export async function cropThen(file: File, aspect: number, onDone: (cropped: File) => void) {
    const url = URL.createObjectURL(file);
    const animated = (await frameCount(url).catch(() => 1)) > 1;
    URL.revokeObjectURL(url);
    if (animated) { api.showToast?.('Animated pictures can’t be cropped; it’s used as it is.', 'info'); onDone(file); return; }
    openDialog('crop-image', { file, aspect, onDone });
}

function CropDialog({ close, file, aspect, onDone }: DialogProps<{ file: File; aspect: number; onDone: (f: File) => void }>) {
    const [src] = useState(() => URL.createObjectURL(file));
    const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
    const [zoom, setZoom] = useState(1);
    const [pos, setPos] = useState({ x: 0, y: 0 });
    const [busy, setBusy] = useState(false);
    const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    useEffect(() => () => URL.revokeObjectURL(src), [src]);

    const frameW = Math.min(480, window.innerWidth - 64);
    const frameH = frameW / aspect;
    const base = natural ? Math.max(frameW / natural.w, frameH / natural.h) : 1;
    const scale = base * zoom;
    // keeps the picture covering the frame: no empty edge can be cropped in
    const clamp = (p: { x: number; y: number }, s = scale) => natural ? {
        x: Math.min(0, Math.max(frameW - natural.w * s, p.x)),
        y: Math.min(0, Math.max(frameH - natural.h * s, p.y))
    } : p;

    function loaded() {
        const img = imgRef.current!;
        const n = { w: img.naturalWidth, h: img.naturalHeight };
        const s = Math.max(frameW / n.w, frameH / n.h);
        setNatural(n);
        setPos({ x: (frameW - n.w * s) / 2, y: (frameH - n.h * s) / 2 });
    }
    function zoomTo(next: number) {
        next = Math.min(6, Math.max(1, next));
        const k = next / zoom;
        // zoom about the frame's centre, not its corner
        setPos(clamp({ x: frameW / 2 - (frameW / 2 - pos.x) * k, y: frameH / 2 - (frameH / 2 - pos.y) * k }, base * next));
        setZoom(next);
    }
    const down = (e: ReactPointerEvent) => { (e.currentTarget as Element).setPointerCapture(e.pointerId); drag.current = { px: e.clientX, py: e.clientY, ...pos }; };
    const move = (e: ReactPointerEvent) => { const d = drag.current; if (d) setPos(clamp({ x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py })); };

    async function save() {
        if (!natural || busy) return;
        setBusy(true);
        const sw = frameW / scale, sh = frameH / scale;
        const out = Math.min(1, CROP_MAX_SIDE / Math.max(sw, sh));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(sw * out));
        canvas.height = Math.max(1, Math.round(sh * out));
        const ctx = canvas.getContext('2d')!;
        ctx.imageSmoothingEnabled = out < 1;      // only a big photo being shrunk gets smoothed
        ctx.drawImage(imgRef.current!, -pos.x / scale, -pos.y / scale, sw, sh, 0, 0, canvas.width, canvas.height);
        const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
        let blob = await new Promise<Blob | null>(r => canvas.toBlob(r, type, 0.92));
        // a large PNG crop can pass the 2MB cap; webp keeps it under without visible loss
        if (blob && blob.size > 2 * 1024 * 1024) blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/webp', 0.9));
        setBusy(false);
        if (!blob) { api.showToast?.('Couldn’t crop that picture.', 'error'); return; }
        const ext = blob.type.split('/')[1] || 'png';
        onDone(new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'image'}.${ext}`, { type: blob.type }));
        close();
    }

    return (
        <Modal onClose={close} title={aspect === 1 ? 'Crop your picture' : 'Crop your cover photo'} className="crop-modal">
            <div className={`crop-frame${aspect === 1 ? ' is-round' : ''}`} style={{ width: frameW, height: frameH }}
                onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }}
                onWheel={e => zoomTo(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))}>
                <img ref={imgRef} src={src} alt="" draggable={false} onLoad={loaded}
                    style={natural ? { width: natural.w * scale, height: natural.h * scale, left: pos.x, top: pos.y } : { opacity: 0 }} />
            </div>
            <label className="crop-zoom"><Icon name="magnifying-glass-minus" size={16} />
                <input type="range" min={1} max={6} step={0.01} value={zoom} onChange={e => zoomTo(Number(e.target.value))} aria-label="Zoom" />
                <Icon name="magnifying-glass-plus" size={16} /></label>
            <p className="profile-field-hint">Drag to move it, zoom to fit.</p>
            <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={close}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={!natural || busy} onClick={save}>{busy ? 'Cropping…' : 'Use this'}</button>
            </div>
        </Modal>
    );
}
registerDialog('crop-image', CropDialog);
