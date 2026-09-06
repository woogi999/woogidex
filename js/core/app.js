// tells the boot guard at the bottom of index.html the module graph executed,
// so it can explain an empty shell instead of leaving it unexplained
window.__woogidexBooted = true;
import './vendor.js';
// registers the updates globals on window; destructure below still finds them
// since ES modules finish every import before this module's body runs
import '../features/updates.js';
import { log } from './log.js';
const { openUpdatesModal, closeUpdatesModal, renderUpdates, loadUpdates } = window;
import { POKEMON_TYPES, POKEMON_COLORS } from './data.js';
import * as data from './data.js';
import * as editor from '../editor/editor.js';
import * as sampleSets from '../editor/sample-sets.js';
import * as editorCore from '../editor/editor-core.js';
import * as pokedex from '../features/pokedex.js';
import * as storage from './storage.js';
import * as exporter from '../export/export.js';
import * as showdownExport from '../export/showdown-export.js';
import * as essentialsExport from '../export/essentials-export.js';
import * as evolution from '../features/evolution.js';
import * as analysis from '../features/analysis.js';
import * as auth from '../features/auth.js';
import * as community from '../features/community.js';
import * as notifications from './notifications.js';
import * as moderation from './moderation.js';
import * as events from './events.js';
import * as battleUI from '../battle/ui/battle-ui.js';
import * as abilityBlocks from '../editor/ability-blocks.js';
import * as nameRoll from '../tools/name-roll.js';
import * as fieldRoll from '../tools/field-roll.js';
import * as protect from './protect.js';
import * as views from './views.js';
import * as router from './router.js';
import * as recovery from '../features/recovery.js';
import * as cloudSave from '../features/cloud-save.js';
import * as siteNotice from '../features/site-notice.js';
import * as legal from '../features/legal.js';
import * as accountDeletion from '../features/account-deletion.js';
import * as oauth from '../features/oauth.js';
import { maybeShowOriginNotice } from './dev-notice.js';
import { initArtShield } from './art-shield.js';
import { initAvatars, paintAvatarSlots } from './avatar.js';

export const state = {
    sdMoves: {},
    sdAbilities: {},
    sdItems: {},
    sdPokedex: {},
    sdLearnsets: {},
    sdLearnsetsLoaded: false,
    pokeApiSpeciesCache: {},
    sdMoveUsefulness: {},
    sdLoaded: false,
    fakemonDB: [],
    folders: [],
    customMoves: [],
    customAbilities: [],
    customItems: [],
    battleTeams: [],
    currentFolderId: null,
    editingId: null,
    // NOTE: editor draft and saved library share customMoves/customAbilities
    // names; worth splitting into a separate draft object eventually
    abilities: [],
    learnset: [],
    sampleSets: [],
    artworkData: null,
    shinyArtworkData: null,
    cryData: null,
    artCredit: null,
    artworkMode: 'normal',
    previewArtworkMode: 'normal',
    collectionShinyPreview: localStorage.getItem('woogidex-collection-shiny-preview') === 'true',
    autoSaveTimer: null,
    lastSavedId: null,
    evolutionGraph: null,
    profilePageUser: null,
    profilePageEditing: false
};

