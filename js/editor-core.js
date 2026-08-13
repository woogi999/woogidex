import { state, api } from './app.js';

import { POKEMON_TYPES, TYPE_EFFECTIVENESS } from './data.js';
import { escapeHtml, getAbilityRole, hydrateLearnsetEntry, isCustomMove, openCustomMoveModal, renderAbilities, renderCustomAbilities, renderCustomMoves, renderLearnset, showMoveDetail, sortLearnset, resetEditingCustomAbilityIndex } from './editor.js';
import { calcStat, copySampleSetText, generateShowdownExport, renderSampleSets, sampleMoveIsActuallyUseful } from './sample-sets.js';
// ==================== EDITOR LOGIC ====================
        function getNextPokedexNumber() {
    const used = new Set();
    (state.fakemonDB || []).forEach(f => {
        const raw = String(f?.number || '').trim().replace(/^#/, '');
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) used.add(n);
    });
    let next = 1;
    while (used.has(next)) next++;
    return `#${String(next).padStart(3, '0')}`;
}

function resetEditor() {
            document.getElementById('fakemon-name').value = '';
            document.getElementById('fakemon-species').value = '';
            document.getElementById('fakemon-species').disabled = false;
            if (document.getElementById('fakemon-is-mega')) document.getElementById('fakemon-is-mega').checked = false;
            if (document.getElementById('fakemon-is-forme')) document.getElementById('fakemon-is-forme').checked = false;
            selectType('type1', '');
            selectType('type2', '');
            document.getElementById('fakemon-number').value = getNextPokedexNumber();
            document.getElementById('editor-level').value = 100;
            document.getElementById('stat-hp').value = 60;
            document.getElementById('stat-atk').value = 60;
            document.getElementById('stat-def').value = 60;
            document.getElementById('stat-spa').value = 60;
            document.getElementById('stat-spd').value = 60;
            document.getElementById('stat-spe').value = 60;
            document.getElementById('dex-entry1').value = '';
            document.getElementById('dex-entry2').value = '';
            document.getElementById('fakemon-height').value = '';
            document.getElementById('fakemon-weight').value = '';
            document.getElementById('height-unit').value = 'm';
            document.getElementById('weight-unit').value = 'kg';
            document.getElementById('fakemon-height').dataset.lastUnit = 'm';
            document.getElementById('fakemon-weight').dataset.lastUnit = 'kg';
            document.getElementById('fakemon-color').value = '';
            setEggGroupValue('');
            setGenderRatioValue('50-50');
            document.querySelectorAll('.color-option').forEach(el => el.classList.remove('selected'));
            state.abilities = [];
            resetEditingCustomAbilityIndex();
            state.learnset = [];
            state.sampleSets = [];
            state.artworkData = null;
            state.evolutionGraph = null;
            document.getElementById('artwork-preview').innerHTML = '<span class="placeholder">ART</span>';
            renderAbilities();
            renderLearnset();
            renderCustomMoves();
            renderSampleSets();
            updateStats();
            updateGenderBar();
            api.initializeEvolutionGraph?.(null);
        }

        function loadFakemonIntoEditor(fakemon) {
            document.getElementById('fakemon-name').value = fakemon.name || '';
            document.getElementById('fakemon-species').value = fakemon.species || '';
            selectType('type1', fakemon.type1 || '');
            selectType('type2', fakemon.type2 || '');
            document.getElementById('fakemon-number').value = fakemon.number || '';
            document.getElementById('editor-level').value = fakemon.level || 100;
            document.getElementById('stat-hp').value = clampBaseStatValue(fakemon.stats?.hp ?? 60);
            document.getElementById('stat-atk').value = clampBaseStatValue(fakemon.stats?.atk ?? 60);
            document.getElementById('stat-def').value = clampBaseStatValue(fakemon.stats?.def ?? 60);
            document.getElementById('stat-spa').value = clampBaseStatValue(fakemon.stats?.spa ?? 60);
            document.getElementById('stat-spd').value = clampBaseStatValue(fakemon.stats?.spd ?? 60);
            document.getElementById('stat-spe').value = clampBaseStatValue(fakemon.stats?.spe ?? 60);
            document.getElementById('dex-entry1').value = fakemon.dexEntry1 || '';
            document.getElementById('dex-entry2').value = fakemon.dexEntry2 || '';
            // Parse height string (e.g., "0.9 m" or "3.5 ft")
            if (fakemon.height) {
                const hMatch = fakemon.height.match(/^([\d.]+)\s*(m|ft|meters|feet)?$/i);
                if (hMatch) {
                    document.getElementById('fakemon-height').value = hMatch[1];
                    const hUnit = hMatch[2] ? (hMatch[2].toLowerCase().startsWith('f') ? 'ft' : 'm') : 'm';
                    document.getElementById('height-unit').value = hUnit;
                    document.getElementById('fakemon-height').dataset.lastUnit = hUnit;
                } else {
                    document.getElementById('fakemon-height').value = fakemon.height;
                    document.getElementById('height-unit').value = 'm';
                    document.getElementById('fakemon-height').dataset.lastUnit = 'm';
                }
            } else {
                document.getElementById('fakemon-height').value = '';
                document.getElementById('height-unit').value = 'm';
                document.getElementById('fakemon-height').dataset.lastUnit = 'm';
            }
            // Parse weight string (e.g., "25.0 kg" or "55.1 lb")
            if (fakemon.weight) {
                const wMatch = fakemon.weight.match(/^([\d.]+)\s*(kg|lb|kilograms|pounds)?$/i);
                if (wMatch) {
                    document.getElementById('fakemon-weight').value = wMatch[1];
                    const wUnit = wMatch[2] ? (wMatch[2].toLowerCase().startsWith('l') || wMatch[2].toLowerCase().startsWith('p') ? 'lb' : 'kg') : 'kg';
                    document.getElementById('weight-unit').value = wUnit;
                    document.getElementById('fakemon-weight').dataset.lastUnit = wUnit;
                } else {
                    document.getElementById('fakemon-weight').value = fakemon.weight;
                    document.getElementById('weight-unit').value = 'kg';
                    document.getElementById('fakemon-weight').dataset.lastUnit = 'kg';
                }
            } else {
                document.getElementById('fakemon-weight').value = '';
                document.getElementById('weight-unit').value = 'kg';
                document.getElementById('fakemon-weight').dataset.lastUnit = 'kg';
            }
            document.getElementById('fakemon-color').value = fakemon.color || '';
            const normalizedEggGroups = Array.isArray(fakemon.eggGroups) ? fakemon.eggGroups.filter(Boolean).join(', ') : String(fakemon.eggGroups || '');
            setEggGroupValue(normalizedEggGroups);
            const normalizedGenderRatio = typeof fakemon.genderRatio === 'string' ? fakemon.genderRatio : (fakemon.genderRatio?.value || '50-50');
            setGenderRatioValue(normalizedGenderRatio || '50-50');
            document.querySelectorAll('.color-option').forEach(el => {
                el.classList.remove('selected');
                if (el.title === fakemon.color) el.classList.add('selected');
            });
            resetEditingCustomAbilityIndex();
            const legacyAbilities = Array.isArray(fakemon.abilities) ? fakemon.abilities : [];
            const legacyCustomAbilities = Array.isArray(fakemon.customAbilities) ? fakemon.customAbilities : [];
            state.abilities = [
                ...legacyAbilities.map(a => typeof a === 'string' ? { name: a, source: 'sd', desc: '' } : {
                    name: a.name || '', source: a.source || (a.custom ? 'custom' : 'sd'), desc: a.desc || a.description || ''
                }),
                ...legacyCustomAbilities.map(a => ({
                    name: a.name || '', source: 'custom', desc: a.desc || a.description || ''
                }))
            ].filter(a => a.name || a.source === 'custom').slice(0, 4);
            // Build the unified learnset. Explicitly marked custom moves are never sent
            // through Showdown hydration, even if their name happens to match a vanilla move.
            state.learnset = (fakemon.learnset || []).map(m => {
                if (m && (m.source === 'custom' || m.custom === true)) {
                    return {
                        ...m,
                        source: 'custom',
                        custom: true,
                        learnMethod: m.learnMethod || 'none',
                        level: m.learnMethod === 'level' ? (m.level || null) : null,
                        flags: m.flags || {}
                    };
                }
                return hydrateLearnsetEntry(m);
            });
            // Migrate legacy standalone custom moves into the unified learnset.
            const legacyCustomMoves = Array.isArray(fakemon.customMoves) ? fakemon.customMoves : [];
            legacyCustomMoves.forEach(m => {
                if (!m || !m.name) return;
                const exists = state.learnset.some(x => x.name === m.name && isCustomMove(x));
                if (!exists) state.learnset.push({
                    ...m,
                    source: 'custom',
                    custom: true,
                    learnMethod: m.learnMethod || 'none',
                    level: m.learnMethod === 'level' ? (m.level || null) : null,
                    flags: m.flags || {}
                });
            });
            sortLearnset();
            state.sampleSets = fakemon.sampleSets || [];
            state.artworkData = fakemon.artwork || null;
            if (state.artworkData) {
                document.getElementById('artwork-preview').innerHTML = `<img src="${state.artworkData}" alt="Artwork">`;
            } else {
                document.getElementById('artwork-preview').innerHTML = '<span class="placeholder">ART</span>';
            }
            renderAbilities();
            renderCustomAbilities();
            renderLearnset();
            renderCustomMoves();
            renderSampleSets();
            api.syncEvolutionOnBasicLoad?.(fakemon);
            api.initializeEvolutionGraph?.(fakemon.evolutionGraph || null);
            updateStats();
            updateGenderBar();
        }

        
