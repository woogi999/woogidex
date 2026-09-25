// tells the boot guard at the bottom of index.html the module graph executed,
// so it can explain an empty shell instead of leaving it unexplained
window.__woogidexBooted = true;
import { log } from './log.ts';
import * as updates from '../features/updates.ts';
import { SELECTABLE_TYPES, POKEMON_COLORS } from './data.ts';
import * as data from './data.ts';
import * as editor from '../editor/editor.ts';
import * as sampleSets from '../editor/sample-sets.ts';
import * as editorCore from '../editor/editor-core.ts';
import * as pokedex from '../features/pokedex.ts';
import * as storage from './storage.ts';
import * as exporter from '../export/export.ts';
import * as showdownExport from '../export/showdown-export.ts';
import * as essentialsExport from '../export/essentials-export.ts';
import * as evolution from '../features/evolution.ts';
import * as analysis from '../features/analysis.ts';
import * as auth from '../features/auth.ts';
import * as community from '../features/community.ts';
import * as notifications from './notifications.ts';
import * as moderation from './moderation.ts';
import * as events from '../features/contests.ts';
import * as battleUI from '../battle/ui/battle-ui.ts';
import * as abilityBlocks from '../editor/ability-blocks.ts';
import * as nameRoll from '../tools/name-roll.ts';
import * as fieldRoll from '../tools/field-roll.ts';
import * as protect from './protect.ts';
import * as router from './router.ts';
import * as recovery from '../features/recovery.ts';
import * as cloudSave from '../features/cloud-save.ts';
import * as siteNotice from '../features/site-notice.ts';
import * as legal from '../features/legal.ts';
import { mountPages } from '../app/mount.tsx';
import { mountDialogHost } from '../app/dialogs.tsx';
import { notify, markViewShown } from '../app/store.ts';
import { pushToast } from '../app/shell/Toasts.tsx';
import * as accountDeletion from '../features/account-deletion.ts';
import * as oauth from '../features/oauth.ts';
import * as globalSearch from '../features/global-search.ts';
import * as regions from '../features/regions.ts';
import * as customTypes from '../features/custom-types.ts';
import * as entityArt from '../editor/entity-art.ts';
import * as feedback from '../features/feedback.ts';
import { maybeShowOriginNotice } from './dev-notice.ts';
import { initArtShield } from './art-shield.ts';
import { initAvatars } from './avatar.ts';

import { state } from '../app/state.ts';
export { state };

// every module's exports, merged below; reached through here to avoid import cycles
export const api: Record<string, any> = {};

