// Settings, as its own page (/settings). A navigation column (search, who
// you are, the four sections) beside the open section; on a phone the
// navigation is its own screen and a section slides in over it, the way
// phone settings apps work. Styles: css/settings.css.

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { api, state } from '../../core/app.ts';
import { isLowEndDevice } from '../../core/device.ts';
import { Icon } from '../components/Icon.tsx';
import { Avatar } from '../components/Avatar.tsx';
import {
    ACCOUNT_DELETION_GRACE_DAYS, accountDeletionDueAt, cancelAccountDeletion, formatDue, openDeleteAccountModal
} from '../../features/account-deletion.ts';
import {
    cloudState, deleteCloudBackup, isAutoBackupOn, openCloudBackupModal, refreshCloudBackupUI, setCloudAutoBackup
} from '../../features/cloud-save.ts';
import { CloudMeters } from '../components/CloudMeters.tsx';
import { ConnectedAccounts } from '../components/ConnectedAccounts.tsx';
import { useStore, useViewShown } from '../store.ts';
import { NOTIFICATION_KINDS, notificationPrefs, setNotificationPref } from '../../core/notifications.ts';

type SectionKey = 'appearance' | 'editor' | 'notifications' | 'account' | 'data';

/**
 * One row. `setting` names a boolean in app.ts's BOOLEAN_SETTINGS (it gets a
 * switch); otherwise `control` draws whatever sits on the right.
 */
interface Item {
    id: string;
    label: string;
    desc: ReactNode;
    /** what search matches, when `desc` isn't plain text */
    text?: string;
    setting?: string;
    control?: () => ReactNode;
    tone?: 'danger';
}

/** A titled group of rows, or a group that draws itself (`render`). */
interface Group {
    id: string;
    title: string;
    desc?: () => ReactNode;
    items?: Item[];
    render?: () => ReactNode;
    /** extra words search should find a self-drawn group by */
    keywords?: string;
    when?: () => boolean;
}

interface Section {
    key: SectionKey;
    label: string;
    blurb: string;
    groups: Group[];
    when?: () => boolean;
}

const signedIn = () => !!state.user;

