// Puts the React pages into the containers the page shell already has
// (#legal-view, #not-found-view, ...). The shell still decides which one is
// showing; each page renders what its route or the shared state says.

import { lazy, Suspense, type ComponentType } from 'react';
import { mountIsland } from './island.tsx';
import './dialogs/account.tsx';
import './dialogs/cloudBackup.tsx';
import './dialogs/auth.tsx';
import './dialogs/feedback.tsx';
import './dialogs/roll.tsx';
import './dialogs/confirm.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { LegalPage } from './pages/LegalPage.tsx';
import { UpdatesPage } from './pages/UpdatesPage.tsx';
import { SearchPage } from './pages/SearchPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { ProfilePage } from './pages/ProfilePage.tsx';
import { CommunityPage } from './pages/CommunityPage.tsx';
import { CommunityDetailPage } from './pages/CommunityDetailPage.tsx';
import { PostPage } from './pages/PostPage.tsx';
import { MessagesPage } from './pages/MessagesPage.tsx';
import { useViewShown } from './store.ts';
import { api } from '../core/app.ts';
import { CollectionPage } from './pages/CollectionPage.tsx';
import { EditorPage } from './pages/EditorPage.tsx';
import { AbilityBlockEditorPage } from './pages/AbilityBlockEditorPage.tsx';
import { Header } from './shell/Header.tsx';
import { Sidebar } from './shell/Sidebar.tsx';
import { Toasts } from './shell/Toasts.tsx';

// Battle (its engine, the 3D field, the netcode: a sizeable share of the
// site) only downloads the first time someone opens it. Until then the page
// renders nothing, so mounting it at boot costs nothing either.
// waits for the battle functions to be on `api` too, which the page calls
const BattlePageChunk = lazy(() => Promise.all([import('./pages/BattlePage.tsx'), api.loadBattle()]).then(([m]) => ({ default: m.BattlePage })));
function BattlePage() {
    const shown = useViewShown('battle-view');
    if (!shown) return null;
    return (
        <Suspense fallback={<div className="battle-loading" aria-busy="true"><span className="skel" style={{ display: 'block', height: 420, borderRadius: 'var(--panel-r)' }} /></div>}>
            <BattlePageChunk />
        </Suspense>
    );
}

const PAGES: Array<[string, ComponentType]> = [
    ['not-found-view', NotFoundPage],
    ['legal-view', LegalPage],
    ['updates-view', UpdatesPage],
    ['search-view', SearchPage],
    ['settings-view', SettingsPage],
    ['profile-view', ProfilePage],
    ['community-view', CommunityPage],
    ['community-detail-view', CommunityDetailPage],
    ['post-view', PostPage],
    ['messages-view', MessagesPage],
    ['battle-view', BattlePage],
    ['collection-view', CollectionPage],
    ['editor-view', EditorPage],
    ['ability-block-editor-view', AbilityBlockEditorPage],
    // not pages: the shell around them
    ['app-header', Header],
    ['app-sidebar', Sidebar],
    ['toast-container', Toasts]
];

/** Mounts every React page. Runs once at boot, before the first route opens. */
export function mountPages(): void {
    // rendered at once: the editor's boards are drawn into by other modules straight after boot
    for (const [id, Page] of PAGES) mountIsland(id, Page, {}, { sync: true });
}