function loadDarkMode() {
            const saved = localStorage.getItem('woogidex-dark-mode');
            if (saved === 'true') {
                document.documentElement.setAttribute('data-theme', 'dark');
                updateDarkModeUI(true);
            } else {
                document.documentElement.removeAttribute('data-theme');
                updateDarkModeUI(false);
            }
        }
        // where the last click or tap landed: the theme change spreads out from there
        let themeOrigin: any = null;
        document.addEventListener('pointerdown', e => { themeOrigin = { x: e.clientX, y: e.clientY }; }, true);

        function applyDarkMode(dark) {
            if (dark) document.documentElement.setAttribute('data-theme', 'dark');
            else document.documentElement.removeAttribute('data-theme');
            try { localStorage.setItem('woogidex-dark-mode', String(dark)); } catch {}
            updateDarkModeUI(dark);
        }

        // The new theme is revealed through a circle that grows from the switch
        // (View Transitions; css/tokens.css turns off the default cross-fade).
        // Without support, or with reduced motion, it just switches.
        function toggleDarkMode() {
            const dark = document.documentElement.getAttribute('data-theme') !== 'dark';
            const reduced = document.documentElement.classList.contains('reduce-motion')
                || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            if (!document.startViewTransition || reduced) { applyDarkMode(dark); return; }
            const x = themeOrigin?.x ?? innerWidth / 2;
            const y = themeOrigin?.y ?? innerHeight / 2;
            const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
            const transition = document.startViewTransition(() => applyDarkMode(dark));
            transition.ready.then(() => {
                document.documentElement.animate(
                    { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
                    { duration: 560, easing: 'cubic-bezier(.4, 0, .2, 1)', pseudoElement: '::view-transition-new(root)' }
                );
            }).catch(() => {});
        }
        // the switch in the header's account menu; the Settings page reads isDarkModeEnabled()
        function updateDarkModeUI(isDark) {
            notify();
        }

// ---- boolean settings ----
// each entry gets get/set/toggle<Name> generated below, so adding a setting is
// one row instead of three functions. `apply` runs on load+change (DOM state),
// `onChange` only on change (re-renders).
const BOOLEAN_SETTINGS = {
    FadeUselessMoves: {
        storageKey: 'woogidex-fade-useless-moves', defaultValue: true,
        onChange: () => api.updatePreview?.()
    },
    Use2DSprites: {
        storageKey: 'woogidex-use-2d-sprites', defaultValue: false,
        onChange: () => {
            // the template picker's sprites
            notify();
            api.updateBulkComparison?.();
        }
    },
    IncludeOwnFakemonsInBulkComparison: {
        storageKey: 'woogidex-include-own-fakemons-bulk', defaultValue: false,
        onChange: () => api.updateBulkComparison?.()
    },
    IncludeOwnFakemonsInRecommendedMoves: {
        storageKey: 'woogidex-include-own-fakemons-recommended', defaultValue: false
    },
    ShowCollectionCardDate: {
        storageKey: 'woogidex-show-card-date', defaultValue: true,
        onChange: () => api.renderCollection?.()
    },
    ReduceMotion: {
        storageKey: 'woogidex-reduce-motion', defaultValue: false,
        apply: (enabled) => document.documentElement.classList.toggle('reduce-motion', enabled)
    },
    OverlayBlur: {
        storageKey: 'woogidex-overlay-blur', defaultValue: true,
        apply: (enabled) => document.documentElement.classList.toggle('no-overlay-blur', !enabled)
    },
    ConfirmBeforeDelete: {
        storageKey: 'woogidex-confirm-before-delete', defaultValue: true
    },
    AutoplayCry: {
        storageKey: 'woogidex-autoplay-cry', defaultValue: false
    },
    AlwaysShowCardActions: {
        storageKey: 'woogidex-always-show-card-actions', defaultValue: false,
        apply: (enabled) => document.documentElement.classList.toggle('always-show-card-actions', enabled)
    }
};

function readSetting(spec) {
    const stored = localStorage.getItem(spec.storageKey);
    return stored === null ? spec.defaultValue : stored === 'true';
}

const settingsApi: Record<string, any> = {};
for (const [name, spec] of Object.entries<any>(BOOLEAN_SETTINGS)) {
    settingsApi[`get${name}`] = () => readSetting(spec);
    settingsApi[`set${name}`] = (enabled) => {
        localStorage.setItem(spec.storageKey, enabled ? 'true' : 'false');
        spec.apply?.(enabled);
        updateSettingsUI();
        spec.onChange?.();
    };
    settingsApi[`toggle${name}`] = () => settingsApi[`set${name}`](!readSetting(spec));
}

function isDarkModeEnabled() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
}

// the tab the next Settings visit opens on (js/app/pages/SettingsPage.tsx takes it)
let settingsTabRequest = 'appearance';
function takeSettingsTab() {
    const tab = settingsTabRequest;
    settingsTabRequest = 'appearance';
    return tab;
}

function openSettings(tab = 'appearance') {
    log.debug('SETTINGS', 'Opening settings page');
    settingsTabRequest = typeof tab === 'string' ? tab : 'appearance';
    api.activateTopLevelView?.('settings-view');
    api.setRoute?.('settings', 'Settings');
}

// the Settings page renders from the settings themselves; this just tells it to
function updateSettingsUI() {
    notify();
}

function loadSettings() {
    for (const spec of Object.values<any>(BOOLEAN_SETTINGS)) spec.apply?.(readSetting(spec));
    updateSettingsUI();
}


