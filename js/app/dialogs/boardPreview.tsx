// Quick Preview: a collection card's Pokédex board, without opening the
// editor. The Fakémon is loaded into the (hidden) editor first, so this draws
// the same board the editor's Preview tab does.

import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Modal } from '../components/Modal.tsx';
import { EditorBoard } from '../components/board/EditorBoard.tsx';

function BoardPreviewDialog({ onEdit, close }: DialogProps<{ onEdit: () => void }>) {
    return (
        <Modal onClose={close} title="Quick Preview" className="quick-preview-modal" labelledBy="quick-preview-title">
            <div className="preview-modal-board-wrap"><EditorBoard /></div>
            <div className="quick-preview-actions">
                <button className="btn btn-primary" type="button" onClick={() => { close(); onEdit(); }}>Edit Fakemon</button>
            </div>
        </Modal>
    );
}

registerDialog('board-preview', BoardPreviewDialog);
