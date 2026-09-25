// The editor's Basic Info tab: name, species, typing, number, artwork, cry,
// Pokédex entries, size, colour, egg groups and gender. Every field reads and
// writes the form in js/editor/draft.ts.

import { useRef, useState } from 'react';
import { api, state } from '../../../core/app.ts';
import {
    EGG_GROUPS, cleanMeasurement, editForm, form, setHeightUnit, setWeightUnit
} from '../../../editor/draft.ts';
import { Icon } from '../Icon.tsx';
import { ColorSwatchPicker, RollButton, RowHeading, TypeDropdown, TypePill } from './fields.tsx';
import { CommitInput } from '../CommitInput.tsx';

/** What the typing is weak to, resists and is immune to. */
function TypeEffectiveness() {
    const types = [form.type1, form.type2].filter(Boolean);
    if (!types.length) {
        return <div className="type-effectiveness-analysis"><div className="type-effectiveness-empty">Select a type to see weaknesses and resistances.</div></div>;
    }
    const groups = api.typeEffectiveness(types) as Record<'weak' | 'resist' | 'immune', Array<{ type: string; multiplier: number }>>;
    const group = (title: string, items: Array<{ type: string; multiplier: number }>, cls: string) => items.length > 0 && (
        <div className={`type-effectiveness-group ${cls}`}>
            <div className="type-effectiveness-group-title">{title}</div>
            <div className="type-effectiveness-pills">
                {items.map(({ type, multiplier }) => (
                    <span className="type-effectiveness-item" key={type}>
                        <TypePill type={type} />
                        <span className="type-effectiveness-multiplier">{multiplier === 0 ? '0×' : `${multiplier}×`}</span>
                    </span>
                ))}
            </div>
        </div>
    );
    const none = !groups.weak.length && !groups.resist.length && !groups.immune.length;
    return (
        <div className="type-effectiveness-analysis">
            {group('Weak to', groups.weak, 'weak')}
            {group('Resists', groups.resist, 'resist')}
            {group('Immune to', groups.immune, 'immune')}
            {none && <div className="type-effectiveness-empty">No special matchups.</div>}
        </div>
    );
}

/** Normal and shiny artwork: click or drop an image, switch between the two. */
function ArtworkField() {
    const input = useRef<HTMLInputElement>(null);
    const [over, setOver] = useState(false);
    const mode = state.artworkMode === 'shiny' ? 'shiny' : 'normal';
    const artwork = mode === 'shiny' ? state.shinyArtworkData : state.artworkData;
    return (
        <div className={`artwork-upload-combined${over ? ' artwork-drag-over' : ''}`} title="Click or drag an image here to upload artwork"
            onClick={e => { if (!(e.target as Element).closest('button')) input.current?.click(); }}
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; setOver(true); }}
            onDragLeave={e => { e.preventDefault(); if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
            onDrop={e => { e.preventDefault(); e.stopPropagation(); setOver(false); api.processArtworkFile(e.dataTransfer.files?.[0]); }}>
            <div className="artwork-mode-tabs" role="tablist" aria-label="Artwork type">
                {(['normal', 'shiny'] as const).map(m => (
                    <button key={m} type="button" role="tab" aria-selected={mode === m} className={`artwork-mode-tab${mode === m ? ' active' : ''}`}
                        onClick={e => { e.stopPropagation(); api.setArtworkMode(m); }}>
                        <Icon name={m === 'shiny' ? 'sparkles' : 'image'} /><span>{m === 'shiny' ? 'Shiny' : 'Normal'}</span>
                    </button>
                ))}
            </div>
            <div className="artwork-preview" id="artwork-preview">
                {artwork
                    ? <img src={artwork} alt={mode === 'shiny' ? 'Shiny artwork' : 'Artwork'} />
                    : mode === 'shiny' ? <span className="placeholder">Shiny</span> : <img className="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork" />}
            </div>
            <input ref={input} type="file" id="artwork-upload" accept="image/*" onChange={e => { api.processArtworkFile(e.target.files?.[0]); e.target.value = ''; }} />
            <div className="artwork-upload-overlay"><Icon name="upload" size={16} /><span>{mode === 'shiny' ? 'Click or drag shiny artwork here' : 'Click or drag artwork here'}</span></div>
            {artwork && <button type="button" className="artwork-remove-btn" onClick={e => api.removeCurrentArtwork(e)}>Remove artwork</button>}
        </div>
    );
}

