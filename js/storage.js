import { log } from './log.js';
import { state, api } from './app.js';

// ==================== INDEXEDDB ====================
        const IDB_NAME = 'woogidex-db';
        const IDB_VERSION = 1;
        const IDB_STORE = 'kv';
        let idbPromise = null;

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

// ==================== COLLECTION NORMALIZATION ====================
// IDs are the primary key for every saved collection entry. Older builds could
// accidentally append the same object more than once during overlapping saves.
// Normalize on load/save so duplicates can no longer accumulate.
function normalizeCollectionArray(arr) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const id = String(item.id ?? '').trim();
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        out.push(item);
    }
    return out;
}
function normalizeCollections() {
    state.fakemonDB = normalizeCollectionArray(state.fakemonDB);
    state.customMoves = normalizeCollectionArray(state.customMoves);
    state.customAbilities = normalizeCollectionArray(state.customAbilities);
    state.customItems = normalizeCollectionArray(state.customItems);
}

// ==================== AUTO SAVE ====================


        function autoSave(immediate) {
            // Shared-link previews and Community Hub previews are read-only.
            // Loading a Fakemon into the editor for either is only for
            // rendering/rehydration and must never create or overwrite a
            // collection entry through the normal autosave pipeline.
            if (state.isShareRoute || state.isCommunityPreview) {
                log.debug('STORAGE', 'autoSave skipped during read-only preview');
                return;
            }
            log.debug('STORAGE', 'autoSave requested', { immediate: !!immediate, editingId: state.editingId });
            // Don't auto-save if there's no name yet (silently skip)
            const name = document.getElementById('fakemon-name').value.trim();
            if (!name) {
                updateSaveStatus('unsaved');
                return;
            }

            if (state.autoSaveTimer) {
                clearTimeout(state.autoSaveTimer);
                state.autoSaveTimer = null;
            }

            const doSave = async () => {
                state.autoSaveTimer = null;
                const done = log.time('STORAGE', 'autoSave commit');
                const fakemon = buildFakemonObject();
                if (!fakemon) return;

                // Claim the new ID before awaiting IndexedDB. This closes a race
                // where two auto-saves could both see editingId as empty and append
                // the same newly-created Fakemon.
                if (!state.editingId) state.editingId = fakemon.id;
                const idx = state.fakemonDB.findIndex(f => String(f.id) === String(state.editingId));
                if (idx !== -1) state.fakemonDB[idx] = fakemon;
                else state.fakemonDB.push(fakemon);
                normalizeCollections();

                await saveToStorage();
                done({ id: fakemon.id, name: fakemon.name });
                log.info('STORAGE', 'Fakemon saved', { id: fakemon.id, name: fakemon.name });
                state.lastSavedId = fakemon.id;
                api.onFakemonSaved?.(fakemon.id);
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
                // Kept as an empty legacy field so older imports remain compatible.
                customMoves: [],
                sampleSets: state.sampleSets,
                artwork: state.artworkData,
                shinyArtwork: state.shinyArtworkData,
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
            copy.id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
            const done = log.time('STORAGE', 'saveToStorage');
            log.debug('STORAGE', 'Saving collection', { fakemons: state.fakemonDB.length, folders: state.folders.length, customMoves: state.customMoves.length });
            try {
                normalizeCollections();
                await idbSet('fakemonDB_v4', state.fakemonDB);
                await idbSet('woogidexFolders_v1', state.folders);
                await idbSet('woogidexCustomMoves_v1', state.customMoves);
                await idbSet('woogidexCustomAbilities_v1', state.customAbilities);
                await idbSet('woogidexCustomItems_v1', state.customItems);
                done({ fakemons: state.fakemonDB.length });
                log.info('STORAGE', 'Collection saved');
            }
            catch (e) { log.error('STORAGE', 'Collection save failed', e); api.showToast('Warning: Storage limit may be reached. Export your collection!', 'error'); }

            // Mirror to Supabase when the user is logged in. This is fire-and-forget
            // and never blocks the local (IndexedDB) save above — local storage is
            // always the source of truth for immediate UI responsiveness; the cloud
            // copy is best-effort backup/sync across devices.
            pushToCloud();
        }

        // ==================== CLOUD SYNC (Supabase) ====================
        let cloudPushTimer = null;

        function pushToCloud() {
            if (!state.user) return; // not logged in — local-only mode
            if (cloudPushTimer) clearTimeout(cloudPushTimer);
            cloudPushTimer = setTimeout(async () => {
                cloudPushTimer = null;
                try {
                    const client = await api.getClient();
                    const payload = {
                        user_id: state.user.id,
                        fakemon_db: state.fakemonDB,
                        folders: state.folders,
                        custom_moves: state.customMoves,
                        custom_abilities: state.customAbilities,
                        custom_items: state.customItems,
                        updated_at: new Date().toISOString()
                    };
                    const { error } = await client.from('collections').upsert(payload, { onConflict: 'user_id' });
                    if (error) throw error;
                    log.info('STORAGE', 'Cloud sync: pushed', { fakemons: state.fakemonDB.length });
                } catch (e) {
                    log.error('STORAGE', 'Cloud sync: push failed', e);
                    api.showToast?.('Cloud sync failed — your data is still saved locally.', 'warning');
                }
            }, 1200); // debounce so rapid edits don't spam the network
        }

        // Pulls the logged-in user's cloud collection and adopts it as the local
        // collection. Called right after sign-in. If the user has local data from
        // before logging in (e.g. they made a few fakemon anonymously) and the
        // cloud is empty, we push the local data up instead of wiping it.
        async function pullFromCloud() {
            if (!state.user) return;
            try {
                const client = await api.getClient();
                const { data, error } = await client
                    .from('collections')
                    .select('*')
                    .eq('user_id', state.user.id)
                    .maybeSingle();
                if (error) throw error;

                const hasLocalData = state.fakemonDB.length > 0;
                const hasCloudData = data && Array.isArray(data.fakemon_db) && data.fakemon_db.length > 0;

                if (hasCloudData) {
                    state.fakemonDB = data.fakemon_db || [];
                    state.folders = data.folders || [];
                    state.customMoves = data.custom_moves || [];
                    state.customAbilities = data.custom_abilities || [];
                    state.customItems = data.custom_items || [];
                    normalizeCollections();
                    await saveToStorage(); // caches the cloud copy into IndexedDB too
                    log.info('STORAGE', 'Cloud sync: pulled', { fakemons: state.fakemonDB.length });
                } else if (hasLocalData) {
                    // Nothing in the cloud yet, but there's local data — adopt it as
                    // this account's collection by pushing it up immediately.
                    pushToCloud();
                }
            } catch (e) {
                log.error('STORAGE', 'Cloud sync: pull failed', e);
                api.showToast?.('Could not load your cloud collection — showing local data.', 'warning');
            }
        }
        async function loadFromStorage() {
            const done = log.time('STORAGE', 'loadFromStorage');
            log.info('STORAGE', 'Loading persisted application state');
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

        

export { autoSave, buildFakemonObject, updateSaveStatus, saveFakemon, deleteFakemon, duplicateFakemon, saveToStorage, loadFromStorage, migrateLearnsetsToMinimal, migrateCustomLibrariesFromCollection, pushToCloud, pullFromCloud };