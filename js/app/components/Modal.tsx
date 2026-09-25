// A dialog in the site's modal style (css/modals.css). Rendered through a
// portal outside the page, so it covers the page even when its opener sits
// inside a page that is mid-animation (a transformed ancestor would otherwise
// become the containing block of its fixed overlay).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.tsx';

interface ModalProps {
    onClose: () => void;
    /** heading; omit for a modal that draws its own */
    title?: ReactNode;
    /** extra classes on the .modal box */
    className?: string;
    /** extra classes on the overlay */
    overlayClassName?: string;
    children: ReactNode;
    /** close on a click on the dimmed page and on Escape (default true) */
    dismissible?: boolean;
    labelledBy?: string;
}

export function Modal({ onClose, title, className = '', overlayClassName = '', children, dismissible = true, labelledBy }: ModalProps) {
    const box = useRef<HTMLDivElement>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    // read while rendering, before a field's autoFocus moves the focus into the dialog
    const [opener] = useState(() => document.activeElement as HTMLElement | null);

    useEffect(() => {
        // focus the dialog so Escape and Tab start inside it, unless a field's
        // autoFocus already has (React focuses those before this runs)
        if (!box.current?.contains(document.activeElement)) {
            const first = box.current?.querySelector<HTMLElement>('input, textarea, select, button:not(.modal-close)');
            (first || box.current)?.focus?.();
        }
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && dismissible && !event.defaultPrevented) {
                // only the topmost dialog answers
                const overlays = document.querySelectorAll('.modal-overlay.active');
                if (overlays[overlays.length - 1] !== box.current?.parentElement) return;
                event.preventDefault();
                closeRef.current();
            }
        };
        document.addEventListener('keydown', onKey);
        document.body.classList.add('modal-open');
        return () => {
            document.removeEventListener('keydown', onKey);
            if (!document.querySelector('.modal-overlay.active')) document.body.classList.remove('modal-open');
            opener?.focus?.();
        };
    }, [dismissible]);

    return createPortal(
        <div className={`modal-overlay active ${overlayClassName}`.trim()}
            onMouseDown={e => { if (dismissible && e.target === e.currentTarget) onClose(); }}>
            <div className={`modal ${className}`.trim()} ref={box} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>
                {title !== undefined && (
                    <div className="modal-header">
                        <div><h3 id={labelledBy}>{title}</h3></div>
                        <button className="modal-close" type="button" onClick={onClose} aria-label="Close"><Icon name="x" size={20} /></button>
                    </div>
                )}
                {children}
            </div>
        </div>,
        // the dialog host (js/app/dialogs.tsx) when it's up, so css/modals.css can animate these
        document.getElementById('react-dialogs') || document.body
    );
}