const SECTIONS: Section[] = [
    {
        key: 'appearance', label: 'Appearance',
        blurb: 'Theme, motion, and how your collection looks.',
        groups: [
            { id: 'theme', title: 'Theme', render: () => <ThemePicker />, keywords: 'theme dark mode light mode colors night' },
            {
                id: 'effects', title: 'Motion & effects',
                desc: () => isLowEndDevice()
                    ? 'This device looks low-powered, so blur starts off and flat sprites start on to keep things smooth. Change them whenever you like.'
                    : null,
                items: [
                    { id: 'motion', setting: 'ReduceMotion', label: 'Reduce motion', desc: 'Turn off animations and transitions across the site.' },
                    { id: 'blur', setting: 'OverlayBlur', label: 'Blur & dim effects', desc: 'Darken and blur the page behind the sidebar, modals, and other overlays.' },
                    { id: 'sprites', setting: 'Use2DSprites', label: 'Use 2D sprites', desc: 'Show flat sprites instead of animated 3D models. Lighter on older phones.' }
                ]
            },
            {
                id: 'cards', title: 'Collection cards',
                items: [
                    { id: 'date', setting: 'ShowCollectionCardDate', label: 'Show creation date on cards', desc: 'Display when each Fakémon was created on its collection card.' },
                    { id: 'actions', setting: 'AlwaysShowCardActions', label: 'Always show card action buttons', desc: 'Keep pin, edit, export and delete visible on every card instead of only on hover.' }
                ]
            }
        ]
    },
    {
        key: 'editor', label: 'Editor & Tools',
        blurb: 'How the Fakémon editor and its helpers behave.',
        groups: [
            {
                id: 'editor', title: 'Editor',
                items: [
                    { id: 'fullscreen', setting: 'EditorFullscreen', label: 'Open the editor full screen', desc: "Use the whole window below the header instead of a side panel. The button in the editor's header switches it too." },
                    { id: 'fade', setting: 'FadeUselessMoves', label: 'Fade out usually useless moves', desc: 'Dim moves in the movepool that rarely see competitive use.' },
                    { id: 'cry', setting: 'AutoplayCry', label: 'Autoplay Pokémon cry', desc: "Play a Fakémon's uploaded cry automatically when you open it to edit or preview." },
                    { id: 'confirm', setting: 'ConfirmBeforeDelete', label: 'Confirm before deleting a Fakémon', desc: 'Ask "Are you sure?" before a delete goes through. Turn off to delete in one click.' }
                ]
            },
            {
                id: 'comparison', title: 'Comparison tools',
                items: [
                    { id: 'bulk', setting: 'IncludeOwnFakemonsInBulkComparison', label: 'Include your Fakémon in Bulk Comparison', desc: 'Let your own collection show up alongside official Pokémon.' },
                    { id: 'recommend', setting: 'IncludeOwnFakemonsInRecommendedMoves', label: 'Include your Fakémon in Recommended Moves', desc: 'Factor your own collection into move recommendations.' }
                ]
            }
        ]
    },
    {
        key: 'notifications', label: 'Notifications', when: signedIn,
        blurb: 'Choose what you hear about.',
        groups: [
            { id: 'notifications', title: 'Notify me about', render: () => <NotificationsGroup />, keywords: 'notifications alerts bell follow comments wall repost share pause mute' }
        ]
    },
    {
        key: 'account', label: 'Account', when: signedIn,
        blurb: 'Your profile, how you sign in, and linked accounts.',
        groups: [
            {
                id: 'profile', title: 'Profile',
                items: [
                    { id: 'edit-profile', label: 'Edit your profile', desc: 'Change your display name, bio, avatar, username and badges.', control: () => <button type="button" className="btn btn-secondary btn-sm" onClick={() => api.showProfileView(null, { edit: true })}>Edit Profile</button> }
                ]
            },
            {
                id: 'security', title: 'Security',
                items: [
                    { id: 'password', label: 'Password', desc: 'Change the password you use to sign in with your username or email.', control: () => <button type="button" className="btn btn-secondary btn-sm" onClick={() => api.openChangePasswordModal()}>Change Password</button> }
                ]
            },
            {
                id: 'connected', title: 'Connected accounts', keywords: 'google discord sign in link provider',
                render: () => <ConnectedAccounts className="st-group st-connected" heading={<GroupHead title="Connected accounts" />} />
            },
            { id: 'danger', title: 'Danger zone', keywords: 'delete account remove', render: () => <AccountDeletionGroup /> }
        ]
    },
    {
        key: 'data', label: 'Data & Storage',
        blurb: 'Your collection on this device, backups, and the safety net.',
        groups: [
            { id: 'device', title: 'This device', render: () => <DeviceGroup />, keywords: 'storage offline space saved browser persistent' },
            {
                id: 'safety', title: 'Safety & recovery',
                items: [
                    { id: 'safety-checks', setting: 'CollectionSafetyChecks', label: 'Collection safety checks', desc: 'Stop saving and warn you when your collection did not load or suddenly looks empty, so nothing overwrites Fakémon that can still be recovered. Only turn this off if the warning keeps coming back after reloading.' },
                    { id: 'lost', label: 'Check for lost Fakémon', text: 'Compares your collection against backup copies and restores anything missing.', desc: <>Compares your collection against this device&rsquo;s backup copies and restores anything missing. If nothing is missing here and you are signed in, it opens your cloud backup so you can check that too.</>, control: () => <button type="button" className="btn btn-secondary btn-sm" onClick={() => api.manualCheckForLostFakemon()}>Check Now</button> },
                    { id: 'export', label: 'Export your collection', desc: 'Download every Fakémon you own as a backup file you can import again later.', control: () => <button type="button" className="btn btn-secondary btn-sm" onClick={() => api.showCollection()}>Go to Collection</button> }
                ]
            },
            { id: 'cloud', title: 'Cloud backup', when: signedIn, keywords: 'cloud backup restore upload server', render: () => <CloudBackupGroup /> }
        ]
    }
];

const visibleSections = () => SECTIONS.filter(s => !s.when || s.when());
const visibleGroups = (s: Section) => s.groups.filter(g => !g.when || g.when());

