// The editor's smaller dialogs: Import / Export Moves, Recommended Moves (and
// the Generated Learnset summary it leads to), and the popups that explain a
// move or an ability. The logic is js/editor/editor.ts.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, state } from '../../core/app.ts';
import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Modal } from '../components/Modal.tsx';
import { Icon } from '../components/Icon.tsx';
import { CategoryIcon } from '../components/editor/lists.tsx';

const catClass = (c?: string) => (c === 'Physical' ? 'cat-physical' : c === 'Special' ? 'cat-special' : 'cat-status');
const selectStyle: React.CSSProperties = { padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, fontFamily: "'Exo 2',sans-serif", fontSize: 13 };

// ---- Import / Export Moves ----

function MoveImportExportDialog({ close }: DialogProps) {
    const [sort, setSort] = useState('name');
    const [order, setOrder] = useState('asc');
    const [text, setText] = useState(() => api.getExportableMovesText('name', 'asc'));
    const box = useRef<HTMLTextAreaElement>(null);
    const exportNow = (s = sort, o = order, announce = false) => {
        setText(api.getExportableMovesText(s, o));
        if (!announce) return;
        requestAnimationFrame(() => { box.current?.focus(); box.current?.select(); });
        const count = state.learnset.filter(m => m && m.name).length;
        api.showToast(`Exported ${count} move${count === 1 ? '' : 's'} to the text box.`, 'success');
    };
    return (
        <Modal onClose={close} title="Import / Export Moves" className="move-import-export-dialog" labelledBy="move-io-title">
            <p className="dialog-hint">Import and export your moves here. The selected order is used for both operations.</p>
            <div className="dialog-sort-row">
                <label>Learnset sort</label>
                <select style={{ ...selectStyle, width: 145 }} value={sort} onChange={e => { setSort(e.target.value); exportNow(e.target.value, order); }}>
                    <option value="name">Alphabetical</option>
                    <option value="type">Type</option>
                    <option value="power">Power</option>
                    <option value="category">Category</option>
                    <option value="default">Default</option>
                </select>
                <select style={{ ...selectStyle, width: 105 }} value={order} onChange={e => { setOrder(e.target.value); exportNow(sort, e.target.value); }} aria-label="Order">
                    <option value="asc">Ascending</option>
                    <option value="desc">Descending</option>
                </select>
            </div>
            <textarea ref={box} className="move-import-export-text" spellCheck={false} autoFocus value={text} placeholder={'Absorb\nAcid Armor\nAerial Ace\n...'} onChange={e => setText(e.target.value)} />
            <div className="dialog-actions">
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => exportNow(sort, order, true)}>Export Current Moves</button>
                <button className="btn btn-primary btn-sm" type="button" onClick={() => { const next = api.importMovesFromText(text, { sort, order }); if (next != null) setText(next); }}>Import Moves</button>
                <button className="btn btn-secondary btn-sm" type="button" onClick={close}>Cancel</button>
            </div>
        </Modal>
    );
}

// ---- Recommended Moves ----

