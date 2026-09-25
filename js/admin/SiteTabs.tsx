// Badges & permissions, and the site-wide limits.

import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../app/components/Icon.tsx';
import { Modal } from '../app/components/Modal.tsx';
import { openDialog, registerDialog, type DialogProps } from '../app/dialogs.tsx';
import { useStore } from '../app/store.ts';
import { allIconNames } from '../core/icon-set.ts';
import { PERMISSIONS, admin, ask, can, getClient, loadBadges, reload, showToast, type Badge } from './core.ts';
import { BadgeIcon } from './ui.tsx';

// ==================== badges ====================
export function BadgesTab() {
    useStore();
    const myRank = admin.me?.rank ?? 0;
    return (
        <>
            <div className="admin-section-head"><h3>Badges &amp; permissions</h3></div>
            <p className="admin-section-sub">Badges and roles are the same thing. A user can hold several; their permissions are the union of every badge they hold, and their rank (used for staff hierarchy) is the highest among them. Rank 0 badges are purely cosmetic. You can only create, edit or grant a badge ranked below your own.</p>
            <div className="admin-badges-grid">
                {admin.badges.map(b => {
                    // only capabilities actually granted, so a cosmetic badge reads as cosmetic
                    const perms = PERMISSIONS.filter(([key]) => b['can_' + key]);
                    const locked = b.rank >= myRank;
                    return (
                        <div className="admin-badge-card" key={b.key}>
                            <div className="admin-badge-card-top">
                                <div className="admin-badge-icon-chip" style={{ background: `${b.color}22`, color: b.color }}>
                                    <BadgeIcon badge={b} size={20} className="" colored={false} />
                                </div>
                                <div>
                                    <div className="admin-badge-card-title">{b.label}</div>
                                    <div className="admin-badge-card-rank">Rank {b.rank}</div>
                                </div>
                            </div>
                            {b.description && <div className="admin-badge-card-desc">{b.description}</div>}
                            <div className="admin-badge-card-perms">
                                {perms.length ? perms.map(([key, label]) => <span key={key} className="admin-perm-pill on">{label}</span>) : <span className="admin-perm-pill">Cosmetic</span>}
                            </div>
                            <div className="admin-badge-card-actions">
                                <button type="button" disabled={locked} title={locked ? 'Rank too high to edit' : undefined} onClick={() => openDialog('admin-badge', { badge: b })}>
                                    <Icon name="pencil" /> Edit
                                </button>
                            </div>
                        </div>
                    );
                })}
                <button type="button" className="admin-add-badge-card" onClick={() => openDialog('admin-badge', { badge: null })}>
                    <Icon name="plus-circle" /> New badge
                </button>
            </div>
        </>
    );
}

// every Heroicon's name, fetched once for the picker
let iconNames: string[] | null = null;

// Any common image becomes a 64x64 PNG (contained, transparent edges), so the
// database only ever stores one small, script-free format.
async function toBadgePng(file: File): Promise<string> {
    if (!/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(file.type)) throw new Error('Choose a PNG, JPG, WebP, GIF or SVG image.');
    if (file.size > 4 * 1024 * 1024) throw new Error('That image is over 4 MB. Choose a smaller one.');
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('That file could not be read as an image.'));
            el.src = url;
        });
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d')!;
        const w = img.naturalWidth || size, h = img.naturalHeight || size;
        const scale = Math.min(size / w, size / h);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, (size - w * scale) / 2, (size - h * scale) / 2, w * scale, h * scale);
        return canvas.toDataURL('image/png');
    } finally {
        URL.revokeObjectURL(url);
    }
}

// Empty means "inherit" (null); `|| ''` would wrongly blank a real 0 too.
const num = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));

