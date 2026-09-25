// Settings, as its own page (/settings): appearance, editor & tools,
// account and data.

import { useEffect, useState, type ReactNode } from 'react';
import { api, state } from '../../core/app.ts';
import { Icon } from '../components/Icon.tsx';
import {
    ACCOUNT_DELETION_GRACE_DAYS, accountDeletionDueAt, cancelAccountDeletion, formatDue, openDeleteAccountModal
} from '../../features/account-deletion.ts';
import {
    cloudState, deleteCloudBackup, isAutoBackupOn, openCloudBackupModal, refreshCloudBackupUI, setCloudAutoBackup
} from '../../features/cloud-save.ts';
import { CloudMeters } from '../components/CloudMeters.tsx';
import { ConnectedAccounts } from '../components/ConnectedAccounts.tsx';
import { useStore, useViewShown } from '../store.ts';

type Tab = 'appearance' | 'editor' | 'account' | 'data';

/** A boolean setting: its name in app.ts's BOOLEAN_SETTINGS (get<Name>/toggle<Name>). */
interface ToggleSpec { setting: string; label: string; desc: string; }

const APPEARANCE: ToggleSpec[] = [
    { setting: 'ReduceMotion', label: 'Reduce motion', desc: 'Turn off animations and transitions across the site.' },
    { setting: 'OverlayBlur', label: 'Blur & dim effects', desc: 'Darken and blur the page behind the sidebar, modals, and other overlays.' },
    { setting: 'Use2DSprites', label: 'Use 2D sprites', desc: 'Show flat sprites instead of animated 3D models.' }
];
const COLLECTION: ToggleSpec[] = [
    { setting: 'ShowCollectionCardDate', label: 'Show creation date on cards', desc: 'Display when each Fakemon was created on its collection card.' },
    { setting: 'AlwaysShowCardActions', label: 'Always show card action buttons', desc: 'Keep pin, edit, export and delete visible on every card instead of only on hover.' }
];
const EDITOR: ToggleSpec[] = [
    { setting: 'FadeUselessMoves', label: 'Fade out usually useless moves', desc: 'Dim moves in the movepool that rarely see competitive use.' },
    { setting: 'AutoplayCry', label: 'Autoplay Pokemon cry', desc: "Play a Fakemon's uploaded cry automatically when you open it to edit or preview." },
    { setting: 'ConfirmBeforeDelete', label: 'Confirm before deleting a Fakemon', desc: 'Ask "Are you sure?" before a delete goes through. Turn off to delete in one click.' }
];
const COMPARISON: ToggleSpec[] = [
    { setting: 'IncludeOwnFakemonsInBulkComparison', label: 'Include own Fakemon in Bulk Comparison', desc: 'Let your own collection show up alongside official Pokemon.' },
    { setting: 'IncludeOwnFakemonsInRecommendedMoves', label: 'Include own Fakemon in Recommended Moves', desc: 'Factor your own collection into move recommendations.' }
];

