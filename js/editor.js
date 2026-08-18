import { log } from './log.js';
import { state, api } from './app.js';

import { POKEMON_TYPES, NATURE_DATA, NATURES, STAT_NAMES, TYPE_EFFECTIVENESS } from './data.js';
import { showDetailPopup, updateSampleSet } from './sample-sets.js';
import { getFlagLabels, updateBulkComparison, updatePreview } from './editor-core.js';

// ==================== SHOWDOWN DATA ====================
        // Showdown's move dex does not expose a numeric per-move usefulness rating.
        // We therefore derive a deterministic competitive-usefulness weight from
        // Showdown/Smogon sample-set frequency. This is deliberately a ranking signal,
        // not a hard requirement, so Fakemon-exclusive/custom moves still work.
        async function loadCompetitiveMoveUsefulness() {
            if (state.sdMoveUsefulness && Object.keys(state.sdMoveUsefulness).length) return;
            state.sdMoveUsefulness = {};
            const urls = [
                'https://pkmn.github.io/smogon/data/sets/gen9ou.json',
                'https://pkmn.github.io/smogon/data/sets/gen9uu.json',
                'https://pkmn.github.io/smogon/data/sets/gen9ru.json'
            ];
            for (const url of urls) {
                try {
                    const res = await fetch(url);
                    if (!res.ok) continue;
                    const data = await res.json();
                    for (const sets of Object.values(data || {})) {
                        for (const set of Object.values(sets || {})) {
                            const moves = Array.isArray(set.moves) ? set.moves : [];
                            for (const entry of moves) {
                                const names = Array.isArray(entry) ? entry : [entry];
                                for (const name of names) {
                                    if (!name) continue;
                                    state.sdMoveUsefulness[name] = (state.sdMoveUsefulness[name] || 0) + 1;
                                }
                            }
                        }
                    }
                } catch (err) {
                    log.warn('SAMPLE SETS', 'Competitive move weights unavailable', { url, error: err });
                }
            }
            const values = Object.values(state.sdMoveUsefulness);
            const max = Math.max(1, ...values);
            Object.keys(state.sdMoveUsefulness).forEach(name => {
                // Log scaling prevents a few ubiquitous moves from drowning out
                // genuinely useful but less common moves.
                state.sdMoveUsefulness[name] = 1 + 11 * Math.log1p(state.sdMoveUsefulness[name]) / Math.log1p(max);
            });
        }

        async function fetchShowdownData() {
            const done = log.time('SHOWDOWN', 'fetchShowdownData');
            log.info('SHOWDOWN', 'Fetching Showdown datasets');
            const statusEl = document.getElementById('api-status');
            if (statusEl) statusEl.style.display = 'none';
            log.debug('SHOWDOWN', 'Requesting moves, abilities, items, pokedex, and learnsets');

            try {
                const [movesRes, abilitiesRes, itemsRes, pokedexRes, learnsetsRes] = await Promise.all([
                    fetch('https://play.pokemonshowdown.com/data/moves.json'),
                    fetch('https://play.pokemonshowdown.com/data/abilities.js'),
                    fetch('https://play.pokemonshowdown.com/data/items.js'),
                    fetch('https://play.pokemonshowdown.com/data/pokedex.json'),
                    fetch('https://play.pokemonshowdown.com/data/learnsets.json')
                ]);

                const movesRaw = await movesRes.json();
                const abilitiesText = await abilitiesRes.text();
                const itemsText = await itemsRes.text();
                const pokedexRaw = await pokedexRes.json();
                const learnsetsRaw = await learnsetsRes.json();

                // parse abilities - captures Showdown's own ability rating
                // (-1 to 5, see data/abilities.ts upstream) alongside the
                // name/desc, so analysis.js can score abilities off Showdown's
                // real assessment instead of a hand-curated list.
                const abilitiesMatch = abilitiesText.match(/exports\.BattleAbilities\s*=\s*(\{[\s\S]*\});/);
                if (abilitiesMatch) {
                    let jsonStr = abilitiesMatch[1].replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_-]*)(\s*:)/g, '$1"$2"$3');
                    const abilitiesRaw = JSON.parse(jsonStr);
                    for (const [key, a] of Object.entries(abilitiesRaw)) {
                        if (a.isNonstandard === 'Past') continue;
                        state.sdAbilities[key] = {
                            name: a.name || key,
                            desc: a.shortDesc || a.desc || '',
                            rating: typeof a.rating === 'number' ? a.rating : null
                        };
                    }
                }

                // Parse items
                const itemsMatch = itemsText.match(/exports\.BattleItems\s*=\s*(\{[\s\S]*\});/);
                if (itemsMatch) {
                    let jsonStr = itemsMatch[1].replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_-]*)(\s*:)/g, '$1"$2"$3');
                    const itemsRaw = JSON.parse(jsonStr);
                    for (const [key, i] of Object.entries(itemsRaw)) {
                        if (i.isNonstandard === 'Past') continue;
                        state.sdItems[key] = { name: i.name || key, desc: i.desc || i.shortDesc || '' };
                    }
                }

                // Parse moves
                for (const [key, m] of Object.entries(movesRaw)) {
                    if (m.isNonstandard === 'Future') continue;
                    state.sdMoves[key] = {
                        name: m.name || key,
                        category: m.category || 'Status',
                        type: m.type || 'Normal',
                        basePower: m.basePower || 0,
                        accuracy: m.accuracy,
                        pp: m.pp || 0,
                        priority: m.priority || 0,
                        flags: m.flags || {},
                        desc: m.desc || m.shortDesc || ''
                    };
                }

                // Parse pokedex (species stats/typing/height/weight/color/egg groups/gender)
                // - used to find real Pokemon similar to this Fakemon for state.learnset generation.
                for (const [key, p] of Object.entries(pokedexRaw)) {
                    if (!p.baseStats || !p.types || !p.num || p.num <= 0) continue; // skip CAP/nonstandard/formes w/o stats
                    // Keep all usable alternate formes (regional, Mega, Unbound, Totem,
                    // Origin, Therian, etc.). The old filter discarded Mega/other formes,
                    // which made them impossible to use as templates or comparisons.
                    let genderPct = 50;
                    if (p.gender === 'N') genderPct = -1; // genderless
                    else if (p.gender === 'M') genderPct = 100;
                    else if (p.gender === 'F') genderPct = 0;
                    else if (p.genderRatio) genderPct = Math.round((p.genderRatio.M || 0) * 100);
                    state.sdPokedex[key] = {
                        id: key,
                        num: p.num,
                        name: p.name || key,
                        types: p.types || [],
                        stats: p.baseStats,
                        heightm: p.heightm || 0,
                        weightkg: p.weightkg || 0,
                        color: p.color || '',
                        eggGroups: p.eggGroups || [],
                        genderPct,
                        forme: p.forme || '',
                        baseSpecies: p.baseSpecies || '',
                        // Showdown stores regional/form abilities directly on the
                        // Pokedex entry. Keep them with the species record so template
                        // creation can populate the editor without guessing from names.
                        abilities: p.abilities || {}
                    };

                    // Showdown's internal IDs omit punctuation in many form names
                    // (e.g. raticatealola), while users/databases commonly use
                    // raticate-alola. Make both spellings resolve to the same record
                    // without duplicating entries in Object.values()/bulk comparison.
                    const dashedId = String(p.name || key).toLowerCase()
                        .replace(/['’]/g, '')
                        .replace(/[^a-z0-9]+/g, '-')
                        .replace(/^-+|-+$/g, '');
                    const compactId = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
                    [dashedId, compactId].forEach(alias => {
                        if (alias && alias !== key && !Object.prototype.hasOwnProperty.call(state.sdPokedex, alias)) {
                            Object.defineProperty(state.sdPokedex, alias, { value: state.sdPokedex[key], enumerable: false, configurable: true });
                        }
                    });
                }
                // Parse learnsets (moveid -> array of "{gen}{method}{level?}" source strings)
                for (const [key, l] of Object.entries(learnsetsRaw)) {
                    if (!l.learnset) continue;
                    state.sdLearnsets[key] = l.learnset;
                    const dex = state.sdPokedex[key];
                    const dashedId = String(dex?.name || key).toLowerCase()
                        .replace(/['’]/g, '')
                        .replace(/[^a-z0-9]+/g, '-')
                        .replace(/^-+|-+$/g, '');
                    if (dashedId && dashedId !== key && !Object.prototype.hasOwnProperty.call(state.sdLearnsets, dashedId)) {
                        Object.defineProperty(state.sdLearnsets, dashedId, { value: l.learnset, enumerable: false, configurable: true });
                    }
                }

                state.sdLoaded = true;
                done({ moves: Object.keys(state.sdMoves).length, abilities: Object.keys(state.sdAbilities).length, items: Object.keys(state.sdItems).length, pokedex: Object.keys(state.sdPokedex).length });
                log.info('SHOWDOWN', 'Showdown datasets loaded', { moves: Object.keys(state.sdMoves).length, abilities: Object.keys(state.sdAbilities).length, items: Object.keys(state.sdItems).length, pokedex: Object.keys(state.sdPokedex).length });
                // A Fakemon may have been loaded before the async Showdown fetch
                // completed. Rehydrate its minimal saved learnset now that the
                // authoritative vanilla move data is available.
                rehydrateCurrentLearnsetFromShowdown();
                log.info('SHOWDOWN', 'Data loaded', { moves: Object.keys(state.sdMoves).length, species: Object.keys(state.sdPokedex).length, abilities: Object.keys(state.sdAbilities).length, items: Object.keys(state.sdItems).length });
                api.showToast('Showdown data loaded!', 'success');
                updateBulkComparison();
            } catch (err) {
                log.error('SHOWDOWN', 'Data loading failed', err);
                state.sdLoaded = false;
                api.showToast('Showdown data unavailable. Using custom entry only.', 'error');
            }
        }

        
// ==================== AUTOCOMPLETE ====================
        function filterAbilities(query) {
            const dropdown = document.getElementById('ability-dropdown');
            if (!query.trim()) { dropdown.classList.remove('active'); return; }
            const matches = Object.entries(state.sdAbilities)
                .filter(([k, v]) => v.name.toLowerCase().includes(query.toLowerCase()))
                .slice(0, 8);
            renderDropdown(dropdown, matches.map(([k,v]) => ({key:k, ...v})), (item) => {
                addAbility(item.name, 'sd');
                document.getElementById('ability-input').value = '';
                dropdown.classList.remove('active');
            }, false);
        }
        function filterMoves(query) {
            const dropdown = document.getElementById('move-dropdown');
            if (!query.trim()) { dropdown.classList.remove('active'); return; }
            const matches = Object.entries(state.sdMoves)
                .filter(([k, v]) => v.name.toLowerCase().includes(query.toLowerCase()))
                .slice(0, 8);
            renderDropdown(dropdown, matches.map(([k,v]) => ({key:k, ...v})), (item) => {
                const method = document.getElementById('move-method').value;
                const level = method === 'level' ? document.getElementById('move-level').value : null;
                addLearnsetMove(item, method, level);
                document.getElementById('move-input').value = '';
                dropdown.classList.remove('active');
            }, true);
        }
        function renderDropdown(dropdown, items, onClick, showCategory) {
            if (items.length === 0) {
                dropdown.innerHTML = '<div class="autocomplete-item">No matches</div>';
                dropdown.classList.add('active'); return;
            }
            dropdown.innerHTML = items.map((item, i) => {
                let catBadge = '';
                if (showCategory && item.category) {
                    const catClass = item.category === 'Physical' ? 'cat-physical' : item.category === 'Special' ? 'cat-special' : 'cat-status';
                    catBadge = `<span class="cat-badge ${catClass}">${getCategoryIcon(item.category, 12)}</span>`;
                }
                return `<div class="autocomplete-item" data-index="${i}">${item.name}${catBadge}</div>`;
            }).join('');
            dropdown.querySelectorAll('.autocomplete-item').forEach((el, i) => {
                el.addEventListener('mousedown', (e) => { e.preventDefault(); onClick(items[i]); });
            });
            dropdown.classList.add('active');
        }
        function hideAbilityDropdownDelayed() { setTimeout(() => document.getElementById('ability-dropdown').classList.remove('active'), 200); }
        function hideMoveDropdownDelayed() { setTimeout(() => document.getElementById('move-dropdown').classList.remove('active'), 200); }
        function toggleLevelInput() {
            const method = document.getElementById('move-method').value;
            const levelInput = document.getElementById('move-level');
            if (method === 'level') {
                levelInput.style.display = 'inline-block';
                levelInput.focus();
            } else {
                levelInput.style.display = 'none';
                levelInput.value = '';
            }
        }
        function findClosestAbility(query) {
            if (!query.trim()) return null;
            const q = query.toLowerCase().trim();

            // Exact match (case-insensitive)
            let match = Object.entries(state.sdAbilities).find(([k, v]) => v.name.toLowerCase() === q);
            if (match) return match[1];

            // Key exact match
            match = Object.entries(state.sdAbilities).find(([k, v]) => k.toLowerCase() === q);
            if (match) return match[1];

            // Starts with
            let startsWith = Object.entries(state.sdAbilities).filter(([k, v]) => v.name.toLowerCase().startsWith(q));
            if (startsWith.length === 1) return startsWith[0][1];
            if (startsWith.length > 1) {
                startsWith.sort((a, b) => a[1].name.length - b[1].name.length);
                return startsWith[0][1];
            }

            // Includes
            let includes = Object.entries(state.sdAbilities).filter(([k, v]) => v.name.toLowerCase().includes(q));
            if (includes.length === 1) return includes[0][1];
            if (includes.length > 1) {
                includes.sort((a, b) => a[1].name.length - b[1].name.length);
                return includes[0][1];
            }

            // Word-boundary match
            let wordMatches = Object.entries(state.sdAbilities).filter(([k, v]) => {
                const name = v.name.toLowerCase();
                const words = name.split(/[\s\-]+/);
                return words.some(w => w.startsWith(q) || w === q);
            });
            if (wordMatches.length > 0) {
                wordMatches.sort((a, b) => a[1].name.length - b[1].name.length);
                return wordMatches[0][1];
            }

            return null;
        }
        function handleAbilityKey(e) {
            if (e.key === 'Enter') {
                const val = e.target.value.trim();
                if (val) {
                    const closest = findClosestAbility(val);
                    if (closest) {
                        addAbility(closest.name, 'sd');
                        e.target.value = '';
                        document.getElementById('ability-dropdown').classList.remove('active');
                    }
                    // No match: leave the input as-is so the user can keep typing
                    // rather than silently accepting an invalid ability name.
                } else {
                    e.target.value = '';
                    document.getElementById('ability-dropdown').classList.remove('active');
                }
            }
        }
                
// ==================== ADVANCED MOVE BROWSER ====================
        // Filter panel is parameter-driven: name text, type/category/priority
        // selects, min BP/Acc/PP thresholds, and toggleable flag chips (AND'd
        // together) - all read straight from the modal's form controls.
        const MOVE_FLAG_KEYWORDS = {
            contact: 'contact', punch: 'punch', slicing: 'slicing', sound: 'sound',
            bite: 'bite', bullet: 'bullet', pulse: 'pulse', wind: 'wind', dance: 'dance',
            powder: 'powder', heal: 'heal', thawing: 'thawing',
            charge: 'charge', recharge: 'recharge', highcrit: 'highcrit',
            ohko: 'ohko', priority: 'priority', multihit: 'multihit', pivot: 'pivot',
            protect: 'protect', bypasssub: 'bypasssub', reflectable: 'reflectable', snatch: 'snatch'
        };
        const activeMoveBrowserFlags = new Set();

        function getAllBrowsableMoves() {
            const sd = Object.entries(state.sdMoves).map(([k, v]) => ({ key: k, ...v }));
            const custom = (state.customMoves || []).map(m => ({ key: 'custom:' + m.name, ...m, custom: true }));
            const seen = new Set();
            return [...sd, ...custom].filter(m => {
                if (!m.name || seen.has(m.name.toLowerCase())) return false;
                seen.add(m.name.toLowerCase());
                return true;
            });
        }

        function populateMoveBrowserTypeOptions() {
            const typeMenu = document.getElementById('mb-filter-type-menu');
            if (typeMenu && !typeMenu.children.length) {
                typeMenu.innerHTML = buildTypeMenuOptions(t => `selectMoveBrowserTypeFilter('${t}')`, true, 'Any Type');
            }
            const catMenu = document.getElementById('mb-filter-category-menu');
            if (catMenu && !catMenu.children.length) {
                catMenu.innerHTML = buildCatMenuOptions(c => `selectMoveBrowserCategoryFilter('${c}')`, true, 'Any Category');
            }
        }

        function selectMoveBrowserTypeFilter(type) {
            document.getElementById('mb-filter-type').value = type;
            setTypeDropdownValue('mb-filter-type', type, 'Any Type');
            filterMoveBrowser();
        }

        function selectMoveBrowserCategoryFilter(category) {
            document.getElementById('mb-filter-category').value = category;
            setCatDropdownValue('mb-filter-category', category, 'Any Category');
            filterMoveBrowser();
        }

        function renderMoveBrowserFlagChips() {
            const container = document.getElementById('mb-filter-flags');
            if (!container || container.children.length) return;
            container.innerHTML = Object.keys(MOVE_FLAG_KEYWORDS).map(key => {
                const label = key.charAt(0).toUpperCase() + key.slice(1);
                return `<span class="mb-flag-chip" data-flag="${key}" onclick="toggleMoveBrowserFlag('${key}')">${label}</span>`;
            }).join('');
        }

        function toggleMoveBrowserFlag(flag) {
            if (activeMoveBrowserFlags.has(flag)) activeMoveBrowserFlags.delete(flag);
            else activeMoveBrowserFlags.add(flag);
            document.querySelectorAll('#mb-filter-flags .mb-flag-chip').forEach(chip => {
                chip.classList.toggle('active', activeMoveBrowserFlags.has(chip.dataset.flag));
            });
            filterMoveBrowser();
        }

        function clearMoveBrowserFilters() {
            document.getElementById('mb-filter-name').value = '';
            document.getElementById('mb-filter-type').value = '';
            setTypeDropdownValue('mb-filter-type', '', 'Any Type');
            document.getElementById('mb-filter-category').value = '';
            setCatDropdownValue('mb-filter-category', '', 'Any Category');
            document.getElementById('mb-filter-priority').value = '';
            document.getElementById('mb-filter-bp-min').value = '';
            document.getElementById('mb-filter-acc-min').value = '';
            document.getElementById('mb-filter-pp-min').value = '';
            activeMoveBrowserFlags.clear();
            document.querySelectorAll('#mb-filter-flags .mb-flag-chip').forEach(chip => chip.classList.remove('active'));
            filterMoveBrowser();
        }

        function openMoveBrowserModal() {
            populateMoveBrowserTypeOptions();
            renderMoveBrowserFlagChips();
            clearMoveBrowserFilters();
            document.getElementById('move-browser-modal')?.classList.add('active');
            setTimeout(() => document.getElementById('mb-filter-name')?.focus(), 0);
        }

        function moveMatchesBrowserFilters(move) {
            const name = document.getElementById('mb-filter-name')?.value.trim().toLowerCase() || '';
            const type = document.getElementById('mb-filter-type')?.value || '';
            const category = document.getElementById('mb-filter-category')?.value || '';
            const priority = document.getElementById('mb-filter-priority')?.value || '';
            const bpMin = parseInt(document.getElementById('mb-filter-bp-min')?.value, 10);
            const accMin = parseInt(document.getElementById('mb-filter-acc-min')?.value, 10);
            const ppMin = parseInt(document.getElementById('mb-filter-pp-min')?.value, 10);

            if (name && !(move.name || '').toLowerCase().includes(name)) return false;
            if (type && move.type !== type) return false;
            if (category && move.category !== category) return false;

            const moveIsPriority = Number(move.priority) || 0;
            if (priority === 'positive' && !(moveIsPriority > 0)) return false;
            if (priority === 'negative' && !(moveIsPriority < 0)) return false;
            if (priority === 'zero' && moveIsPriority !== 0) return false;

            if (Number.isFinite(bpMin) && (Number(move.basePower) || 0) < bpMin) return false;
            if (Number.isFinite(accMin)) {
                const acc = (move.accuracy === true || move.accuracy === undefined) ? 100 : (move.accuracy === false ? 0 : Number(move.accuracy) || 0);
                if (acc < accMin) return false;
            }
            if (Number.isFinite(ppMin) && (Number(move.pp) || 0) < ppMin) return false;

            if (activeMoveBrowserFlags.size) {
                const flags = getMoveEditorFlags(move);
                for (const flag of activeMoveBrowserFlags) {
                    if (!flags[MOVE_FLAG_KEYWORDS[flag]]) return false;
                }
            }
            return true;
        }

        function filterMoveBrowser() {
            const list = document.getElementById('move-browser-results');
            const countEl = document.getElementById('move-browser-count');
            if (!list) return;
            const matches = getAllBrowsableMoves().filter(moveMatchesBrowserFilters).sort((a, b) => a.name.localeCompare(b.name));
            if (countEl) countEl.textContent = `${matches.length} move${matches.length === 1 ? '' : 's'}`;
            if (!matches.length) {
                list.innerHTML = '<div class="move-browser-empty">No moves match those filters.</div>';
                return;
            }
            const alreadyAdded = new Set(state.learnset.filter(m => m && m.name).map(m => m.name.toLowerCase()));
            list.innerHTML = matches.map(m => {
                const typeClass = `type-${(m.type || 'normal').toLowerCase()}`;
                const acc = (m.accuracy === true || m.accuracy === undefined) ? '-' : (m.accuracy === false ? '-' : `${m.accuracy}%`);
                const added = alreadyAdded.has(m.name.toLowerCase());
                const catClass = m.category === 'Physical' ? 'cat-physical' : m.category === 'Special' ? 'cat-special' : 'cat-status';
                return `<div class="move-browser-card${added ? ' added' : ''}" data-move-key="${escapeHtml(m.key)}" onclick="addMoveFromBrowser('${escapeHtml(m.key).replace(/'/g, "\\'")}')" title="${added ? 'Already in learnset' : 'Click to add to learnset'}">
                    <div class="move-browser-card-top">
                        <span class="type-pill ${typeClass}">${m.type || '?'}</span>
                        <span class="cat-pill ${catClass}">${getCategoryIcon(m.category, 12)} ${m.category || 'Status'}</span>
                        ${added ? '<span class="move-browser-added-badge">Added</span>' : ''}
                    </div>
                    <div class="move-browser-card-name">${escapeHtml(m.name)}</div>
                    <div class="move-browser-card-stats">BP ${m.basePower || '-'} &nbsp;·&nbsp; Acc ${acc} &nbsp;·&nbsp; PP ${m.pp || '-'}${m.priority ? ` &nbsp;·&nbsp; Prio ${m.priority > 0 ? '+' : ''}${m.priority}` : ''}</div>
                </div>`;
            }).join('');
        }

        function addMoveFromBrowser(key) {
            const move = getAllBrowsableMoves().find(m => m.key === key);
            if (!move) return;
            const method = document.getElementById('move-method')?.value || 'none';
            const level = method === 'level' ? document.getElementById('move-level')?.value : null;
            if (move.custom) {
                const exists = state.learnset.some(x => x.name === move.name && isCustomMove(x));
                if (!exists) state.learnset.push({ ...move, source: 'custom', custom: true, learnMethod: method, level: method === 'level' ? (level || null) : null, flags: move.flags || {} });
                sortLearnset();
                renderLearnset();
                updatePreview();
                api.autoSave();
            } else {
                addLearnsetMove(move, method, level);
            }
            filterMoveBrowser();
        }

        window.openMoveBrowserModal = openMoveBrowserModal;
        window.filterMoveBrowser = filterMoveBrowser;
        window.addMoveFromBrowser = addMoveFromBrowser;
        window.toggleMoveBrowserFlag = toggleMoveBrowserFlag;
        window.clearMoveBrowserFilters = clearMoveBrowserFilters;

// ==================== MOVE LOOKUP ====================
        function findClosestMove(query) {
            if (!query.trim()) return null;
            const q = query.toLowerCase().trim();

            // Exact match (case-insensitive)
            let match = Object.entries(state.sdMoves).find(([k, v]) => v.name.toLowerCase() === q);
            if (match) return match[1];

            // Key exact match
            match = Object.entries(state.sdMoves).find(([k, v]) => k.toLowerCase() === q);
            if (match) return match[1];

            // Starts with
            let startsWith = Object.entries(state.sdMoves).filter(([k, v]) => v.name.toLowerCase().startsWith(q));
            if (startsWith.length === 1) return startsWith[0][1];
            if (startsWith.length > 1) {
                startsWith.sort((a, b) => a[1].name.length - b[1].name.length);
                return startsWith[0][1];
            }

            // Includes
            let includes = Object.entries(state.sdMoves).filter(([k, v]) => v.name.toLowerCase().includes(q));
            if (includes.length === 1) return includes[0][1];
            if (includes.length > 1) {
                includes.sort((a, b) => a[1].name.length - b[1].name.length);
                return includes[0][1];
            }

            // Word-boundary match
            let wordMatches = Object.entries(state.sdMoves).filter(([k, v]) => {
                const name = v.name.toLowerCase();
                const words = name.split(/[\s\-]+/);
                return words.some(w => w.startsWith(q) || w === q);
            });
            if (wordMatches.length > 0) {
                wordMatches.sort((a, b) => a[1].name.length - b[1].name.length);
                return wordMatches[0][1];
            }

            return null;
        }

// ==================== MOVE IMPORT / EXPORT ====================
        function normalizeMoveLookupName(name) {
            return String(name || '')
                .toLowerCase()
                .replace(/[’']/g, '')
                .replace(/[^a-z0-9]+/g, '');
        }

        function levenshteinDistance(a, b) {
            a = String(a || '');
            b = String(b || '');
            if (a === b) return 0;
            if (!a.length) return b.length;
            if (!b.length) return a.length;
            if (a.length > b.length) [a, b] = [b, a];

            let previous = Array.from({ length: a.length + 1 }, (_, i) => i);
            for (let j = 1; j <= b.length; j++) {
                const current = [j];
                for (let i = 1; i <= a.length; i++) {
                    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                    current[i] = Math.min(
                        current[i - 1] + 1,
                        previous[i] + 1,
                        previous[i - 1] + cost
                    );
                }
                previous = current;
            }
            return previous[a.length];
        }

        function findClosestMoveForImport(query) {
            const raw = String(query || '').trim();
            if (!raw) return { move: null, corrected: false, distance: Infinity };
            const normalized = normalizeMoveLookupName(raw);
            if (!normalized) return { move: null, corrected: false, distance: Infinity };

            // Exact normalized match first: handles capitalization, spaces, hyphens,
            // apostrophes, and other harmless formatting differences.
            const exact = Object.values(state.sdMoves).find(move =>
                normalizeMoveLookupName(move.name) === normalized
            );
            if (exact) return { move: exact, corrected: false, distance: 0 };

            let best = null;
            for (const move of Object.values(state.sdMoves)) {
                const candidate = normalizeMoveLookupName(move.name);
                const distance = levenshteinDistance(normalized, candidate);
                const maxLen = Math.max(normalized.length, candidate.length);
                const ratio = maxLen ? distance / maxLen : 1;
                if (!best || distance < best.distance ||
                    (distance === best.distance && ratio < best.ratio)) {
                    best = { move, distance, ratio };
                }
            }

            if (!best) return { move: null, corrected: false, distance: Infinity };

            // Conservative typo correction. Short names get a tighter threshold;
            // longer names can tolerate a few transpositions/typos.
            const threshold = normalized.length <= 4 ? 1 : normalized.length <= 7 ? 2 : 3;
            const ratioThreshold = normalized.length <= 5 ? 0.34 : 0.38;
            if (best.distance <= threshold && best.ratio <= ratioThreshold) {
                return { move: best.move, corrected: true, distance: best.distance };
            }
            return { move: null, corrected: false, distance: best.distance };
        }

        function parseMoveImportText(text) {
            // Accept one-per-line lists, comma-separated lists, semicolons, bullets,
            // tabs, and common list prefixes without requiring a particular format.
            return String(text || '')
                .replace(/\r/g, '')
                .split(/[\n,;|•·]+/)
                .map(part => part
                    .replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '')
                    .trim()
                )
                .filter(Boolean);
        }

        function getExportableVanillaMoves() {
            return state.learnset
                .filter(move => move && move.name && !isCustomMove(move))
                .map(move => move.name)
                .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        }

        function formatCustomMoveForImportExport(move) {
            const accText = (move.accuracy === true || move.accuracy === undefined || move.accuracy === false) ? '-' : `${move.accuracy}%`;
            const flags = getFlagLabels(move.flags || {}, move.category);
            const flagText = flags.length ? flags.join(' | ') : 'None';
            const description = (move.desc || move.description || '').trim();
            return [
                `${move.name} *`,
                `${move.category || 'Status'} | ${move.type || 'Normal'}`,
                `${move.basePower || 0} BP | ${accText} ACC | ${move.pp || 10} PP`,
                flagText,
                description
            ].join('\n');
        }

        function sortLearnsetEntries(entries, sortMode = 'name', order = 'asc') {
            const sorted = (Array.isArray(entries) ? entries : []).filter(move => move && move.name).slice();
            const sortFn = (a, b) => {
                if (sortMode === 'type') return (a.type || '').localeCompare(b.type || '', undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
                if (sortMode === 'power') return (Number(a.basePower) || 0) - (Number(b.basePower) || 0) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
                if (sortMode === 'category') {
                    const catOrder = { Physical: 0, Special: 1, Status: 2 };
                    return (catOrder[a.category] ?? 3) - (catOrder[b.category] ?? 3) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
                }
                if (sortMode === 'default') {
                    const customA = isCustomMove(a), customB = isCustomMove(b);
                    if (customA !== customB) return customA ? -1 : 1;
                    if (customA && customB) return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
                    const methodOrder = { level: 0, egg: 1, tm: 2, none: 3 };
                    const ma = a.learnMethod || 'none', mb = b.learnMethod || 'none';
                    const md = (methodOrder[ma] ?? 3) - (methodOrder[mb] ?? 3);
                    if (md !== 0) return md;
                    if (ma === 'level' && a.level && b.level) return a.level - b.level;
                    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
                }
                return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
            };
            sorted.sort(sortFn);
            if (order === 'desc') sorted.reverse();
            return sorted;
        }

        function getMoveSortOptions() {
            return {
                sort: document.getElementById('move-import-export-sort')?.value || 'name',
                order: document.getElementById('move-import-export-order')?.value || 'asc'
            };
        }

        function getExportableMovesText(sort, order) {
            const selected = sort && order ? { sort, order } : getMoveSortOptions();
            const entries = sortLearnsetEntries(state.learnset, selected.sort, selected.order);
            const names = entries.map(move => `${move.name}${isCustomMove(move) ? '*' : ''}`);
            const customBlocks = entries.filter(isCustomMove).map(formatCustomMoveForImportExport);
            return names.join('\n') + (customBlocks.length ? `\n\n${customBlocks.join('\n\n')}` : '');
        }

        function openMoveImportExportModal() {
            const textarea = document.getElementById('move-import-export-text');
            if (!textarea) return;
            const { sort, order } = getMoveSortOptions();
            textarea.value = getExportableMovesText(sort, order);
            document.getElementById('move-import-export-modal').classList.add('active');
            setTimeout(() => textarea.focus(), 0);
        }

        function exportMovesToText() {
            const textarea = document.getElementById('move-import-export-text');
            if (!textarea) return;
            const { sort, order } = getMoveSortOptions();
            textarea.value = getExportableMovesText(sort, order);
            textarea.focus();
            textarea.select();
            const count = state.learnset.filter(m => m && m.name).length;
            api.showToast(`Exported ${count} move${count === 1 ? '' : 's'} to the text box.`, 'success');
        }

        function parseCustomMoveImportBlock(lines, startIndex) {
            const header = String(lines[startIndex] || '').trim();
            if (!header.endsWith('*')) return null;
            const name = header.slice(0, -1).trim();
            if (!name) return { nextIndex: startIndex + 1, move: null };

            const details = [];
            let i = startIndex + 1;
            while (i < lines.length && details.length < 4) {
                const line = String(lines[i] || '').trim();
                if (!line) { i++; continue; }
                if (line.endsWith('*') && details.length < 3) break;
                details.push(line);
                i++;
            }

            const categoryType = (details[0] || '').split('|').map(v => v.trim());
            const stats = (details[1] || '').split('|').map(v => v.trim());
            const parseStat = (value, fallback) => {
                const n = parseInt(String(value || '').replace(/[^0-9-]/g, ''), 10);
                return Number.isFinite(n) ? n : fallback;
            };
            const accRaw = String(stats[1] || '').trim();
            const acc = accRaw === '-' || /^true$/i.test(accRaw) ? true : parseStat(accRaw.replace(/%/g, ''), 100);
            const pp = parseStat(stats[2], 10);
            const flagsLine = details[2] || 'None';
            const desc = details.length >= 4 ? details[3] : '';
            const flags = {};
            if (flagsLine && flagsLine.toLowerCase() !== 'none') {
                flagsLine.split('|').map(v => v.trim()).filter(Boolean).forEach(flag => {
                    const key = flag.toLowerCase().replace(/[^a-z0-9]/g, '');
                    const known = {
                        'contact': 'contact', 'protect': 'protect', 'reflectable': 'reflectable',
                        'snatch': 'snatch', 'sound': 'sound', 'punch': 'punch', 'bite': 'bite',
                        'pulse': 'pulse', 'recharge': 'recharge', 'charge': 'charge', 'heal': 'heal',
                        'authentic': 'authentic', 'powder': 'powder', 'bullet': 'bullet', 'slicing': 'slicing',
                        'wind': 'wind', 'dance': 'dance', 'mental': 'mental', 'defrost': 'defrost',
                        'thaws': 'thawing', 'thawsuser': 'thawing', 'thawing': 'thawing',
                        'multihit': 'multihit', 'pivot': 'pivot'
                    };
                    if (known[key]) flags[known[key]] = 1;
                });
            }

            return {
                nextIndex: i,
                move: {
                    name,
                    type: categoryType[1] || 'Normal',
                    category: categoryType[0] || 'Status',
                    basePower: parseStat(stats[0], 0),
                    accuracy: acc,
                    pp,
                    priority: 0,
                    flags,
                    desc,
                    source: 'custom',
                    custom: true,
                    learnMethod: 'none',
                    level: null
                }
            };
        }

        function importMovesFromText() {
            log.info('MOVE IMPORT', 'Starting move text import');
            if (!state.sdLoaded) {
                api.showToast('Showdown move data is still loading. Try again shortly.', 'error');
                return;
            }

            const textarea = document.getElementById('move-import-export-text');
            const text = textarea ? String(textarea.value || '') : '';
            const lines = text.replace(/\r/g, '').split('\n');
            const separator = lines.findIndex((line, index) => !line.trim() && lines.slice(index + 1).some(l => l.trim()));
            const nameLines = separator >= 0 ? lines.slice(0, separator) : lines;
            const detailLines = separator >= 0 ? lines.slice(separator + 1) : [];
            const importedByKey = new Map();
            const order = [];
            const customKeys = new Set();
            let corrected = 0;
            let invalid = 0;

            // Read only the first section as the ordered move-name list.
            nameLines.forEach(line => {
                parseMoveImportText(line).forEach(entry => {
                    const isCustom = entry.endsWith('*');
                    const cleanName = (isCustom ? entry.slice(0, -1) : entry).trim();
                    if (!cleanName) return;
                    const key = normalizeMoveLookupName(cleanName);
                    if (importedByKey.has(key) || customKeys.has(key)) return;
                    order.push(key);
                    if (isCustom) {
                        customKeys.add(key);
                        return;
                    }
                    const result = findClosestMoveForImport(cleanName);
                    if (!result.move) { invalid++; return; }
                    const canonicalKey = normalizeMoveLookupName(result.move.name);
                    if (importedByKey.has(canonicalKey)) return;
                    if (result.corrected) corrected++;
                    importedByKey.set(canonicalKey, hydrateLearnsetEntry({ name: result.move.name, learnMethod: 'none', level: null }));
                });
            });

            // Read custom definitions after the blank separator.
            for (let i = 0; i < detailLines.length;) {
                const line = detailLines[i].trim();
                if (!line) { i++; continue; }
                if (!line.endsWith('*')) { invalid++; i++; continue; }
                const parsed = parseCustomMoveImportBlock(detailLines, i);
                if (!parsed || !parsed.move) { invalid++; i++; continue; }
                const key = normalizeMoveLookupName(parsed.move.name);
                if (!customKeys.has(key)) { invalid++; i = parsed.nextIndex; continue; }
                if (!importedByKey.has(key)) importedByKey.set(key, parsed.move);
                customKeys.delete(key);
                i = parsed.nextIndex;
            }

            invalid += customKeys.size;
            const imported = order.map(key => importedByKey.get(key)).filter(Boolean);
            log.debug('MOVE IMPORT', 'Parsed move import', { imported: imported.length, invalid, corrected });

            if (!imported.length) {
                api.showToast('No valid moves were found in the import text.', 'error');
                return;
            }

            const { sort, order: importOrder } = getMoveSortOptions();
            state.learnset = sortLearnsetEntries(imported, sort, importOrder);
            log.info('MOVE IMPORT', 'Applied imported moves to learnset', { count: state.learnset.length });
            renderLearnset();
            renderRecommendMovesModal();
            updatePreview();
            api.autoSave();
            if (textarea) textarea.value = getExportableMovesText(sort, importOrder);

            const customCount = imported.filter(isCustomMove).length;
            const standardCount = imported.length - customCount;
            const parts = [`Imported ${imported.length} move${imported.length === 1 ? '' : 's'}`];
            if (standardCount) parts.push(`${standardCount} standard`);
            if (customCount) parts.push(`${customCount} custom`);
            if (corrected) parts.push(`corrected ${corrected}`);
            if (invalid) parts.push(`${invalid} invalid`);
            api.showToast(parts.join(' · ') + '.', invalid ? 'warning' : 'success');
        }

function handleMoveKey(e) {
            if (e.key === 'Enter') {
                const val = e.target.value.trim();
                const method = document.getElementById('move-method').value;
                const level = method === 'level' ? document.getElementById('move-level').value : null;
                if (val) {
                    const closest = findClosestMove(val);
                    if (closest) {
                        addLearnsetMove(closest, method, level);
                    } else {
                        api.showToast('Move not found: "' + val + '"', 'error');
                    }
                }
                e.target.value = '';
                document.getElementById('move-dropdown').classList.remove('active');
            }
        }
        function addMoveFromInput() {
            const input = document.getElementById('move-input');
            const methodSelect = document.getElementById('move-method');
            const levelInput = document.getElementById('move-level');
            const name = input.value.trim();
            const method = methodSelect.value;
            const level = method === 'level' ? levelInput.value : null;
            if (name) {
                const closest = findClosestMove(name);
                if (closest) {
                    addLearnsetMove(closest, method, level);
                    input.value = '';
                    methodSelect.value = 'none';
                    levelInput.value = '';
                    levelInput.style.display = 'none';
                } else {
                    api.showToast('Move not found: "' + name + '"', 'error');
                }
            }
        }

        
// ==================== ABILITIES ====================
        let editingCustomAbilityIndex = null;
        function resetEditingCustomAbilityIndex() { editingCustomAbilityIndex = null; }
        let abilityOutsideClickBound = false;
        function addAbility(name, source, description) {
            name = (name || '').trim();
            if (!name) return;
            if (state.abilities.length >= 4) {
                api.showToast('A Pokemon can have a maximum of 4 abilities.', 'error');
                return;
            }
            if (state.abilities.some(a => (a.name || '').toLowerCase() === name.toLowerCase())) return;

            const isCustom = source === 'custom';
            const sdEntry = Object.entries(state.sdAbilities).find(([k, v]) => v.name === name);
            state.abilities.push({
                name,
                source: isCustom ? 'custom' : 'sd',
                desc: isCustom ? (description || '') : ((sdEntry && sdEntry[1].desc) || '')
            });
            renderAbilities();
            updatePreview();
            api.autoSave();
        }

        function addCustomAbility() {
            if (state.abilities.length >= 4) {
                api.showToast('A Pokemon can have a maximum of 4 abilities.', 'error');
                return;
            }
            // Finish any currently edited custom ability first.
            editingCustomAbilityIndex = null;
            state.abilities.push({ name: '', source: 'custom', desc: '' });
            editingCustomAbilityIndex = state.abilities.length - 1;
            renderAbilities();
            updatePreview();
            api.autoSave();
            const input = document.querySelector('#abilities-list .ability-name-input:last-of-type');
            if (input) input.focus();
        }

        function updateAbility(index, field, value) {
            if (!state.abilities[index]) return;
            state.abilities[index][field] = value;
            updatePreview();
            api.autoSave();
        }

        function toggleCustomAbilityEdit(index) {
            const ability = state.abilities[index];
            if (!ability || (ability.source !== 'custom' && !ability.custom)) return;
            if (editingCustomAbilityIndex === index) return;
            editingCustomAbilityIndex = index;
            renderAbilities();
            const input = document.querySelector(`#abilities-list .ability-row[data-ability-index="${index}"] .ability-name-input`);
            if (input) input.focus();
        }

        function finishCustomAbilityEdit(index) {
            if (editingCustomAbilityIndex !== index) return;
            editingCustomAbilityIndex = null;
            renderAbilities();
            updatePreview();
            api.autoSave();
        }

        function finishAllCustomAbilityEdits() {
            if (editingCustomAbilityIndex === null) return;
            editingCustomAbilityIndex = null;
            renderAbilities();
            updatePreview();
            api.autoSave();
        }

        function removeAbility(index) {
            state.abilities.splice(index, 1);
            if (editingCustomAbilityIndex === index) editingCustomAbilityIndex = null;
            else if (editingCustomAbilityIndex !== null && editingCustomAbilityIndex > index) editingCustomAbilityIndex--;
            renderAbilities();
            updatePreview();
            api.autoSave();
        }

        function moveAbility(index, newIndex) {
            if (newIndex < 0 || newIndex >= state.abilities.length || index === newIndex) return;
            const [ability] = state.abilities.splice(index, 1);
            state.abilities.splice(newIndex, 0, ability);
            if (editingCustomAbilityIndex === index) editingCustomAbilityIndex = newIndex;
            else if (editingCustomAbilityIndex !== null) {
                if (index < editingCustomAbilityIndex && newIndex >= editingCustomAbilityIndex) editingCustomAbilityIndex--;
                else if (index > editingCustomAbilityIndex && newIndex <= editingCustomAbilityIndex) editingCustomAbilityIndex++;
            }
            renderAbilities();
            updatePreview();
            api.autoSave();
        }

        function getAbilityRole(index) {
            const count = state.abilities.length;
            if (count >= 2 && count <= 3 && index === count - 1) return 'Hidden';
            if (count === 4 && index === 2) return 'Hidden';
            if (count === 4 && index === 3) return 'Event';
            return '';
        }

        function renderAbilities() {
            const container = document.getElementById('abilities-list');
            if (!container) return;

            container.innerHTML = state.abilities.map((a, i) => {
                const isCustom = a.source === 'custom' || a.custom === true;
                const role = getAbilityRole(i);
                const roleHtml = role ? `<span class="ability-label ${role.toLowerCase()}">${role}</span>` : '';
                const sdEntry = Object.entries(state.sdAbilities).find(([k, v]) => v.name === a.name);
                const desc = isCustom ? (a.desc || a.description || '') : ((sdEntry && sdEntry[1].desc) || a.desc || '');
                const isEditing = isCustom && editingCustomAbilityIndex === i;

                if (isCustom && isEditing) {
                    return `
                        <div class="ability-row ability-custom ability-editing" data-ability-index="${i}">
                            <span class="ability-drag-handle" title="Drag to reorder" aria-label="Drag to reorder">⋮⋮</span>
                            <div class="ability-body">
                                <div class="ability-name-wrap">
                                    <input class="ability-name-input" type="text" value="${escapeHtmlAttr(a.name || '')}" placeholder="Ability name" oninput="updateAbility(${i}, 'name', this.value)">
                                    ${roleHtml}
                                </div>
                                <input class="ability-desc-input" type="text" value="${escapeHtmlAttr(desc)}" placeholder="Short description" oninput="updateAbility(${i}, 'desc', this.value)">
                            </div>
                            <button class="ability-remove" type="button" onclick="event.stopPropagation(); removeAbility(${i})" title="Remove">&times;</button>
                        </div>`;
                }

                const libEntry = isCustom && a.customId ? (state.customAbilities || []).find(x => x.id === a.customId) : null;
                const isCoded = !!(libEntry && libEntry.blocks && libEntry.blocks.trigger);
                const codeBtn = isCustom && a.customId
                    ? `<button class="ability-code-open" type="button" title="${isCoded ? 'Edit battle code' : 'Add battle code'}" onclick="event.stopPropagation(); openAbilityBlockEditor('${escapeJsString(a.customId)}')"><i data-lucide="puzzle"></i></button>`
                    : '';

                return `
                    <div class="ability-row${isCustom ? ' ability-custom' : ''}" draggable="true" data-ability-index="${i}">
                        <span class="ability-drag-handle" title="Drag to reorder" aria-label="Drag to reorder">⋮⋮</span>
                        <div class="ability-body">
                            <div class="ability-name-wrap">
                                <span class="ability-name-text"${isCustom ? ` onclick="event.stopPropagation(); toggleCustomAbilityEdit(${i})" title="Click to edit"` : ''}>${escapeHtml(a.name || 'Unnamed Ability')}</span>
                                ${roleHtml}
                                ${isCoded ? '<span class="ability-code-badge" title="Has battle code from the block editor"><i data-lucide="puzzle"></i> Coded</span>' : ''}
                            </div>
                            <div class="ability-desc-text"${isCustom ? ` onclick="event.stopPropagation(); toggleCustomAbilityEdit(${i})" title="Click to edit"` : ''}>${escapeHtml(desc || 'No description available.')}</div>
                        </div>
                        ${codeBtn}
                        <button class="ability-remove" type="button" onclick="event.stopPropagation(); removeAbility(${i})" title="Remove">&times;</button>
                    </div>`;
            }).join('');

            setupAbilityDragAndDrop(container);
            if (!abilityOutsideClickBound) {
                document.addEventListener('mousedown', handleAbilityOutsideClick);
                abilityOutsideClickBound = true;
            }
        }

        function handleAbilityOutsideClick(e) {
            if (editingCustomAbilityIndex === null) return;
            const editingRow = document.querySelector(`#abilities-list .ability-row[data-ability-index="${editingCustomAbilityIndex}"]`);
            if (!editingRow || !editingRow.contains(e.target)) {
                finishAllCustomAbilityEdits();
            }
        }

        function setupAbilityDragAndDrop(container) {
            let dragIndex = null;
            container.querySelectorAll('.ability-row').forEach(row => {
                row.addEventListener('dragstart', e => {
                    if (e.target.closest('input, button')) {
                        e.preventDefault();
                        return;
                    }
                    dragIndex = Number(row.dataset.abilityIndex);
                    row.classList.add('ability-dragging');
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(dragIndex));
                });
                row.addEventListener('dragover', e => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    row.classList.add('ability-drag-over');
                });
                row.addEventListener('dragleave', () => row.classList.remove('ability-drag-over'));
                row.addEventListener('drop', e => {
                    e.preventDefault();
                    row.classList.remove('ability-drag-over');
                    const from = dragIndex !== null ? dragIndex : Number(e.dataTransfer.getData('text/plain'));
                    const to = Number(row.dataset.abilityIndex);
                    dragIndex = null;
                    moveAbility(from, to);
                });
                row.addEventListener('dragend', () => {
                    dragIndex = null;
                    container.querySelectorAll('.ability-row').forEach(r => r.classList.remove('ability-dragging', 'ability-drag-over'));
                });
            });
        }

        function escapeHtml(value) {
            return String(value == null ? '' : value)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }
        function escapeHtmlAttr(value) { return escapeHtml(value); }
        function escapeJsString(value) {
            return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        }

        function showAbilityDetail(name) {
            const entry = Object.entries(state.sdAbilities).find(([k,v]) => v.name === name);
            const ability = state.abilities.find(a => a.name === name);
            const desc = (ability && (ability.desc || ability.description)) || (entry && entry[1].desc) || 'No description available.';
            showDetailPopup(name, desc);
        }

        // Legacy compatibility for older inline calls / imported data.
        function updateCustomAbility(index, field, value) { updateAbility(index, field === 'description' ? 'desc' : field, value); }
        function removeCustomAbility(index) { removeAbility(index); }
        function renderCustomAbilities() { renderAbilities(); }
// ==================== LEARNSET ====================
        // Learnset entries are saved with just {name, learnMethod, level} - everything else
        // (type, category, power, accuracy, flags, desc) is vanilla move data we re-derive
        // from the Showdown dataset here, so we never have to persist duplicate move info.
        function getSdMoveByName(name) {
            if (!name) return null;
            return Object.values(state.sdMoves).find(v => v.name === name) || null;
        }

        // Showdown has no dedicated pivot flag, so detect standard switch-out moves
        // by name/description. Custom moves can opt into the explicit `pivot` flag.
        const PIVOT_MOVE_NAMES = new Set([
            'U-turn', 'Volt Switch', 'Flip Turn', 'Parting Shot',
            'Chilly Reception', 'Teleport', 'Shed Tail'
        ]);
        function isPivotMove(move) {
            if (!move) return false;
            if (move.flags?.pivot) return true;
            if (PIVOT_MOVE_NAMES.has(move.name)) return true;
            const text = `${move.name || ''} ${move.desc || ''}`.toLowerCase();
            return /(?:the user|user)\s+(?:switches|switches out)|switch(?:es)? out the user/.test(text);
        }

        function getMoveEditorFlags(move) {
            const flags = isCustomMove(move)
                ? { ...(move.flags || {}) }
                : convertShowdownFlagsToEditorFlags({
                    ...(move?.flags || {}),
                    multihit: move?.multihit
                }, move?.category);
            if (isPivotMove(move)) flags.pivot = true;
            return flags;
        }

        // Showdown's move flags describe what a move IS affected by: `protect`,
        // `reflectable`, and `snatch` mean the move is protectable/reflectable/snatchable.
        // Our Fakemon editor uses the opposite convention for these three flags: the
        // checkbox/tag means the move BYPASSES that mechanic. Convert only vanilla
        // Showdown data here; custom moves already use our editor's bypass convention.
        function convertShowdownFlagsToEditorFlags(flags, category) {
            const source = flags || {};
            const isStatus = category === 'Status';
            return {
                ...source,
                protect: !source.protect,
                reflectable: isStatus ? !source.reflectable : false,
                snatch: isStatus ? !source.snatch : false,
                bypasssub: !!source.authentic,
                thawing: !!source.defrost,
                multihit: !!source.multihit
            };
        }

        function hydrateLearnsetEntry(entry) {
            const isCustom = isCustomMove(entry);
            if (isCustom) {
                // Custom moves own their complete move data. Never rehydrate them
                // from Showdown, even if a custom move happens to share a vanilla name.
                return {
                    ...entry,
                    source: 'custom',
                    custom: true,
                    learnMethod: entry.learnMethod || 'none',
                    level: entry.learnMethod === 'level' ? (entry.level || null) : null,
                    flags: entry.flags || {}
                };
            }
            const md = getSdMoveByName(entry.name);
            return {
                name: entry.name,
                category: (md && md.category) || entry.category || 'Status',
                type: (md && md.type) || entry.type || 'Normal',
                basePower: md ? (md.basePower ?? 0) : (entry.basePower ?? 0),
                accuracy: md ? md.accuracy : entry.accuracy,
                pp: md ? (md.pp ?? 0) : (entry.pp ?? 0),
                priority: md ? (md.priority ?? 0) : (entry.priority ?? 0),
                desc: (md && md.desc) || entry.desc || '',
                flags: md ? getMoveEditorFlags({
                    name: md.name || entry.name,
                    desc: md.desc || entry.desc || '',
                    category: md.category || entry.category,
                    multihit: md.multihit,
                    flags: md.flags || {}
                }) : getMoveEditorFlags({ ...entry, flags: entry.flags || {} }),
                learnMethod: entry.learnMethod || 'none',
                level: entry.level || null
            };
        }

        // Saved Fakemon only persist the move name/method/level. If the editor was
        // opened before Showdown finished loading, hydrate those entries again once
        // the vanilla dataset becomes available.
        function rehydrateCurrentLearnsetFromShowdown() {
            if (!Array.isArray(state.learnset) || !state.learnset.length) return;
            state.learnset = state.learnset.map(hydrateLearnsetEntry);
            sortLearnset();
            renderLearnset();
            updatePreview();
        }
        function addLearnsetMove(moveData, learnMethod, level) {
            const move = hydrateLearnsetEntry({
                name: moveData.name,
                learnMethod: learnMethod || 'none',
                level: level ? parseInt(level) : null
            });
            if (!state.learnset.find(m => m.name === move.name)) {
                state.learnset.push(move);
                sortLearnset();
                renderLearnset();
                updatePreview();
                api.autoSave();
            }
        }
        function removeLearnsetMove(index) {
            state.learnset.splice(index, 1);
            renderLearnset();
            updatePreview();
            api.autoSave();
        }
        function updateMoveMethod(index, method) {
            state.learnset[index].learnMethod = method;
            if (method !== 'level') {
                state.learnset[index].level = null;
            }
            sortLearnset();
            renderLearnset();
            updatePreview();
            api.autoSave();
        }
        function updateMoveLevel(index, level) {
            state.learnset[index].level = level ? parseInt(level) : null;
            sortLearnset();
            renderLearnset();
            updatePreview();
            api.autoSave();
        }
        function isCustomMove(move) {
            return !!(move && (move.source === 'custom' || move.custom === true));
        }

        function sortLearnset() {
            const methodOrder = { 'level': 0, 'egg': 1, 'tm': 2, 'none': 3 };
            state.learnset.sort((a, b) => {
                const customA = isCustomMove(a);
                const customB = isCustomMove(b);
                // On Default sorting, custom moves always come first and are alphabetical.
                if (customA !== customB) return customA ? -1 : 1;
                if (customA && customB) return (a.name || '').localeCompare(b.name || '');

                const methodA = a.learnMethod || 'none';
                const methodB = b.learnMethod || 'none';
                const methodDiff = (methodOrder[methodA] ?? 3) - (methodOrder[methodB] ?? 3);
                if (methodDiff !== 0) return methodDiff;
                if (methodA === 'level' && a.level && b.level) {
                    return a.level - b.level;
                }
                return (a.name || '').localeCompare(b.name || '');
            });
        }
        function renderLearnset() {
            log.debug('LEARNSET', 'Rendering learnset', { count: state.learnset.length });
            const container = document.getElementById('learnset-list');
            const searchEl = document.getElementById('learnset-search');
            const sortEl = document.getElementById('learnset-sort');
            const orderEl = document.getElementById('learnset-order');
            const typeFilterEl = document.getElementById('learnset-filter-type');
            const catFilterEl = document.getElementById('learnset-filter-category');

            const query = searchEl ? searchEl.value.trim().toLowerCase() : '';
            const sortMode = sortEl ? sortEl.value : 'default';
            const order = orderEl ? orderEl.value : 'desc';
            const typeFilter = typeFilterEl ? typeFilterEl.value : '';
            const catFilter = catFilterEl ? catFilterEl.value : '';

            // Pair each move with its real index in the `state.learnset` array so remove/update
            // handlers still target the correct entry even after filtering/sorting for display.
            let entries = state.learnset.map((m, i) => ({ m, i }));

            // Text search (name, type, category)
            if (query) {
                entries = entries.filter(({ m }) =>
                    m.name.toLowerCase().includes(query) ||
                    (m.type || '').toLowerCase().includes(query) ||
                    (m.category || '').toLowerCase().includes(query) ||
                    (m.learnMethod || '').toLowerCase().includes(query)
                );
            }

            // Type filter dropdown
            if (typeFilter) {
                entries = entries.filter(({ m }) => (m.type || '') === typeFilter);
            }

            // Category filter dropdown
            if (catFilter) {
                entries = entries.filter(({ m }) => (m.category || '') === catFilter);
            }

            // Sorting
            const sortFn = (a, b) => {
                if (sortMode === 'name') {
                    return a.m.name.localeCompare(b.m.name);
                } else if (sortMode === 'type') {
                    return (a.m.type || '').localeCompare(b.m.type || '') || a.m.name.localeCompare(b.m.name);
                } else if (sortMode === 'power') {
                    return (a.m.basePower || 0) - (b.m.basePower || 0) || a.m.name.localeCompare(b.m.name);
                } else if (sortMode === 'category') {
                    const catOrder = { Physical: 0, Special: 1, Status: 2 };
                    return (catOrder[a.m.category] ?? 3) - (catOrder[b.m.category] ?? 3) || a.m.name.localeCompare(b.m.name);
                }
                // default: custom moves first (alphabetically), then normal learn-method order.
                const customA = isCustomMove(a.m);
                const customB = isCustomMove(b.m);
                if (customA !== customB) return customA ? -1 : 1;
                if (customA && customB) return (a.m.name || '').localeCompare(b.m.name || '');
                const methodOrder = { 'level': 0, 'egg': 1, 'tm': 2, 'none': 3 };
                const ma = a.m.learnMethod || 'none';
                const mb = b.m.learnMethod || 'none';
                const md = (methodOrder[ma] ?? 3) - (methodOrder[mb] ?? 3);
                if (md !== 0) return md;
                if (ma === 'level' && a.m.level && b.m.level) return (a.m.level || 0) - (b.m.level || 0);
                return (a.m.name || '').localeCompare(b.m.name || '');
            };

            entries.sort(sortFn);
            if (order === 'desc' && sortMode !== 'default') {
                entries.reverse();
            }

            if (!entries.length) {
                container.innerHTML = state.learnset.length
                    ? '<p style="font-size:13px;color:var(--text-muted);padding:8px 0;">No moves match your filters.</p>'
                    : '';
                return;
            }

            container.innerHTML = entries.map(({ m, i }) => {
                const custom = isCustomMove(m);
                const catClass = m.category === 'Physical' ? 'cat-physical' : m.category === 'Special' ? 'cat-special' : 'cat-status';
                const typeClass = `type-${(m.type || 'normal').toLowerCase()}`;
                const accText = m.accuracy === true || m.accuracy === undefined ? '-' : (m.accuracy === false ? '-' : `${m.accuracy}%`);
                const levelDisplay = m.learnMethod === 'level' ? 'inline-block' : 'none';
                // Multi-hit/Pivot are metadata shown in move info, not on the learnset nodes.
                const moveTagHtml = '';
                const clickAction = custom ? `openCustomMoveModal(${i})` : `showMoveDetail('${String(m.name || '').replace(/'/g, "\\'")}')`;

                return `
                    <div class="learnset-item${custom ? ' custom-move-editor-item' : ''}" onclick="${clickAction}">
                        <div class="learnset-main">
                            <span class="move-name">${m.name}</span>
                            <div class="move-meta">
                                <span class="type-pill ${typeClass}">${m.type || 'Normal'}</span>
                                <span class="cat-pill ${catClass}">${getCategoryIcon(m.category || 'Status', 14)}</span>
                                <span class="power-text">${m.basePower || '-'} BP / ${accText}</span>
                                ${moveTagHtml}
                            </div>
                            <div class="move-method-row">
                                <select class="method-select-inline" onchange="updateMoveMethod(${i}, this.value); event.stopPropagation();" onclick="event.stopPropagation();">
                                    <option value="none" ${m.learnMethod === 'none' || !m.learnMethod ? 'selected' : ''}>-</option>
                                    <option value="level" ${m.learnMethod === 'level' ? 'selected' : ''}>Level</option>
                                    <option value="tm" ${m.learnMethod === 'tm' ? 'selected' : ''}>TM</option>
                                    <option value="egg" ${m.learnMethod === 'egg' ? 'selected' : ''}>Egg</option>
                                </select>
                                <input type="number" class="level-input-inline" placeholder="Lv" min="1" max="100" value="${m.level || ''}" style="display:${levelDisplay};" onchange="updateMoveLevel(${i}, this.value); event.stopPropagation();" onclick="event.stopPropagation();">
                            </div>
                        </div>
                        <button class="remove-btn" onclick="event.stopPropagation(); removeLearnsetMove(${i})">&times;</button>
                    </div>
                `;
            }).join('');

            renderLearnsetChart();
        }

        
// ==================== LEARNSET BREAKDOWN CHART ====================
        // Donut chart of the *entire* state.learnset (independent of the search/filter controls
        // above), switchable between Type / Category / Learn Method.
        const TYPE_COLORS = {
            Normal: '#A8A878', Fire: '#F08030', Water: '#6890F0', Electric: '#F8D030',
            Grass: '#78C850', Ice: '#98D8D8', Fighting: '#C03028', Poison: '#A040A0',
            Ground: '#E0C068', Flying: '#A890F0', Psychic: '#F85888', Bug: '#A8B820',
            Rock: '#B8A038', Ghost: '#705898', Dragon: '#7038F8', Dark: '#705848',
            Steel: '#B8B8D0', Fairy: '#EE99AC'
        };
        const CATEGORY_COLORS = { Physical: '#cc8844', Special: '#4466cc', Status: '#44aa44' };
        const METHOD_META = {
            level: { label: 'Level-Up', color: '#4a90d9' },
            egg: { label: 'Egg Move', color: '#e08ac0' },
            tm: { label: 'TM/Tutor', color: '#9b6fd1' },
            none: { label: 'Unassigned', color: '#999999' }
        };

        function buildDonutSVG(segments, total) {
            const size = 140, radius = 54, stroke = 22, circumference = 2 * Math.PI * radius;
            let offset = 0;
            const circles = segments.map(seg => {
                const dash = (seg.value / total) * circumference;
                const circle = `<circle r="${radius}" cx="${size / 2}" cy="${size / 2}" fill="transparent" stroke="${seg.color}" stroke-width="${stroke}" stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${size / 2} ${size / 2})"></circle>`;
                offset += dash;
                return circle;
            }).join('');
            return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
                ${circles}
                <text x="${size / 2}" y="${size / 2 - 3}" text-anchor="middle" font-size="24" font-weight="800" fill="var(--text-primary)" font-family="'Exo 2',sans-serif">${total}</text>
                <text x="${size / 2}" y="${size / 2 + 15}" text-anchor="middle" font-size="10" fill="var(--text-muted)" font-family="'Exo 2',sans-serif">move${total === 1 ? '' : 's'}</text>
            </svg>`;
        }

        function renderLearnsetChart() {
            const wrap = document.getElementById('learnset-chart-wrap');
            const groupEl = document.getElementById('learnset-chart-group');
            if (!wrap || !groupEl) return;
            const groupBy = groupEl.value;
            const total = state.learnset.length;

            if (!total) {
                wrap.innerHTML = '<p style="font-size:13px;color:var(--text-muted);text-align:center;width:100%;">Add moves to see a breakdown.</p>';
                return;
            }

            const groups = {};
            state.learnset.forEach(m => {
                let key, color;
                if (groupBy === 'type') { key = m.type || 'Normal'; color = TYPE_COLORS[key] || '#999'; }
                else if (groupBy === 'category') { key = m.category || 'Status'; color = CATEGORY_COLORS[key] || '#999'; }
                else { const meta = METHOD_META[m.learnMethod] || METHOD_META.none; key = meta.label; color = meta.color; }
                if (!groups[key]) groups[key] = { value: 0, color };
                groups[key].value++;
            });
            const segments = Object.entries(groups).map(([label, g]) => ({ label, value: g.value, color: g.color })).sort((a, b) => b.value - a.value);

            const svg = buildDonutSVG(segments, total);
            const legend = segments.map(s => `
                <div style="display:flex;align-items:center;gap:6px;font-size:12px;line-height:1;white-space:nowrap;">
                    <span style="width:10px;height:10px;border-radius:2px;background:${s.color};display:inline-block;flex-shrink:0;"></span>
                    <span style="color:var(--text-primary);">${s.label}</span>
                    <span style="font-family:'JetBrains Mono',monospace;color:var(--text-muted);font-size:11px;">${s.value} · ${Math.round(s.value / total * 100)}%</span>
                </div>
            `).join('');
            wrap.innerHTML = `<div style="display:flex;gap:16px;align-items:center;justify-content:center;flex-wrap:wrap;">${svg}<div style="display:flex;flex-direction:column;gap:4px;">${legend}</div></div>`;
        }

        function clearLearnsetFilters() {
            const searchEl = document.getElementById('learnset-search');
            const typeEl = document.getElementById('learnset-filter-type');
            const catEl = document.getElementById('learnset-filter-category');
            const sortEl = document.getElementById('learnset-sort');
            const orderEl = document.getElementById('learnset-order');
            if (searchEl) searchEl.value = '';
            if (typeEl) typeEl.value = '';
            if (catEl) catEl.value = '';
            if (sortEl) sortEl.value = 'default';
            if (orderEl) orderEl.value = 'desc';
            setTypeDropdownValue('learnset-filter-type', '', 'All Types');
            setCatDropdownValue('learnset-filter-category', '', 'All Categories');
            renderLearnset();
            api.showToast('Filters cleared', 'info');
        }

        
// ==================== UNIVERSAL MOVES ====================
        const UNIVERSAL_MOVES = ['Toxic', 'Hidden Power', 'Tera Blast', 'Protect', 'Frustration', 'Return', 'Double Team', 'Facade', 'Rest', 'Attract', 'Round', 'Swagger', 'Sleep Talk', 'Substitute'];

        function addUniversalMoves() {
            if (!state.sdLoaded) { api.showToast('Showdown data still loading, try again shortly.', 'error'); return; }
            let added = 0;
            UNIVERSAL_MOVES.forEach(name => {
                const move = findClosestMove(name);
                if (move && !state.learnset.find(m => m.name === move.name)) {
                    addLearnsetMove(move, 'tm', null);
                    added++;
                }
            });
            if (added > 0) api.autoSave();
            api.showToast(added > 0 ? `Added ${added} universal move${added === 1 ? '' : 's'}!` : 'Universal moves already in learnset.', added > 0 ? 'success' : 'info');
        }

        
// ==================== MOVE RECOMMENDATIONS ====================
        function getFakemonStats() {
            return {
                hp: parseInt(document.getElementById('stat-hp').value) || 0,
                atk: parseInt(document.getElementById('stat-atk').value) || 0,
                def: parseInt(document.getElementById('stat-def').value) || 0,
                spa: parseInt(document.getElementById('stat-spa').value) || 0,
                spd: parseInt(document.getElementById('stat-spd').value) || 0,
                spe: parseInt(document.getElementById('stat-spe').value) || 0
            };
        }

        // Reads this Fakemon's full profile (typing, stats, height/weight, color, egg
        // groups, gender ratio) - everything we use to find real Pokemon it resembles.
        function getFakemonProfile() {
            const type1 = document.getElementById('fakemon-type1').value;
            const type2 = document.getElementById('fakemon-type2').value;
            const heightVal = parseFloat(document.getElementById('fakemon-height')?.value || '');
            const heightUnit = document.getElementById('height-unit')?.value || 'm';
            const weightVal = parseFloat(document.getElementById('fakemon-weight')?.value || '');
            const weightUnit = document.getElementById('weight-unit')?.value || 'kg';
            // Convert to metric for internal comparison
            const heightm = !isNaN(heightVal) ? (heightUnit === 'ft' ? heightVal / 3.28084 : heightVal) : null;
            const weightkg = !isNaN(weightVal) ? (weightUnit === 'lb' ? weightVal / 2.20462 : weightVal) : null;
            const color = document.getElementById('fakemon-color')?.value || '';
            const egg1 = document.getElementById('fakemon-egg1')?.value || '';
            const egg2 = document.getElementById('fakemon-egg2')?.value || '';
            const genderless = document.getElementById('gender-genderless')?.checked;
            const maleInput = document.getElementById('gender-male-input');
            return {
                types: [type1, type2].filter(Boolean),
                stats: getFakemonStats(),
                heightm: heightm,
                weightkg: weightkg,
                color,
                eggGroups: [egg1, egg2].filter(Boolean),
                genderPct: genderless ? -1 : (maleInput ? parseFloat(maleInput.value) : 50)
            };
        }

        function normalizePokemonLookupId(value) {
            return String(value || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]/g, '');
        }

        function getPokemonLearnsetData(pokemonId) {
            const raw = String(pokemonId || '');
            const candidates = [
                raw,
                raw.toLowerCase(),
                raw.replace(/-/g, ''),
                raw.toLowerCase().replace(/-/g, ''),
                raw.replace(/-(alola|galar|hisui|paldea)$/i, ''),
                raw.toLowerCase().replace(/-(alola|galar|hisui|paldea)$/i, '').replace(/-/g, '')
            ];
            for (const candidate of candidates) {
                if (state.sdLearnsets[candidate]) return state.sdLearnsets[candidate];
            }
            const normalized = normalizePokemonLookupId(raw);
            const key = Object.keys(state.sdLearnsets).find(k => normalizePokemonLookupId(k) === normalized);
            return key ? state.sdLearnsets[key] : null;
        }

        // ---- Similarity engine ----
        // Scores every real Pokemon against this Fakemon's profile (typing, stats,
        // height/weight, color, egg groups, gender ratio) and returns the closest
        // matches. Nothing needs to match exactly - it's a weighted "family resemblance"
        // score, same spirit as bitcrush.org's movelist generator.
        function findSimilarPokemon(profile, limit) {
            const scored = [];
            for (const dex of Object.values(state.sdPokedex)) {
                if (!getPokemonLearnsetData(dex.id)) continue;
                let score = 0;

                // Typing - the single biggest driver of what a mon's movepool looks like
                const sharedTypes = dex.types.filter(t => profile.types.includes(t)).length;
                score += sharedTypes * 30;
                if (sharedTypes === dex.types.length && sharedTypes === profile.types.length) score += 12;

                // Stat spread - normalized Euclidean distance across all 6 stats, so mons
                // with a similar role (e.g. bulky physical wall, frail special sweeper) rank close
                const statKeys = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
                let statDistSq = 0;
                statKeys.forEach(k => { const d = (dex.stats[k] || 0) - (profile.stats[k] || 0); statDistSq += d * d; });
                const statDist = Math.sqrt(statDistSq);
                score += Math.max(0, 34 - statDist / 6);

                // Height/weight - compared on a log scale since these span a huge range
                if (profile.heightm && dex.heightm) {
                    const hDiff = Math.abs(Math.log(dex.heightm) - Math.log(profile.heightm));
                    score += Math.max(0, 8 - hDiff * 5);
                }
                if (profile.weightkg && dex.weightkg) {
                    const wDiff = Math.abs(Math.log(dex.weightkg) - Math.log(profile.weightkg));
                    score += Math.max(0, 8 - wDiff * 2.5);
                }

                // Pokedex color
                if (profile.color && dex.color && profile.color.toLowerCase() === dex.color.toLowerCase()) score += 10;

                // Egg group overlap
                if (profile.eggGroups.length && dex.eggGroups.length) {
                    const sharedEgg = dex.eggGroups.filter(g => profile.eggGroups.includes(g)).length;
                    score += sharedEgg * 6;
                }

                // Gender ratio closeness (both genderless, or similar M% split)
                if (profile.genderPct === -1 && dex.genderPct === -1) score += 6;
                else if (profile.genderPct !== -1 && dex.genderPct !== -1) {
                    score += Math.max(0, 6 - Math.abs(profile.genderPct - dex.genderPct) / 20);
                }

                if (score > 0) scored.push({ dex, score });
            }
            scored.sort((a, b) => b.score - a.score);
            return scored.slice(0, limit || 25);
        }

        // Parses a Showdown state.learnset source array (e.g. ["9L16","8L16"]) into this
        // move's primary learn method + level for that species.
        function classifyLearnsetSource(sources) {
            for (const s of sources) {
                const m = s.match(/^\d+L(\d+)$/);
                if (m) return { method: 'level', level: parseInt(m[1]) };
            }
            for (const s of sources) {
                if (/^\d+E$/.test(s)) return { method: 'egg', level: null };
            }
            for (const s of sources) {
                if (/^\d+[MT]$/.test(s)) return { method: 'tm', level: null };
            }
            return null;
        }

        // A move is treated as "signature" (too exclusive to hand out to a Fakemon)
        // if only a couple of real species can ever learn it - e.g. Fleur Cannon,
        // Gigaton Hammer, Make It Rain. Computed once across the full Showdown
        // learnsets dataset and cached, since it doesn't depend on which Fakemon
        // we're generating for.
        const SIGNATURE_MOVE_MAX_LEARNERS = 2;
        function getSignatureMoveIds() {
            if (state.signatureMoveIds) return state.signatureMoveIds;
            const counts = {};
            for (const learnset of Object.values(state.sdLearnsets)) {
                for (const moveId of Object.keys(learnset)) {
                    counts[moveId] = (counts[moveId] || 0) + 1;
                }
            }
            const sig = new Set();
            for (const [moveId, count] of Object.entries(counts)) {
                if (count <= SIGNATURE_MOVE_MAX_LEARNERS) sig.add(moveId);
            }
            state.signatureMoveIds = sig;
            return sig;
        }

        // Aggregates the learnsets of the most similar real Pokemon into weighted
        // level-up / egg / TM move pools - this is what makes generated levels realistic
        // (a move only lands at Lv.1 here if similar mons actually learn it that early).
        function buildSimilarMovePools(profile) {
            const similar = findSimilarPokemon(profile, 25);
            const signatureMoveIds = getSignatureMoveIds();
            const agg = {};

            const addMoveSource = (moveId, sources, weight, supporterName) => {
                if (signatureMoveIds.has(moveId)) return;
                const classified = classifyLearnsetSource(sources);
                if (!classified) return;
                const mv = state.sdMoves[moveId];
                if (!mv) return;
                if (!agg[mv.name]) {
                    agg[mv.name] = {
                        move: mv, weight: 0, levelWeightedSum: 0, levelWeight: 0,
                        level: 0, egg: 0, tm: 0, supporters: []
                    };
                }
                const a = agg[mv.name];
                a.weight += weight;
                a[classified.method] += weight;
                if (classified.method === 'level') {
                    a.levelWeightedSum += classified.level * weight;
                    a.levelWeight += weight;
                }
                if (a.supporters.length < 4 && supporterName && !a.supporters.includes(supporterName)) {
                    a.supporters.push(supporterName);
                }
            };

            similar.forEach(({ dex, score }, rank) => {
                const learnsetData = getPokemonLearnsetData(dex.id);
                if (!learnsetData) return;
                const weight = score / (1 + rank * 0.12);
                for (const [moveId, sources] of Object.entries(learnsetData)) {
                    addMoveSource(moveId, sources, weight, dex.name);
                }
            });

            // Optional second source pool: saved Woogidex Fakemons. Their learned
            // moves are weighted by profile similarity, so an unrelated Fakemon does
            // not overwhelm the recommendations.
            const includeOwn = typeof api.getIncludeOwnFakemonsInRecommendedMoves === 'function'
                ? api.getIncludeOwnFakemonsInRecommendedMoves()
                : false;

            const typeSet = new Set((profile.types || []).map(t => String(t).toLowerCase()));
            const statNames = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

            if (includeOwn) {
                (state.fakemonDB || []).forEach(fakemon => {
                    // Never use the Fakemon currently being edited as a recommendation
                    // source. The setting is meant to include OTHER saved Fakemon.
                    if (state.editingId && String(fakemon?.id) === String(state.editingId)) return;
                    if (!fakemon || !fakemon.name || !fakemon.stats) return;

                    const ownTypes = [fakemon.type1, fakemon.type2].filter(Boolean).map(t => String(t).toLowerCase());
                    const sharedTypes = ownTypes.filter(t => typeSet.has(t)).length;
                    let statDistance = 0;
                    let statCount = 0;
                    statNames.forEach(stat => {
                        const a = Number(profile.stats?.[stat]);
                        const b = Number(fakemon.stats?.[stat]);
                        if (Number.isFinite(a) && Number.isFinite(b)) {
                            statDistance += Math.abs(a - b) / 254;
                            statCount++;
                        }
                    });
                    const statSimilarity = statCount ? Math.max(0, 1 - (statDistance / statCount)) : 0.5;
                    const typeSimilarity = ownTypes.length && typeSet.size
                        ? (sharedTypes / Math.max(ownTypes.length, typeSet.size))
                        : 0.25;

                    // Keep own-Fakemon contributions meaningful but secondary to
                    // the National Dex similarity pool.
                    const ownWeight = Math.max(0.35, (typeSimilarity * 0.65) + (statSimilarity * 0.35));

                    const ownLearnset = Array.isArray(fakemon.learnset) ? fakemon.learnset : [];
                    ownLearnset.forEach(entry => {
                        if (!entry || !entry.name) return;
                        const move = findClosestMove(entry.name);
                        if (!move) return;
                        const method = entry.learnMethod || 'tm';
                        const source = {
                            method: method === 'level' ? 'level' : method === 'egg' ? 'egg' : 'tm',
                            level: method === 'level' ? (Number(entry.level) || 1) : null
                        };
                        addMoveSource(move.id || move.name.toLowerCase().replace(/[^a-z0-9]/g, ''), source, ownWeight, fakemon.name);
                    });
                });
            }

            const entries = Object.values(agg).sort((a, b) => b.weight - a.weight);
            return {
                similar: similar.map(s => s.dex.name),
                levelPool: entries.filter(e => e.level >= e.egg && e.level >= e.tm)
                    .map(e => ({ move: e.move, avgLevel: Math.max(1, Math.round(e.levelWeightedSum / e.levelWeight)), weight: e.weight, supporters: e.supporters })),
                eggPool: entries.filter(e => e.egg > e.level && e.egg >= e.tm)
                    .map(e => ({ move: e.move, weight: e.weight, supporters: e.supporters })),
                tmPool: entries.filter(e => e.tm > e.level && e.tm > e.egg)
                    .map(e => ({ move: e.move, weight: e.weight, supporters: e.supporters }))
            };
        }

        // Name-based role classifiers - used only to sort already similarity-selected
        // moves into familiar categories (STAB/Flavour/Setup/Recovery/Utility/Coverage);
        // move *selection* and *levels* still come entirely from the similarity engine above.
        const SETUP_MOVE_NAMES = new Set(['Swords Dance', 'Nasty Plot', 'Calm Mind', 'Bulk Up', 'Dragon Dance', 'Coil', 'Quiver Dance', 'Tail Glow', 'Shell Smash', 'Growth', 'Work Up', 'Hone Claws', 'Iron Defense', 'Amnesia', 'Cotton Guard', 'Acid Armor', 'Cosmic Power', 'Stockpile', 'Rock Polish', 'Autotomize', 'Agility']);
        const SPEED_MOVE_NAMES = new Set(['Agility', 'Rock Polish', 'Autotomize', 'Dragon Dance']);
        const RECOVERY_MOVE_NAMES = new Set(['Recover', 'Roost', 'Rest', 'Slack Off', 'Synthesis', 'Moonlight', 'Morning Sun', 'Milk Drink', 'Soft-Boiled', 'Shore Up', 'Wish', 'Strength Sap']);
        const UTILITY_MOVE_NAMES = new Set(['Toxic', 'Will-O-Wisp', 'Thunder Wave', 'Stealth Rock', 'Spikes', 'Toxic Spikes', 'Sticky Web', 'Taunt', 'Knock Off', 'Trick', 'Switcheroo', 'Encore', 'Disable', 'Haze', 'Defog', 'Rapid Spin', 'Substitute', 'Protect', 'Detect', 'Light Screen', 'Reflect', 'Aurora Veil', 'Leech Seed', 'Confuse Ray', 'Yawn', 'Glare']);
        // Attacking moves that are technically damaging but too weak, too situational, or
        // secondary-effect-focused to count as a real STAB/Coverage pick - these get bucketed
        // as Flavour instead. Rather than raw BP alone (which Showdown doesn't rate for
        // "usefulness"), we combine a minimum power floor with named exclusions for moves
        // whose type is conditional/variable (Tera Blast, Hidden Power, etc.) or whose real
        // purpose is a secondary effect rather than damage (Thief, Round, Snore...).
        const MIN_STAB_COVERAGE_BP = 65;
        const CONDITIONAL_TYPE_MOVE_NAMES = new Set(['Tera Blast', 'Hidden Power', 'Judgment', 'Weather Ball', 'Natural Gift', 'Techno Blast', 'Multi-Attack', 'Revelation Dance', 'Terrain Pulse', 'Raging Bull', 'Ivy Cudgel']);
        const FILLER_ATTACK_MOVE_NAMES = new Set([
            'Round', 'Snore', 'Thief', 'Covet', 'Tackle', 'Pound', 'Scratch', 'Constrict', 'Present',
            'Bide', 'Rage', 'Fury Attack', 'Fury Swipes', 'Take Down', 'Submission', 'Headbutt',
            'Mega Drain', 'Absorb', 'Vine Whip', 'Razor Leaf', 'Ember', 'Water Gun', 'Bubble',
            'Powder Snow', 'Gust', 'Peck', 'Astonish', 'Lick', 'Nuzzle', 'Pounce',
            'Fling', 'Natural Gift', 'Echoed Voice', 'Struggle Bug', 'Infestation'
        ]);
        // Showdown lists basePower as 0 for moves whose damage is computed dynamically
        // in battle (weight/HP-based, weather, etc). Without this, genuinely strong
        // moves like Facade, Return, or Gyro Ball would always look like 0-power
        // filler and get bucketed as Flavour instead of STAB/Coverage.
        const VARIABLE_BP_ESTIMATE = {
            'Low Kick': 80, 'Grass Knot': 80, 'Heavy Slam': 80, 'Heat Crash': 80,
            'Gyro Ball': 80, 'Electro Ball': 60, 'Flail': 100, 'Reversal': 100,
            'Wring Out': 90, 'Crush Grip': 90, 'Punishment': 60, 'Payback': 50,
            'Facade': 70, 'Hex': 65, 'Acrobatics': 75, 'Stored Power': 70, 'Power Trip': 70,
            'Return': 100, 'Frustration': 60, 'Foul Play': 95, 'Eruption': 100,
            'Water Spout': 100, 'Last Respects': 100, 'Rage Fist': 90
        };
        function effectiveMoveBasePower(move) {
            const raw = Number(move.basePower || 0);
            return raw > 0 ? raw : (VARIABLE_BP_ESTIMATE[move.name] || 0);
        }
        // A move only counts as real "coverage" if it's actually super-effective
        // against something the Fakemon's own STAB doesn't already hit hard - e.g.
        // for a pure Normal-type Fakemon (whose STAB never resists/hits 2x anything),
        // any strong off-type attack with a genuine 2x matchup qualifies, but a
        // neutral-everywhere off-type move does not; it's just Flavour.
        function moveHasMeaningfulCoverage(moveType, ownTypes) {
            for (const defender of POKEMON_TYPES) {
                const stabBest = Math.max(...ownTypes.map(t => TYPE_EFFECTIVENESS[t]?.[defender] ?? 1), 0);
                const coverageMult = TYPE_EFFECTIVENESS[moveType]?.[defender] ?? 1;
                if (stabBest < 2 && coverageMult >= 2) return true;
            }
            return false;
        }

        function classifyMoveRole(move, types) {
            if (SPEED_MOVE_NAMES.has(move.name) && move.name !== 'Dragon Dance') return 'speed';
            if (SETUP_MOVE_NAMES.has(move.name)) return 'setup';
            if (RECOVERY_MOVE_NAMES.has(move.name)) return 'recovery';
            if (UTILITY_MOVE_NAMES.has(move.name)) return 'utility';
            const bp = effectiveMoveBasePower(move);
            if (move.category !== 'Status' && bp > 0) {
                const isLowValue = bp < MIN_STAB_COVERAGE_BP
                    || CONDITIONAL_TYPE_MOVE_NAMES.has(move.name)
                    || FILLER_ATTACK_MOVE_NAMES.has(move.name);
                if (isLowValue) return 'flavour';
                if (types.includes(move.type)) return 'stab';
                return moveHasMeaningfulCoverage(move.type, types) ? 'coverage' : 'flavour';
            }
            return 'flavour';
        }

        // Recommendations shown are remembered here (name -> {learnMethod, level}) so that
        // clicking one adds it with the same method/level it was suggested with, instead of
        // always defaulting to TM.
        let lastRecommendations = {};

        function generateMoveRecommendations() {
            const profile = getFakemonProfile();
            const learnedNames = new Set(state.learnset.map(m => m.name));
            const sections = [];
            if (!profile.types.length) return { sections, needsType: true };

            const pools = buildSimilarMovePools(profile);
            const candidates = [
                ...pools.levelPool.map(e => ({ move: e.move, weight: e.weight, supporters: e.supporters, learnMethod: 'level', level: e.avgLevel })),
                ...pools.eggPool.map(e => ({ move: e.move, weight: e.weight, supporters: e.supporters, learnMethod: 'egg', level: null })),
                ...pools.tmPool.map(e => ({ move: e.move, weight: e.weight, supporters: e.supporters, learnMethod: 'tm', level: null }))
            ].filter(e => !learnedNames.has(e.move.name));

            const buckets = { stab: [], flavour: [], setup: [], speed: [], recovery: [], utility: [], coverage: [] };
            candidates.forEach(e => buckets[classifyMoveRole(e.move, profile.types)].push(e));

            // Collapse "slight variations" of the same job (e.g. five different mid-power
            // Normal physical moves for a Normal-type Fakemon) down to the strongest
            // representative per type+category, so the list doesn't fill up with
            // near-identical redundant picks.
            const dedupeByTypeCategory = arr => {
                const best = new Map();
                arr.forEach(e => {
                    const key = `${e.move.type}|${e.move.category}`;
                    const bp = effectiveMoveBasePower(e.move);
                    const current = best.get(key);
                    if (!current || bp > current.bp + 5 || (bp >= current.bp - 5 && e.weight > current.entry.weight)) {
                        best.set(key, { entry: e, bp });
                    }
                });
                return Array.from(best.values()).map(v => v.entry);
            };
            buckets.stab = dedupeByTypeCategory(buckets.stab);
            buckets.coverage = dedupeByTypeCategory(buckets.coverage);

            Object.values(buckets).forEach(arr => arr.sort((a, b) => b.weight - a.weight));

            const reasonFor = e => e.learnMethod === 'level'
                ? `~Lv.${e.level} on similar Pokémon (e.g. ${e.supporters.slice(0, 2).join(', ')})`
                : e.learnMethod === 'egg'
                    ? `Egg move on similar Pokémon (e.g. ${e.supporters.slice(0, 2).join(', ')})`
                    : `TM/tutor move on similar Pokémon (e.g. ${e.supporters.slice(0, 2).join(', ')})`;

            const pushSection = (label, arr, limit) => {
                if (!arr.length) return;
                sections.push({ label, moves: arr.slice(0, limit).map(e => ({ move: e.move, reason: reasonFor(e), learnMethod: e.learnMethod, level: e.level })) });
            };

            pushSection('STAB Moves', buckets.stab, 4);
            pushSection('Flavour Moves', buckets.flavour, 4);
            pushSection('Setup', buckets.setup, 3);
            if (profile.stats.spe < 80) pushSection('Speed Control', buckets.speed, 1);
            const bulk = (profile.stats.def + profile.stats.spd) / 2;
            if (profile.stats.hp >= 80 || bulk >= 80) pushSection('Recovery', buckets.recovery, 2);
            pushSection('Utility', buckets.utility, 3);
            pushSection('Coverage', buckets.coverage, 4);

            return { sections, similar: pools.similar };
        }

        function openRecommendMovesModal() {
            if (!state.sdLoaded) { api.showToast('Showdown data still loading, try again shortly.', 'error'); return; }
            renderRecommendMovesModal();
            document.getElementById('recommend-moves-modal').classList.add('active');
        }
        function renderRecommendMovesModal() {
            const container = document.getElementById('recommend-moves-list');
            const { sections, needsType } = generateMoveRecommendations();
            lastRecommendations = {};
            if (needsType) {
                container.innerHTML = '<p style="font-size:13px;color:var(--text-muted);">Set a primary type first so we can suggest moves.</p>';
                return;
            }
            if (!sections.length) {
                container.innerHTML = '<p style="font-size:13px;color:var(--text-muted);">No new suggestions - looks like your learnset already covers the basics!</p>';
                return;
            }
            sections.forEach(sec => sec.moves.forEach(({ move, learnMethod, level }) => {
                lastRecommendations[move.name] = { learnMethod, level };
            }));
            container.innerHTML = sections.map(sec => `
                <div class="recommend-section-label">${sec.label}</div>
                ${sec.moves.map(({move, reason}) => {
                    const typeClass = `type-${(move.type || 'normal').toLowerCase()}`;
                    const catClass = move.category === 'Physical' ? 'cat-physical' : move.category === 'Special' ? 'cat-special' : 'cat-status';
                    return `
                        <div class="recommend-move-item" onclick="selectRecommendedMove('${move.name.replace(/'/g, "\\'")}')">
                            <div>
                                <div class="move-name">${move.name}</div>
                                <div class="move-why">${reason}</div>
                            </div>
                            <div class="meta-right">
                                <span class="type-pill ${typeClass}">${move.type}</span>
                                <span class="cat-pill ${catClass}">${getCategoryIcon(move.category, 14)}</span>
                                <span class="power-text">${move.basePower || '-'}</span>
                            </div>
                        </div>
                    `;
                }).join('')}
            `).join('');
        }
        function selectRecommendedMove(name) {
            const move = findClosestMove(name);
            if (!move) return;
            const meta = lastRecommendations[name] || { learnMethod: 'tm', level: null };
            addLearnsetMove(move, meta.learnMethod, meta.level);
            autoSave();
            const methodLabel = meta.learnMethod === 'level' ? `Lv.${meta.level}` : meta.learnMethod.toUpperCase();
            api.showToast(`Added ${move.name} (${methodLabel})!`, 'success');
            renderRecommendMovesModal();
        }

        
// ==================== FULL LEARNSET GENERATOR ====================
        // Produces a plausible in-game-style state.learnset (level-up curve + egg moves + TMs)
        // by finding real Pokemon similar to this Fakemon (typing, stats, height, weight,
        // color, egg groups, gender ratio) and aggregating their actual Showdown learnsets,
        // weighted by similarity - so both which moves show up and what level they land at
        // reflect real patterns instead of a fixed curve. Moves already in the state.learnset are
        // "woven" in - reused in place (method/level updated) - rather than duplicated;
        // moves not touched by the generator are left alone.
        function generateLearnset() {
            if (!state.sdLoaded) { api.showToast('Showdown data still loading, try again shortly.', 'error'); return; }
            const profile = getFakemonProfile();
            if (!profile.types.length) { api.showToast('Set a primary type first so we can generate a state.learnset.', 'error'); return; }

            const pools = buildSimilarMovePools(profile);
            if (!pools.levelPool.length && !pools.eggPool.length && !pools.tmPool.length) {
                api.showToast('Not enough similar Pokémon data to generate a state.learnset yet.', 'error');
                return;
            }

            const placements = []; // {move, learnMethod, level}
            const usedNames = new Set();

            // Level-up moves: picking a flat "top 18 by weight" biases hard toward
            // widely-shared low-level moves (nearly every Pokémon learns something
            // around Lv.1-20), which starves out rarer high-level signature moves and
            // left learnsets topping out around Lv.50. Instead, bucket the pool across
            // the whole 1-100 curve and take the strongest-weighted picks from each
            // bucket, so the generated learnset actually spans up to Lv.100 whenever
            // the similar-Pokémon data supports it.
            const LEVEL_BUCKET_COUNT = 5;
            const PICKS_PER_BUCKET = 4;
            const bucketSize = 100 / LEVEL_BUCKET_COUNT;
            const levelBuckets = Array.from({ length: LEVEL_BUCKET_COUNT }, () => []);
            pools.levelPool.forEach(e => {
                const idx = Math.min(LEVEL_BUCKET_COUNT - 1, Math.floor((e.avgLevel - 1) / bucketSize));
                levelBuckets[idx].push(e);
            });
            const levelPicks = [];
            levelBuckets.forEach((bucket, idx) => {
                const sortedBucket = [...bucket].sort((a, b) => b.weight - a.weight);
                const picks = sortedBucket.slice(0, PICKS_PER_BUCKET);
                if (idx === 0) {
                    // The earliest bucket (Lv.1-20) is where basic "starter" attacks like
                    // Tackle/Pound/Scratch live - they're weak so stronger same-level moves
                    // usually out-weigh them for the general slots above. Explicitly hold a
                    // couple of spots for them so early learnsets don't skip straight to
                    // strategic picks and look unrealistically strong right out the gate.
                    const pickedNames = new Set(picks.map(e => e.move.name));
                    const fillerPicks = sortedBucket
                        .filter(e => !pickedNames.has(e.move.name) && classifyMoveRole(e.move, profile.types) === 'flavour')
                        .slice(0, 2);
                    picks.push(...fillerPicks);
                }
                picks.forEach(e => levelPicks.push(e));
            });
            const seenLevels = new Set();
            levelPicks.sort((a, b) => a.avgLevel - b.avgLevel).forEach(e => {
                if (usedNames.has(e.move.name)) return;
                let lvl = Math.min(100, Math.max(1, e.avgLevel));
                while (seenLevels.has(lvl) && lvl < 100) lvl++; // nudge apart same-level collisions
                seenLevels.add(lvl);
                usedNames.add(e.move.name);
                placements.push({ move: e.move, learnMethod: 'level', level: lvl });
            });

            // Egg moves
            [...pools.eggPool].sort((a, b) => b.weight - a.weight).slice(0, 4).forEach(e => {
                if (usedNames.has(e.move.name)) return;
                usedNames.add(e.move.name);
                placements.push({ move: e.move, learnMethod: 'egg', level: null });
            });

            // TM moves
            [...pools.tmPool].sort((a, b) => b.weight - a.weight).slice(0, 6).forEach(e => {
                if (usedNames.has(e.move.name)) return;
                usedNames.add(e.move.name);
                placements.push({ move: e.move, learnMethod: 'tm', level: null });
            });

            // Weave into the existing state.learnset: reuse-in-place if already present,
            // otherwise add as a new entry.
            let woven = 0, added = 0;
            const addedMoves = [];
            const wovenMoves = [];
            placements.forEach(({ move, learnMethod, level }) => {
                const existing = state.learnset.find(m => m.name === move.name);
                if (existing) {
                    const changed = existing.learnMethod !== learnMethod || existing.level !== level;
                    existing.learnMethod = learnMethod;
                    existing.level = level;
                    woven++;
                    if (changed) wovenMoves.push({ move, learnMethod, level });
                } else {
                    state.learnset.push(hydrateLearnsetEntry({ name: move.name, learnMethod, level }));
                    added++;
                    addedMoves.push({ move, learnMethod, level });
                }
            });

            sortLearnset();
            renderLearnset();
            renderRecommendMovesModal();
            updatePreview();
            autoSave();
            const sampleSimilar = pools.similar.slice(0, 3).join(', ');
            api.showToast(`Generated from Pokémon like ${sampleSimilar}: ${added} added, ${woven} woven in.`, 'success');
            closeModal('recommend-moves-modal');
            showGeneratedLearnsetSummary(addedMoves, wovenMoves, sampleSimilar);
        }

        function formatLearnMethodLabel(learnMethod, level) {
            if (learnMethod === 'level') return `Lv.${level ?? '?'}`;
            if (learnMethod === 'tm') return 'TM';
            if (learnMethod === 'egg') return 'Egg';
            return learnMethod || '-';
        }

        function showGeneratedLearnsetSummary(addedMoves, wovenMoves, sampleSimilar) {
            if (!addedMoves.length && !wovenMoves.length) return;
            const renderMoveCard = ({ move, learnMethod, level }) => {
                const typeClass = `type-${(move.type || 'normal').toLowerCase()}`;
                const catClass = move.category === 'Physical' ? 'cat-physical' : move.category === 'Special' ? 'cat-special' : 'cat-status';
                return `<div class="gl-item" onclick="showMoveDetail('${move.name.replace(/'/g, "\\'")}')">
                    <span class="type-pill ${typeClass}">${move.type}</span>
                    <span class="move-name">${escapeHtml(move.name)}</span>
                    <div class="move-meta">
                        <span class="cat-pill ${catClass}">${getCategoryIcon(move.category, 12)}</span>
                        <span class="method-text">${formatLearnMethodLabel(learnMethod, level)}</span>
                    </div>
                </div>`;
            };
            const sortByLevelThenName = (a, b) => {
                if (a.learnMethod === 'level' && b.learnMethod === 'level') return (a.level || 0) - (b.level || 0);
                return a.move.name.localeCompare(b.move.name);
            };
            const subtitle = document.getElementById('generated-learnset-subtitle');
            if (subtitle) subtitle.textContent = `Based on Pokémon like ${sampleSimilar}.`;
            let content = '';
            if (addedMoves.length) {
                content += `<div class="gl-section-label">Added (${addedMoves.length})</div>` +
                    `<div class="gl-grid">${[...addedMoves].sort(sortByLevelThenName).map(renderMoveCard).join('')}</div>`;
            }
            if (wovenMoves.length) {
                content += `<div class="gl-section-label">Updated Existing Moves (${wovenMoves.length})</div>` +
                    `<div class="gl-grid">${[...wovenMoves].sort(sortByLevelThenName).map(renderMoveCard).join('')}</div>`;
            }
            const body = document.getElementById('generated-learnset-body');
            if (body) body.innerHTML = content;
            document.getElementById('generated-learnset-modal')?.classList.add('active');
        }

        function clearMoveset() {
            if (!state.learnset.length) { api.showToast('Learnset is already empty.', 'info'); return; }
            if (!confirm(`Clear all ${state.learnset.length} move${state.learnset.length === 1 ? '' : 's'} from the state.learnset? This cannot be undone.`)) return;
            state.learnset = [];
            renderLearnset();
            updatePreview();
            autoSave();
            api.showToast('Moveset cleared.', 'success');
        }

        function showMoveDetail(name) {
            log.debug('MOVE INFO', 'Opening move detail', { name });
            const move = state.learnset.find(m => m.name === name);
            if (!move) return;
            const sdEntry = Object.entries(state.sdMoves).find(([k,v]) => v.name === name);
            const desc = sdEntry ? sdEntry[1].desc : (move.desc || 'No description available.');
            const acc = move.accuracy === true ? '-' : (move.accuracy === false ? '-' : `${move.accuracy}%`);

            // Build flag tidbits using the editor's normalized convention.
            // Vanilla Showdown flags are inverted here, and Status-only tags are
            // suppressed for damaging moves.
            const flags = getMoveEditorFlags({
                ...move,
                // Showdown stores multi-hit as the top-level `multihit` property,
                // not inside `flags`. Pass it through explicitly so Move Info can
                // render the same Multi-hit badge as the learnset data.
                multihit: isCustomMove(move)
                    ? move.multihit
                    : (sdEntry ? sdEntry[1].multihit : move.multihit),
                flags: isCustomMove(move)
                    ? (move.flags || {})
                    : (sdEntry ? (sdEntry[1].flags || {}) : (move.flags || {}))
            });
            const flagLabels = getFlagLabels(flags, move.category);
            log.debug('MOVE INFO', 'Resolved move flags', { name: move.name, multihit: !!flags.multihit, pivot: !!flags.pivot, labels: flagLabels });
            let flagsHtml = '';
            if (flagLabels.length) {
                flagsHtml = '<div style="display:flex;flex-wrap:wrap;gap:6px;margin:12px 0;padding:12px 0;border-top:1px solid var(--border-light);border-bottom:1px solid var(--border-light);">' +
                    flagLabels.map(f => `<span class="flag-tidbit">${f}</span>`).join('') +
                    '</div>';
            }

            const typeClass = `type-${(move.type || 'normal').toLowerCase()}`;
            const priority = move.priority || 0;
            const priorityDisplay = priority > 0 ? `+${priority}` : `${priority}`;
            const content = `
                <div class="detail-row"><span class="detail-label">Type</span><span class="detail-value"><span class="type-pill ${typeClass}">${move.type}</span></span></div>
                <div class="detail-row"><span class="detail-label">Category</span><span class="detail-value">${getCategoryIcon(move.category, 16)} ${move.category}</span></div>
                <div class="detail-row"><span class="detail-label">Base Power</span><span class="detail-value">${move.basePower || '-'}</span></div>
                <div class="detail-row"><span class="detail-label">Accuracy</span><span class="detail-value">${acc}</span></div>
                <div class="detail-row"><span class="detail-label">PP</span><span class="detail-value">${move.pp || '-'}</span></div>
                <div class="detail-row"><span class="detail-label">Priority</span><span class="detail-value">${priorityDisplay}</span></div>
                ${flagsHtml}
                <div class="desc-text">${desc}</div>
            `;
            showDetailPopup(move.name, content);
        }

        
// ==================== CUSTOM ENTITIES ====================
        // Custom abilities are now part of the unified state.abilities list.
        // Legacy custom-ability functions are kept as aliases in the Abilities section above.

        
// ==================== CUSTOM ABILITY LIBRARY ====================
        let customEntityChooserKind = null;

        function renderCustomEntityChooser(kind) {
            customEntityChooserKind = kind;
            const body = document.getElementById('custom-entity-chooser-body');
            if (!body) return;

            const isAbility = kind === 'ability';
            const list = isAbility ? (state.customAbilities || []) : (state.customMoves || []);
            const queryEl = document.getElementById('custom-entity-search');
            const sortEl = document.getElementById('custom-entity-sort');
            const query = (queryEl?.value || '').trim().toLowerCase();
            const sort = sortEl?.value || 'name-asc';

            let filtered = list.filter(item => {
                if (!query) return true;
                const haystack = isAbility
                    ? `${item.name || ''} ${item.desc || ''}`.toLowerCase()
                    : `${item.name || ''} ${item.type || ''} ${item.category || ''} ${item.desc || ''}`.toLowerCase();
                return haystack.includes(query);
            });

            filtered.sort((a, b) => {
                if (sort === 'name-desc') return String(b.name || '').localeCompare(String(a.name || ''));
                if (sort === 'newest') return String(b.id || '').localeCompare(String(a.id || ''));
                if (sort === 'oldest') return String(a.id || '').localeCompare(String(b.id || ''));
                return String(a.name || '').localeCompare(String(b.name || ''));
            });

            const addButton = isAbility
                ? `<button class="btn btn-primary" type="button" onclick="closeModal('custom-entity-chooser-modal'); openCustomAbilityLibraryModal();" style="width:100%;justify-content:center;margin-bottom:14px;">＋ Make a New Ability</button>`
                : `<button class="btn btn-primary" type="button" onclick="closeModal('custom-entity-chooser-modal'); openCustomMoveModal();" style="width:100%;justify-content:center;margin-bottom:14px;">＋ Make a New Move</button>`;

            const placeholder = isAbility ? 'Search your custom abilities...' : 'Search your custom moves...';
            const emptyText = query
                ? 'No custom entries match your search.'
                : (isAbility ? 'No custom abilities yet.' : 'No custom moves yet.');

            body.innerHTML = `
                ${addButton}
                <div class="custom-entity-library-controls">
                    <input id="custom-entity-search" class="custom-entity-search" type="text" placeholder="${placeholder}" value="${escapeHtmlAttr(query)}" oninput="renderCustomEntityChooser('${kind}')">
                    <select id="custom-entity-sort" class="custom-entity-sort" onchange="renderCustomEntityChooser('${kind}')">
                        <option value="name-asc" ${sort === 'name-asc' ? 'selected' : ''}>Name (A-Z)</option>
                        <option value="name-desc" ${sort === 'name-desc' ? 'selected' : ''}>Name (Z-A)</option>
                        <option value="newest" ${sort === 'newest' ? 'selected' : ''}>Newest First</option>
                        <option value="oldest" ${sort === 'oldest' ? 'selected' : ''}>Oldest First</option>
                    </select>
                </div>
                <div class="custom-entity-chooser-list">
                    ${filtered.length ? filtered.map(item => {
                        const detail = isAbility
                            ? (item.desc || 'No description')
                            : `${item.category || 'Status'} · ${item.type || 'Normal'} · ${item.basePower || '-'} BP · ${item.pp || '-'} PP`;
                        const handler = isAbility
                            ? `addExistingCustomAbility('${escapeJsString(item.id)}')`
                            : `addExistingCustomMove('${escapeJsString(item.id)}')`;
                        const codeBadge = isAbility && item.blocks && item.blocks.trigger ? '<span class="ability-code-badge" title="Has battle code from the block editor"><i data-lucide="puzzle"></i> Coded</span>' : '';
                        const codeBtn = isAbility ? `<button type="button" class="chooser-option-code-btn" title="Edit battle code" onclick="event.stopPropagation();openAbilityBlockEditor('${escapeJsString(item.id)}')"><i data-lucide="puzzle"></i></button>` : '';
                        return `<div class="chooser-option" onclick="${handler}">
                            <div><strong>${escapeHtml(item.name || 'Unnamed')}</strong> ${codeBadge}<span>${escapeHtml(detail)}</span></div>
                            ${codeBtn}
                            <i data-lucide="plus-circle"></i>
                        </div>`;
                    }).join('') : `<div class="custom-entity-empty">${emptyText}</div>`}
                </div>
            `;

            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function getCustomMoveLibrary() {
            return Array.isArray(state.customMoves) ? state.customMoves : [];
        }
        function getCustomAbilityLibrary() {
            return Array.isArray(state.customAbilities) ? state.customAbilities : [];
        }

        function openCustomAbilityChooser() {
            const list = getCustomAbilityLibrary();
            if (!list.length) {
                openCustomAbilityLibraryModal();
                return;
            }
            const modal = document.getElementById('custom-entity-chooser-modal');
            document.getElementById('custom-entity-chooser-title').textContent = 'Add Custom Ability';
            modal.classList.add('active');
            renderCustomEntityChooser('ability');
        }
        function openCustomAbilityLibraryModal(id='') {
            const a=id?getCustomAbilityLibrary().find(x=>x.id===id):null;
            document.getElementById('custom-ability-edit-id').value=id; document.getElementById('custom-ability-modal-title').textContent=a?'Edit Custom Ability':'Create Custom Ability'; document.getElementById('custom-ability-name').value=a?.name||''; document.getElementById('custom-ability-desc').value=a?.desc||''; document.getElementById('custom-ability-modal').classList.add('active');
        }
        function saveCustomAbilityLibraryEntry(){
            const name=document.getElementById('custom-ability-name').value.trim(); if(!name){api.showToast('Please enter an ability name!','error');return;}
            const desc=document.getElementById('custom-ability-desc').value.trim(); let id=document.getElementById('custom-ability-edit-id').value;
            if(id){const a=getCustomAbilityLibrary().find(x=>x.id===id); if(a){a.name=name;a.desc=desc;} state.fakemonDB.forEach(f=>(f.abilities||[]).forEach(a=>{if(a&&a.customId===id){a.name=name;a.desc=desc;a.source='custom';a.custom=true;}}));}
            else {id='ca_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); state.customAbilities.push({id,name,desc}); if(state.abilities.length<4 && document.getElementById('editor-view').style.display!=='none'){state.abilities.push({name,source:'custom',custom:true,customId:id,desc});renderAbilities();updatePreview();api.autoSave();}}
            api.saveToStorage(); api.renderCollection(); closeModal('custom-ability-modal'); api.showToast(id&&document.getElementById('custom-ability-edit-id').value?'Custom ability saved!':'Custom ability created!','success');
        }
        function addExistingCustomAbility(id){const a=getCustomAbilityLibrary().find(x=>x.id===id);if(!a)return;if(document.getElementById('editor-view')?.style.display==='none'){api.showToast('Open a Fakemon in the editor before adding a custom ability.','info');return;}if(state.abilities.length>=4){api.showToast('A Pokemon can have a maximum of 4 abilities.','error');return;}if(state.abilities.some(x=>x&&x.customId===id)){api.showToast('That custom ability is already on this Fakemon.','info');return;}state.abilities.push({name:a.name,source:'custom',custom:true,customId:id,desc:a.desc||''});closeModal('custom-entity-chooser-modal');renderAbilities();updatePreview();api.autoSave();api.showToast('Custom ability added!','success');}
        function editCustomAbilityLibrary(id){openCustomAbilityLibraryModal(id);}


// ==================== CUSTOM ITEMS ====================
let pendingSampleSetItemTarget = null;
function getCustomItemLibrary() { return Array.isArray(state.customItems) ? state.customItems : []; }
function openCustomItemModal(id='', sampleSetTarget=null) {
    pendingSampleSetItemTarget = sampleSetTarget || null;
    const item = id ? getCustomItemLibrary().find(x => x.id === id) : null;
    const modal = document.getElementById('custom-item-modal');
    if (!modal) return;
    document.getElementById('custom-item-edit-id').value = id;
    document.getElementById('custom-item-modal-title').textContent = item ? 'Edit Custom Item' : 'Create Custom Item';
    document.getElementById('custom-item-name').value = item?.name || '';
    document.getElementById('custom-item-desc').value = item?.desc || '';
    const preview = document.getElementById('custom-item-artwork-preview');
    if (preview) preview.innerHTML = item?.artwork ? `<img src="${item.artwork}" alt="Item artwork">` : '<span class="placeholder">ITEM</span>';
    modal.classList.add('active');
    setTimeout(() => document.getElementById('custom-item-name')?.focus(), 50);
}
function saveCustomItemLibraryEntry() {
    const name = document.getElementById('custom-item-name')?.value.trim() || '';
    if (!name) { api.showToast('Please enter an item name!', 'error'); return; }
    const desc = document.getElementById('custom-item-desc')?.value.trim() || '';
    const artwork = document.getElementById('custom-item-artwork-preview')?.querySelector('img')?.src || '';
    let id = document.getElementById('custom-item-edit-id')?.value || '';
    if (!Array.isArray(state.customItems)) state.customItems = [];
    let item;
    if (id) {
        item = state.customItems.find(x => x.id === id);
        if (!item) { id = ''; }
    }
    if (!id) {
        id = 'ci_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        item = { id, name, desc, artwork, source:'custom', custom:true };
        state.customItems.push(item);
    } else {
        Object.assign(item, { name, desc, artwork, source:'custom', custom:true });
    }
    const target = pendingSampleSetItemTarget;
    pendingSampleSetItemTarget = null;
    if (target && Number.isInteger(target.setIndex) && state.sampleSets[target.setIndex]) {
        state.sampleSets[target.setIndex].item = name;
        state.sampleSets[target.setIndex].itemCustom = true;
        state.sampleSets[target.setIndex].itemCustomId = id;
        state.sampleSets[target.setIndex].itemDesc = desc;
        api.renderSampleSets?.();
        api.updatePreview?.();
        api.autoSave?.();
    }
    api.saveToStorage();
    api.renderCollection();
    closeModal('custom-item-modal');
    api.showToast(id ? 'Custom item saved!' : 'Custom item created!', 'success');
}
function editCustomItemLibrary(id) { openCustomItemModal(id); }
function processCustomItemArtworkFile(file) {
    if (!file) return;
    if (!file.type || !file.type.startsWith('image/')) { api.showToast('Please use an image file for item artwork.', 'error'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
        const preview = document.getElementById('custom-item-artwork-preview');
        if (preview) preview.innerHTML = `<img src="${e.target.result}" alt="Item artwork">`;
        document.getElementById('custom-item-artwork-zone')?.classList.remove('artwork-drag-over');
    };
    reader.readAsDataURL(file);
}
function handleCustomItemArtworkUpload(event) { processCustomItemArtworkFile(event?.target?.files?.[0]); if (event?.target) event.target.value = ''; }
function handleCustomItemArtworkDragOver(event) { event.preventDefault(); event.stopPropagation(); document.getElementById('custom-item-artwork-zone')?.classList.add('artwork-drag-over'); }
function handleCustomItemArtworkDragLeave(event) { event.preventDefault(); document.getElementById('custom-item-artwork-zone')?.classList.remove('artwork-drag-over'); }
function handleCustomItemArtworkDrop(event) { event.preventDefault(); event.stopPropagation(); processCustomItemArtworkFile(event?.dataTransfer?.files?.[0]); }


// ==================== CUSTOM MOVES ====================
        // ==================== GENERIC TYPE DROPDOWN HELPERS ====================
        // Reusable version of the fancy pill-style type dropdown (used for Type1/Type2)
        // so any other type picker (custom move type, sample set Tera Type, etc.)
        // can render and behave identically. `which` must match the id prefix used
        // on the trigger's onclick="toggleTypeDropdown(which)" call.
        function buildTypeMenuOptions(makeOnclick, allowNone, noneLabel) {
            const opt = (type) => {
                if (!type) return `<div class="type-dropdown-option" onclick="${makeOnclick('')}; event.stopPropagation();"><span>${noneLabel}</span></div>`;
                const tc = 'type-' + type.toLowerCase();
                return `<div class="type-dropdown-option" onclick="${makeOnclick(type)}; event.stopPropagation();"><span class="type-pill ${tc}">${type}</span></div>`;
            };
            return (allowNone ? opt('') : '') + POKEMON_TYPES.map(opt).join('');
        }
        function setTypeDropdownValue(which, type, noneLabel) {
            const valueEl = document.getElementById(which + '-value');
            if (!valueEl) return;
            if (type) {
                const tc = 'type-' + type.toLowerCase();
                valueEl.innerHTML = '<span class="type-pill ' + tc + '">' + type + '</span>';
            } else {
                valueEl.textContent = noneLabel;
            }
            const dropdown = document.getElementById(which + '-dropdown');
            if (dropdown) dropdown.classList.remove('open');
        }
        function selectCustomMoveType(type) {
            document.getElementById('custom-move-type').value = type;
            setTypeDropdownValue('custom-move-type', type, 'Select Type');
        }
        // Category Dropdown helpers (mirrors the Type Dropdown helpers above).
        function buildCatMenuOptions(makeOnclick, allowNone, noneLabel) {
            const cats = ['Physical', 'Special', 'Status'];
            const opt = (cat) => {
                if (!cat) return `<div class="cat-dropdown-option" onclick="${makeOnclick('')}; event.stopPropagation();"><span>${noneLabel}</span></div>`;
                const cc = 'cat-' + cat.toLowerCase();
                return `<div class="cat-dropdown-option" onclick="${makeOnclick(cat)}; event.stopPropagation();"><span class="cat-pill ${cc}">${cat}</span></div>`;
            };
            return (allowNone ? opt('') : '') + cats.map(opt).join('');
        }
        function setCatDropdownValue(which, cat, noneLabel) {
            const valueEl = document.getElementById(which + '-value');
            if (!valueEl) return;
            if (cat) {
                const cc = 'cat-' + cat.toLowerCase();
                valueEl.innerHTML = '<span class="cat-pill ' + cc + '">' + cat + '</span>';
            } else {
                valueEl.textContent = noneLabel;
            }
            const dropdown = document.getElementById(which + '-dropdown');
            if (dropdown) dropdown.classList.remove('open');
        }
        function selectCustomMoveCategory(category) {
            document.getElementById('custom-move-category').value = category;
            setCatDropdownValue('custom-move-category', category, 'Status');
            updateCustomMoveFlagAvailability();
        }
        function selectLearnsetTypeFilter(type) {
            document.getElementById('learnset-filter-type').value = type;
            setTypeDropdownValue('learnset-filter-type', type, 'All Types');
            renderLearnset();
        }
        function selectLearnsetCategoryFilter(category) {
            document.getElementById('learnset-filter-category').value = category;
            setCatDropdownValue('learnset-filter-category', category, 'All Categories');
            renderLearnset();
        }
        function selectTeraType(setIndex, type) {
            updateSampleSet(setIndex, 'teraType', type);
            setTypeDropdownValue(`tera-type-${setIndex}`, type, 'None');
        }

        function updateCustomMoveFlagAvailability() {
            const category = document.getElementById('custom-move-category')?.value || 'Status';
            const statusOnly = category === 'Status';
            ['reflectable', 'snatch'].forEach(flag => {
                const cb = document.querySelector(`#custom-move-flags input[value="${flag}"]`);
                if (!cb) return;
                const label = cb.closest('label');
                if (label) label.style.display = statusOnly ? '' : 'none';
                if (!statusOnly) cb.checked = false;
            });
        }

        function openCustomMoveModal(index) {
        log.debug('CUSTOM MOVE', 'Opening custom move modal', { index });
            const menu = document.getElementById('custom-move-type-menu');
            if (menu && !menu.innerHTML) {
                menu.innerHTML = buildTypeMenuOptions(t => `selectCustomMoveType('${t}')`, false, '');
            }
            const catMenu = document.getElementById('custom-move-category-menu');
            if (catMenu && !catMenu.innerHTML) {
                catMenu.innerHTML = buildCatMenuOptions(c => `selectCustomMoveCategory('${c}')`, false, '');
            }

            if (index !== undefined && state.learnset[index] && isCustomMove(state.learnset[index])) {
                const m = state.learnset[index];
                document.getElementById('custom-move-edit-index').value = index;
                document.getElementById('custom-move-library-edit-id').value = '';
                document.getElementById('custom-move-modal-title').textContent = 'Edit Custom Move';
                document.getElementById('custom-move-name').value = m.name || '';
                document.getElementById('custom-move-type').value = m.type || 'Normal';
                setTypeDropdownValue('custom-move-type', m.type || 'Normal', 'Select Type');
                document.getElementById('custom-move-category').value = m.category || 'Status';
                setCatDropdownValue('custom-move-category', m.category || 'Status', 'Status');
                document.getElementById('custom-move-power').value = m.basePower || 0;
                document.getElementById('custom-move-accuracy').value = (m.accuracy === true || m.accuracy === undefined) ? 100 : (m.accuracy === false ? 0 : (m.accuracy || 100));
                document.getElementById('custom-move-pp').value = m.pp || 10;
                document.getElementById('custom-move-priority').value = m.priority || 0;
                document.getElementById('custom-move-desc').value = m.desc || '';

                document.querySelectorAll('#custom-move-flags input').forEach(cb => {
                    cb.checked = m.flags && m.flags[cb.value] ? true : false;
                });
            } else {
                document.getElementById('custom-move-edit-index').value = '';
                document.getElementById('custom-move-library-edit-id').value = '';
                document.getElementById('custom-move-modal-title').textContent = 'Create Custom Move';
                document.getElementById('custom-move-name').value = '';
                document.getElementById('custom-move-type').value = 'Normal';
                setTypeDropdownValue('custom-move-type', 'Normal', 'Select Type');
                document.getElementById('custom-move-category').value = 'Status';
                setCatDropdownValue('custom-move-category', 'Status', 'Status');
                document.getElementById('custom-move-power').value = 0;
                document.getElementById('custom-move-accuracy').value = 100;
                document.getElementById('custom-move-pp').value = 10;
                document.getElementById('custom-move-priority').value = 0;
                document.getElementById('custom-move-desc').value = '';
                document.querySelectorAll('#custom-move-flags input').forEach(cb => cb.checked = false);
            }

            updateCustomMoveFlagAvailability();
            document.getElementById('custom-move-modal').classList.add('active');
        }

        function saveCustomMove() {
        log.info('CUSTOM MOVE', 'Saving custom move');
            const name = document.getElementById('custom-move-name').value.trim();
            if (!name) { api.showToast('Please enter a move name!', 'error'); return; }
            const category = document.getElementById('custom-move-category').value;
            const flags = {};
            document.querySelectorAll('#custom-move-flags input:checked').forEach(cb => {
                if ((cb.value === 'snatch' || cb.value === 'reflectable') && category !== 'Status') return;
                flags[cb.value] = 1;
            });
            const move = { name, type:document.getElementById('custom-move-type').value, category, basePower:parseInt(document.getElementById('custom-move-power').value)||0, accuracy:parseInt(document.getElementById('custom-move-accuracy').value)||100, pp:parseInt(document.getElementById('custom-move-pp').value)||10, priority:parseInt(document.getElementById('custom-move-priority').value)||0, flags, desc:document.getElementById('custom-move-desc').value.trim() };
            const libraryId = document.getElementById('custom-move-library-edit-id').value;
            if (libraryId) {
                const lib = state.customMoves.find(m => m.id === libraryId);
                if (lib) Object.assign(lib, move);
                state.fakemonDB.forEach(f => (f.learnset||[]).forEach(m => { if (m && m.customId === libraryId) Object.assign(m, move, {source:'custom', custom:true, customId:libraryId, learnMethod:'none', level:null}); }));
                // Keep the in-memory editor learnset in sync too, in case the Fakemon
                // currently open in the (possibly hidden) editor has this move.
                state.learnset.forEach(m => { if (m && m.customId === libraryId) Object.assign(m, move, {source:'custom', custom:true, customId:libraryId, learnMethod:'none', level:null}); });
                api.saveToStorage(); api.renderCollection(); closeModal('custom-move-modal'); api.showToast('Custom move updated!', 'success'); return;
            }
            // Only touch the in-editor learnset if the editor is actually open. Creating
            // a brand-new library move from the Collection screen must never silently
            // attach it to whichever Fakemon happened to be open last (this was the
            // cause of custom moves "duplicating" onto the wrong Fakemon).
            const inEditor = document.getElementById('editor-view').style.display !== 'none';
            const editIndex = inEditor ? document.getElementById('custom-move-edit-index').value : '';
            const id = editIndex !== '' && state.learnset[parseInt(editIndex)]?.customId ? state.learnset[parseInt(editIndex)].customId : 'cm_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
            const libraryEntry = { ...move, id };
            const existingLib = state.customMoves.find(m => m.id === id);
            if (existingLib) Object.assign(existingLib, libraryEntry); else state.customMoves.push(libraryEntry);
            if (inEditor) {
                if (editIndex !== '') {
                    const existing = state.learnset[parseInt(editIndex)];
                    state.learnset[parseInt(editIndex)] = { ...existing, ...move, source:'custom', custom:true, customId:id, learnMethod:'none', level:null };
                } else {
                    state.learnset.push({ ...move, source:'custom', custom:true, customId:id, learnMethod:'none', level:null });
                }
                sortLearnset(); renderLearnset(); updatePreview(); api.autoSave();
            }
            closeModal('custom-move-modal'); api.saveToStorage(); api.renderCollection();
            api.showToast(editIndex !== '' ? 'Custom move updated!' : 'Custom move created!', 'success');
        }

        function openCustomMoveChooser() {
            const list = getCustomMoveLibrary();
            if (!list.length) {
                document.getElementById('custom-entity-chooser-modal')?.classList.remove('active');
                openCustomMoveModal();
                return;
            }
            const modal = document.getElementById('custom-entity-chooser-modal');
            document.getElementById('custom-entity-chooser-title').textContent = 'Add Custom Move';
            modal.classList.add('active');
            renderCustomEntityChooser('move');
        }
        function addExistingCustomMove(id) {
            const m = getCustomMoveLibrary().find(x=>x.id===id); if (!m) return;
            if (document.getElementById('editor-view')?.style.display === 'none') {
                api.showToast('Open a Fakemon in the editor before adding a custom move to its learnset.', 'info');
                return;
            }
            if (state.learnset.some(x=>x && x.customId===id)) { api.showToast('That custom move is already in this learnset.', 'info'); return; }
            state.learnset.push({...m, source:'custom', custom:true, customId:id, learnMethod:'none', level:null});
            closeModal('custom-entity-chooser-modal'); sortLearnset(); renderLearnset(); updatePreview(); api.autoSave(); api.showToast('Custom move added to learnset!', 'success');
        }
        function editCustomMoveLibrary(id) {
            const m=getCustomMoveLibrary().find(x=>x.id===id); if(!m) return;
            closeModal('custom-entity-chooser-modal');
            openCustomMoveModal();
            document.getElementById('custom-move-library-edit-id').value=id;
            document.getElementById('custom-move-edit-index').value='';
            document.getElementById('custom-move-modal-title').textContent='Edit Custom Move';
            document.getElementById('custom-move-name').value=m.name||''; document.getElementById('custom-move-type').value=m.type||'Normal'; setTypeDropdownValue('custom-move-type',m.type||'Normal','Select Type'); document.getElementById('custom-move-category').value=m.category||'Status'; setCatDropdownValue('custom-move-category',m.category||'Status','Status'); document.getElementById('custom-move-power').value=m.basePower||0; document.getElementById('custom-move-accuracy').value=m.accuracy??100; document.getElementById('custom-move-pp').value=m.pp||10; document.getElementById('custom-move-priority').value=m.priority||0; document.getElementById('custom-move-desc').value=m.desc||''; document.querySelectorAll('#custom-move-flags input').forEach(cb=>cb.checked=!!(m.flags&&m.flags[cb.value])); updateCustomMoveFlagAvailability();
        }

        function removeCustomMove(index) {
            if (index === undefined || !state.learnset[index] || !isCustomMove(state.learnset[index])) return;
            removeLearnsetMove(index);
        }

        function renderCustomMoves() {
            renderLearnset();
            renderCustomMoveShowcase();
        }

        function renderCustomMoveShowcase() {
            const container = document.getElementById('custom-moves-showcase');
            if (!container) return;
            const customMoves = state.learnset.filter(m => isCustomMove(m) && m.name);
            if (!customMoves.length) {
                container.innerHTML = '';
                return;
            }

            const cards = customMoves.map((m) => {
                const typeClass = `type-${(m.type || 'Normal').toLowerCase()}`;
                const accText = (m.accuracy === true || m.accuracy === undefined || m.accuracy === false) ? '-' : `${m.accuracy}%`;
                const method = m.learnMethod === 'level' && m.level ? `Level ${m.level}` :
                    m.learnMethod === 'tm' ? 'TM' :
                    m.learnMethod === 'egg' ? 'Egg' : '-';
                const priority = m.priority ? ` · Priority ${m.priority}` : '';
                const flags = getFlagLabels(m.flags || {}, m.category);
                return `
                    <div class="custom-move-showcase-card" onclick="openCustomMoveModal(${state.learnset.indexOf(m)})">
                        <div class="custom-move-showcase-header">
                            <span class="type-pill ${typeClass}">${m.type || 'Normal'}</span>
                            <div class="custom-move-showcase-name">${escapeHtml(m.name)}</div>
                            <span class="custom-move-showcase-method">${method}</span>
                        </div>
                        <div class="custom-move-showcase-stats">
                            ${m.category || 'Status'} · ${m.basePower || '-'} BP · ${accText} acc · ${m.pp || '-'} PP${priority}
                        </div>
                        ${m.desc ? `<div class="custom-move-showcase-desc">${escapeHtml(m.desc)}</div>` : ''}
                        ${flags.length ? `<div class="custom-move-showcase-flags">${flags.map(f => `<span>${escapeHtml(f)}</span>`).join('')}</div>` : ''}
                    </div>
                `;
            }).join('');

            container.innerHTML = `
                <div class="custom-move-showcase">
                    <div class="board-section-title">Custom Moves</div>
                    <div class="custom-move-showcase-list">${cards}</div>
                </div>
            `;
        }

        