function BadgeDialog({ close, badge: b }: DialogProps<{ badge: Badge | null }>) {
    const myRank = admin.me?.rank ?? 0;
    const [f, setF] = useState({
        key: b?.key || '', label: b?.label || '', icon: b?.icon || 'star', color: b?.color || '#6b7280',
        description: b?.description || '', rank: String(b?.rank ?? 0), image: b?.icon_image || '',
        perms: Object.fromEntries(PERMISSIONS.map(([key]) => [key, !!b?.['can_' + key]])) as Record<string, boolean>,
        items: num(b?.limit_cloud_items), uploads: num(b?.limit_community_uploads), cooldown: num(b?.limit_publish_cooldown_seconds),
        regions: num(b?.limit_cloud_regions), auto: !!b?.can_auto_backup
    });
    const set = (patch: Partial<typeof f>) => setF(v => ({ ...v, ...patch }));
    const [icons, setIcons] = useState<string[] | null>(iconNames);
    useEffect(() => { if (!icons) allIconNames().then((n: string[]) => { iconNames = n; setIcons(n); }); }, []);
    // Read-only (not hidden) without manage_limits: viewing is fine, editing is gated.
    const mayEditLimits = can('manage_limits');

    const q = f.icon.trim().toLowerCase();
    const exact = icons?.includes(q);
    const shownIcons = (icons || []).filter(n => !q || exact || n.includes(q));

    async function upload(file: File | undefined) {
        if (!file) return;
        try { set({ image: await toBadgePng(file) }); }
        catch (e: any) { showToast(e.message || 'That image could not be used.', 'error'); }
    }

    async function submit(e: FormEvent) {
        e.preventDefault();
        const key = f.key.trim().toLowerCase();
        if (!/^[a-z0-9_]{2,24}$/.test(key)) { showToast('Badge key must be 2-24 lowercase letters/numbers/underscores.', 'error'); return; }
        const rank = parseInt(f.rank, 10) || 0;
        if (rank >= myRank) { showToast(`Rank must be lower than your own rank (${myRank}).`, 'error'); return; }
        // Empty stays null ("inherit site default") - coercing to 0 would silently cap holders at nothing.
        const limit = (raw: string) => (raw.trim() === '' ? null : parseInt(raw, 10));
        const client = await getClient();
        // SECURITY DEFINER RPC - re-checks manage_badges, manage_limits, and rank server-side.
        const { error } = await client.rpc('admin_upsert_badge_v4', {
            p_key: key, p_label: f.label.trim() || key, p_icon: f.icon.trim() || 'star', p_color: f.color,
            p_description: f.description.trim(), p_rank: rank, p_perms: f.perms,
            p_limits: {
                cloud_items: limit(f.items), community_uploads: limit(f.uploads), publish_cooldown_seconds: limit(f.cooldown),
                cloud_regions: limit(f.regions), auto_backup: f.auto
            },
            p_icon_image: f.image || null
        });
        if (error) { showToast('Could not save badge: ' + error.message, 'error'); return; }
        showToast('Badge saved', 'success');
        close();
        await loadBadges();
        reload('users');
    }

    async function remove() {
        if (!b) return;
        close();
        const answer = await ask({
            title: 'Delete badge',
            blurb: <>Delete <strong>{b.label}</strong>. This removes it from every user who holds it, along with any permissions it granted them.</>,
            confirm: 'Delete badge', requireReason: false, danger: true
        });
        if (!answer) return;
        const client = await getClient();
        const { error } = await client.rpc('admin_delete_badge', { p_key: b.key });
        if (error) { showToast('Could not delete: ' + error.message, 'error'); return; }
        showToast('Badge deleted', 'success');
        await loadBadges();
        reload('users');
    }

    return (
        <Modal onClose={close} title={b ? `Edit “${b.label}”` : 'New badge'} className="modal-wide" labelledBy="admin-badge-title">
            <form onSubmit={submit}>
                <div className="admin-modal-row">
                    <div className="form-group">
                        <label htmlFor="admin-badge-key">Key <span>(internal id, permanent)</span></label>
                        {/* the key is the primary key, so it can't be renamed */}
                        <input id="admin-badge-key" type="text" placeholder="artist_lead" required disabled={!!b} value={f.key} onChange={e => set({ key: e.target.value })} />
                    </div>
                    <div className="form-group">
                        <label htmlFor="admin-badge-label">Display label</label>
                        <input id="admin-badge-label" type="text" placeholder="Artist Lead" required value={f.label} onChange={e => set({ label: e.target.value })} />
                    </div>
                </div>
                <div className="admin-icon-color-row">
                    <div className="admin-icon-preview" style={{ background: `${f.color}22`, color: f.color }}>
                        {f.image ? <img src={f.image} alt="" style={{ width: 24, height: 24 }} /> : <Icon name={q || 'star'} />}
                    </div>
                    <div className="form-group" style={{ flex: 1, minWidth: 150 }}>
                        <label htmlFor="admin-badge-icon">Icon <span>(a Heroicon; pick one below or type its name)</span></label>
                        <input id="admin-badge-icon" type="text" placeholder="shield-check" autoComplete="off" spellCheck={false} value={f.icon} onChange={e => set({ icon: e.target.value })} />
                    </div>
                    <div className="form-group" style={{ width: 80 }}>
                        <label htmlFor="admin-badge-color">Color</label>
                        <input id="admin-badge-color" type="color" value={f.color} onChange={e => set({ color: e.target.value })} />
                    </div>
                    <div className="form-group" style={{ width: 110 }}>
                        <label htmlFor="admin-badge-rank">Rank</label>
                        <input id="admin-badge-rank" type="number" min={0} step={1} required value={f.rank} onChange={e => set({ rank: e.target.value })} />
                    </div>
                </div>
                <div className="admin-icon-picker-wrap">
                    <div className={`admin-icon-picker${f.image ? ' is-overridden' : ''}`} role="listbox" aria-label="Heroicons">
                        {!icons ? <div className="admin-empty">Loading icons…</div> : shownIcons.map(n => (
                            <button key={n} type="button" className={`admin-icon-choice${n === q ? ' active' : ''}`} title={n} role="option" aria-selected={n === q} onClick={() => set({ icon: n })}>
                                <Icon name={n} />
                            </button>
                        ))}
                    </div>
                    <div className="admin-icon-upload">
                        <label className="btn btn-secondary btn-sm">
                            <Icon name="arrow-up-tray" /> Upload your own icon
                            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden onChange={e => { upload(e.target.files?.[0]); e.target.value = ''; }} />
                        </label>
                        {f.image && <button type="button" className="btn btn-secondary btn-sm btn-danger-ghost" onClick={() => set({ image: '' })}><Icon name="x" /> Remove image</button>}
                        <small>PNG, JPG, WebP, GIF or SVG. It's scaled to 64&times;64 and shown instead of the icon, in its own colours.</small>
                    </div>
                </div>
                <div className="form-group">
                    <label htmlFor="admin-badge-description">Description / tooltip</label>
                    <textarea id="admin-badge-description" rows={2} placeholder="Shown on hover" value={f.description} onChange={e => set({ description: e.target.value })} />
                </div>
                <div className="form-group">
                    <label>Permissions</label>
                    <div className="admin-perm-grid">
                        {PERMISSIONS.map(([key, label, help]) => (
                            <label key={key} className="admin-checkbox-row" title={help}>
                                <input type="checkbox" checked={!!f.perms[key]} onChange={e => set({ perms: { ...f.perms, [key]: e.target.checked } })} />
                                <span>{label}<small>{help}</small></span>
                            </label>
                        ))}
                    </div>
                    <p className="admin-section-sub" style={{ margin: '8px 0 0' }}>Rank 0 with no permissions is a purely cosmetic badge. Anything with at least one permission can open this panel.</p>
                </div>
                {/* the RPC refuses these fields from anyone without manage_limits regardless */}
                <div className="form-group">
                    <label>Limits this badge grants</label>
                    <p className="admin-section-sub" style={{ margin: '0 0 8px' }}>Leave a box empty to inherit the site default. Enter -1 for unlimited. When someone holds several badges the most generous number wins, so these raise a limit and never lower one.</p>
                    <div className="admin-modal-row">
                        {([['items', 'Cloud backup items', -1], ['uploads', 'Community uploads', -1], ['cooldown', 'Publish cooldown (seconds)', 0], ['regions', 'Cloud backup regions', -1]] as const).map(([k, label, min]) => (
                            <div className="form-group" key={k}>
                                <label htmlFor={`admin-badge-limit-${k}`}>{label}</label>
                                <input id={`admin-badge-limit-${k}`} type="number" min={min} step={1} placeholder="inherit" disabled={!mayEditLimits}
                                    value={f[k]} onChange={e => set({ [k]: e.target.value })} />
                            </div>
                        ))}
                    </div>
                    <label className="admin-checkbox-row" title="Lets holders switch on automatic cloud backup">
                        <input type="checkbox" disabled={!mayEditLimits} checked={f.auto} onChange={e => set({ auto: e.target.checked })} />
                        <span>automatic cloud backup<small>Holders can switch on auto-backup in Settings, if the site-wide switch on the limits tab is also on.</small></span>
                    </label>
                </div>
                <div className="admin-modal-actions">
                    {b && <button type="button" className="btn btn-danger-ghost" style={{ marginRight: 'auto' }} onClick={remove}>Delete</button>}
                    <button type="button" className="btn btn-secondary" onClick={close}>Cancel</button>
                    <button type="submit" className="btn btn-primary">Save badge</button>
                </div>
            </form>
        </Modal>
    );
}
registerDialog('admin-badge', BadgeDialog);

