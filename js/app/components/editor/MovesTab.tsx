// The editor's Moves & Sets tab: the learnset (filters, rows, adding moves,
// the breakdown chart) and the sample sets.

import { api } from '../../../core/app.ts';
import { AddMoveRow, LearnsetChart, LearnsetFilters, LearnsetList } from './lists.tsx';
import { SampleSets } from './SampleSets.tsx';
import '../../dialogs/sampleSets.tsx';

export function MovesTab() {
    return (
        <>
            <div className="form-group">
                <label>Learnset</label>
                <p className="field-hint">Add your moves here!</p>
                <LearnsetFilters />
                <LearnsetList />
                <AddMoveRow />
                <div className="learnset-actions" style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openCustomMoveChooser()}>+ Add Custom Move</button>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.addUniversalMoves()}>+ Add Universal Moves</button>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openMoveImportExportModal()}>Import / Export Moves</button>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openRecommendMovesModal()}>Recommend Moves</button>
                    <button className="btn btn-danger btn-sm" type="button" onClick={() => api.clearMoveset()} style={{ marginLeft: 'auto' }}>Clear Moveset</button>
                </div>
                <LearnsetChart />
            </div>
            <div className="section-divider" />
            <div className="form-group">
                <label>Sample Sets</label>
                <p className="field-hint">Build competitive sets in Showdown export format</p>
                <SampleSets />
                <button className="sample-set-add" type="button" onClick={() => api.addSampleSet()}>+ Add Sample Set</button>
            </div>
        </>
    );
}
