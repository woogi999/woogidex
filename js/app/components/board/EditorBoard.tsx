// The board for whatever the editor holds, with the family's evolution chain
// and the Base / Mega / Forme tabs; clicking another saved Fakémon in either
// opens it in the editor. Used by the editor's Preview tab and the quick
// preview (both read the editor's state).

import { useId } from 'react';
import { api } from '../../../core/app.ts';
import { PokedexBoard } from './PokedexBoard.tsx';
import { useStore } from '../../store.ts';

function EvoSprite({ info }: { info: any }) {
    const src = info.artwork || (info.kindLabel === 'Fakemon' ? '' : api.getSpriteUrl?.(info.spriteId, info.record || { id: info.spriteId, name: info.name }) || '');
    return (
        <div className="preview-evo-sprite-wrap">
            {src
                ? <img key={src} src={src} alt={info.name} onError={e => (window as any).fallbackPokemonImage?.(e.currentTarget, String(info.name || ''), String(info.record?.baseSpecies || info.refId || info.name || ''))} />
                : <img className="no-art-placeholder" src="assets/no_art_placeholder.png" alt="" />}
        </div>
    );
}

function EvoNode({ entry }: { entry: any }) {
    const info = entry.info;
    const clickable = !entry.isCurrent && entry.kind === 'fakemon' && entry.refId;
    const title = entry.isCurrent ? 'Currently editing' : (clickable ? `Edit ${info.name}` : `${info.name} (vanilla Pokémon)`);
    const cls = `${entry.isCurrent ? ' current' : ''}${clickable ? '' : ' not-clickable'}${entry.compact ? ' compact' : ''}`;
    const props = {
        type: 'button' as const, title, disabled: !clickable,
        style: { left: entry.x, top: entry.y, width: entry.w, height: entry.h },
        onClick: clickable ? () => api.editFakemonFromPreview(entry.refId) : undefined
    };
    const types = (info.types || []).map((t: string) => <span key={t} className={`type-pill type-${String(t).toLowerCase()}`}>{t}</span>);
    if (entry.isSpecial) {
        // at this size artwork and type pills would be unreadable; the badge says what differs
        return (
            <button className={`preview-evo-node preview-evo-node-special${cls}`} {...props}>
                <span className="preview-evo-badge">{entry.badge}</span>
                <span className="preview-evo-name">{info.name}</span>
            </button>
        );
    }
    if (entry.compact) {
        // sprite beside the text, so a split costs 68px a branch instead of 150
        return (
            <button className={`preview-evo-node${cls}`} {...props}>
                <EvoSprite info={info} />
                <span className="preview-evo-body">
                    <span className="preview-evo-name">{info.name}</span>
                    {types.length > 0 && <span className="preview-evo-types">{types}</span>}
                    {entry.method && <span className="preview-evo-card-method">{entry.method}</span>}
                </span>
            </button>
        );
    }
    const meta = [info.number, info.species].filter(Boolean).join(' · ');
    return (
        <button className={`preview-evo-node${cls}`} {...props}>
            <span className="preview-evo-stage">{entry.badge || `Stage ${entry.stage}`}</span>
            <EvoSprite info={info} />
            <span className="preview-evo-name">{info.name}</span>
            {meta && <span className="preview-evo-meta">{meta}</span>}
            {types.length > 0 && <span className="preview-evo-types">{types}</span>}
        </button>
    );
}

/** The family laid out as the graph it is (buildPreviewEvolutionModel in js/features/evolution.ts). */
export function EvolutionChain() {
    // unique per board: the PNG export clones the board next to the live one
    const markerId = `preview-evo-arrow-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
    const model = api.buildPreviewEvolutionModel();
    if (!model) return null;
    return (
        <div className="board-section board-evolution-chain">
            <div className="board-section-title">Evolution Chain</div>
            {/* a wide family scrolls sideways instead of bursting the board */}
            <div className="preview-evo-scroller">
                <div className="preview-evo-graph" style={{ width: model.width, height: model.height }}>
                    <svg className="preview-evo-wires" width={model.width} height={model.height} viewBox={`0 0 ${model.width} ${model.height}`} aria-hidden="true">
                        <defs>
                            <marker id={markerId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
                                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                            </marker>
                        </defs>
                        {model.groups.map((gr: any, i: number) => <rect key={i} className="preview-evo-group" x={gr.x + 1} y={gr.y + 1} width={gr.w - 2} height={gr.h - 2} rx={14} />)}
                        {model.links.map((link: any, i: number) => link.kind === 'forme'
                            ? <path key={i} className="preview-evo-wire preview-evo-wire-forme" d={link.d} />
                            : <path key={i} className="preview-evo-wire" d={link.d} markerEnd={`url(#${markerId})`} />)}
                    </svg>
                    {model.links.filter((l: any) => l.label).map((l: any, i: number) => (
                        <span key={i} className="preview-evo-method" style={{ left: l.labelAt.x, top: l.labelAt.y }}>{l.label}</span>
                    ))}
                    {model.entries.map((e: any) => <EvoNode key={e.id} entry={e} />)}
                </div>
            </div>
        </div>
    );
}

export function FormeTabs() {
    const tabs: any[] = api.previewFormeTabs();
    if (!tabs.length) return null;
    return (
        <div className="preview-forme-tabs">
            {tabs.map(t => {
                const clickable = !t.active && t.kind === 'fakemon' && t.refId;
                return (
                    <button key={t.id} type="button" className={`preview-forme-tab${t.active ? ' active' : ''}`} disabled={t.active}
                        onClick={clickable ? () => api.editFakemonFromPreview(t.refId) : undefined}>
                        <span className="preview-forme-tab-label">{t.label}</span>
                        <span className="preview-forme-tab-name">{t.name}</span>
                    </button>
                );
            })}
        </div>
    );
}

export function EditorBoard({ id }: { id?: string }) {
    useStore();
    return (
        <PokedexBoard id={id} model={api.boardModel()} formeTabs={<FormeTabs />} evolution={<EvolutionChain />}
            onToggleShiny={() => api.togglePreviewArtworkMode()} />
    );
}