// ==================== limits ====================
// Site-wide defaults; per-badge overrides live in the badge editor instead.
// Enforced in Postgres (enforce_collection_quota(), published_mons_enforce_cooldown()
// via effective_limits()), so this page is advisory regardless of what loads it.
export function LimitsTab() {
    const [f, setF] = useState<null | { items: string; mb: string; uploads: string; cooldown: string; regions: string; auto: boolean }>(null);
    const set = (patch: Partial<NonNullable<typeof f>>) => setF(v => (v ? { ...v, ...patch } : v));

    async function load() {
        const client = await getClient();
        const { data: l, error } = await client.from('site_limits').select('*').maybeSingle();
        if (error) { showToast('Could not load limits: ' + error.message, 'error'); return; }
        if (!l) return;
        setF({
            items: String(l.cloud_items),
            // stored in bytes, shown in MB: nobody wants to type 5242880
            mb: String(Math.round((Number(l.cloud_bytes) / 1048576) * 10) / 10),
            uploads: String(l.community_uploads), cooldown: String(l.publish_cooldown_seconds),
            regions: String(l.cloud_regions ?? 3), auto: !!l.auto_backup_enabled
        });
    }
    useEffect(() => { load(); }, []);

    async function submit(e: FormEvent) {
        e.preventDefault();
        if (!f) return;
        const items = parseInt(f.items, 10), mb = parseFloat(f.mb), uploads = parseInt(f.uploads, 10);
        const cooldown = parseInt(f.cooldown, 10), regions = parseInt(f.regions, 10);
        // -1 means unlimited; any other negative would pass the database's check but confuse the trigger
        if (!Number.isFinite(items) || items < -1) return showToast('Cloud backup items must be -1 or higher.', 'error');
        if (!Number.isFinite(uploads) || uploads < -1) return showToast('Community uploads must be -1 or higher.', 'error');
        if (!Number.isFinite(cooldown) || cooldown < 0) return showToast('Cooldown cannot be negative.', 'error');
        if (!Number.isFinite(regions) || regions < -1) return showToast('Regions per backup must be -1 or higher.', 'error');
        if (!Number.isFinite(mb) || mb <= 0) return showToast('Backup size must be greater than zero.', 'error');
        const client = await getClient();
        const { error } = await client.rpc('admin_set_site_limits_v2', {
            p_cloud_items: items, p_cloud_bytes: Math.round(mb * 1048576), p_community_uploads: uploads,
            p_publish_cooldown_seconds: cooldown, p_auto_backup_enabled: f.auto, p_cloud_regions: regions
        });
        if (error) return showToast('Could not save limits: ' + error.message, 'error');
        showToast('Limits saved', 'success');
        await load();
    }

    const field = (k: 'items' | 'mb' | 'uploads' | 'cooldown' | 'regions', label: string, hint: string, min: number, step = 1) => (
        <div className="form-group">
            <label htmlFor={`admin-limit-${k}`}>{label} <span>({hint})</span></label>
            <input id={`admin-limit-${k}`} type="number" min={min} step={step} required value={f?.[k] ?? ''} onChange={e => set({ [k]: e.target.value })} />
        </div>
    );

    return (
        <>
            <div className="admin-section-head"><h3>Limits</h3></div>
            <p className="admin-section-sub">What every account gets by default. A badge can raise any of these for the people holding it (Badges tab), and the most generous badge a user holds is the one that applies. They're enforced in Postgres by enforce_collection_quota() and published_mons_enforce_cooldown(), so they hold no matter what any client sends.</p>
            {!f ? <div className="admin-empty">Loading…</div> : (
                <form id="admin-limits-form" onSubmit={submit}>
                    <fieldset className="admin-limits-group">
                        <legend><Icon name="cloud" /> Cloud backup</legend>
                        <div className="admin-modal-row">
                            {field('items', 'Items', '-1 for unlimited', -1)}
                            {field('mb', 'Size', 'MB per account', 1, 0.5)}
                        </div>
                        <label className="admin-checkbox-row" title="The master switch for automatic cloud backup">
                            <input type="checkbox" checked={f.auto} onChange={e => set({ auto: e.target.checked })} />
                            <span>Automatic cloud backup available<small>Off by default. Even with this on, a user only gets it if one of their badges grants it, and only if they switch it on themselves.</small></span>
                        </label>
                    </fieldset>
                    <fieldset className="admin-limits-group">
                        <legend><Icon name="map" /> Regions in cloud backup</legend>
                        <div className="admin-modal-row">{field('regions', 'Regions per backup', '-1 for unlimited, 0 turns region backup off', -1)}</div>
                        <p className="admin-section-sub" style={{ margin: 0 }}>A region carries its details, banner and main-game roster. Everything filed in it still counts as items. Backups made before this limit keep every region they already hold until they're next saved.</p>
                    </fieldset>
                    <fieldset className="admin-limits-group">
                        <legend><Icon name="users" /> Community</legend>
                        <div className="admin-modal-row">
                            {field('uploads', 'Uploads', '-1 for unlimited', -1)}
                            {field('cooldown', 'Publish cooldown', 'seconds, 0 for none', 0)}
                        </div>
                    </fieldset>
                    <div className="admin-modal-actions"><button type="submit" className="btn btn-primary"><Icon name="save" /> Save limits</button></div>
                </form>
            )}
        </>
    );
}
