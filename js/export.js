import { log } from './log.js';
import { state, api } from './app.js';
import { sortLearnsetEntries, normalizeMoveCategoryInput, normalizeMoveTypeInput } from './editor.js';

// ==================== import / export ====================
        let pendingCollectionImportFile = null;

        function downloadJsonFile(filename, data) {
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        function exportCollection() {
            log.info('EXPORT', 'Exporting collection', { fakemons: state.fakemonDB.length });
            const hasAnything = state.fakemonDB.length || (state.customMoves || []).length || (state.customAbilities || []).length || (state.customItems || []).length;
            if (!hasAnything) { api.showToast('Nothing to export!', 'error'); return; }

            const bundle = {
                format: 'woogidex-collection',
                version: 2,
                exportedAt: new Date().toISOString(),
                fakemonDB: state.fakemonDB,
                customMoves: state.customMoves || [],
                customAbilities: state.customAbilities || [],
                customItems: state.customItems || []
            };

            downloadJsonFile(`fakemon-collection-${new Date().toISOString().split('T')[0]}.json`, bundle);
            api.showToast('Collection exported with Fakemon, custom moves, and custom abilities!', 'success');
        }

        function exportCustomLibraryItem(kind, id) {
            const list = kind === 'move' ? (state.customMoves || []) : kind === 'ability' ? (state.customAbilities || []) : (state.customItems || []);
            const item = list.find(x => String(x.id) === String(id));
            if (!item) { api.showToast('That custom entry could not be found.', 'error'); return; }

            const payload = {
                format: kind === 'move' ? 'woogidex-custom-move' : kind === 'ability' ? 'woogidex-custom-ability' : 'woogidex-custom-item',
                version: 1,
                exportedAt: new Date().toISOString(),
                item
            };

            const safeName = String(item.name || kind).replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || kind;
            downloadJsonFile(`${safeName}-custom-${kind}.json`, payload);
            api.showToast(`${item.name || 'Custom entry'} exported!`, 'success');
        }

        function openImportModal() {
            pendingCollectionImportFile = null;
            const input = document.getElementById('import-file');
            const status = document.getElementById('collection-import-status');
            const addBtn = document.getElementById('collection-import-add');
            const replaceBtn = document.getElementById('collection-import-replace');
            if (input) input.value = '';
            if (status) status.textContent = 'Choose a collection, Fakemon, custom move, custom ability, or custom item JSON/TXT file.';
            if (addBtn) addBtn.disabled = true;
            if (replaceBtn) replaceBtn.disabled = true;
            document.getElementById('import-modal').classList.add('active');
        }

        function handleCollectionImportFile(event) {
            pendingCollectionImportFile = event.target.files?.[0] || null;
            const status = document.getElementById('collection-import-status');
            const addBtn = document.getElementById('collection-import-add');
            const replaceBtn = document.getElementById('collection-import-replace');
            if (!pendingCollectionImportFile) {
                if (status) status.textContent = 'Choose a collection, Fakemon, custom move, custom ability, or custom item JSON/TXT file.';
                if (addBtn) addBtn.disabled = true;
                if (replaceBtn) replaceBtn.disabled = true;
                return;
            }
            if (status) status.textContent = `Selected: ${pendingCollectionImportFile.name}`;
            if (addBtn) addBtn.disabled = false;
            if (replaceBtn) replaceBtn.disabled = false;
        }

        async function importCollection(mode) {
            const done = log.time('IMPORT', `importCollection:${mode}`);
            log.info('IMPORT', 'Starting collection import', { mode, file: pendingCollectionImportFile?.name });
            if (!pendingCollectionImportFile) {
                api.showToast('Choose an import file first.', 'error');
                return;
            }
            try {
                const file = pendingCollectionImportFile;
                const text = await file.text();
                log.debug('IMPORT', 'Import file read', { bytes: text.length, type: file.type, name: file.name });
                let parsed;
                if (file.name.toLowerCase().endsWith('.json') || file.type.includes('json')) {
                    parsed = JSON.parse(text);
                } else {
                    parsed = parsePlainTextFakemon(text);
                }

                // individual custom move/ability import.
                if (parsed && typeof parsed === 'object' && (parsed.format === 'woogidex-custom-move' || parsed.format === 'woogidex-custom-ability' || parsed.format === 'woogidex-custom-item')) {
                    const kind = parsed.format === 'woogidex-custom-move' ? 'move' : parsed.format === 'woogidex-custom-ability' ? 'ability' : 'item';
                    const item = parsed.item;
                    if (!item || !item.name) throw new Error('Invalid custom entry.');
                    const list = kind === 'move' ? (state.customMoves || []) : (state.customAbilities || []);
                    const copy = JSON.parse(JSON.stringify(item));
                    copy.id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
                    if (kind === 'move') {
                        copy.source = 'custom';
                        copy.custom = true;
                        copy.learnMethod = 'none';
                        copy.level = null;
                        if (!Array.isArray(state.customMoves)) state.customMoves = [];
                        state.customMoves.push(copy);
                    } else if (kind === 'ability') {
                        copy.source = 'custom';
                        copy.custom = true;
                        if (!Array.isArray(state.customAbilities)) state.customAbilities = [];
                        state.customAbilities.push(copy);
                    } else {
                        copy.source = 'custom';
                        copy.custom = true;
                        if (!Array.isArray(state.customItems)) state.customItems = [];
                        state.customItems.push(copy);
                    }
                    await api.saveToStorage();
                    api.renderCollection();
                    closeModal('import-modal');
                    pendingCollectionImportFile = null;
                    api.showToast(`Imported custom ${kind} "${copy.name}"!`, 'success');
                    return;
                }

                // full collection bundle includes Fakemon plus reusable libraries.
                const isBundle = parsed && typeof parsed === 'object' && parsed.format === 'woogidex-collection';
                let incomingSource = parsed;
                let importedMoves = isBundle && Array.isArray(parsed.customMoves) ? parsed.customMoves : [];
                let importedAbilities = isBundle && Array.isArray(parsed.customAbilities) ? parsed.customAbilities : [];
                let importedItems = isBundle && Array.isArray(parsed.customItems) ? parsed.customItems : [];

                if (isBundle && Array.isArray(parsed.fakemonDB)) incomingSource = parsed.fakemonDB;
                else if (!Array.isArray(incomingSource) && incomingSource && typeof incomingSource === 'object') {
                    if (Array.isArray(incomingSource.fakemonDB)) incomingSource = incomingSource.fakemonDB;
                    else if (Array.isArray(incomingSource.collection)) incomingSource = incomingSource.collection;
                    else if (Array.isArray(incomingSource.data)) incomingSource = incomingSource.data;
                }
                let incoming = Array.isArray(incomingSource) ? incomingSource : [incomingSource];
                incoming = incoming.filter(f => f && typeof f === 'object' && String(f.name || '').trim());
                if (!incoming.length && !importedMoves.length && !importedAbilities.length && !importedItems.length) throw new Error('No valid Fakemon, custom moves, or custom abilities were found in the file.');

                const now = Date.now();
                incoming = incoming.map((f, index) => {
                    const copy = JSON.parse(JSON.stringify(f));
                    if (!Array.isArray(copy.learnset)) copy.learnset = [];
                    if (!Array.isArray(copy.customMoves)) copy.customMoves = [];
                    const customByName = new Map(copy.customMoves.filter(Boolean).map(m => [String(m.name || '').toLowerCase(), m]));
                    copy.learnset = copy.learnset.map(m => {
                        const key = String(m?.name || '').toLowerCase();
                        return customByName.has(key) ? { ...m, ...customByName.get(key), source: 'custom', custom: true } : m;
                    });
                    copy.customMoves.forEach(m => {
                        const key = String(m?.name || '').toLowerCase();
                        if (key && !copy.learnset.some(x => String(x?.name || '').toLowerCase() === key)) copy.learnset.push({ ...m, source: 'custom', custom: true });
                    });
                    if (!Array.isArray(copy.abilities)) copy.abilities = [];
                    if (!Array.isArray(copy.eggGroups)) copy.eggGroups = String(copy.eggGroups || '').split(/\s*\/\s*|\s*,\s*/).filter(Boolean);
                    // collection imports always receive fresh IDs. this prevents an
                    // imported collection from overwriting anything already present.
                    copy.id = `${now}-${index}-${Math.random().toString(36).slice(2, 8)}`;
                    copy.createdAt = now + index;
                    copy.updatedAt = now + index;
                    return copy;
                });

                if (mode === 'replace') state.fakemonDB = incoming;
                else state.fakemonDB = [...state.fakemonDB, ...incoming];

                const mergeLibrary = (targetKey, incomingList, kind) => {
                    if (!incomingList.length) return;
                    if (mode === 'replace') state[targetKey] = [];
                    if (!Array.isArray(state[targetKey])) state[targetKey] = [];
                    const existing = new Set(state[targetKey].map(x => String(x.name || '').trim().toLowerCase()).filter(Boolean));
                    incomingList.forEach((raw, index) => {
                        if (!raw || !raw.name) return;
                        const copy = JSON.parse(JSON.stringify(raw));
                        if (existing.has(String(copy.name).trim().toLowerCase())) return;
                        copy.id = `${now}-library-${kind}-${index}-${Math.random().toString(36).slice(2,8)}`;
                        copy.source = 'custom';
                        copy.custom = true;
                        if (kind === 'move') {
                            copy.learnMethod = 'none';
                            copy.level = null;
                        }
                        state[targetKey].push(copy);
                        existing.add(String(copy.name).trim().toLowerCase());
                    });
                };

                mergeLibrary('customMoves', importedMoves, 'move');
                mergeLibrary('customAbilities', importedAbilities, 'ability');
                mergeLibrary('customItems', importedItems, 'item');

                await api.migrateLearnsetsToMinimal();
                await api.saveToStorage();
                api.renderCollection();
                closeModal('import-modal');
                const libraryBits = [];
                if (importedMoves.length) libraryBits.push(`${importedMoves.length} custom move${importedMoves.length === 1 ? '' : 's'}`);
                if (importedAbilities.length) libraryBits.push(`${importedAbilities.length} custom activit${importedAbilities.length === 1 ? 'y' : 'ies'}`);
                if (importedItems.length) libraryBits.push(`${importedItems.length} custom item${importedItems.length === 1 ? '' : 's'}`);
                const importedBits = [`${incoming.length} Fakemon${incoming.length === 1 ? '' : 's'}`, ...libraryBits].join(' and ');
                api.showToast(`${mode === 'replace' ? 'Replaced with' : 'Added'} ${importedBits}!`, 'success');
            } catch (err) {
                log.error('IMPORT', 'Collection import failed', err);
                api.showToast(`Import failed: ${err.message || 'invalid file'}`, 'error');
            } finally {
                pendingCollectionImportFile = null;
                const input = document.getElementById('import-file');
                if (input) input.value = '';
            }
        }

        // kept as a compatibility alias for older inline handlers.
        function handleImport(event) {
            handleCollectionImportFile(event);
        }

        function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// ==================== PNG export ====================
        async function exportAsPNG() {
            const board = document.getElementById('pokedex-board-export');
            if (!board) { api.showToast('Nothing to export!', 'error'); return; }
            try {
                api.showToast('Generating PNG...', 'info');
                const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
                const canvas = await html2canvas(board, { backgroundColor: isDark ? '#0f0f12' : '#fafafa', scale: 2, useCORS: true, allowTaint: true, logging: false });
                const link = document.createElement('a');
                const name = document.getElementById('fakemon-name').value || 'fakemon';
                link.download = `${name}-pokedex.png`;
                link.href = canvas.toDataURL('image/png');
                document.body.appendChild(link); link.click(); document.body.removeChild(link);
                api.showToast('PNG exported!', 'success');
            } catch (err) { api.showToast('Export failed!', 'error'); }
        }



        // ==================== single Fakemon export / import ====================
        function getCurrentFakemonForExport() {
            if (typeof api.buildFakemonObject !== 'function') return null;
            return api.buildFakemonObject();
        }

        function exportAsJSON() {
            try {
                const fakemon = getCurrentFakemonForExport();
                if (!fakemon) { api.showToast('Please enter a Pokemon name first!', 'error'); return; }
                const name = fakemon.name || 'fakemon';
                const blob = new Blob([JSON.stringify(fakemon, null, 2)], { type: 'application/json;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `${name}-pokedex.json`;
                document.body.appendChild(link); link.click(); document.body.removeChild(link);
                URL.revokeObjectURL(url);
                api.showToast('JSON exported!', 'success');
            } catch (err) {
                log.error('EXPORT', 'JSON export failed', err);
                api.showToast('JSON export failed!', 'error');
            }
        }

        function getCollectionFakemon(id) {
            return (state.fakemonDB || []).find(f => String(f.id) === String(id)) || null;
        }

        async function prepareCollectionFakemonForExport(id, callback) {
            const fakemon = getCollectionFakemon(id);
            if (!fakemon) { api.showToast('That Fakemon could not be found.', 'error'); return; }
            try {
                await api.autoSave?.(true);
                state.editingId = fakemon.id;
                api.loadFakemonIntoEditor(fakemon);
                api.updatePreview?.();
                await callback(fakemon);
            } catch (err) {
                log.error('EXPORT', 'Collection Fakemon export failed', err);
                api.showToast(`Export failed: ${err.message || 'unknown error'}`, 'error');
            }
        }

        function exportCollectionFakemonAsJSON(id, event) {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            const fakemon = getCollectionFakemon(id);
            if (!fakemon) { api.showToast('That Fakemon could not be found.', 'error'); return; }
            const name = fakemon.name || 'fakemon';
            downloadJsonFile(`${name}-pokedex.json`, fakemon);
            api.showToast('JSON exported!', 'success');
            api.closeCollectionFakemonExportMenus?.();
        }

        async function exportCollectionFakemonAsPNG(id, event) {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            await prepareCollectionFakemonForExport(id, async () => { await exportAsPNG(); });
            api.closeCollectionFakemonExportMenus?.();
        }

        async function exportCollectionFakemonAsPlainText(id, event) {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            await prepareCollectionFakemonForExport(id, async () => { openPlainTextExportModal(); });
            api.closeCollectionFakemonExportMenus?.();
        }

        async function exportCollectionFakemonAsShowdown(id, event) {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            await prepareCollectionFakemonForExport(id, async () => { await api.exportShowdownMod(); });
            api.closeCollectionFakemonExportMenus?.();
        }

        async function exportCollectionFakemonAsEssentials(id, event) {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            await prepareCollectionFakemonForExport(id, async () => { await api.exportEssentialsMod(); });
            api.closeCollectionFakemonExportMenus?.();
        }

        function openFakemonImport() {
            const input = document.getElementById('fakemon-import-file');
            if (input) input.click();
        }

        function parsePlainTextFakemon(text) {
            const rawText = String(text || '').replace(/\r/g, '');
            const lines = rawText.split('\n');
            const trim = value => String(value ?? '').trim();
            const result = {
                name: '', species: '', type1: '', type2: '',
                stats: { hp:60, atk:60, def:60, spa:60, spd:60, spe:60 },
                abilities: [], dexEntry1:'', dexEntry2:'', height:'', weight:'', color:'',
                eggGroups:[], genderRatio:'50-50', learnset:[], customMoves:[], sampleSets:[], artwork:null
            };

            const findIndex = (regex, from = 0) => {
                for (let i = from; i < lines.length; i++) if (regex.test(trim(lines[i]))) return i;
                return -1;
            };
            const valueAfter = regex => {
                const i = findIndex(regex);
                if (i < 0) return '';
                return trim(lines[i]).replace(regex, '').trim();
            };

            // ---------- header ----------
            const nameLine = lines.find(line => /^Name:\s*/i.test(trim(line)));
            if (nameLine) {
                const raw = trim(nameLine).replace(/^Name:\s*/i, '').trim();
                const match = raw.match(/^(.*?),\s*the\s+(.*)$/i);
                result.name = trim(match ? match[1] : raw);
                result.species = trim(match ? match[2] : '');
            }

            const typeText = valueAfter(/^Types:\s*/i);
            const types = typeText.split(/\s*\/\s*/).map(trim);
            result.type1 = types[0] && types[0] !== '-' ? types[0] : '';
            result.type2 = types[1] && types[1] !== '-' ? types[1] : '';

            const statsText = valueAfter(/^Stats:\s*/i);
            const statMatch = statsText.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
            if (statMatch) ['hp','atk','def','spa','spd','spe'].forEach((key, i) => { result.stats[key] = Number(statMatch[i + 1]); });

            // ---------- abilities ----------
            const abilitiesIndex = findIndex(/^Abilities:\s*/i);
            const dexIndex = findIndex(/^Dex:\s*$/i);
            if (abilitiesIndex >= 0) {
                const raw = trim(lines[abilitiesIndex]).replace(/^Abilities:\s*/i, '').trim();
                const abilityGroups = raw.split(/\s*\/\/\s*/).map(trim).filter(Boolean);
                const normalNames = abilityGroups[0] ? abilityGroups[0].split(/\s*\/\s*/).map(trim).filter(Boolean) : [];
                const specialNames = abilityGroups.slice(1).flatMap(group => group.split(/\s*\/\s*/).map(trim).filter(Boolean));
                [...normalNames, ...specialNames].slice(0, 4).forEach(name => {
                    const custom = /[!*]$/.test(name);
                    result.abilities.push({
                        name: custom ? trim(name.slice(0, -1)) : name,
                        source: custom ? 'custom' : 'sd',
                        custom,
                        desc: ''
                    });
                });

                // custom ability descriptions use: ability name!: description
                // (legacy exports used "ability name*: description")
                const abilityEnd = dexIndex >= 0 ? dexIndex : lines.length;
                for (let i = abilitiesIndex + 1; i < abilityEnd; i++) {
                    const line = trim(lines[i]);
                    if (!line) continue;
                    const match = line.match(/^(.+?)[!*]:\s*(.*)$/);
                    if (!match) continue;
                    const ability = result.abilities.find(a => a.name.toLowerCase() === trim(match[1]).toLowerCase());
                    if (ability) {
                        ability.source = 'custom';
                        ability.custom = true;
                        ability.desc = match[2];
                    }
                }
            }

            // ---------- dex / basic details ----------
            const entry1Index = findIndex(/^Entry 1:\s*/i);
            const entry2Index = findIndex(/^Entry 2:\s*/i);
            const heightIndex = findIndex(/^Height:\s*/i);
            const weightIndex = findIndex(/^Weight:\s*/i);
            const colorIndex = findIndex(/^Dex Colour:\s*/i);
            const eggIndex = findIndex(/^Egg Group\(s\):\s*/i);
            const genderIndex = findIndex(/^Gender Ratio:\s*/i);
            const learnIndex = findIndex(/^Learnset:\s*$/i);
            const sampleIndex = findIndex(/^Sample Sets:\s*$/i);

            const readMultilineField = (index, prefixRegex, nextIndexes) => {
                if (index < 0) return '';
                const first = trim(lines[index]).replace(prefixRegex, '').trim();
                const end = nextIndexes.filter(n => n > index).sort((a,b) => a-b)[0] ?? lines.length;
                const parts = first ? [first] : [];
                for (let i = index + 1; i < end; i++) {
                    const line = trim(lines[i]);
                    if (line) parts.push(line);
                }
                return parts.join('\n').trim();
            };

            result.dexEntry1 = readMultilineField(entry1Index, /^Entry 1:\s*/i, [entry2Index, heightIndex, learnIndex, sampleIndex]);
            result.dexEntry2 = readMultilineField(entry2Index, /^Entry 2:\s*/i, [heightIndex, learnIndex, sampleIndex]);
            result.height = valueAfter(/^Height:\s*/i);
            result.weight = valueAfter(/^Weight:\s*/i);
            result.color = valueAfter(/^Dex Colour:\s*/i);
            const egg = valueAfter(/^Egg Group\(s\):\s*/i);
            result.eggGroups = egg && !/^none$/i.test(egg) ? egg.split(/\s*\/\s*|\s*,\s*/).map(trim).filter(Boolean) : [];
            result.genderRatio = valueAfter(/^Gender Ratio:\s*/i) || '50-50';

            // ---------- learnset + custom move definitions ----------
            if (learnIndex >= 0) {
                const end = sampleIndex >= 0 ? sampleIndex : lines.length;
                const learnLines = lines.slice(learnIndex + 1, end).map(trim);
                const seen = new Set();
                let customSectionStarted = false;

                // the exporter writes all normal moves first, followed by each custom
                // move's full definition. once the first marked title is encountered,
                // everything until the next marked title belongs to custom data.
                // accepts the current "!" marker as well as the legacy "*" marker.
                for (const line of learnLines) {
                    if (!line) continue;
                    if (/[!*]$/.test(line)) {
                        customSectionStarted = true;
                        const name = trim(line.slice(0, -1));
                        if (name && !seen.has(name.toLowerCase())) {
                            result.learnset.push({ name, source:'custom', custom:true, learnMethod:'none', level:null });
                            seen.add(name.toLowerCase());
                        }
                        continue;
                    }
                    if (customSectionStarted) continue;
                    if (!seen.has(line.toLowerCase())) {
                        result.learnset.push({ name: line, learnMethod:'none', level:null });
                        seen.add(line.toLowerCase());
                    }
                }

                for (let i = 0; i < learnLines.length; i++) {
                    const title = learnLines[i];
                    if (!/[!*]$/.test(title)) continue;
                    const name = trim(title.slice(0, -1));
                    const categoryType = learnLines[i + 1] || '';
                    const bpLine = learnLines[i + 2] || '';
                    const categoryMatch = categoryType.match(/^(.+?)\s*\|\s*(.+)$/);
                    const bpMatch = bpLine.match(/^(.+?)\s*BP\s*\|\s*(.+?)\s*ACC\s*\|\s*(.+?)\s*PP$/i);
                    if (!categoryMatch || !bpMatch) continue;

                    let cursor = i + 3;
                    let flags = {};
                    // a flag line is optional. do not consume the description if it has no '|'.
                    if (cursor < learnLines.length && learnLines[cursor] && learnLines[cursor].includes('|') && !learnLines[cursor].includes('BP')) {
                        learnLines[cursor].split('|').map(trim).filter(Boolean).forEach(flag => {
                            const key = flag.toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase());
                            if (key) flags[key] = true;
                        });
                        cursor++;
                    }
                    const desc = learnLines[cursor] || '';
                    const accuracyText = trim(bpMatch[2]);
                    const move = {
                        name,
                        source:'custom', custom:true, learnMethod:'none', level:null,
                        category:normalizeMoveCategoryInput(categoryMatch[1]), type:normalizeMoveTypeInput(categoryMatch[2]),
                        basePower: /^-$/.test(trim(bpMatch[1])) ? 0 : (parseInt(bpMatch[1], 10) || 0),
                        accuracy: /^-$/.test(accuracyText) ? true : (parseFloat(accuracyText.replace('%','')) || 100),
                        pp: /^-$/.test(trim(bpMatch[3])) ? 0 : (parseInt(bpMatch[3], 10) || 0),
                        flags,
                        desc
                    };
                    const idx = result.learnset.findIndex(m => m.name.toLowerCase() === name.toLowerCase());
                    if (idx >= 0) result.learnset[idx] = move;
                    else result.learnset.push(move);
                    result.customMoves.push(move);
                }
            }

            // ---------- sample sets ----------
            if (sampleIndex >= 0) {
                const sampleLines = lines.slice(sampleIndex + 1).map(trim);
                const ignoredHeaders = new Set(['Ability:', 'Level:', 'Tera Type:', 'EVs:', 'IVs:']);
                const headerIndexes = [];
                sampleLines.forEach((line, i) => {
                    if (!line || ignoredHeaders.has(line)) return;
                    if (/^.+:\s*$/.test(line) && !/^Ability:|^Level:|^Tera Type:|^EVs:|^IVs:/i.test(line)) {
                        headerIndexes.push(i);
                    }
                });
                headerIndexes.forEach((headerIndex, n) => {
                    const setName = trim(sampleLines[headerIndex].slice(0, -1));
                    const end = n + 1 < headerIndexes.length ? headerIndexes[n + 1] : sampleLines.length;
                    const body = sampleLines.slice(headerIndex + 1, end).filter(Boolean);
                    if (!setName || !body.length) return;
                    const set = {
                        name: setName, item:'', ability:'', nature:'Hardy',
                        evs:{hp:0,atk:0,def:0,spa:0,spd:0,spe:0},
                        ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},
                        moves:[], teraType:'', level:100
                    };
                    const first = body[0] || '';
                    const at = first.indexOf(' @ ');
                    if (at >= 0) set.item = trim(first.slice(at + 3));
                    body.forEach(line => {
                        if (/^Ability:\s*/i.test(line)) set.ability = trim(line.replace(/^Ability:\s*/i,''));
                        else if (/^Level:\s*/i.test(line)) set.level = parseInt(line.replace(/^Level:\s*/i,''), 10) || 100;
                        else if (/^Tera Type:\s*/i.test(line)) set.teraType = trim(line.replace(/^Tera Type:\s*/i,''));
                        else if (/^EVs:\s*/i.test(line)) parseSpread(line.replace(/^EVs:\s*/i,''), set.evs);
                        else if (/^IVs:\s*/i.test(line)) parseSpread(line.replace(/^IVs:\s*/i,''), set.ivs);
                        else if (/^(.+) Nature$/i.test(line)) set.nature = trim(line.replace(/ Nature$/i,''));
                        else if (/^-\s*/.test(line)) set.moves.push(trim(line.replace(/^-\s*/,'')));
                    });
                    result.sampleSets.push(set);
                });
            }

            return result;
        }

        function parseSpread(text, target) {
            const map = { HP:'hp', Atk:'atk', Def:'def', SpA:'spa', SpD:'spd', Spe:'spe' };
            text.split('/').forEach(part => { const m = part.trim().match(/^(\d+)\s+(.+)$/); if (m && map[m[2]]) target[map[m[2]]] = Number(m[1]); });
        }

        async function handleFakemonImport(event) {
            const file = event.target.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                let fakemon;
                if (file.name.toLowerCase().endsWith('.json') || file.type.includes('json')) {
                    const parsed = JSON.parse(text);
                    fakemon = Array.isArray(parsed) ? parsed[0] : parsed;
                } else {
                    fakemon = parsePlainTextFakemon(text);
                }
                if (!fakemon || typeof fakemon !== 'object' || !fakemon.name) throw new Error('Invalid Fakemon data');

                // single-fakemon imports are for the editor only. never use the imported
                // JSON id to select or overwrite a collection entry. the imported data
                // is loaded into whichever Fakemon is currently open.
                const currentId = state.editingId || null;
                const currentExisting = currentId ? state.fakemonDB.find(f => f && f.id === currentId) : null;
                const imported = JSON.parse(JSON.stringify(fakemon));
                if (currentId) imported.id = currentId;
                else delete imported.id;
                imported.createdAt = currentExisting?.createdAt || Date.now();
                imported.updatedAt = Date.now();

                api.loadFakemonIntoEditor(imported);
                state.editingId = currentId;
                api.exitProfileRoute?.();
                document.getElementById('collection-view').style.display = 'none';
                document.getElementById('editor-view').style.display = 'block';
                document.getElementById('save-status').style.display = '';
                api.switchTab(document.querySelector('.tab'), 'basic');
                api.updatePreview();

                if (currentId) {
                    await api.autoSave(true);
                    api.showToast(`${imported.name} loaded into the current Fakemon!`, 'success');
                } else {
                    api.showToast('Imported into the new Fakemon editor. Save it to add it to your collection.', 'success');
                }
            } catch (err) {
                log.error('IMPORT', 'Fakemon import failed', err);
                api.showToast(`Import failed: ${err.message || 'invalid file'}`, 'error');
            } finally {
                event.target.value = '';
            }
        }

        function escapePlainText(value) {
            return String(value ?? '').replace(/\r?\n/g, '\n');
        }

        function buildPlainTextExport(sort = 'name', order = 'asc') {
            const name = document.getElementById('fakemon-name')?.value.trim() || 'Fakemon';
            const species = document.getElementById('fakemon-species')?.value.trim() || 'Pokemon';
            const type1 = document.getElementById('fakemon-type1')?.value.trim() || '-';
            const type2 = document.getElementById('fakemon-type2')?.value.trim() || '-';
            const number = document.getElementById('fakemon-number')?.value.trim() || '';
            const stats = ['hp','atk','def','spa','spd','spe'].map(k => parseInt(document.getElementById('stat-' + k)?.value) || 0);
            const bst = stats.reduce((sum, n) => sum + n, 0);
            const height = api.getHeightDisplay ? api.getHeightDisplay() : (document.getElementById('fakemon-height')?.value.trim() || '');
            const weight = api.getWeightDisplay ? api.getWeightDisplay() : (document.getElementById('fakemon-weight')?.value.trim() || '');
            const color = document.getElementById('fakemon-color')?.value.trim() || '';
            const eggs = api.getEggGroupValue ? api.getEggGroupValue() : '';
            const gender = api.getGenderRatioValue ? api.getGenderRatioValue() : '';
            const dex1 = document.getElementById('dex-entry1')?.value.trim() || '';
            const dex2 = document.getElementById('dex-entry2')?.value.trim() || '';

            const abilityEntries = (state.abilities || []).filter(a => a && a.name);
            const abilitySlots = abilityEntries.map((a, i) => {
                const role = api.getAbilityRole ? api.getAbilityRole(i) : '';
                const isCustom = a.source === 'custom' || a.custom === true;
                return { ...a, role, isCustom };
            });
            const normalAbilities = abilitySlots.filter(a => !a.role).map(a => `${a.name}${a.isCustom ? '!' : ''}`);
            const hiddenAbility = abilitySlots.find(a => a.role === 'Hidden');
            const eventAbility = abilitySlots.find(a => a.role === 'Event');
            const abilityParts = [];
            if (normalAbilities.length) abilityParts.push(normalAbilities.join(' / '));
            if (hiddenAbility) abilityParts.push(`// ${hiddenAbility.name}${hiddenAbility.isCustom ? '!' : ''}`);
            if (eventAbility) abilityParts.push(`// ${eventAbility.name}${eventAbility.isCustom ? '!' : ''}`);

            const lines = [];
            lines.push(`Name: ${name}, the ${species}`);
            lines.push(`Types: ${type1} / ${type2}`);
            lines.push(`Stats: ${stats.join('/')} (BST ${bst})`);
            lines.push('');
            lines.push(`Abilities: ${abilityParts.join(' ')}`);
            lines.push('');

            abilityEntries.filter(a => a.source === 'custom' || a.custom === true).forEach(a => {
                lines.push(`${a.name}${a.source === 'custom' || a.custom === true ? '!' : ''}: ${a.desc || a.description || ''}`);
                lines.push('');
            });

            lines.push('Dex:');
            lines.push('');
            lines.push(`Entry 1: ${escapePlainText(dex1)}`);
            lines.push('');
            lines.push(`Entry 2: ${escapePlainText(dex2)}`);
            lines.push('');
            lines.push(`Height: ${height}`);
            lines.push(`Weight: ${weight}`);
            lines.push(`Dex Colour: ${color}`);
            lines.push(`Egg Group(s): ${eggs}`);
            lines.push(`Gender Ratio: ${gender}`);
            lines.push('');
            lines.push('Learnset:');

            const learnset = sortLearnsetEntries(state.learnset, sort, order);
            const vanillaMoves = learnset
                .filter(m => m && m.name && !(m.source === 'custom' || m.custom === true))
                .map(m => m.name);
            vanillaMoves.forEach(m => lines.push(m));

            const customMoves = learnset.filter(m => m && m.name && (m.source === 'custom' || m.custom === true));
            customMoves.forEach(m => lines.push(`${m.name}!`));
            if (customMoves.length) lines.push('');
            customMoves.forEach((m, index) => {
                lines.push(`${m.name}!`);
                lines.push(`${m.category || 'Status'} | ${m.type || 'Normal'}`);
                const acc = (m.accuracy === true || m.accuracy === undefined) ? '-' : (m.accuracy === false ? '-' : `${m.accuracy}%`);
                lines.push(`${m.basePower || '-'} BP | ${acc} ACC | ${m.pp || '-'} PP`);
                const flags = api.getFlagLabels ? api.getFlagLabels(m.flags || {}, m.category) : [];
                if (flags.length) lines.push(flags.join(' | '));
                lines.push(escapePlainText(m.desc || ''));
                if (index < customMoves.length - 1) lines.push('');
            });

            lines.push('');
            lines.push('Sample Sets:');
            (state.sampleSets || []).forEach((set, i) => {
                if (i) lines.push('');
                lines.push(`${set.name || `Set ${i + 1}`}:`);
                lines.push(api.generateShowdownExport ? api.generateShowdownExport(name, set) : '');
            });

            return lines.join('\n').replace(/\n{4,}/g, '\n\n\n');
        }

        function refreshPlainTextExport() {
            const sort = document.getElementById('plain-text-export-sort')?.value || 'name';
            const order = document.getElementById('plain-text-export-order')?.value || 'asc';
            const textarea = document.getElementById('plain-text-export-text');
            if (textarea) textarea.value = buildPlainTextExport(sort, order);
        }

        function openPlainTextExportModal() {
            try {
                const sort = document.getElementById('plain-text-export-sort')?.value || 'name';
                const order = document.getElementById('plain-text-export-order')?.value || 'asc';
                const text = buildPlainTextExport(sort, order);
                const textarea = document.getElementById('plain-text-export-text');
                if (!textarea) return;
                textarea.value = text;
                document.getElementById('plain-text-export-modal')?.classList.add('active');
                setTimeout(() => { textarea.focus(); textarea.select(); }, 0);
            } catch (err) {
                log.error('EXPORT', 'Plain text export failed', err);
                api.showToast('Plain text export failed!', 'error');
            }
        }

        async function copyPlainTextExport() {
            const textarea = document.getElementById('plain-text-export-text');
            if (!textarea) return;
            const text = textarea.value;
            try {
                await navigator.clipboard.writeText(text);
                api.showToast('Plain text copied!', 'success');
            } catch (err) {
                textarea.focus();
                textarea.select();
                document.execCommand('copy');
                api.showToast('Plain text copied!', 'success');
            }
        }

        function downloadPlainTextExport() {
            const textarea = document.getElementById('plain-text-export-text');
            if (!textarea) return;
            const name = document.getElementById('fakemon-name')?.value.trim() || 'fakemon';
            const blob = new Blob([textarea.value], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${name}-pokedex.txt`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            api.showToast('Plain text downloaded!', 'success');
        }

        function toggleExportMenu(event) {
            if (event) event.stopPropagation();
            const menu = document.getElementById('export-as-menu');
            if (!menu) return;
            menu.style.display = menu.style.display === 'none' || !menu.style.display ? 'block' : 'none';
        }

        function closeExportMenu() {
            const menu = document.getElementById('export-as-menu');
            if (menu) menu.style.display = 'none';
        }

        function toggleCollectionExportMenu(event) {
            if (event) event.stopPropagation();
            const menu = document.getElementById('collection-export-menu');
            if (!menu) return;
            menu.style.display = menu.style.display === 'none' || !menu.style.display ? 'block' : 'none';
        }

        function closeCollectionExportMenu() {
            const menu = document.getElementById('collection-export-menu');
            if (menu) menu.style.display = 'none';
        }

        document.addEventListener('click', (event) => {
            if (!event.target.closest('.export-as-wrap')) {
                closeExportMenu();
                closeCollectionExportMenu();
            }
        });

        

export { refreshPlainTextExport, exportCollection, exportCustomLibraryItem, getCollectionFakemon, prepareCollectionFakemonForExport, exportCollectionFakemonAsJSON, exportCollectionFakemonAsPNG, exportCollectionFakemonAsPlainText, exportCollectionFakemonAsShowdown, exportCollectionFakemonAsEssentials, openImportModal, closeModal, handleCollectionImportFile, importCollection, handleImport, exportAsPNG, openPlainTextExportModal, copyPlainTextExport, downloadPlainTextExport, toggleExportMenu, closeExportMenu, toggleCollectionExportMenu, closeCollectionExportMenu, buildPlainTextExport, exportAsJSON, openFakemonImport, handleFakemonImport, parsePlainTextFakemon };