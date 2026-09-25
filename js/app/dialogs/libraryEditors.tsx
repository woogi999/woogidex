// The custom move, ability and item editors, and the "Add Custom ..." chooser
// the editor opens first. From My Collection they slide in from the right
// (.as-sheet); from the Fakémon editor they're ordinary dialogs. Saving and
// its rules are js/editor/editor.ts.

import { useState, type ReactNode } from 'react';
import { api, state } from '../../core/app.ts';
import { MOVE_FLAG_OPTIONS } from '../../editor/learnset-model.ts';
import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Modal } from '../components/Modal.tsx';
import { Icon } from '../components/Icon.tsx';
import { RegionAssign } from '../components/RegionAssign.tsx';
import { ArtField } from '../components/ArtField.tsx';
import { TypeDropdown, useClickAway } from '../components/editor/fields.tsx';
import { CategoryIcon } from '../components/editor/lists.tsx';

type Kind = 'move' | 'ability' | 'item';

/** The editor's header: title, "Add to region", close. */
function Head({ title, regionIds, setRegionIds, close }: { title: string; regionIds: string[]; setRegionIds: (ids: string[]) => void; close: () => void }) {
    return (
        <div className="modal-header">
            <h3>{title}</h3>
            <RegionAssign value={regionIds} onChange={setRegionIds} />
            <button className="modal-close" type="button" onClick={close} aria-label="Close"><Icon name="x" size={20} /></button>
        </div>
    );
}

/** Blocks, or hand-written Showdown hook code, for what it does in battle. */
function BattleCode({ kind, code, setCode, onBlocks }: { kind: Kind; code: string; setCode: (c: string) => void; onBlocks: () => void }) {
    const report = api.rawCodeReport(code, kind);
    const hooks: string[] = api.rawCodeHooks(kind);
    const noun = kind === 'move' ? 'move' : kind === 'item' ? 'item' : 'ability';
    return (
        <div className="form-group entity-code-launch">
            <button type="button" className="btn btn-secondary entity-code-blocks-btn" onClick={onBlocks}><Icon name="puzzle" size={16} /> Code Battle Effect (Blocks)</button>
            <p className="entity-code-hint">Save the {noun} once first, then build its real battle logic out of coding blocks. It exports to both Showdown and Essentials.</p>
            {/* open when there's something in it, so saved code is never hidden behind a closed summary */}
            <details className="entity-raw-code" open={!!code.trim() || undefined}>
                <summary><Icon name="code-bracket" /> Or write the code yourself</summary>
                <p className="entity-code-hint">
                    Paste Showdown hook syntax. The bare hooks, the whole <code>{'{ ... }'}</code> entry, an <code>export const</code> off GitHub or one keyed entry out of a dex table all work, TypeScript annotations included. Runs in battles against the bot; a battle against another player skips it, on both sides, because their copy arrived over the network.
                    {kind === 'move' && <> A move also gets the move pipeline: <code>basePowerCallback</code>, <code>onModifyMove</code>, <code>onBasePower</code>, <code>onTry</code>, <code>onHit</code>, plus data fields like <code>secondaries</code>, <code>drain</code> and <code>multihit</code>.</>}
                </p>
                <textarea rows={10} spellCheck={false} value={code} aria-label="Battle code"
                    placeholder={kind === 'move'
                        ? 'basePowerCallback(pokemon, target, move) {\n    return 40 + Math.floor(pokemon.hp * 60 / pokemon.maxhp);\n},\nsecondaries: [{ chance: 30, boosts: { spe: -1 } }],\nonHit(target, source, move) {\n    this.boost({ atk: 1 }, source);\n}'
                        : kind === 'item'
                            ? 'onModifySpe(spe, pokemon) {\n    return this.chainModify(2);\n},\nonDamage(damage, target, source, effect) {\n    if (damage >= target.hp) return target.hp - 1;\n}'
                            : 'onModifyMove(move, pokemon) {\n    if (move.secondaries) {\n        for (const s of move.secondaries) s.chance *= 2;\n    }\n},\nonResidual(pokemon) {\n    this.heal(pokemon.maxhp / 8, pokemon);\n}'}
                    onChange={e => setCode(e.target.value)}
                    onBlur={() => { const fixed = api.rawCodeReport(code, kind, true).fixed; if (fixed) setCode(fixed); }} />
                <div className={`entity-raw-code-status ${report.tone}`.trim()}>{report.text}</div>
                <details className="entity-raw-code-ref">
                    <summary>Hooks this engine can run</summary>
                    <div className="entity-raw-code-hooks">{hooks.map((h, i) => <span key={h}>{i ? ' ' : ''}<code>{h}</code></span>)}</div>
                </details>
            </details>
        </div>
    );
}