export { sortLearnsetEntries, resetEditingCustomAbilityIndex, getAbilityRole, fetchShowdownData, filterAbilities, filterMoves, renderDropdown, openMoveBrowserModal, filterMoveBrowser, addMoveFromBrowser, toggleMoveBrowserFlag, clearMoveBrowserFilters, hideAbilityDropdownDelayed, hideMoveDropdownDelayed, toggleLevelInput, handleAbilityKey, findClosestAbility, findClosestMove, findClosestMoveForImport, parseMoveImportText, openMoveImportExportModal, exportMovesToText, importMovesFromText, handleMoveKey, addMoveFromInput, addAbility, openCustomAbilityChooser, openCustomAbilityLibraryModal, saveCustomAbilityLibraryEntry, addExistingCustomAbility, editCustomAbilityLibrary, updateAbility, toggleCustomAbilityEdit, finishCustomAbilityEdit, removeAbility, moveAbility, renderAbilities, showAbilityDetail, getSdMoveByName, hydrateLearnsetEntry, rehydrateCurrentLearnsetFromShowdown, addLearnsetMove, removeLearnsetMove, updateMoveMethod, updateMoveLevel, sortLearnset, renderLearnset, buildDonutSVG, renderLearnsetChart, clearLearnsetFilters, addUniversalMoves, getFakemonStats, getFakemonProfile, findSimilarPokemon, classifyLearnsetSource, buildSimilarMovePools, classifyMoveRole, generateMoveRecommendations, openRecommendMovesModal, renderRecommendMovesModal, selectRecommendedMove, generateLearnset, formatLearnMethodLabel, showGeneratedLearnsetSummary, clearMoveset, showMoveDetail, updateCustomAbility, removeCustomAbility, renderCustomAbilities, buildTypeMenuOptions, setTypeDropdownValue, buildCatMenuOptions, setCatDropdownValue, selectCustomMoveType, selectCustomMoveCategory, selectLearnsetTypeFilter, selectLearnsetCategoryFilter, selectMoveBrowserTypeFilter, selectMoveBrowserCategoryFilter, openCustomMoveChooser, addExistingCustomMove, editCustomMoveLibrary, openCustomMoveModal, saveCustomMove, removeCustomMove, renderCustomMoves, getCustomItemLibrary, openCustomItemModal, saveCustomItemLibraryEntry, editCustomItemLibrary, processCustomItemArtworkFile, handleCustomItemArtworkUpload, handleCustomItemArtworkDragOver, handleCustomItemArtworkDragLeave, handleCustomItemArtworkDrop, renderCustomMoveShowcase, selectTeraType, loadCompetitiveMoveUsefulness, escapeHtml, isCustomMove };