/** Phones get the navigation as its own screen; see the page comment. */
function useNarrow() {
    const query = '(max-width: 760px)';
    const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
    useEffect(() => {
        const mq = window.matchMedia(query);
        const on = () => setNarrow(mq.matches);
        mq.addEventListener('change', on);
        return () => mq.removeEventListener('change', on);
    }, []);
    return narrow;
}

export function SettingsPage() {
    useStore();
    const opened = useViewShown('settings-view');
    const narrow = useNarrow();
    const [section, setSection] = useState<SectionKey>('appearance');
    // phones: the menu, or a section on top of it
    const [inSection, setInSection] = useState(false);
    const [query, setQuery] = useState('');
    const sections = visibleSections();

    // every visit starts on the section it was opened with (the menu, on a
    // phone, unless one was asked for), and refetches what the server knows
    useEffect(() => {
        if (!opened) return;
        const asked = api.takeSettingsTab?.() as SectionKey | '';
        setSection(asked || 'appearance');
        setInSection(!!asked);
        setQuery('');
        if (state.user) {
            refreshCloudBackupUI();
            api.updateConnectedAccountsUI?.();
        }
    }, [opened]);

    // the Account section goes away on sign-out
    const current = sections.find(s => s.key === section) || sections[0];
    const searching = query.trim().length > 0;
    const showMain = !narrow || inSection || searching;
    const showNav = !narrow || (!inSection && !searching) || searching;

    const open = (key: SectionKey) => {
        setSection(key);
        setInSection(true);
        setQuery('');
        window.scrollTo({ top: 0 });
    };

    return (
        <div className={`st${narrow ? ' st-narrow' : ''}${narrow && inSection && !searching ? ' st-in-section' : ''}`}>
            {showNav && (
                <aside className="st-nav" aria-label="Settings sections">
                    <h1 className="st-title">Settings</h1>
                    <SearchBox value={query} onChange={setQuery} />
                    {!searching && <IdentityCard />}
                    {!searching && (
                        <nav className="st-nav-list">
                            {sections.map(s => (
                                <button key={s.key} type="button"
                                    className={`st-nav-item${!narrow && s.key === current.key ? ' is-active' : ''}`}
                                    aria-current={!narrow && s.key === current.key ? 'page' : undefined}
                                    onClick={() => open(s.key)}>
                                    <span className="st-nav-text">
                                        <span className="st-nav-label">{s.label}</span>
                                    </span>
                                    <Icon name="chevron-right" size={16} className="st-nav-chevron" />
                                </button>
                            ))}
                        </nav>
                    )}
                </aside>
            )}

            {showMain && (
                <main className="st-main">
                    {searching
                        ? <SearchResults query={query} sections={sections} onOpen={open} />
                        : <SectionView key={current.key} section={current} onBack={narrow ? () => setInSection(false) : undefined} />}
                </main>
            )}
        </div>
    );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    return (
        <label className="st-search">
            <Icon name="magnifying-glass" size={16} />
            <input type="search" placeholder="Search settings" value={value} autoComplete="off"
                onChange={e => onChange(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape' && value) { e.preventDefault(); onChange(''); } }}
                aria-label="Search settings" />
            {value && <button type="button" className="st-search-clear" onClick={() => onChange('')} aria-label="Clear search"><Icon name="x-mark" size={14} /></button>}
        </label>
    );
}

/** Who is signed in, or why you might want to be. */
function IdentityCard() {
    const user = state.user;
    if (!user) {
        return (
            <div className="st-identity is-guest">
                <span className="st-identity-avatar"><Icon name="user" size={20} /></span>
                <span className="st-identity-text">
                    <strong>You're not signed in</strong>
                    <small>Sign in to back up your collection and share it in the Community Hub.</small>
                </span>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => api.openAuthModal('signin')}>Sign In</button>
            </div>
        );
    }
    const name = user.displayName || user.username || 'Your profile';
    return (
        <button type="button" className="st-identity" onClick={() => api.showProfileView()}>
            <span className="st-identity-avatar"><Avatar userId={user.id} url={user.avatarUrl} name={name} className="st-avatar-img" /></span>
            <span className="st-identity-text">
                <strong>{name}</strong>
                <small>{user.username ? '@' + user.username : 'View your profile'}</small>
            </span>
            <Icon name="chevron-right" size={16} className="st-nav-chevron" />
        </button>
    );
}

function SectionView({ section, onBack }: { section: Section; onBack?: () => void }) {
    return (
        <>
            <header className="st-head">
                {onBack && <button type="button" className="btn btn-secondary btn-icon btn-sm st-back" onClick={onBack} aria-label="All settings"><Icon name="arrow-left" size={16} /></button>}
                <span className="st-head-text">
                    <h2>{section.label}</h2>
                    <p>{section.blurb}</p>
                </span>
            </header>
            {visibleGroups(section).map(g => <GroupView key={g.id} group={g} />)}
        </>
    );
}

function GroupHead({ title, desc }: { title: string; desc?: ReactNode }) {
    return (
        <div className="st-group-head">
            <h3>{title}</h3>
            {desc && <p>{desc}</p>}
        </div>
    );
}

function GroupView({ group, items }: { group: Group; items?: Item[] }) {
    if (group.render) return <>{group.render()}</>;
    return (
        <section className="st-group">
            <GroupHead title={group.title} desc={group.desc?.()} />
            <div className="st-card">
                {(items || group.items || []).map(item => <Row key={item.id} item={item} />)}
            </div>
        </section>
    );
}

function Row({ item }: { item: Item }) {
    const labelId = useId();
    if (item.setting) {
        const on = !!api[`get${item.setting}`]?.();
        return (
            <label className={`st-row${on ? ' is-on' : ''}`}>
                <span className="st-row-text">
                    <span className="st-label" id={labelId}>{item.label}</span>
                    <span className="st-desc">{item.desc}</span>
                </span>
                <Switch checked={on} labelledBy={labelId} onChange={v => api[`set${item.setting}`]?.(v)} />
            </label>
        );
    }
    return (
        <div className={`st-row st-row-static${item.tone === 'danger' ? ' is-danger' : ''}`}>
            <span className="st-row-text">
                <span className="st-label">{item.label}</span>
                <span className="st-desc">{item.desc}</span>
            </span>
            {item.control && <span className="st-row-control">{item.control()}</span>}
        </div>
    );
}

function Switch({ checked, onChange, labelledBy }: { checked: boolean; onChange: (on: boolean) => void; labelledBy?: string }) {
    return (
        <span className="st-switch">
            <input type="checkbox" role="switch" checked={checked} aria-labelledby={labelledBy} onChange={e => onChange(e.target.checked)} />
            <span className="st-switch-track" aria-hidden="true" />
        </span>
    );
}

// ---- search ----

function SearchResults({ query, sections, onOpen }: { query: string; sections: Section[]; onOpen: (key: SectionKey) => void }) {
    const q = query.trim().toLowerCase();
    const hits = useMemo(() => sections.map(section => {
        const groups = visibleGroups(section).map(group => {
            const groupHit = [group.title, group.keywords].join(' ').toLowerCase().includes(q);
            if (group.render) return groupHit ? { group, items: undefined } : null;
            const items = (group.items || []).filter(i => groupHit
                || [i.label, typeof i.desc === 'string' ? i.desc : '', i.text].join(' ').toLowerCase().includes(q));
            return items.length ? { group, items } : null;
        }).filter(Boolean) as Array<{ group: Group; items?: Item[] }>;
        return { section, groups };
    }).filter(r => r.groups.length), [q, sections]);

    if (!hits.length) {
        return (
            <div className="st-empty">
                <h2>No settings match &ldquo;{query.trim()}&rdquo;</h2>
                <p>Try a shorter word, like &ldquo;dark&rdquo;, &ldquo;backup&rdquo; or &ldquo;motion&rdquo;.</p>
            </div>
        );
    }
    return (
        <>
            <header className="st-head">
                <span className="st-head-text">
                    <h2>Results for &ldquo;{query.trim()}&rdquo;</h2>
                    <p>Change them right here, or open the section they belong to.</p>
                </span>
            </header>
            {hits.map(({ section, groups }) => (
                <div key={section.key} className="st-result">
                    <button type="button" className="st-result-section" onClick={() => onOpen(section.key)}>
                        {section.label}<Icon name="chevron-right" size={14} />
                    </button>
                    {groups.map(({ group, items }) => <GroupView key={group.id} group={group} items={items} />)}
                </div>
            ))}
        </>
    );
}

// ---- appearance: theme ----

const THEMES = [
    { dark: false, label: 'Light', note: 'Warm paper. Easy to read in daylight.' },
    { dark: true, label: 'Dark', note: 'Easy on the eyes at night.' }
];

function ThemePicker() {
    const dark = !!api.isDarkModeEnabled?.();
    return (
        <section className="st-group">
            <GroupHead title="Theme" />
            <div className="st-themes" role="radiogroup" aria-label="Theme">
                {THEMES.map(t => {
                    const selected = t.dark === dark;
                    return (
                        <button key={t.label} type="button" role="radio" aria-checked={selected}
                            className={`st-theme${selected ? ' is-selected' : ''}`} data-preview={t.dark ? 'dark' : 'light'}
                            onClick={() => { if (!selected) api.toggleDarkMode(); }}>
                            <span className="st-theme-art" aria-hidden="true">
                                <span className="mk-header"><span className="mk-logo" /><span className="mk-pill" /></span>
                                <span className="mk-body">
                                    <span className="mk-side"><span /><span /><span /></span>
                                    <span className="mk-grid">
                                        {[0, 1, 2].map(i => <span key={i} className="mk-card"><span className="mk-art" /><span className="mk-line" /><span className="mk-line mk-line-short" /></span>)}
                                    </span>
                                </span>
                            </span>
                            <span className="st-theme-caption">
                                <span className="st-radio" aria-hidden="true" />
                                <span className="st-theme-text"><strong>{t.label}</strong><small>{t.note}</small></span>
                            </span>
                        </button>
                    );
                })}
            </div>
        </section>
    );
}

// ---- data: this device ----

function formatBytes(n: number) {
    if (!n) return '0 MB';
    const mb = n / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** What the browser says about this site's storage. Read once per visit. */
function useStorageStatus() {
    const [status, setStatus] = useState<{ persisted: boolean | null; usage: number | null }>({ persisted: null, usage: null });
    const [tick, setTick] = useState(0);
    useEffect(() => {
        let live = true;
        (async () => {
            const s = navigator.storage;
            const persisted = s?.persisted ? await s.persisted().catch(() => null) : null;
            const est = s?.estimate ? await s.estimate().catch(() => null) : null;
            if (live) setStatus({ persisted, usage: est?.usage ?? null });
        })();
        return () => { live = false; };
    }, [tick]);
    return { ...status, refresh: () => setTick(t => t + 1) };
}

function useOnline() {
    const [online, setOnline] = useState(navigator.onLine);
    useEffect(() => {
        const on = () => setOnline(navigator.onLine);
        window.addEventListener('online', on);
        window.addEventListener('offline', on);
        return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on); };
    }, []);
    return online;
}