function Actions({ close, save, label }: { close: () => void; save: () => void; label: string }) {
    return (
        <div className="library-editor-actions">
            <button className="btn btn-secondary" type="button" onClick={close}>Cancel</button>
            <button className="btn btn-primary" type="button" onClick={save}>{label}</button>
        </div>
    );
}

/** Runs a save; a problem is shown and keeps the editor open. */
function saving(run: () => string, close: () => void) {
    return () => {
        const problem = run();
        if (problem) api.showToast(problem, 'error');
        else close();
    };
}

// ---- abilities ----

function CustomAbilityDialog({ id, sheet, close }: DialogProps<{ id: string; sheet?: boolean }>) {
    const entry = id ? (state.customAbilities || []).find(x => x.id === id) : null;
    const [name, setName] = useState(entry?.name || '');
    const [desc, setDesc] = useState(entry?.desc || '');
    const [code, setCode] = useState(entry?.rawCode || '');
    const [art, setArt] = useState(entry?.artwork || '');
    const [regionIds, setRegionIds] = useState<string[]>(() => entry ? api.entryRegionIds(entry) : [api.defaultRegionForNewFakemon?.()].filter(Boolean));
    const save = saving(() => api.saveCustomAbility({ id, name, desc, rawCode: code, artwork: art, regionIds }), close);
    return (
        <Modal onClose={close} className="library-editor library-editor-ability" overlayClassName={sheet ? 'as-sheet' : ''}>
            <Head title={entry ? 'Edit Custom Ability' : 'Create Custom Ability'} regionIds={regionIds} setRegionIds={setRegionIds} close={close} />
            <div className="form-group">
                <label htmlFor="custom-ability-name">Ability Name</label>
                <input type="text" id="custom-ability-name" placeholder="e.g., Solar Heart" autoFocus value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="form-group">
                <label>Image <span className="label-optional">(optional, for previews)</span></label>
                <ArtField value={art} onChange={setArt} />
            </div>
            <div className="form-group">
                <label htmlFor="custom-ability-desc">Description</label>
                <textarea id="custom-ability-desc" rows={4} placeholder="Describe what this ability does..." value={desc} onChange={e => setDesc(e.target.value)} />
            </div>
            <BattleCode kind="ability" code={code} setCode={setCode} onBlocks={() => api.openAbilityBlockEditor(id)} />
            <Actions close={close} save={save} label="Save Ability" />
        </Modal>
    );
}

// ---- items ----

function ItemArtwork({ value, onChange }: { value: string; onChange: (url: string) => void }) {
    const [over, setOver] = useState(false);
    const read = (file?: File | null) => {
        if (!file) return;
        if (!file.type?.startsWith('image/')) { api.showToast('Please use an image file for item artwork.', 'error'); return; }
        const reader = new FileReader();
        reader.onload = () => onChange(String(reader.result));
        reader.readAsDataURL(file);
    };
    let input: HTMLInputElement | null = null;
    return (
        <div className={`artwork-upload-combined custom-item-artwork-zone${over ? ' artwork-drag-over' : ''}`}
            onClick={() => input?.click()}
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); setOver(true); }}
            onDragLeave={e => { e.preventDefault(); setOver(false); }}
            onDrop={e => { e.preventDefault(); e.stopPropagation(); setOver(false); read(e.dataTransfer.files?.[0]); }}>
            <div className="artwork-preview">{value ? <img src={value} alt="Item artwork" /> : <span className="placeholder">Item</span>}</div>
            <input ref={el => { input = el; }} type="file" accept="image/*" onClick={e => e.stopPropagation()} onChange={e => { read(e.target.files?.[0]); e.target.value = ''; }} />
            <div className="artwork-upload-overlay"><Icon name="upload" size={16} /><span>Click or drag item artwork here</span></div>
        </div>
    );
}

