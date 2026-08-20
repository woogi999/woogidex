import { log } from './log.js';
const { openUpdatesModal, closeUpdatesModal, renderUpdates, loadUpdates } = window;
import { POKEMON_TYPES, POKEMON_COLORS } from './data.js';
import * as data from './data.js';
import * as editor from './editor.js';
import * as sampleSets from './sample-sets.js';
import * as editorCore from './editor-core.js';
import * as pokedex from './pokedex.js';
import * as storage from './storage.js';
import * as exporter from './export.js';
import * as showdownExport from './showdown-export.js';
import * as essentialsExport from './essentials-export.js';
import * as evolution from './evolution.js';
import * as analysis from './analysis.js';
import * as auth from './auth.js';
import * as community from './community.js';
import * as notifications from './notifications.js';
import * as events from './events.js';
import * as abilityBlocks from './ability-blocks.js';
import * as nameRoll from './name-roll.js';
import * as fieldRoll from './field-roll.js';

// ==================== feature flags ====================
// TODO: remove this flag (and the sidebar-events-btn hidden attribute in
// index.html) once the events/contests feature is finished - this just
// hides the entry point without touching any of the underlying code.
export const FEATURE_EVENTS_ENABLED = false;

// ==================== shared state ====================
export const state = {
    sdMoves: {},
    sdAbilities: {},
    sdItems: {},
    sdPokedex: {},
    sdLearnsets: {},
    pokeApiSpeciesCache: {},
    sdMoveUsefulness: {},
    sdLoaded: false,
    fakemonDB: [],
    folders: [],
    customMoves: [],
    customAbilities: [],
    customItems: [],
    currentFolderId: null,
    editingId: null,
    abilities: [],
    customAbilities: [],
    learnset: [],
    customMoves: [],
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


// ==================== dark mode ====================
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
            // look the button up by a fixed selector rather than the icon's id -
            // lucide.createIcons() swaps the <i data-lucide> element for a fresh
            // <svg>, and outerHTML-replacing it below would otherwise need to
            // keep re-guessing which element currently holds the id.
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

        function isDarkModeEnabled() {
            return document.documentElement.getAttribute('data-theme') === 'dark';
        }

        function getFadeUselessMoves() {
            return localStorage.getItem('woogidex-fade-useless-moves') !== 'false';
        }

        function setFadeUselessMoves(enabled) {
            localStorage.setItem('woogidex-fade-useless-moves', enabled ? 'true' : 'false');
            updateSettingsUI();
            if (typeof api.updatePreview === 'function') api.updatePreview();
        }

        function toggleFadeUselessMoves() {
            setFadeUselessMoves(!getFadeUselessMoves());
        }

        function getUse2DSprites() {
            // 3d/animated sprites are the default. the preference is persisted locally.
            return localStorage.getItem('woogidex-use-2d-sprites') === 'true';
        }

        function setUse2DSprites(enabled) {
            localStorage.setItem('woogidex-use-2d-sprites', enabled ? 'true' : 'false');
            updateSettingsUI();
            if (typeof api.renderPokemonTemplateChooser === 'function' && document.getElementById('pokemon-template-modal')?.classList.contains('active')) {
                api.renderPokemonTemplateChooser();
            }
            if (typeof api.updateBulkComparison === 'function') api.updateBulkComparison();
        }

        function toggleUse2DSprites() {
            setUse2DSprites(!getUse2DSprites());
        }

        function getIncludeOwnFakemonsInBulkComparison() {
            return localStorage.getItem('woogidex-include-own-fakemons-bulk') === 'true';
        }

        function setIncludeOwnFakemonsInBulkComparison(enabled) {
            localStorage.setItem('woogidex-include-own-fakemons-bulk', enabled ? 'true' : 'false');
            updateSettingsUI();
            if (typeof api.updateBulkComparison === 'function') api.updateBulkComparison();
        }

        function toggleIncludeOwnFakemonsInBulkComparison() {
            setIncludeOwnFakemonsInBulkComparison(!getIncludeOwnFakemonsInBulkComparison());
        }

        function getIncludeOwnFakemonsInRecommendedMoves() {
            return localStorage.getItem('woogidex-include-own-fakemons-recommended') === 'true';
        }

        function setIncludeOwnFakemonsInRecommendedMoves(enabled) {
            localStorage.setItem('woogidex-include-own-fakemons-recommended', enabled ? 'true' : 'false');
            updateSettingsUI();
        }

        function toggleIncludeOwnFakemonsInRecommendedMoves() {
            setIncludeOwnFakemonsInRecommendedMoves(!getIncludeOwnFakemonsInRecommendedMoves());
        }

        function getShowCollectionCardDate() {
            return localStorage.getItem('woogidex-show-card-date') !== 'false';
        }

        function setShowCollectionCardDate(enabled) {
            localStorage.setItem('woogidex-show-card-date', enabled ? 'true' : 'false');
            updateSettingsUI();
            if (typeof api.renderCollection === 'function') api.renderCollection();
        }

        function toggleShowCollectionCardDate() {
            setShowCollectionCardDate(!getShowCollectionCardDate());
        }

        function getReduceMotion() {
            return localStorage.getItem('woogidex-reduce-motion') === 'true';
        }

        function applyReduceMotion(enabled) {
            document.documentElement.classList.toggle('reduce-motion', enabled);
        }

        function setReduceMotion(enabled) {
            localStorage.setItem('woogidex-reduce-motion', enabled ? 'true' : 'false');
            applyReduceMotion(enabled);
            updateSettingsUI();
        }

        function toggleReduceMotion() {
            setReduceMotion(!getReduceMotion());
        }

        function openSettings() {
            log.debug('SETTINGS', 'Opening settings');
            const modal = document.getElementById('settings-modal');
            if (!modal) return;
            updateSettingsUI();
            modal.classList.add('active');
        }

        function updateSettingsUI() {
            const dark = isDarkModeEnabled();
            const fade = getFadeUselessMoves();
            const darkToggle = document.getElementById('settings-dark-toggle');
            const fadeToggle = document.getElementById('settings-fade-toggle');
            const ownBulkToggle = document.getElementById('settings-own-bulk-toggle');
            const ownRecommendedToggle = document.getElementById('settings-own-recommended-toggle');
            const use2dToggle = document.getElementById('settings-2d-sprites-toggle');
            const cardDateToggle = document.getElementById('settings-card-date-toggle');
            const reduceMotionToggle = document.getElementById('settings-reduce-motion-toggle');
            if (darkToggle) darkToggle.checked = dark;
            if (fadeToggle) fadeToggle.checked = fade;
            if (ownBulkToggle) ownBulkToggle.checked = getIncludeOwnFakemonsInBulkComparison();
            if (ownRecommendedToggle) ownRecommendedToggle.checked = getIncludeOwnFakemonsInRecommendedMoves();
            if (use2dToggle) use2dToggle.checked = getUse2DSprites();
            if (cardDateToggle) cardDateToggle.checked = getShowCollectionCardDate();
            if (reduceMotionToggle) reduceMotionToggle.checked = getReduceMotion();
        }

        function loadSettings() {
            applyReduceMotion(getReduceMotion());
            updateSettingsUI();
        }

        

// ==================== toast ====================
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
    

function toggleSidebar() {
    const sidebar = document.getElementById('app-sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    const toggle = document.getElementById('menu-toggle');
    if (!sidebar || !backdrop) return;
    const open = !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', open);
    backdrop.classList.toggle('open', open);
    sidebar.setAttribute('aria-hidden', String(!open));
    toggle?.setAttribute('aria-expanded', String(open));
    if (open && typeof lucide !== 'undefined') lucide.createIcons();
}
function closeSidebar() {
    const sidebar = document.getElementById('app-sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    const toggle = document.getElementById('menu-toggle');
    sidebar?.classList.remove('open');
    backdrop?.classList.remove('open');
    sidebar?.setAttribute('aria-hidden', 'true');
    toggle?.setAttribute('aria-expanded', 'false');
}

// ==================== URL + title routing ====================
// keeps the address bar and document title in sync with whatever view the
// user is actually looking at. always uses replaceState, never pushState -
// this is meant to make refreshing/sharing a link land back where you were,
// not to build a back-button history of every click; ordinary in-app
// navigation should never pile up history entries.
// community mon (#community/<id>) and profile (#profile/<username>) deep
// links are richer and manage their own hash (see community.js / auth.js);
// this only touches the hash when neither of those routes is active, so it
// never fights them.
const BASE_TITLE = 'Woogidex';
function setPageTitle(subtitle) {
    document.title = subtitle ? `${subtitle} · ${BASE_TITLE}` : BASE_TITLE;
}
function setRoute(hashPath, title) {
    setPageTitle(title);
    const current = window.location.hash || '';
    if (current.startsWith('#community/') || current.startsWith('#profile/')) return;
    const nextHash = hashPath ? `#${hashPath}` : '';
    if (current === nextHash) return;
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}${nextHash}`);
}

// ==================== top-level view navigation ====================
// All full-page views live under #main-content. Keep their visibility in one
// place so adding a new editor/page cannot leave a previously-open view
// stranded underneath it. Modules can still perform their own async work
// (autosave/fetching) before calling this function.
const TOP_LEVEL_VIEW_IDS = [
    'collection-view',
    'editor-view',
    'ability-block-editor-view',
    'community-view',
    'community-detail-view',
    'events-view',
    'profile-view'
];

function activateTopLevelView(viewId, options = {}) {
    const { preserveAbilityEditor = false } = options;

    if (viewId !== 'ability-block-editor-view' && !preserveAbilityEditor) {
        api.onTopLevelNavigation?.(viewId);
    }

    TOP_LEVEL_VIEW_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = id === viewId ? 'block' : 'none';
    });

    return document.getElementById(viewId) || null;
}

// ==================== module coordination ====================
log.setContext({ state, api });

Object.assign(api, data, editor, sampleSets, editorCore, pokedex, storage, exporter, showdownExport, essentialsExport, evolution, analysis, auth, community, notifications, events, abilityBlocks, nameRoll, fieldRoll, {
    openUpdatesModal, closeUpdatesModal, renderUpdates, loadUpdates,
    loadDarkMode, toggleDarkMode, updateDarkModeUI, openSettings, toggleSidebar, closeSidebar, getFadeUselessMoves, setFadeUselessMoves, toggleFadeUselessMoves,
    getIncludeOwnFakemonsInBulkComparison, setIncludeOwnFakemonsInBulkComparison, toggleIncludeOwnFakemonsInBulkComparison,
    setRoute, setPageTitle, activateTopLevelView,
    getShowCollectionCardDate, setShowCollectionCardDate, toggleShowCollectionCardDate,
    getReduceMotion, setReduceMotion, toggleReduceMotion,
    getIncludeOwnFakemonsInRecommendedMoves, setIncludeOwnFakemonsInRecommendedMoves, toggleIncludeOwnFakemonsInRecommendedMoves,
    getUse2DSprites, setUse2DSprites, toggleUse2DSprites,
    updateSettingsUI, loadSettings, showToast,
    initTypeSelects, toggleTypeDropdown, toggleCatDropdown, selectType, initColorPicker, selectColor
});

// preserve the original inline event-handler contract.
Object.assign(window, api);

// dynamic edge-to-edge header: retracts on downward scroll and reveals again
// when scrolling up or when the pointer reaches the very top of the screen.
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
    api.initTypeSelects();
    api.initColorPicker();
    document.getElementById('sidebar-events-btn')?.toggleAttribute('hidden', !FEATURE_EVENTS_ENABLED);
    // paint skeleton cards immediately so the very first frame already has
    // the right shape instead of an empty grid, then let auth/storage load
    // underneath it — renderCollection() below replaces it seamlessly.
    if (!window.location.hash.startsWith('#community/') && !window.location.hash.startsWith('#profile/')) {
        api.renderCollectionSkeleton?.();
    }
    await api.initAuth();
    await api.loadFromStorage();
    // load showdown's authoritative move/ability data before rendering a shared
    // Fakemon so its preview is fully rehydrated on the first render.
    await api.fetchShowdownData?.();
    const isCommunityRoute = await api.handleCommunityHashRoute?.();
    const isProfileRoute = !isCommunityRoute && window.location.hash.startsWith('#profile/')
        ? (api.activateTopLevelView?.('profile-view'), await api.handleProfileHashRoute?.())
        : false;
    if (!isCommunityRoute && !isProfileRoute) {
        const handled = await handleAppHashRoute(window.location.hash || '');
        if (!handled) api.renderCollection();
    }
    loadDarkMode();
    loadSettings();
    if (typeof lucide !== 'undefined') lucide.createIcons();
    api.updateEditorStats();
    api.populateStatTemplateOptions?.();
    api.initStatBarSliders?.();
    done({ fakemons: state.fakemonDB.length, sdLoaded: state.sdLoaded });
    log.info('BOOT', 'Application ready', { fakemons: state.fakemonDB.length, sdLoaded: state.sdLoaded });
});

// restores the app's other top-level views (collection/editor/community
// hub/events) from a plain #route hash on load or back/forward - the richer
// #community/<id> and #profile/<username> deep links are handled separately
// above this, before we ever get here. returns true if it recognized and
// handled the hash, so the caller knows whether to fall back to the
// collection as the default view.
async function handleAppHashRoute(hash) {
    if (hash.startsWith('#ability-editor/')) {
        const id = decodeURIComponent(hash.slice('#ability-editor/'.length));
        api.openAbilityBlockEditor(id);
        return true;
    }
    if (hash.startsWith('#editor/')) {
        const id = decodeURIComponent(hash.slice('#editor/'.length));
        const fakemon = state.fakemonDB.find(f => String(f.id) === id);
        if (fakemon) { api.editFakemon(id); return true; }
        return false;
    }
    if (hash === '#community') { await api.openCommunityHub?.(); return true; }
    if (hash === '#events') { await api.openEvents?.(); return true; }
    if (hash === '#collection' || hash === '') { return false; }
    return false;
}

window.addEventListener('hashchange', async () => {
    const hash = window.location.hash || '';
    if (hash.startsWith('#community/')) await api.handleCommunityHashRoute?.();
    else if (hash.startsWith('#profile/')) {
        api.activateTopLevelView?.('profile-view');
        await api.handleProfileHashRoute?.();
    }
    else await handleAppHashRoute(hash);
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