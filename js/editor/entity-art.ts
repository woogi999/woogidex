// An optional image on a custom move, ability, item or type. It only
// decorates previews (collection cards and the Fakemon page); mod exports
// don't carry it. Images are shrunk on the way in so they stay small in saves
// and backups; the field itself is js/app/components/ArtField.tsx.

const MAX_PX = 256;
/**
 * An image file as a PNG data URL, shrunk to fit MAX_PX.
 * @param file
 * @returns rejects with a message to show
 */
export function shrinkImageFile(file: File, maxPx = MAX_PX): Promise<string> {
    return new Promise((resolve, reject) => {
        if (!file?.type?.startsWith('image/')) { reject(new Error('Please use an image file.')); return; }
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/png'));
            };
            img.onerror = () => reject(new Error('That image could not be read.'));
            img.src = String(reader.result);
        };
        reader.onerror = () => reject(new Error('That image could not be read.'));
        reader.readAsDataURL(file);
    });
}