function Status({ tone, children }: { tone: 'good' | 'wait' | 'off'; children: ReactNode }) {
    return <span className={`st-status is-${tone}`}><span className="st-status-dot" />{children}</span>;
}

function DeviceGroup() {
    const storage = useStorageStatus();
    const online = useOnline();
    const offlineReady = !!navigator.serviceWorker?.controller;
    const count = (list: unknown[] | undefined, one: string, many: string) => {
        const n = (list || []).length;
        return `${n} ${n === 1 ? one : many}`;
    };
    const saved = [
        count(state.fakemonDB, 'Fakémon', 'Fakémon'),
        count(state.customMoves, 'custom move', 'custom moves'),
        count(state.customAbilities, 'ability', 'abilities'),
        count(state.customItems, 'item', 'items')
    ].join(' · ');
    const protect = async () => {
        const granted = await api.requestPersistentStorage?.();
        storage.refresh();
        api.showToast?.(granted
            ? 'Done. Your browser will keep your collection even when space runs low.'
            : "Your browser said no for now. It usually agrees once you've used the site a few times, or after you add it to your home screen.", granted ? 'success' : 'info');
    };
    return (
        <section className="st-group">
            <GroupHead title="This device" desc="Your collection lives in this browser, not on our server." />
            <div className="st-card">
                <div className="st-row st-row-static">
                    <span className="st-row-text">
                        <span className="st-label">Saved here</span>
                        <span className="st-desc st-figures">{saved}{storage.usage != null && <> · {formatBytes(storage.usage)} used</>}</span>
                    </span>
                </div>
                <div className={`st-row st-row-static${storage.persisted ? ' is-on' : ''}`}>
                    <span className="st-row-text">
                        <span className="st-label">Protected from cleanup</span>
                        <span className="st-desc">{storage.persisted
                            ? "Your browser won't clear this site's data to free up space."
                            : 'When space runs low, some browsers clear site data, collection included. Ask yours to keep it, and export a backup now and then.'}</span>
                    </span>
                    <span className="st-row-control">
                        {storage.persisted === null ? <Status tone="off">Unknown</Status>
                            : storage.persisted ? <Status tone="good">Protected</Status>
                                : <button type="button" className="btn btn-secondary btn-sm" onClick={protect}>Protect</button>}
                    </span>
                </div>
                <div className={`st-row st-row-static${offlineReady ? ' is-on' : ''}`}>
                    <span className="st-row-text">
                        <span className="st-label">Works offline</span>
                        <span className="st-desc">{offlineReady
                            ? 'Your collection, the editor, analysis and exports all work without a connection. Community, messages and battles need one.'
                            : import.meta.env.PROD
                                ? 'Getting ready. Keep the site open for a moment while you have a connection.'
                                : 'Offline support only runs on the built site, not the development server.'}</span>
                    </span>
                    <span className="st-row-control">
                        {!online ? <Status tone="wait">You're offline</Status> : offlineReady ? <Status tone="good">Ready</Status> : <Status tone="off">Not yet</Status>}
                    </span>
                </div>
            </div>
        </section>
    );
}

// ---- account: danger zone ----

function AccountDeletionGroup() {
    const due: Date | null = accountDeletionDueAt();
    return (
        <section className="st-group">
            <GroupHead title="Danger zone" />
            <div className="st-card">
                <div className="st-row st-row-static is-danger">
                    <span className="st-row-text">
                        <span className="st-label">Delete account</span>
                        <span className="st-desc">{due
                            ? `This account is scheduled for permanent deletion on ${formatDue(due)}. Cancel any time before then and nothing is lost.`
                            : `Permanently delete your account and everything on it. Nothing is destroyed for ${ACCOUNT_DELETION_GRACE_DAYS} days, so you can change your mind.`}</span>
                    </span>
                    <span className="st-row-control">
                        {due
                            ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => cancelAccountDeletion()}>Cancel Deletion</button>
                            : <button type="button" className="btn btn-danger btn-sm" onClick={() => openDeleteAccountModal()}>Delete Account</button>}
                    </span>
                </div>
            </div>
        </section>
    );
}