// ==================== STAT INPUT VALIDATION ====================
        function clampBaseStatValue(value) {
            const parsed = Number.parseInt(String(value).replace(/[^0-9-]/g, ''), 10);
            if (!Number.isFinite(parsed)) return 1;
            return Math.max(1, Math.min(255, parsed));
        }

        function enforceBaseStatInput(input) {
            if (!input) return;
            input.value = clampBaseStatValue(input.value);
        }

// ==================== STATS ====================
        function updateEditorStats() {
            const level = parseInt(document.getElementById('editor-level').value) || 100;
            const stats = ['hp','atk','def','spa','spd','spe'];
            const statLabels = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
            let bst = 0;
            stats.forEach(stat => {
                const input = document.getElementById('stat-' + stat);
                const base = clampBaseStatValue(input?.value);
                if (input) input.value = base;
                bst += base;
                // Update bar fill
                const bar = document.getElementById('editor-bar-' + stat);
                if (bar) bar.style.width = Math.min(base / 255 * 100, 100) + '%';
                // Update calculated stat (neutral nature, 0 EVs, 31 IVs)
                const calc = calcStat(base, 0, 31, 'Hardy', stat, level);
                const calcEl = document.getElementById('calc-' + stat);
                if (calcEl) calcEl.textContent = calc;
            });
            document.getElementById('bst-value').textContent = bst;
            updatePreview();
            autoSave();
            updateBulkComparison();
        }
        // Legacy alias
        function updateStats() { updateEditorStats(); }

        