function CustomItemDialog({ id, sampleSetTarget, sheet, close }: DialogProps<{ id: string; sampleSetTarget?: { setIndex: number } | null; sheet?: boolean }>) {
    const entry = id ? (state.customItems || []).find(x => x.id === id) : null;
    const [name, setName] = useState(entry?.name || '');
    const [desc, setDesc] = useState(entry?.desc || '');
    const [art, setArt] = useState(entry?.artwork || '');
    const [mega, setMega] = useState(entry?.isMegaStone === true);
    const [code, setCode] = useState(entry?.rawCode || '');
    const [regionIds, setRegionIds] = useState<string[]>(() => entry ? api.entryRegionIds(entry) : [api.defaultRegionForNewFakemon?.()].filter(Boolean));
    const save = saving(() => api.saveCustomItem({ id, name, desc, artwork: art, isMegaStone: mega, rawCode: code, regionIds, sampleSetTarget }), close);
    return (
        <Modal onClose={close} className="library-editor library-editor-item" overlayClassName={sheet ? 'as-sheet' : ''}>
            <Head title={entry ? 'Edit Custom Item' : 'Create Custom Item'} regionIds={regionIds} setRegionIds={setRegionIds} close={close} />
            <div className="form-group">
                <label htmlFor="custom-item-name">Item Name</label>
                <input type="text" id="custom-item-name" placeholder="e.g., Moonlit Charm" autoFocus value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="form-group">
                <label>Artwork</label>
                <ItemArtwork value={art} onChange={setArt} />
            </div>
            <div className="form-group">
                <label htmlFor="custom-item-desc">Description</label>
                <textarea id="custom-item-desc" rows={4} placeholder="Describe what this item does..." value={desc} onChange={e => setDesc(e.target.value)} />
            </div>
            <label className="custom-item-mega-toggle">
                <input type="checkbox" checked={mega} onChange={e => setMega(e.target.checked)} />
                <span className="custom-item-mega-toggle-copy">
                    <strong>Mega Stone</strong>
                    <span>Mark this item as a Mega Stone for evolution and item pickers.</span>
                </span>
            </label>
            <BattleCode kind="item" code={code} setCode={setCode} onBlocks={() => api.openItemBlockEditor(id)} />
            <Actions close={close} save={save} label="Save Item" />
        </Modal>
    );
}

// ---- moves ----

const CATEGORIES = ['Physical', 'Special', 'Status'];

function CategoryPicker({ value, onPick }: { value: string; onPick: (c: string) => void }) {
    const [open, setOpen] = useState(false);
    const ref = useClickAway(open, () => setOpen(false));
    const pill = (c: string) => <span className={`cat-pill cat-${c.toLowerCase()}`}><CategoryIcon category={c} size={14} /> {c}</span>;
    return (
        <div className={`cat-dropdown${open ? ' open' : ''}`} ref={ref}>
            <button className="cat-dropdown-trigger" type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}>
                <span className="cat-dropdown-value">{pill(value)}</span>
                <span className="type-dropdown-arrow"><Icon name="chevron-down" size={12} /></span>
            </button>
            <div className="cat-dropdown-menu">
                {CATEGORIES.map(c => <div key={c} className="cat-dropdown-option" onClick={() => { setOpen(false); onPick(c); }}>{pill(c)}</div>)}
            </div>
        </div>
    );
}

