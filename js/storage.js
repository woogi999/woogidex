import { log } from './log.js';
import { state, api } from './app.js';

// ==================== IndexedDB ====================
        const IDB_NAME = 'woogidex-db';
        const IDB_VERSION = 1;
        const IDB_STORE = 'kv';
        let idbPromise = null;
let storageWriteRevision = 0;
let latestStorageWriteRevision = 0;
let storageWriteChain = Promise.resolve();
let autoSaveGeneration = 0;

        function openDB() {
            log.debug('STORAGE', 'openDB requested', { database: IDB_NAME, version: IDB_VERSION });
            if (idbPromise) return idbPromise;
            idbPromise = new Promise((resolve, reject) => {
                if (!('indexedDB' in window)) { reject(new Error('IndexedDB not supported')); return; }
                const req = indexedDB.open(IDB_NAME, IDB_VERSION);
                req.onupgradeneeded = (e) => {
                    log.info('STORAGE', 'IndexedDB upgrade', { version: e.newVersion });
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
                };
                req.onsuccess = () => { log.info('STORAGE', 'IndexedDB opened'); resolve(req.result); };
                req.onerror = () => { log.error('STORAGE', 'IndexedDB open failed', req.error); reject(req.error); };
            });
            return idbPromise;
        }
        function idbGet(key) {
            return openDB().then(db => new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get(key);
                req.onsuccess = () => { log.info('STORAGE', 'IndexedDB opened'); resolve(req.result); };
                req.onerror = () => { log.error('STORAGE', 'IndexedDB open failed', req.error); reject(req.error); };
            }));
        }
        function idbSet(key, value) {
            return openDB().then(db => new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).put(value, key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            }));
        }