// ==================== SPRITE FALLBACKS ====================
        const pokeApiArtworkCache = new Map();
        const pokeApiArtworkPending = new Map();

        function normalizePokeApiPokemonName(value) {
            return String(value || '').trim().toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        }

        async function getPokeApiOfficialArtwork(pokemonName, fallbackName) {
            const candidates = [...new Set([pokemonName, fallbackName].map(normalizePokeApiPokemonName).filter(Boolean))];
            for (const name of candidates) {
                if (pokeApiArtworkCache.has(name)) return pokeApiArtworkCache.get(name);
                if (!pokeApiArtworkPending.has(name)) {
                    pokeApiArtworkPending.set(name, fetch(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(name)}`)
                        .then(res => res.ok ? res.json() : null)
                        .then(data => {
                            const url = data?.sprites?.other?.['official-artwork']?.front_default || null;
                            if (url) pokeApiArtworkCache.set(name, url);
                            return url;
                        }).catch(() => null));
                }
                const url = await pokeApiArtworkPending.get(name);
                pokeApiArtworkPending.delete(name);
                if (url) return url;
            }
            return null;
        }

        async function fallbackPokemonImage(img, pokemonName, fallbackName) {
            if (!img || img.dataset.pokeapiFallbackAttempted === 'true') return;
            img.dataset.pokeapiFallbackAttempted = 'true';
            const url = await getPokeApiOfficialArtwork(pokemonName, fallbackName);
            if (url) {
                img.src = url;
                img.style.visibility = 'visible';
                img.style.display = '';
            } else {
                img.style.visibility = 'hidden';
            }
        }
        window.fallbackPokemonImage = fallbackPokemonImage;

        // ==================== BULK COMPARISON ====================
        function getSpriteUrl(dexId, dexRecord) {
            const raw = String(dexId || dexRecord?.id || dexRecord?.name || '').trim().toLowerCase();
            const slug = value => String(value || '')
                .toLowerCase()
                .replace(/[’']/g, '')
                .replace(/\./g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            const base = slug(dexRecord?.baseSpecies || '');
            const forme = slug(dexRecord?.forme || '');
            let name;
            if (base && forme) {
                let suffix = forme;
                suffix = suffix.replace(/^mega-([xy])$/, 'mega$1');
                suffix = suffix.replace(/^alola-totem$/, 'alolatotem');
                suffix = suffix.replace(/^galar-totem$/, 'galartotem');
                suffix = suffix.replace(/^hisui-totem$/, 'hisuitotem');
                suffix = suffix.replace(/^paldea-totem$/, 'paldeatotem');
                name = `${base}-${suffix}`;
            } else {
                name = raw.replace(/[-_\s]+/g, '-');
            }
            const spriteDir = typeof api.getUse2DSprites === 'function' && api.getUse2DSprites() ? 'gen5ani' : 'ani';
            return 'https://play.pokemonshowdown.com/sprites/' + spriteDir + '/' + (name || 'missingno') + '.gif';
        }

        function updateBulkComparison() {
            const container = document.getElementById('bulk-comparison');
            if (!container) return;
            if (!state.sdLoaded || Object.keys(state.sdPokedex).length === 0) {
                container.innerHTML = '<div class="bulk-comparison-title">Bulk Comparison</div><p style="font-size:12px;color:var(--text-muted);">Loading Pokemon data...</p>';
                return;
            }

            const useRawStat = typeof api.getUseRawStatBulk === 'function' ? api.getUseRawStatBulk() : true;
            // "Raw stat" bulk runs each base stat through the real level-100,
            // neutral-nature, no-EV stat formula (api.calcStat) instead of just
            // multiplying base stat numbers together. This tracks in-game bulk
            // more accurately, since HP scales differently from Def/SpD.
            const toBulkStat = (base, statKey) => useRawStat
                ? calcStat(base, 0, 31, 'Hardy', statKey, 100)
                : base;

            const hp = clampBaseStatValue(document.getElementById('stat-hp').value);
            const def = clampBaseStatValue(document.getElementById('stat-def').value);
            const spd = clampBaseStatValue(document.getElementById('stat-spd').value);
            const physBulk = toBulkStat(hp, 'hp') * toBulkStat(def, 'def');
            const specBulk = toBulkStat(hp, 'hp') * toBulkStat(spd, 'spd');

            const candidates = Object.values(state.sdPokedex)
                .filter(dex => dex && dex.stats)
                .map(dex => ({ ...dex, isOwnFakemon: false }));

            const includeOwn = typeof api.getIncludeOwnFakemonsInBulkComparison === 'function'
                ? api.getIncludeOwnFakemonsInBulkComparison()
                : false;

            if (includeOwn) {
                (state.fakemonDB || []).forEach(fakemon => {
                    // Exclude the Fakemon currently open in the editor.
                    if (state.editingId && String(fakemon?.id) === String(state.editingId)) return;
                    if (!fakemon || !fakemon.name || !fakemon.stats) return;
                    candidates.push({
                        id: `woogidex-${fakemon.id || fakemon.name}`,
                        name: fakemon.name,
                        stats: {
                            hp: clampBaseStatValue(fakemon.stats.hp ?? 60),
                            def: clampBaseStatValue(fakemon.stats.def ?? 60),
                            spd: clampBaseStatValue(fakemon.stats.spd ?? 60)
                        },
                        isOwnFakemon: true,
                        artwork: fakemon.artwork || null
                    });
                });
            }

            let closestPhys = null, closestPhysDiff = Infinity;
            let closestSpec = null, closestSpecDiff = Infinity;

            for (const dex of candidates) {
                const dHp = toBulkStat(dex.stats.hp || 0, 'hp');
                const dDef = toBulkStat(dex.stats.def || 0, 'def');
                const dSpd = toBulkStat(dex.stats.spd || 0, 'spd');
                const physDiff = Math.abs((dHp * dDef) - physBulk);
                const specDiff = Math.abs((dHp * dSpd) - specBulk);
                if (physDiff < closestPhysDiff) {
                    closestPhysDiff = physDiff;
                    closestPhys = dex;
                }
                if (specDiff < closestSpecDiff) {
                    closestSpecDiff = specDiff;
                    closestSpec = dex;
                }
            }

            const getMatchSprite = match => {
                if (!match) return '';
                if (match.isOwnFakemon && match.artwork) return match.artwork;
                return getSpriteUrl(match.id, match);
            };

            const getMatchLabel = (match, kind) => {
                if (!match) return 'N/A';
                const bulk = (toBulkStat(match.stats.hp, 'hp') * (kind === 'physical' ? toBulkStat(match.stats.def, 'def') : toBulkStat(match.stats.spd, 'spd'))).toLocaleString();
                return `${match.name} — ${bulk} bulk`;
            };

            const physSprite = getMatchSprite(closestPhys);
            const specSprite = getMatchSprite(closestSpec);

            container.innerHTML = `
                <div class="bulk-comparison-title">Bulk Comparison</div>
                <div class="bulk-row">
                    <div class="bulk-card${closestPhys?.isOwnFakemon ? ' bulk-card-own' : ''}">
                        <div class="bulk-label">Physical Bulk (HP x Def)</div>
                        <div class="bulk-value">${physBulk.toLocaleString()}</div>
                        <div class="bulk-match">
                            <img class="bulk-match-sprite" src="${physSprite}" alt="${closestPhys ? closestPhys.name : ''}" onerror="window.fallbackPokemonImage(this, '${String(closestPhys?.name || '').replace(/'/g, "\\'")}', '${String(closestPhys?.baseSpecies || '').replace(/'/g, "\\'")}')">
                            <span class="bulk-match-name">Closest: ${getMatchLabel(closestPhys, 'physical')}</span>
                        </div>
                    </div>
                    <div class="bulk-card${closestSpec?.isOwnFakemon ? ' bulk-card-own' : ''}">
                        <div class="bulk-label">Special Bulk (HP x SpD)</div>
                        <div class="bulk-value">${specBulk.toLocaleString()}</div>
                        <div class="bulk-match">
                            <img class="bulk-match-sprite" src="${specSprite}" alt="${closestSpec ? closestSpec.name : ''}" onerror="window.fallbackPokemonImage(this, '${String(closestSpec?.name || '').replace(/'/g, "\\'")}', '${String(closestSpec?.baseSpecies || '').replace(/'/g, "\\'")}')">
                            <span class="bulk-match-name">Closest: ${getMatchLabel(closestSpec, 'special')}</span>
                        </div>
                    </div>
                </div>
            `;
        }

        function processArtworkFile(file) {
            if (!file) return;
            if (!file.type || !file.type.startsWith('image/')) {
                api.showToast('Please use an image file for artwork.', 'error');
                return;
            }
            const reader = new FileReader();
            reader.onload = (e) => {
                state.artworkData = e.target.result;
                const preview = document.getElementById('artwork-preview');
                if (preview) preview.innerHTML = `<img src="${state.artworkData}" alt="Artwork">`;
                const zone = document.getElementById('artwork-upload-zone');
                if (zone) zone.classList.remove('artwork-drag-over');
                updatePreview();
                autoSave();
            };
            reader.readAsDataURL(file);
        }

        function handleArtworkUpload(event) {
            processArtworkFile(event?.target?.files?.[0]);
            if (event?.target) event.target.value = '';
        }

        function handleArtworkDragOver(event) {
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
            document.getElementById('artwork-upload-zone')?.classList.add('artwork-drag-over');
        }

        function handleArtworkDragLeave(event) {
            event.preventDefault();
            event.stopPropagation();
            const zone = document.getElementById('artwork-upload-zone');
            if (!zone || !zone.contains(event.relatedTarget)) zone.classList.remove('artwork-drag-over');
        }

        function handleArtworkDrop(event) {
            event.preventDefault();
            event.stopPropagation();
            const file = event.dataTransfer?.files?.[0];
            processArtworkFile(file);
        }

        
// ==================== EGG GROUPS ====================
        function handleEggGroupChange() {
            updatePreview();
            autoSave();
        }

        function getEggGroupValue() {
            const egg1 = document.getElementById('fakemon-egg1').value;
            const egg2 = document.getElementById('fakemon-egg2').value;
            const groups = [];
            if (egg1) groups.push(egg1);
            if (egg2 && egg2 !== egg1) groups.push(egg2);
            return groups.join(', ') || 'None';
        }

        function setEggGroupValue(value) {
            const egg1 = document.getElementById('fakemon-egg1');
            const egg2 = document.getElementById('fakemon-egg2');
            if (!value || value === 'None') {
                egg1.value = '';
                egg2.value = '';
                return;
            }
            const groups = value.split(',').map(s => s.trim()).filter(Boolean);
            egg1.value = groups[0] || '';
            egg2.value = groups[1] || '';
        }

        
// ==================== GENDER BAR ====================
        
// ==================== HEIGHT / WEIGHT INPUT & CONVERSION ====================
function handleHeightInput(input) {
    // Strip any non-numeric characters except decimal point
    let val = input.value;
    // Allow only digits and at most one decimal point
    val = val.replace(/[^0-9.]/g, '');
    const parts = val.split('.');
    if (parts.length > 2) {
        val = parts[0] + '.' + parts.slice(1).join('');
    }
    input.value = val;
}
function handleWeightInput(input) {
    let val = input.value;
    val = val.replace(/[^0-9.]/g, '');
    const parts = val.split('.');
    if (parts.length > 2) {
        val = parts[0] + '.' + parts.slice(1).join('');
    }
    input.value = val;
}
function convertHeight() {
    const input = document.getElementById('fakemon-height');
    const unitSelect = document.getElementById('height-unit');
    const val = parseFloat(input.value);
    if (isNaN(val)) return;
    const oldUnit = input.dataset.lastUnit || 'm';
    const newUnit = unitSelect.value;
    if (oldUnit === newUnit) return;
    let converted;
    if (oldUnit === 'm' && newUnit === 'ft') {
        converted = val * 3.28084;
    } else if (oldUnit === 'ft' && newUnit === 'm') {
        converted = val / 3.28084;
    } else {
        converted = val;
    }
    // Round to 2 decimal places, strip trailing zeros
    input.value = parseFloat(converted.toFixed(2));
    input.dataset.lastUnit = newUnit;
}
function convertWeight() {
    const input = document.getElementById('fakemon-weight');
    const unitSelect = document.getElementById('weight-unit');
    const val = parseFloat(input.value);
    if (isNaN(val)) return;
    const oldUnit = input.dataset.lastUnit || 'kg';
    const newUnit = unitSelect.value;
    if (oldUnit === newUnit) return;
    let converted;
    if (oldUnit === 'kg' && newUnit === 'lb') {
        converted = val * 2.20462;
    } else if (oldUnit === 'lb' && newUnit === 'kg') {
        converted = val / 2.20462;
    } else {
        converted = val;
    }
    input.value = parseFloat(converted.toFixed(2));
    input.dataset.lastUnit = newUnit;
}
function getHeightDisplay() {
    const val = document.getElementById('fakemon-height').value;
    const unit = document.getElementById('height-unit').value;
    if (!val) return '';
    return val + ' ' + unit;
}
function getWeightDisplay() {
    const val = document.getElementById('fakemon-weight').value;
    const unit = document.getElementById('weight-unit').value;
    if (!val) return '';
    return val + ' ' + unit;
}

function getGenderRatioValue() {
            if (document.getElementById('gender-genderless').checked) return 'genderless';
            const male = parseFloat(document.getElementById('gender-male-input').value) || 0;
            const female = parseFloat(document.getElementById('gender-female-input').value) || 0;
            return `${male}-${female}`;
        }

        function setGenderRatioValue(ratio) {
            const genderlessCheckbox = document.getElementById('gender-genderless');
            if (ratio === 'genderless') {
                genderlessCheckbox.checked = true;
                toggleGenderless();
                updateGenderBar();
                return;
            }
            genderlessCheckbox.checked = false;
            toggleGenderless();
            const parts = ratio.split('-').map(Number);
            const male = isNaN(parts[0]) ? 50 : parts[0];
            const female = isNaN(parts[1]) ? (100 - male) : parts[1];
            document.getElementById('gender-slider').value = male;
            document.getElementById('gender-male-input').value = male;
            document.getElementById('gender-female-input').value = female;
            updateGenderBar();
        }

        function toggleGenderless() {
            const isGenderless = document.getElementById('gender-genderless').checked;
            document.getElementById('gender-ratio-controls').style.display = isGenderless ? 'none' : 'block';
            autoSave();
        }

        function genderSliderChanged() {
            const male = parseFloat(document.getElementById('gender-slider').value) || 0;
            document.getElementById('gender-male-input').value = male;
            document.getElementById('gender-female-input').value = Math.round((100 - male) * 10) / 10;
            autoSave();
        }

        function genderMaleInputChanged() {
            let male = parseFloat(document.getElementById('gender-male-input').value);
            if (isNaN(male)) male = 0;
            male = Math.min(100, Math.max(0, male));
            document.getElementById('gender-male-input').value = male;
            document.getElementById('gender-female-input').value = Math.round((100 - male) * 10) / 10;
            document.getElementById('gender-slider').value = male;
            autoSave();
        }

        function genderFemaleInputChanged() {
            let female = parseFloat(document.getElementById('gender-female-input').value);
            if (isNaN(female)) female = 0;
            female = Math.min(100, Math.max(0, female));
            document.getElementById('gender-female-input').value = female;
            const male = Math.round((100 - female) * 10) / 10;
            document.getElementById('gender-male-input').value = male;
            document.getElementById('gender-slider').value = male;
            autoSave();
        }

        function updateGenderBar() {
            const bar = document.getElementById('gender-bar-preview');
            if (document.getElementById('gender-genderless').checked) {
                bar.innerHTML = '<div class="genderless" style="width:100%"></div>';
                return;
            }
            const male = parseFloat(document.getElementById('gender-male-input').value) || 0;
            const female = parseFloat(document.getElementById('gender-female-input').value) || 0;
            let html = '';
            if (male > 0) html += `<div class="male" style="width:${male}%"></div>`;
            if (female > 0) html += `<div class="female" style="width:${female}%"></div>`;
            bar.innerHTML = html || '<div class="genderless" style="width:100%"></div>';
        }

        
// ==================== PREVIEW ====================
                
// ==================== FLAG HELPERS ====================
        function getFlagLabels(flags, category) {
            if (!flags) return [];
            const labels = [];
            const isStatus = category === 'Status';
            if (flags.contact) labels.push('Contact');
            if (flags.punch) labels.push('Punch');
            if (flags.slicing) labels.push('Slicing');
            if (flags.sound) labels.push('Sound');
            if (flags.bite) labels.push('Bite');
            if (flags.bullet) labels.push('Bullet');
            if (flags.pulse) labels.push('Pulse');
            if (flags.wind) labels.push('Wind');
            if (flags.dance) labels.push('Dance');
            if (flags.powder) labels.push('Powder');
            if (flags.heal || flags.recovery) labels.push('Heal');
            if (flags.thawing) labels.push('Thaws User');
            if (flags.charge) labels.push('Charge');
            if (flags.recharge) labels.push('Recharge');
            if (flags.highcrit) labels.push('High Crit');
            if (flags.ohko) labels.push('OHKO');
            if (flags.priority) labels.push('Priority');
            if (flags.multihit) labels.push('Multi-hit');
            if (flags.protect) labels.push('Bypass Protect');
            if (flags.bypasssub) labels.push('Bypass Substitute');
            if (isStatus && flags.reflectable) labels.push('Cannot be Bounced');
            if (isStatus && flags.snatch) labels.push('Unsnatchable');
            return labels;
        }

        function renderMoveTag(m) {
            const catClass = m.category === 'Physical' ? 'physical' : m.category === 'Special' ? 'special' : 'status';
            let lowValue = false;
            try { lowValue = !sampleMoveIsActuallyUseful(m); } catch (e) { lowValue = false; }
            const fadeClass = (typeof api.getFadeUselessMoves === 'function' ? api.getFadeUselessMoves() : true) && lowValue ? ' low-value' : '';
            return `<span class="move-tag ${catClass}${fadeClass}" onclick="showMoveDetail('${m.name}')">${m.name}</span>`;
        }



// ==================== TYPE WEAKNESS / RESISTANCE ====================
function getTypeDamageMultiplier(attackType, defendingTypes) {
    return defendingTypes.reduce((multiplier, defendingType) => {
        return multiplier * (TYPE_EFFECTIVENESS[attackType]?.[defendingType] ?? 1);
    }, 1);
}

function renderTypeEffectiveness() {
    const container = document.getElementById('type-effectiveness-analysis');
    if (!container) return;

    const type1 = document.getElementById('fakemon-type1')?.value || '';
    const type2 = document.getElementById('fakemon-type2')?.value || '';
    const defendingTypes = [type1, type2].filter(Boolean);

    if (!defendingTypes.length) {
        container.innerHTML = `
            <div class="type-effectiveness-empty">
                Select a type to see weaknesses and resistances.
            </div>`;
        return;
    }

    const groups = { weak: [], resist: [], immune: [] };
    POKEMON_TYPES.forEach(attackType => {
        const multiplier = getTypeDamageMultiplier(attackType, defendingTypes);
        if (multiplier >= 2) groups.weak.push({ type: attackType, multiplier });
        else if (multiplier === 0) groups.immune.push({ type: attackType, multiplier });
        else if (multiplier > 0 && multiplier < 1) groups.resist.push({ type: attackType, multiplier });
    });

    const renderGroup = (title, items, className) => {
        if (!items.length) return '';
        return `
            <div class="type-effectiveness-group ${className}">
                <div class="type-effectiveness-group-title">${title}</div>
                <div class="type-effectiveness-pills">
                    ${items.map(({ type, multiplier }) => `
                        <span class="type-effectiveness-item">
                            <span class="type-pill type-${type.toLowerCase()}">${type}</span>
                            <span class="type-effectiveness-multiplier">${multiplier === 0 ? '0×' : multiplier + '×'}</span>
                        </span>
                    `).join('')}
                </div>
            </div>`;
    };

    container.innerHTML = `
        ${renderGroup('Weak to', groups.weak, 'weak')}
        ${renderGroup('Resists', groups.resist, 'resist')}
        ${renderGroup('Immune to', groups.immune, 'immune')}
        ${(!groups.weak.length && !groups.resist.length && !groups.immune.length) ? '<div class="type-effectiveness-empty">No special matchups.</div>' : ''}
    `;
}

function updatePreview() {
            renderTypeEffectiveness();
            const name = document.getElementById('fakemon-name').value || 'Unnamed Pokemon';
            const speciesRaw = document.getElementById('fakemon-species').value.trim();
            const species = speciesRaw ? (/^the\s/i.test(speciesRaw) ? speciesRaw : 'The ' + speciesRaw) : '';
            const type1 = document.getElementById('fakemon-type1').value;
            const type2 = document.getElementById('fakemon-type2').value;
            const number = document.getElementById('fakemon-number').value;
            const hp = parseInt(document.getElementById('stat-hp').value) || 0;
            const atk = parseInt(document.getElementById('stat-atk').value) || 0;
            const def = parseInt(document.getElementById('stat-def').value) || 0;
            const spa = parseInt(document.getElementById('stat-spa').value) || 0;
            const spd = parseInt(document.getElementById('stat-spd').value) || 0;
            const spe = parseInt(document.getElementById('stat-spe').value) || 0;
            const bst = hp + atk + def + spa + spd + spe;
            const dex1 = document.getElementById('dex-entry1').value;
            const dex2 = document.getElementById('dex-entry2').value;
            const height = getHeightDisplay();
            const weight = getWeightDisplay();
            const color = document.getElementById('fakemon-color').value;
            const eggs = getEggGroupValue();
            const genderRatio = getGenderRatioValue();

            const type1Class = type1 ? `type-${type1.toLowerCase()}` : '';
            const type2Class = type2 ? `type-${type2.toLowerCase()}` : '';

            const genderLabels = (() => {
                const l = {};
                if (genderRatio !== 'genderless') {
                    const [m, f] = genderRatio.split('-').map(Number);
                    l[genderRatio] = (m > 0 && f > 0) ? `${m}% Male / ${f}% Female` : (m > 0 ? '100% Male' : '100% Female');
                }
                l['genderless'] = 'Genderless';
                return l;
            })();
            const genderBarHtml = (() => {
                if (genderRatio === 'genderless') return '<div class="genderless" style="width:100%"></div>';
                const [m, f] = genderRatio.split('-').map(Number);
                let html = '';
                if (m > 0) html += `<div class="male" style="width:${m}%"></div>`;
                if (f > 0) html += `<div class="female" style="width:${f}%"></div>`;
                return html || '<div class="genderless" style="width:100%"></div>';
            })();

            

            const allMoves = state.learnset.filter(m => m && m.name);
            const physMoves = allMoves.filter(m => m.category === 'Physical');
            const specMoves = allMoves.filter(m => m.category === 'Special');
            const statMoves = allMoves.filter(m => m.category === 'Status');
            const physTags = physMoves.map(m => renderMoveTag(m)).join('');
            const specTags = specMoves.map(m => renderMoveTag(m)).join('');
            const statTags = statMoves.map(m => renderMoveTag(m)).join('');
            const customMoves = allMoves.filter(isCustomMove);
            const customMoveTags = '';
            

            const allAbilities = state.abilities.filter(a => a.name);

            let abilitiesHtml = '';
            if (allAbilities.length > 0) {
                abilitiesHtml = '<div class="board-abilities-compact"><div class="board-section-title" style="margin-bottom:6px; font-size: 12px;">Abilities</div>';
                allAbilities.forEach((a, abilityIndex) => {
                    const isCustom = a.source === 'custom' || a.custom === true;
                    const role = getAbilityRole(abilityIndex);
                    const roleHtml = role ? '<span class="board-ability-role ' + role.toLowerCase() + '">' + role + '</span>' : '';
                    const sdEntry = Object.entries(state.sdAbilities).find(([k,v]) => v.name === a.name);
                    const desc = isCustom ? (a.desc || a.description || '') : ((sdEntry && sdEntry[1].desc) || a.desc || '');
                    abilitiesHtml += '<div class="board-ability-item' + (isCustom ? ' board-ability-custom' : '') + '"><div class="board-ability-name-row"><span class="ability-name">' + escapeHtml(a.name) + '</span>' + roleHtml + '</div>';
                    if (desc) abilitiesHtml += '<span class="ability-desc">' + escapeHtml(desc) + '</span>';
                    abilitiesHtml += '</div>';
                });
                abilitiesHtml += '</div>';
            }

            // Pre-compute dex entries HTML
            let dexHtml = '';
            if (dex1 || dex2) {
                dexHtml = '<div class="board-dex-entries-compact" style="margin-top:0;"><div class="board-section-title">Pokedex Entries</div><div class="dex-entries">';
                if (dex1) dexHtml += '<div class="dex-entry"><div class="dex-entry-label">Entry 1</div>' + dex1 + '</div>';
                if (dex2) dexHtml += '<div class="dex-entry"><div class="dex-entry-label">Entry 2</div>' + dex2 + '</div>';
                dexHtml += '</div></div>';
            }

            // Pre-compute state.learnset HTML. Custom moves live directly inside
            // the Learnset section now; there is no separate Custom Moves panel.
            let learnsetHtml = '';
            const hasLearnset = !!(physTags || specTags || statTags || customMoveTags || customMoves.length);
            if (hasLearnset) {
                learnsetHtml = '<div class="board-section board-learnset-col"><div class="board-section-title">Learnset</div>';
                if (physTags) learnsetHtml += '<div class="move-category physical"><div class="move-category-title">' + getCategoryIcon('Physical', 18) + ' Physical</div><div class="move-list">' + physTags + '</div></div>';
                if (specTags) learnsetHtml += '<div class="move-category special"><div class="move-category-title">' + getCategoryIcon('Special', 18) + ' Special</div><div class="move-list">' + specTags + '</div></div>';
                if (statTags) learnsetHtml += '<div class="move-category status"><div class="move-category-title">' + getCategoryIcon('Status', 18) + ' Status</div><div class="move-list">' + statTags + '</div></div>';

                customMoves.forEach(m => {
                    const typeClass = 'type-' + (m.type || 'Normal').toLowerCase();
                    const flagLabels = getFlagLabels(m.flags || {}, m.category);
                    const flagHtml = flagLabels.length ? '<div class="cm-flags">' + flagLabels.map(f => '<span class="flag-tidbit">' + escapeHtml(f) + '</span>').join('') + '</div>' : '';
                    const accText = (m.accuracy === true || m.accuracy === undefined || m.accuracy === false) ? '—' : m.accuracy + '%';
                    const methodText = m.learnMethod === 'level' && m.level ? ' · Level ' + m.level : m.learnMethod === 'tm' ? ' · TM' : m.learnMethod === 'egg' ? ' · Egg' : '';
                    learnsetHtml += '<div class="board-custom-move-item board-custom-move-inline" onclick="openCustomMoveModal(' + state.learnset.indexOf(m) + ')"><span class="cm-type ' + typeClass + '">' + escapeHtml(m.type || 'Normal') + '</span><div class="cm-body"><div class="cm-name">' + escapeHtml(m.name) + '</div><div class="cm-stats">' + escapeHtml(m.category || 'Status') + ' · ' + (m.basePower || '—') + ' BP · ' + accText + ' acc · ' + (m.pp || '—') + ' PP' + methodText + (m.priority ? ' · Priority ' + m.priority : '') + '</div>' + (m.desc ? '<div class="cm-desc">' + escapeHtml(m.desc) + '</div>' : '') + flagHtml + '</div></div>';
                });
                learnsetHtml += '</div>';
            }

            // Pre-compute sample sets HTML
            let setsHtml = '';
            if (state.sampleSets.length > 0) {
                setsHtml = '<div class="board-section board-sets-col"><div class="board-section-title">Sample Sets</div>';
                state.sampleSets.forEach((set, i) => {
                    const exportText = generateShowdownExport(name, set);
                    // Escape HTML and preserve line breaks for the preview
                    const escapedText = exportText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    const safeText = exportText.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                    setsHtml += '<div style="margin-bottom:12px;"><div style="font-size:12px;font-weight:700;margin-bottom:4px;color:var(--text-primary);">' + (set.name || 'Set ' + (i+1)) + '</div><div class="sample-set-output" style="margin-top:0;"><button class="sample-set-copy" data-copy-text="' + safeText + '" title="Copy to clipboard"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button><span class="sample-set-output-text">' + escapedText + '</span></div></div>';
                });
                setsHtml += '</div>';
            }

            const container = document.getElementById('pokedex-board-container');
            container.innerHTML = `
                <div class="pokedex-board" id="pokedex-board-export">
                    <div class="board-header">
                        <div class="board-number">${number || '#???'}</div>
                    </div>

                    <!-- Centered Name & Species -->
                    <div style="text-align: center; margin-bottom: 16px;">
                        <div class="board-name"><h2>${name}</h2></div>
                        ${species ? `<div class="board-species">${species}</div>` : ''}
                        <div class="board-types" style="justify-content: center; margin-top: 8px;">
                            ${type1 ? `<span class="type-badge ${type1Class}">${type1}</span>` : ''}
                            ${type2 ? `<span class="type-badge ${type2Class}">${type2}</span>` : ''}
                        </div>
                    </div>

                    <!-- Top Row: Art (left) | Data + Dex Entries (right, side by side) -->
                    <div class="board-top-row">
                        <div class="board-artwork-left">
                            ${state.artworkData ? `<img src="${state.artworkData}" alt="${name}">` : '<span class="placeholder">ART</span>'}
                        </div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                            <div class="board-data-right">
                                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px;">
                                    ${height ? `<div class="board-data-row"><span class="label">Height</span><span class="value">${height}</span></div>` : ''}
                                    ${weight ? `<div class="board-data-row"><span class="label">Weight</span><span class="value">${weight}</span></div>` : ''}
                                    ${color ? `<div class="board-data-row"><span class="label">Color</span><span class="value">${color}</span></div>` : ''}
                                    ${eggs && eggs !== 'None' ? `<div class="board-data-row"><span class="label">Egg</span><span class="value">${eggs}</span></div>` : ''}
                                </div>
                                <div class="board-gender-compact">
                                    <span class="label" style="min-width: 60px; font-size: 10px;">Gender</span>
                                    <div class="gender-bar">${genderBarHtml}</div>
                                    <span class="gender-label">${genderLabels[genderRatio] || genderRatio}</span>
                                </div>
                                ${abilitiesHtml}
                            </div>
                            ${dexHtml}
                        </div>
                    </div>

                    <!-- Bottom Row: Learnset (left) | Stats + Sample Sets stacked (right) -->
                    <div class="board-lower-row">
                        <div class="board-learnset-slot">${learnsetHtml || ''}</div>
                        <div class="board-sets-slot">
                            <div class="board-section board-stats-narrow">
                                <div class="board-section-title">Base Stats</div>
                                <div class="stat-bar-container"><span class="stat-label">HP</span><div class="stat-bar-bg"><div class="stat-bar-fill hp" style="width:${Math.min(hp/255*100,100)}%"></div></div><span class="stat-value">${hp}</span></div>
                                <div class="stat-bar-container"><span class="stat-label">ATK</span><div class="stat-bar-bg"><div class="stat-bar-fill atk" style="width:${Math.min(atk/255*100,100)}%"></div></div><span class="stat-value">${atk}</span></div>
                                <div class="stat-bar-container"><span class="stat-label">DEF</span><div class="stat-bar-bg"><div class="stat-bar-fill def" style="width:${Math.min(def/255*100,100)}%"></div></div><span class="stat-value">${def}</span></div>
                                <div class="stat-bar-container"><span class="stat-label">SPA</span><div class="stat-bar-bg"><div class="stat-bar-fill spa" style="width:${Math.min(spa/255*100,100)}%"></div></div><span class="stat-value">${spa}</span></div>
                                <div class="stat-bar-container"><span class="stat-label">SPD</span><div class="stat-bar-bg"><div class="stat-bar-fill spd" style="width:${Math.min(spd/255*100,100)}%"></div></div><span class="stat-value">${spd}</span></div>
                                <div class="stat-bar-container"><span class="stat-label">SPE</span><div class="stat-bar-bg"><div class="stat-bar-fill spe" style="width:${Math.min(spe/255*100,100)}%"></div></div><span class="stat-value">${spe}</span></div>
                                <div class="board-bst-display"><span class="label">Base Stat Total</span><span class="value">${bst}</span></div>
                            </div>
                            ${setsHtml || ''}
                        </div>
                    </div>
                </div>
            `;
            autoSave();
            // Attach copy button listeners for preview sample sets
            container.querySelectorAll('.sample-set-copy[data-copy-text]').forEach(btn => {
                btn.onclick = () => copySampleSetText(btn.dataset.copyText);
            });
        }




export { getNextPokedexNumber, resetEditor, loadFakemonIntoEditor, updateEditorStats, updateStats, getSpriteUrl, updateBulkComparison, handleArtworkUpload, handleArtworkDragOver, handleArtworkDragLeave, handleArtworkDrop, handleEggGroupChange, getEggGroupValue, setEggGroupValue, getGenderRatioValue, setGenderRatioValue, toggleGenderless, genderSliderChanged, genderMaleInputChanged, genderFemaleInputChanged, updateGenderBar, getFlagLabels, renderMoveTag, updatePreview, handleHeightInput, handleWeightInput, convertHeight, convertWeight, getHeightDisplay, getWeightDisplay, getTypeDamageMultiplier, renderTypeEffectiveness };