/** A note in the corner for three seconds (js/app/shell/Toasts.tsx). Plain text. */
function showToast(message, type = 'info') {
    log.info('TOAST', `${type}: ${message}`);
    pushToast(message, type);
}

        

// keeps the address bar/title in sync with the current view. Opening a page
// adds a history entry (router.navigateRoute), so Back and Forward walk the
// pages visited; see router.ts.
const BASE_TITLE = 'Woogidex';
function setPageTitle(subtitle) {
    document.title = subtitle ? `${subtitle} · ${BASE_TITLE}` : BASE_TITLE;
}
function setRoute(path, title) {
    setPageTitle(title);
    router.navigateRoute(path);
}

// all full-page views live under #main-content; visibility is kept in one
// place so a new page can't leave a previously-open view stranded underneath it
const TOP_LEVEL_VIEW_IDS = [
    'collection-view',
    'editor-view',
    'ability-block-editor-view',
    'community-view',
    'community-detail-view',
    'battle-view',
    'profile-view',
    'legal-view',
    'settings-view',
    'updates-view',
    'search-view',
    'not-found-view'
];

// Views that open as a sheet over another page rather than replacing it,
// mapped to the page they sit on. The editor slides in over My Collection.
const SHEET_VIEWS = { 'editor-view': 'collection-view' };

function activateTopLevelView(viewId, options: Record<string, any> = {}) {
    const { preserveAbilityEditor = false } = options;

    if (viewId !== 'ability-block-editor-view' && !preserveAbilityEditor) {
        api.onTopLevelNavigation?.(viewId);
    }

    // drop lobby presence when leaving battle so you don't linger in "online" lists
    const leavingBattle = document.getElementById('battle-view')?.style.display === 'block' && viewId !== 'battle-view';
    if (leavingBattle) api.onBattleViewLeave?.();

    // a library editor panel belongs to My Collection; leaving closes it
    document.querySelectorAll('.modal-overlay.as-sheet.active').forEach(el => el.classList.remove('active'));

    // a sheet keeps (or brings up) the page it belongs over
    const pageId = SHEET_VIEWS[viewId] || viewId;
    const pageWasShowing = document.getElementById(pageId)?.style.display === 'block';
    const targetWasShowing = document.getElementById(viewId)?.style.display === 'block';


    TOP_LEVEL_VIEW_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = (id === viewId || id === pageId) ? 'block' : 'none';
    });

    // the shell reads these: the sidebar only exists on My Collection, the 404
    // hides the header, and an open sheet locks the page scroll behind it
    document.body.dataset.page = pageId;
    document.body.classList.toggle('editor-sheet-open', viewId === 'editor-view');

    // the page under a sheet stays put; only what just appeared animates in
    const target = document.getElementById(viewId);
    const page = document.getElementById(pageId);
    if (page && page !== target && !pageWasShowing) {
        page.classList.remove('top-level-view-enter');
        void page.offsetWidth;
        page.classList.add('top-level-view-enter');
    }
    // a sheet has its own slide-in (css/editor.css); the page enter animation's
    // transform would also re-anchor the sheet's fixed-position scrim
    if (target && !SHEET_VIEWS[viewId] && !targetWasShowing) {
        // force a reflow so the enter animation replays (same trick as switchTab())
        target.classList.remove('top-level-view-enter');
        void target.offsetWidth;
        target.classList.add('top-level-view-enter');
    }

    // a React page refetches what it shows each time it opens (useViewShown)
    markViewShown(viewId);
    return target || null;
}

log.setContext({ state, api });

Object.assign(api, data, editor, sampleSets, editorCore, pokedex, storage, exporter, showdownExport, essentialsExport, evolution, analysis, auth, community, notifications, moderation, events, battleUI, abilityBlocks, nameRoll, fieldRoll, protect, router, recovery, cloudSave, siteNotice, legal, accountDeletion, oauth, globalSearch, regions, customTypes, entityArt, feedback, updates, settingsApi, {
    loadDarkMode, toggleDarkMode, updateDarkModeUI, openSettings, takeSettingsTab, isDarkModeEnabled,
    setRoute, setPageTitle, activateTopLevelView,
    updateSettingsUI, loadSettings, showToast
});

