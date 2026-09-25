// The evolution board's dialogs: add a Fakémon or main-game Pokémon to the
// board, and add or edit an evolution method (by level, by item, or described).

import { useState } from 'react';
import { api } from '../../core/app.ts';
import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Modal } from '../components/Modal.tsx';
import { useClickAway } from '../components/editor/fields.tsx';
import { Icon } from '../components/Icon.tsx';

function NodeChooserDialog({ kind, close }: DialogProps<{ kind: 'fakemon' | 'vanilla' }>) {
    const [query, setQuery] = useState('');
    const items: any[] = api.evolutionNodeChoices(kind, query);
    return (
        <Modal onClose={close} title={kind === 'fakemon' ? 'Add Fakemon' : 'Add Vanilla Pokémon'} className="evolution-node-modal" labelledBy="evolution-node-title">
            <div className="pokemon-template-controls">
                <input type="text" placeholder="Search Pokemon by name..." autoComplete="off" autoFocus value={query} onChange={e => setQuery(e.target.value)} aria-label="Search" />
            </div>
            <div className="pokemon-template-list evolution-node-list">
                {items.length ? items.map(x => {
                    const id = x.id || x.key || x.name;
                    const sprite = kind === 'fakemon' ? (x.artwork || '') : (api.getSpriteUrl?.(x.id, x) || '');
                    return (
                        <button key={id} type="button" className="pokemon-template-card" onClick={() => api.addEvolutionNode(kind, id)}>
                            {sprite
                                ? <img className="pokemon-template-sprite" src={sprite} alt={x.name} loading="lazy"
                                    onError={e => (window as any).fallbackPokemonImage?.(e.currentTarget, String(x.name || ''), String(x.baseSpecies || x.name || id))} />
                                : <img className="pokemon-template-sprite no-art-placeholder" src="assets/no_art_placeholder.png" alt="" />}
                            <span className="pokemon-template-info">
                                <span className="pokemon-template-number">{kind === 'fakemon' ? 'FAKEMON' : (x.num ? `#${String(x.num).padStart(3, '0')}` : 'VANILLA')}</span>
                                <span className="pokemon-template-name">{x.name || 'Pokémon'}</span>
                                <span className="pokemon-template-meta">
                                    {(x.types || []).map((t: string) => <span key={t} className={`type-pill type-${String(t).toLowerCase()}`}>{t}</span>)}
                                    <span className="pokemon-template-bst">{x.species || ''}</span>
                                </span>
                            </span>
                            <span className="pokemon-template-arrow">›</span>
                        </button>
                    );
                }) : <div className="pokemon-template-empty">No Pokémon match that search.</div>}
            </div>
        </Modal>
    );
}

const METHODS: Array<[string, string]> = [['level', 'By Level'], ['item', 'By Item'], ['custom', 'Custom Method']];

/** An item box with suggestions, your own items first. */
function ItemCombobox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    const [open, setOpen] = useState(false);
    const ref = useClickAway(open, () => setOpen(false));
    const [broken, setBroken] = useState<Record<string, boolean>>({});
    const items: any[] = open ? api.evolutionItemSuggestions(value) : [];
    return (
        <div className="evo-combobox" ref={ref}>
            <input type="text" autoComplete="off" placeholder="Search or type an item..." value={value} aria-label="Item"
                onFocus={() => setOpen(true)} onChange={e => { onChange(e.target.value); setOpen(true); }} onBlur={() => setTimeout(() => setOpen(false), 180)} />
            <div className={`evo-combobox-menu${open ? ' open' : ''}`}>
                {open && (items.length ? items.map(item => {
                    const icon = api.evolutionItemIcon(item.name);
                    const desc = String(item.desc || '').trim();
                    const custom = item.source === 'custom' || item.custom === true;
                    return (
                        <div key={item.name} className={`autocomplete-item evo-method-item-option${custom ? ' evo-method-custom-item' : ''}`}
                            onMouseDown={e => { e.preventDefault(); onChange(item.name); setOpen(false); }}>
                            <span className="evo-method-item-main">
                                {icon && !broken[icon] && <img src={icon} alt="" className="evo-method-item-icon" onError={() => setBroken(b => ({ ...b, [icon]: true }))} />}
                                <span>{item.name}</span>
                            </span>
                            {desc && <span className="meta">{desc.length > 70 ? `${desc.slice(0, 67)}...` : desc}</span>}
                        </div>
                    );
                }) : <div className="autocomplete-item"><span>No matches</span></div>)}
            </div>
        </div>
    );
}

function MethodDialog({ nodeId, close }: DialogProps<{ nodeId: string | null }>) {
    const node = nodeId ? api.ensureGraph().nodes.find((n: any) => n.id === nodeId) : null;
    const [type, setType] = useState<string>(node?.methodType || 'level');
    const [level, setLevel] = useState(String(node?.methodType === 'level' ? (node.value || 16) : 16));
    const [value, setValue] = useState(String(node?.methodType === 'item' ? node.value || '' : ''));
    const [description, setDescription] = useState(String(node?.description || ''));
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useClickAway(menuOpen, () => setMenuOpen(false));
    const save = () => { api.saveEvolutionMethod({ nodeId, type, level, value, description }); close(); };
    return (
        <Modal onClose={close} title={node ? 'Edit Evo Method' : 'Add Evo Method'} className="evolution-method-modal" labelledBy="evolution-method-title">
            <div className="evolution-method-form">
                <div className="form-group">
                    <label>Method</label>
                    <div className={`type-dropdown evo-method-type-dropdown${menuOpen ? ' open' : ''}`} ref={menuRef}>
                        <button className="type-dropdown-trigger" type="button" onClick={() => setMenuOpen(v => !v)} aria-expanded={menuOpen}>
                            <span className="type-dropdown-value">{METHODS.find(([k]) => k === type)?.[1]}</span>
                            <span className="type-dropdown-arrow"><Icon name="chevron-down" size={12} /></span>
                        </button>
                        <div className="type-dropdown-menu">
                            {METHODS.map(([k, label]) => (
                                <div key={k} className="type-dropdown-option" onClick={() => { setType(k); setMenuOpen(false); }}>{label}</div>
                            ))}
                        </div>
                    </div>
                </div>
                {type === 'level' && (
                    <div className="form-group">
                        <label htmlFor="evolution-method-level">Level</label>
                        <input id="evolution-method-level" type="number" min={1} max={100} value={level} onChange={e => setLevel(e.target.value)} />
                    </div>
                )}
                {type === 'item' && (
                    <div className="form-group">
                        <label>Item</label>
                        <ItemCombobox value={value} onChange={setValue} />
                        <div className="evolution-method-hint">Evolution Stones and Mega Stones are detected automatically from the item you choose.</div>
                    </div>
                )}
                {type === 'custom' && (
                    <div className="form-group">
                        <label htmlFor="evolution-method-description">Description</label>
                        <textarea id="evolution-method-description" placeholder="Describe the evolution condition..." value={description} onChange={e => setDescription(e.target.value)} />
                    </div>
                )}
                <div className="evolution-method-actions">
                    <button className="btn btn-secondary btn-sm" type="button" onClick={close}>Cancel</button>
                    <button className="btn btn-primary btn-sm" type="button" onClick={save}>Save Method</button>
                </div>
            </div>
        </Modal>
    );
}

registerDialog('evo-node', NodeChooserDialog);
registerDialog('evo-method', MethodDialog);