export function SettingsPage() {
    useStore();
    const opened = useViewShown('settings-view');
    const [tab, setTab] = useState<Tab>('appearance');
    const signedIn = !!state.user;

    // every visit starts on the tab it was opened with, and refetches what the
    // server knows (the backup, the connections) since it may have changed
    useEffect(() => {
        if (!opened) return;
        setTab((api.takeSettingsTab?.() as Tab) || 'appearance');
        if (state.user) {
            refreshCloudBackupUI();
            api.updateConnectedAccountsUI?.();
        }
    }, [opened]);

    // the Account tab goes away on sign-out
    const shownTab: Tab = tab === 'account' && !signedIn ? 'appearance' : tab;
    const tabs: Array<[Tab, string]> = [['appearance', 'Appearance'], ['editor', 'Editor & Tools'], ...(signedIn ? [['account', 'Account'] as [Tab, string]] : []), ['data', 'Data']];

    return (
        <div className="settings-page-shell">
            <div className="settings-page-header">
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.showCollection()}>
                    <Icon name="arrow-left" size={14} /> Back
                </button>
                <h2>Settings</h2>
            </div>

            <div className="panel settings-page-panel">
                <div className="tabs" role="tablist">
                    {tabs.map(([key, label]) => (
                        <button key={key} className={`tab${shownTab === key ? ' active' : ''}`} type="button" role="tab"
                            aria-selected={shownTab === key} onClick={() => setTab(key)}>{label}</button>
                    ))}
                </div>

                {shownTab === 'appearance' && (
                    <div className="tab-content settings-list" style={{ display: 'flex' }}>
                        <Group title="Look & feel">
                            <Toggle label="Dark mode" desc="Switch the whole site to a dark color scheme."
                                checked={!!api.isDarkModeEnabled?.()} onChange={() => api.toggleDarkMode()} />
                            {APPEARANCE.map(spec => <SettingToggle key={spec.setting} spec={spec} />)}
                        </Group>
                        <Group title="Collection">
                            {COLLECTION.map(spec => <SettingToggle key={spec.setting} spec={spec} />)}
                        </Group>
                    </div>
                )}

                {shownTab === 'editor' && (
                    <div className="tab-content settings-list" style={{ display: 'flex' }}>
                        <Group title="Editor">{EDITOR.map(spec => <SettingToggle key={spec.setting} spec={spec} />)}</Group>
                        <Group title="Comparison tools">{COMPARISON.map(spec => <SettingToggle key={spec.setting} spec={spec} />)}</Group>
                    </div>
                )}

                {shownTab === 'account' && signedIn && (
                    <div className="tab-content settings-list" style={{ display: 'flex' }}>
                        <Group title="Profile">
                            <Row label="Edit your profile" desc="Change your display name, bio, avatar, username and badges.">
                                <button type="button" className="btn btn-secondary btn-sm" onClick={() => api.showProfileView(null, { edit: true })}>Edit Profile</button>
                            </Row>
                        </Group>
                        <Group title="Security">
                            <Row label="Password" desc="Change the password you use to sign in with your username or email.">
                                <button type="button" className="btn btn-secondary btn-sm" onClick={() => api.openChangePasswordModal()}>Change Password</button>
                            </Row>
                        </Group>
                        <ConnectedAccounts />
                        <AccountDeletionGroup />
                    </div>
                )}

                {shownTab === 'data' && (
                    <div className="tab-content settings-list" style={{ display: 'flex' }}>
                        <Group title="Data">
                            <Row label="Check for lost Fakemon" desc={<>Compares your collection against this device&rsquo;s backup copies and restores anything missing. If nothing is missing here and you are signed in, it opens your cloud backup so you can check that too.</>}>
                                <button type="button" className="btn btn-secondary btn-sm" onClick={() => api.manualCheckForLostFakemon()}>Check Now</button>
                            </Row>
                            <Row label="Export your collection" desc={<>Download every Fakemon you own as a backup file you can re-import later. Available from My Collection &rarr; Export Collection.</>}>
                                <button type="button" className="btn btn-secondary btn-sm" onClick={() => api.showCollection()}>Go to Collection</button>
                            </Row>
                        </Group>
                        {signedIn && <CloudBackupGroup />}
                    </div>
                )}
            </div>
        </div>
    );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="settings-group">
            <div className="settings-group-title"><span>{title}</span></div>
            {children}
        </div>
    );
}

function Row({ label, desc, children }: { label: string; desc: ReactNode; children?: ReactNode }) {
    return (
        <div className="settings-row settings-row-static">
            <span className="settings-row-text">
                <span className="settings-label">{label}</span>
                <span className="settings-desc">{desc}</span>
            </span>
            {children}
        </div>
    );
}

