// Making a Fakémon: New Fakemon asks for a name, then starts blank or goes on
// to Choose a Pokemon Template, which copies a main-game Pokémon's data in.
// The editor side of both is startNewFakemonEditor / usePokemonTemplate in
// js/features/pokedex.ts.

import { useDeferredValue, useState } from 'react';
import { api, state } from '../../core/app.ts';
import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Modal } from '../components/Modal.tsx';
import { useStore } from '../store.ts';

function NewFakemonDialog({ close }: DialogProps) {
    const [name, setName] = useState('');
    const create = () => {
        const clean = name.trim();
        if (!clean) { api.showToast('Please enter a Pokemon name first!', 'error'); return; }
        api.startNewFakemonEditor(clean, null);
    };
    return (
        <Modal onClose={close} title="New Fakemon" className="new-fakemon-modal" labelledBy="new-fakemon-title">
            <div className="form-group" style={{ marginBottom: 18 }}>
                <label htmlFor="new-fakemon-name">Enter your Fakemon's name</label>
                <input id="new-fakemon-name" type="text" placeholder="e.g., Flareon" autoComplete="off" autoFocus value={name}
                    onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); create(); } }} />
            </div>
            <div className="new-fakemon-actions">
                <button className="btn btn-primary new-fakemon-choice" type="button" onClick={create}>Create Fakemon</button>
                <button className="btn btn-secondary new-fakemon-choice" type="button" onClick={() => api.openPokemonTemplateChooser(name)}>Use Existing Pokemon as Template</button>
            </div>
        </Modal>
    );
}

const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

function TemplateCard({ p, onPick }: { p: any; onPick: () => void }) {
    const bst = STATS.reduce((sum, k) => sum + (Number(p.stats?.[k]) || 0), 0);
    return (
        <button className="pokemon-template-card" type="button" onClick={onPick}>
            <img className="pokemon-template-sprite" src={api.getPokemonTemplateSprite(p)} alt={p.name} loading="lazy"
                onError={e => (window as any).fallbackPokemonImage?.(e.currentTarget, String(p.name || ''), String(p.baseSpecies || ''))} />
            <span className="pokemon-template-info">
                <span className="pokemon-template-number">#{String(p.num).padStart(3, '0')}</span>
                <span className="pokemon-template-name">{p.name}</span>
                <span className="pokemon-template-meta">
                    {(p.types || []).map((t: string) => <span key={t} className={`type-pill type-${String(t).toLowerCase()}`}>{t}</span>)}
                    <span className="pokemon-template-bst">BST {bst}</span>
                </span>
            </span>
            <span className="pokemon-template-arrow">›</span>
        </button>
    );
}

function PokemonTemplateDialog({ name, close }: DialogProps<{ name?: string }>) {
    useStore();
    const [query, setQuery] = useState('');
    // a thousand-odd cards: typing stays responsive while the list catches up
    const deferred = useDeferredValue(query);
    const entries: any[] = state.sdLoaded ? api.getPokemonTemplateEntries().filter((p: any) => api.templateMatches(p, deferred)) : [];
    return (
        <Modal onClose={close} title="Choose a Pokemon Template" className="pokemon-template-modal" labelledBy="pokemon-template-title">
            <p className="new-fakemon-subtitle">Choose a vanilla Pokémon. Its stats, typing, abilities, dimensions, learnset, and other available data will be copied into your new Fakemon.</p>
            <div className="pokemon-template-controls">
                <input type="text" placeholder="Search Pokemon by name..." autoComplete="off" autoFocus value={query} onChange={e => setQuery(e.target.value)} />
            </div>
            <div className="pokemon-template-status">{deferred.trim() ? `${entries.length} matching Pokemon` : `${entries.length} vanilla Pokemon available`}</div>
            <div className="pokemon-template-list">
                {entries.length
                    ? entries.map(p => <TemplateCard key={p.id} p={p} onPick={() => api.usePokemonTemplate(p.id, { name })} />)
                    : <div className="pokemon-template-empty">No Pokemon match that search.</div>}
            </div>
        </Modal>
    );
}

registerDialog('new-fakemon', NewFakemonDialog);
registerDialog('pokemon-template', PokemonTemplateDialog);
