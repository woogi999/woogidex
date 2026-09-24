// An optional image on a custom move or ability. It only decorates previews
// (collection cards and the Fakemon page); mod exports don't carry it.
// Images are shrunk on the way in so they stay small in saves and backups.

import { api } from '../core/app.js';

const MAX_PX = 256;
const current = {};   // form prefix -> data URL ('' for none)

function paint(prefix) {
    const preview = document.getElementById(`${prefix}-art-preview`);
    const clear = document.getElementById(`${prefix}-art-clear`);
    const art = current[prefix] || '';
    if (preview) {
        preview.innerHTML = art ? `<img src="${art}" alt="">` : '<i data-lucide="image"></i>';
        preview.classList.toggle('has-art', !!art);
    }
    if (clear) clear.hidden = !art;
    if (!art && typeof lucide !== 'undefined') lucide.createIcons();
}

/** Sets the form's image (on open). */
export function setEntityArt(prefix, dataUrl) {
    current[prefix] = dataUrl || '';
    paint(prefix);
}

/** The form's image (on save), '' for none. */
export function readEntityArt(prefix) {
    return current[prefix] || '';
}

export function clearEntityArt(prefix) {
    setEntityArt(prefix, '');
}

export function handleEntityArtUpload(prefix, event) {
    const file = event?.target?.files?.[0];
    if (event?.target) event.target.value = '';
    if (!file) return;
    if (!file.type?.startsWith('image/')) { api.showToast?.('Please use an image file.', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, MAX_PX / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            setEntityArt(prefix, canvas.toDataURL('image/png'));
        };
        img.onerror = () => api.showToast?.('That image could not be read.', 'error');
        img.src = reader.result;
    };
    reader.readAsDataURL(file);
}
