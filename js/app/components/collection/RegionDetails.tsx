// A region's own page, in place of My Collection's tabs and grid: its banner,
// name, tagline, bio and colour, what it brings over from the main games,
// what's in it and exporting it. The data and saving are js/features/regions.ts.

import { api, state } from '../../../core/app.ts';
import {
    POOL_ICON, POOL_KINDS, POOL_LABEL, REGION_COLORS, poolOf, poolSummary, regionDetailsStatus
} from '../../../features/regions.ts';
import { Icon } from '../Icon.tsx';
import type { Region } from '../../types.ts';

export function ColorSwatches({ colors, selected, onPick }: { colors: string[]; selected: string | null; onPick: (hex: string) => void }) {
    return (
        <div className="color-options">
            {colors.map(hex => (
                <button key={hex} type="button" className={`color-option${hex === selected ? ' selected' : ''}`} style={{ backgroundColor: hex }}
                    aria-label={`Colour ${hex}`} aria-pressed={hex === selected} onClick={() => onPick(hex)} />
            ))}
        </div>
    );
}

const COUNTS: Array<[string, string]> = [['fakemon', 'Fakémon'], ['moves', 'Moves'], ['abilities', 'Abilities'], ['items', 'Items'], ['types', 'Types']];
const MODES: Array<[string, string]> = [['none', 'None'], ['natdex', 'National Dex'], ['custom', 'Choose']];

function inRegion(list: any[] | undefined, region: Region) {
    return (list || []).filter(x => !x.pendingVanilla && api.entryInRegion(x, region.id)).length;
}

export function RegionDetails({ region }: { region: Region }) {
    const counts: Record<string, number> = {
        fakemon: inRegion(state.fakemonDB, region),
        moves: inRegion(state.customMoves, region),
        abilities: inRegion(state.customAbilities, region),
        items: inRegion(state.customItems, region),
        types: inRegion(api.getCustomTypes?.(), region)
    };
    const color = region.color || REGION_COLORS[0];
    return (
        <>
            <div className={`region-details-banner${region.banner ? ' has-image' : ''}`}
                style={{ '--region-color': color, ...(region.banner ? { backgroundImage: `url('${region.banner}')` } : {}) } as React.CSSProperties}>
                <div className="region-details-banner-actions">
                    <label className="btn btn-secondary btn-sm">
                        <Icon name="image-up" /><span>{region.banner ? 'Change banner' : 'Add banner'}</span>
                        <input type="file" accept="image/*" hidden onChange={e => api.uploadRegionBanner(e)} />
                    </label>
                    {region.banner && <button type="button" className="btn btn-secondary btn-sm" onClick={() => api.removeRegionBanner()}><Icon name="x" /><span>Remove</span></button>}
                </div>
                <div className="region-details-banner-title">
                    <h2>{region.name}</h2>
                    {region.tagline && <p>{region.tagline}</p>}
                </div>
            </div>

            <div className="region-details-grid">
                <div className="region-details-main">
                    {/* keyed by region: switching regions starts the fields afresh */}
                    <section className="region-details-section" key={region.id}>
                        <header><h3>About</h3><span className="region-details-status">{regionDetailsStatus()}</span></header>
                        <div className="form-group"><label htmlFor="region-details-name">Name</label>
                            <input type="text" id="region-details-name" maxLength={40} defaultValue={region.name} onChange={e => api.regionDetailsInput('name', e.target.value)} /></div>
                        <div className="form-group"><label htmlFor="region-details-tagline">Tagline</label>
                            <input type="text" id="region-details-tagline" maxLength={90} defaultValue={region.tagline || ''} placeholder="One line, like a game's box art" onChange={e => api.regionDetailsInput('tagline', e.target.value)} /></div>
                        <div className="form-group"><label htmlFor="region-details-bio">Bio</label>
                            <textarea id="region-details-bio" rows={6} maxLength={4000} defaultValue={region.bio || ''} placeholder="Its history, its landmarks, its legends..." onChange={e => api.regionDetailsInput('bio', e.target.value)} /></div>
                        <div className="form-group"><label>Colour</label>
                            <ColorSwatches colors={REGION_COLORS} selected={region.color || null} onPick={hex => api.setRegionDetailsColor(hex)} /></div>
                    </section>

                    <section className="region-details-section">
                        <header><h3>From the main games</h3></header>
                        <p className="region-details-help">What {region.name} brings over from the official games, next to what you make. It's included when you export the region.</p>
                        <div className="region-pools">
                            {POOL_KINDS.map((kind: string) => {
                                const { mode } = poolOf(region, kind);
                                return (
                                    <div className="region-pool-row" key={kind}>
                                        <span className="region-pool-icon"><Icon name={(POOL_ICON as Record<string, string>)[kind]} /></span>
                                        <span className="region-pool-name"><strong>{(POOL_LABEL as Record<string, string>)[kind]}</strong><small>{poolSummary(region, kind)}</small></span>
                                        <div className="seg">
                                            {MODES.map(([m, label]) => (
                                                <button key={m} type="button" className={`seg-btn${mode === m ? ' on' : ''}`} aria-pressed={mode === m} onClick={() => api.setRegionPoolMode(kind, m)}>{label}</button>
                                            ))}
                                        </div>
                                        {mode === 'custom'
                                            ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => api.openRegionPicker(kind)}>Edit list</button>
                                            : <span className="region-pool-spacer" />}
                                    </div>
                                );
                            })}
                        </div>
                    </section>
                </div>

                <aside className="region-details-side">
                    <section className="region-details-section">
                        <header><h3>In this region</h3></header>
                        <dl className="region-counts">
                            {COUNTS.map(([k, label]) => (
                                <div key={k}><dt>{label}</dt><dd><button type="button" onClick={() => { api.closeRegionDetails(); api.setCollectionView(k); }}>{counts[k]}</button></dd></div>
                            ))}
                        </dl>
                    </section>
                    <section className="region-details-section">
                        <header><h3>Export {region.name}</h3></header>
                        <p className="region-details-help">Only this region: its Fakémon, moves, abilities, items and types.</p>
                        <div className="region-export-list">
                            <button type="button" className="btn btn-secondary" onClick={() => api.exportCollection()}><Icon name="file-json" />JSON (to import)</button>
                            <button type="button" className="btn btn-secondary" onClick={() => api.exportCollectionAsShowdownMod()}><Icon name="package" />Showdown mod</button>
                            <button type="button" className="btn btn-secondary" onClick={() => api.exportCollectionAsEssentialsMod()}><Icon name="package" />Essentials mod</button>
                            <button type="button" className="btn btn-secondary" onClick={() => api.exportCollectionAsPlainTextZip()}><Icon name="file-text" />Plain text (.zip)</button>
                        </div>
                    </section>
                    <button type="button" className="btn btn-secondary region-delete-btn region-details-delete" onClick={() => api.deleteActiveRegion()}><Icon name="trash-2" />Delete region</button>
                </aside>
            </div>
        </>
    );
}