function CustomMoveDialog({ index, libraryId, sheet, close }: DialogProps<{ index: number | null; libraryId: string; sheet?: boolean }>) {
    const [draft, setDraft] = useState(() => api.customMoveDraft(index, libraryId));
    const set = (patch: object) => setDraft((d: any) => ({ ...d, ...patch }));
    const editing = !!libraryId || index != null;
    const statusOnly = draft.category === 'Status';
    const save = saving(() => api.saveCustomMoveEntry({ index, libraryId, draft }), close);
    const num = (key: string, label: string, min: number, max: number) => (
        <div className="form-group">
            <label>{label}</label>
            <input type="number" min={min} max={max} value={draft[key]} onChange={e => set({ [key]: e.target.value })} />
        </div>
    );
    return (
        <Modal onClose={close} className="library-editor library-editor-move" overlayClassName={sheet ? 'as-sheet' : ''}>
            <Head title={editing ? 'Edit Custom Move' : 'Create Custom Move'} regionIds={draft.regionIds} setRegionIds={regionIds => set({ regionIds })} close={close} />
            <div className="form-group">
                <label htmlFor="custom-move-name">Move Name</label>
                <input type="text" id="custom-move-name" placeholder="e.g., Ember Fang" autoFocus value={draft.name} onChange={e => set({ name: e.target.value })} />
            </div>
            <div className="form-group">
                <label>Image <span className="label-optional">(optional, for previews)</span></label>
                <ArtField value={draft.artwork} onChange={artwork => set({ artwork })} />
            </div>
            <div className="form-row">
                <div className="form-group">
                    <label>Type</label>
                    <TypeDropdown id="custom-move-type" value={draft.type} placeholder="Select Type" allowNone={false} onPick={type => set({ type })} />
                </div>
                <div className="form-group">
                    <label>Category</label>
                    <CategoryPicker value={draft.category} onPick={category => set({ category })} />
                </div>
            </div>
            <div className="form-row-3">
                {num('basePower', 'Base Power', 0, 250)}
                {num('accuracy', 'Accuracy', 0, 100)}
                {num('pp', 'PP', 1, 64)}
            </div>
            {num('priority', 'Priority', -7, 5)}
            <div className="form-group">
                <label>Flags</label>
                <div className="flag-checkboxes">
                    {/* only a status move can be bounced back or snatched */}
                    {(MOVE_FLAG_OPTIONS as Array<[string, string]>).filter(([flag]) => statusOnly || (flag !== 'reflectable' && flag !== 'snatch')).map(([flag, label]) => (
                        <label key={flag}>
                            <input type="checkbox" checked={!!draft.flags[flag]} onChange={e => set({ flags: { ...draft.flags, [flag]: e.target.checked } })} /> {label}
                        </label>
                    ))}
                </div>
            </div>
            <div className="form-group">
                <label htmlFor="custom-move-desc">Description</label>
                <textarea id="custom-move-desc" rows={3} placeholder="Describe what this move does..." value={draft.desc} onChange={e => set({ desc: e.target.value })} />
            </div>
            <BattleCode kind="move" code={draft.rawCode} setCode={rawCode => set({ rawCode })} onBlocks={() => api.openMoveBlockEditor(libraryId)} />
            <Actions close={close} save={save} label="Save Move" />
        </Modal>
    );
}

// ---- "Add Custom Ability / Move": pick one from your library ----

function ChooserDialog({ kind, close }: DialogProps<{ kind: 'ability' | 'move' }>) {
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState('name-asc');
    const isAbility = kind === 'ability';
    const items: any[] = api.customEntityChoices(kind, query, sort);
    const make = () => { close(); if (isAbility) api.openCustomAbilityLibraryModal(); else api.openCustomMoveModal(); };
    const empty: ReactNode = query ? 'No custom entries match your search.' : (isAbility ? 'No custom abilities yet.' : 'No custom moves yet.');
    return (
        <Modal onClose={close} title={isAbility ? 'Add Custom Ability' : 'Add Custom Move'} className="custom-entity-chooser" labelledBy="custom-entity-chooser-title">
            <button className="btn btn-primary custom-entity-make" type="button" onClick={make}><Icon name="plus" size={16} />{isAbility ? 'Make a New Ability' : 'Make a New Move'}</button>
            <div className="custom-entity-library-controls">
                <input className="custom-entity-search" type="text" placeholder={isAbility ? 'Search your custom abilities...' : 'Search your custom moves...'} value={query} onChange={e => setQuery(e.target.value)} aria-label="Search" />
                <select className="custom-entity-sort" value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort">
                    <option value="name-asc">Name (A-Z)</option>
                    <option value="name-desc">Name (Z-A)</option>
                    <option value="newest">Newest First</option>
                    <option value="oldest">Oldest First</option>
                </select>
            </div>
            <div className="custom-entity-chooser-list">
                {items.length ? items.map(item => (
                    <div key={item.id} className="chooser-option" role="button" tabIndex={0}
                        onClick={() => (isAbility ? api.addExistingCustomAbility(item.id) : api.addExistingCustomMove(item.id))}>
                        <div>
                            <strong>{item.name || 'Unnamed'}</strong>
                            {isAbility && item.blocks?.trigger && <> <span className="ability-code-badge" title="Has battle code from the block editor"><Icon name="puzzle" /> Coded</span></>}
                            <span>{isAbility ? (item.desc || 'No description') : `${item.category || 'Status'} · ${item.type || 'Normal'} · ${item.basePower || '-'} BP · ${item.pp || '-'} PP`}</span>
                        </div>
                        <Icon name="plus-circle" />
                    </div>
                )) : <div className="custom-entity-empty">{empty}</div>}
            </div>
        </Modal>
    );
}

registerDialog('custom-ability', CustomAbilityDialog);
registerDialog('custom-item', CustomItemDialog);
registerDialog('custom-move', CustomMoveDialog);
registerDialog('custom-entity-chooser', ChooserDialog);
