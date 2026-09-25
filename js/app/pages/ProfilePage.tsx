// A trainer's profile (/profile/<username>): their card, published Fakémon
// and comments. On your own profile, Edit Profile swaps in the forms for your
// name, bio, avatar, username, shown badges, email and connected accounts.

import { useEffect, useState, type ChangeEvent, type ReactNode } from 'react';
import { api, state } from '../../core/app.ts';
import { Avatar } from '../components/Avatar.tsx';
import { BadgeRow } from '../components/Badge.tsx';
import { ConnectedAccounts } from '../components/ConnectedAccounts.tsx';
import { Icon } from '../components/Icon.tsx';
import { BadgePicker, ProfileComments, ProfileMons } from '../components/profile.tsx';
import { useStore } from '../store.ts';

type Message = { text: string; ok?: boolean };

export function ProfilePage() {
    useStore();
    const status = state.profilePageStatus || 'loading';
    const profile = state.profilePageUser;
    const isOwn = !!state.user && !!profile && state.user.id === profile.id;
    const editing = !!state.profilePageEditing && isOwn;

    if (status === 'error') {
        return (
            <div className="profile-page-shell">
                <div className="profile-loading profile-load-error" style={{ display: 'flex' }}>
                    <strong>Couldn’t load this profile.</strong>
                    <span>{state.profilePageError}</span>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => api.showProfileView()}>Try Again</button>
                </div>
            </div>
        );
    }

    return (
        <div className="profile-page-shell">
            {editing ? <EditProfile profile={profile} /> : (
                <>
                    <div className="profile-page-header profile-page-header-clean">
                        <div />
                        <div className="profile-page-header-actions">
                            <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.showCollection()}>
                                <Icon name="arrow-left" size={14} /> Back
                            </button>
                            {isOwn && status === 'ready' && (
                                <button className="btn btn-primary btn-sm" type="button" onClick={() => api.editOwnProfile()}>
                                    <Icon name="pencil" /> Edit Profile
                                </button>
                            )}
                        </div>
                    </div>
                    {status === 'loading' || !profile ? <PublicProfileSkeleton /> : <PublicProfile profile={profile} isOwn={isOwn} />}
                </>
            )}
        </div>
    );
}

// ==================== the public page ====================

function PublicProfileSkeleton() {
    return (
        <div>
            <section className="panel profile-public-hero trainer-card">
                <div className="profile-public-avatar-wrap">
                    <span className="profile-public-avatar-fallback skel skel-circle" style={{ display: 'flex' }} />
                </div>
                <div className="profile-public-main">
                    <div className="profile-public-name-row">
                        <div>
                            <div className="trainer-card-label">Trainer card</div>
                            <h2 className="skel skel-text" style={{ width: 160 }} />
                            <p className="profile-page-handle skel skel-text" style={{ width: 100 }} />
                        </div>
                    </div>
                    <div className="trainer-card-meta">
                        <div className="profile-public-badges skel-card" style={{ display: 'flex' }}><span className="skel skel-pill" style={{ width: 70 }} /></div>
                        <span className="skel skel-text" style={{ width: 90, display: 'inline-block' }} />
                    </div>
                    <p className="profile-public-bio skel skel-text" style={{ width: '55%' }} />
                </div>
            </section>
            <Section title="Fakemon" desc="Published creations from this creator." count={<span className="profile-badge-count skel skel-text" style={{ width: 46, display: 'inline-block' }} />}>
                <div className="profile-mons-grid"><ProfileMons loading /></div>
            </Section>
            <Section title="Comments" desc="Leave a message for this creator.">
                <div className="profile-comments-list"><ProfileComments loading /></div>
            </Section>
        </div>
    );
}

function PublicProfile({ profile, isOwn }: { profile: any; isOwn: boolean }) {
    const displayName = profile.display_name || profile.username || 'Profile';
    const badges: string[] = Array.isArray(profile.display_badges) ? profile.display_badges : [];
    const mons = profile.mons || [];
    return (
        <div>
            <section className="panel profile-public-hero trainer-card">
                <div className="profile-public-avatar-wrap">
                    <Avatar userId={profile.id} url={profile.avatar_url} name={displayName} className="profile-public-avatar" />
                </div>
                <div className="profile-public-main">
                    <div className="profile-public-name-row">
                        <div>
                            <div className="trainer-card-label">Trainer card</div>
                            <h2>{displayName}</h2>
                            <p className="profile-page-handle">{profile.username ? `@${profile.username}` : ''}</p>
                        </div>
                    </div>
                    <div className="trainer-card-meta">
                        {badges.length > 0 && <div className="profile-public-badges" style={{ display: 'flex' }}><BadgeRow badgeKeys={badges} size={18} /></div>}
                        <span>{profile.created_at ? `Joined ${new Date(profile.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })}` : ''}</span>
                    </div>
                    <p className="profile-public-bio">{profile.bio || 'No bio yet.'}</p>
                    {/* your own linked sign-ins; nobody else's can be listed */}
                    {isOwn && <ConnectedBadges />}
                </div>
            </section>

            <Section title="Fakemon" desc="Published creations from this creator." count={<span className="profile-badge-count">{mons.length} {mons.length === 1 ? 'mon' : 'mons'}</span>}>
                <div className="profile-mons-grid"><ProfileMons mons={mons} /></div>
            </Section>

            <Section title="Comments" desc="Leave a message for this creator.">
                <div className="profile-comments-list">
                    <ProfileComments comments={profile.comments || []} viewerId={state.user?.id || null} viewerIsStaff={!!api.isStaff?.()} />
                </div>
                {state.user ? <CommentBox /> : <div className="profile-signin-hint">Sign in to leave a comment.</div>}
            </Section>
        </div>
    );
}