// ==================== collection normalization ====================
// IDs are the primary key for every saved collection entry. older builds could
// accidentally append the same object more than once during overlapping saves.
// normalize on load/save so duplicates can no longer accumulate.
function normalizeCollectionArray(arr, options = {}) {
    if (!Array.isArray(arr)) return [];
    const seenIds = new Set();
    const seenNames = new Set();
    const out = [];

    for (const item of arr) {
        if (!item || typeof item !== 'object') continue;

        let id = String(item.id ?? '').trim();
        const nameKey = String(item.name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

        if (id && seenIds.has(id)) continue;
        // custom libraries are name-unique in the UI. older versions could create
        // the same entry twice with different generated IDs during overlapping saves.
        if (options.uniqueName && nameKey && seenNames.has(nameKey)) continue;

        if (!id && options.idPrefix && nameKey) {
            id = `${options.idPrefix}${nameKey}`;
            item.id = id;
        }

        if (id) seenIds.add(id);
        if (options.uniqueName && nameKey) seenNames.add(nameKey);
        out.push(item);
    }
    return out;
}

function normalizeCollections() {
    state.fakemonDB = normalizeCollectionArray(state.fakemonDB);
    state.customMoves = normalizeCollectionArray(state.customMoves, { uniqueName: true, idPrefix: 'cm_' });
    state.customAbilities = normalizeCollectionArray(state.customAbilities, { uniqueName: true, idPrefix: 'ca_' });
    state.customItems = normalizeCollectionArray(state.customItems, { uniqueName: true, idPrefix: 'ci_' });
}

// ==================== auto save ====================


        function autoSave(immediate = false) {
            // shared-link previews and community hub previews are strictly read-only.
            // they may hydrate the editor for rendering, but they can never enter the
            // private collection through this function.
            if (state.isCommunityPreview) {
                if (state.autoSaveTimer) {
                    clearTimeout(state.autoSaveTimer);
                    state.autoSaveTimer = null;
                }
                autoSaveGeneration++;
                log.debug('STORAGE', 'autoSave skipped during read-only preview');
                return Promise.resolve(false);
            }

            // debounced autosave requests only originate from editor changes. this
            // prevents hidden/stale editor DOM from being accidentally persisted when
            // collection/community UI is being navigated.
            const editor = document.getElementById('editor-view');
            if (!editor || editor.style.display === 'none') {
                if (state.autoSaveTimer) {
                    clearTimeout(state.autoSaveTimer);
                    state.autoSaveTimer = null;
                }
                autoSaveGeneration++;
                log.debug('STORAGE', 'autoSave skipped outside the editor');
                return Promise.resolve(false);
            }

            log.debug('STORAGE', 'autoSave requested', { immediate: !!immediate, editingId: state.editingId });

            const nameEl = document.getElementById('fakemon-name');
            const name = nameEl?.value.trim() || '';
            if (!name) {
                updateSaveStatus('unsaved');
                return Promise.resolve(false);
            }

            if (state.autoSaveTimer) {
                clearTimeout(state.autoSaveTimer);
                state.autoSaveTimer = null;
            }

            const generation = ++autoSaveGeneration;

            const doSave = async () => {
                state.autoSaveTimer = null;

                // a newer save, delete, or route transition owns the editor now.
                if (generation !== autoSaveGeneration) {
                    log.debug('STORAGE', 'Discarding stale autosave generation', { generation, current: autoSaveGeneration });
                    return false;
                }

                const done = log.time('STORAGE', 'autoSave commit');
                const fakemon = buildFakemonObject();
                if (!fakemon) return false;

                // claim the new ID before the first await. every later save of this
                // editor session therefore updates the same primary-keyed record.
                const savedId = state.editingId || fakemon.id;
                state.editingId = savedId;
                fakemon.id = savedId;

                const idx = state.fakemonDB.findIndex(f => String(f.id) === String(savedId));
                if (idx !== -1) state.fakemonDB[idx] = fakemon;
                else state.fakemonDB.push(fakemon);
                normalizeCollections();

                await saveToStorage();

                // do not let an older in-flight save update UI state after a delete
                // or a newer editor session has superseded it.
                if (generation !== autoSaveGeneration) {
                    log.debug('STORAGE', 'Autosave finished stale; storage revision protected', { id: fakemon.id });
                    return false;
                }

                done({ id: fakemon.id, name: fakemon.name });
                log.info('STORAGE', 'Fakemon saved', { id: fakemon.id, name: fakemon.name });
                state.lastSavedId = fakemon.id;
                api.onFakemonSaved?.(fakemon.id);
                updateSaveStatus('saved');
                return true;
            };

            if (immediate) {
                return doSave();
            }

            updateSaveStatus('saving');
            return new Promise(resolve => {
                state.autoSaveTimer = setTimeout(() => {
                    doSave().then(resolve).catch(err => {
                        log.error('STORAGE', 'Autosave failed', err);
                        updateSaveStatus('unsaved');
                        resolve(false);
                    });
                }, 800);
            });
        }

        function buildFakemonObject() {
            const name = document.getElementById('fakemon-name').value.trim();
            if (!name) return null;

            return {
                id: state.editingId || Date.now().toString(),
                name: name,
                folderId: state.editingId ? (state.fakemonDB.find(f => f.id === state.editingId)?.folderId ?? null) : (state.currentFolderId || null),
                pinned: state.editingId ? (state.fakemonDB.find(f => f.id === state.editingId)?.pinned || false) : false,
                species: document.getElementById('fakemon-species').value.trim(),
                isMega: !!document.getElementById('fakemon-is-mega')?.checked,
                isFormeChange: !!document.getElementById('fakemon-is-forme')?.checked,
                type1: document.getElementById('fakemon-type1').value,
                type2: document.getElementById('fakemon-type2').value,
                number: document.getElementById('fakemon-number').value.trim(),
                level: parseInt(document.getElementById('editor-level').value) || 100,
                stats: {
                    hp: parseInt(document.getElementById('stat-hp').value) || 60,
                    atk: parseInt(document.getElementById('stat-atk').value) || 60,
                    def: parseInt(document.getElementById('stat-def').value) || 60,
                    spa: parseInt(document.getElementById('stat-spa').value) || 60,
                    spd: parseInt(document.getElementById('stat-spd').value) || 60,
                    spe: parseInt(document.getElementById('stat-spe').value) || 60
                },
                abilities: state.abilities.filter(a => a.name && a.name.trim()).map(a => ({ name: a.name.trim(), source: a.source || 'sd', desc: a.desc || a.description || '' })),
                dexEntry1: document.getElementById('dex-entry1').value.trim(),
                dexEntry2: document.getElementById('dex-entry2').value.trim(),
                height: document.getElementById('fakemon-height').value.trim(),
                weight: document.getElementById('fakemon-weight').value.trim(),
                color: document.getElementById('fakemon-color').value,
                eggGroups: api.getEggGroupValue(),
                genderRatio: api.getGenderRatioValue(),
                learnset: state.learnset.map(m => {
                    if (m && (m.source === 'custom' || m.custom === true)) {
                        return {
                            ...m,
                            source: 'custom',
                            custom: true,
                            learnMethod: m.learnMethod || 'none',
                            level: m.learnMethod === 'level' ? (m.level || null) : null
                        };
                    }
                    return { name: m.name, learnMethod: m.learnMethod || 'none', level: m.level || null };
                }),
                // kept as an empty legacy field so older imports remain compatible.
                customMoves: [],
                sampleSets: state.sampleSets,
                artwork: state.artworkData,
                shinyArtwork: state.shinyArtworkData,
                cry: state.cryData,
                artCredit: state.artCredit,
                evolutionGraph: state.evolutionGraph ? JSON.parse(JSON.stringify(state.evolutionGraph)) : null,
                evolutionStage: state.evolutionGraph && typeof api.calculateEvolutionStages === 'function' ? (api.calculateEvolutionStages(state.evolutionGraph)[state.editingId ? `fakemon:${state.editingId}` : 'current:fakemon'] || 1) : 1,
                createdAt: state.editingId ? (state.fakemonDB.find(f => f.id === state.editingId)?.createdAt || Date.now()) : Date.now(),
                updatedAt: Date.now()
            };
        }

        function updateSaveStatus(status) {
            const el = document.getElementById('save-status');
            if (!el) return;
            if (status === 'saved') {
                el.textContent = 'Saved';
                el.className = 'save-status saved';
            } else if (status === 'saving') {
                el.textContent = 'Saving...';
                el.className = 'save-status saving';
            } else {
                el.textContent = 'Unsaved';
                el.className = 'save-status unsaved';
            }
        }

        
// ==================== save / load ====================

        function saveFakemon() {
            // manual save button - just forces an immediate auto-save
            const name = document.getElementById('fakemon-name').value.trim();
            if (!name) { api.showToast('Please enter a Pokemon name!', 'error'); return; }
            autoSave(true);
            api.showToast('Saved!', 'success');
            api.showCollection();
        }

        async function deleteFakemon(id, event) {
            event.stopPropagation();
            if (!confirm('Are you sure you want to delete this Fakemon?')) return;

            // invalidate both delayed and in-flight autosaves before removing the
            // record. the storage revision queue will also reject any older snapshot.
            if (state.autoSaveTimer) {
                clearTimeout(state.autoSaveTimer);
                state.autoSaveTimer = null;
            }
            autoSaveGeneration++;

            state.fakemonDB = state.fakemonDB.filter(f => String(f.id) !== String(id));
            if (String(state.editingId) === String(id)) {
                state.editingId = null;
                state.lastSavedId = null;
            }

            await saveToStorage();
            api.renderCollection();
            api.showToast('Fakemon deleted!', 'info');
        }

        async function duplicateFakemon(id, event) {
            event.stopPropagation();
            const original = state.fakemonDB.find(f => f.id === id);
            if (!original) return;
            const copy = JSON.parse(JSON.stringify(original));
            copy.id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            copy.name = copy.name + ' (Copy)';
            copy.createdAt = Date.now();
            copy.updatedAt = Date.now();
            state.fakemonDB.push(copy);
            await saveToStorage();
            api.renderCollection();
            api.showToast('Fakemon duplicated!', 'success');
        }

        
// ==================== storage (IndexedDB) ====================
        // storage is local-only (IndexedDB). signing in only grants access to the
        // community hub (publishing/commenting) - it never uploads, backs up, or
        // syncs your private collection anywhere.
        async function saveToStorage() {
            normalizeCollections();

            // snapshot the exact state being requested. IndexedDB writes are async, so
            // never hand it live arrays that may be changed by a delete/edit while a
            // previous write is still in flight.
            const snapshot = {
                fakemonDB: JSON.parse(JSON.stringify(state.fakemonDB)),
                folders: JSON.parse(JSON.stringify(state.folders)),
                customMoves: JSON.parse(JSON.stringify(state.customMoves)),
                customAbilities: JSON.parse(JSON.stringify(state.customAbilities)),
                customItems: JSON.parse(JSON.stringify(state.customItems))
            };

            const revision = ++storageWriteRevision;
            latestStorageWriteRevision = revision;

            storageWriteChain = storageWriteChain.then(async () => {
                // a newer snapshot is already queued, so this snapshot is obsolete.
                // skipping it is what prevents a delete from being resurrected by an
                // older autosave that was already waiting on IndexedDB.
                if (revision !== latestStorageWriteRevision) {
                    log.debug('STORAGE', 'Skipping stale storage snapshot', { revision, latest: latestStorageWriteRevision });
                    return false;
                }

                const done = log.time('STORAGE', 'saveToStorage');
                log.debug('STORAGE', 'Saving collection snapshot', {
                    revision,
                    fakemons: snapshot.fakemonDB.length,
                    folders: snapshot.folders.length,
                    customMoves: snapshot.customMoves.length,
                    customAbilities: snapshot.customAbilities.length,
                    customItems: snapshot.customItems.length
                });

                try {
                    await idbSet('fakemonDB_v4', snapshot.fakemonDB);
                    await idbSet('woogidexFolders_v1', snapshot.folders);
                    await idbSet('woogidexCustomMoves_v1', snapshot.customMoves);
                    await idbSet('woogidexCustomAbilities_v1', snapshot.customAbilities);
                    await idbSet('woogidexCustomItems_v1', snapshot.customItems);
                    done({ revision, fakemons: snapshot.fakemonDB.length });
                    log.info('STORAGE', 'Collection saved', { revision });
                    return true;
                } catch (e) {
                    log.error('STORAGE', 'Collection save failed', e);
                    api.showToast('Warning: Storage limit may be reached. Export your collection!', 'error');
                    return false;
                }
            });

            return storageWriteChain;
        }

        async function loadFromStorage() {
            const done = log.time('STORAGE', 'loadFromStorage');
            log.info('STORAGE', 'Loading persisted application state');
            try {
                const data = await idbGet('fakemonDB_v4');
                if (Array.isArray(data)) {
                    state.fakemonDB = data;
                } else {
                    // one-time migration for existing users: earlier versions of this
                    // app kept the collection in localStorage. if IndexedDB is empty,
                    // pull whatever legacy copy exists there, adopt it, and persist it
                    // into IndexedDB going forward.
                    const legacy = localStorage.getItem('fakemonDB_v4')
                        || localStorage.getItem('fakemonDB_v3')
                        || localStorage.getItem('fakemonDB_v2')
                        || localStorage.getItem('fakemonDB');
                    if (legacy) {
                        state.fakemonDB = JSON.parse(legacy);
                        await saveToStorage();
                        ['fakemonDB_v4', 'fakemonDB_v3', 'fakemonDB_v2', 'fakemonDB'].forEach(k => localStorage.removeItem(k));
                    } else {
                        state.fakemonDB = [];
                    }
                }
                const folders = await idbGet('woogidexFolders_v1');
                state.folders = Array.isArray(folders) ? folders : [];
                const customMoves = await idbGet('woogidexCustomMoves_v1');
                const customAbilities = await idbGet('woogidexCustomAbilities_v1');
                const customItems = await idbGet('woogidexCustomItems_v1');
                state.customMoves = Array.isArray(customMoves) ? customMoves : [];
                state.customAbilities = Array.isArray(customAbilities) ? customAbilities : [];
                state.customItems = Array.isArray(customItems) ? customItems : [];
                normalizeCollections();
                migrateCustomLibrariesFromCollection();
                normalizeCollections();
                await saveToStorage();
            } catch (e) { state.fakemonDB = []; state.folders = []; }
            await migrateLearnsetsToMinimal();
        }
        function migrateCustomLibrariesFromCollection() {
            const moveMap = new Map((state.customMoves || []).filter(m => m && m.id).map(m => [m.id, m]));
            const abilityMap = new Map((state.customAbilities || []).filter(a => a && a.id).map(a => [a.id, a]));
            const itemMap = new Map((state.customItems || []).filter(i => i && i.id).map(i => [i.id, i]));
            state.fakemonDB.forEach(f => {
                (f.sampleSets || []).forEach(set => {
                    const name = String(set?.item || '').trim();
                    if (name && set.itemCustom === true) {
                        const id = set.itemCustomId || ('ci_' + name.toLowerCase().replace(/[^a-z0-9]+/g,'-'));
                        set.itemCustomId = id;
                        if (!itemMap.has(id)) itemMap.set(id, { id, name, desc: set.itemDesc || '', source:'custom', custom:true });
                    }
                });
                (f.learnset || []).forEach(m => {
                    if (m && (m.source === 'custom' || m.custom === true) && m.name) {
                        const id = m.customId || ('cm_' + String(m.name).toLowerCase().replace(/[^a-z0-9]+/g,'-'));
                        m.customId = id;
                        if (!moveMap.has(id)) moveMap.set(id, { id, name:m.name, type:m.type||'Normal', category:m.category||'Status', basePower:m.basePower||0, accuracy:m.accuracy ?? 100, pp:m.pp||10, priority:m.priority||0, flags:m.flags||{}, desc:m.desc||'' });
                    }
                });
                (f.abilities || []).forEach(a => {
                    if (a && (a.source === 'custom' || a.custom === true) && a.name) {
                        const id = a.customId || ('ca_' + String(a.name).toLowerCase().replace(/[^a-z0-9]+/g,'-'));
                        a.customId = id;
                        if (!abilityMap.has(id)) abilityMap.set(id, { id, name:a.name, desc:a.desc || a.description || '' });
                    }
                });
            });
            state.customMoves = [...moveMap.values()];
            state.customAbilities = [...abilityMap.values()];
            state.customItems = [...itemMap.values()];
        }

        // normalize legacy learnsets without destroying unified custom moves.
        // vanilla moves can safely be stored minimally because Showdown data is the
        // authoritative source for their properties. custom moves cannot: their full
        // move definition (including source/custom marker) must survive browser reloads.
        async function migrateLearnsetsToMinimal() {
            let changed = false;
            state.fakemonDB.forEach(f => {
                if (!Array.isArray(f.learnset)) return;
                f.learnset = f.learnset.map(m => {
                    if (!m || !m.name) return m;

                    // never strip a unified custom move. this is the critical guard that
                    // prevents a browser reload from turning it back into a vanilla move.
                    if (m.source === 'custom' || m.custom === true) {
                        return {
                            ...m,
                            source: 'custom',
                            custom: true,
                            learnMethod: m.learnMethod || 'none',
                            level: m.learnMethod === 'level' ? (m.level || null) : null,
                            flags: m.flags || {}
                        };
                    }

                    const minimal = {
                        name: m.name,
                        learnMethod: m.learnMethod || 'none',
                        level: m.level || null
                    };
                    if (JSON.stringify(m) !== JSON.stringify(minimal)) changed = true;
                    return minimal;
                });

                // older builds kept custom moves in a separate customMoves array. if that
                // field still exists, migrate them into the unified learnset once.
                if (Array.isArray(f.customMoves) && f.customMoves.length) {
                    const existingCustomNames = new Set(
                        f.learnset.filter(m => m && (m.source === 'custom' || m.custom === true)).map(m => m.name)
                    );
                    f.customMoves.forEach(m => {
                        if (!m || !m.name || existingCustomNames.has(m.name)) return;
                        f.learnset.push({
                            ...m,
                            source: 'custom',
                            custom: true,
                            learnMethod: m.learnMethod || 'none',
                            level: m.learnMethod === 'level' ? (m.level || null) : null,
                            flags: m.flags || {}
                        });
                        changed = true;
                    });
                    // the unified system no longer needs a second source of truth.
                    if (f.customMoves.length) { f.customMoves = []; changed = true; }
                }
            });
            if (changed) await saveToStorage();
        }

        

export { autoSave, buildFakemonObject, updateSaveStatus, saveFakemon, deleteFakemon, duplicateFakemon, saveToStorage, loadFromStorage, migrateLearnsetsToMinimal, migrateCustomLibrariesFromCollection };