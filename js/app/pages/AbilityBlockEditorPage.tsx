// The block editor (/ability-editor/<id>): code a custom ability, move or
// item from Scratch-style blocks, with the generated Showdown and Essentials
// code beside it. The AST, the drag system and the compilers stay in
// js/editor/ability-blocks.ts; this draws what it holds.

import { abilityBlockView, allowWorkspaceDrop, closeAbilityBlockEditor, handleWorkspaceDrop, saveAbilityBlockEditor, setAbilityBlockPreviewTab } from '../../editor/ability-blocks.ts';
import { Icon } from '../components/Icon.tsx';
import { AbilityPalette } from '../components/blocks/AbilityPalette.tsx';
import { BlockBoard } from '../components/blocks/BlockBoard.tsx';
import { useStore } from '../store.ts';

export function AbilityBlockEditorPage() {
    useStore();
    const v = abilityBlockView();
    if (!v) return null;
    return (
        <div className="main-layout">
            <div>
                <div className="ability-block-header">
                    <h2 id="ability-block-editor-title">Code "{v.name}"</h2>
                    <div className="ability-block-header-actions">
                        <button className="btn btn-secondary btn-sm" type="button" onClick={() => closeAbilityBlockEditor()}><Icon name="arrow-left" size={14} /> Back</button>
                        <button className="btn btn-primary btn-sm" type="button" onClick={() => saveAbilityBlockEditor()}>Save {v.Noun} Code</button>
                    </div>
                </div>
                <p className="ability-block-intro">Very WIP. Code using coding blocks!</p>
                <div className="ability-block-layout">
                    <div className="ability-block-canvas" id="ability-block-canvas">
                        <div className="ab-board-shell">
                            <aside className="ab-palette"><AbilityPalette kind={v.kind} tables={v.tables} /></aside>
                            <div className="ab-workspace-scroll">
                                <div className="ab-workspace" id="ab-workspace" onDragOver={e => allowWorkspaceDrop(e)} onDrop={e => handleWorkspaceDrop(e)}>
                                    <BlockBoard events={v.events} loose={v.loose} tables={v.tables} />
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="ability-block-preview">
                        <div className="ability-block-preview-tabs">
                            {([['sd', 'Showdown'], ['es', 'Essentials']] as const).map(([tab, label]) => (
                                <button key={tab} type="button" className={`ability-block-tab${v.previewTab === tab ? ' active' : ''}`} onClick={() => setAbilityBlockPreviewTab(tab)}>{label}</button>
                            ))}
                        </div>
                        <pre className="ability-block-code">{v.previewTab === 'sd' ? v.sd : v.es}</pre>
                    </div>
                </div>
            </div>
        </div>
    );
}
