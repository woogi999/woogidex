// The cloud backup picker, in two modes: choosing what the backup should
// hold, and choosing what to bring back from it. One tab per kind of thing a
// backup can hold; the ticks are shared across tabs so the total and the
// meters always show. State and rules: js/features/cloud-save.ts.

import { api } from '../../core/app.ts';
import { cloudBackupPicker } from '../../features/cloud-save.ts';
import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Modal } from '../components/Modal.tsx';
import { Icon } from '../components/Icon.tsx';
import { CloudMeters } from '../components/CloudMeters.tsx';
import { useStore } from '../store.ts';

function CloudBackupDialog(_: DialogProps) {
    useStore();
    const v = cloudBackupPicker();
    const close = () => api.closeCloudBackupModal();
    const count = (n: number, cap: number) => `${n}${cap === Infinity ? '' : `/${cap}`}`;
    return (
        <Modal onClose={close} className="community-update-modal cloud-backup-modal" labelledBy="cloud-backup-title">
            <div className="modal-header">
                <div><h3 id="cloud-backup-title">{v.uploading ? 'Choose what to back up' : 'Choose what to restore'}</h3></div>
                <button className="modal-close" type="button" onClick={close} aria-label="Close"><Icon name="x" size={20} /></button>
            </div>
            <div className="modal-body community-update-modal-body">
                <p className="community-update-help">{v.help}</p>
                {/* only upload previews the cost; in restore mode the ticks are about this device */}
                {!v.loading && <CloudMeters items={v.uploading ? v.total : null} regions={v.uploading ? v.regionCount : null} />}
                {!v.loading && (
                    <div className="tabs cloud-backup-tabs">
                        {v.tabs.map(t => (
                            <button key={t.key} type="button" className={`tab${t.active ? ' active' : ''}`} disabled={!t.available || t.blocked}
                                title={t.blocked ? 'Region backup isn’t available on your account' : undefined} onClick={() => api.switchCloudBackupKind(t.key)}>
                                {t.label}<span className="cloud-tab-count">{t.picked}/{t.available}</span>
                            </button>
                        ))}
                    </div>
                )}
                <div className="community-update-controls">
                    <div className="community-update-search-wrap">
                        <Icon name="search" />
                        {/* keyed by tab: each tab has its own search */}
                        <input key={v.kind} type="search" placeholder={v.searchPlaceholder} defaultValue={v.search} onChange={e => api.filterCloudBackupModal(e.target.value)} aria-label="Search" />
                    </div>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.selectAllCloudBackupMons()}>Select all</button>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.clearCloudBackupSelection()}>Clear</button>
                </div>
                <div className="cloud-pick-grid">
                    {v.loading ? <div className="cloud-pick-empty">Loading your backup...</div>
                        : !v.entries.length ? <div className="cloud-pick-empty">{v.empty}</div>
                            : v.entries.map((e: any) => (
                                <button key={e.id} type="button" className={`cloud-pick-card${e.picked ? ' selected' : ''}`} aria-pressed={e.picked} onClick={() => api.toggleCloudBackupMon(e.id)}>
                                    <span className="cloud-pick-check"><Icon name={e.picked ? 'check' : 'plus'} size={12} /></span>
                                    <span className={`cloud-pick-art${e.artwork === null ? ' cloud-pick-art-icon' : ''}`}>
                                        {e.artwork === null
                                            ? <Icon name={e.icon} size={18} style={e.color ? { color: e.color } : undefined} />
                                            : e.artwork ? <img src={e.artwork} alt={e.name} loading="lazy" decoding="async" /> : <img className="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork" />}
                                    </span>
                                    <span className="cloud-pick-info">
                                        <strong>{e.name}</strong>
                                        <span>{e.subtitle}</span>
                                        {e.note && <span className={`cloud-pick-note ${e.note.tone}`.trim()}>{e.note.text}</span>}
                                    </span>
                                </button>
                            ))}
                </div>
                <div className="community-update-actions">
                    <div className="community-update-selected">
                        {v.uploading
                            ? <>{v.parts.join(' + ') || 'No items'} = <strong className={v.itemsOver ? 'cloud-over-limit' : ''}>{count(v.total, v.cap)}</strong>
                                {v.regionCount > 0 && <>, <strong className={v.regionsOver ? 'cloud-over-limit' : ''}>{count(v.regionCount, v.regionCap)} region{v.regionCount === 1 ? '' : 's'}</strong></>}</>
                            : <>{v.parts.join(' + ') || (v.regionCount ? '' : 'Nothing selected')}{v.regionCount > 0 && `${v.parts.length ? ' + ' : ''}${v.regionCount} region${v.regionCount === 1 ? '' : 's'}`}</>}
                    </div>
                    <div className="community-update-action-buttons">
                        <button className="btn btn-secondary" type="button" onClick={close}>Cancel</button>
                        <button className="btn btn-primary" type="button" disabled={v.loading || !v.canConfirm} onClick={() => api.confirmCloudBackupModal()}>
                            <Icon name={v.uploading ? 'cloud-upload' : 'cloud-download'} size={14} /> {v.uploading ? 'Save backup' : 'Restore selected'}
                        </button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

registerDialog('cloud-backup', CloudBackupDialog);
