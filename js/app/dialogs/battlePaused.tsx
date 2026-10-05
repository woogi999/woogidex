// Battle is switched off while a new simulator is built: the Battle tab, the
// /battle route and search all open this instead (api.openBattle in js/core/app.ts).

import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Modal } from '../components/Modal.tsx';
import { Icon } from '../components/Icon.tsx';

function BattlePausedDialog({ close }: DialogProps) {
    return (
        <Modal onClose={close} className="confirm-dialog" overlayClassName="confirm-dialog-overlay" labelledBy="battle-paused-title">
            <div className="confirm-dialog-icon" aria-hidden="true"><Icon name="swords" size={22} /></div>
            <h3 id="battle-paused-title">Battles are taking a break</h3>
            <p>The current battle simulator is too buggy to be fun, so I've switched it off. I'm building a better one from the ground up and will bring battles back when it's ready.</p>
            <div className="confirm-dialog-actions">
                <button type="button" className="btn btn-primary" onClick={close}>Got it</button>
            </div>
        </Modal>
    );
}

registerDialog('battle-paused', BattlePausedDialog);