// header retracts on downward scroll, reveals on scroll up or pointer near top
let lastScrollY = 0;
let headerScrollTick = false;
let headerHoverRevealTimer: any = null;
function showDynamicHeader() {
    const header = document.querySelector('.header');
    if (!header) return;
    header.classList.remove('header-retracted');
}
function updateDynamicHeader() {
    const header = document.querySelector('.header');
    if (!header) return;
    const y = window.scrollY || 0;
    const delta = y - lastScrollY;
    if (y <= 8) showDynamicHeader();
    else if (delta > 5) header.classList.add('header-retracted');
    else if (delta < -5) showDynamicHeader();
    lastScrollY = y;
    headerScrollTick = false;
}
window.addEventListener('scroll', () => {
    if (!headerScrollTick) { headerScrollTick = true; requestAnimationFrame(updateDynamicHeader); }
}, { passive: true });
window.addEventListener('mousemove', (event) => {
    if (event.clientY <= 14) {
        clearTimeout(headerHoverRevealTimer);
        headerHoverRevealTimer = setTimeout(showDynamicHeader, 40);
    }
}, { passive: true });
window.addEventListener('touchstart', (event) => {
    if (event.touches?.[0]?.clientY <= 18) showDynamicHeader();
}, { passive: true });

document.addEventListener('DOMContentLoaded', async () => {
    const done = log.time('BOOT', 'Application initialization');
    log.info('BOOT', 'DOMContentLoaded fired');
    // the pages, the shell around them, and the dialog layer (js/app)
    mountPages();
    mountDialogHost();
    // rewrite old #hash links before anything reads the route
    router.migrateLegacyHash();
    const bootRoute = router.currentRoute();
    // paint a skeleton for the current route immediately so the first frame
    // has the right shape instead of sitting blank until data loads;
    // handleRoute() below does the real reveal/fetch and replaces it
    switch (bootRoute.name) {
        case '':
        case 'collection':
            api.renderCollectionSkeleton?.();
            break;
        case 'community':
            api.renderCommunityGridSkeleton?.();
            break;
        case 'events':
            api.renderEventsSkeleton?.();
            break;
        case 'battle':
            api.renderBattleSkeleton?.();
            break;
        case 'profile':
            api.renderProfileLoading?.();
            break;
        // editor/ability-editor open a specific Fakemon that only exists after
        // loadFromStorage() resolves, so there's nothing to skeleton yet
    }
    await api.initAuth();
    await api.loadFromStorage();
    // custom types join the shared type lists before anything draws a type picker
    api.syncCustomTypes?.(true);
    // Showdown data (moves/abilities/items/pokedex, 1MB+) is only needed
    // up front by routes that look something up in it before rendering
    // (editor, community preview, battle); the collection grid draws only
    // from the Fakemon's own saved fields, so it doesn't block on this fetch.
    // Callers elsewhere show their own loading state if they beat it (see
    // state.sdLoaded checks in editor.ts/analysis.ts/pokedex.ts).
    const NEEDS_SHOWDOWN_DATA_UP_FRONT = new Set(['editor', 'ability-editor', 'community', 'events', 'battle']);
    const showdownDataPromise = api.fetchShowdownData?.();
    if (NEEDS_SHOWDOWN_DATA_UP_FRONT.has(bootRoute.name)) await showdownDataPromise;
    // learnsets.json (3.2 MB) warms in the background; callers await api.ensureLearnsets() themselves
    api.ensureLearnsets?.();
    // opening the page the address already names must not add an entry
    const handled = await router.replacingHistory(() => handleRoute(bootRoute));
    if (!handled) api.renderCollection();
    loadDarkMode();
    loadSettings();
    api.initContentProtection?.();
    initArtShield();
    // avatars come from the same masked pipe artwork does; this hands the
    // module a client getter rather than letting it import the feature layer
    initAvatars(() => api.getClient());
    api.updateEditorStats();
    done({ fakemons: state.fakemonDB.length, sdLoaded: state.sdLoaded });
    log.info('BOOT', 'Application ready', { fakemons: state.fakemonDB.length, sdLoaded: state.sdLoaded });
    // empty collection on a local origin looks like data loss; see dev-notice.ts
    maybeShowOriginNotice(state.fakemonDB.length);
    // Order matters. A collection that did not load, or that came up empty on a
    // device that had Fakemon, is the only thing worth showing first: it tells
    // the user not to create anything yet, and its own buttons lead to the
    // recovery scan. Otherwise recovery takes priority over the transfer notice;
    // recovery.ts shows the transfer notice itself once it is done (restored,
    // dismissed, or nothing found).
    if (!api.maybeWarnAboutCollectionHealth?.()) {
        if (!(await api.checkForLostFakemon?.())) api.maybeShowSiteTransferNotice?.();
    }
    // the unread count on the header's Updates tab
    updates.refreshUpdatesBadge();
});