function CryField() {
    const input = useRef<HTMLInputElement>(null);
    return (
        <div className="cry-upload-zone" title="Click to upload a Pokemon cry (max 2 MB)"
            onClick={e => { if (!(e.target as Element).closest('button')) input.current?.click(); }}>
            <input ref={input} type="file" id="cry-upload" accept="audio/*" onChange={e => { api.processPokemonCryFile(e.target.files?.[0]); e.target.value = ''; }} />
            <div className="cry-upload-content">
                <Icon name="volume-2" size={18} />
                <span>{state.cryData ? 'Pokemon cry uploaded - click to replace' : 'Click to upload a Pokemon cry'}</span>
                <small>Audio only · Max 2 MB</small>
            </div>
            {state.cryData && <button type="button" className="artwork-remove-btn cry-remove-btn" onClick={e => api.removePokemonCry(e)}>Remove cry</button>}
        </div>
    );
}

function EggSelect({ id, value, onPick }: { id: string; value: string; onPick: (v: string) => void }) {
    return (
        <select id={id} value={value} onChange={e => onPick(e.target.value)}>
            <option value="">None</option>
            {EGG_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
    );
}

function GenderField() {
    const female = Math.round((100 - form.male) * 10) / 10;
    const setMale = (value: number) => editForm({ male: Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0)) });
    return (
        <div className="form-group">
            <label>Gender Ratio</label>
            <div className="gender-genderless-row">
                <input type="checkbox" id="gender-genderless" checked={form.genderless} onChange={e => editForm({ genderless: e.target.checked })} />
                <label htmlFor="gender-genderless">Genderless</label>
            </div>
            {!form.genderless && (
                <div id="gender-ratio-controls">
                    <input type="range" id="gender-slider" className="gender-slider" min={0} max={100} step={0.1} value={form.male}
                        aria-label="Percent male" onChange={e => setMale(parseFloat(e.target.value))} />
                    <div className="gender-inputs">
                        <div className="gender-input male">
                            <span className="gender-name">Male</span>
                            <CommitInput type="number" min={0} max={100} step={0.1} value={form.male} aria-label="Percent male" onCommit={v => setMale(parseFloat(v))} />
                            <span>%</span>
                        </div>
                        <div className="gender-input female">
                            <span>%</span>
                            <CommitInput type="number" min={0} max={100} step={0.1} value={female} aria-label="Percent female" onCommit={v => setMale(100 - (parseFloat(v) || 0))} />
                            <span className="gender-name">Female</span>
                        </div>
                    </div>
                </div>
            )}
            <div className="gender-bar" id="gender-bar-preview">
                {form.genderless || (form.male <= 0 && female <= 0)
                    ? <div className="genderless" style={{ width: '100%' }} />
                    : <>{form.male > 0 && <div className="male" style={{ width: `${form.male}%` }} />}{female > 0 && <div className="female" style={{ width: `${female}%` }} />}</>}
            </div>
        </div>
    );
}

