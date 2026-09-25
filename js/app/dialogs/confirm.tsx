// "Are you sure?", as asked by confirmDialog() in js/core/confirm-dialog.ts.
// The safe answer comes first and takes the focus, so a stray Enter doesn't
// delete anything; Escape and a click beside the box also mean no.

import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Modal } from '../components/Modal.tsx';
import { Icon } from '../components/Icon.tsx';

interface ConfirmProps {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    danger: boolean;
    answer: (yes: boolean) => void;
}

function ConfirmDialog({ close, title, message, confirmLabel, cancelLabel, danger, answer }: DialogProps<ConfirmProps>) {
    const reply = (yes: boolean) => { close(); answer(yes); };
    return (
        <Modal onClose={() => reply(false)} className={`confirm-dialog${danger ? ' is-danger' : ''}`} overlayClassName="confirm-dialog-overlay" labelledBy="confirm-dialog-title">
            <div className="confirm-dialog-icon" aria-hidden="true"><Icon name={danger ? 'trash-2' : 'info'} size={22} /></div>
            <h3 id="confirm-dialog-title">{title}</h3>
            {message && <p>{message}</p>}
            <div className="confirm-dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={() => reply(false)}>{cancelLabel}</button>
                <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => reply(true)}>{confirmLabel}</button>
            </div>
        </Modal>
    );
}

registerDialog('confirm', ConfirmDialog);
