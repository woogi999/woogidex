import { cachedFetch } from '../core/net-cache.ts';
import { SD_MOVE_FIELDS } from '../battle/engine/dex.ts';
import { log } from '../core/log.ts';
import { state, api } from '../core/app.ts';
import { confirmDialog } from '../core/confirm-dialog.ts';
import { checkRawHooks, supportedHooks } from '../battle/engine/sd-hooks.ts';

import { POKEMON_TYPES, SELECTABLE_TYPES, NATURE_DATA, NATURES, STAT_NAMES, TYPE_EFFECTIVENESS } from '../core/data.ts';
import { updateSampleSet } from './sample-sets.ts';
import { getFlagLabels, updateBulkComparison, updatePreview } from './editor-core.ts';
import { notify, notifySync } from '../app/store.ts';
import { closeDialog, openDialog } from '../app/dialogs.tsx';
import { abilityRole, prepareLearnset } from './learnset-model.ts';

// ==================== SHOWDOWN DATA ====================
        // Showdown's move dex has no numeric usefulness rating, so we derive one
        // from Showdown/Smogon sample-set frequency as a ranking signal (not a
        // hard requirement, so Fakemon-exclusive/custom moves still work).
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
                    for (const sets of Object.values<any>(data || {})) {
                        for (const set of Object.values<any>(sets || {})) {
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
                } catch (err: any) {
                    log.warn('SAMPLE SETS', 'Competitive move weights unavailable', { url, error: err });
                }
            }
            const values = Object.values<any>(state.sdMoveUsefulness);
            const max = Math.max(1, ...values);
            Object.keys(state.sdMoveUsefulness).forEach(name => {
                // log scaling prevents a few ubiquitous moves from drowning out others
                state.sdMoveUsefulness[name] = 1 + 11 * Math.log1p(state.sdMoveUsefulness[name]) / Math.log1p(max);
            });
        }

        // One place for the Showdown dataset URLs so the cache layer and the
        // lazy learnset loader cannot drift apart.
        const SD_DATA = {
            moves:     'https://play.pokemonshowdown.com/data/moves.json',
            abilities: 'https://play.pokemonshowdown.com/data/abilities.js',
            items:     'https://play.pokemonshowdown.com/data/items.js',
            pokedex:   'https://play.pokemonshowdown.com/data/pokedex.json',
            learnsets: 'https://play.pokemonshowdown.com/data/learnsets.json'
        };
        async function fetchShowdownData() {
            const done = log.time('SHOWDOWN', 'fetchShowdownData');
            log.info('SHOWDOWN', 'Fetching Showdown datasets');
            log.debug('SHOWDOWN', 'Requesting moves, abilities, items and pokedex (learnsets load separately)');

            try {
                // learnsets.json (3.2 of 4.3 MB total) isn't needed on the first
                // screen, so it's not awaited here -- see ensureLearnsets() below
                const [movesRes, abilitiesRes, itemsRes, pokedexRes] = await Promise.all([
                    cachedFetch(SD_DATA.moves),
                    cachedFetch(SD_DATA.abilities),
                    cachedFetch(SD_DATA.items),
                    cachedFetch(SD_DATA.pokedex)
                ]);

                const movesRaw = await movesRes.json();
                const abilitiesText = await abilitiesRes.text();
                const itemsText = await itemsRes.text();
                const pokedexRaw = await pokedexRes.json();

                // captures Showdown's own ability rating (-1 to 5, data/abilities.ts
                // upstream) so analysis.ts can score off it instead of a hand-curated list
                const abilitiesMatch = abilitiesText.match(/exports\.BattleAbilities\s*=\s*(\{[\s\S]*\});/);
                if (abilitiesMatch) {
                    let jsonStr = abilitiesMatch[1].replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_-]*)(\s*:)/g, '$1"$2"$3');
                    const abilitiesRaw = JSON.parse(jsonStr);
                    for (const [key, a] of Object.entries<any>(abilitiesRaw)) {
                        if (a.isNonstandard === 'Past') continue;
                        state.sdAbilities[key] = {
                            name: a.name || key,
                            desc: a.shortDesc || a.desc || '',
                            rating: typeof a.rating === 'number' ? a.rating : null,
                            // CAP abilities are negative; Browse Abilities hides them
                            num: Number(a.num) || 0
                        };
                    }
                }

                const itemsMatch = itemsText.match(/exports\.BattleItems\s*=\s*(\{[\s\S]*\});/);
                if (itemsMatch) {
                    let jsonStr = itemsMatch[1].replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_-]*)(\s*:)/g, '$1"$2"$3');
                    const itemsRaw = JSON.parse(jsonStr);
                    for (const [key, i] of Object.entries<any>(itemsRaw)) {
                        if (i.isNonstandard === 'Past') continue;
                        state.sdItems[key] = { name: i.name || key, desc: i.desc || i.shortDesc || '', num: Number(i.num) || 0, nonstandard: i.isNonstandard || '', spritenum: Number.isFinite(Number(i.spritenum)) ? Number(i.spritenum) : null };
                    }
                }

                // kept fields come from SD_MOVE_FIELDS so this can't silently drop
                // something the battle engine reads (it used to keep nine of eighteen,
                // leaving drain/recoil/multihit/secondaries/boosts/status inert)
                for (const [key, m] of Object.entries<any>(movesRaw)) {
                    if (m.isNonstandard === 'Future') continue;
                    const move: Record<string, any> = { name: m.name || key, category: m.category || 'Status', type: m.type || 'Normal' };
                    for (const field of SD_MOVE_FIELDS) {
                        if (move[field] === undefined && m[field] !== undefined) move[field] = m[field];
                    }
                    move.desc = m.desc || m.shortDesc || '';
                    // what a region's "National Dex" pool leaves out (js/features/regions.ts)
                    if (m.isNonstandard) move.nonstandard = m.isNonstandard;
                    if (m.isZ) move.isZ = true;
                    if (m.isMax) move.isMax = true;
                    state.sdMoves[key] = move;
                }

                // used to find real Pokemon similar to this Fakemon for learnset generation
                for (const [key, p] of Object.entries<any>(pokedexRaw)) {
                    if (!p.baseStats || !p.types || !p.num || p.num <= 0) continue; // skip CAP/nonstandard/formes w/o stats
                    // keep all usable alternate formes (regional, Mega, Totem, etc.) so
                    // they're usable as templates/comparisons
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
                        nonstandard: p.isNonstandard || '',
                        // the evolution line, so a Fakemon made from this species
                        // gets its family on the evolution board (see evolution.ts)
                        prevo: p.prevo || '', evos: p.evos || [],
                        evoLevel: p.evoLevel || null, evoType: p.evoType || '', evoItem: p.evoItem || '',
                        evoCondition: p.evoCondition || '', evoMove: p.evoMove || '',
                        // kept with the species record so template creation can
                        // populate the editor without guessing abilities from names
                        abilities: p.abilities || {}
                    };

                    // Showdown IDs omit punctuation (raticatealola) while users commonly
                    // use raticate-alola; alias both to the same record without duplicating
                    // entries in Object.values()/bulk comparison
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
                // learnsets are loaded separately -- see ensureLearnsets().

                state.sdLoaded = true;
                done({ moves: Object.keys(state.sdMoves).length, abilities: Object.keys(state.sdAbilities).length, items: Object.keys(state.sdItems).length, pokedex: Object.keys(state.sdPokedex).length });
                log.info('SHOWDOWN', 'Showdown datasets loaded', { moves: Object.keys(state.sdMoves).length, abilities: Object.keys(state.sdAbilities).length, items: Object.keys(state.sdItems).length, pokedex: Object.keys(state.sdPokedex).length });
                // a Fakemon may have loaded before this fetch completed; rehydrate its
                // minimal saved learnset now that vanilla move data is available
                rehydrateCurrentLearnsetFromShowdown();
                log.info('SHOWDOWN', 'Data loaded', { moves: Object.keys(state.sdMoves).length, species: Object.keys(state.sdPokedex).length, abilities: Object.keys(state.sdAbilities).length, items: Object.keys(state.sdItems).length });
                updateBulkComparison();
            } catch (err: any) {
                log.error('SHOWDOWN', 'Data loading failed', err);
                state.sdLoaded = false;
                api.showToast('Showdown data unavailable. Using custom entry only.', 'error');
            }
        }


        // largest Showdown dataset (3.2 of 4.3 MB), not needed on the collection
        // screen, so it loads on its own; the boot sequence kicks it off and
        // moves on, callers that need it await this. memoised so racing callers
        // produce one request, and a failure clears it so retry is possible.
        let learnsetsPromise: any = null;
        function ensureLearnsets() {
            if (state.sdLearnsetsLoaded) return Promise.resolve();
            learnsetsPromise ||= loadLearnsets().catch(err => {
                learnsetsPromise = null;
                log.error('SHOWDOWN', 'Learnset data failed to load', err);
            });
            return learnsetsPromise;
        }

        async function loadLearnsets() {
            const done = log.time('SHOWDOWN', 'loadLearnsets');
            const res = await cachedFetch(SD_DATA.learnsets);
            const learnsetsRaw = await res.json();
            // Parse learnsets (moveid -> array of "{gen}{method}{level?}" source strings)
            for (const [key, l] of Object.entries<any>(learnsetsRaw)) {
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
            state.sdLearnsetsLoaded = true;
            done({ learnsets: Object.keys(state.sdLearnsets).length });
        }

        
// ==================== AUTOCOMPLETE ====================
        // the search boxes on the Stats and Moves tabs (js/app/components/editor/Autocomplete.tsx)
        /** Up to 8 main-game abilities whose name contains the query. */
        function abilitySuggestions(query) {
            const q = String(query || '').trim().toLowerCase();
            if (!q) return [];
            return Object.entries<any>(state.sdAbilities).filter(([, v]) => v.name.toLowerCase().includes(q)).slice(0, 8).map(([k, v]) => ({ key: k, ...v }));
        }
        /** Up to 8 main-game moves whose name contains the query. */
        function moveSuggestions(query) {
            const q = String(query || '').trim().toLowerCase();
            if (!q) return [];
            return Object.entries<any>(state.sdMoves).filter(([, v]) => v.name.toLowerCase().includes(q)).slice(0, 8).map(([k, v]) => ({ key: k, ...v }));
        }
        function findClosestAbility(query) {
            if (!query.trim()) return null;
            const q = query.toLowerCase().trim();

            // Exact match (case-insensitive)
            let match = Object.entries<any>(state.sdAbilities).find(([k, v]) => v.name.toLowerCase() === q);
            if (match) return match[1];

            // Key exact match
            match = Object.entries<any>(state.sdAbilities).find(([k, v]) => k.toLowerCase() === q);
            if (match) return match[1];

            // Starts with
            let startsWith = Object.entries<any>(state.sdAbilities).filter(([k, v]) => v.name.toLowerCase().startsWith(q));
            if (startsWith.length === 1) return startsWith[0][1];
            if (startsWith.length > 1) {
                startsWith.sort((a, b) => a[1].name.length - b[1].name.length);
                return startsWith[0][1];
            }

            // Includes
            let includes = Object.entries<any>(state.sdAbilities).filter(([k, v]) => v.name.toLowerCase().includes(q));
            if (includes.length === 1) return includes[0][1];
            if (includes.length > 1) {
                includes.sort((a, b) => a[1].name.length - b[1].name.length);
                return includes[0][1];
            }

            // Word-boundary match
            let wordMatches = Object.entries<any>(state.sdAbilities).filter(([k, v]) => {
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
        /**
         * Adds the ability whose name best matches what was typed.
         * @returns whether one was found (no match leaves the text for more typing)
         */
        function addAbilityByName(text): boolean {
            const closest = findClosestAbility(String(text || ''));
            if (!closest) return false;
            addAbility(closest.name, 'sd');
            return true;
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

        /** The flags the browser filters by, as its chips name them. */
        const MOVE_BROWSER_FLAGS = Object.keys(MOVE_FLAG_KEYWORDS);

        function getAllBrowsableMoves() {
            const sd = Object.entries<any>(state.sdMoves).map(([k, v]) => ({ key: k, ...v }));
            const custom = (state.customMoves || []).map(m => ({ key: 'custom:' + m.name, ...m, custom: true }));
            const seen = new Set();
            return [...sd, ...custom].filter(m => {
                if (!m.name || seen.has(m.name.toLowerCase())) return false;
                seen.add(m.name.toLowerCase());
                return true;
            });
        }

        /**
         * Whether a move passes the browser's filters (js/app/dialogs/moveBrowser.tsx):
         * { name, type, category, priority: ''|'positive'|'zero'|'negative', bpMin, accMin, ppMin, flags: string[] }
         */
        function moveMatchesFilters(move, f: Record<string, any> = {}) {
            const name = String(f.name || '').trim().toLowerCase();
            if (name && !(move.name || '').toLowerCase().includes(name)) return false;
            if (f.type && move.type !== f.type) return false;
            if (f.category && move.category !== f.category) return false;
            const prio = Number(move.priority) || 0;
            if (f.priority === 'positive' && !(prio > 0)) return false;
            if (f.priority === 'negative' && !(prio < 0)) return false;
            if (f.priority === 'zero' && prio !== 0) return false;
            const bpMin = parseInt(f.bpMin, 10), accMin = parseInt(f.accMin, 10), ppMin = parseInt(f.ppMin, 10);
            if (Number.isFinite(bpMin) && (Number(move.basePower) || 0) < bpMin) return false;
            if (Number.isFinite(accMin)) {
                const acc = (move.accuracy === true || move.accuracy === undefined) ? 100 : (move.accuracy === false ? 0 : Number(move.accuracy) || 0);
                if (acc < accMin) return false;
            }
            if (Number.isFinite(ppMin) && (Number(move.pp) || 0) < ppMin) return false;
            if (f.flags?.length) {
                const flags = getMoveEditorFlags(move);
                for (const flag of f.flags) if (!flags[MOVE_FLAG_KEYWORDS[flag]]) return false;
            }
            return true;
        }

        /** Every move that passes the filters, A to Z, and which are already in the learnset. */
        function moveBrowserResults(filters) {
            const moves = getAllBrowsableMoves().filter(m => moveMatchesFilters(m, filters)).sort((a, b) => a.name.localeCompare(b.name));
            const added = new Set(state.learnset.filter(m => m && m.name).map(m => m.name.toLowerCase()));
            return moves.map(m => ({ ...m, added: added.has(m.name.toLowerCase()) }));
        }

        function openMoveBrowserModal() {
            openDialog('move-browser', { mode: 'editor' });
        }

        function addMoveFromBrowser(key) {
            const move = getAllBrowsableMoves().find(m => m.key === key);
            if (!move) return;
            // added the way the Moves tab's add row is set (level, TM, ...)
            const method = newMoveMethod.method;
            const level = method === 'level' ? newMoveMethod.level : null;
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
        }

// ==================== ability browser ====================
        // every Showdown ability, grouped the way the Showdown client's
        // teambuilder groups them for Balanced Hackmons (battle-dex-search.ts,
        // BattleAbilitySearch): by the ability's own rating, with Normalize
        // bumped to 3. The client's top bucket (3+) is split in two here so
        // the best abilities stand out from the merely solid ones.
        const ABILITY_GROUPS = [
            { id: 'good', label: 'Good Abilities', min: 4 },
            { id: 'normal', label: 'Normal Abilities', min: 3 },
            { id: 'situational', label: 'Situational Abilities', min: 2 },
            { id: 'unviable', label: 'Unviable Abilities', min: -Infinity }
        ];

        function abilityGroupFor(id, rating) {
            const r = id === 'normalize' ? 3 : (Number(rating) || 0);
            return ABILITY_GROUPS.find(g => r >= g.min);
        }

        let browsableAbilityCache: any = null;
        let browsableAbilitySource: any = null;
        function getBrowsableAbilities() {
            if (browsableAbilityCache && browsableAbilitySource === state.sdAbilities) return browsableAbilityCache;
            browsableAbilityCache = Object.entries<any>(state.sdAbilities || {})
                // CAP abilities have num < 0; "No Ability" is 0
                .filter(([, a]) => a && a.name && (Number(a.num) || 0) > 0)
                .map(([id, a]) => ({ id, name: a.name, desc: a.desc || '', group: abilityGroupFor(id, a.rating) }));
            browsableAbilitySource = state.sdAbilities;
            return browsableAbilityCache;
        }

        function openAbilityBrowserModal() {
            if (!state.sdLoaded) { api.showToast('Ability data is still loading. Try again in a moment.', 'info'); return; }
            openDialog('ability-browser', {});
        }

        /**
         * The ability browser's list: filtered, sorted, and (by default) in the
         * client's Balanced Hackmons groups.
         */
        function abilityBrowserResults({ query = '', group = '', sort = 'default' }: { query?: any; group?: any; sort?: any } = {}): { count: number, full: boolean, groups: Array<{ id, label, rows: Array<{ id, name, desc, group, added }> }> } {
            const q = String(query).trim().toLowerCase();
            const matches = getBrowsableAbilities()
                .filter(a => (!group || a.group.id === group) && (!q || a.name.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q)))
                .sort((a, b) => a.name.localeCompare(b.name));
            if (sort === 'za') matches.reverse();
            const taken = new Set(state.abilities.map(a => (a.name || '').toLowerCase()));
            const rows = matches.map(a => ({ ...a, added: taken.has(a.name.toLowerCase()) }));
            const groups = sort !== 'default'
                ? [{ id: 'all', label: '', rows }]
                : ABILITY_GROUPS.map(g => ({ id: g.id, label: g.label, rows: rows.filter(a => a.group.id === g.id) })).filter(g => g.rows.length);
            return { count: matches.length, full: state.abilities.length >= 4, groups };
        }

        function addAbilityFromBrowser(id) {
            const ability = state.sdAbilities?.[id];
            if (!ability) return;
            if (state.abilities.some(a => (a.name || '').toLowerCase() === ability.name.toLowerCase())) return;
            addAbility(ability.name, 'sd');
        }

// ==================== MOVE LOOKUP ====================
        function findClosestMove(query) {
            if (!query.trim()) return null;
            const q = query.toLowerCase().trim();

            // Exact match (case-insensitive)
            let match = Object.entries<any>(state.sdMoves).find(([k, v]) => v.name.toLowerCase() === q);
            if (match) return match[1];

            // Key exact match
            match = Object.entries<any>(state.sdMoves).find(([k, v]) => k.toLowerCase() === q);
            if (match) return match[1];

            // Starts with
            let startsWith = Object.entries<any>(state.sdMoves).filter(([k, v]) => v.name.toLowerCase().startsWith(q));
            if (startsWith.length === 1) return startsWith[0][1];
            if (startsWith.length > 1) {
                startsWith.sort((a, b) => a[1].name.length - b[1].name.length);
                return startsWith[0][1];
            }

            // Includes
            let includes = Object.entries<any>(state.sdMoves).filter(([k, v]) => v.name.toLowerCase().includes(q));
            if (includes.length === 1) return includes[0][1];
            if (includes.length > 1) {
                includes.sort((a, b) => a[1].name.length - b[1].name.length);
                return includes[0][1];
            }

            // Word-boundary match
            let wordMatches = Object.entries<any>(state.sdMoves).filter(([k, v]) => {
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
            if (!raw) return { move: null as any, corrected: false, distance: Infinity };
            const normalized = normalizeMoveLookupName(raw);
            if (!normalized) return { move: null as any, corrected: false, distance: Infinity };

            // Exact normalized match first: handles capitalization, spaces, hyphens,
            // apostrophes, and other harmless formatting differences.
            const exact = Object.values<any>(state.sdMoves).find(move =>
                normalizeMoveLookupName(move.name) === normalized
            );
            if (exact) return { move: exact, corrected: false, distance: 0 };

            let best: any = null;
            for (const move of Object.values<any>(state.sdMoves)) {
                const candidate = normalizeMoveLookupName(move.name);
                const distance = levenshteinDistance(normalized, candidate);
                const maxLen = Math.max(normalized.length, candidate.length);
                const ratio = maxLen ? distance / maxLen : 1;
                if (!best || distance < best.distance ||
                    (distance === best.distance && ratio < best.ratio)) {
                    best = { move, distance, ratio };
                }
            }

            if (!best) return { move: null as any, corrected: false, distance: Infinity };

            // Conservative typo correction. Short names get a tighter threshold;
            // longer names can tolerate a few transpositions/typos.
            const threshold = normalized.length <= 4 ? 1 : normalized.length <= 7 ? 2 : 4;
            const ratioThreshold = normalized.length <= 5 ? 0.4 : 0.45;
            if (best.distance <= threshold && best.ratio <= ratioThreshold) {
                return { move: best.move, corrected: true, distance: best.distance };
            }
            return { move: null as any, corrected: false, distance: best.distance };
        }

        function normalizeMoveCategoryInput(value) {
            const v = String(value || '').trim().toLowerCase();
            if (v.startsWith('phys')) return 'Physical';
            if (v.startsWith('spec')) return 'Special';
            if (v.startsWith('stat')) return 'Status';
            return 'Status';
        }

        function normalizeMoveTypeInput(value) {
            const v = String(value || '').trim().toLowerCase();
            const match = SELECTABLE_TYPES.find(t => t.toLowerCase() === v);
            return match || 'Normal';
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


        function formatCustomMoveForImportExport(move) {
            const accText = (move.accuracy === true || move.accuracy === undefined || move.accuracy === false) ? '-' : `${move.accuracy}%`;
            const flags = getFlagLabels(move.flags || {}, move.category);
            const flagText = flags.length ? flags.join(' | ') : 'None';
            const description = (move.desc || move.description || '').trim();
            return [
                `${move.name} !`,
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

        /** The learnset as text: names (custom ones marked "!"), then each custom move's details. */
        function getExportableMovesText(sort = 'name', order = 'asc') {
            const entries = sortLearnsetEntries(state.learnset, sort, order);
            const names = entries.map(move => `${move.name}${isCustomMove(move) ? '!' : ''}`);
            const customBlocks = entries.filter(isCustomMove).map(formatCustomMoveForImportExport);
            return names.join('\n') + (customBlocks.length ? `\n\n${customBlocks.join('\n\n')}` : '');
        }

        function openMoveImportExportModal() {
            openDialog('move-import-export', {});
        }

        function stripCustomMoveMarker(line) {
            // Accepts the current "!" custom-move marker as well as the legacy
            // "*" marker, with or without a space before it, so older exports
            // and hand-typed lists still import cleanly.
            const trimmed = String(line || '').trim();
            const match = trimmed.match(/^(.*?)\s*[!*]$/);
            if (!match) return { isCustom: false, name: trimmed };
            return { isCustom: true, name: match[1].trim() };
        }

        function parseCustomMoveImportBlock(lines, startIndex) {
            const header = String(lines[startIndex] || '').trim();
            const headerParsed = stripCustomMoveMarker(header);
            if (!headerParsed.isCustom) return null;
            const name = headerParsed.name;
            if (!name) return { nextIndex: startIndex + 1, move: null as any };

            const details: any[] = [];
            let i = startIndex + 1;
            while (i < lines.length && details.length < 4) {
                const line = String(lines[i] || '').trim();
                if (!line) { i++; continue; }
                if (details.length < 3 && stripCustomMoveMarker(line).isCustom) break;
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
            const flags: Record<string, any> = {};
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
                    type: normalizeMoveTypeInput(categoryType[1]),
                    category: normalizeMoveCategoryInput(categoryType[0]),
                    basePower: parseStat(stats[0], 0),
                    accuracy: acc,
                    pp,
                    priority: 0,
                    flags,
                    desc,
                    source: 'custom',
                    custom: true,
                    learnMethod: 'none',
                    level: null as any
                }
            };
        }

        /**
         * Replaces the learnset with the moves in the text (Import / Export Moves).
         * @returns the learnset as text afterwards, or null when nothing was imported
         */
        function importMovesFromText(text, { sort = 'name', order: importOrder = 'asc' }: { sort?: any; order?: any } = {}): string|null {
            log.info('MOVE IMPORT', 'Starting move text import');
            if (!state.sdLoaded) {
                api.showToast('Showdown move data is still loading. Try again shortly.', 'error');
                return null;
            }
            text = String(text || '');
            const lines = text.replace(/\r/g, '').split('\n');
            const separator = lines.findIndex((line, index) => !line.trim() && lines.slice(index + 1).some(l => l.trim()));
            const nameLines = separator >= 0 ? lines.slice(0, separator) : lines;
            const detailLines = separator >= 0 ? lines.slice(separator + 1) : [];
            const importedByKey = new Map();
            const order: any[] = [];
            const customKeys = new Set();
            let corrected = 0;
            let invalid = 0;

            // Read only the first section as the ordered move-name list.
            nameLines.forEach(line => {
                parseMoveImportText(line).forEach(entry => {
                    const { isCustom, name: cleanName } = stripCustomMoveMarker(entry);
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
                    importedByKey.set(canonicalKey, hydrateLearnsetEntry({ name: result.move.name, learnMethod: 'none', level: null as any }));
                });
            });

            // Read custom definitions after the blank separator.
            for (let i = 0; i < detailLines.length;) {
                const line = detailLines[i].trim();
                if (!line) { i++; continue; }
                if (!stripCustomMoveMarker(line).isCustom) { invalid++; i++; continue; }
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
                return null;
            }

            state.learnset = sortLearnsetEntries(imported, sort, importOrder);
            log.info('MOVE IMPORT', 'Applied imported moves to learnset', { count: state.learnset.length });
            renderLearnset();
            updatePreview();
            api.autoSave();

            const customCount = imported.filter(isCustomMove).length;
            const standardCount = imported.length - customCount;
            const parts = [`Imported ${imported.length} move${imported.length === 1 ? '' : 's'}`];
            if (standardCount) parts.push(`${standardCount} standard`);
            if (customCount) parts.push(`${customCount} custom`);
            if (corrected) parts.push(`corrected ${corrected}`);
            if (invalid) parts.push(`${invalid} invalid`);
            api.showToast(parts.join(' · ') + '.', invalid ? 'warning' : 'success');
            return getExportableMovesText(sort, importOrder);
        }

        // how a move added from the Moves tab (or the move browser) is learned
        let newMoveMethod = { method: 'none', level: '' };
        function getNewMoveMethod() { return newMoveMethod; }
        function setNewMoveMethod(patch) { newMoveMethod = { ...newMoveMethod, ...patch }; notifySync(); }

        /**
         * Adds the move whose name best matches what was typed.
         * @returns whether one was found
         */
        function addMoveByName(text, method = 'none', level: any = null): boolean {
            const name = String(text || '').trim();
            if (!name) return false;
            const closest = findClosestMove(name);
            if (!closest) {
                api.showToast('Move not found: "' + name + '"', 'error');
                return false;
            }
            addLearnsetMove(closest, method, method === 'level' ? level : null);
            return true;
        }

// ==================== ABILITIES ====================
        let editingCustomAbilityIndex: any = null;
        function resetEditingCustomAbilityIndex() { editingCustomAbilityIndex = null; }
        function addAbility(name, source, description?) {
            name = (name || '').trim();
            if (!name) return;
            if (state.abilities.length >= 4) {
                api.showToast('A Pokemon can have a maximum of 4 abilities.', 'error');
                return;
            }
            if (state.abilities.some(a => (a.name || '').toLowerCase() === name.toLowerCase())) return;

            const isCustom = source === 'custom';
            const sdEntry = Object.entries<any>(state.sdAbilities).find(([k, v]) => v.name === name);
            state.abilities.push({
                name,
                source: isCustom ? 'custom' : 'sd',
                desc: isCustom ? (description || '') : ((sdEntry && sdEntry[1].desc) || '')
            });
            renderAbilities();
            updatePreview();
            api.autoSave();
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
        }

        /** Which custom ability is open for editing in place, if any. */
        function getEditingAbilityIndex() { return editingCustomAbilityIndex; }

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

        // Which slot an ability sits in is positional -- see abilityRole() in
        // ./learnset-model.ts, which is where that rule now lives.
        function getAbilityRole(index) {
            return abilityRole(index, state.abilities.length);
        }

        // Resolving what an ability actually says means looking in two places:
        // the Showdown dataset for a vanilla ability, and this Fakemon's own
        // custom-ability library for a coded one. The list component asks rather
        // than reaching into editor state itself.
        function describeAbility(a) {
            const isCustom = a.source === 'custom' || a.custom === true;
            const sdEntry = Object.entries<any>(state.sdAbilities).find(([, v]) => v.name === a.name);
            const desc = isCustom
                ? (a.desc || a.description || '')
                : ((sdEntry && sdEntry[1].desc) || a.desc || '');
            const libEntry = isCustom && a.customId
                ? (state.customAbilities || []).find(x => x.id === a.customId)
                : null;
            return { isCustom, desc, isCoded: !!(libEntry && libEntry.blocks && libEntry.blocks.trigger) };
        }

        // drawn by js/app/components/editor/lists.tsx
        function renderAbilities() { notify(); }

import { esc as escapeHtml, esc as escapeHtmlAttr } from '../core/html.ts';
import { form } from './draft.ts';

        function escapeJsString(value) {
            return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        }

        function showAbilityDetail(name) {
            const entry = Object.values<any>(state.sdAbilities).find(v => v.name === name);
            const ability = state.abilities.find(a => a.name === name);
            const desc = (ability && (ability.desc || ability.description)) || (entry && entry.desc) || 'No description available.';
            openDialog('detail', { title: name, text: desc });
        }

        // Legacy compatibility for older inline calls / imported data.
        function updateCustomAbility(index, field, value) { updateAbility(index, field === 'description' ? 'desc' : field, value); }
        function removeCustomAbility(index) { removeAbility(index); }
        function renderCustomAbilities() { renderAbilities(); }
// ==================== LEARNSET ====================
        // learnset entries are saved with just {name, learnMethod, level}; everything
        // else is vanilla move data re-derived from the Showdown dataset here
        function getSdMoveByName(name) {
            if (!name) return null;
            return Object.values<any>(state.sdMoves).find(v => v.name === name) || null;
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

        // Showdown's protect/reflectable/snatch flags mean the move IS affected;
        // this editor's convention is the opposite (checked = BYPASSES it), so
        // invert only vanilla data -- custom moves already use our convention
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

        // re-hydrate saved name/method/level entries once vanilla data loads,
        // in case the editor opened before Showdown finished loading
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
        // the list, its filters and the chart are drawn by the Moves tab
        function renderLearnset() {
            log.debug('LEARNSET', 'Rendering learnset', { count: state.learnset.length });
            notify();
        }

        const LEARNSET_FILTERS = { query: '', type: '', category: '', sort: 'default', order: 'desc' };
        let learnsetFilters = { ...LEARNSET_FILTERS };
        let learnsetChartGroup = 'type';

        function getLearnsetFilters() { return learnsetFilters; }
        function setLearnsetFilters(patch) {
            learnsetFilters = { ...learnsetFilters, ...patch };
            // the search box is a controlled input (see notifySync)
            notifySync();
        }

        /**
         * The learnset as the Moves tab lists it: filtered and sorted, each entry
         * keeping its real index so edits still hit the right move (prepareLearnset
         * in ./learnset-model.ts).
         */
        function learnsetEntries() {
            return prepareLearnset(state.learnset, {
                query: learnsetFilters.query.trim().toLowerCase(),
                typeFilter: learnsetFilters.type,
                catFilter: learnsetFilters.category,
                sortMode: learnsetFilters.sort,
                order: learnsetFilters.order,
                isCustomMove
            });
        }

// ==================== LEARNSET BREAKDOWN CHART ====================
        // Donut chart of the *entire* state.learnset (independent of the search/filter controls
        // above), switchable between Type / Category / Learn Method.
        const TYPE_COLORS = {
            Normal: '#A8A878', Fire: '#F08030', Water: '#6890F0', Electric: '#F8D030',
            Grass: '#78C850', Ice: '#98D8D8', Fighting: '#C03028', Poison: '#A040A0',
            Ground: '#E0C068', Flying: '#A890F0', Psychic: '#F85888', Bug: '#A8B820',
            Rock: '#B8A038', Ghost: '#705898', Dragon: '#7038F8', Dark: '#705848',
            Steel: '#B8B8D0', Fairy: '#EE99AC', '???': '#68A090', Stellar: '#40B5A5'
        };
        const CATEGORY_COLORS = { Physical: '#cc8844', Special: '#4466cc', Status: '#44aa44' };
        const METHOD_META = {
            level: { label: 'Level-Up', color: '#4a90d9' },
            egg: { label: 'Egg Move', color: '#e08ac0' },
            tm: { label: 'TM/Tutor', color: '#9b6fd1' },
            none: { label: 'Unassigned', color: '#999999' }
        };

        function getLearnsetChartGroup() { return learnsetChartGroup; }
        function setLearnsetChartGroup(group) { learnsetChartGroup = group; notify(); }

        /** The whole learnset (not just what the filters show) grouped by type, category or learn method. */
        function learnsetChartSegments(groupBy = learnsetChartGroup) {
            const groups: Record<string, any> = {};
            state.learnset.forEach(m => {
                let key, color;
                if (groupBy === 'type') { key = m.type || 'Normal'; color = TYPE_COLORS[key] || '#999'; }
                else if (groupBy === 'category') { key = m.category || 'Status'; color = CATEGORY_COLORS[key] || '#999'; }
                else { const meta = METHOD_META[m.learnMethod] || METHOD_META.none; key = meta.label; color = meta.color; }
                if (!groups[key]) groups[key] = { value: 0, color };
                groups[key].value++;
            });
            return Object.entries<any>(groups).map(([label, g]) => ({ label, value: g.value, color: g.color })).sort((a, b) => b.value - a.value);
        }

        function clearLearnsetFilters() {
            setLearnsetFilters({ ...LEARNSET_FILTERS });
            api.showToast('Filters cleared', 'info');
        }

// ==================== UNIVERSAL MOVES ====================
        const UNIVERSAL_MOVES = ['Toxic', 'Hidden Power', 'Tera Blast', 'Protect', 'Frustration', 'Return', 'Double Team', 'Facade', 'Rest', 'Attract', 'Round', 'Swagger', 'Sleep Talk', 'Substitute'];

        async function addUniversalMoves() {
            await ensureLearnsets();
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
                hp: parseInt(String(form.stats.hp)) || 0,
                atk: parseInt(String(form.stats.atk)) || 0,
                def: parseInt(String(form.stats.def)) || 0,
                spa: parseInt(String(form.stats.spa)) || 0,
                spd: parseInt(String(form.stats.spd)) || 0,
                spe: parseInt(String(form.stats.spe)) || 0
            };
        }

        // Reads this Fakemon's full profile (typing, stats, height/weight, color, egg
        // groups, gender ratio) - everything we use to find real Pokemon it resembles.
        function getFakemonProfile() {
            const type1 = form.type1;
            const type2 = form.type2;
            const heightVal = parseFloat(form.height || '');
            const heightUnit = form.heightUnit || 'm';
            const weightVal = parseFloat(form.weight || '');
            const weightUnit = form.weightUnit || 'kg';
            // Convert to metric for internal comparison
            const heightm = !isNaN(heightVal) ? (heightUnit === 'ft' ? heightVal / 3.28084 : heightVal) : null;
            const weightkg = !isNaN(weightVal) ? (weightUnit === 'lb' ? weightVal / 2.20462 : weightVal) : null;
            const color = form.color || '';
            const egg1 = form.egg1 || '';
            const egg2 = form.egg2 || '';
            const genderless = form.genderless;
            return {
                types: [type1, type2].filter(Boolean),
                stats: getFakemonStats(),
                heightm: heightm,
                weightkg: weightkg,
                color,
                eggGroups: [egg1, egg2].filter(Boolean),
                genderPct: genderless ? -1 : form.male
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
            const scored: any[] = [];
            for (const dex of Object.values<any>(state.sdPokedex)) {
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
                if (/^\d+E$/.test(s)) return { method: 'egg', level: null as any };
            }
            for (const s of sources) {
                if (/^\d+[MT]$/.test(s)) return { method: 'tm', level: null as any };
            }
            return null;
        }

        // "signature" (too exclusive to hand out) if only a couple real species
        // can learn it, e.g. Fleur Cannon. Computed once across the full
        // learnsets dataset and cached, since it's Fakemon-independent.
        const SIGNATURE_MOVE_MAX_LEARNERS = 2;
        function getSignatureMoveIds() {
            if (state.signatureMoveIds) return state.signatureMoveIds;
            const counts: Record<string, any> = {};
            for (const learnset of Object.values<any>(state.sdLearnsets)) {
                for (const moveId of Object.keys(learnset)) {
                    counts[moveId] = (counts[moveId] || 0) + 1;
                }
            }
            const sig = new Set();
            for (const [moveId, count] of Object.entries<any>(counts)) {
                if (count <= SIGNATURE_MOVE_MAX_LEARNERS) sig.add(moveId);
            }
            state.signatureMoveIds = sig;
            return sig;
        }

        // aggregates similar Pokemon's learnsets into weighted move pools, so a
        // move only lands at Lv.1 here if similar mons actually learn it that early
        function buildSimilarMovePools(profile) {
            const similar = findSimilarPokemon(profile, 25);
            const signatureMoveIds = getSignatureMoveIds();
            const agg: Record<string, any> = {};

            const addMoveSource = (moveId, sources, weight, supporterName) => {
                if (signatureMoveIds.has(moveId)) return;
                const classified = classifyLearnsetSource(sources);
                if (!classified) return;
                const mv = state.sdMoves[moveId];
                if (!mv) return;
                if (!agg[mv.name]) {
                    agg[mv.name] = {
                        move: mv, weight: 0, levelWeightedSum: 0, levelWeight: 0,
                        level: 0, egg: 0, tm: 0, supporters: [] as any[]
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

            similar.forEach(({ dex, score }: { dex?: any; score?: any }, rank) => {
                const learnsetData = getPokemonLearnsetData(dex.id);
                if (!learnsetData) return;
                const weight = score / (1 + rank * 0.12);
                for (const [moveId, sources] of Object.entries<any>(learnsetData)) {
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

                    // keep own-Fakemon contributions meaningful but secondary to
                    // the National Dex similarity pool
                    const ownWeight = Math.max(0.35, (typeSimilarity * 0.65) + (statSimilarity * 0.35));

                    const ownLearnset = Array.isArray(fakemon.learnset) ? fakemon.learnset : [];
                    ownLearnset.forEach(entry => {
                        if (!entry || !entry.name) return;
                        const move = findClosestMove(entry.name);
                        if (!move) return;
                        const method = entry.learnMethod || 'tm';
                        // addMoveSource runs `sources` through classifyLearnsetSource, which
                        // expects a Showdown-style array like ["9L16"], not a {method,level}
                        // object -- must build that array shape here
                        const source = method === 'level'
                            ? [`9L${Number(entry.level) || 1}`]
                            : method === 'egg' ? ['9E'] : ['9M'];
                        addMoveSource(move.id || move.name.toLowerCase().replace(/[^a-z0-9]/g, ''), source, ownWeight, fakemon.name);
                    });
                });
            }

            const entries = Object.values<any>(agg).sort((a, b) => b.weight - a.weight);
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

        // name-based role classifiers, used only to bucket already similarity-selected
        // moves into categories; selection and levels come from the similarity engine above
        const SETUP_MOVE_NAMES = new Set(['Swords Dance', 'Nasty Plot', 'Calm Mind', 'Bulk Up', 'Dragon Dance', 'Coil', 'Quiver Dance', 'Tail Glow', 'Shell Smash', 'Growth', 'Work Up', 'Hone Claws', 'Iron Defense', 'Amnesia', 'Cotton Guard', 'Acid Armor', 'Cosmic Power', 'Stockpile', 'Rock Polish', 'Autotomize', 'Agility']);
        const SPEED_MOVE_NAMES = new Set(['Agility', 'Rock Polish', 'Autotomize', 'Dragon Dance']);
        const RECOVERY_MOVE_NAMES = new Set(['Recover', 'Roost', 'Rest', 'Slack Off', 'Synthesis', 'Moonlight', 'Morning Sun', 'Milk Drink', 'Soft-Boiled', 'Shore Up', 'Wish', 'Strength Sap']);
        const UTILITY_MOVE_NAMES = new Set(['Toxic', 'Will-O-Wisp', 'Thunder Wave', 'Stealth Rock', 'Spikes', 'Toxic Spikes', 'Sticky Web', 'Taunt', 'Knock Off', 'Trick', 'Switcheroo', 'Encore', 'Disable', 'Haze', 'Defog', 'Rapid Spin', 'Substitute', 'Protect', 'Detect', 'Light Screen', 'Reflect', 'Aurora Veil', 'Leech Seed', 'Confuse Ray', 'Yawn', 'Glare']);
        // damaging moves too weak/situational/secondary-effect-focused to count as
        // real STAB/Coverage get bucketed as Flavour: a min power floor plus named
        // exclusions for conditional-type moves and secondary-effect attacks
        const MIN_STAB_COVERAGE_BP = 65;
        const CONDITIONAL_TYPE_MOVE_NAMES = new Set(['Tera Blast', 'Hidden Power', 'Judgment', 'Weather Ball', 'Natural Gift', 'Techno Blast', 'Multi-Attack', 'Revelation Dance', 'Terrain Pulse', 'Raging Bull', 'Ivy Cudgel']);
        const FILLER_ATTACK_MOVE_NAMES = new Set([
            'Round', 'Snore', 'Thief', 'Covet', 'Tackle', 'Pound', 'Scratch', 'Constrict', 'Present',
            'Bide', 'Rage', 'Fury Attack', 'Fury Swipes', 'Take Down', 'Submission', 'Headbutt',
            'Mega Drain', 'Absorb', 'Vine Whip', 'Razor Leaf', 'Ember', 'Water Gun', 'Bubble',
            'Powder Snow', 'Gust', 'Peck', 'Astonish', 'Lick', 'Nuzzle', 'Pounce',
            'Fling', 'Natural Gift', 'Echoed Voice', 'Struggle Bug', 'Infestation'
        ]);
        // Showdown lists basePower 0 for dynamically-computed moves; without this
        // estimate, strong moves like Facade/Return/Gyro Ball look like 0-power filler
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
        // only counts as "coverage" if super-effective against something the
        // Fakemon's own STAB doesn't already hit hard; a neutral-everywhere
        // off-type move is just Flavour
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

        // remembers name -> {learnMethod, level} so clicking a recommendation adds
        // it with the method/level it was suggested with, not a default TM
        let lastRecommendations: Record<string, any> = {};

        function generateMoveRecommendations() {
            const profile = getFakemonProfile();
            const learnedNames = new Set(state.learnset.map(m => m.name));
            const sections: any[] = [];
            if (!profile.types.length) return { sections, needsType: true };

            const pools = buildSimilarMovePools(profile);
            const candidates = [
                ...pools.levelPool.map(e => ({ move: e.move, weight: e.weight, supporters: e.supporters, learnMethod: 'level', level: e.avgLevel })),
                ...pools.eggPool.map(e => ({ move: e.move, weight: e.weight, supporters: e.supporters, learnMethod: 'egg', level: null as any })),
                ...pools.tmPool.map(e => ({ move: e.move, weight: e.weight, supporters: e.supporters, learnMethod: 'tm', level: null as any }))
            ].filter(e => !learnedNames.has(e.move.name));

            const buckets = { stab: [] as any[], flavour: [] as any[], setup: [] as any[], speed: [] as any[], recovery: [] as any[], utility: [] as any[], coverage: [] as any[] };
            candidates.forEach(e => buckets[classifyMoveRole(e.move, profile.types)].push(e));

            // collapse slight variations of the same job down to the strongest
            // representative per type+category, avoiding near-identical redundant picks
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

            Object.values<any>(buckets).forEach(arr => arr.sort((a, b) => b.weight - a.weight));

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

        async function openRecommendMovesModal() {
            await ensureLearnsets();
            if (!state.sdLoaded) { api.showToast('Showdown data still loading, try again shortly.', 'error'); return; }
            openDialog('recommend-moves', {});
        }

        /**
         * The Recommended Moves list: sections of { move, reason }, remembering how
         * each would be learned for selectRecommendedMove().
         */
        function moveRecommendations() {
            const { sections, needsType } = generateMoveRecommendations();
            lastRecommendations = {};
            (sections || []).forEach(sec => sec.moves.forEach(({ move, learnMethod, level }: { move?: any; learnMethod?: any; level?: any }) => {
                lastRecommendations[move.name] = { learnMethod, level };
            }));
            return { sections: sections || [], needsType: !!needsType };
        }
        // the dialog redraws its own list
        function renderRecommendMovesModal() { notify(); }

        function selectRecommendedMove(name) {
            const move = findClosestMove(name);
            if (!move) return;
            const meta = lastRecommendations[name] || { learnMethod: 'tm', level: null as any };
            addLearnsetMove(move, meta.learnMethod, meta.level);
            api.autoSave();
            const methodLabel = meta.learnMethod === 'level' ? `Lv.${meta.level}` : meta.learnMethod.toUpperCase();
            api.showToast(`Added ${move.name} (${methodLabel})!`, 'success');
        }


// ==================== FULL LEARNSET GENERATOR ====================
        // produces a plausible level-up curve + egg moves + TMs by aggregating similar
        // real Pokemon's Showdown learnsets, weighted by similarity. moves already in
        // the learnset are woven in (method/level updated) rather than duplicated.
        async function generateLearnset() {
            await ensureLearnsets();
            if (!state.sdLoaded) { api.showToast('Showdown data still loading, try again shortly.', 'error'); return; }
            const profile = getFakemonProfile();
            if (!profile.types.length) { api.showToast('Set a primary type first so we can generate a state.learnset.', 'error'); return; }

            const pools = buildSimilarMovePools(profile);
            if (!pools.levelPool.length && !pools.eggPool.length && !pools.tmPool.length) {
                api.showToast('Not enough similar Pokémon data to generate a state.learnset yet.', 'error');
                return;
            }

            const placements: any[] = []; // {move, learnMethod, level}
            const usedNames = new Set();

            // a flat "top 18 by weight" biases hard toward widely-shared low-level
            // moves and starves rarer high-level ones; bucket across the 1-100 curve
            // instead so the learnset can span up to Lv.100
            const LEVEL_BUCKET_COUNT = 5;
            const PICKS_PER_BUCKET = 4;
            const bucketSize = 100 / LEVEL_BUCKET_COUNT;
            const levelBuckets = Array.from({ length: LEVEL_BUCKET_COUNT }, () => ([] as any[]));
            pools.levelPool.forEach(e => {
                const idx = Math.min(LEVEL_BUCKET_COUNT - 1, Math.floor((e.avgLevel - 1) / bucketSize));
                levelBuckets[idx].push(e);
            });
            const levelPicks: any[] = [];
            levelBuckets.forEach((bucket, idx) => {
                const sortedBucket = [...bucket].sort((a, b) => b.weight - a.weight);
                const picks = sortedBucket.slice(0, PICKS_PER_BUCKET);
                if (idx === 0) {
                    // hold a couple spots for weak "starter" attacks (Tackle/Pound/etc.)
                    // that would otherwise lose out to stronger same-level moves, so
                    // early learnsets don't look unrealistically strong right away
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

            [...pools.eggPool].sort((a, b) => b.weight - a.weight).slice(0, 4).forEach(e => {
                if (usedNames.has(e.move.name)) return;
                usedNames.add(e.move.name);
                placements.push({ move: e.move, learnMethod: 'egg', level: null as any });
            });

            [...pools.tmPool].sort((a, b) => b.weight - a.weight).slice(0, 6).forEach(e => {
                if (usedNames.has(e.move.name)) return;
                usedNames.add(e.move.name);
                placements.push({ move: e.move, learnMethod: 'tm', level: null as any });
            });

            // reuse-in-place if already present, otherwise add as a new entry
            let woven = 0, added = 0;
            const addedMoves: any[] = [];
            const wovenMoves: any[] = [];
            placements.forEach(({ move, learnMethod, level }: { move?: any; learnMethod?: any; level?: any }) => {
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
            updatePreview();
            api.autoSave();
            const sampleSimilar = pools.similar.slice(0, 3).join(', ');
            api.showToast(`Generated from Pokémon like ${sampleSimilar}: ${added} added, ${woven} woven in.`, 'success');
            closeDialog('recommend-moves');
            if (addedMoves.length || wovenMoves.length) openDialog('generated-learnset', { added: addedMoves, woven: wovenMoves, similar: sampleSimilar });
        }

        function formatLearnMethodLabel(learnMethod, level) {
            if (learnMethod === 'level') return `Lv.${level ?? '?'}`;
            if (learnMethod === 'tm') return 'TM';
            if (learnMethod === 'egg') return 'Egg';
            return learnMethod || '-';
        }

        async function clearMoveset() {
            if (!state.learnset.length) { api.showToast('Learnset is already empty.', 'info'); return; }
            if (!await confirmDialog({ title: `Clear all ${state.learnset.length} move${state.learnset.length === 1 ? '' : 's'}?`, message: 'The whole learnset is emptied. This can’t be undone.', confirmLabel: 'Clear moveset' })) return;
            state.learnset = [];
            renderLearnset();
            updatePreview();
            api.autoSave();
            api.showToast('Moveset cleared.', 'success');
        }

        /** A move in the open Fakemon's learnset, in the detail popup (js/app/dialogs/details.tsx). */
        function showMoveDetail(name) {
            log.debug('MOVE INFO', 'Opening move detail', { name });
            if (!state.learnset.some(m => m.name === name)) return;
            openDialog('move-detail', { name });
        }

        /** Everything the move popup shows. */
        function moveDetail(name) {
            const move = state.learnset.find(m => m.name === name);
            if (!move) return null;
            const sdEntry = Object.values<any>(state.sdMoves).find(v => v.name === name);
            const flags = getMoveEditorFlags({
                ...move,
                // multihit is a top-level Showdown property, not inside `flags`
                multihit: isCustomMove(move) ? move.multihit : (sdEntry ? sdEntry.multihit : move.multihit),
                flags: isCustomMove(move) ? (move.flags || {}) : (sdEntry ? (sdEntry.flags || {}) : (move.flags || {}))
            });
            const priority = move.priority || 0;
            return {
                name: move.name, type: move.type || 'Normal', category: move.category || 'Status',
                basePower: move.basePower || '-',
                accuracy: move.accuracy === true || move.accuracy === false ? '-' : `${move.accuracy}%`,
                pp: move.pp || '-', priority: priority > 0 ? `+${priority}` : `${priority}`,
                flags: getFlagLabels(flags, move.category),
                desc: sdEntry ? sdEntry.desc : (move.desc || 'No description available.')
            };
        }


// ==================== CUSTOM ENTITIES ====================
        // Custom abilities are now part of the unified state.abilities list.
        // Legacy custom-ability functions are kept as aliases in the Abilities section above.

        
// ==================== CUSTOM ABILITY LIBRARY ====================
        // The editors themselves are js/app/dialogs/libraryEditors.tsx; these
        // open them and save what they hand back.

        // ==================== hand-written battle code ====================
        // escape hatch for writing code instead of blocks; stored as `rawCode`
        // and compiled by sd-hooks.ts, the same bridge Showdown's own moves/
        // items/abilities go through -- Showdown hook syntax, nothing new to learn.

        /**
         * Auto-repairs a missing comma/stray semicolon, so code doesn't persist
         * broken; only punctuation is rewritten -- a full module/TypeScript
         * paste is otherwise left untouched.
         */
        function repairRawCode(raw, kind) {
            if (!String(raw || '').trim()) return raw || '';
            const result = checkRawHooks(raw, kind);
            return result.autoFixed && result.fixedText ? result.fixedText : raw;
        }

        /**
         * One line about what the code box produced: what bound, what was read as
         * data, and what has nowhere to go -- or the syntax error, while typing
         * rather than mid-battle.
         *   fixed: the repaired text when applyFix and a repair was possible
         */
        function rawCodeReport(raw, kind, applyFix = false): { text: string, tone: '' | 'is-good' | 'is-warn' | 'is-bad', fixed: string | null } {
            const source = repairRawCode(raw, kind);
            if (!String(source).trim()) return { text: '', tone: '', fixed: null as any };
            let result = checkRawHooks(source, kind);
            let repaired = '';
            let fixed: any = null;
            const first = checkRawHooks(raw, kind);
            if (first.autoFixed && first.fixedText && applyFix) {
                fixed = first.fixedText;
                repaired = 'Fixed a missing comma/semicolon for you. ';
            } else if (first.autoFixed && first.fixedText) {
                repaired = 'A small punctuation fix will be applied when you save. ';
            }
            if (!result.ok) return { text: result.error, tone: 'is-bad', fixed };
            return { text: repaired + describeRawCodeResult(result, kind), tone: rawCodeTone(result), fixed };
        }

        function describeRawCodeResult(result, kind) {
            const parts: any[] = [];
            const bound = [...(result.hooks || []), ...(result.conditionHooks || [])];
            if (bound.length) parts.push(`${bound.length} hook(s): ${bound.join(', ')}`);
            // data fields are a move's own; on an ability/item nothing reads them
            if (result.data?.length) {
                parts.push(kind === 'move'
                    ? `data: ${result.data.join(', ')}`
                    : `ignored data: ${result.data.join(', ')}`);
            }
            if (result.unknown?.length) parts.push(`no event for: ${result.unknown.join(', ')}`);
            if (!parts.length) return 'Parsed, but there is nothing in here to run.';
            // worth saying when the paste wasn't the documented shape
            if (result.via === 'object') parts.push('(read as a full entry)');
            return parts.join(' · ');
        }

        function rawCodeTone(result) {
            if (result.unknown?.length) return 'is-warn';
            if (!(result.hooks?.length || result.conditionHooks?.length)) return 'is-warn';
            return 'is-good';
        }

        /** The hooks the engine can run for a kind, from the bridge's own table so it can't fall out of step. */
        function rawCodeHooks(kind) {
            return supportedHooks(kind);
        }

        function getCustomMoveLibrary() {
            return Array.isArray(state.customMoves) ? state.customMoves : [];
        }
        function getCustomAbilityLibrary() {
            return Array.isArray(state.customAbilities) ? state.customAbilities : [];
        }
        function editorIsOpen() {
            return document.getElementById('editor-view')?.style.display !== 'none';
        }

        /** Your custom abilities or moves, searched and sorted, for the "Add Custom ..." chooser. */
        function customEntityChoices(kind, query = '', sort = 'name-asc') {
            const isAbility = kind === 'ability';
            const q = String(query || '').trim().toLowerCase();
            return (isAbility ? getCustomAbilityLibrary() : getCustomMoveLibrary())
                .filter(item => {
                    if (!q) return true;
                    const haystack = isAbility
                        ? `${item.name || ''} ${item.desc || ''}`
                        : `${item.name || ''} ${item.type || ''} ${item.category || ''} ${item.desc || ''}`;
                    return haystack.toLowerCase().includes(q);
                })
                .sort((a, b) => {
                    if (sort === 'name-desc') return String(b.name || '').localeCompare(String(a.name || ''));
                    if (sort === 'newest') return String(b.id || '').localeCompare(String(a.id || ''));
                    if (sort === 'oldest') return String(a.id || '').localeCompare(String(b.id || ''));
                    return String(a.name || '').localeCompare(String(b.name || ''));
                });
        }

        function openCustomAbilityChooser() {
            if (!getCustomAbilityLibrary().length) { openCustomAbilityLibraryModal(); return; }
            openDialog('custom-entity-chooser', { kind: 'ability' });
        }

        /** The ability editor; sheet: slide in from the right (opened from My Collection). */
        function openCustomAbilityLibraryModal(id = '', { sheet = false }: { sheet?: any } = {}) {
            openDialog('custom-ability', { id: id || '', sheet });
        }

        /**
         * Saves the ability editor. A new ability also joins the Fakemon open in
         * the editor, when there's room.
         * @returns a problem to show, or '' once it's saved
         */
        function saveCustomAbility({ id = '', name = '', desc = '', rawCode = '', artwork = '', regionIds = [] }: { id?: any; name?: any; desc?: any; rawCode?: any; artwork?: any; regionIds?: any }): string {
            name = String(name).trim();
            if (!name) return 'Please enter an ability name!';
            desc = String(desc).trim();
            rawCode = repairRawCode(rawCode, 'ability');
            const existing = id ? getCustomAbilityLibrary().find(x => x.id === id) : null;
            if (existing) {
                Object.assign(existing, { name, desc, rawCode, artwork });
                api.setEntryRegionIds?.(existing, regionIds);
                api.settleVanillaCopy?.('abilities', existing);
                state.fakemonDB.forEach(f => (f.abilities || []).forEach(a => {
                    if (a && a.customId === id) { a.name = name; a.desc = desc; a.source = 'custom'; a.custom = true; }
                }));
            } else {
                id = 'ca_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                const created = { id, name, desc, rawCode, artwork };
                api.setEntryRegionIds?.(created, regionIds);
                state.customAbilities.push(created);
                if (state.abilities.length < 4 && editorIsOpen()) {
                    state.abilities.push({ name, source: 'custom', custom: true, customId: id, desc });
                    renderAbilities(); updatePreview(); api.autoSave();
                }
            }
            api.saveToStorage(); api.renderCollection();
            api.showToast(existing ? 'Custom ability saved!' : 'Custom ability created!', 'success');
            return '';
        }

        function addExistingCustomAbility(id) {
            const a = getCustomAbilityLibrary().find(x => x.id === id);
            if (!a) return;
            if (!editorIsOpen()) { api.showToast('Open a Fakemon in the editor before adding a custom ability.', 'info'); return; }
            if (state.abilities.length >= 4) { api.showToast('A Pokemon can have a maximum of 4 abilities.', 'error'); return; }
            if (state.abilities.some(x => x && x.customId === id)) { api.showToast('That custom ability is already on this Fakemon.', 'info'); return; }
            state.abilities.push({ name: a.name, source: 'custom', custom: true, customId: id, desc: a.desc || '' });
            closeDialog('custom-entity-chooser');
            renderAbilities(); updatePreview(); api.autoSave();
            api.showToast('Custom ability added!', 'success');
        }
        function editCustomAbilityLibrary(id) { openCustomAbilityLibraryModal(id); }


// ==================== CUSTOM ITEMS ====================
function getCustomItemLibrary() { return Array.isArray(state.customItems) ? state.customItems : []; }

/** The item editor; sampleSetTarget: { setIndex } when made from a sample set's item box, which then gets it. */
function openCustomItemModal(id = '', sampleSetTarget: any = null, { sheet = false }: { sheet?: any } = {}) {
    openDialog('custom-item', { id: id || '', sampleSetTarget, sheet });
}

/**
 * Saves the item editor.
 * @returns a problem to show, or '' once it's saved
 */
function saveCustomItem({ id = '', name = '', desc = '', artwork = '', isMegaStone = false, rawCode = '', regionIds = [], sampleSetTarget = null }: { id?: any; name?: any; desc?: any; artwork?: any; isMegaStone?: any; rawCode?: any; regionIds?: any; sampleSetTarget?: any }): string {
    name = String(name).trim();
    if (!name) return 'Please enter an item name!';
    desc = String(desc).trim();
    rawCode = repairRawCode(rawCode, 'item');
    if (!Array.isArray(state.customItems)) state.customItems = [];
    let item: any = id ? state.customItems.find(x => x.id === id) : null;
    const isNew = !item;
    if (isNew) {
        id = 'ci_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        item = { id, name, desc, artwork, isMegaStone, rawCode, source: 'custom', custom: true };
        state.customItems.push(item);
    } else {
        Object.assign(item, { name, desc, artwork, isMegaStone, rawCode, source: 'custom', custom: true });
    }
    api.setEntryRegionIds?.(item, regionIds);
    api.settleVanillaCopy?.('items', item);
    const set = sampleSetTarget && Number.isInteger(sampleSetTarget.setIndex) ? state.sampleSets[sampleSetTarget.setIndex] : null;
    if (set) {
        Object.assign(set, { item: name, itemCustom: true, itemCustomId: id, itemDesc: desc });
        api.renderSampleSets?.(); api.updatePreview?.(); api.autoSave?.();
    }
    api.saveToStorage();
    api.renderCollection();
    api.showToast(isNew ? 'Custom item created!' : 'Custom item saved!', 'success');
    return '';
}
function editCustomItemLibrary(id) { openCustomItemModal(id); }


// ==================== CUSTOM MOVES ====================
        /** The move editor on a custom move in the open Fakemon's learnset (index), or a new one. */
        function openCustomMoveModal(index?, { sheet = false }: { sheet?: any } = {}) {
            log.debug('CUSTOM MOVE', 'Opening custom move editor', { index });
            const entry = index !== undefined && state.learnset[index] && isCustomMove(state.learnset[index]) ? state.learnset[index] : null;
            openDialog('custom-move', { index: entry ? index : null, libraryId: '', sheet });
        }

        /** The move editor on a move in your library. */
        function editCustomMoveLibrary(id, { sheet = false }: { sheet?: any } = {}) {
            if (!getCustomMoveLibrary().some(x => x.id === id)) return;
            closeDialog('custom-entity-chooser');
            openDialog('custom-move', { index: null as any, libraryId: id, sheet });
        }
        // What the block editor calls on its way back, so a move keeps its
        // place in the library instead of reopening as a blank new move.
        function openCustomMoveLibraryModal(id) { editCustomMoveLibrary(id); }

        /** What the move editor starts from. */
        function customMoveDraft(index, libraryId) {
            const lib = libraryId ? getCustomMoveLibrary().find(x => x.id === libraryId) : null;
            const m = lib || (index != null ? state.learnset[index] : null);
            // a move already in the library keeps its region and image; a new one starts in the region you're viewing
            const libMove = lib || (m?.customId ? getCustomMoveLibrary().find(x => x.id === m.customId) : null);
            return {
                name: m?.name || '', type: m?.type || 'Normal', category: m?.category || 'Status',
                basePower: m?.basePower || 0,
                accuracy: m ? ((m.accuracy === true || m.accuracy === undefined) ? 100 : (m.accuracy === false ? 0 : (m.accuracy ?? 100))) : 100,
                pp: m?.pp || 10, priority: m?.priority || 0, desc: m?.desc || '', rawCode: m?.rawCode || '',
                flags: Object.fromEntries(Object.entries<any>(m?.flags || {}).filter(([, v]) => v).map(([k]) => [k, true])),
                artwork: libMove?.artwork || m?.artwork || '',
                regionIds: libMove ? api.entryRegionIds(libMove) : [api.defaultRegionForNewFakemon?.()].filter(Boolean)
            };
        }

        /**
         * Saves the move editor: a library move (and every Fakemon using it), or
         * the open Fakemon's custom move, or a new one (which joins the open
         * Fakemon's learnset only when the editor is actually open).
         * @returns a problem to show, or '' once it's saved
         */
        function saveCustomMoveEntry({ index = null, libraryId = '', draft }: { index?: any; libraryId?: any; draft?: any }): string {
            log.info('CUSTOM MOVE', 'Saving custom move');
            const name = String(draft.name || '').trim();
            if (!name) return 'Please enter a move name!';
            const category = draft.category || 'Status';
            const flags: Record<string, any> = {};
            Object.entries<any>(draft.flags || {}).forEach(([flag, on]) => {
                if (!on) return;
                // only a status move can be bounced or snatched
                if ((flag === 'snatch' || flag === 'reflectable') && category !== 'Status') return;
                flags[flag] = 1;
            });
            const move = {
                rawCode: repairRawCode(draft.rawCode, 'move'), name, type: draft.type || 'Normal', category,
                basePower: parseInt(draft.basePower) || 0, accuracy: parseInt(draft.accuracy) || 100, pp: parseInt(draft.pp) || 10,
                priority: parseInt(draft.priority) || 0, flags, desc: String(draft.desc || '').trim(), artwork: draft.artwork || ''
            };
            const inherit = id => ({ source: 'custom', custom: true, customId: id, learnMethod: 'none', level: null as any });
            if (libraryId) {
                const lib = state.customMoves.find(m => m.id === libraryId);
                if (lib) { Object.assign(lib, move); api.setEntryRegionIds?.(lib, draft.regionIds || []); api.settleVanillaCopy?.('moves', lib); }
                state.fakemonDB.forEach(f => (f.learnset || []).forEach(m => { if (m && m.customId === libraryId) Object.assign(m, move, inherit(libraryId)); }));
                // the Fakemon open in the (possibly hidden) editor too
                state.learnset.forEach(m => { if (m && m.customId === libraryId) Object.assign(m, move, inherit(libraryId)); });
                api.saveToStorage(); api.renderCollection();
                api.showToast('Custom move updated!', 'success');
                return '';
            }
            // Creating a library move from My Collection must never attach it to
            // whichever Fakemon happened to be open last.
            const inEditor = editorIsOpen();
            const editIndex = inEditor && index != null ? index : null;
            const id = editIndex != null && state.learnset[editIndex]?.customId ? state.learnset[editIndex].customId : 'cm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            const libraryEntry = { ...move, id };
            const existingLib = state.customMoves.find(m => m.id === id);
            if (existingLib) Object.assign(existingLib, libraryEntry); else state.customMoves.push(libraryEntry);
            api.setEntryRegionIds?.(existingLib || libraryEntry, draft.regionIds || []);
            if (inEditor) {
                if (editIndex != null) state.learnset[editIndex] = { ...state.learnset[editIndex], ...move, ...inherit(id) };
                else state.learnset.push({ ...move, ...inherit(id) });
                sortLearnset(); renderLearnset(); updatePreview(); api.autoSave();
            }
            api.saveToStorage(); api.renderCollection();
            api.showToast(editIndex != null ? 'Custom move updated!' : 'Custom move created!', 'success');
            return '';
        }

        function openCustomMoveChooser() {
            if (!getCustomMoveLibrary().length) { openCustomMoveModal(); return; }
            openDialog('custom-entity-chooser', { kind: 'move' });
        }
        function addExistingCustomMove(id) {
            const m = getCustomMoveLibrary().find(x => x.id === id); if (!m) return;
            if (!editorIsOpen()) { api.showToast('Open a Fakemon in the editor before adding a custom move to its learnset.', 'info'); return; }
            if (state.learnset.some(x => x && x.customId === id)) { api.showToast('That custom move is already in this learnset.', 'info'); return; }
            state.learnset.push({ ...m, source: 'custom', custom: true, customId: id, learnMethod: 'none', level: null as any });
            closeDialog('custom-entity-chooser'); sortLearnset(); renderLearnset(); updatePreview(); api.autoSave();
            api.showToast('Custom move added to learnset!', 'success');
        }

        function removeCustomMove(index) {
            if (index === undefined || !state.learnset[index] || !isCustomMove(state.learnset[index])) return;
            removeLearnsetMove(index);
        }

        function renderCustomMoves() {
            renderLearnset();
        }


export { ensureLearnsets, openAbilityBrowserModal, getExportableMovesText, moveRecommendations, moveDetail, MOVE_BROWSER_FLAGS, moveMatchesFilters, moveBrowserResults, abilityBrowserResults, addAbilityFromBrowser, openCustomAbilityLibraryModal, saveCustomAbility, saveCustomItem, saveCustomMoveEntry, customMoveDraft, customEntityChoices, rawCodeReport, rawCodeHooks, repairRawCode, getNewMoveMethod, setNewMoveMethod, abilitySuggestions, moveSuggestions, addAbilityByName, addMoveByName, getEditingAbilityIndex, getLearnsetFilters, setLearnsetFilters, learnsetEntries, getLearnsetChartGroup, setLearnsetChartGroup, learnsetChartSegments, describeAbility, getAllBrowsableMoves, sortLearnsetEntries, resetEditingCustomAbilityIndex, getAbilityRole, fetchShowdownData, openMoveBrowserModal, addMoveFromBrowser, findClosestAbility, findClosestMove, findClosestMoveForImport, parseMoveImportText, stripCustomMoveMarker, normalizeMoveCategoryInput, normalizeMoveTypeInput, openMoveImportExportModal, importMovesFromText, addAbility, openCustomAbilityChooser, addExistingCustomAbility, editCustomAbilityLibrary, updateAbility, toggleCustomAbilityEdit, finishCustomAbilityEdit, removeAbility, moveAbility, renderAbilities, showAbilityDetail, getSdMoveByName, hydrateLearnsetEntry, rehydrateCurrentLearnsetFromShowdown, addLearnsetMove, removeLearnsetMove, updateMoveMethod, updateMoveLevel, sortLearnset, renderLearnset, clearLearnsetFilters, addUniversalMoves, getFakemonStats, getFakemonProfile, findSimilarPokemon, classifyLearnsetSource, buildSimilarMovePools, classifyMoveRole, generateMoveRecommendations, openRecommendMovesModal, renderRecommendMovesModal, selectRecommendedMove, generateLearnset, formatLearnMethodLabel, clearMoveset, showMoveDetail, updateCustomAbility, removeCustomAbility, renderCustomAbilities, openCustomMoveChooser, addExistingCustomMove, editCustomMoveLibrary, openCustomMoveModal, removeCustomMove, renderCustomMoves, getCustomItemLibrary, openCustomItemModal, editCustomItemLibrary, loadCompetitiveMoveUsefulness, escapeHtml, isCustomMove, openCustomMoveLibraryModal };