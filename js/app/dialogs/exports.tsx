// Import Collection and Export as Plain Text. The file handling and the text
// itself are js/export/export.ts.

import { useState } from 'react';
import { api } from '../../core/app.ts';
import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Modal } from '../components/Modal.tsx';

const selectStyle: React.CSSProperties = { padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, fontFamily: "'Exo 2',sans-serif", fontSize: 13 };

function CollectionImportDialog({ close }: DialogProps) {
    const [file, setFile] = useState<File | null>(null);
    const [busy, setBusy] = useState(false);
    const run = async (mode: 'add' | 'replace') => {
        setBusy(true);
        const ok = await api.importCollection(file, mode);
        setBusy(false);
        if (ok) close();
        else setFile(null);
    };
    return (
        <Modal onClose={close} title="Import Collection" className="collection-import-dialog" labelledBy="collection-import-title">
            <p className="collection-import-lead">Import a collection or a Fakemon export. You can choose to add the imported Fakemon to your collection, or replace the current collection.</p>
            <label className="file-upload-btn collection-import-pick">
                <input type="file" accept=".json,.txt,application/json,text/plain" onChange={e => setFile(e.target.files?.[0] || null)} />
                Choose JSON / TXT File
            </label>
            <div className="collection-import-status">
                {file ? `Selected: ${file.name}` : 'Choose a collection, Fakemon, custom move, custom ability, or custom item JSON/TXT file.'}
            </div>
            <div className="collection-import-actions">
                <button className="btn btn-secondary" type="button" disabled={!file || busy} onClick={() => run('add')}>Add to Collection</button>
                <button className="btn btn-danger" type="button" disabled={!file || busy} onClick={() => run('replace')}>Replace Collection</button>
            </div>
        </Modal>
    );
}

function PlainTextExportDialog({ close }: DialogProps) {
    const [sort, setSort] = useState('name');
    const [order, setOrder] = useState('asc');
    // built once for the Fakémon open now, and again when the order changes
    const [text, setText] = useState(() => {
        try { return api.buildPlainTextExport('name', 'asc'); }
        catch { api.showToast('Plain text export failed!', 'error'); return ''; }
    });
    const rebuild = (s: string, o: string) => setText(api.buildPlainTextExport(s, o));
    return (
        <Modal onClose={close} title="Export as Plain Text" className="plain-text-export-dialog" labelledBy="plain-text-title">
            <p className="dialog-hint">Choose the learnset order, then copy the text below or download it as a .txt file.</p>
            <div className="dialog-sort-row">
                <label>Learnset sort</label>
                <select style={{ ...selectStyle, width: 145 }} value={sort} onChange={e => { setSort(e.target.value); rebuild(e.target.value, order); }}>
                    <option value="name">Alphabetical</option>
                    <option value="type">Type</option>
                    <option value="power">Power</option>
                    <option value="category">Category</option>
                    <option value="default">Default</option>
                </select>
                <select style={{ ...selectStyle, width: 105 }} value={order} onChange={e => { setOrder(e.target.value); rebuild(sort, e.target.value); }} aria-label="Order">
                    <option value="asc">Ascending</option>
                    <option value="desc">Descending</option>
                </select>
            </div>
            <textarea className="plain-text-export-text" spellCheck={false} value={text} onChange={e => setText(e.target.value)}
                autoFocus onFocus={e => e.currentTarget.select()} />
            <div className="dialog-actions">
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.copyPlainTextExport(text)}>Copy Text</button>
                <button className="btn btn-primary btn-sm" type="button" onClick={() => api.downloadPlainTextExport(text)}>Download .txt</button>
                <button className="btn btn-secondary btn-sm" type="button" onClick={close}>Close</button>
            </div>
        </Modal>
    );
}

registerDialog('collection-import', CollectionImportDialog);
registerDialog('plain-text-export', PlainTextExportDialog);
