// A published family on the Community Hub board. A post keeps its members
// as a flat list with a stage number and no edges, so the exact branches the
// author drew can't be recovered: members of one stage stack in a column, and
// an arrow is only drawn where the stage actually advances. Clicking a member
// swaps the board to it, without leaving the page.

import { api } from '../../../core/app.ts';
import { ShieldedArt } from '../ShieldedArt.tsx';

function Arrow() {
    return (
        <div className="preview-evo-connector">
            <svg className="preview-evo-arrow-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M3 12h15M12 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        </div>
    );
}

function Card({ entry, activeId, label, compact }: { entry: any; activeId: string; label: string; compact: boolean }) {
    const mon = entry.mon || {};
    const current = entry.sourceId === activeId;
    const props = {
        type: 'button' as const, disabled: current, title: current ? 'Currently viewing' : `View ${mon.name || 'this stage'}`,
        onClick: current ? undefined : () => api.switchCommunityPreviewMon(entry.sourceId)
    };
    if (compact) {
        return (
            <button className={`preview-evo-node preview-evo-node-special${current ? ' current' : ''}`} {...props}>
                <span className="preview-evo-badge">{label}</span>
                <span className="preview-evo-name">{mon.name || 'Unnamed'}</span>
            </button>
        );
    }
    const types = [mon.type1, mon.type2].filter(Boolean);
    const meta = [mon.number, mon.species].filter(Boolean).join(' · ');
    return (
        <button className={`preview-evo-node${current ? ' current' : ''}`} {...props}>
            <span className="preview-evo-stage">{label}</span>
            <div className="preview-evo-sprite-wrap">
                {mon.artwork ? <ShieldedArt src={mon.artwork} alt={`${mon.name || 'Fakémon'} artwork`} /> : <img className="no-art-placeholder" src="assets/no_art_placeholder.png" alt="" />}
            </div>
            <span className="preview-evo-name">{mon.name || 'Unnamed'}</span>
            {meta && <span className="preview-evo-meta">{meta}</span>}
            {types.length > 0 && <span className="preview-evo-types">{types.map((t: string) => <span key={t} className={`type-pill type-${String(t).toLowerCase()}`}>{t}</span>)}</span>}
        </button>
    );
}

export function CommunityEvoStrip({ row, activeId }: { row: any; activeId: string }) {
    const members: any[] = Array.isArray(row?.family_full) ? row.family_full : [];
    if (members.length < 2) return null;
    const stageOf = (m: any) => Math.max(1, m.stage || 1);
    const bases = members.filter(m => !m.isMega && !m.isFormeChange);
    const specials = members.filter(m => m.isMega || m.isFormeChange);
    const stages = [...new Set(bases.map(stageOf))].sort((a, b) => a - b);
    return (
        <div className="board-section board-evolution-chain">
            <div className="board-section-title">Evolution Chain</div>
            <div className="preview-evo-row community-evo-row">
                {stages.map((stage, i) => {
                    const here = bases.filter(m => stageOf(m) === stage);
                    // a split stage swaps to side-by-side cards, and a big one wraps (css/preview-evolution.css)
                    const split = here.length >= 2 ? ` split${here.length > 4 ? ' wrap' : ''}` : '';
                    return (
                        <div key={stage} style={{ display: 'contents' }}>
                            <div className={`community-evo-column${split}`}>
                                {here.map(m => <Card key={m.sourceId} entry={m} activeId={activeId} label={`Stage ${stage}`} compact={false} />)}
                                {/* a Mega/forme sits beside the stage it transforms from */}
                                {specials.filter(m => stageOf(m) === stage).map(m => <Card key={m.sourceId} entry={m} activeId={activeId} label={m.isMega ? 'Mega' : 'Forme'} compact />)}
                            </div>
                            {i < stages.length - 1 && <Arrow />}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