function Section({ title, desc, count, children }: { title: string; desc: string; count?: ReactNode; children: ReactNode }) {
    return (
        <section className="panel profile-public-section">
            <div className="profile-section-title">
                <div><h3>{title}</h3><p>{desc}</p></div>
                {count}
            </div>
            {children}
        </section>
    );
}

function ConnectedBadges() {
    const [html, setHtml] = useState('');
    useEffect(() => {
        let live = true;
        api.renderConnectedBadgesHtml?.().then((markup: string) => { if (live) setHtml(markup || ''); });
        return () => { live = false; };
    }, []);
    if (!html) return null;
    // brand marks from oauth.ts's own constants
    return <div className="profile-connected-badges" style={{ display: 'flex' }} dangerouslySetInnerHTML={{ __html: html }} />;
}

function CommentBox() {
    const [text, setText] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    async function post() {
        if (!text.trim() || busy) return;
        setBusy(true);
        setError('');
        const problem: string = await api.submitProfileComment(text);
        setBusy(false);
        if (problem) setError(problem);
        else setText('');
    }
    return (
        <div className="profile-comment-box" style={{ display: 'flex' }}>
            <textarea maxLength={1000} rows={3} placeholder="Say hello..." value={text} onChange={e => setText(e.target.value)} />
            <div className="profile-comment-actions">
                <span className="auth-modal-error">{error}</span>
                <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={post}>Post Comment</button>
            </div>
        </div>
    );
}

// ==================== editing your own ====================

function Note({ message }: { message: Message | null }) {
    return <p className="auth-modal-error" style={message?.ok ? { color: 'var(--success, #22c55e)' } : undefined}>{message?.text || ''}</p>;
}

function EditProfile({ profile }: { profile: any }) {
    const user = state.user!;
    const [displayName, setDisplayName] = useState(user.displayName || '');
    const [bio, setBio] = useState(profile.bio || '');
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<string>(user.avatarUrl || '');
    const [detailsMsg, setDetailsMsg] = useState<Message | null>(null);
    const [saving, setSaving] = useState(false);

    function chooseAvatar(event: ChangeEvent<HTMLInputElement>) {
        const chosen = event.target.files?.[0] || null;
        setDetailsMsg(null);
        if (!chosen) return;
        const problem: string = api.avatarFileProblem(chosen);
        if (problem) { setDetailsMsg({ text: problem }); event.target.value = ''; return; }
        setFile(chosen);
        const reader = new FileReader();
        reader.onload = () => setPreview(String(reader.result || ''));
        reader.readAsDataURL(chosen);
    }

    async function saveDetails() {
        if (saving) return;
        setSaving(true);
        setDetailsMsg(null);
        try {
            await api.saveProfileDetails({ displayName: displayName.trim(), bio: bio.trim(), file });
        } catch (e: any) {
            setDetailsMsg({ text: e?.message || 'Something went wrong.' });
        } finally {
            setSaving(false);
        }
    }

    return (
        <>
            <div className="profile-page-header profile-page-header-clean">
                <div />
                <div className="profile-page-header-actions">
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.cancelEditOwnProfile()}><Icon name="x" /> Cancel</button>
                    <button className="btn btn-primary btn-sm" type="button" disabled={saving} onClick={saveDetails}>
                        <Icon name="save" /> {saving ? 'Saving…' : 'Save Profile'}
                    </button>
                </div>
            </div>

            <div className="profile-page-grid">
                <section className="panel profile-page-card profile-identity-card">
                    <div className="profile-page-avatar-row">
                        <label className="profile-page-avatar-picker" title="Change picture">
                            {preview
                                ? <img className="profile-avatar-preview" src={preview} alt="" style={{ display: 'block' }} />
                                : <span className="profile-avatar-placeholder" style={{ display: 'flex' }}><Icon name="camera" size={22} /></span>}
                            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={chooseAvatar} />
                        </label>
                        <div>
                            <h3>Customize Profile</h3>
                            <p className="profile-page-handle">{profile.username ? `@${profile.username}` : 'Choose a username'}</p>
                            <p className="profile-avatar-hint">JPG, PNG, or GIF. Max 2MB.</p>
                        </div>
                    </div>
                    <div className="form-group">
                        <label htmlFor="profile-display-name">Display Name</label>
                        <input type="text" id="profile-display-name" maxLength={40} placeholder="e.g., AshK" autoFocus value={displayName} onChange={e => setDisplayName(e.target.value)} />
                    </div>
                    <div className="form-group">
                        <label htmlFor="profile-bio">Bio</label>
                        <textarea id="profile-bio" maxLength={280} rows={4} placeholder="Tell people a little about yourself..." value={bio} onChange={e => setBio(e.target.value)} />
                        <div className="profile-field-hint">280 characters max.</div>
                    </div>
                    <Note message={detailsMsg} />
                </section>

                <UsernameCard />
                <BadgesCard />
                <EmailCard />
                <ConnectedAccounts className="panel profile-page-card" heading={
                    <div className="profile-section-title"><div><h3>Connected Accounts</h3><p>Sign in with a linked account as well as your password. Also editable from Settings → Account.</p></div></div>
                } />
            </div>
        </>
    );
}

