// An optional image on a custom type, move, ability or item: a preview, an
// upload button and Remove. Uploads are shrunk (js/editor/entity-art.ts) so
// they stay small in saves and backups.

import { useRef, type CSSProperties } from 'react';
import { api } from '../../core/app.ts';
import { shrinkImageFile } from '../../editor/entity-art.ts';
import { Icon } from './Icon.tsx';

export function ArtField({ value, onChange, uploadLabel = 'Upload image', previewClassName = '', previewStyle }: {
    value: string; onChange: (dataUrl: string) => void; uploadLabel?: string; previewClassName?: string; previewStyle?: CSSProperties;
}) {
    const input = useRef<HTMLInputElement>(null);
    return (
        <div className="entity-art-field">
            <div className={`entity-art-preview ${previewClassName}${value ? ' has-art' : ''}`.trim()} style={previewStyle}>
                {value ? <img src={value} alt="" /> : <Icon name="image" />}
            </div>
            <div className="entity-art-actions">
                <label className="btn btn-secondary btn-sm">
                    <Icon name="upload" /><span>{uploadLabel}</span>
                    <input ref={input} type="file" accept="image/*" hidden onChange={e => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) shrinkImageFile(file).then(onChange, (err: Error) => api.showToast?.(err.message, 'error'));
                    }} />
                </label>
                {value && <button className="btn btn-secondary btn-sm" type="button" onClick={() => onChange('')}>Remove</button>}
            </div>
        </div>
    );
}
