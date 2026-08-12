import { state, api } from './app.js';

import { POKEMON_TYPES, NATURE_DATA, NATURES, STAT_NAMES, TYPE_EFFECTIVENESS } from './data.js';
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
                    console.warn('[Sample Sets] competitive move weights unavailable from', url, err);
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
            const statusEl = document.getElementById('api-status');
            if (statusEl) statusEl.style.display = 'none';
            console.log('[Showdown] Loading data...');

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

                // Parse abilities
                const abilitiesMatch = abilitiesText.match(/exports\.BattleAbilities\s*=\s*(\{[\s\S]*\});/);
                if (abilitiesMatch) {
                    let jsonStr = abilitiesMatch[1].replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_-]*)(\s*:)/g, '$1"$2"$3');
                    const abilitiesRaw = JSON.parse(jsonStr);
                    for (const [key, a] of Object.entries(abilitiesRaw)) {
                        if (a.isNonstandard === 'Past') continue;
                        state.sdAbilities[key] = { name: a.name || key, desc: a.shortDesc || a.desc || '' };
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
                // — used to find real Pokemon similar to this Fakemon for state.learnset generation.
                for (const [key, p] of Object.entries(pokedexRaw)) {
                    if (!p.baseStats || !p.types || !p.num || p.num <= 0) continue; // skip CAP/nonstandard/formes w/o stats
                    if (p.forme && !/^(Alola|Galar|Hisui|Paldea)/.test(p.forme)) continue; // skip mega/gmax/other cosmetic-ish formes, keep regional
                    let genderPct = 50;
                    if (p.gender === 'N') genderPct = -1; // genderless
                    else if (p.gender === 'M') genderPct = 100;
                    else if (p.gender === 'F') genderPct = 0;
                    else if (p.genderRatio) genderPct = Math.round((p.genderRatio.M || 0) * 100);
                    state.sdPokedex[key] = {
                        id: key,
                        name: p.name || key,
                        types: p.types || [],
                        stats: p.baseStats,
                        heightm: p.heightm || 0,
                        weightkg: p.weightkg || 0,
                        color: p.color || '',
                        eggGroups: p.eggGroups || [],
                        genderPct
                    };
                }
                // Parse learnsets (moveid -> array of "{gen}{method}{level?}" source strings)
                for (const [key, l] of Object.entries(learnsetsRaw)) {
                    if (!l.learnset) continue;
                    state.sdLearnsets[key] = l.learnset;
                }

                state.sdLoaded = true;
                // A Fakemon may have been loaded before the async Showdown fetch
                // completed. Rehydrate its minimal saved learnset now that the
                // authoritative vanilla move data is available.
                rehydrateCurrentLearnsetFromShowdown();
                console.log(`[Showdown] Data loaded (${Object.keys(state.sdMoves).length} moves, ${Object.keys(state.sdPokedex).length} species, ${Object.keys(state.sdAbilities).length} abilities, ${Object.keys(state.sdItems).length} items)`);
                api.showToast('Showdown data loaded!', 'success');
                updateBulkComparison();
            } catch (err) {
                console.error('[Showdown] data error:', err);
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
        function handleAbilityKey(e) {
            if (e.key === 'Enter') {
                const val = e.target.value.trim();
                if (val) addAbility(val, 'custom');
                e.target.value = '';
                document.getElementById('ability-dropdown').classList.remove('active');
            }
        }
                
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
            const accText = (move.accuracy === true || move.accuracy === undefined || move.accuracy === false) ? '—' : `${move.accuracy}%`;
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

        function getExportableMovesText() {
            // Canonical move import/export format:
            // - one alphabetical list of every move, with custom moves marked by *
            // - one blank line
            // - custom move definitions afterward, matching the starred names
            const entries = state.learnset
                .filter(move => move && move.name)
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
            const names = entries.map(move => `${move.name}${isCustomMove(move) ? '*' : ''}`);
            const customBlocks = entries.filter(isCustomMove).map(formatCustomMoveForImportExport);
            return names.join('\n') + (customBlocks.length ? `\n\n${customBlocks.join('\n\n')}` : '');
        }

        function openMoveImportExportModal() {
            const textarea = document.getElementById('move-import-export-text');
            if (!textarea) return;
            textarea.value = getExportableMovesText();
            document.getElementById('move-import-export-modal').classList.add('active');
            setTimeout(() => textarea.focus(), 0);
        }

        function exportMovesToText() {
            const textarea = document.getElementById('move-import-export-text');
            if (!textarea) return;
            textarea.value = getExportableMovesText();
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
            const acc = accRaw === '—' || /^true$/i.test(accRaw) ? true : parseStat(accRaw.replace(/%/g, ''), 100);
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
                        'wind': 'wind', 'dance': 'dance', 'mental': 'mental', 'defrost': 'defrost'
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

            if (!imported.length) {
                api.showToast('No valid moves were found in the import text.', 'error');
                return;
            }

            state.learnset = imported;
            // Do not apply the editor's default custom-first ordering here. The import
            // format itself defines the order, and the preview/export can alphabetize
            // independently when needed.
            renderLearnset();
            renderRecommendMovesModal();
            updatePreview();
            api.autoSave();
            if (textarea) textarea.value = getExportableMovesText();

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

                return `
                    <div class="ability-row${isCustom ? ' ability-custom' : ''}" draggable="true" data-ability-index="${i}">
                        <span class="ability-drag-handle" title="Drag to reorder" aria-label="Drag to reorder">⋮⋮</span>
                        <div class="ability-body">
                            <div class="ability-name-wrap">
                                <span class="ability-name-text"${isCustom ? ` onclick="event.stopPropagation(); toggleCustomAbilityEdit(${i})" title="Click to edit"` : ''}>${escapeHtml(a.name || 'Unnamed Ability')}</span>
                                ${roleHtml}
                            </div>
                            <div class="ability-desc-text"${isCustom ? ` onclick="event.stopPropagation(); toggleCustomAbilityEdit(${i})" title="Click to edit"` : ''}>${escapeHtml(desc || 'No description available.')}</div>
                        </div>
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
        // Learnset entries are saved with just {name, learnMethod, level} — everything else
        // (type, category, power, accuracy, flags, desc) is vanilla move data we re-derive
        // from the Showdown dataset here, so we never have to persist duplicate move info.
        function getSdMoveByName(name) {
            if (!name) return null;
            return Object.values(state.sdMoves).find(v => v.name === name) || null;
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
                bypasssub: !!source.bypasssub
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
                flags: md ? convertShowdownFlagsToEditorFlags(md.flags, md.category || entry.category) : (entry.flags || {}),
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
                const accText = m.accuracy === true || m.accuracy === undefined ? '—' : (m.accuracy === false ? '—' : `${m.accuracy}%`);
                const levelDisplay = m.learnMethod === 'level' ? 'inline-block' : 'none';
                const clickAction = custom ? `openCustomMoveModal(${i})` : `showMoveDetail('${String(m.name || '').replace(/'/g, "\\'")}')`;

                return `
                    <div class="learnset-item${custom ? ' custom-move-editor-item' : ''}" onclick="${clickAction}">
                        <div class="learnset-main">
                            <span class="move-name">${m.name}</span>
                            <div class="move-meta">
                                <span class="type-pill ${typeClass}">${m.type || 'Normal'}</span>
                                <span class="cat-pill ${catClass}">${getCategoryIcon(m.category || 'Status', 14)}</span>
                                <span class="power-text">${m.basePower || '—'} BP / ${accText}</span>
                            </div>
                            <div class="move-method-row">
                                <select class="method-select-inline" onchange="updateMoveMethod(${i}, this.value); event.stopPropagation();" onclick="event.stopPropagation();">
                                    <option value="none" ${m.learnMethod === 'none' || !m.learnMethod ? 'selected' : ''}>—</option>
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
        // groups, gender ratio) — everything we use to find real Pokemon it resembles.
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

        // ---- Similarity engine ----
        // Scores every real Pokemon against this Fakemon's profile (typing, stats,
        // height/weight, color, egg groups, gender ratio) and returns the closest
        // matches. Nothing needs to match exactly — it's a weighted "family resemblance"
        // score, same spirit as bitcrush.org's movelist generator.
        function findSimilarPokemon(profile, limit) {
            const scored = [];
            for (const dex of Object.values(state.sdPokedex)) {
                if (!state.sdLearnsets[dex.id] && !state.sdLearnsets[dex.id.replace(/-.*$/, '')]) continue;
                let score = 0;

                // Typing — the single biggest driver of what a mon's movepool looks like
                const sharedTypes = dex.types.filter(t => profile.types.includes(t)).length;
                score += sharedTypes * 30;
                if (sharedTypes === dex.types.length && sharedTypes === profile.types.length) score += 12;

                // Stat spread — normalized Euclidean distance across all 6 stats, so mons
                // with a similar role (e.g. bulky physical wall, frail special sweeper) rank close
                const statKeys = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
                let statDistSq = 0;
                statKeys.forEach(k => { const d = (dex.stats[k] || 0) - (profile.stats[k] || 0); statDistSq += d * d; });
                const statDist = Math.sqrt(statDistSq);
                score += Math.max(0, 34 - statDist / 6);

                // Height/weight — compared on a log scale since these span a huge range
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
        // if only a couple of real species can ever learn it — e.g. Fleur Cannon,
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
        // level-up / egg / TM move pools — this is what makes generated levels realistic
        // (a move only lands at Lv.1 here if similar mons actually learn it that early).
        function buildSimilarMovePools(profile) {
            const similar = findSimilarPokemon(profile, 25);
            const signatureMoveIds = getSignatureMoveIds();
            const agg = {}; // moveName -> { weight, levelWeightedSum, levelWeight, level:w, egg:w, tm:w, supporters:[names] }
            similar.forEach(({ dex, score }, rank) => {
                const learnsetData = state.sdLearnsets[dex.id] || state.sdLearnsets[dex.id.replace(/-.*$/, '')];
                if (!learnsetData) return;
                const weight = score / (1 + rank * 0.12); // higher-ranked (more similar) mons count more
                for (const [moveId, sources] of Object.entries(learnsetData)) {
                    if (signatureMoveIds.has(moveId)) continue; // skip near-exclusive signature moves
                    const classified = classifyLearnsetSource(sources);
                    if (!classified) continue;
                    const mv = state.sdMoves[moveId];
                    if (!mv) continue;
                    if (!agg[mv.name]) agg[mv.name] = { move: mv, weight: 0, levelWeightedSum: 0, levelWeight: 0, level: 0, egg: 0, tm: 0, supporters: [] };
                    const a = agg[mv.name];
                    a.weight += weight;
                    a[classified.method] += weight;
                    if (classified.method === 'level') { a.levelWeightedSum += classified.level * weight; a.levelWeight += weight; }
                    if (a.supporters.length < 4 && !a.supporters.includes(dex.name)) a.supporters.push(dex.name);
                }
            });
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

        // Name-based role classifiers — used only to sort already similarity-selected
        // moves into familiar categories (STAB/Flavour/Setup/Recovery/Utility/Coverage);
        // move *selection* and *levels* still come entirely from the similarity engine above.
        const SETUP_MOVE_NAMES = new Set(['Swords Dance', 'Nasty Plot', 'Calm Mind', 'Bulk Up', 'Dragon Dance', 'Coil', 'Quiver Dance', 'Tail Glow', 'Shell Smash', 'Growth', 'Work Up', 'Hone Claws', 'Iron Defense', 'Amnesia', 'Cotton Guard', 'Acid Armor', 'Cosmic Power', 'Stockpile', 'Rock Polish', 'Autotomize', 'Agility']);
        const SPEED_MOVE_NAMES = new Set(['Agility', 'Rock Polish', 'Autotomize', 'Dragon Dance']);
        const RECOVERY_MOVE_NAMES = new Set(['Recover', 'Roost', 'Rest', 'Slack Off', 'Synthesis', 'Moonlight', 'Morning Sun', 'Milk Drink', 'Soft-Boiled', 'Shore Up', 'Wish', 'Strength Sap']);
        const UTILITY_MOVE_NAMES = new Set(['Toxic', 'Will-O-Wisp', 'Thunder Wave', 'Stealth Rock', 'Spikes', 'Toxic Spikes', 'Sticky Web', 'Taunt', 'Knock Off', 'Trick', 'Switcheroo', 'Encore', 'Disable', 'Haze', 'Defog', 'Rapid Spin', 'Substitute', 'Protect', 'Detect', 'Light Screen', 'Reflect', 'Aurora Veil', 'Leech Seed', 'Confuse Ray', 'Yawn', 'Glare']);
        // Attacking moves that are technically damaging but too weak, too situational, or
        // secondary-effect-focused to count as a real STAB/Coverage pick — these get bucketed
        // as Flavour instead. Rather than raw BP alone (which Showdown doesn't rate for
        // "usefulness"), we combine a minimum power floor with named exclusions for moves
        // whose type is conditional/variable (Tera Blast, Hidden Power, etc.) or whose real
        // purpose is a secondary effect rather than damage (Thief, Round, Snore...).
        const MIN_STAB_COVERAGE_BP = 65;
        const CONDITIONAL_TYPE_MOVE_NAMES = new Set(['Tera Blast', 'Hidden Power', 'Judgment', 'Weather Ball', 'Natural Gift', 'Techno Blast', 'Multi-Attack', 'Revelation Dance', 'Terrain Pulse', 'Raging Bull', 'Ivy Cudgel']);
        const FILLER_ATTACK_MOVE_NAMES = new Set(['Round', 'Snore', 'Thief', 'Covet', 'Tackle', 'Pound', 'Scratch', 'Constrict', 'Present']);

        function classifyMoveRole(move, types) {
            if (SPEED_MOVE_NAMES.has(move.name) && move.name !== 'Dragon Dance') return 'speed';
            if (SETUP_MOVE_NAMES.has(move.name)) return 'setup';
            if (RECOVERY_MOVE_NAMES.has(move.name)) return 'recovery';
            if (UTILITY_MOVE_NAMES.has(move.name)) return 'utility';
            if (move.category !== 'Status' && (move.basePower || 0) > 0) {
                const isLowValue = (move.basePower || 0) < MIN_STAB_COVERAGE_BP
                    || CONDITIONAL_TYPE_MOVE_NAMES.has(move.name)
                    || FILLER_ATTACK_MOVE_NAMES.has(move.name);
                if (isLowValue) return 'flavour';
                return types.includes(move.type) ? 'stab' : 'coverage';
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

            pushSection('STAB Moves', buckets.stab, 6);
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
                container.innerHTML = '<p style="font-size:13px;color:var(--text-muted);">No new suggestions — looks like your learnset already covers the basics!</p>';
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
                                <span class="power-text">${move.basePower || '—'}</span>
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
        // weighted by similarity — so both which moves show up and what level they land at
        // reflect real patterns instead of a fixed curve. Moves already in the state.learnset are
        // "woven" in — reused in place (method/level updated) — rather than duplicated;
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
                    // Tackle/Pound/Scratch live — they're weak so stronger same-level moves
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
            placements.forEach(({ move, learnMethod, level }) => {
                const existing = state.learnset.find(m => m.name === move.name);
                if (existing) {
                    existing.learnMethod = learnMethod;
                    existing.level = level;
                    woven++;
                } else {
                    state.learnset.push(hydrateLearnsetEntry({ name: move.name, learnMethod, level }));
                    added++;
                }
            });

            sortLearnset();
            renderLearnset();
            renderRecommendMovesModal();
            updatePreview();
            autoSave();
            const sampleSimilar = pools.similar.slice(0, 3).join(', ');
            api.showToast(`Generated from Pokémon like ${sampleSimilar}: ${added} added, ${woven} woven in.`, 'success');
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
            const move = state.learnset.find(m => m.name === name);
            if (!move) return;
            const sdEntry = Object.entries(state.sdMoves).find(([k,v]) => v.name === name);
            const desc = sdEntry ? sdEntry[1].desc : (move.desc || 'No description available.');
            const acc = move.accuracy === true ? '—' : (move.accuracy === false ? '—' : `${move.accuracy}%`);

            // Build flag tidbits using the editor's normalized convention.
            // Vanilla Showdown flags are inverted here, and Status-only tags are
            // suppressed for damaging moves.
            const flags = isCustomMove(move)
                ? (move.flags || {})
                : convertShowdownFlagsToEditorFlags(sdEntry ? (sdEntry[1].flags || {}) : (move.flags || {}), move.category);
            const flagLabels = getFlagLabels(flags, move.category);
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
                <div class="detail-row"><span class="detail-label">Base Power</span><span class="detail-value">${move.basePower || '—'}</span></div>
                <div class="detail-row"><span class="detail-label">Accuracy</span><span class="detail-value">${acc}</span></div>
                <div class="detail-row"><span class="detail-label">PP</span><span class="detail-value">${move.pp || '—'}</span></div>
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
                            : `${item.category || 'Status'} · ${item.type || 'Normal'} · ${item.basePower || '—'} BP · ${item.pp || '—'} PP`;
                        const handler = isAbility
                            ? `addExistingCustomAbility('${escapeJsString(item.id)}')`
                            : `addExistingCustomMove('${escapeJsString(item.id)}')`;
                        return `<div class="chooser-option" onclick="${handler}">
                            <div><strong>${escapeHtml(item.name || 'Unnamed')}</strong><span>${escapeHtml(detail)}</span></div>
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
                const accText = (m.accuracy === true || m.accuracy === undefined || m.accuracy === false) ? '—' : `${m.accuracy}%`;
                const method = m.learnMethod === 'level' && m.level ? `Level ${m.level}` :
                    m.learnMethod === 'tm' ? 'TM' :
                    m.learnMethod === 'egg' ? 'Egg' : '—';
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
                            ${m.category || 'Status'} · ${m.basePower || '—'} BP · ${accText} acc · ${m.pp || '—'} PP${priority}
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

        
// ==================== SAMPLE SETS ====================
        // Competitive sample-set generator.
        //
        // This is intentionally local/deterministic: it never calls an AI or external
        // generation API.  The only move data it consumes is the Fakemon's current
        // learnset plus the Showdown move metadata already loaded into state.sdMoves.
        //
        // The scoring tables below are deliberately kept in one place so the generator
        // can be tuned without rewriting the selection algorithm.
        const SAMPLE_SET_CONFIG = {
            roles: {
                physicalSweeper: { name: 'Physical Sweeper', attack: 'atk', natureFast: 'Jolly', natureSlow: 'Adamant' },
                specialSweeper: { name: 'Special Sweeper', attack: 'spa', natureFast: 'Timid', natureSlow: 'Modest' },
                wallbreaker: { name: 'Wallbreaker', attack: null, natureFast: null, natureSlow: null },
                bulkyAttacker: { name: 'Bulky Attacker', attack: null, natureFast: null, natureSlow: null },
                defensive: { name: 'Defensive', attack: null, natureFast: null, natureSlow: null },
                support: { name: 'Support', attack: null, natureFast: null, natureSlow: null },
                pivot: { name: 'Pivot', attack: null, natureFast: null, natureSlow: null },
                setupSweeper: { name: 'Setup Sweeper', attack: null, natureFast: null, natureSlow: null },
                hazard: { name: 'Hazard Setter/Remover', attack: null, natureFast: null, natureSlow: null }
            },
            move: {
                stab: 34,
                superEffectiveCoverage: 18,
                neutralCoverage: 7,
                power: 0.075,
                usefulness: 7,
                selfKOPenalty: 45,
                accuracy: 4,
                priority: 10,
                setup: 30,
                recovery: 27,
                status: 12,
                hazard: 26,
                removal: 25,
                pivot: 24,
                speedControl: 18,
                disruption: 14,
                sameCategoryPenalty: 8,
                redundantTypePenalty: 13,
                redundantRolePenalty: 16,
                lowPowerPenalty: 8,
                abilitySynergy: 18,
                signaturePenalty: 0
            },
            roles: {
                speedSweeperMin: 80,
                physicalAttackMin: 85,
                specialAttackMin: 85,
                bulkyHpMin: 85,
                bulkyDefMin: 85,
                bulkySpdMin: 85,
                wallbreakerPowerMin: 80
            }
        };

        const SAMPLE_SET_MOVE_TAGS = {
            setup: new Set(['Swords Dance','Nasty Plot','Calm Mind','Bulk Up','Dragon Dance','Quiver Dance','Shell Smash','Shift Gear','Victory Dance','Tail Glow','Growth','Work Up','Hone Claws','Coil','Curse','Agility','Rock Polish','Autotomize']),
            defensiveSetup: new Set(['Iron Defense','Amnesia','Acid Armor','Cotton Guard','Cosmic Power','Stockpile']),
            recovery: new Set(['Recover','Roost','Rest','Slack Off','Synthesis','Moonlight','Morning Sun','Milk Drink','Soft-Boiled','Shore Up','Wish','Strength Sap','Heal Order']),
            hazards: new Set(['Stealth Rock','Spikes','Toxic Spikes','Sticky Web']),
            removal: new Set(['Rapid Spin','Defog','Mortal Spin']),
            pivot: new Set(['U-turn','Volt Switch','Flip Turn','Parting Shot','Chilly Reception','Teleport','Shed Tail']),
            speedControl: new Set(['Thunder Wave','Glare','Icy Wind','Electroweb','Tailwind']),
            disruption: new Set(['Taunt','Encore','Knock Off','Trick','Switcheroo','Haze','Roar','Whirlwind','Yawn','Disable','Toxic','Will-O-Wisp']),
            screens: new Set(['Reflect','Light Screen','Aurora Veil'])
        };

        // Competitive-set filters. These are intentionally explicit so the generator
        // prefers moves that actually belong on a serious set instead of merely having
        // high BP or being technically legal.
        const SAMPLE_SET_BAD_DEFAULT_MOVES = new Set([
            // Generic/weak attacks that should never be auto-selected for a competitive
            // sample set. These remain perfectly legal in the Fakemon's learnset and can
            // still be selected manually.
            'Covet','Thief','Tackle','Pound','Scratch','Constrict','Present','Round','Snore',
            'Bide','Rage','Fury Attack','Fury Swipes','Take Down','Submission','Headbutt',
            'Mega Drain','Absorb','Vine Whip','Razor Leaf','Ember','Water Gun','Bubble',
            'Powder Snow','Gust','Peck','Pursuit','Astonish','Lick','Aerial Ace',
            'Quick Attack','Feint','Vacuum Wave','Mach Punch','Bullet Punch',
            'Nuzzle','Pounce','Mud Shot','Bulldoze','Rock Smash','Low Sweep',
            'Fling','Natural Gift','Echoed Voice','Uproar','Swift','Snarl',
            'Struggle Bug','Infestation','Inflict',
            'Focus Energy','Laser Focus'
        ]);

        // Additional low-value status/utility moves. The sample-set generator is
        // deliberately conservative: if a status move does not have a clear competitive
        // job, it should never be used merely to fill the fourth slot.
        const SAMPLE_SET_LOW_VALUE_UTILITY_MOVES = new Set([
            'Safeguard','Mist','Lucky Chant','Sweet Scent','Odor Sleuth','Foresight',
            'Flash','Sand Attack','Smokescreen','Kinesis','Mud-Slap','Tail Whip',
            'Growl','Leer','String Shot','Scary Face','Baby-Doll Eyes','Play Nice',
            'Tickle','Noble Roar','Screech','Fake Tears','Metal Sound','Defog',
            'Harden','Withdraw','Defense Curl','Minimize','Double Team','Swagger',
            'Flatter','Teeter Dance','Confide','Charm','Captivate','Attract',
            'Sweet Kiss','Flatter','Supersonic','Confusion','Kinesis','Smog',
            'Poison Gas','Smokescreen','Sand Attack','Water Sport','Mud Sport',
            'Lucky Chant','Magic Coat'
        ]);
        const SAMPLE_SET_SELF_KO_MOVES = new Set([
            'Explosion','Self-Destruct','Misty Explosion','Final Gambit','Memento','Healing Wish','Lunar Dance'
        ]);
        const SAMPLE_SET_COVERAGE_TYPES = ['Normal','Fire','Water','Electric','Grass','Ice','Fighting','Poison','Ground','Flying','Psychic','Bug','Rock','Ghost','Dragon','Dark','Steel','Fairy'];
        // Premium attacks that should survive competitive-usefulness filtering even when
        // they have little/no sample-set frequency. These are not blanket auto-picks;
        // they still have to fit the Fakemon's role, category, typing, and movepool.
        const SAMPLE_SET_PREMIUM_ATTACKS = new Set([
            'V-create','Gigaton Hammer','Make It Rain','Fleur Cannon','Bolt Beak','Fishious Rend',
            'Headlong Rush','Glacial Lance','Astral Barrage','Collision Course','Electro Drift',
            'Population Bomb','Last Respects','Rage Fist','Expanding Force','Surging Strikes'
        ]);

        function sampleSetHash(value) {
            let h = 2166136261 >>> 0;
            const s = String(value);
            for (let i = 0; i < s.length; i++) {
                h ^= s.charCodeAt(i);
                h = Math.imul(h, 16777619);
            }
            return h >>> 0;
        }

        function sampleSetRng(seed) {
            let x = seed >>> 0;
            return () => {
                x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
                return (x >>> 0) / 4294967296;
            };
        }

        function getSampleSetProfile() {
            const stats = {
                hp: parseInt(document.getElementById('stat-hp')?.value) || 60,
                atk: parseInt(document.getElementById('stat-atk')?.value) || 60,
                def: parseInt(document.getElementById('stat-def')?.value) || 60,
                spa: parseInt(document.getElementById('stat-spa')?.value) || 60,
                spd: parseInt(document.getElementById('stat-spd')?.value) || 60,
                spe: parseInt(document.getElementById('stat-spe')?.value) || 60
            };
            const types = [
                document.getElementById('fakemon-type1')?.value,
                document.getElementById('fakemon-type2')?.value
            ].filter(Boolean);
            const abilities = getAllAbilities();
            const abilityDetails = state.abilities.filter(a => a && a.name).map(a => {
                const sd = Object.values(state.sdAbilities || {}).find(v => v.name === a.name);
                return { name: a.name, desc: a.desc || a.description || sd?.desc || '' };
            });
            const moves = (state.learnset || []).filter(m => m && m.name).map(m => {
                const sd = getSdMoveByName(m.name);
                return {
                    ...m,
                    ...(sd || {}),
                    name: m.name,
                    type: m.type || sd?.type || 'Normal',
                    category: m.category || sd?.category || 'Status',
                    basePower: m.basePower ?? sd?.basePower ?? 0,
                    accuracy: m.accuracy ?? sd?.accuracy,
                    priority: m.priority ?? sd?.priority ?? 0,
                    flags: m.flags || sd?.flags || {},
                    desc: m.desc || sd?.desc || ''
                };
            });
            return { stats, types, abilities, abilityDetails, moves };
        }

        function sampleMoveKind(move) {
            const name = move.name;
            const lower = `${name} ${move.desc || ''}`.toLowerCase();
            const kinds = {
                setup: SAMPLE_SET_MOVE_TAGS.setup.has(name),
                defensiveSetup: SAMPLE_SET_MOVE_TAGS.defensiveSetup.has(name),
                recovery: SAMPLE_SET_MOVE_TAGS.recovery.has(name),
                hazard: SAMPLE_SET_MOVE_TAGS.hazards.has(name),
                removal: SAMPLE_SET_MOVE_TAGS.removal.has(name),
                pivot: SAMPLE_SET_MOVE_TAGS.pivot.has(name),
                speedControl: SAMPLE_SET_MOVE_TAGS.speedControl.has(name),
                disruption: SAMPLE_SET_MOVE_TAGS.disruption.has(name),
                screens: SAMPLE_SET_MOVE_TAGS.screens.has(name),
                selfKO: /^(Explosion|Self-Destruct|Misty Explosion|Final Gambit|Memento|Healing Wish|Lunar Dance)$/.test(name)
            };
            // Name/description fallback catches custom *status* recovery moves, but
            // deliberately avoids broad 'heal/regain' matching that can misclassify
            // offensive draining attacks as recovery.
            kinds.recovery ||= (move.category === 'Status' && /(?:recover|heals? the user|restores? the user's hp|restores? hp|regains? hp|fully restores? hp|wish|rest$)/.test(lower));
            kinds.setup ||= /raises? (its |the )?(attack|sp\\. attack|special attack|speed|defen|sp\\. def|all stats)|boosts? .*stat/.test(lower);
            kinds.hazard ||= /stealth rock|spikes|toxic spikes|sticky web/.test(lower);
            kinds.removal ||= /remove.*hazard|clear.*hazard|defog|rapid spin/.test(lower);
            kinds.pivot ||= /switch.*out|user.*switches|switches out/.test(lower) && move.category === 'Status';
            return kinds;
        }

        function sampleIsDamaging(move) {
            return move.category === 'Physical' || move.category === 'Special';
        }

        function sampleTypeEffectiveness(moveType, defenderType) {
            const chart = {
                Normal:{Rock:.5,Steel:.5,Ghost:0}, Fire:{Grass:2,Ice:2,Bug:2,Steel:2,Fire:.5,Water:.5,Rock:.5,Dragon:.5},
                Water:{Fire:2,Ground:2,Rock:2,Water:.5,Grass:.5,Dragon:.5}, Electric:{Water:2,Flying:2,Electric:.5,Grass:.5,Dragon:.5,Ground:0},
                Grass:{Water:2,Ground:2,Rock:2,Fire:.5,Grass:.5,Poison:.5,Flying:.5,Bug:.5,Dragon:.5,Steel:.5},
                Ice:{Grass:2,Ground:2,Flying:2,Dragon:2,Fire:.5,Water:.5,Ice:.5,Steel:.5},
                Fighting:{Normal:2,Ice:2,Rock:2,Dark:2,Steel:2,Poison:.5,Flying:.5,Psychic:.5,Bug:.5,Fairy:.5,Ghost:0},
                Poison:{Grass:2,Fairy:2,Poison:.5,Ground:.5,Rock:.5,Ghost:.5,Steel:0},
                Ground:{Fire:2,Electric:2,Poison:2,Rock:2,Steel:2,Grass:.5,Bug:.5,Flying:0},
                Flying:{Grass:2,Fighting:2,Bug:2,Electric:.5,Rock:.5,Steel:.5},
                Psychic:{Fighting:2,Poison:2,Psychic:.5,Steel:.5,Dark:0},
                Bug:{Grass:2,Psychic:2,Dark:2,Fire:.5,Fighting:.5,Poison:.5,Flying:.5,Ghost:.5,Steel:.5,Fairy:.5},
                Rock:{Fire:2,Ice:2,Flying:2,Bug:2,Fighting:.5,Ground:.5,Steel:.5},
                Ghost:{Psychic:2,Ghost:2,Dark:.5,Normal:0},
                Dragon:{Dragon:2,Steel:.5,Fairy:0},
                Dark:{Psychic:2,Ghost:2,Fighting:.5,Dark:.5,Fairy:.5},
                Steel:{Ice:2,Rock:2,Fairy:2,Fire:.5,Water:.5,Electric:.5,Steel:.5},
                Fairy:{Fighting:2,Dragon:2,Dark:2,Fire:.5,Poison:.5,Steel:.5}
            };
            return chart[moveType]?.[defenderType] ?? 1;
        }

        function sampleCoverageScore(move, types, chosen = []) {
            if (!sampleHasGoodCoverage(move, { types }, chosen)) return 0;
            let score = 0;
            const chosenDamaging = chosen.filter(sampleIsDamaging);
            const stabTypes = types;
            let meaningful = 0;
            for (const defender of SAMPLE_SET_COVERAGE_TYPES) {
                const stabBest = Math.max(...stabTypes.map(t => sampleTypeEffectiveness(t, defender)));
                const coverageMult = sampleTypeEffectiveness(move.type, defender);
                if (stabBest < 2 && coverageMult >= 2) meaningful++;
                if (stabBest < 1 && coverageMult >= 2) score += 4;
            }
            score += Math.min(18, meaningful * 4);
            if (chosenDamaging.some(m => m.type === move.type)) score -= 12;
            if (chosenDamaging.some(m => m.type !== move.type && !types.includes(m.type))) score += 2;
            return score;
        }

        function sampleRoleScores(profile) {
            const { stats, types, moves, abilities } = profile;
            const damaging = moves.filter(sampleIsDamaging);
            const physical = damaging.filter(m => m.category === 'Physical');
            const special = damaging.filter(m => m.category === 'Special');
            const setup = moves.filter(m => sampleMoveKind(m).setup);
            const defensiveSetup = moves.filter(m => sampleMoveKind(m).defensiveSetup);
            const recovery = moves.filter(m => sampleMoveKind(m).recovery);
            const hazards = moves.filter(m => sampleMoveKind(m).hazard);
            const removal = moves.filter(m => sampleMoveKind(m).removal);
            const pivot = moves.filter(m => sampleMoveKind(m).pivot);
            const utility = moves.filter(m => {
                const k = sampleMoveKind(m);
                return k.disruption || k.speedControl || k.screens || k.removal || k.hazard;
            });

            // Use the whole stat line, not isolated thresholds. This gives the role
            // scorer a much better picture of what the Fakemon actually wants to do.
            const physicalAdvantage = stats.atk - stats.spa;
            const specialAdvantage = stats.spa - stats.atk;
            const bulk = stats.hp + stats.def + stats.spd;
            const physicalBulk = stats.hp + stats.def;
            const specialBulk = stats.hp + stats.spd;
            const speed = stats.spe;
            const fast = speed >= 100;
            const veryFast = speed >= 115;
            const slow = speed <= 65;
            const hasPhysicalSTAB = physical.some(m => types.includes(m.type) && sampleMoveIsActuallyUseful(m));
            const hasSpecialSTAB = special.some(m => types.includes(m.type) && sampleMoveIsActuallyUseful(m));
            const goodPhysical = physical.filter(sampleMoveIsActuallyUseful);
            const goodSpecial = special.filter(sampleMoveIsActuallyUseful);
            const abilityText = abilities.join(' ').toLowerCase();

            const scores = {
                physicalSweeper: 0, specialSweeper: 0, wallbreaker: 0,
                bulkyAttacker: 0, defensive: 0, support: 0, pivot: 0,
                setupSweeper: 0, hazard: 0
            };

            // Offensive profile: reward both the stat and the existence of genuinely
            // usable attacks of that category. A 120 Atk stat with only bad moves should
            // not beat a 105 SpA stat with a great movepool.
            scores.physicalSweeper += Math.max(0, physicalAdvantage) * 0.55 + Math.max(0, stats.atk - 80) * 0.7;
            scores.specialSweeper += Math.max(0, specialAdvantage) * 0.55 + Math.max(0, stats.spa - 80) * 0.7;
            scores.physicalSweeper += goodPhysical.length * 7 + (hasPhysicalSTAB ? 12 : 0);
            scores.specialSweeper += goodSpecial.length * 7 + (hasSpecialSTAB ? 12 : 0);
            scores.wallbreaker += Math.max(0, stats.atk - 90) * 0.55 + Math.max(0, stats.spa - 90) * 0.55;
            scores.wallbreaker += (goodPhysical.length + goodSpecial.length) * 3;
            scores.wallbreaker += damaging.filter(m => (m.basePower || 0) >= 100 && sampleMoveIsActuallyUseful(m)).length * 7;

            // Speed is meaningful only when the offensive profile can capitalize on it.
            if (fast) {
                scores.physicalSweeper += hasPhysicalSTAB ? 10 : 3;
                scores.specialSweeper += hasSpecialSTAB ? 10 : 3;
                scores.pivot += 6;
            }
            if (veryFast) {
                scores.physicalSweeper += 7;
                scores.specialSweeper += 7;
                scores.pivot += 8;
            }
            if (slow) {
                scores.bulkyAttacker += 7;
                scores.wallbreaker += 5;
            }

            // Bulk is relative to offensive stats. High bulk + high offense points to a
            // bulky attacker; high bulk without offensive tools points to defense/support.
            scores.bulkyAttacker += Math.max(0, bulk - 250) * 0.22;
            scores.bulkyAttacker += Math.max(0, Math.max(stats.atk, stats.spa) - 95) * 0.45;
            scores.bulkyAttacker += recovery.length * 9;
            scores.defensive += Math.max(0, physicalBulk - 155) * 0.35;
            scores.defensive += Math.max(0, specialBulk - 155) * 0.35;
            scores.defensive += recovery.length * 24;
            scores.defensive += utility.length * 5;
            scores.support += utility.length * 12 + recovery.length * 10;
            scores.support += Math.max(0, bulk - 240) * 0.15;

            // Recovery is a major role signal. This prevents a bulky mon with Moonlight /
            // Synthesis / Recover from being treated as a pure sweeper just because its
            // Attack stat is high.
            if (recovery.length) {
                if (physicalBulk >= 170 || specialBulk >= 170) scores.defensive += 18;
                if (bulk >= 270) scores.bulkyAttacker += 10;
            }

            scores.pivot += pivot.length * 30 + Math.max(0, stats.spe - 70) * 0.35 + utility.length * 2;
            scores.setupSweeper += setup.length * 30 + Math.max(0, stats.spe - 75) * 0.45;
            scores.defensive += defensiveSetup.length * 8;
            scores.bulkyAttacker += defensiveSetup.length * 4;
            scores.hazard += hazards.length * 34 + removal.length * 20 + utility.length * 3;

            if (stats.atk >= 110 && hasPhysicalSTAB) scores.physicalSweeper += 10;
            if (stats.spa >= 110 && hasSpecialSTAB) scores.specialSweeper += 10;
            if (stats.hp >= 100 && (stats.def >= 100 || stats.spd >= 100)) scores.defensive += 10;
            if (types.length === 2) scores.bulkyAttacker += 2;

            // Ability synergy is still a nudge, but now uses the role's actual stat profile.
            if (/huge power|pure power|technician|guts|moxie|adaptability|strong jaw|iron fist/.test(abilityText)) {
                scores.physicalSweeper += Math.max(0, physicalAdvantage) >= 0 ? 10 : 2;
                scores.bulkyAttacker += Math.max(0, physicalBulk - 160) * 0.08;
            }
            if (/analytic|sheer force|competitive|mega launcher|solar power|torrent|blaze/.test(abilityText)) {
                scores.specialSweeper += Math.max(0, specialAdvantage) >= 0 ? 10 : 2;
            }
            if (/regenerator|natural cure|magic guard|multiscale|filter|unaware|levitate|flame body|water absorb|volt absorb/.test(abilityText)) {
                scores.defensive += 12;
                scores.bulkyAttacker += 5;
            }
            if (/prankster|magic bounce/.test(abilityText)) scores.support += 14;

            return scores;
        }

        function sampleRoleMoveRequirements(role) {
            return {
                physicalSweeper: { attack: 'Physical', require: 'damaging', preferSetup: true, preferSpeed: true },
                specialSweeper: { attack: 'Special', require: 'damaging', preferSetup: true, preferSpeed: true },
                wallbreaker: { attack: 'either', require: 'damaging', preferPower: true },
                bulkyAttacker: { attack: 'either', require: 'damaging', preferRecovery: true },
                defensive: { attack: 'either', require: 'utility', preferRecovery: true },
                support: { attack: 'either', require: 'utility', preferRecovery: true },
                pivot: { attack: 'either', require: 'pivot', preferSpeed: true },
                setupSweeper: { attack: 'either', require: 'damaging', preferSetup: true, preferSpeed: true },
                hazard: { attack: 'either', require: 'utility', preferHazard: true }
            }[role];
        }

        function sampleAbilityScore(move, profile, role) {
            const abilityNames = profile.abilityDetails?.map(a => a.name) || profile.abilities || [];
            const text = abilityNames.join(' ').toLowerCase();
            const name = move.name.toLowerCase();
            let score = 0;
            if (/technician/.test(text) && move.basePower <= 60 && sampleIsDamaging(move)) score += 18;
            if (/adaptability/.test(text) && profile.types.includes(move.type)) score += 16;
            if (/sheer force/.test(text) && sampleIsDamaging(move) && /secondary|chance|flinch|lower|raise/.test(move.desc || '')) score += 10;
            if (/moxie/.test(text) && sampleIsDamaging(move)) score += 7;
            if (/guts/.test(text) && move.category === 'Physical') score += 7;
            if (/iron fist/.test(text) && /punch/.test(name)) score += 10;
            if (/strong jaw/.test(text) && /fang|bite/.test(name)) score += 10;
            if (/mega launcher/.test(text) && /pulse/.test(name)) score += 10;
            if (/pixilate|refrigerate|galvanize|aerilate/.test(text) && move.type === 'Normal') score += 12;
            if (/prankster/.test(text) && move.category === 'Status') score += 9;
            if (/serene grace/.test(text) && sampleIsDamaging(move)) score += 5;
            return score;
        }

        function sampleAbilityFitScore(ability, profile, role, chosenMoves = []) {
            const name = String(ability.name || ability || '');
            const desc = String(ability.desc || ability.description || '').toLowerCase();
            const n = name.toLowerCase();
            const s = profile.stats;
            const moveNames = profile.moves.map(m => m.name.toLowerCase());
            const has = (...names) => names.some(x => moveNames.includes(x.toLowerCase()));
            let score = 0;
            const offensive = ['physicalSweeper','specialSweeper','wallbreaker','setupSweeper'].includes(role);
            const bulky = ['bulkyAttacker','defensive','support','pivot','hazard'].includes(role);

            // Directly match common competitive ability archetypes to the Fakemon's actual data.
            if (/huge power|pure power/.test(n)) score += s.atk >= s.spa ? 28 : 6;
            if (/guts/.test(n)) score += offensive && s.atk >= s.spa ? 22 : 4;
            if (/moxie|beast boost/.test(n)) score += offensive && (s.atk >= 95 || s.spa >= 95) ? 20 : 5;
            if (/adaptability/.test(n)) score += profile.types.length ? 18 : 4;
            if (/technician/.test(n)) score += profile.moves.some(m => sampleIsDamaging(m) && m.basePower <= 60) ? 20 : -2;
            if (/tinted lens/.test(n)) score += profile.moves.some(m => sampleIsDamaging(m) && !profile.types.includes(m.type)) ? 18 : 4;
            if (/sheer force/.test(n)) score += profile.moves.some(m => sampleIsDamaging(m) && /secondary|chance|flinch|lower|raise/.test(m.desc || '')) ? 22 : 2;
            if (/strong jaw/.test(n)) score += profile.moves.some(m => /fang|bite/i.test(m.name)) ? 20 : 0;
            if (/iron fist/.test(n)) score += profile.moves.some(m => /punch/i.test(m.name)) ? 20 : 0;
            if (/sharpness/.test(n)) score += profile.moves.some(m => /slash|blade|sword|cut/i.test(m.name)) ? 20 : 0;
            if (/mega launcher/.test(n)) score += profile.moves.some(m => /pulse/i.test(m.name)) ? 20 : 0;
            if (/contrary/.test(n)) score += profile.moves.some(m => /lower|drop|v-create|leaf storm|superpower|overheat/i.test(m.name + ' ' + (m.desc || ''))) ? 28 : -4;
            if (/speed boost/.test(n)) score += offensive && s.spe >= 70 ? 22 : 4;
            if (/clear body|white smoke/.test(n)) score += bulky ? 10 : 4;
            if (/intimidate/.test(n)) score += bulky && s.def >= s.spd ? 24 : 8;
            if (/fur coat/.test(n)) score += s.def >= 95 ? 26 : 4;
            if (/ice scales/.test(n)) score += s.spd >= 95 ? 26 : 4;
            if (/unaware/.test(n)) score += bulky ? 25 : 5;
            if (/regenerator/.test(n)) score += bulky ? 28 : 8;
            if (/magic guard/.test(n)) score += bulky || offensive ? 20 : 6;
            if (/multiscale|shadow shield/.test(n)) score += s.hp >= 80 && (s.def >= 80 || s.spd >= 80) ? 24 : 4;
            if (/sturdy/.test(n)) score += bulky ? 10 : 5;
            if (/levitate/.test(n)) score += profile.types.includes('Ground') ? 24 : 12;
            if (/water absorb|storm drain/.test(n)) score += bulky && profile.types.includes('Water') ? 24 : 14;
            if (/volt absorb|motor drive/.test(n)) score += bulky && profile.types.includes('Electric') ? 24 : 14;
            if (/flash fire/.test(n)) score += profile.types.includes('Fire') ? 18 : 14;
            if (/thick fat|heatproof|fluffy/.test(n)) score += bulky ? 20 : 10;
            if (/poison heal/.test(n)) score += bulky && has('Protect','Substitute') ? 30 : 20;
            if (/magic bounce/.test(n)) score += bulky || role === 'support' ? 28 : 12;
            if (/prankster/.test(n)) score += profile.moves.some(m => m.category === 'Status') ? 24 : 2;
            if (/unburden/.test(n)) score += offensive && s.spe < 100 ? 22 : 8;
            if (/competitive|defiant/.test(n)) score += offensive ? 16 : 5;
            if (/solar power/.test(n)) score += profile.types.includes('Fire') || profile.moves.some(m => /sun|solar/i.test(m.desc || '')) ? 18 : 2;
            if (/swift swim|chlorophyll|slush rush|sand rush/.test(n)) score += offensive && s.spe >= 70 ? 18 : 6;

            // Ability/move interaction must be evaluated against the moves that will
            // actually be on the generated set, not merely anything in the full learnset.
            // This is especially important for Contrary: Swords Dance + Contrary is
            // actively counter-synergistic, while V-create/Superpower/Leaf Storm/etc.
            // can make Contrary excellent when their stat drops are part of the set.
            const chosen = chosenMoves || [];
            const chosenNames = chosen.map(m => String(m.name || '').toLowerCase());
            const chosenText = chosen.map(m => `${m.name} ${m.desc || ''}`).join(' ').toLowerCase();
            const hasChosen = (...names) => names.some(x => chosenNames.includes(String(x).toLowerCase()));
            const hasSelfDropMove = /(?:v-create|superpower|close combat|leaf storm|overheat|draco meteor|make it rain|psychic noise)/.test(chosenText)
                || chosen.some(m => /(?:lowers|lowered|drop|drops).*(?:user|its|attack|defen|sp\. atk|sp\. def|speed)/i.test(String(m.desc || '')));
            const hasDirectRaise = chosen.some(m => /(?:raises|boosts).*(?:user|its).*(?:attack|defen|sp\. atk|sp\. def|speed|stats)/i.test(String(m.desc || '')))
                || hasChosen('Swords Dance','Nasty Plot','Calm Mind','Iron Defense','Amnesia','Acid Armor','Cotton Guard','Bulk Up','Dragon Dance','Quiver Dance','Coil','Curse','Shell Smash','Rock Polish','Agility','Autotomize');

            if (/contrary/.test(n)) {
                if (hasSelfDropMove) score += 42;
                else score -= 28;
                if (hasDirectRaise) score -= 55;
                if (hasChosen('Swords Dance','Nasty Plot','Calm Mind','Iron Defense','Amnesia','Acid Armor','Cotton Guard','Bulk Up','Dragon Dance','Quiver Dance','Coil','Curse','Shell Smash','Rock Polish','Agility','Autotomize')) score -= 70;
            }
            if (/simple/.test(n)) {
                score += hasDirectRaise ? 28 : -8;
                if (hasSelfDropMove) score -= 35;
            }
            if (/defiant|competitive/.test(n)) {
                score += chosen.some(m => /lower|drop/i.test(String(m.desc || ''))) ? 24 : 0;
            }
            if (/sheer force/.test(n)) {
                score += chosen.some(m => sampleIsDamaging(m) && /chance|flinch|lower|raise|secondary/i.test(String(m.desc || ''))) ? 28 : -6;
            }
            if (/technician/.test(n)) {
                score += chosen.some(m => sampleIsDamaging(m) && (m.basePower || 0) <= 60) ? 30 : -8;
            }
            if (/strong jaw/.test(n)) score += chosen.some(m => /fang|bite/i.test(m.name)) ? 28 : -8;
            if (/iron fist/.test(n)) score += chosen.some(m => /punch/i.test(m.name)) ? 28 : -8;
            if (/mega launcher/.test(n)) score += chosen.some(m => /pulse/i.test(m.name)) ? 28 : -8;
            if (/sharpness/.test(n)) score += chosen.some(m => /slash|blade|sword|cut/i.test(m.name)) ? 28 : -8;
            if (/moxie|beast boost/.test(n)) score += chosen.some(sampleIsDamaging) ? 10 : -8;
            if (/regenerator/.test(n)) score += ['pivot','defensive','support','bulkyAttacker'].includes(role) ? 18 : 2;
            if (/unaware/.test(n)) score += ['defensive','support'].includes(role) ? 18 : -4;

            // Use the actual description as a final semantic-ish deterministic signal.
            if (bulky && /damage|power|attack|defense|special defense|speed|status|heal|recover|switch/.test(desc)) score += 2;
            if (offensive && /attack|special attack|damage|power|speed/.test(desc)) score += 2;
            return score;
        }

        function sampleRoleAttackCategory(profile, role) {
            const s = profile.stats;
            if (role === 'physicalSweeper' || role === 'setupSweeper') return s.atk >= s.spa ? 'Physical' : 'Special';
            if (role === 'specialSweeper') return 'Special';
            if (role === 'wallbreaker' || role === 'bulkyAttacker' || role === 'pivot') return s.atk >= s.spa ? 'Physical' : 'Special';
            return 'either';
        }

        function sampleSetupFitsRole(move, profile, role) {
            const moveKind = sampleMoveKind(move);
            if (moveKind.defensiveSetup) return false;
            if (!moveKind.setup) return true;
            const n = move.name.toLowerCase();
            const physicalSetup = /swords dance|bulk up|dragon dance|coil|hone claws|shift gear|victory dance|curse/.test(n);
            const specialSetup = /nasty plot|calm mind|quiver dance|tail glow|growth/.test(n);
            const speedSetup = /agility|rock polish|autotomize/.test(n);
            const category = sampleRoleAttackCategory(profile, role);
            if (category === 'Physical' && specialSetup && !speedSetup) return false;
            if (category === 'Special' && physicalSetup && !speedSetup) return false;
            return true;
        }

        function sampleMoveCompatibleWithRole(move, profile, role) {
            // A damaging move must use the offensive category the set is built around.
            // This is a hard compatibility rule: it prevents things like Eruption from
            // appearing on a physical sweeper simply because its raw BP is high.
            if (sampleIsDamaging(move)) {
                const category = sampleRoleAttackCategory(profile, role);
                if (category !== 'either' && move.category !== category) return false;
            }
            if (!sampleSetupFitsRole(move, profile, role)) return false;
            return true;
        }

        function sampleCompetitiveUsefulness(move) {
            const weights = state.sdMoveUsefulness || {};
            const exact = weights[move.name];
            if (exact != null) return exact;
            // Custom/Fakemon moves are not in Smogon data. Give them a neutral baseline
            // and let the local role/coverage/ability rules decide their value.
            return 1;
        }

        // Hard blacklist for sample-set generation. These moves are legal, but are
        // deliberately never allowed to enter an automatically generated sample set.
        // This prevents the final-slot fallback from turning into generic low-value
        // utility just because the Fakemon happens to learn it.
        const SAMPLE_SET_BANNED_MOVES = new Set([
            'Safeguard', 'Mist', 'Lucky Chant', 'Sweet Scent', 'Odor Sleuth', 'Foresight',
            'Flash', 'Sand Attack', 'Smokescreen', 'Kinesis', 'Mud-Slap', 'Tail Whip',
            'Growl', 'Leer', 'String Shot', 'Scary Face', 'Baby-Doll Eyes', 'Play Nice',
            'Tickle', 'Noble Roar', 'Screech', 'Fake Tears', 'Metal Sound',
            'Sweet Scent', 'Defog'
        ]);

        function sampleMoveIsBanned(move) {
            if (!move || !move.name) return true;
            // One hard gate for all permanently banned sample-set moves.
            if (SAMPLE_SET_BANNED_MOVES.has(move.name)) return true;
            if (SAMPLE_SET_BAD_DEFAULT_MOVES.has(move.name)) return true;
            if (SAMPLE_SET_LOW_VALUE_UTILITY_MOVES.has(move.name)) return true;
            return false;
        }

        function sampleMoveIsActuallyUseful(move, profile = null, role = null) {
            if (!move || !move.name) return false;
            if (sampleMoveIsBanned(move)) return false;
            if (SAMPLE_SET_BAD_DEFAULT_MOVES.has(move.name)) return false;
            if (SAMPLE_SET_SELF_KO_MOVES.has(move.name)) return false;
            const kind = sampleMoveKind(move);
            if (kind.hazard || kind.removal || kind.pivot || kind.setup || kind.defensiveSetup || kind.disruption || kind.speedControl || kind.screens) return true;
            // Only status moves with explicit recovery semantics count as recovery.
            if (kind.recovery && move.category === 'Status') return true;
            if (!sampleIsDamaging(move)) return false;
            const bp = Number(move.basePower || 0);
            const usefulness = sampleCompetitiveUsefulness(move);
            const accuracy = move.accuracy === true || move.accuracy == null || Number(move.accuracy) >= 75;
            // Usage is a preference, not a legality/usefulness gate. Strong/signature
            // attacks such as V-create and Gigaton Hammer must remain viable even when
            // they have little or no ladder usage history.
            if (!accuracy) return (SAMPLE_SET_PREMIUM_ATTACKS.has(move.name) && bp >= 100 && Number(move.accuracy) >= 65) || (bp >= 120 && Number(move.accuracy) >= 65);
            if (SAMPLE_SET_PREMIUM_ATTACKS.has(move.name) && bp >= 90) return true;
            if (bp >= 120) return true;
            if (bp >= 100) return true;
            if (bp >= 80 && usefulness >= 1.05) return true;
            return bp >= 60 && usefulness >= 2.0;
        }

        function sampleHasGoodCoverage(move, profile, chosen) {
            if (!sampleIsDamaging(move) || profile.types.includes(move.type)) return false;
            if (!sampleMoveIsActuallyUseful(move)) return false;
            const chosenGood = chosen.filter(sampleMoveIsActuallyUseful);
            const stabTypes = profile.types;
            let best = 1;
            for (const defender of SAMPLE_SET_COVERAGE_TYPES) {
                const stabBest = Math.max(...stabTypes.map(t => sampleTypeEffectiveness(t, defender)));
                const cov = sampleTypeEffectiveness(move.type, defender);
                if (stabBest < 2 && cov >= 2) best = Math.max(best, cov);
            }
            // Don't call a coverage move "coverage" if it merely adds another neutral hit.
            if (best < 2) return false;
            if (chosenGood.some(m => !profile.types.includes(m.type) && m.type === move.type)) return false;
            return true;
        }

        function sampleMoveScore(move, profile, role, chosen) {
            const { stats, types } = profile;
            const kind = sampleMoveKind(move);
            const req = sampleRoleMoveRequirements(role);
            let score = 0;

            if (!sampleMoveCompatibleWithRole(move, profile, role)) return -10000;
            if (SAMPLE_SET_BAD_DEFAULT_MOVES.has(move.name)) return -9000;
            if (kind.selfKO) return -8500;

            const usefulness = sampleCompetitiveUsefulness(move);
            score += usefulness * SAMPLE_SET_CONFIG.move.usefulness;
            if (!sampleIsDamaging(move) && !kind.recovery && !kind.hazard && !kind.removal && !kind.pivot && !kind.disruption && !kind.speedControl && !kind.screens && !kind.setup && !kind.defensiveSetup) score -= 40;

            if (sampleIsDamaging(move)) {
                if (types.includes(move.type)) score += SAMPLE_SET_CONFIG.move.stab;
                // Coverage is a bonus only when it is genuinely good. It is never a
                // requirement, so a mediocre coverage move cannot beat a useful STAB,
                // recovery, setup, or utility move just because it is super effective.
                score += sampleCoverageScore(move, types, chosen);
                // Strong attacks deserve to compete on their actual combat value, not
                // merely on usage frequency. This is especially important for legal
                // Fakemon movepools containing moves such as V-create or Gigaton Hammer.
                score += Math.min(10, (move.basePower || 0) * 0.05);
                if (SAMPLE_SET_PREMIUM_ATTACKS.has(move.name)) score += 12;
                if ((move.basePower || 0) >= 120 && (move.accuracy === true || move.accuracy == null || Number(move.accuracy) >= 80)) score += 8;
                if (move.accuracy === true || move.accuracy === undefined) score += SAMPLE_SET_CONFIG.move.accuracy;
                else if (typeof move.accuracy === 'number') score += (move.accuracy / 100) * SAMPLE_SET_CONFIG.move.accuracy;
                if (move.priority > 0) score += SAMPLE_SET_CONFIG.move.priority;
                if (req.attack === move.category) score += 15;
                if (!sampleMoveIsActuallyUseful(move)) score -= 25;
                if ((move.basePower || 0) < 60) score -= SAMPLE_SET_CONFIG.move.lowPowerPenalty;
            }

            // Stat-aware offensive fit. The same move is worth more when it matches the
            // Fakemon's genuinely superior attacking stat.
            if (sampleIsDamaging(move)) {
                if (move.category === 'Physical') score += Math.max(-4, Math.min(12, (stats.atk - stats.spa) * 0.18));
                if (move.category === 'Special') score += Math.max(-4, Math.min(12, (stats.spa - stats.atk) * 0.18));
            }

            if (kind.setup) score += req.preferSetup ? SAMPLE_SET_CONFIG.move.setup : -12;
            if (kind.recovery) {
                score += req.preferRecovery ? SAMPLE_SET_CONFIG.move.recovery : (role === 'physicalSweeper' || role === 'specialSweeper' || role === 'wallbreaker' ? -5 : 8);
                if (['defensive','support','hazard','bulkyAttacker'].includes(role)) score += 18;
            }
            if (kind.hazard) score += req.preferHazard ? SAMPLE_SET_CONFIG.move.hazard : (['defensive','support','hazard'].includes(role) ? 10 : -4);
            if (kind.removal) score += ['defensive','support','pivot','hazard'].includes(role) ? SAMPLE_SET_CONFIG.move.removal : 2;
            if (kind.pivot) score += role === 'pivot' ? SAMPLE_SET_CONFIG.move.pivot : 3;
            if (kind.speedControl) score += ['support','pivot'].includes(role) ? SAMPLE_SET_CONFIG.move.speedControl : 1;
            if (kind.disruption) score += ['support','defensive','pivot'].includes(role) ? SAMPLE_SET_CONFIG.move.disruption : 2;
            if (kind.screens) score += role === 'support' ? 16 : -6;
            score += sampleAbilityScore(move, profile, role);

            // Defensive roles should not spend slots on four attacks if they have real
            // longevity/utility available.
            if (['defensive','support','hazard'].includes(role) && sampleIsDamaging(move)) score -= 4;
            if (role === 'bulkyAttacker' && sampleIsDamaging(move)) score += 3;

            chosen.forEach(other => {
                const ok = sampleMoveKind(other);
                if (sampleIsDamaging(move) && sampleIsDamaging(other)) {
                    if (move.type === other.type) score -= types.includes(move.type) ? 8 : SAMPLE_SET_CONFIG.move.redundantTypePenalty;
                    if (move.category === other.category && !types.includes(move.type)) score -= 6;
                }
                if (kind.setup && ok.setup) score -= SAMPLE_SET_CONFIG.move.redundantRolePenalty;
                if (kind.recovery && ok.recovery) score -= SAMPLE_SET_CONFIG.move.redundantRolePenalty * 2;
                if (kind.hazard && ok.hazard) score -= SAMPLE_SET_CONFIG.move.redundantRolePenalty * 2;
                if (kind.removal && ok.removal) score -= SAMPLE_SET_CONFIG.move.redundantRolePenalty * 2;
                if (kind.pivot && ok.pivot) score -= SAMPLE_SET_CONFIG.move.redundantRolePenalty;
            });

            return score;
        }

        function samplePickMoves(profile, role, seed) {
            const rng = sampleSetRng(seed);
            const compatible = profile.moves.filter(m => m.name && !sampleMoveIsBanned(m) && sampleMoveCompatibleWithRole(m, profile, role));
            const clean = compatible.filter(m => !SAMPLE_SET_SELF_KO_MOVES.has(m.name) && !SAMPLE_SET_BAD_DEFAULT_MOVES.has(m.name));
            const usable = clean.length >= 4 ? clean : compatible.filter(m => !SAMPLE_SET_SELF_KO_MOVES.has(m.name));
            if (usable.length < 4) return [];
            const chosen = [];
            const pickBest = (pool, mandatory=false) => {
                const candidates = pool.filter(m => !chosen.some(c => c.name === m.name)).map(m => ({move:m,score:sampleMoveScore(m,profile,role,chosen)+rng()*0.0001})).sort((a,b)=>b.score-a.score||a.move.name.localeCompare(b.move.name));
                if (!candidates.length) return null;
                if (mandatory) { chosen.push(candidates[0].move); return candidates[0].move; }
                const top = candidates.slice(0, Math.min(3,candidates.length));
                const pick = top[Math.floor(rng()*top.length)].move; chosen.push(pick); return pick;
            };
            const defensiveRole=['defensive','support','hazard'].includes(role), bulkyRole=role==='bulkyAttacker';
            const offensiveRole=['physicalSweeper','specialSweeper','setupSweeper','wallbreaker','bulkyAttacker'].includes(role);
            const useful=m=>sampleMoveIsActuallyUseful(m,profile,role);
            const attacks=usable.filter(m=>sampleIsDamaging(m)&&useful(m));
            const goodStabs=attacks.filter(m=>profile.types.includes(m.type));
            const goodCoverage=attacks.filter(m=>!profile.types.includes(m.type)&&sampleHasGoodCoverage(m,profile,chosen));
            const recovery=usable.filter(m=>sampleMoveKind(m).recovery && m.category === 'Status' && !sampleIsDamaging(m));
            const setup=usable.filter(m=>sampleMoveKind(m).setup&&sampleSetupFitsRole(m,profile,role));
            const hazards=usable.filter(m=>sampleMoveKind(m).hazard);
            const removal=usable.filter(m=>sampleMoveKind(m).removal);
            const pivot=usable.filter(m=>sampleMoveKind(m).pivot);
            const realUtility=usable.filter(m=>{const k=sampleMoveKind(m);return k.hazard||k.removal||k.pivot||k.disruption||k.speedControl||k.screens;});

            // Defensive sets: recovery is a structural slot, and at least one genuinely
            // useful attack is preferred. Draining attacks are not recovery for this purpose.
            if (defensiveRole || bulkyRole) {
                if (recovery.length) pickBest(recovery, true);
                if (goodStabs.length) pickBest(goodStabs, true);
                if (role==='hazard' && hazards.length) pickBest(hazards, true);
                else if (role==='pivot' && pivot.length) pickBest(pivot, true);
                else if (removal.length) pickBest(removal, true);
            }
            if (['physicalSweeper','specialSweeper','setupSweeper'].includes(role) && setup.length) pickBest(setup, true);
            if (offensiveRole && !chosen.some(sampleIsDamaging)) {
                if (goodStabs.length) pickBest(goodStabs, true);
            }
            // Prefer a second distinct STAB before coverage when it is actually good.
            const firstStabType = chosen.find(m=>sampleIsDamaging(m)&&profile.types.includes(m.type))?.type;
            const secondStab = goodStabs.filter(m=>m.type!==firstStabType);
            if (offensiveRole && secondStab.length && chosen.length<4) pickBest(secondStab);
            // Coverage is optional: only use a genuinely good coverage move when one exists.
            if (offensiveRole && goodCoverage.length && chosen.length<4) pickBest(goodCoverage);

            while(chosen.length<4){
                const remaining=usable.filter(m=>!chosen.some(c=>c.name===m.name));
                if(!remaining.length) break;
                const pool = remaining.filter(m => {
                    const k=sampleMoveKind(m);
                    if (sampleIsDamaging(m)) return useful(m);
                    // Only genuinely role-relevant status moves may fill a slot.
                    // Do not fall back to arbitrary legal utility such as Safeguard.
                    return k.hazard||k.removal||k.pivot||k.disruption||k.speedControl||k.screens||k.setup||k.defensiveSetup || (k.recovery && m.category==='Status');
                });
                if (!pool.length) break;
                const candidates=pool.map(m=>{
                    let score=sampleMoveScore(m,profile,role,chosen);
                    if (sampleIsDamaging(m) && !profile.types.includes(m.type) && !sampleHasGoodCoverage(m,profile,chosen)) score-=18;
                    if (!sampleIsDamaging(m) && !sampleMoveKind(m).recovery && ['physicalSweeper','specialSweeper','wallbreaker','bulkyAttacker'].includes(role)) score-=22;
                    if (defensiveRole && sampleIsDamaging(m) && chosen.some(c=>sampleIsDamaging(c))) score+=6;
                    return {move:m,score:score+rng()*0.0001};
                }).sort((a,b)=>b.score-a.score||a.move.name.localeCompare(b.move.name));
                if(!candidates.length) break;
                chosen.push(candidates[0].move);
            }
            return chosen.length===4?chosen:[];
        }

        function generateParametricSampleSet(profile, seed) {
            const def=profile.moves.find(m=>['Iron Defense','Cotton Guard','Acid Armor'].includes(m.name));
            const body=profile.moves.find(m=>m.name==='Body Press');
            if(!def||!body||profile.stats.def<95) return null;
            const pool=[def,body];
            const recovery=profile.moves.filter(m=>!sampleMoveIsBanned(m)&&sampleMoveKind(m).recovery && m.category === 'Status' && !sampleIsDamaging(m));
            const coverage=profile.moves.filter(m=>!sampleMoveIsBanned(m)&&sampleIsDamaging(m)&&!profile.types.includes(m.type)&&sampleHasGoodCoverage(m,profile,pool));
            const stab=profile.moves.filter(m=>!sampleMoveIsBanned(m)&&sampleIsDamaging(m)&&profile.types.includes(m.type)&&sampleMoveIsActuallyUseful(m));
            const utility=profile.moves.filter(m=>!sampleMoveIsBanned(m)&&sampleMoveIsActuallyUseful(m,profile,'defensive')&&(()=>{const k=sampleMoveKind(m);return k.hazard||k.removal||k.disruption||k.pivot;})());
            const third=recovery[0]||coverage[0]||stab[0]||utility[0]; if(third&&!pool.includes(third)) pool.push(third);
            const fourth=coverage.find(m=>!pool.includes(m))||stab.find(m=>!pool.includes(m))||utility.find(m=>!pool.includes(m)); if(fourth) pool.push(fourth);
            if(pool.length!==4) return null;
            const ability = sampleChooseAbility(profile, 'defensive', pool);
            return {name:`${def.name} + Body Press`,role:'Defensive Setup',item:'Leftovers',ability,nature:'Bold',evs:{hp:252,atk:0,def:252,spa:0,spd:4,spe:0},ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},moves:pool.map(m=>m.name),teraType:profile.types.includes('Fighting')?'Fighting':(profile.types[0]||'Fighting'),level:100};
        }

        function sampleChooseNatureEVs(profile, role) {
            const s = profile.stats;
            const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
            const physical = s.atk >= s.spa;
            const fast = s.spe >= 95;
            const veryFast = s.spe >= 110;
            let nature = 'Hardy';

            if (role === 'physicalSweeper' || role === 'setupSweeper') {
                evs.atk = 252; evs.spe = 252; evs.hp = 4;
                nature = fast ? 'Jolly' : 'Adamant';
            } else if (role === 'specialSweeper') {
                evs.spa = 252; evs.spe = 252; evs.hp = 4;
                nature = fast ? 'Timid' : 'Modest';
            } else if (role === 'wallbreaker') {
                const key = physical ? 'atk' : 'spa';
                evs[key] = 252;
                if (s.spe >= 80) { evs.spe = 252; evs.hp = 4; }
                else { evs.hp = 252; evs.spe = 4; }
                nature = key === 'atk' ? (s.spe >= 80 ? 'Jolly' : 'Adamant') : (s.spe >= 80 ? 'Timid' : 'Modest');
            } else if (role === 'bulkyAttacker') {
                const key = physical ? 'atk' : 'spa';
                evs.hp = 252;
                evs[key] = 252;
                evs[ s.def >= s.spd ? 'def' : 'spd' ] = 4;
                // Don't waste a nature on Speed unless the base Speed is high enough
                // for the Fakemon to realistically use it as an offensive stat.
                nature = key === 'atk' ? 'Adamant' : 'Modest';
            } else if (role === 'defensive') {
                evs.hp = 252;
                if (s.def >= s.spd) { evs.def = 252; evs.spd = 4; nature = 'Bold'; }
                else { evs.spd = 252; evs.def = 4; nature = 'Calm'; }
            } else if (role === 'support') {
                evs.hp = 252;
                if (veryFast) { evs.spe = 252; evs.def = 4; nature = 'Timid'; }
                else if (s.def >= s.spd) { evs.def = 252; evs.spd = 4; nature = 'Bold'; }
                else { evs.spd = 252; evs.def = 4; nature = 'Calm'; }
            } else if (role === 'pivot') {
                const key = physical ? 'atk' : 'spa';
                evs.spe = 252;
                evs[key] = 252;
                evs.hp = 4;
                nature = key === 'atk' ? 'Jolly' : 'Timid';
            } else if (role === 'hazard') {
                evs.hp = 252;
                if (s.def >= s.spd) { evs.def = 252; evs.spd = 4; nature = 'Impish'; }
                else { evs.spd = 252; evs.def = 4; nature = 'Careful'; }
            }

            return { evs, nature };
        }

        function sampleChooseAbility(profile, role, chosenMoves = []) {
            const abilities = profile.abilityDetails?.length ? profile.abilityDetails : profile.abilities.map(name => ({name, desc:''}));
            if (!abilities.length) return '';
            const scored = abilities.map((ability, index) => ({
                name: ability.name,
                score: sampleAbilityFitScore(ability, profile, role, chosenMoves) - index * 0.001
            })).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
            return scored[0].name;
        }

        function hasHazardWeakness(types) {
            // Stealth Rock is the main reason Boots matter in singles. Rock weakness
            // (especially 2x/4x) is a meaningful signal; otherwise longevity items win.
            if (!types.length) return false;
            let mult = 1;
            for (const t of types) mult *= sampleTypeEffectiveness('Rock', t);
            return mult > 1;
        }

        function sampleChooseItem(profile, role, chosenMoves, chosenAbility = '') {
            const moves = chosenMoves || profile.moves;
            const kinds = moves.map(sampleMoveKind);
            const hasSetup = kinds.some(k => k.setup);
            const hasRecovery = kinds.some(k => k.recovery);
            const hasPivot = kinds.some(k => k.pivot);
            const hasHazard = kinds.some(k => k.hazard);
            const hasRemoval = kinds.some(k => k.removal);
            const hasStatus = moves.some(m => m.category === 'Status');
            const abilityText = (chosenAbility || profile.abilities.join(' ')).toLowerCase();
            const physical = sampleRoleAttackCategory(profile, role) === 'Physical';
            const fast = profile.stats.spe >= 95;
            const bulky = profile.stats.hp + profile.stats.def + profile.stats.spd >= 265;
            const rockWeak = hasHazardWeakness(profile.types);

            if (/guts/.test(abilityText) && !['defensive','support','hazard'].includes(role)) return 'Flame Orb';
            if (/magic guard/.test(abilityText) && ['physicalSweeper','specialSweeper','setupSweeper','wallbreaker'].includes(role) && !bulky) return 'Life Orb';

            // Longevity is the default for bulky roles. Life Orb is intentionally never
            // selected for a Bulky Attacker, Defensive, Support, Pivot, or Hazard set.
            if (role === 'defensive' || role === 'support' || role === 'hazard') {
                if (hasRecovery) return 'Leftovers';
                if (hasHazard || hasRemoval) return 'Rocky Helmet';
                return 'Leftovers';
            }
            if (role === 'bulkyAttacker') {
                if (hasRecovery || bulky) return 'Leftovers';
                if (!hasStatus && !hasSetup && (physical ? profile.stats.atk : profile.stats.spa) >= 105) return 'Assault Vest';
                return 'Leftovers';
            }
            if (role === 'pivot') {
                if (rockWeak && hasPivot) return 'Heavy-Duty Boots';
                return hasRecovery ? 'Leftovers' : 'Heavy-Duty Boots';
            }
            if (role === 'wallbreaker') return physical ? 'Choice Band' : 'Choice Specs';

            if (['physicalSweeper','specialSweeper','setupSweeper'].includes(role)) {
                // Setup sweepers prefer a safer setup item unless the ability specifically
                // wants Life Orb. Fast offensive sets can use Expert Belt when they have
                // real coverage, otherwise Leftovers/Lum Berry are safer defaults.
                if (hasSetup && hasStatus) return 'Lum Berry';
                if (hasSetup && bulky) return 'Leftovers';
                const goodCoverage = moves.some(m => sampleHasGoodCoverage(m, profile, moves));
                if (goodCoverage && fast) return 'Expert Belt';
                if (hasSetup && fast && !bulky && goodCoverage && profile.stats[physical ? 'atk' : 'spa'] >= 110) return 'Life Orb';
                if (hasSetup && !bulky) return 'Leftovers';
                return fast ? 'Expert Belt' : 'Leftovers';
            }
            return 'Leftovers';
        }

        function sampleChooseTera(profile, role, moves) {
            const stabTypes = profile.types.filter(t => moves.some(m => m.type === t && sampleIsDamaging(m)));
            if (role === 'physicalSweeper' || role === 'specialSweeper' || role === 'setupSweeper' || role === 'wallbreaker') {
                if (stabTypes.length) return stabTypes[0];
                const damage = moves.filter(sampleIsDamaging).sort((a,b) => (b.basePower||0) - (a.basePower||0));
                if (damage[0]) return damage[0].type;
            }
            if (profile.types.includes('Steel')) return 'Steel';
            if (profile.types.includes('Fairy')) return 'Fairy';
            if (profile.types.includes('Water')) return 'Water';
            return profile.types[0] || 'Normal';
        }

        function sampleRoleLabel(role) {
            const configured = SAMPLE_SET_CONFIG.roles[role]?.name;
            if (configured) return configured;
            // Keep generated labels human-readable even if a role key is introduced
            // later using camelCase or snake_case.
            return String(role || 'Sample Set')
                .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                .replace(/[_-]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .replace(/\b\w/g, c => c.toUpperCase());
        }

        function sampleSetIdeaSimilarity(a, b) {
            const am = new Set((a.moves || []).map(x => String(x).toLowerCase()));
            const bm = new Set((b.moves || []).map(x => String(x).toLowerCase()));
            const union = new Set([...am, ...bm]).size;
            const intersection = [...am].filter(x => bm.has(x)).length;
            const moveJaccard = union ? intersection / union : 1;
            const sameRole = String(a.role || '').toLowerCase() === String(b.role || '').toLowerCase();
            const sameItem = String(a.item || '').toLowerCase() === String(b.item || '').toLowerCase();
            const ae = a.evs || {}, be = b.evs || {};
            const dominant = evs => Object.entries(evs).filter(([,v]) => (v || 0) >= 200).map(([k]) => k).sort().join(',');
            const sameEVProfile = dominant(ae) === dominant(be);
            return { moveJaccard, sameRole, sameItem, sameEVProfile };
        }

        function sampleSetIdeaIsTooSimilar(candidate, accepted) {
            return accepted.some(existing => {
                const sim = sampleSetIdeaSimilarity(candidate, existing);
                // Exact/near-exact sets are duplicates even if their labels differ.
                if (sim.moveJaccard >= 0.75) return true;
                // Two sets from the same role with at least half their moves and the
                // same broad EV profile are effectively the same idea.
                if (sim.sameRole && sim.moveJaccard >= 0.50 && sim.sameEVProfile) return true;
                // Don't show two sets that only differ by an item while everything else
                // is effectively identical.
                if (sim.moveJaccard >= 0.50 && sim.sameItem && sim.sameEVProfile) return true;
                return false;
            });
        }

        function generateSuggestedSampleSets() {
            const profile = getSampleSetProfile();
            if (profile.moves.length < 4) return [];
            const roleScores = sampleRoleScores(profile);
            const rankedRoles = Object.keys(roleScores).sort((a,b) => roleScores[b] - roleScores[a] || a.localeCompare(b));
            const seedSource = [document.getElementById('fakemon-name')?.value || '', Object.values(profile.stats).join(','), profile.types.join('/'), profile.abilities.join('/'), profile.moves.map(m => `${m.name}:${m.type}:${m.category}:${m.basePower}`).join('|')].join('::');
            const seed = sampleSetHash(seedSource);
            const suggestions = [];

            const consider = set => {
                if (!set || !Array.isArray(set.moves) || set.moves.length !== 4) return false;
                if (sampleSetIdeaIsTooSimilar(set, suggestions)) return false;
                suggestions.push(set);
                return true;
            };

            // Parametric sets (e.g. Iron Defense + Body Press) are first-class ideas,
            // but they do not automatically crowd out unrelated roles anymore.
            consider(generateParametricSampleSet(profile, seed ^ 0x9e3779b9));

            // Walk the entire role ranking. We intentionally do not stop after three
            // attempts: several top-scoring roles can collapse to the same four moves.
            // Only genuinely distinct ideas are kept, so returning 1–3 is preferable to
            // showing three copies of the same set with different labels.
            rankedRoles.forEach((role, roleIndex) => {
                if (suggestions.length >= 3) return;
                const moves = samplePickMoves(profile, role, seed + Math.imul(roleIndex + 1, 2654435761));
                if (moves.length !== 4) return;
                const { evs, nature } = sampleChooseNatureEVs(profile, role);
                const ability = sampleChooseAbility(profile, role, moves);
                consider({
                    name: sampleRoleLabel(role),
                    role: sampleRoleLabel(role),
                    item: sampleChooseItem(profile, role, moves, ability),
                    ability,
                    nature,
                    evs,
                    ivs: { hp:31, atk:31, def:31, spa:31, spd:31, spe:31 },
                    moves: moves.map(m => m.name),
                    teraType: sampleChooseTera(profile, role, moves),
                    level: 100
                });
            });

            return suggestions.slice(0, 3);
        }
        function openSampleSetModal() {
            const modal = document.getElementById('sample-set-modal');
            if (!modal) return;
            renderSuggestedSampleSets();
            modal.classList.add('active');
            loadCompetitiveMoveUsefulness().then(() => {
                if (modal.classList.contains('active')) renderSuggestedSampleSets();
            });
        }

        function closeSampleSetModal() {
            const modal = document.getElementById('sample-set-modal');
            if (modal) modal.classList.remove('active');
        }

        function addBlankSampleSet() {
            state.sampleSets.push({
                name: 'Standard Set',
                item: '',
                ability: '',
                nature: 'Hardy',
                evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
                ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
                moves: ['', '', '', ''],
                teraType: '',
                level: 100
            });
            closeSampleSetModal();
            renderSampleSets();
            updatePreview();
            autoSave();
        }

        function addSampleSet() {
            openSampleSetModal();
        }

        function applySuggestedSampleSet(index) {
            const suggestions = generateSuggestedSampleSets();
            const set = suggestions[index];
            if (!set) return;
            state.sampleSets.push(JSON.parse(JSON.stringify(set)));
            closeSampleSetModal();
            renderSampleSets();
            updatePreview();
            autoSave();
        }

        function renderSuggestedSampleSets() {
            const container = document.getElementById('suggested-sample-sets-list');
            if (!container) return;
            let suggestions = [];
            try { suggestions = generateSuggestedSampleSets(); }
            catch (err) { console.error('[Sample Sets] generator error:', err); }
            if (!suggestions.length) {
                container.innerHTML = '<div class="sample-set-empty-message">oh nah no sample sets for u unc</div>';
                return;
            }
            container.innerHTML = suggestions.map((set, i) => {
                const spread = formatEVSpread(set.evs, set.nature, set);
                return `
                    <button type="button" class="suggested-sample-set-card" onclick="applySuggestedSampleSet(${i})">
                        <div class="suggested-sample-set-title">
                            <strong>${set.name}</strong>
                            <span>${set.item}</span>
                        </div>
                        <div class="suggested-sample-set-meta">${set.nature} · ${spread}</div>
                        <div class="suggested-sample-set-moves">${set.moves.join(' · ')}</div>
                        <div class="suggested-sample-set-footer">${set.ability || 'No ability'} · Tera ${set.teraType}</div>
                    </button>
                `;
            }).join('');
        }

        function updateSampleSet(index, field, value) {
            if (field.startsWith('evs.')) {
                const stat = field.split('.')[1];
                state.sampleSets[index].evs[stat] = parseInt(value) || 0;
            } else if (field.startsWith('ivs.')) {
                const stat = field.split('.')[1];
                state.sampleSets[index].ivs[stat] = parseInt(value) || 0;
            } else if (field.startsWith('moves.')) {
                const slot = parseInt(field.split('.')[1]);
                state.sampleSets[index].moves[slot] = value;
            } else if (field === 'level') {
                let lvl = parseInt(value) || 100;
                lvl = Math.max(1, Math.min(100, lvl));
                state.sampleSets[index].level = lvl;
            } else {
                state.sampleSets[index][field] = value;
            }
            const card = document.querySelector(`.sample-set-card[data-set-index="${index}"]`);
            if (card) {
                const fakemonName = document.getElementById('fakemon-name').value || 'Fakemon';
                const exportText = generateShowdownExport(fakemonName, state.sampleSets[index]);
                const outputEl = card.querySelector('.sample-set-output-text');
                if (outputEl) outputEl.textContent = exportText;
            }
            updatePreview();
            autoSave();
        }
        function updateSampleSetItem(setIndex, value) {
            state.sampleSets[setIndex].item = value;
            const card = document.querySelector(`.sample-set-card[data-set-index="${setIndex}"]`);
            if (card) {
                const icon = card.querySelector('.sample-set-item-icon');
                if (icon) {
                    if (value) {
                        const slug = value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
                        icon.src = 'https://play.pokemonshowdown.com/sprites/itemicons/' + slug + '.png';
                        icon.style.display = '';
                    } else {
                        icon.style.display = 'none';
                    }
                }
                const fakemonName = document.getElementById('fakemon-name').value || 'Fakemon';
                const exportText = generateShowdownExport(fakemonName, state.sampleSets[setIndex]);
                const outputEl = card.querySelector('.sample-set-output-text');
                if (outputEl) outputEl.textContent = exportText;
            }
            updatePreview();
            autoSave();
        }

        
// ==================== SAMPLE SET AUTOCOMPLETE ====================
        function hideSampleSetDropdownDelayed(id) {
            setTimeout(() => { const el = document.getElementById(id); if (el) el.classList.remove('active'); }, 200);
        }
        function filterSampleSetItem(setIndex, value) {
            updateSampleSetItem(setIndex, value);
            const dropdown = document.getElementById(`item-dropdown-${setIndex}`);
            if (!dropdown) return;
            if (!value.trim()) { dropdown.classList.remove('active'); return; }
            const matches = Object.values(state.sdItems)
                .filter(it => it.name.toLowerCase().includes(value.toLowerCase()))
                .slice(0, 8);
            renderDropdown(dropdown, matches, (item) => {
                const input = dropdown.previousElementSibling;
                input.value = item.name;
                updateSampleSetItem(setIndex, item.name);
                dropdown.classList.remove('active');
            }, false);
        }
        function filterSampleSetMove(setIndex, slot, value) {
            updateSampleSet(setIndex, `moves.${slot}`, value);
            const dropdown = document.getElementById(`move-dropdown-${setIndex}-${slot}`);
            if (!dropdown) return;
            if (!value.trim()) { dropdown.classList.remove('active'); return; }
            const pool = [...state.learnset];
            const matches = pool
                .filter(m => m.name.toLowerCase().includes(value.toLowerCase()))
                .filter((m, idx, arr) => arr.findIndex(x => x.name === m.name) === idx)
                .slice(0, 8);
            renderDropdown(dropdown, matches, (item) => {
                const input = dropdown.previousElementSibling;
                input.value = item.name;
                updateSampleSet(setIndex, `moves.${slot}`, item.name);
                dropdown.classList.remove('active');
            }, true);
        }

        function removeSampleSet(index) {
            state.sampleSets.splice(index, 1);
            renderSampleSets();
            updatePreview();
            autoSave();
        }
        function copySampleSet(index) {
            const set = state.sampleSets[index];
            const fakemonName = document.getElementById('fakemon-name').value || 'Fakemon';
            const text = generateShowdownExport(fakemonName, set);
            navigator.clipboard.writeText(text).then(() => api.showToast('Set copied to clipboard!', 'success'));
        }
        function copySampleSetText(text) {
            navigator.clipboard.writeText(text).then(() => api.showToast('Set copied to clipboard!', 'success'));
        }
        function generateShowdownExport(name, set) {
            let lines = [];
            // Name @ Item
            if (set.item) lines.push(`${name} @ ${set.item}`);
            else lines.push(name);
            // Ability
            if (set.ability) lines.push(`Ability: ${set.ability}`);
            // Level (Showdown omits this line entirely at the default of 100)
            if (set.level && set.level !== 100) lines.push(`Level: ${set.level}`);
            // Tera Type
            if (set.teraType) lines.push(`Tera Type: ${set.teraType}`);
            // EVs
            const evParts = [];
            if (set.evs.hp) evParts.push(`${set.evs.hp} HP`);
            if (set.evs.atk) evParts.push(`${set.evs.atk} Atk`);
            if (set.evs.def) evParts.push(`${set.evs.def} Def`);
            if (set.evs.spa) evParts.push(`${set.evs.spa} SpA`);
            if (set.evs.spd) evParts.push(`${set.evs.spd} SpD`);
            if (set.evs.spe) evParts.push(`${set.evs.spe} Spe`);
            if (evParts.length) lines.push(`EVs: ${evParts.join(' / ')}`);
            // Nature
            if (set.nature) lines.push(`${set.nature} Nature`);
            // IVs
            const ivParts = [];
            if (set.ivs.hp !== 31) ivParts.push(`${set.ivs.hp} HP`);
            if (set.ivs.atk !== 31) ivParts.push(`${set.ivs.atk} Atk`);
            if (set.ivs.def !== 31) ivParts.push(`${set.ivs.def} Def`);
            if (set.ivs.spa !== 31) ivParts.push(`${set.ivs.spa} SpA`);
            if (set.ivs.spd !== 31) ivParts.push(`${set.ivs.spd} SpD`);
            if (set.ivs.spe !== 31) ivParts.push(`${set.ivs.spe} Spe`);
            if (ivParts.length) lines.push(`IVs: ${ivParts.join(' / ')}`);
            // Moves
            set.moves.forEach(m => { if (m) lines.push(`- ${m}`); });
            return lines.join('\n');
        }
                
// ==================== STAT CALCULATION ====================
        function getNatureBoostLabel(nature) {
            const data = NATURE_DATA[nature];
            if (!data || data.up === data.down) return '<span style="color:var(--text-muted);">Neutral</span>';
            return `<span style="color:#cc4444;font-weight:700;">+${STAT_NAMES[data.up]}</span> / <span style="color:#4466cc;font-weight:700;">−${STAT_NAMES[data.down]}</span>`;
        }

        function calcStat(base, ev, iv, nature, statKey, level) {
            level = level || 100;
            iv = iv || 31;
            ev = ev || 0;
            let natureMult = 1.0;
            const data = NATURE_DATA[nature];
            if (data && data.up !== data.down) {
                if (data.up === statKey) natureMult = 1.1;
                if (data.down === statKey) natureMult = 0.9;
            }
            if (statKey === 'hp') {
                return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + level + 10;
            }
            return Math.floor((Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + 5) * natureMult);
        }

        function getAllAbilities() {
            return state.abilities.filter(a => a.name).map(a => a.name);
        }

                function updateSampleSetEV(setIndex, statKey, value) {
            const ev = parseInt(value) || 0;
            const set = state.sampleSets[setIndex];
            const otherEVs = Object.entries(set.evs).filter(([k,v]) => k !== statKey).reduce((s,[k,v]) => s + (v||0), 0);
            const maxAllowed = 508 - otherEVs;
            const clampedEV = Math.max(0, Math.min(ev, maxAllowed, 252));

            if (clampedEV !== ev && ev > clampedEV) {
                const card = document.querySelector(`.sample-set-card[data-set-index="${setIndex}"]`);
                const now = Date.now();
                if (!card._lastEvToast || now - card._lastEvToast > 2000) {
                    api.showToast('Cannot exceed 508 total EVs!', 'error');
                    card._lastEvToast = now;
                }
            }

            set.evs[statKey] = clampedEV;

            const card = document.querySelector(`.sample-set-card[data-set-index="${setIndex}"]`);
            if (card) {
                const calcEl = document.getElementById(`set-${setIndex}-stat-${statKey}`);
                if (calcEl) {
                    const row = calcEl.closest('.sample-set-stat-row');
                    if (row) {
                        const track = row.querySelector('.sample-set-ev-track');
                        if (track) {
                            const slider = track.querySelector('.sample-set-ev-slider');
                            const fill = track.querySelector('.sample-set-ev-fill');
                            if (slider) slider.value = clampedEV;
                            if (fill) fill.style.width = (clampedEV / 252 * 100) + '%';
                        }
                        const input = row.querySelector('.sample-set-ev-input-compact');
                        if (input) input.value = clampedEV;
                    }
                }

                const fakemonName = document.getElementById('fakemon-name').value || 'Fakemon';
                const exportText = generateShowdownExport(fakemonName, set);
                const outputEl = card.querySelector('.sample-set-output-text');
                if (outputEl) outputEl.textContent = exportText;
                const statKeys = ['hp','atk','def','spa','spd','spe'];
                const totalEVs = statKeys.reduce((sum, k) => sum + (set.evs[k] || 0), 0);
                const evRemaining = 508 - totalEVs;
                const evText = card.querySelector('.sample-set-ev-total-text');
                if (evText) evText.textContent = `${totalEVs} / 508 EVs ${evRemaining >= 0 ? '(' + evRemaining + ' remaining)' : '(' + Math.abs(evRemaining) + ' over!)'}`;
                const guessBtn = card.querySelector('.sample-set-guess-btn');
                if (guessBtn) guessBtn.textContent = formatEVSpread(set.evs, set.nature, set);
            }

            updateStatDisplay(setIndex, statKey, clampedEV.toString(), null);
            autoSave();
        }

        // Heuristic EV spread guesser, in the spirit of Smogon's "sample set" spreads:
        // pick the stronger attacking stat, decide whether this is a speed-based or
        // bulky-based set from the Fakemon's base Speed, then dump EVs accordingly.
        function getGuessSpreadRole(set) {
            const base = getSampleSetProfile().stats;
            const evs = set?.evs || {};
            const nature = NATURE_DATA[set?.nature];
            const physical = (evs.atk || 0) >= (evs.spa || 0);
            const fast = (evs.spe || 0) >= 200;
            if ((evs.spd || 0) >= 200 && (evs.hp || 0) >= 160) return 'Specially Defensive';
            if ((evs.def || 0) >= 200 && (evs.hp || 0) >= 160) return 'Physically Defensive';
            if ((evs.spe || 0) >= 200 && (evs.atk || 0) >= 200) return 'Fast Physical Attacker';
            if ((evs.spe || 0) >= 200 && (evs.spa || 0) >= 200) return 'Fast Special Attacker';
            if ((evs.atk || 0) >= 200 && (evs.hp || 0) >= 160) return 'Bulky Physical Attacker';
            if ((evs.spa || 0) >= 200 && (evs.hp || 0) >= 160) return 'Bulky Special Attacker';
            if (nature && nature.up === 'atk') return physical ? 'Physical Attacker' : 'Mixed Attacker';
            if (nature && nature.up === 'spa') return 'Special Attacker';
            if (base.atk >= base.spa) return fast ? 'Fast Physical Attacker' : 'Bulky Physical Attacker';
            return fast ? 'Fast Special Attacker' : 'Bulky Special Attacker';
        }

        function formatEVSpread(evs, natureName, set) {
            const labels = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
            const order = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
            const parts = order
                .filter(key => (evs?.[key] || 0) > 0)
                .map(key => `${evs[key]} ${labels[key]}`);
            const spread = parts.length ? parts.join(' / ') : '0 EVs';
            const nature = NATURE_DATA[natureName];
            const natureText = nature && nature.up !== nature.down
                ? ` / (+${STAT_NAMES[nature.up]}, -${STAT_NAMES[nature.down]})`
                : '';
            return `${getGuessSpreadRole(set || { evs, nature: natureName })}: ${spread}${natureText}`;
        }

        function guessEVSpread(setIndex) {
            const set = state.sampleSets[setIndex];
            if (!set) return;

            const base = {
                hp: parseInt(document.getElementById('stat-hp').value) || 60,
                atk: parseInt(document.getElementById('stat-atk').value) || 60,
                def: parseInt(document.getElementById('stat-def').value) || 60,
                spa: parseInt(document.getElementById('stat-spa').value) || 60,
                spd: parseInt(document.getElementById('stat-spd').value) || 60,
                spe: parseInt(document.getElementById('stat-spe').value) || 60
            };

            // Figure out whether this set leans physical or special. Prefer looking at
            // the actual moves chosen (ignoring Status moves); fall back to comparing
            // base Atk vs base SpA if no damaging moves are set yet.
            let physicalCount = 0, specialCount = 0;
            set.moves.forEach(name => {
                if (!name) return;
                const move = getSdMoveByName(name);
                if (!move) return;
                if (move.category === 'Physical') physicalCount++;
                else if (move.category === 'Special') specialCount++;
            });
            let offStat;
            if (physicalCount || specialCount) offStat = physicalCount >= specialCount ? 'atk' : 'spa';
            else offStat = base.atk >= base.spa ? 'atk' : 'spa';

            // Speedy attackers invest in Speed; slow/bulky ones dump the rest into HP.
            const isFast = base.spe >= 90;
            const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
            evs[offStat] = 252;
            if (isFast) {
                evs.spe = 252;
                evs.hp = 4;
            } else {
                evs.hp = 252;
                // Put the last 4 EVs in whichever defensive stat is weaker.
                evs[base.def <= base.spd ? 'def' : 'spd'] = 4;
            }

            const natureTable = {
                atk: isFast ? 'Jolly' : 'Adamant',
                spa: isFast ? 'Timid' : 'Modest'
            };

            set.evs = evs;
            set.nature = natureTable[offStat];

            renderSampleSets();
            updatePreview();
            autoSave();
        }

        function setNatureBoost(setIndex, statKey, direction) {
            const set = state.sampleSets[setIndex];
            const current = NATURE_DATA[set.nature];
            let newUp = current.up;
            let newDown = current.down;

            if (direction === 'up') {
                if (current.up === statKey) {
                    // Toggle off - set to neutral
                    newUp = statKey; newDown = statKey;
                } else {
                    newUp = statKey;
                    // Keep current down if it's different
                    if (newDown === statKey) newDown = current.down;
                }
            } else {
                if (current.down === statKey) {
                    // Toggle off - set to neutral
                    newUp = statKey; newDown = statKey;
                } else {
                    newDown = statKey;
                    // Keep current up if it's different
                    if (newUp === statKey) newUp = current.up;
                }
            }

            const newNature = findNatureByBoosts(newUp, newDown);
            set.nature = newNature;

            // Update nature select without full re-render
            const card = document.querySelector(`.sample-set-card[data-set-index="${setIndex}"]`);
            if (card) {
                const natureSelect = card.querySelector('.sample-set-field select');
                // Find the nature select (it's the one with nature options)
                const selects = card.querySelectorAll('select');
                selects.forEach(sel => {
                    if (sel.value === set.nature || Array.from(sel.options).some(o => o.value === set.nature)) {
                        sel.value = set.nature;
                    }
                });
            }

            renderNatureStats(setIndex);
            autoSave();
        }

        function renderNatureStats(setIndex) {
            const set = state.sampleSets[setIndex];
            const baseStats = {
                hp: parseInt(document.getElementById('stat-hp').value) || 60,
                atk: parseInt(document.getElementById('stat-atk').value) || 60,
                def: parseInt(document.getElementById('stat-def').value) || 60,
                spa: parseInt(document.getElementById('stat-spa').value) || 60,
                spd: parseInt(document.getElementById('stat-spd').value) || 60,
                spe: parseInt(document.getElementById('stat-spe').value) || 60
            };
            const statKeys = ['hp','atk','def','spa','spd','spe'];
            const data = NATURE_DATA[set.nature];

            const card = document.querySelector(`.sample-set-card[data-set-index="${setIndex}"]`);
            if (!card) return;

            statKeys.forEach(key => {
                const base = baseStats[key];
                const ev = set.evs[key] || 0;
                const iv = set.ivs[key] || 31;
                const calc = calcStat(base, ev, iv, set.nature, key, set.level);
                const isBoosted = data && data.up === key && data.up !== data.down;
                const isReduced = data && data.down === key && data.up !== data.down;
                const barFill = Math.min((calc / 500) * 100, 100);
                const barColor = isBoosted ? '#cc4444' : isReduced ? '#4466cc' : '#888';

                const calcEl = document.getElementById(`set-${setIndex}-stat-${key}`);
                if (calcEl) {
                    calcEl.textContent = calc;
                    const bar = calcEl.closest('.sample-set-stat-row')?.querySelector('.sample-set-stat-bar-fill');
                    if (bar) {
                        bar.style.width = barFill + '%';
                        bar.style.background = barColor;
                    }
                }

                // Update row class for styling
                const row = document.getElementById(`set-${setIndex}-stat-${key}`).closest('.sample-set-stat-row');
                if (row) {
                    row.classList.remove('stat-boosted', 'stat-reduced');
                    if (isBoosted) row.classList.add('stat-boosted');
                    if (isReduced) row.classList.add('stat-reduced');
                }

                // Update + / - button states
                const plusBtn = row.querySelector('.nature-plus');
                const minusBtn = row.querySelector('.nature-minus');
                if (plusBtn) plusBtn.classList.toggle('active', isBoosted);
                if (minusBtn) minusBtn.classList.toggle('active', isReduced);
            });

            // Update export text
            const fakemonName = document.getElementById('fakemon-name').value || 'Fakemon';
            const exportText = generateShowdownExport(fakemonName, set);
            const outputEl = card.querySelector('.sample-set-output-text');
            if (outputEl) outputEl.textContent = exportText;

            updatePreview();
        }

function updateStatDisplay(setIndex, statKey, evVal, ivVal) {
            const set = state.sampleSets[setIndex];
            const baseStats = {
                hp: parseInt(document.getElementById('stat-hp').value) || 60,
                atk: parseInt(document.getElementById('stat-atk').value) || 60,
                def: parseInt(document.getElementById('stat-def').value) || 60,
                spa: parseInt(document.getElementById('stat-spa').value) || 60,
                spd: parseInt(document.getElementById('stat-spd').value) || 60,
                spe: parseInt(document.getElementById('stat-spe').value) || 60
            };
            const ev = evVal !== null ? parseInt(evVal) || 0 : (set.evs[statKey] || 0);
            const iv = ivVal !== null ? parseInt(ivVal) || 0 : (set.ivs[statKey] || 31);
            const calc = calcStat(baseStats[statKey], ev, iv, set.nature, statKey, set.level);
            const el = document.getElementById(`set-${setIndex}-stat-${statKey}`);
            const card = document.querySelector(`.sample-set-card[data-set-index="${setIndex}"]`);
            if (el) el.textContent = calc;

            if (card) {
                const row = el ? el.closest('.sample-set-stat-row') : null;
                if (row) {
                    const data = NATURE_DATA[set.nature];
                    const isBoosted = data && data.up === statKey && data.up !== data.down;
                    const isReduced = data && data.down === statKey && data.up !== data.down;
                    const barFill = Math.min((calc / 500) * 100, 100);
                    const barColor = isBoosted ? '#cc4444' : isReduced ? '#4466cc' : '#888';
                    const bar = row.querySelector('.sample-set-stat-bar-fill');
                    if (bar) {
                        bar.style.width = barFill + '%';
                        bar.style.background = barColor;
                    }
                    const evDisplay = row.querySelector('.sample-set-ev-value');
                    if (evDisplay) evDisplay.textContent = ev;
                    const slider = row.querySelector('.sample-set-ev-slider');
                    const fill = row.querySelector('.sample-set-ev-fill');
                    if (slider && evVal !== null) slider.value = ev;
                    if (fill && evVal !== null) fill.style.width = (ev / 252 * 100) + '%';
                }

                const fakemonName = document.getElementById('fakemon-name').value || 'Fakemon';
                const exportText = generateShowdownExport(fakemonName, set);
                const outputEl = card.querySelector('.sample-set-output-text');
                if (outputEl) outputEl.textContent = exportText;
            }
            updatePreview();
        }

        
        function renderSampleSets() {
            const container = document.getElementById('sample-sets-list');
            const fakemonName = document.getElementById('fakemon-name').value || 'Fakemon';
            const baseStats = {
                hp: parseInt(document.getElementById('stat-hp').value) || 60,
                atk: parseInt(document.getElementById('stat-atk').value) || 60,
                def: parseInt(document.getElementById('stat-def').value) || 60,
                spa: parseInt(document.getElementById('stat-spa').value) || 60,
                spd: parseInt(document.getElementById('stat-spd').value) || 60,
                spe: parseInt(document.getElementById('stat-spe').value) || 60
            };
            const allAbilities = getAllAbilities();
            const statKeys = ['hp','atk','def','spa','spd','spe'];
            const statLabels = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

            container.innerHTML = state.sampleSets.map((set, i) => {
                const exportText = generateShowdownExport(fakemonName, set);
                const totalEVs = statKeys.reduce((sum, k) => sum + (set.evs[k] || 0), 0);
                const evRemaining = 508 - totalEVs;

                const statRows = statKeys.map(key => {
                    const base = baseStats[key];
                    const ev = set.evs[key] || 0;
                    const iv = set.ivs[key] || 31;
                    const calc = calcStat(base, ev, iv, set.nature, key, set.level);
                    const data = NATURE_DATA[set.nature];
                    const isBoosted = data && data.up === key && data.up !== data.down;
                    const isReduced = data && data.down === key && data.up !== data.down;
                    const natureClass = isBoosted ? 'stat-boosted' : isReduced ? 'stat-reduced' : '';
                    const barFill = Math.min((calc / 500) * 100, 100);
                    const barColor = isBoosted ? '#cc4444' : isReduced ? '#4466cc' : '#888';

                    return `
                        <div class="sample-set-stat-row ${natureClass}">
                            <div class="sample-set-stat-col stat-name-col">
                                <div class="sample-set-stat-label">${statLabels[key]}</div>
                                <div class="sample-set-nature-btns">
                                    <button class="nature-btn nature-plus ${isBoosted ? 'active' : ''}" onclick="setNatureBoost(${i}, '${key}', 'up')" title="Boost ${statLabels[key]}">+</button>
                                    <button class="nature-btn nature-minus ${isReduced ? 'active' : ''}" onclick="setNatureBoost(${i}, '${key}', 'down')" title="Reduce ${statLabels[key]}">−</button>
                                </div>
                            </div>
                            <div class="sample-set-stat-base">${base}</div>
                            <input type="number" class="sample-set-ev-input-compact" min="0" max="252" step="4" value="${ev}" 
                                onchange="updateSampleSetEV(${i},'${key}',this.value)">
                            <div class="sample-set-stat-col slider-col">
                                <div class="sample-set-stat-bar-above">
                                    <div class="sample-set-stat-bar-fill" style="width:${barFill}%;background:${barColor}"></div>
                                </div>
                                <div class="sample-set-ev-track">
                                    <div class="sample-set-ev-fill" style="width:${(ev/252)*100}%"></div>
                                    <input type="range" class="sample-set-ev-slider" min="0" max="252" step="4" value="${ev}" 
                                        oninput="updateSampleSetEV(${i},'${key}',this.value)">
                                </div>
                            </div>
                            <div class="sample-set-stat-iv-wrap">
                                <input type="number" class="sample-set-iv-input" min="0" max="31" value="${iv}" 
                                    onchange="updateSampleSet(${i},'ivs.${key}',this.value); updateStatDisplay(${i},'${key}',null,this.value)">
                            </div>
                            <div class="sample-set-stat-calc" id="set-${i}-stat-${key}">${calc}</div>
                        </div>
                    `;
                }).join('');

                let abilityOptions = '<option value="">None</option>';
                allAbilities.forEach(a => {
                    abilityOptions += `<option value="${a}" ${set.ability === a ? 'selected' : ''}>${a}</option>`;
                });

                const natureOptions = NATURES.map(n => {
                    const label = getNatureOptionLabel(n);
                    return `<option value="${n}" ${set.nature === n ? 'selected' : ''}>${label}</option>`;
                }).join('');

                return `
                    <div class="sample-set-card" data-set-index="${i}">
                        <button class="sample-set-delete" onclick="removeSampleSet(${i})" title="Delete"><i data-lucide="trash-2" style="width:16px;height:16px;"></i></button>
                        <div class="sample-set-header">
                            <input type="text" class="sample-set-name" value="${set.name}" placeholder="Set name" oninput="updateSampleSet(${i},'name',this.value)">
                        </div>
                        <div class="sample-set-row">
                            <div class="sample-set-field">
                                <label>Item</label>
                                <div class="sample-set-item-wrap">
                                    <img class="sample-set-item-icon" id="set-${i}-item-icon" src="${set.item ? 'https://play.pokemonshowdown.com/sprites/itemicons/' + set.item.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '') + '.png' : ''}" alt="" style="${set.item ? '' : 'display:none;'}" onerror="this.style.display='none'">
                                    <div class="autocomplete-container" style="flex:1;">
                                        <input type="text" class="sample-set-item-input" value="${set.item}" placeholder="e.g., Leftovers"
                                            oninput="filterSampleSetItem(${i}, this.value)" onblur="hideSampleSetDropdownDelayed('item-dropdown-${i}')">
                                        <div class="autocomplete-dropdown" id="item-dropdown-${i}"></div>
                                    </div>
                                </div>
                            </div>
                            <div class="sample-set-field">
                                <label>Ability</label>
                                <select onchange="updateSampleSet(${i},'ability',this.value)">${abilityOptions}</select>
                            </div>
                            <div class="sample-set-field">
                                <label>Nature</label>
                                <select onchange="updateSampleSet(${i},'nature',this.value); renderNatureStats(${i})">${natureOptions}</select>
                            </div>
                        </div>
                        <div class="sample-set-row">
                            <div class="sample-set-field">
                                <label>Level</label>
                                <input type="number" min="1" max="100" value="${set.level || 100}" placeholder="100"
                                    onchange="updateSampleSet(${i},'level',this.value)">
                            </div>
                            <div class="sample-set-field wide">
                                <label>Tera Type</label>
                                <div class="type-dropdown" id="tera-type-${i}-dropdown">
                                    <button class="type-dropdown-trigger" type="button" onclick="toggleTypeDropdown('tera-type-${i}')">
                                        <span class="type-dropdown-value" id="tera-type-${i}-value">${set.teraType ? `<span class="type-pill type-${set.teraType.toLowerCase()}">${set.teraType}</span>` : 'None'}</span>
                                        <span class="type-dropdown-arrow">▼</span>
                                    </button>
                                    <div class="type-dropdown-menu" id="tera-type-${i}-menu">${buildTypeMenuOptions(t => `selectTeraType(${i}, '${t}')`, true, 'None')}</div>
                                </div>
                            </div>
                        </div>
                        <div class="sample-set-ev-total-row">
                            <div class="sample-set-ev-total-text">${totalEVs} / 508 EVs ${evRemaining >= 0 ? '(' + evRemaining + ' remaining)' : '(' + Math.abs(evRemaining) + ' over!)'}</div>
                            <button type="button" class="sample-set-guess-btn btn btn-secondary btn-sm" onclick="guessEVSpread(${i})" title="Guess a competitive EV spread from this Fakemon's base stats and moves">${formatEVSpread(set.evs, set.nature, set)}</button>
                        </div>
                        <div class="sample-set-stats-section">
                            <div class="sample-set-stats-header">
                                <span>Stat</span><span>Base</span><span>EV</span><span>Slider</span><span>IV</span><span>Total</span>
                            </div>
                            ${statRows}
                        </div>
                        <div style="margin-top:8px;">
                            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:700;margin-bottom:4px;">Moves</div>
                            <div class="sample-set-moves">
                                ${[0,1,2,3].map(slot => `
                                    <div class="autocomplete-container">
                                        <input type="text" class="sample-set-move-input" value="${set.moves[slot]}" placeholder="Move ${slot+1}"
                                            oninput="filterSampleSetMove(${i}, ${slot}, this.value)" onblur="hideSampleSetDropdownDelayed('move-dropdown-${i}-${slot}')">
                                        <div class="autocomplete-dropdown" id="move-dropdown-${i}-${slot}"></div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                        <div class="sample-set-output">
                            <button class="sample-set-copy" onclick="copySampleSet(${i})" title="Copy to clipboard"><i data-lucide="copy" style="width:14px;height:14px;"></i></button>
                            <span class="sample-set-output-text">${exportText}</span>
                        </div>
                    </div>
                `;
            }).join('');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function showDetailPopup(title, content) {
            document.querySelectorAll('.move-detail-popup, .overlay-dark').forEach(el => el.remove());
            const overlay = document.createElement('div');
            overlay.className = 'overlay-dark';
            const popup = document.createElement('div');
            popup.className = 'move-detail-popup';
            popup.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <h3>${title}</h3>
                    <button class="modal-close" type="button">&times;</button>
                </div>
                ${content}
            `;
            const close = () => {
                overlay.classList.remove('active');
                popup.classList.remove('active');
                setTimeout(() => { overlay.remove(); popup.remove(); }, 150);
            };
            overlay.onclick = close;
            popup.querySelector('.modal-close').onclick = close;
            document.body.appendChild(overlay);
            document.body.appendChild(popup);
            // Double rAF so the initial (pre-.active) state paints first, guaranteeing
            // the transition actually runs instead of jumping straight to the end state.
            requestAnimationFrame(() => requestAnimationFrame(() => {
                overlay.classList.add('active');
                popup.classList.add('active');
            }));
        }

        
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
            editingCustomAbilityIndex = null;
            state.learnset = [];
            state.sampleSets = [];
            state.artworkData = null;
            document.getElementById('artwork-preview').innerHTML = '<span class="placeholder">ART</span>';
            renderAbilities();
            renderLearnset();
            renderCustomMoves();
            renderSampleSets();
            updateStats();
            updateGenderBar();
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
            editingCustomAbilityIndex = null;
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

        
// ==================== BULK COMPARISON ====================
        function getSpriteUrl(dexId) {
            // Convert dex ID to sprite filename (lowercase, hyphenated)
            let name = dexId.toLowerCase();
            // Remove forme suffixes for sprite lookup
            name = name.replace(/-alola$/, '').replace(/-galar$/, '').replace(/-hisui$/, '').replace(/-paldea$/, '');
            return 'https://play.pokemonshowdown.com/sprites/gen5ani/' + name + '.gif';
        }

        function updateBulkComparison() {
            const container = document.getElementById('bulk-comparison');
            if (!container) return;
            if (!state.sdLoaded || Object.keys(state.sdPokedex).length === 0) {
                container.innerHTML = '<div class="bulk-comparison-title">Bulk Comparison</div><p style="font-size:12px;color:var(--text-muted);">Loading Pokemon data...</p>';
                return;
            }

            const hp = clampBaseStatValue(document.getElementById('stat-hp').value);
            const def = clampBaseStatValue(document.getElementById('stat-def').value);
            const spd = clampBaseStatValue(document.getElementById('stat-spd').value);
            const physBulk = hp * def;
            const specBulk = hp * spd;

            // Find closest by physical bulk
            let closestPhys = null, closestPhysDiff = Infinity;
            let closestSpec = null, closestSpecDiff = Infinity;

            for (const dex of Object.values(state.sdPokedex)) {
                if (!dex.stats) continue;
                const dHp = dex.stats.hp || 0;
                const dDef = dex.stats.def || 0;
                const dSpd = dex.stats.spd || 0;
                const dPhys = dHp * dDef;
                const dSpec = dHp * dSpd;
                const physDiff = Math.abs(dPhys - physBulk);
                const specDiff = Math.abs(dSpec - specBulk);
                if (physDiff < closestPhysDiff) { closestPhysDiff = physDiff; closestPhys = dex; }
                if (specDiff < closestSpecDiff) { closestSpecDiff = specDiff; closestSpec = dex; }
            }

            const physSprite = closestPhys ? getSpriteUrl(closestPhys.id) : '';
            const specSprite = closestSpec ? getSpriteUrl(closestSpec.id) : '';

            container.innerHTML = `
                <div class="bulk-comparison-title">Bulk Comparison</div>
                <div class="bulk-row">
                    <div class="bulk-card">
                        <div class="bulk-label">Physical Bulk (HP x Def)</div>
                        <div class="bulk-value">${physBulk.toLocaleString()}</div>
                        <div class="bulk-match">
                            <img class="bulk-match-sprite" src="${physSprite}" alt="${closestPhys ? closestPhys.name : ''}" onerror="this.style.display='none'">
                            <span class="bulk-match-name">Closest: ${closestPhys ? closestPhys.name : 'N/A'}${closestPhys ? ` — ${((closestPhys.stats?.hp || 0) * (closestPhys.stats?.def || 0)).toLocaleString()} bulk` : ''}</span>
                        </div>
                    </div>
                    <div class="bulk-card">
                        <div class="bulk-label">Special Bulk (HP x SpD)</div>
                        <div class="bulk-value">${specBulk.toLocaleString()}</div>
                        <div class="bulk-match">
                            <img class="bulk-match-sprite" src="${specSprite}" alt="${closestSpec ? closestSpec.name : ''}" onerror="this.style.display='none'">
                            <span class="bulk-match-name">Closest: ${closestSpec ? closestSpec.name : 'N/A'}${closestSpec ? ` — ${((closestSpec.stats?.hp || 0) * (closestSpec.stats?.spd || 0)).toLocaleString()} bulk` : ''}</span>
                        </div>
                    </div>
                </div>
            `;
        }

        
// ==================== ARTWORK ====================
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
            return `<span class="move-tag ${catClass}${lowValue ? ' low-value' : ''}" onclick="showMoveDetail('${m.name}')">${m.name}</span>`;
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



export { getNextPokedexNumber, getAbilityRole, fetchShowdownData, filterAbilities, filterMoves, renderDropdown, hideAbilityDropdownDelayed, hideMoveDropdownDelayed, toggleLevelInput, handleAbilityKey, findClosestMove, findClosestMoveForImport, parseMoveImportText, openMoveImportExportModal, exportMovesToText, importMovesFromText, handleMoveKey, addMoveFromInput, addAbility, openCustomAbilityChooser, openCustomAbilityLibraryModal, saveCustomAbilityLibraryEntry, addExistingCustomAbility, editCustomAbilityLibrary, updateAbility, toggleCustomAbilityEdit, finishCustomAbilityEdit, removeAbility, moveAbility, renderAbilities, showAbilityDetail, getSdMoveByName, hydrateLearnsetEntry, rehydrateCurrentLearnsetFromShowdown, addLearnsetMove, removeLearnsetMove, updateMoveMethod, updateMoveLevel, sortLearnset, renderLearnset, buildDonutSVG, renderLearnsetChart, clearLearnsetFilters, addUniversalMoves, getFakemonStats, getFakemonProfile, findSimilarPokemon, classifyLearnsetSource, buildSimilarMovePools, classifyMoveRole, generateMoveRecommendations, openRecommendMovesModal, renderRecommendMovesModal, selectRecommendedMove, generateLearnset, clearMoveset, showMoveDetail, updateCustomAbility, removeCustomAbility, renderCustomAbilities, buildTypeMenuOptions, setTypeDropdownValue, buildCatMenuOptions, setCatDropdownValue, selectCustomMoveType, selectCustomMoveCategory, selectLearnsetTypeFilter, selectLearnsetCategoryFilter, openCustomMoveChooser, addExistingCustomMove, editCustomMoveLibrary, openCustomMoveModal, saveCustomMove, removeCustomMove, renderCustomMoves, renderCustomMoveShowcase, updateSampleSet, updateSampleSetItem, hideSampleSetDropdownDelayed, filterSampleSetItem, filterSampleSetMove, removeSampleSet, copySampleSet, copySampleSetText, generateShowdownExport, selectTeraType, openSampleSetModal, closeSampleSetModal, addBlankSampleSet, addSampleSet, applySuggestedSampleSet, renderSuggestedSampleSets, getNatureBoostLabel, calcStat, getAllAbilities, updateSampleSetEV, guessEVSpread, setNatureBoost, renderNatureStats, updateStatDisplay, renderSampleSets, showDetailPopup, resetEditor, loadFakemonIntoEditor, updateEditorStats, updateStats, getSpriteUrl, updateBulkComparison, handleArtworkUpload, handleArtworkDragOver, handleArtworkDragLeave, handleArtworkDrop, handleEggGroupChange, getEggGroupValue, setEggGroupValue, getGenderRatioValue, setGenderRatioValue, toggleGenderless, genderSliderChanged, genderMaleInputChanged, genderFemaleInputChanged, updateGenderBar, getFlagLabels, renderMoveTag, updatePreview, handleHeightInput, handleWeightInput, convertHeight, convertWeight, getHeightDisplay, getWeightDisplay, getTypeDamageMultiplier, renderTypeEffectiveness };