// tells the boot guard at the bottom of index.html the module graph executed,
// so it can explain an empty shell instead of leaving it unexplained
window.__woogidexBooted = true;
import { log } from './log.ts';
import { isLowEndDevice, prefersSavingData, whenIdle } from './device.ts';
import { registerOfflineSupport } from './offline.ts';
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
import * as events from '../features/events.ts';
import * as abilityBlocks from '../editor/ability-blocks.ts';
import * as nameRoll from '../tools/name-roll.ts';
import * as fieldRoll from '../tools/field-roll.ts';
import * as protect from './protect.ts';
import * as router from './router.ts';
import * as recovery from '../features/recovery.ts';
import * as cloudSave from '../features/cloud-save.ts';
import * as legal from '../features/legal.ts';
import { mountPages } from '../app/mount.tsx';
import { mountDialogHost, openDialog } from '../app/dialogs.tsx';
import { notify, markViewShown } from '../app/store.ts';
import { pushToast } from '../app/shell/Toasts.tsx';
import * as accountDeletion from '../features/account-deletion.ts';
import * as oauth from '../features/oauth.ts';
import * as globalSearch from '../features/global-search.ts';
import * as regions from '../features/regions.ts';
import * as customTypes from '../features/custom-types.ts';
import * as entityArt from '../editor/entity-art.ts';
import * as feedback from '../features/feedback.ts';
import * as moveInheritance from '../features/move-inheritance.ts';
import * as social from '../features/social.ts';
import * as messaging from '../features/messaging.ts';
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
    // flat sprites by default on a low-end device: animated 3D models are the
    // heaviest thing the collection and template picker can draw
    Use2DSprites: {
        storageKey: 'woogidex-use-2d-sprites', defaultValue: isLowEndDevice(),
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
        storageKey: 'woogidex-overlay-blur', defaultValue: !isLowEndDevice(),
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
    },
    // the editor sheet covers the whole window under the header instead of the right side
    EditorFullscreen: {
        storageKey: 'woogidex-editor-fullscreen', defaultValue: false,
        apply: (enabled) => document.documentElement.classList.toggle('editor-fullscreen', enabled)
    },
    // the "did not load" / "looks empty" save locks in js/core/storage.ts
    CollectionSafetyChecks: {
        storageKey: 'woogidex-collection-safety-checks', defaultValue: true,
        onChange: () => api.closeCollectionWarning?.()
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

// the section the next Settings visit opens on (js/app/pages/SettingsPage.tsx
// takes it). '' is "none in particular": the first section on a wide screen,
// the list of sections on a phone.
let settingsTabRequest = '';
function takeSettingsTab() {
    const tab = settingsTabRequest;
    settingsTabRequest = '';
    return tab;
}

function openSettings(tab = '') {
    log.debug('SETTINGS', 'Opening settings page');
    settingsTabRequest = typeof tab === 'string' ? tab : '';
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
    setMeta('og:title', document.title);
    setMeta('twitter:title', document.title);
}

// The share card for whatever is on screen. Link previews on other sites come
// from worker/index.js (bots don't run this code); this keeps the live page's
// own tags in step, which the browser's share sheet and some apps read.
const DEFAULT_SHARE = (() => {
    const read = (sel: string) => document.querySelector<HTMLMetaElement>(sel)?.content || '';
    return { description: read('meta[name="description"]'), image: read('meta[property="og:image"]') };
})();
function setMeta(key: string, value: string) {
    const attr = key.startsWith('og:') ? 'property' : 'name';
    const el = document.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
    if (el && value) el.content = value;
}
function setShareMeta({ title = '', description = '', image = '' }: { title?: string; description?: string; image?: string } = {}) {
    if (title) setPageTitle(title);
    const desc = description || DEFAULT_SHARE.description;
    setMeta('description', desc);
    setMeta('og:description', desc);
    setMeta('twitter:description', desc);
    setMeta('og:image', image || DEFAULT_SHARE.image);
    setMeta('twitter:image', image || DEFAULT_SHARE.image);
    setMeta('og:url', window.location.href.split('#')[0]);
}
router.onRouteChange(() => setMeta('og:url', window.location.href.split('#')[0]));

function setRoute(path, title) {
    setPageTitle(title);
    setShareMeta();
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
    'post-view',
    'messages-view',
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
    // the guest view of a public event is one page only; anything else ends it
    document.body.classList.remove('event-guest');

    if (viewId !== 'ability-block-editor-view' && !preserveAbilityEditor) {
        api.onTopLevelNavigation?.(viewId);
    }

    // drop lobby presence when leaving battle so you don't linger in "online" lists
    const leavingBattle = document.getElementById('battle-view')?.style.display === 'block' && viewId !== 'battle-view';
    if (leavingBattle) api.onBattleViewLeave?.();

    // a community post's borrowed custom types only apply while it's open
    if (viewId !== 'community-detail-view') api.setVisitingTypes?.([]);

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
    // nearly every editor tool reads the Showdown data; don't make it wait for
    // the idle moment boot left it for (memoised, so a no-op once loaded)
    if (viewId === 'editor-view') api.fetchShowdownData?.();

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

// Battle loads on first use (js/app/mount.tsx draws its page lazily too).
// Until then these stand in for the few battle functions the rest of the site
// calls; loading the module puts every real one on `api`, replacing them.
let battleModule: Promise<any> | null = null;
function loadBattle() {
    return battleModule ||= import('../battle/ui/battle-ui.ts').then(m => { Object.assign(api, m); return m; });
}
const battleStubs = {
    loadBattle,
    // ponytail: battles are switched off until the new simulator lands; restore
    // `loadBattle().then(m => m.openBattle(...args))` to bring them back
    openBattle: () => openDialog('battle-paused', {}),
    renderBattleSkeleton: (...args: any[]) => loadBattle().then(m => m.renderBattleSkeleton(...args)),
    // only ever asked once a battle is running, by which point the real one is in place
    battleMoveChoices: () => [],
    pickBattleMove: () => false,
    onBattleViewLeave: (...args: any[]) => { battleModule?.then(m => m.onBattleViewLeave?.(...args)); }
};

Object.assign(api, data, editor, sampleSets, editorCore, pokedex, storage, exporter, showdownExport, essentialsExport, evolution, analysis, auth, community, notifications, moderation, events, battleStubs, abilityBlocks, nameRoll, fieldRoll, protect, router, recovery, cloudSave, legal, accountDeletion, oauth, globalSearch, regions, customTypes, entityArt, feedback, moveInheritance, social, messaging, updates, settingsApi, {
    loadDarkMode, toggleDarkMode, updateDarkModeUI, openSettings, takeSettingsTab, isDarkModeEnabled,
    setRoute, setPageTitle, setShareMeta, activateTopLevelView,
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
    // theme and settings are local: apply them before anything paints, so a
    // slow or unreachable backend never leaves the page in the wrong theme
    loadDarkMode();
    loadSettings();
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
        case 'profile':
            api.renderProfileLoading?.();
            break;
        // editor/ability-editor open a specific Fakemon that only exists after
        // loadFromStorage() resolves, so there's nothing to skeleton yet
    }
    // The collection lives on this device and does not depend on the account,
    // so reading it never waits on auth. It used to: a sign-in that threw or
    // hung (Supabase blocked, offline with an expired token, a stale chunk
    // after a deploy) meant loadFromStorage() never ran, and every save was
    // refused with "Your Collection Did Not Load" on every reload.
    const authDone = Promise.resolve().then(() => api.initAuth())
        .catch(e => log.error('BOOT', 'Sign-in setup failed; carrying on signed out', e));
    await api.loadFromStorage();
    // Supabase being down must not hold the page hostage: everything local
    // works without it. Wait briefly so a restored session is there for the
    // first route, then go on; the header catches up when auth settles.
    // Pages that live on this device don't wait at all.
    // ponytail: fixed 2.5s cap, tune if slow networks sign in late too often
    const LOCAL_ROUTES = new Set(['', 'collection', 'editor', 'ability-editor', 'battle', 'settings', 'privacy', 'terms']);
    if (!LOCAL_ROUTES.has(bootRoute.name)) await Promise.race([authDone, new Promise(r => setTimeout(r, 2500))]);
    // custom types join the shared type lists before anything draws a type picker
    api.syncCustomTypes?.(true);
    // Showdown data (moves/abilities/items/pokedex, 1MB+) is only needed
    // up front by routes that look something up in it before rendering
    // (editor, community preview, battle); the collection grid draws only
    // from the Fakemon's own saved fields, so it doesn't block on this fetch.
    // Callers elsewhere show their own loading state if they beat it (see
    // state.sdLoaded checks in editor.ts/analysis.ts/pokedex.ts).
    const NEEDS_SHOWDOWN_DATA_UP_FRONT = new Set(['editor', 'ability-editor', 'community', 'events']);
    if (NEEDS_SHOWDOWN_DATA_UP_FRONT.has(bootRoute.name)) await api.fetchShowdownData?.();
    // Everywhere else it waits for the first quiet moment, so parsing ~1 MB of
    // JSON doesn't land on top of the first render (seconds, on a cheap phone).
    // learnsets.json (3.2 MB) warms after it; callers await api.ensureLearnsets()
    // themselves, so a low-end device or Data Saver skips the warm-up entirely.
    else whenIdle(() => api.fetchShowdownData?.());
    if (!isLowEndDevice() && !prefersSavingData()) whenIdle(() => api.ensureLearnsets?.(), 8000);
    // opening the page the address already names must not add an entry
    // not awaited: a route waiting on the network shows its skeleton while
    // the rest of boot (offline support, art shield, notices) carries on
    router.replacingHistory(() => handleRoute(bootRoute))
        .then(handled => { if (!handled) api.renderCollection(); })
        .catch(e => { log.error('BOOT', 'Could not open the first page', e); api.showCollection?.(); });
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
    // recovery scan. Otherwise the lost-Fakemon scan runs.
    if (!api.maybeWarnAboutCollectionHealth?.()) await api.checkForLostFakemon?.();
    // the unread count on the header's Updates tab
    updates.refreshUpdatesBadge();
    // keeps the site usable offline (js/core/offline.ts)
    registerOfflineSupport();
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
    if (name === 'post') {
        if (!param) return false;
        return await api.openPost?.(param, { preserveRoute: true }) === true;
    }
    if (name === 'messages') return await api.handleMessagesRoute?.(param) === true;
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
    if (name === 'events') { await api.openEvents?.(param); return true; }
    if (name === 'battle') { api.showCollection?.(); api.openBattle?.(); return true; }
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