// ---- data: cloud backup ----

function CloudBackupGroup() {
    const cs = cloudState();
    const autoOn = isAutoBackupOn();
    const autoId = useId();
    return (
        <section className="st-group">
            <GroupHead title="Cloud backup" desc="A private copy on our server, so you can get your collection back on a new device or after clearing your browser. Only you can see it." />
            <div className="st-card">
                <div className="st-row st-row-static st-row-meters">
                    <CloudMeters className="cloud-meters settings-cloud-meters" />
                </div>
                <div className={`st-row st-row-static${cs.savedAt ? ' is-on' : ''}`}>
                    <span className="st-row-text">
                        <span className="st-label">Back up to your account</span>
                        <span className="st-desc">You choose exactly which Fakémon, moves, abilities, items and regions go in, up to the allowance above. It is separate from publishing to the Community Hub.</span>
                        <span className="st-desc st-desc-status">
                            {cs.savedAt
                                ? `Last backed up ${new Date(cs.savedAt).toLocaleString()}, ${cs.byId.size} Fakémon stored.`
                                : (cs.loaded ? 'No cloud backup yet.' : 'Checking your cloud backup…')}
                        </span>
                    </span>
                    <span className="st-row-control"><button type="button" className="btn btn-primary btn-sm" onClick={() => openCloudBackupModal('upload')}>Choose &amp; Back Up</button></span>
                </div>
                <div className="st-row st-row-static">
                    <span className="st-row-text">
                        <span className="st-label">Restore from your backup</span>
                        <span className="st-desc">Copies the entries you tick onto this device. Anything already here is left alone unless you tick it, in which case the backed-up version replaces it. Nothing is ever deleted.</span>
                    </span>
                    <span className="st-row-control"><button type="button" className="btn btn-secondary btn-sm" disabled={!cs.savedAt} onClick={() => openCloudBackupModal('restore')}>Choose &amp; Restore</button></span>
                </div>
                {/* only for accounts a badge allows it, while the site-wide switch is on */}
                {cs.limits.autoBackup && (
                    <label className={`st-row${autoOn ? ' is-on' : ''}`}>
                        <span className="st-row-text">
                            <span className="st-label" id={autoId}>Keep my backup up to date automatically</span>
                            <span className="st-desc">Re-uploads the entries you already picked whenever you edit them, a few minutes after you stop. It never adds anything you did not choose, and a Fakémon you delete here does leave the backup, so it mirrors your picks rather than being a second collection.</span>
                            {autoOn && <span className="st-desc st-desc-status">{cs.savedAt
                                ? 'On. Your picks are kept current.'
                                : 'On, but there is nothing to keep current yet. Back something up once and it will take over from there.'}</span>}
                        </span>
                        <Switch checked={autoOn} labelledBy={autoId} onChange={on => setCloudAutoBackup(on)} />
                    </label>
                )}
                {cs.savedAt && (
                    <div className="st-row st-row-static is-danger">
                        <span className="st-row-text">
                            <span className="st-label">Delete your backup</span>
                            <span className="st-desc">Removes the copy stored on our server. Your collection on this device is untouched.</span>
                        </span>
                        <span className="st-row-control"><button type="button" className="btn btn-danger btn-sm" onClick={() => deleteCloudBackup()}>Delete Backup</button></span>
                    </div>
                )}
            </div>
        </section>
    );
}