function UsernameCard() {
    const user = state.user!;
    const [username, setUsername] = useState(user.username || '');
    const [msg, setMsg] = useState<Message | null>(null);
    const [busy, setBusy] = useState(false);
    async function save() {
        setBusy(true);
        setMsg(null);
        try {
            await api.saveUsername(username);
            setMsg({ text: 'Username updated.', ok: true });
        } catch (e: any) {
            setMsg({ text: e?.message || 'Could not update username.' });
        } finally {
            setBusy(false);
        }
    }
    return (
        <section className="panel profile-page-card">
            <div className="profile-section-title"><div><h3>Username</h3><p>Your username is used to sign in and identify you.</p></div></div>
            <div className="form-group">
                <label htmlFor="profile-username">Username</label>
                <input type="text" id="profile-username" maxLength={20} placeholder="letters, numbers, underscore only" value={username} onChange={e => setUsername(e.target.value)} />
                <div className="profile-field-hint">{api.usernameChangesRemainingText(user.usernameHistory)}</div>
            </div>
            <Note message={msg} />
            <button className="btn btn-secondary auth-submit-btn" type="button" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save Username'}</button>
        </section>
    );
}

function BadgesCard() {
    const user = state.user!;
    const owned: string[] = Array.isArray(user.badges) ? user.badges : [];
    // a badge no longer held can't stay selected
    const initial = (Array.isArray(user.displayBadges) ? user.displayBadges : owned).filter((k: string) => owned.includes(k));
    const [selected, setSelected] = useState<Set<string>>(() => new Set(initial));
    const [msg, setMsg] = useState<Message | null>(null);
    const [busy, setBusy] = useState(false);
    async function save() {
        setBusy(true);
        setMsg(null);
        try {
            await api.saveDisplayedBadges(owned.filter(k => selected.has(k)));
            setMsg({ text: 'Badge display updated.', ok: true });
        } catch (e: any) {
            setMsg({ text: e?.message || 'Could not update badge display.' });
        } finally {
            setBusy(false);
        }
    }
    return (
        <section className="panel profile-page-card">
            <div className="profile-section-title">
                <div><h3>Badges to Show</h3><p>Choose which badges appear on your profile and beside your name.</p></div>
                <span className="profile-badge-count">{owned.filter(k => selected.has(k)).length} of {owned.length} shown</span>
            </div>
            <div className="profile-badges-selection"><BadgePicker owned={owned} selected={selected} onChange={setSelected} /></div>
            <Note message={msg} />
            <button className="btn btn-primary auth-submit-btn" type="button" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save Badge Display'}</button>
        </section>
    );
}

function EmailCard() {
    const user = state.user!;
    const [email, setEmail] = useState(user.hasRealEmail ? user.email || '' : '');
    const [msg, setMsg] = useState<Message | null>(null);
    const [busy, setBusy] = useState<'' | 'save' | 'remove'>('');
    async function save() {
        setBusy('save');
        setMsg(null);
        try {
            await api.saveEmail(email);
            setMsg({ text: 'Email updated. If confirmation is required, check your inbox.', ok: true });
        } catch (e: any) {
            setMsg({ text: e?.message || 'Could not update email.' });
        } finally {
            setBusy('');
        }
    }
    async function remove() {
        setBusy('remove');
        setMsg(null);
        try {
            if (await api.removeAccountEmail()) setMsg({ text: 'Check your current inbox to confirm removal - it takes effect once confirmed.', ok: true });
        } catch (e: any) {
            setMsg({ text: e?.message || 'Could not remove email.' });
        } finally {
            setBusy('');
        }
    }
    return (
        <section className="panel profile-page-card">
            <div className="profile-section-title"><div><h3>Account Email</h3><p>Optional. Use an email for account recovery, or leave the account username-only.</p></div></div>
            <div className="form-group">
                <label htmlFor="profile-email">Account Email</label>
                <input type="email" id="profile-email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder={user.hasRealEmail ? '' : 'No email on file - add one for account recovery'} />
            </div>
            <Note message={msg} />
            <div className="profile-email-actions">
                <button type="button" className="btn btn-secondary profile-email-save-btn" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save Email'}</button>
                {user.hasRealEmail && (
                    <button type="button" className="btn btn-danger profile-email-remove-btn" disabled={!!busy} onClick={remove}>{busy === 'remove' ? 'Removing…' : 'Remove Email'}</button>
                )}
            </div>
        </section>
    );
}
