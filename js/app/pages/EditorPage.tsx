// The Fakémon editor: a sheet that slides in from the right over My
// Collection (activateTopLevelView keeps the collection showing underneath).
// The form is js/editor/draft.ts; the live Pokédex board is the Preview tab,
// rendered even while hidden because Export as PNG and the Community Hub
// copy it.
//
// Every tab stays mounted and is only hidden, as before: the boards and lists
// other modules draw into (abilities, learnset, evolution, sample sets,
// analysis, the preview board) keep their contents between visits.

import { useState } from 'react';
import { api } from '../../core/app.ts';
import { editForm, form } from '../../editor/draft.ts';
import { Icon } from '../components/Icon.tsx';
import { RegionAssign } from '../components/RegionAssign.tsx';
import { useClickAway } from '../components/editor/fields.tsx';
import { BasicTab } from '../components/editor/BasicTab.tsx';
import { StatsTab } from '../components/editor/StatsTab.tsx';
import { MovesTab } from '../components/editor/MovesTab.tsx';
import { AnalysisTab } from '../components/editor/AnalysisTab.tsx';
import { EditorBoard } from '../components/board/EditorBoard.tsx';
import '../dialogs/boardPreview.tsx';
import '../dialogs/libraryEditors.tsx';
import '../dialogs/moveBrowser.tsx';
import '../dialogs/editorTools.tsx';
import '../dialogs/exports.tsx';
import { useStore } from '../store.ts';

type Tab = 'basic' | 'stats' | 'moves' | 'analysis' | 'preview';
// short names on phones, so all five fit without scrolling sideways
const TABS: Array<[Tab, string, string]> = [
    ['basic', 'Basic Info', 'Basics'], ['stats', 'Stats, Abilities, & Evos', 'Stats'], ['moves', 'Moves & Sets', 'Moves'], ['analysis', 'Analysis', 'Analysis']
];

const EXPORTS: Array<[string, () => void]> = [
    ['Export as PNG', () => api.exportAsPNG()],
    ['Export as Plain Text', () => api.openPlainTextExportModal()],
    ['Export as JSON', () => api.exportAsJSON()],
    ['Export as Showdown Mod', () => api.exportShowdownMod()],
    ['Export as Essentials Mod', () => api.exportEssentialsMod()]
];

function ExportMenu() {
    const [open, setOpen] = useState(false);
    const ref = useClickAway(open, () => setOpen(false));
    return (
        <div className="export-as-wrap" ref={ref}>
            <button className="btn btn-primary btn-sm" type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}><Icon name="download" /><span>Export</span></button>
            {open && (
                <div className="export-as-menu" style={{ display: 'block' }}>
                    {EXPORTS.map(([label, run]) => (
                        <button key={label} className="export-as-menu-item" type="button" onClick={() => { setOpen(false); run(); }}>{label}</button>
                    ))}
                </div>
            )}
        </div>
    );
}

/** A tab's panel: always mounted, shown when it's the current tab (and animated in). */
function Panel({ tab, current, className = '', children }: { tab: Tab; current: Tab; className?: string; children?: React.ReactNode }) {
    const on = tab === current;
    return (
        <div id={`tab-${tab}`} className={`tab-content${on ? ' tab-content-enter' : ''}${className ? ` ${className}` : ''}`} style={{ display: on ? 'block' : 'none' }}>
            {children}
        </div>
    );
}

export function EditorPage() {
    useStore();
    const tab: Tab = api.getEditorTab();
    return (
        <div className="editor-sheet" role="dialog" aria-labelledby="editor-sheet-title">
            <div className="editor-sheet-head">
                <button className="btn btn-secondary btn-icon btn-sm editor-sheet-close" type="button" onClick={() => api.showCollection()} aria-label="Close the editor" title="Close (Esc)"><Icon name="x" /></button>
                <div className="editor-sheet-heading">
                    <h2 className="editor-sheet-title" id="editor-sheet-title">{form.name.trim() || 'New Fakémon'}</h2>
                    <RegionAssign value={form.regionIds} onChange={regionIds => { editForm({ regionIds }); api.renderRegionSidebar(); }} />
                </div>
                <div className="editor-actionbar-group">
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.publishCurrentEditorFakemon()}><Icon name="upload" /><span>Publish</span></button>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openFakemonImport()}><Icon name="file-input" /><span>Import</span></button>
                    <ExportMenu />
                    <input type="file" id="fakemon-import-file" accept=".json,.txt,application/json,text/plain" style={{ display: 'none' }} onChange={e => api.handleFakemonImport(e)} />
                </div>
            </div>

            <div className="tabs editor-tabs" role="tablist" aria-label="Editor sections">
                {TABS.map(([key, long, short]) => (
                    <button key={key} className={`tab${tab === key ? ' active' : ''}`} type="button" role="tab" aria-selected={tab === key} onClick={() => api.switchTab(null, key)}>
                        <span className="tab-long">{long}</span><span className="tab-short">{short}</span>
                    </button>
                ))}
                <button className={`tab editor-preview-tab${tab === 'preview' ? ' active' : ''}`} type="button" role="tab" aria-selected={tab === 'preview'} onClick={() => api.switchTab(null, 'preview')}>
                    <Icon name="eye" /><span>Preview</span>
                </button>
            </div>

            <div className="editor-sheet-body editor-form-col">
                <Panel tab="analysis" current={tab}><AnalysisTab /></Panel>
                <Panel tab="basic" current={tab}><BasicTab /></Panel>
                <Panel tab="stats" current={tab}><StatsTab /></Panel>
                <Panel tab="moves" current={tab}><MovesTab /></Panel>
                {/* the live board: Export as PNG captures it, so it's drawn even while hidden */}
                <Panel tab="preview" current={tab} className="editor-preview-pane"><div id="pokedex-board-container"><EditorBoard id="pokedex-board-export" /></div></Panel>
            </div>
        </div>
    );
}
