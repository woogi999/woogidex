// My Collection's dialogs: naming a folder, making a region, and choosing
// exactly which main-game entries a region brings over.

import { useMemo, useState } from 'react';
import { api, state } from '../../core/app.ts';
import { POKEMON_COLORS } from '../../core/data.ts';
import { DEFAULT_POOLS, POOL_KINDS, POOL_LABEL, REGION_COLORS, regionPickerEntries } from '../../features/regions.ts';
import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Modal } from '../components/Modal.tsx';
import { Icon } from '../components/Icon.tsx';
import { ColorSwatches } from '../components/collection/RegionDetails.tsx';

// ---- folders ----

function FolderNameDialog({ folderId, close }: DialogProps<{ folderId?: string }>) {
    const folder = folderId ? state.folders.find(f => f.id === folderId) : null;
    const [name, setName] = useState(folder?.name || '');
    const [color, setColor] = useState<string | null>((folder as any)?.color || null);
    const save = () => {
        const problem = api.saveFolder({ id: folder?.id || null, name, color });
        if (problem) api.showToast(problem, 'error');
        else close();
    };
    return (
        <Modal onClose={close} title={folder ? 'Rename Folder' : 'New Folder'} className="folder-name-dialog" labelledBy="folder-name-title">
            <div className="form-group">
                <label htmlFor="folder-name-input">Folder Name</label>
                <input type="text" id="folder-name-input" placeholder="e.g., Legendaries" value={name} autoFocus
                    onFocus={e => e.target.select()}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
            </div>
            <div className="form-group">
                <label>Folder Color</label>
                <div className="color-options">
                    <button type="button" className={`color-option folder-color-none${!color ? ' selected' : ''}`} title="None" aria-label="No colour" onClick={() => setColor(null)}>
                        <Icon name="slash" size={14} />
                    </button>
                    {(POKEMON_COLORS as Array<{ name: string; hex: string }>).map(c => (
                        <button key={c.hex} type="button" className={`color-option${c.hex === color ? ' selected' : ''}`} style={{ backgroundColor: c.hex }}
                            title={c.name} aria-label={c.name} onClick={() => setColor(c.hex)} />
                    ))}
                </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
                <button className="btn btn-secondary" type="button" onClick={close}>Cancel</button>
                <button className="btn btn-primary" type="button" onClick={save}>Save</button>
            </div>
        </Modal>
    );
}

// ---- a new region ----

function RegionCreateDialog({ color: startColor, close }: DialogProps<{ color?: string }>) {
    const [name, setName] = useState('');
    const [tagline, setTagline] = useState('');
    const [color, setColor] = useState(startColor || REGION_COLORS[0]);
    const [pools, setPools] = useState<Record<string, string>>({ ...DEFAULT_POOLS });
    const save = () => {
        const problem = api.createRegionFrom({ name, tagline, color, pools });
        if (problem) api.showToast(problem, 'error');
        else close();
    };
    return (
        <Modal onClose={close} title="New region" labelledBy="region-create-title" className="region-create-dialog">
            <div className="form-group">
                <label htmlFor="region-name-input">Name</label>
                <input type="text" id="region-name-input" maxLength={40} placeholder="e.g., Kanto" value={name} autoFocus
                    onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
            </div>
            <div className="form-group">
                <label htmlFor="region-tagline-input">Tagline <span className="label-optional">(optional)</span></label>
                <input type="text" id="region-tagline-input" maxLength={90} placeholder="One line, like a game's box art" value={tagline} onChange={e => setTagline(e.target.value)} />
            </div>
            <div className="form-group">
                <label>Colour</label>
                <ColorSwatches colors={REGION_COLORS} selected={color} onPick={setColor} />
            </div>
            <div className="form-group">
                <label>Bring over from the main games</label>
                <p className="custom-type-help">You can pick exact Pokémon, moves and more later, in Region details.</p>
                <div className="region-pool-choices">
                    {(POOL_KINDS as string[]).map(kind => (
                        <label className="region-pool-choice" key={kind}>
                            <span>{(POOL_LABEL as Record<string, string>)[kind]}</span>
                            <select value={pools[kind]} onChange={e => setPools(p => ({ ...p, [kind]: e.target.value }))}>
                                <option value="none">None</option>
                                <option value="natdex">National Dex</option>
                            </select>
                        </label>
                    ))}
                </div>
            </div>
            <div className="region-modal-actions">
                <span className="region-modal-spacer" />
                <button className="btn btn-secondary" type="button" onClick={close}>Cancel</button>
                <button className="btn btn-primary" type="button" onClick={save}>Create region</button>
            </div>
        </Modal>
    );
}

// ---- choosing individual main-game entries ----

function RegionPickerDialog({ kind, regionName, initial, close }: DialogProps<{ kind: string; regionName: string; initial: string[] }>) {
    const [selected, setSelected] = useState(() => new Set(initial));
    const [query, setQuery] = useState('');
    // the list itself only changes with the kind; what's ticked doesn't reorder it
    const entries = useMemo(() => regionPickerEntries(kind, new Set(initial)) as Array<[string, any]>, [kind, initial]);
    const q = query.trim().toLowerCase();
    const shown = entries.filter(([id, v]) => !q || String(v.name).toLowerCase().includes(q) || id.includes(q));
    const setMany = (ids: string[], on: boolean) => setSelected(prev => {
        const next = new Set(prev);
        ids.forEach(id => (on ? next.add(id) : next.delete(id)));
        return next;
    });
    const label = String((POOL_LABEL as Record<string, string>)[kind] || kind).toLowerCase();
    return (
        <Modal onClose={close} title={`Choose ${label} for ${regionName}`} className="region-picker-modal" labelledBy="region-picker-title">
            <div className="region-picker-tools">
                <input type="search" placeholder="Search..." aria-label="Search" value={query} autoFocus onChange={e => setQuery(e.target.value)} />
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => setMany(shown.map(([id]) => id), true)}>Select shown</button>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => setMany(shown.map(([id]) => id), false)}>Clear shown</button>
            </div>
            <div className="region-picker-list">
                {shown.length ? shown.map(([id, v]) => {
                    const extra = kind === 'pokemon' ? `#${String(v.num).padStart(3, '0')}` : kind === 'moves' ? `${v.type || ''} · ${v.category || ''}` : '';
                    return (
                        <label className="region-picker-row" key={id}>
                            <input type="checkbox" checked={selected.has(id)} onChange={e => setMany([id], e.target.checked)} />
                            <span>{v.name}</span>{extra && <small>{extra}</small>}
                        </label>
                    );
                }) : <p className="region-picker-empty">Nothing matches.</p>}
            </div>
            <div className="region-modal-actions">
                <span className="region-picker-count">{selected.size} chosen</span>
                <span className="region-modal-spacer" />
                <button className="btn btn-secondary" type="button" onClick={close}>Cancel</button>
                <button className="btn btn-primary" type="button" onClick={() => { api.saveRegionPool(kind, [...selected]); close(); }}>Done</button>
            </div>
        </Modal>
    );
}

registerDialog('folder-name', FolderNameDialog);
registerDialog('region-create', RegionCreateDialog);
registerDialog('region-picker', RegionPickerDialog);