// restores whichever page a URL names, on load and on back/forward, so both
// paths can never diverge. returns true if the route was recognised/opened.
async function handleRoute(route) {
    const { name, param } = route;

    if (name === 'community') {
        if (param) return await api.handleCommunityRoute?.(param) === true;
        await api.openCommunityHub?.();
        return true;
    }
    if (name === 'profile') {
        if (!param) return false;
        api.activateTopLevelView?.('profile-view');
        return await api.handleProfileRoute?.(param) === true;
    }
    if (name === 'ability-editor') {
        if (!param) return false;
        api.openAbilityBlockEditor(param);
        return true;
    }
    if (name === 'editor') {
        // a Fakemon this browser doesn't have isn't an error - the collection
        // is local, so the link just isn't for this person; fall through
        if (!param) return false;
        const fakemon = state.fakemonDB.find(f => String(f.id) === param);
        if (!fakemon) return false;
        api.editFakemon(param);
        return true;
    }
    if (name === 'privacy' || name === 'terms') return await legal.openLegalPage(name) === true;
    if (name === 'events') { await api.openEvents?.(); return true; }
    if (name === 'battle') { await api.openBattle?.(); return true; }
    if (name === 'settings') { api.openSettings?.(); return true; }
    if (name === 'search') { await api.openSearchPage?.(new URLSearchParams(window.location.search).get('q') || ''); return true; }
    if (name === 'updates') { await api.openUpdatesPage?.(param === 'credits' ? 'credits' : 'updates'); return true; }
    if (name === 'collection' || name === '') { api.showCollection?.(); return true; }
    if (name === router.NOT_FOUND) { showNotFound(param); return true; }
    return false;
}

// the address bar is left alone so the bad link stays visible and copyable;
// the page (js/app/pages/NotFoundPage.tsx) reads the path from it
function showNotFound(path) {
    activateTopLevelView('not-found-view');
    setPageTitle('Page not found');
    log.info('ROUTER', 'No route for this path', { path });
}

// the browser's back and forward buttons
router.listenForHistory(async (route) => {
    if (!(await handleRoute(route))) api.showCollection?.();
});

// a click on the dimmed page beside the sheet lands on #editor-view itself
// (its ::before is the scrim), and closes the editor like the X does
// (library editor panels are React dialogs, which close themselves the same way)
document.addEventListener('click', (event) => {
    if ((event.target as Element | null)?.id === 'editor-view') api.showCollection?.();
});

// Esc closes the editor sheet, unless a dialog opened from inside it is
// what the key is meant for (those close themselves first)
document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (!document.body.classList.contains('editor-sheet-open')) return;
    if (document.querySelector('.modal-overlay.active, .move-detail-popup')) return;
    // a menu or picker inside the sheet takes the first Esc
    if (document.activeElement?.closest?.('.global-search, .export-as-wrap, .type-dropdown.open')) return;
    api.showCollection?.();
});

export { loadDarkMode, toggleDarkMode, updateDarkModeUI, showToast };