// ---- notifications ----

function NotificationsGroup() {
    const prefs = notificationPrefs();
    const paused = prefs?.all === false;
    const pauseId = useId();
    return (
        <>
            <section className="st-group">
                <GroupHead title="Pause notifications" desc="Moderation notices still reach you, whatever you choose here." />
                <div className="st-card">
                    <label className={`st-row${paused ? ' is-on' : ''}`}>
                        <span className="st-row-text">
                            <span className="st-label" id={pauseId}>Pause all notifications</span>
                            <span className="st-desc">Nothing new shows up on the bell until you turn this back off.</span>
                        </span>
                        <Switch checked={paused} labelledBy={pauseId} onChange={on => setNotificationPref('all', !on)} />
                    </label>
                </div>
            </section>
            <section className={`st-group${paused ? ' is-muted' : ''}`}>
                <GroupHead title="Notify me about" />
                <div className="st-card" aria-disabled={paused || undefined}>
                    {prefs === null ? (
                        <div className="st-row st-row-static"><span className="st-row-text"><span className="skel skel-text" style={{ width: '50%' }} /></span></div>
                    ) : NOTIFICATION_KINDS.map(([type, label, desc]) => <NotificationRow key={type} type={type} label={label} desc={desc} on={prefs[type] !== false} disabled={paused} />)}
                </div>
            </section>
        </>
    );
}

function NotificationRow({ type, label, desc, on, disabled }: { type: string; label: string; desc: string; on: boolean; disabled: boolean }) {
    const id = useId();
    return (
        <label className={`st-row${on && !disabled ? ' is-on' : ''}`}>
            <span className="st-row-text">
                <span className="st-label" id={id}>{label}</span>
                <span className="st-desc">{desc}</span>
            </span>
            <span className="st-switch">
                <input type="checkbox" role="switch" checked={on} disabled={disabled} aria-labelledby={id} onChange={e => setNotificationPref(type, e.target.checked)} />
                <span className="st-switch-track" aria-hidden="true" />
            </span>
        </label>
    );
}
