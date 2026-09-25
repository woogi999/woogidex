// Puts the React pages into the containers the page shell already has
// (#legal-view, #not-found-view, ...). The shell still decides which one is
// showing; each page renders what its route or the shared state says.

import type { ComponentType } from 'react';
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
import { BattlePage } from './pages/BattlePage.tsx';
import { CollectionPage } from './pages/CollectionPage.tsx';
import { EditorPage } from './pages/EditorPage.tsx';
import { AbilityBlockEditorPage } from './pages/AbilityBlockEditorPage.tsx';
import { Header } from './shell/Header.tsx';
import { Sidebar } from './shell/Sidebar.tsx';
import { Toasts } from './shell/Toasts.tsx';

const PAGES: Array<[string, ComponentType]> = [
    ['not-found-view', NotFoundPage],
    ['legal-view', LegalPage],
    ['updates-view', UpdatesPage],
    ['search-view', SearchPage],
    ['settings-view', SettingsPage],
    ['profile-view', ProfilePage],
    ['community-view', CommunityPage],
    ['community-detail-view', CommunityDetailPage],
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
