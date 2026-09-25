// Boots the staff panel (admin.html): the theme first so it doesn't flash,
// then the page and its dialog layer, then who is signed in.

import { mountIsland } from '../app/island.tsx';
import { mountDialogHost } from '../app/dialogs.tsx';
import { AdminApp } from './AdminApp.tsx';
import { initAdmin, loadDarkMode } from './core.ts';

loadDarkMode();
mountIsland('admin-root', AdminApp);
mountDialogHost();
initAdmin();
