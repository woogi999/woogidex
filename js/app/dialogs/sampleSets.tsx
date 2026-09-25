// Add Sample Set: a blank one, or one of the ideas generated from this
// Fakémon's stats, typing, abilities and learnset (js/editor/sample-sets.ts).

import { useEffect, useState } from 'react';
import { api } from '../../core/app.ts';
import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Modal } from '../components/Modal.tsx';

function SampleSetAddDialog({ close }: DialogProps) {
    const [ideas, setIdeas] = useState<any[] | null>(null);
    useEffect(() => {
        let live = true;
        // the generator is heavy: let the dialog paint its loading line first
        const frame = requestAnimationFrame(() => setTimeout(() => {
            api.suggestedSampleSets().then((sets: any[]) => { if (live) setIdeas(sets || []); });
        }, 0));
        return () => { live = false; cancelAnimationFrame(frame); };
    }, []);
    return (
        <Modal onClose={close} title="Add Sample Set" className="sample-set-add-dialog" labelledBy="sample-set-add-title">
            <button className="btn btn-secondary sample-set-blank-btn" type="button" onClick={() => api.addBlankSampleSet()}>Blank Slate</button>
            <div className="sample-set-ideas">
                <div className="sample-set-ideas-title">Sample Set Ideas</div>
                <p className="sample-set-ideas-help">Based from this Fakemon's data. It's kinda stupid right now but hey, it's better than nothing!</p>
                {ideas === null
                    ? <div className="sample-set-empty-message">Loading sample sets…</div>
                    : !ideas.length
                        ? <div className="sample-set-empty-message">oh nah no sample sets for u unc</div>
                        : ideas.map((set, i) => (
                            <button key={i} type="button" className="suggested-sample-set-card" onClick={() => api.applySuggestedSampleSet(set)}>
                                <div className="suggested-sample-set-title"><strong>{set.name}</strong><span>{set.item}</span></div>
                                <div className="suggested-sample-set-meta">{set.nature} · {api.formatEVSpread(set.evs, set.nature, set)}</div>
                                <div className="suggested-sample-set-moves">{set.moves.join(' · ')}</div>
                                <div className="suggested-sample-set-footer">{set.ability || 'No ability'} · Tera {set.teraType}</div>
                            </button>
                        ))}
            </div>
        </Modal>
    );
}

registerDialog('sample-set-add', SampleSetAddDialog);