function RecommendMovesDialog({ close }: DialogProps) {
    const [version, setVersion] = useState(0);
    const [recs, setRecs] = useState(() => api.moveRecommendations());
    useEffect(() => { if (version) setRecs(api.moveRecommendations()); }, [version]);
    return (
        <Modal onClose={close} title="Recommended Moves" className="recommend-moves-dialog" labelledBy="recommend-title">
            <p className="dialog-hint">Based on this Fakemon's typing and stat spread. Click a move to add it to the learnset.</p>
            <button className="btn btn-secondary btn-sm recommend-generate" type="button" onClick={() => api.generateLearnset()}>Generate Learnset</button>
            <p className="dialog-hint small">Too lazy to think of a proper moveset? I got you! It finds real Pokémon similar to this Fakemon's data and builds a learnset from their actual movesets. Moves you've already added are adjusted accordingly.</p>
            {recs.needsType
                ? <p className="dialog-empty">Set a primary type first so we can suggest moves.</p>
                : !recs.sections.length
                    ? <p className="dialog-empty">No new suggestions - looks like your learnset already covers the basics!</p>
                    : recs.sections.map((sec: any) => (
                        <div key={sec.label}>
                            <div className="recommend-section-label">{sec.label}</div>
                            {sec.moves.map(({ move, reason }: any) => (
                                <div key={move.name} className="recommend-move-item" role="button" tabIndex={0} onClick={() => { api.selectRecommendedMove(move.name); setVersion(v => v + 1); }}>
                                    <div>
                                        <div className="move-name">{move.name}</div>
                                        <div className="move-why">{reason}</div>
                                    </div>
                                    <div className="meta-right">
                                        <span className={`type-pill type-${String(move.type || 'normal').toLowerCase()}`}>{move.type}</span>
                                        <span className={`cat-pill ${catClass(move.category)}`}><CategoryIcon category={move.category} size={14} /></span>
                                        <span className="power-text">{move.basePower || '-'}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ))}
        </Modal>
    );
}

function methodLabel(method: string, level: number | null) {
    if (method === 'level') return `Lv.${level ?? '?'}`;
    if (method === 'tm') return 'TM';
    if (method === 'egg') return 'Egg';
    return method || '-';
}

function GeneratedLearnsetDialog({ added, woven, similar, close }: DialogProps<{ added: any[]; woven: any[]; similar: string }>) {
    const byLevelThenName = (a: any, b: any) => (a.learnMethod === 'level' && b.learnMethod === 'level' ? (a.level || 0) - (b.level || 0) : a.move.name.localeCompare(b.move.name));
    const grid = (rows: any[]) => (
        <div className="gl-grid">
            {[...rows].sort(byLevelThenName).map(({ move, learnMethod, level }) => (
                <div key={move.name} className="gl-item" role="button" tabIndex={0} onClick={() => api.showMoveDetail(move.name)}>
                    <span className={`type-pill type-${String(move.type || 'normal').toLowerCase()}`}>{move.type}</span>
                    <span className="move-name">{move.name}</span>
                    <div className="move-meta">
                        <span className={`cat-pill ${catClass(move.category)}`}><CategoryIcon category={move.category} size={12} /></span>
                        <span className="method-text">{methodLabel(learnMethod, level)}</span>
                    </div>
                </div>
            ))}
        </div>
    );
    return (
        <Modal onClose={close} title="Generated Learnset" className="generated-learnset-dialog" labelledBy="generated-title">
            <p className="dialog-hint">Based on Pokémon like {similar}.</p>
            {added.length > 0 && <><div className="gl-section-label">Added ({added.length})</div>{grid(added)}</>}
            {woven.length > 0 && <><div className="gl-section-label">Updated Existing Moves ({woven.length})</div>{grid(woven)}</>}
        </Modal>
    );
}

// ---- move and ability popups ----

/** The small centred popup the old editor used for details, with its fade and scale. */
function DetailPopup({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
    const [shown, setShown] = useState(false);
    const closeRef = useRef(close);
    closeRef.current = close;
    const leave = () => { setShown(false); setTimeout(() => closeRef.current(), 150); };
    useEffect(() => {
        // two frames, so the hidden state paints first and the transition runs
        let b = 0;
        const a = requestAnimationFrame(() => { b = requestAnimationFrame(() => setShown(true)); });
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); setShown(false); setTimeout(() => closeRef.current(), 150); } };
        document.addEventListener('keydown', key);
        return () => { cancelAnimationFrame(a); cancelAnimationFrame(b); document.removeEventListener('keydown', key); };
    }, []);
    return createPortal(
        <>
            <div className={`overlay-dark${shown ? ' active' : ''}`} onClick={leave} />
            <div className={`move-detail-popup${shown ? ' active' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
                <div className="detail-popup-head">
                    <h3>{title}</h3>
                    <button className="modal-close" type="button" aria-label="Close" onClick={leave}><Icon name="x" size={20} /></button>
                </div>
                {children}
            </div>
        </>,
        document.getElementById('react-dialogs') || document.body
    );
}

function MoveDetailDialog({ name, close }: DialogProps<{ name: string }>) {
    const d = api.moveDetail(name);
    if (!d) return null;
    const row = (label: string, value: ReactNode) => <div className="detail-row"><span className="detail-label">{label}</span><span className="detail-value">{value}</span></div>;
    return (
        <DetailPopup title={d.name} close={close}>
            {row('Type', <span className={`type-pill type-${d.type.toLowerCase()}`}>{d.type}</span>)}
            {row('Category', <><CategoryIcon category={d.category} size={16} /> {d.category}</>)}
            {row('Base Power', d.basePower)}
            {row('Accuracy', d.accuracy)}
            {row('PP', d.pp)}
            {row('Priority', d.priority)}
            {d.flags.length > 0 && <div className="detail-flags">{d.flags.map((f: string) => <span key={f} className="flag-tidbit">{f}</span>)}</div>}
            <div className="desc-text">{d.desc}</div>
        </DetailPopup>
    );
}

function TextDetailDialog({ title, text, close }: DialogProps<{ title: string; text: string }>) {
    return <DetailPopup title={title} close={close}><div className="desc-text">{text}</div></DetailPopup>;
}

registerDialog('move-import-export', MoveImportExportDialog);
registerDialog('recommend-moves', RecommendMovesDialog);
registerDialog('generated-learnset', GeneratedLearnsetDialog);
registerDialog('move-detail', MoveDetailDialog);
registerDialog('detail', TextDetailDialog);
