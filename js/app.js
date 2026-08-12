import { POKEMON_TYPES, POKEMON_COLORS } from './data.js';
import * as data from './data.js';
import * as editor from './editor.js';
import * as pokedex from './pokedex.js';
import * as storage from './storage.js';
import * as exporter from './export.js';

// ==================== SHARED STATE ====================
export const state = {
    sdMoves: {},
    sdAbilities: {},
    sdItems: {},
    sdPokedex: {},
    sdLearnsets: {},
    sdMoveUsefulness: {},
    sdLoaded: false,
    fakemonDB: [],
    folders: [],
    customMoves: [],
    customAbilities: [],
    currentFolderId: null,
    editingId: null,
    abilities: [],
    customAbilities: [],
    learnset: [],
    customMoves: [],
    sampleSets: [],
    artworkData: null,
    autoSaveTimer: null,
    lastSavedId: null
};

export const api = {};


// ==================== DARK MODE ====================
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
            if (btn) {
                btn.innerHTML = isDark 
                    ? '<i data-lucide="moon" style="width:18px;height:18px;"></i>' 
                    : '<i data-lucide="sun" style="width:18px;height:18px;"></i>';
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
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

        function openSettings() {
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
            if (darkToggle) darkToggle.checked = dark;
            if (fadeToggle) fadeToggle.checked = fade;
            if (ownBulkToggle) ownBulkToggle.checked = getIncludeOwnFakemonsInBulkComparison();
            if (ownRecommendedToggle) ownRecommendedToggle.checked = getIncludeOwnFakemonsInRecommendedMoves();
        }

        function loadSettings() {
            updateSettingsUI();
        }

        

// ==================== TOAST ====================
        function showToast(message, type = 'info') {
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

        

// ==================== INIT HELPERS ====================
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
    

// ==================== MODULE COORDINATION ====================
Object.assign(api, data, editor, pokedex, storage, exporter, {
    loadDarkMode, toggleDarkMode, updateDarkModeUI, openSettings, getFadeUselessMoves, setFadeUselessMoves, toggleFadeUselessMoves,
    getIncludeOwnFakemonsInBulkComparison, setIncludeOwnFakemonsInBulkComparison, toggleIncludeOwnFakemonsInBulkComparison,
    getIncludeOwnFakemonsInRecommendedMoves, setIncludeOwnFakemonsInRecommendedMoves, toggleIncludeOwnFakemonsInRecommendedMoves,
    updateSettingsUI, loadSettings, showToast,
    initTypeSelects, toggleTypeDropdown, toggleCatDropdown, selectType, initColorPicker, selectColor
});

// Preserve the original inline event-handler contract.
Object.assign(window, api);

document.addEventListener('DOMContentLoaded', async () => {
    api.initTypeSelects();
    api.initColorPicker();
    await api.loadFromStorage();
    api.renderCollection();
    api.fetchShowdownData();
    loadDarkMode();
    loadSettings();
    if (typeof lucide !== 'undefined') lucide.createIcons();
    api.updateEditorStats();
});

export { loadDarkMode, toggleDarkMode, updateDarkModeUI, showToast, initTypeSelects, toggleTypeDropdown, toggleCatDropdown, selectType, initColorPicker, selectColor };