export function BasicTab() {
    const special = form.isMega || form.isForme;
    return (
        <>
            <div className="form-group">
                <label htmlFor="fakemon-name">Pokemon Name</label>
                <div className="name-input-row">
                    <input type="text" id="fakemon-name" placeholder="e.g., Flareon" value={form.name} onChange={e => editForm({ name: e.target.value })} />
                    <RollButton id="name-roll-btn" title="Suggest a name based on this Fakemon's type, ability, and species" onRoll={e => api.openNameRollPopover(e)} />
                </div>
            </div>
            <div className="form-group species-evo-row">
                <div className="species-field-wrap">
                    <label htmlFor="fakemon-species">Species / Category</label>
                    <div className="name-input-row">
                        {/* a Mega or forme shares its base's species */}
                        <input type="text" id="fakemon-species" placeholder="e.g., Flame Pokemon" value={form.species} disabled={special} onChange={e => editForm({ species: e.target.value })} />
                        <RollButton id="species-roll-btn" title="Suggest a species/category based on this Fakemon's type" onRoll={e => api.openSpeciesRollPopover(e)} />
                    </div>
                </div>
                <div className="species-evo-toggles">
                    <label className="compact-toggle-label" title="This Fakemon is a Mega Evolution">
                        <input type="checkbox" checked={form.isMega} onChange={e => api.toggleEvolutionMode('mega', e.target.checked)} />
                        <span>Is Mega Evolution</span>
                    </label>
                    <label className="compact-toggle-label" title="This Fakemon is a forme change">
                        <input type="checkbox" checked={form.isForme} onChange={e => api.toggleEvolutionMode('forme', e.target.checked)} />
                        <span>Is a Forme Change</span>
                    </label>
                </div>
            </div>
            <RowHeading roll={<RollButton id="types-roll-btn" small title="Roll random types" onRoll={e => api.openTypesRollPopover(e)} />}>Typing</RowHeading>
            <div className="form-row">
                <div className="form-group">
                    <label>Type 1</label>
                    <TypeDropdown id="type1" value={form.type1} placeholder="Select Type" onPick={t => editForm({ type1: t })} />
                </div>
                <div className="form-group">
                    <label>Type 2 (Optional)</label>
                    <TypeDropdown id="type2" value={form.type2} placeholder="None" onPick={t => editForm({ type2: t })} />
                </div>
            </div>
            <TypeEffectiveness />
            <div className="form-group">
                <label htmlFor="fakemon-number">Pokedex Number</label>
                <input type="text" id="fakemon-number" placeholder="e.g., #001" value={form.number} onChange={e => editForm({ number: e.target.value })} />
            </div>
            <div className="form-group">
                <label>Artwork</label>
                <ArtworkField />
            </div>
            <div className="form-group">
                <label htmlFor="art-credit-input">Art Credit (Optional)</label>
                <CommitInput type="text" id="art-credit-input" placeholder="e.g., Art by @username" value={state.artCredit || ''} onCommit={v => api.setArtCredit(v)} />
                <small className="field-hint">Shown as a small credit button next to the artwork on the pokedex board. Artwork must be drawn by a person; AI-generated images are not allowed on Woogidex.</small>
            </div>
            <div className="form-group">
                <label>Pokemon Cry</label>
                <CryField />
            </div>
            <div className="form-group">
                <label htmlFor="dex-entry1">Pokedex Entry 1</label>
                <textarea id="dex-entry1" placeholder="First Pokedex description..." value={form.dexEntry1} onChange={e => editForm({ dexEntry1: e.target.value })} />
            </div>
            <div className="form-group">
                <label htmlFor="dex-entry2">Pokedex Entry 2</label>
                <textarea id="dex-entry2" placeholder="Second Pokedex description..." value={form.dexEntry2} onChange={e => editForm({ dexEntry2: e.target.value })} />
            </div>
            <RowHeading roll={<RollButton id="measurements-roll-btn" small title="Roll a random height and weight" onRoll={e => api.openHeightWeightRollPopover(e)} />}>Height &amp; Weight</RowHeading>
            <div className="form-row">
                <div className="form-group">
                    <label htmlFor="fakemon-height">Height</label>
                    <div className="measurement-input-wrap">
                        <input type="text" id="fakemon-height" placeholder="e.g., 0.9" inputMode="decimal" value={form.height} onChange={e => editForm({ height: cleanMeasurement(e.target.value) })} />
                        <select aria-label="Height unit" value={form.heightUnit} onChange={e => setHeightUnit(e.target.value as 'm' | 'ft')}>
                            <option value="m">meters</option>
                            <option value="ft">feet</option>
                        </select>
                    </div>
                </div>
                <div className="form-group">
                    <label htmlFor="fakemon-weight">Weight</label>
                    <div className="measurement-input-wrap">
                        <input type="text" id="fakemon-weight" placeholder="e.g., 25.0" inputMode="decimal" value={form.weight} onChange={e => editForm({ weight: cleanMeasurement(e.target.value) })} />
                        <select aria-label="Weight unit" value={form.weightUnit} onChange={e => setWeightUnit(e.target.value as 'kg' | 'lb')}>
                            <option value="kg">kilograms</option>
                            <option value="lb">pounds</option>
                        </select>
                    </div>
                </div>
            </div>
            <div className="form-group">
                <label>Pokedex Colour</label>
                <ColorSwatchPicker value={form.color} onPick={color => editForm({ color })} />
            </div>
            <RowHeading roll={<RollButton id="egg-roll-btn" small title="Roll random egg groups" onRoll={e => api.openEggGroupRollPopover(e)} />}>Egg Groups</RowHeading>
            <div className="form-row">
                <div className="form-group">
                    <label htmlFor="fakemon-egg1">Egg Group 1</label>
                    <EggSelect id="fakemon-egg1" value={form.egg1} onPick={egg1 => editForm({ egg1 })} />
                </div>
                <div className="form-group">
                    <label htmlFor="fakemon-egg2">Egg Group 2</label>
                    <EggSelect id="fakemon-egg2" value={form.egg2} onPick={egg2 => editForm({ egg2 })} />
                </div>
            </div>
            <GenderField />
        </>
    );
}