function Toggle({ label, desc, checked, onChange, extra }: { label: string; desc: ReactNode; checked: boolean; onChange: (on: boolean) => void; extra?: ReactNode }) {
    return (
        <label className="settings-row">
            <span className="settings-row-text">
                <span className="settings-label">{label}</span>
                <span className="settings-desc">{desc}</span>
                {extra}
            </span>
            <span className="settings-switch-wrap">
                <input className="settings-toggle-input" type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
                <span className="settings-toggle-slider" />
            </span>
        </label>
    );
}

function SettingToggle({ spec }: { spec: ToggleSpec }) {
    return (
        <Toggle label={spec.label} desc={spec.desc} checked={!!api[`get${spec.setting}`]?.()}
            onChange={on => api[`set${spec.setting}`]?.(on)} />
    );
}

function AccountDeletionGroup() {
    const due: Date | null = accountDeletionDueAt();
    return (
        <Group title="Danger Zone">
            <Row label="Delete account" desc={due
                ? `This account is scheduled for permanent deletion on ${formatDue(due)}. Cancel any time before then and nothing is lost.`
                : `Permanently delete your account and everything on it. Nothing is destroyed for ${ACCOUNT_DELETION_GRACE_DAYS} days, so you can change your mind.`}>
                {due
                    ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => cancelAccountDeletion()}>Cancel Deletion</button>
                    : <button type="button" className="btn btn-danger btn-sm" onClick={() => openDeleteAccountModal()}>Delete Account</button>}
            </Row>
        </Group>
    );
}

function CloudBackupGroup() {
    const cs = cloudState();
    const autoOn = isAutoBackupOn();
    return (
        <Group title="Cloud Backup">
            <div className="settings-row settings-row-static">
                <CloudMeters className="cloud-meters settings-cloud-meters" />
            </div>
            <div className="settings-row settings-row-static">
                <span className="settings-row-text">
                    <span className="settings-label">Back up to your account</span>
                    <span className="settings-desc">Keep a private copy of your collection on our server so you can get it back on a new device or after clearing your browser. Only you can see it, and it is separate from publishing to the community hub. You choose exactly which Fakémon, moves, abilities, items and regions go in, up to the allowance shown above.</span>
                    <span className="settings-desc">
                        {cs.savedAt
                            ? `Last backed up ${new Date(cs.savedAt).toLocaleString()} - ${cs.byId.size} Fakemon stored.`
                            : (cs.loaded ? 'No cloud backup yet.' : 'Checking your cloud backup...')}
                    </span>
                </span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => openCloudBackupModal('upload')}>Choose &amp; Back Up</button>
            </div>
            <Row label="Restore from your backup" desc="Copies the entries you tick onto this device. Anything already here is left alone unless you tick it, in which case the backed-up version replaces it. Nothing is ever deleted.">
                <button type="button" className="btn btn-secondary btn-sm" disabled={!cs.savedAt} onClick={() => openCloudBackupModal('restore')}>Choose &amp; Restore</button>
            </Row>
            {/* only for accounts a badge allows it, while the site-wide switch is on */}
            {cs.limits.autoBackup && (
                <Toggle label="Keep my backup up to date automatically"
                    desc="Re-uploads the entries you already picked whenever you edit them, a few minutes after you stop. It never adds anything you did not choose, and a Fakémon you delete here does leave the backup, so it is a mirror of your picks rather than a second collection."
                    checked={autoOn} onChange={on => setCloudAutoBackup(on)}
                    extra={autoOn && <span className="settings-desc">{cs.savedAt
                        ? 'On. Your picks are kept current.'
                        : 'On, but there is nothing to keep current yet. Back something up once and it will take over from there.'}</span>} />
            )}
            {cs.savedAt && (
                <Row label="Delete your backup" desc="Removes the copy stored on our server. Your collection on this device is untouched.">
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => deleteCloudBackup()}>Delete Backup</button>
                </Row>
            )}
        </Group>
    );
}