export const api = {};

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
        function toggleDarkMode() {
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            if (isDark) {
                document.documentElement.removeAttribute('data-theme');
                localStorage.setItem('woogidex-dark-mode', 'false');
                updateDarkModeUI(false);
            } else {
                document.documentElement.setAttribute('data-theme', 'dark');
                localStorage.setItem('woogidex-dark-mode', 'true');
                updateDarkModeUI(true);
            }
        }
        function updateDarkModeUI(isDark) {
            const btn = document.getElementById('dark-mode-btn');
            // fixed selector rather than the icon's id: lucide.createIcons() swaps
            // the <i data-lucide> for a fresh <svg>, so the id wouldn't be stable
            const sidebarBtn = document.querySelector('.sidebar-nav-btn[onclick*="toggleDarkMode"]');
            const sidebarLabel = document.getElementById('sidebar-dark-label');
            const iconName = isDark ? 'sun' : 'moon';
            const iconMarkup = `<i data-lucide="${iconName}" id="sidebar-dark-icon" style="width:18px;height:18px;"></i>`;

            if (btn) {
                btn.innerHTML = `<i data-lucide="${iconName}" style="width:20px;height:20px;"></i>`;
                btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
                btn.setAttribute('title', isDark ? 'Switch to light mode' : 'Switch to dark mode');
            }
            if (sidebarBtn) {
                const currentIcon = sidebarBtn.querySelector('[data-lucide], svg');
                if (currentIcon) currentIcon.outerHTML = iconMarkup;
            }
            if (sidebarLabel) sidebarLabel.textContent = isDark ? 'Light Mode' : 'Dark Mode';
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

// ---- boolean settings ----
// each entry gets get/set/toggle<Name> generated below, so adding a setting is
// one row instead of three functions. `apply` runs on load+change (DOM state),
// `onChange` only on change (re-renders).
const BOOLEAN_SETTINGS = {
    FadeUselessMoves: {
        storageKey: 'woogidex-fade-useless-moves', defaultValue: true, toggleId: 'settings-fade-toggle',
        onChange: () => api.updatePreview?.()
    },
    Use2DSprites: {
        storageKey: 'woogidex-use-2d-sprites', defaultValue: false, toggleId: 'settings-2d-sprites-toggle',
        onChange: () => {
            if (document.getElementById('pokemon-template-modal')?.classList.contains('active')) api.renderPokemonTemplateChooser?.();
            api.updateBulkComparison?.();
        }
    },
    IncludeOwnFakemonsInBulkComparison: {
        storageKey: 'woogidex-include-own-fakemons-bulk', defaultValue: false, toggleId: 'settings-own-bulk-toggle',
        onChange: () => api.updateBulkComparison?.()
    },
    IncludeOwnFakemonsInRecommendedMoves: {
        storageKey: 'woogidex-include-own-fakemons-recommended', defaultValue: false, toggleId: 'settings-own-recommended-toggle'
    },
    ShowCollectionCardDate: {
        storageKey: 'woogidex-show-card-date', defaultValue: true, toggleId: 'settings-card-date-toggle',
        onChange: () => api.renderCollection?.()
    },
    ReduceMotion: {
        storageKey: 'woogidex-reduce-motion', defaultValue: false, toggleId: 'settings-reduce-motion-toggle',
        apply: (enabled) => document.documentElement.classList.toggle('reduce-motion', enabled)
    },
    OverlayBlur: {
        storageKey: 'woogidex-overlay-blur', defaultValue: true, toggleId: 'settings-sidebar-blur-toggle',
        apply: (enabled) => document.documentElement.classList.toggle('no-overlay-blur', !enabled)
    },
    ConfirmBeforeDelete: {
        storageKey: 'woogidex-confirm-before-delete', defaultValue: true, toggleId: 'settings-confirm-delete-toggle'
    },
    AutoplayCry: {
        storageKey: 'woogidex-autoplay-cry', defaultValue: false, toggleId: 'settings-autoplay-cry-toggle'
    },
    AlwaysShowCardActions: {
        storageKey: 'woogidex-always-show-card-actions', defaultValue: false, toggleId: 'settings-always-show-actions-toggle',
        apply: (enabled) => document.documentElement.classList.toggle('always-show-card-actions', enabled)
    }
};

function readSetting(spec) {
    const stored = localStorage.getItem(spec.storageKey);
    return stored === null ? spec.defaultValue : stored === 'true';
}

const settingsApi = {};
for (const [name, spec] of Object.entries(BOOLEAN_SETTINGS)) {
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

function openSettings() {
    log.debug('SETTINGS', 'Opening settings page');
    api.activateTopLevelView?.('settings-view');
    switchSettingsTab(document.querySelector('#settings-tabs .tab'), 'appearance');
    updateSettingsUI();
    api.setRoute?.('settings', 'Settings');
}

function closeSettingsPage() {
    api.showCollection?.();
}

// same .tabs/.tab-content pattern as the editor's switchTab, kept separate
// since the editor's version reaches for editor-only elements
function switchSettingsTab(tabEl, tabName) {
    document.querySelectorAll('#settings-tabs .tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('#settings-view .tab-content').forEach(t => t.style.display = 'none');
    if (tabEl) tabEl.classList.add('active');
    else document.querySelector(`#settings-tabs .tab[onclick*="'${tabName}'"]`)?.classList.add('active');
    const target = document.getElementById(`settings-tab-${tabName}`);
    if (target) target.style.display = 'flex';
}

function updateSettingsUI() {
    // depends on the signed-in user, so settled here on every open rather than at boot
    accountDeletion.updateAccountDeletionUI();
    // only the server knows which accounts are connected / whether a backup exists
    oauth.updateConnectedAccountsUI();
    cloudSave.refreshCloudBackupUI();
    // fall back to Appearance if a signed-out visitor was on the now-hidden Account tab
    const accountTabBtn = document.getElementById('settings-tab-account-btn');
    if (accountTabBtn) {
        const wasVisible = accountTabBtn.style.display !== 'none';
        accountTabBtn.style.display = state.user ? '' : 'none';
        if (wasVisible && !state.user && accountTabBtn.classList.contains('active')) {
            switchSettingsTab(document.querySelector('#settings-tabs .tab'), 'appearance');
        }
    }
    const darkToggle = document.getElementById('settings-dark-toggle');
    if (darkToggle) darkToggle.checked = isDarkModeEnabled();
    for (const spec of Object.values(BOOLEAN_SETTINGS)) {
        const el = document.getElementById(spec.toggleId);
        if (el) el.checked = readSetting(spec);
    }
}

function loadSettings() {
    for (const spec of Object.values(BOOLEAN_SETTINGS)) spec.apply?.(readSetting(spec));
    updateSettingsUI();
}


function showToast(message, type = 'info') {
            log.info('TOAST', `${type}: ${message}`);
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            const icons = { success: 'check-circle-2', error: 'circle-x', info: 'info', warning: 'triangle-alert' };
            const iconName = icons[type] || icons.info;
            toast.innerHTML = `<i data-lucide="${iconName}" class="toast-icon" aria-hidden="true"></i><span>${message}</span>`;
            container.appendChild(toast);
            if (typeof lucide !== 'undefined') lucide.createIcons();
            setTimeout(() => { toast.style.animation = 'slideOut 0.3s ease forwards'; setTimeout(() => toast.remove(), 300); }, 3000);
        }

        

// ==================== init helpers ====================
        function initTypeSelects() {
            const type1Menu = document.getElementById('type1-menu');
            const type2Menu = document.getElementById('type2-menu');
            const makeOption = (type, dropdownId) => {
                if (!type) return `<div class="type-dropdown-option" onclick="selectType('${dropdownId}', ''); event.stopPropagation();"><span>None</span></div>`;
                const tc = 'type-' + type.toLowerCase();
                return `<div class="type-dropdown-option" onclick="selectType('${dropdownId}', '${type}'); event.stopPropagation();"><span class="type-pill ${tc}">${type}</span></div>`;
            };
            type1Menu.innerHTML = makeOption('', 'type1') + POKEMON_TYPES.map(t => makeOption(t, 'type1')).join('');
            type2Menu.innerHTML = makeOption('', 'type2') + POKEMON_TYPES.map(t => makeOption(t, 'type2')).join('');

            const learnsetTypeMenu = document.getElementById('learnset-filter-type-menu');
            if (learnsetTypeMenu) {
                learnsetTypeMenu.innerHTML = api.buildTypeMenuOptions(t => `selectLearnsetTypeFilter('${t}')`, true, 'All Types');
            }
            const learnsetCatMenu = document.getElementById('learnset-filter-category-menu');
            if (learnsetCatMenu) {
                learnsetCatMenu.innerHTML = api.buildCatMenuOptions(c => `selectLearnsetCategoryFilter('${c}')`, true, 'All Categories');
            }

            document.addEventListener('click', (e) => {
                if (!e.target.closest('.type-dropdown') && !e.target.closest('.cat-dropdown')) {
                    document.querySelectorAll('.type-dropdown, .cat-dropdown').forEach(d => d.classList.remove('open'));
                }
            });
        }

        function toggleTypeDropdown(which) {
            const dropdown = document.getElementById(which + '-dropdown');
            const isOpen = dropdown.classList.contains('open');
            document.querySelectorAll('.type-dropdown').forEach(d => d.classList.remove('open'));
            if (!isOpen) dropdown.classList.add('open');
        }

        function toggleCatDropdown(which) {
            const dropdown = document.getElementById(which + '-dropdown');
            const isOpen = dropdown.classList.contains('open');
            document.querySelectorAll('.cat-dropdown').forEach(d => d.classList.remove('open'));
            if (!isOpen) dropdown.classList.add('open');
        }

        function selectType(which, type) {
            document.getElementById('fakemon-' + which).value = type;
            const valueEl = document.getElementById(which + '-value');
            if (type) {
                const tc = 'type-' + type.toLowerCase();
                valueEl.innerHTML = '<span class="type-pill ' + tc + '">' + type + '</span>';
            } else {
                valueEl.textContent = which === 'type1' ? 'Select Type' : 'None';
            }
            document.getElementById(which + '-dropdown').classList.remove('open');
            updatePreview();
            autoSave();
        }
        function initColorPicker() {
            const container = document.getElementById('color-options');
            container.innerHTML = '';
            POKEMON_COLORS.forEach(color => {
                const div = document.createElement('div');
                div.className = 'color-option';
                div.style.backgroundColor = color.hex;
                div.title = color.name;
                div.onclick = () => selectColor(color.name, div);
                container.appendChild(div);
            });
        }
        function selectColor(colorName, element) {
            document.getElementById('fakemon-color').value = colorName;
            document.querySelectorAll('.color-option').forEach(el => el.classList.remove('selected'));
            element.classList.add('selected');
            updatePreview();
            autoSave();
        }
    

// the rail is off-canvas only on mobile; on desktop it's a permanent icon
// strip, so aria-hidden must only apply when genuinely off-screen, or it hides
// nav from screen readers on desktop. `inert` also removes it from tab order,
// which aria-hidden alone doesn't do.
const SIDEBAR_OVERLAY_QUERY = '(max-width: 768px)';

function setSidebarHidden(sidebar, hidden) {
    if (!sidebar) return;
    const offCanvas = hidden && window.matchMedia(SIDEBAR_OVERLAY_QUERY).matches;
    // focus must leave before the element is hidden, not after
    if (offCanvas && sidebar.contains(document.activeElement)
        && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
    }
    sidebar.inert = offCanvas;
    if (offCanvas) sidebar.setAttribute('aria-hidden', 'true');
    else sidebar.removeAttribute('aria-hidden');
}

// re-evaluate on breakpoint change, or widening from phone-width keeps the rail inert
try {
    window.matchMedia(SIDEBAR_OVERLAY_QUERY).addEventListener('change', () => {
        const sidebar = document.getElementById('app-sidebar');
        if (sidebar) setSidebarHidden(sidebar, !sidebar.classList.contains('open'));
    });
} catch { /* older Safari: the initial state is still correct */ }

function toggleSidebar() {
    const sidebar = document.getElementById('app-sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    const toggle = document.getElementById('menu-toggle');
    if (!sidebar || !backdrop) return;
    const open = !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', open);
    if (open) sidebar.classList.remove('force-closed');
    backdrop.classList.toggle('open', open);
    setSidebarHidden(sidebar, !open);
    toggle?.setAttribute('aria-expanded', String(open));
    if (open && typeof lucide !== 'undefined') lucide.createIcons();
}
function closeSidebar() {
    const sidebar = document.getElementById('app-sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    const toggle = document.getElementById('menu-toggle');
    sidebar?.classList.remove('open');
    backdrop?.classList.remove('open');
    setSidebarHidden(sidebar, true);
    toggle?.setAttribute('aria-expanded', 'false');
    // desktop rail stays widened via :hover/:focus-within after .open is
    // removed if the pointer/focus is still on it; force collapse regardless
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (sidebar) {
        sidebar.classList.add('force-closed');
        const clear = () => sidebar.classList.remove('force-closed');
        sidebar.addEventListener('mouseleave', clear, { once: true });
        setTimeout(clear, 1500);
    }
}

// dims/blurs the page behind the icon rail while hover-expanded on desktop;
// purely visual, no onclick, so it never intercepts clicks
function initSidebarHoverDim() {
    const sidebar = document.getElementById('app-sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (!sidebar || !backdrop) return;
    const show = () => backdrop.classList.add('hover-active');
    const hide = () => backdrop.classList.remove('hover-active');
    sidebar.addEventListener('mouseenter', show);
    sidebar.addEventListener('mouseleave', hide);
    sidebar.addEventListener('focusin', show);
    sidebar.addEventListener('focusout', (e) => { if (!sidebar.contains(e.relatedTarget)) hide(); });
}

// keeps the address bar/title in sync with the current view; always
// replaceState, never pushState, so in-app navigation doesn't pile up
// history. community/profile deep links manage their own path (see
// community.js/auth.js); this backs off when either is active.
const BASE_TITLE = 'Woogidex';
function setPageTitle(subtitle) {
    document.title = subtitle ? `${subtitle} · ${BASE_TITLE}` : BASE_TITLE;
}
function setRoute(path, title) {
    setPageTitle(title);
    // never overwrite a community/profile route that's currently open
    const open = router.currentRoute();
    if (open.param && (open.name === 'community' || open.name === 'profile')) return;
    router.replaceRoute(path);
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
    'settings-view'
];

function activateTopLevelView(viewId, options = {}) {
    const { preserveAbilityEditor = false } = options;

    if (viewId !== 'ability-block-editor-view' && !preserveAbilityEditor) {
        api.onTopLevelNavigation?.(viewId);
    }

    // drop lobby presence when leaving battle so you don't linger in "online" lists
    const leavingBattle = document.getElementById('battle-view')?.style.display === 'block' && viewId !== 'battle-view';
    if (leavingBattle) api.onBattleViewLeave?.();

    // synchronous: markup was already fetched at boot (js/core/views.js)
    views.mountView(viewId);

    TOP_LEVEL_VIEW_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = id === viewId ? 'block' : 'none';
    });

    const target = document.getElementById(viewId);
    if (target) {
        // force a reflow so the enter animation replays (same trick as switchTab())
        target.classList.remove('top-level-view-enter');
        void target.offsetWidth;
        target.classList.add('top-level-view-enter');
    }

    return target || null;
}

log.setContext({ state, api });

Object.assign(api, data, editor, sampleSets, editorCore, pokedex, storage, exporter, showdownExport, essentialsExport, evolution, analysis, auth, community, notifications, moderation, events, battleUI, abilityBlocks, nameRoll, fieldRoll, protect, views, router, recovery, cloudSave, siteNotice, legal, accountDeletion, oauth, settingsApi, {
    openUpdatesModal, closeUpdatesModal, renderUpdates, loadUpdates,
    loadDarkMode, toggleDarkMode, updateDarkModeUI, openSettings, closeSettingsPage, switchSettingsTab, toggleSidebar, closeSidebar,
    setRoute, setPageTitle, activateTopLevelView,
    updateSettingsUI, loadSettings, showToast,
    initTypeSelects, toggleTypeDropdown, toggleCatDropdown, selectType, initColorPicker, selectColor
});

// preserve the inline event-handler contract
Object.assign(window, api);

// header retracts on downward scroll, reveals on scroll up or pointer near top
let lastScrollY = 0;
let headerScrollTick = false;
let headerHoverRevealTimer = null;
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
    // all page markup mounted up front rather than on first nav; see views.js
    await views.loadViewMarkup();
    views.mountAllViews();
    api.initTypeSelects();
    api.initColorPicker();
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
            api.applyCollectionLayoutUI?.();
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
    // Showdown data (moves/abilities/items/pokedex, 1MB+) is only needed
    // up front by routes that look something up in it before rendering
    // (editor, community preview, battle); the collection grid draws only
    // from the Fakemon's own saved fields, so it doesn't block on this fetch.
    // Callers elsewhere show their own loading state if they beat it (see
    // state.sdLoaded checks in editor.js/analysis.js/pokedex.js).
    const NEEDS_SHOWDOWN_DATA_UP_FRONT = new Set(['editor', 'ability-editor', 'community', 'events', 'battle']);
    const showdownDataPromise = api.fetchShowdownData?.();
    if (NEEDS_SHOWDOWN_DATA_UP_FRONT.has(bootRoute.name)) await showdownDataPromise;
    // learnsets.json (3.2 MB) warms in the background; callers await api.ensureLearnsets() themselves
    api.ensureLearnsets?.();
    const handled = await handleRoute(bootRoute);
    if (!handled) api.renderCollection();
    loadDarkMode();
    loadSettings();
    initSidebarHoverDim();
    api.initContentProtection?.();
    initArtShield();
    // avatars come from the same masked pipe artwork does; this hands the
    // module a client getter rather than letting it import the feature layer
    initAvatars(() => api.getClient());
    paintAvatarSlots();
    // rail's initial hidden state: inert on a phone, available on desktop
    setSidebarHidden(document.getElementById('app-sidebar'), true);
    if (typeof lucide !== 'undefined') lucide.createIcons();
    api.updateEditorStats();
    api.populateStatTemplateOptions?.();
    api.initStatBarSliders?.();
    done({ fakemons: state.fakemonDB.length, sdLoaded: state.sdLoaded });
    log.info('BOOT', 'Application ready', { fakemons: state.fakemonDB.length, sdLoaded: state.sdLoaded });
    // empty collection on a local origin looks like data loss; see dev-notice.js
    maybeShowOriginNotice(state.fakemonDB.length);
    // recovery takes priority over the transfer notice; recovery.js shows the
    // transfer notice itself once it's done (restored, dismissed, or nothing found)
    if (!(await api.checkForLostFakemon?.())) api.maybeShowSiteTransferNotice?.();
    // last on purpose: refreshUpdatesBadge() checks for an already-open modal
    // before opening its own, but still fills the unread count either way
    window.refreshUpdatesBadge?.({ autoOpen: true });
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
    if (name === 'collection' || name === '') { api.showCollection?.(); return true; }
    return false;
}

// the app only calls replaceState, so this fires for browser navigation only
window.addEventListener('popstate', async () => {
    await handleRoute(router.currentRoute());
});

function openCreditsModal() {
    const modal = document.getElementById('credits-modal');
    if (!modal) return;
    modal.classList.add('active');
    document.body.classList.add('modal-open');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeCreditsModal() {
    const modal = document.getElementById('credits-modal');
    if (!modal) return;
    modal.classList.remove('active');
    document.body.classList.remove('modal-open');
}

window.openCreditsModal = openCreditsModal;
window.closeCreditsModal = closeCreditsModal;

export { loadDarkMode, toggleDarkMode, updateDarkModeUI, showToast, initTypeSelects, toggleTypeDropdown, toggleCatDropdown, selectType, initColorPicker, selectColor };