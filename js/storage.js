import { state, api } from './app.js';

// ==================== INDEXEDDB ====================
        const IDB_NAME = 'woogidex-db';
        const IDB_VERSION = 1;
        const IDB_STORE = 'kv';
        let idbPromise = null;

        function openDB() {
            if (idbPromise) return idbPromise;
            idbPromise = new Promise((resolve, reject) => {
                if (!('indexedDB' in window)) { reject(new Error('IndexedDB not supported')); return; }
                const req = indexedDB.open(IDB_NAME, IDB_VERSION);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            return idbPromise;
        }
        function idbGet(key) {
            return openDB().then(db => new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get(key);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
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

// ==================== AUTO SAVE ====================


        function autoSave(immediate) {
            // Don't auto-save if there's no name yet (silently skip)
            const name = document.getElementById('fakemon-name').value.trim();
            if (!name) {
                updateSaveStatus('unsaved');
                return;
            }

            if (state.autoSaveTimer) clearTimeout(state.autoSaveTimer);

            const doSave = async () => {
                const fakemon = buildFakemonObject();
                if (!fakemon) return;

                if (state.editingId) {
                    const idx = state.fakemonDB.findIndex(f => f.id === state.editingId);
                    if (idx !== -1) state.fakemonDB[idx] = fakemon;
                    else state.fakemonDB.push(fakemon);
                } else {
                    state.fakemonDB.push(fakemon);
                    state.editingId = fakemon.id;
                }

                await saveToStorage();
                state.lastSavedId = fakemon.id;
                updateSaveStatus('saved');
            };

            if (immediate) {
                doSave();
            } else {
                updateSaveStatus('saving');
                state.autoSaveTimer = setTimeout(doSave, 800);
            }
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
                // Kept as an empty legacy field so older imports remain compatible.
                customMoves: [],
                sampleSets: state.sampleSets,
                artwork: state.artworkData,
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

        
// ==================== SAVE / LOAD ====================

        function saveFakemon() {
            // Manual save button - just forces an immediate auto-save
            const name = document.getElementById('fakemon-name').value.trim();
            if (!name) { api.showToast('Please enter a Pokemon name!', 'error'); return; }
            autoSave(true);
            api.showToast('Saved!', 'success');
            api.showCollection();
        }

        async function deleteFakemon(id, event) {
            event.stopPropagation();
            if (!confirm('Are you sure you want to delete this Fakemon?')) return;
            state.fakemonDB = state.fakemonDB.filter(f => f.id !== id);
            await saveToStorage();
            api.renderCollection();
            api.showToast('Fakemon deleted!', 'info');
        }

        async function duplicateFakemon(id, event) {
            event.stopPropagation();
            const original = state.fakemonDB.find(f => f.id === id);
            if (!original) return;
            const copy = JSON.parse(JSON.stringify(original));
            copy.id = Date.now().toString();
            copy.name = copy.name + ' (Copy)';
            copy.createdAt = Date.now();
            copy.updatedAt = Date.now();
            state.fakemonDB.push(copy);
            await saveToStorage();
            api.renderCollection();
            api.showToast('Fakemon duplicated!', 'success');
        }

        
// ==================== STORAGE (IndexedDB) ====================
        async function saveToStorage() {
            try {
                await idbSet('fakemonDB_v4', state.fakemonDB);
                await idbSet('woogidexFolders_v1', state.folders);
                await idbSet('woogidexCustomMoves_v1', state.customMoves);
                await idbSet('woogidexCustomAbilities_v1', state.customAbilities);
            }
            catch (e) { api.showToast('Warning: Storage limit may be reached. Export your collection!', 'error'); }
        }
        async function loadFromStorage() {
            try {
                const data = await idbGet('fakemonDB_v4');
                if (Array.isArray(data)) {
                    state.fakemonDB = data;
                } else {
                    // One-time migration for existing users: earlier versions of this
                    // app kept the collection in localStorage. If IndexedDB is empty,
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
                state.customMoves = Array.isArray(customMoves) ? customMoves : [];
                state.customAbilities = Array.isArray(customAbilities) ? customAbilities : [];
                migrateCustomLibrariesFromCollection();
                await saveToStorage();
            } catch (e) { state.fakemonDB = []; state.folders = []; }
            await migrateLearnsetsToMinimal();
        }
        function migrateCustomLibrariesFromCollection() {
            const moveMap = new Map((state.customMoves || []).filter(m => m && m.id).map(m => [m.id, m]));
            const abilityMap = new Map((state.customAbilities || []).filter(a => a && a.id).map(a => [a.id, a]));
            state.fakemonDB.forEach(f => {
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
        }

        // Normalize legacy learnsets without destroying unified custom moves.
        // Vanilla moves can safely be stored minimally because Showdown data is the
        // authoritative source for their properties. Custom moves cannot: their full
        // move definition (including source/custom marker) must survive browser reloads.
        async function migrateLearnsetsToMinimal() {
            let changed = false;
            state.fakemonDB.forEach(f => {
                if (!Array.isArray(f.learnset)) return;
                f.learnset = f.learnset.map(m => {
                    if (!m || !m.name) return m;

                    // Never strip a unified custom move. This is the critical guard that
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

                // Older builds kept custom moves in a separate customMoves array. If that
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
                    // The unified system no longer needs a second source of truth.
                    if (f.customMoves.length) { f.customMoves = []; changed = true; }
                }
            });
            if (changed) await saveToStorage();
        }

        

export { autoSave, buildFakemonObject, updateSaveStatus, saveFakemon, deleteFakemon, duplicateFakemon, saveToStorage, loadFromStorage, migrateLearnsetsToMinimal, migrateCustomLibrariesFromCollection };