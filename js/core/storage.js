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

// ==================== wipe guards ====================
// Every previously-reported "my collection vanished" traced back to the same
// shape: something made the in-memory collection empty (or shorter), and the
// next ordinary save faithfully wrote that over the good data in IndexedDB.
// The in-memory copy is only ever a safe thing to persist once we have proved
// we loaded the stored one, so writes are gated on that proof.
let collectionLoaded = false;      // did loadFromStorage() actually read the collection?
let loadFailureReported = false;   // only nag the user once per session
let lastKnownCount = 0;            // Fakemon count of the last known-good state
const MIRROR_KEY = 'woogidexCollectionMirror_v1';
const MIRROR_MIN_INTERVAL_MS = 5 * 60 * 1000;
let lastMirrorAt = 0;

/** True once the stored collection has been read successfully this session. */
export function isCollectionLoaded() { return collectionLoaded; }

function reportLoadFailure(e) {
    collectionLoaded = false;
    if (loadFailureReported) return;
    loadFailureReported = true;
    log.error('STORAGE', 'Collection could not be read; saving is disabled for this session', e);
    api.showToast?.(
        "We couldn't open your saved collection. Nothing has been changed or deleted - "
        + 'reload the page before editing, so a save cannot overwrite it.',
        'error'
    );
}

/**
 * Keeps a second copy of the last known-good collection in its own IndexedDB
 * key, so "Check for lost Fakemon" has something to find. The old recovery
 * path only ever looked at the pre-IndexedDB localStorage keys, which most
 * accounts never had, so for them the check could only ever find nothing.
 * Throttled, best-effort, and never allowed to fail a real save.
 */
async function writeMirror(snapshot) {
    if (!snapshot.fakemonDB.length) return;            // never mirror an empty state over a real one
    const now = Date.now();
    if (now - lastMirrorAt < MIRROR_MIN_INTERVAL_MS) return;
    lastMirrorAt = now;
    try {
        await idbSet(MIRROR_KEY, { savedAt: now, ...snapshot });
        log.debug('STORAGE', 'Safety mirror updated', { fakemons: snapshot.fakemonDB.length });
    } catch (e) {
        // Out of quota is the likely cause, and the primary write already
        // succeeded. Drop the half-written mirror so the extra copy can never
        // be the reason a later real save runs out of room, and stop retrying
        // it this session.
        lastMirrorAt = Number.MAX_SAFE_INTEGER;
        try { await idbDel(MIRROR_KEY); } catch { /* nothing more we can do */ }
        log.warn('STORAGE', 'Safety mirror write failed and was discarded; primary save was fine', e);
    }
}

/** The last known-good collection snapshot, or null. Read by js/features/recovery.js. */
export async function readCollectionMirror() {
    try {
        const mirror = await idbGet(MIRROR_KEY);
        return mirror && Array.isArray(mirror.fakemonDB) ? mirror : null;
    } catch (e) {
        log.warn('STORAGE', 'Safety mirror read failed', e);
        return null;
    }
}

        function openDB() {
            log.debug('STORAGE', 'openDB requested', { database: IDB_NAME, version: IDB_VERSION });
            if (idbPromise) return idbPromise;
            const attempt = new Promise((resolve, reject) => {
                if (!('indexedDB' in window)) { reject(new Error('IndexedDB not supported')); return; }
                const req = indexedDB.open(IDB_NAME, IDB_VERSION);
                req.onupgradeneeded = (e) => {
                    log.info('STORAGE', 'IndexedDB upgrade', { version: e.newVersion });
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
                };
                req.onsuccess = () => {
                    const db = req.result;
                    // a versionchange from another tab closes this handle; drop the
                    // cached promise so the next call reopens instead of using a dead db
                    db.onversionchange = () => { db.close(); if (idbPromise === attempt) idbPromise = null; };
                    db.onclose = () => { if (idbPromise === attempt) idbPromise = null; };
                    log.info('STORAGE', 'IndexedDB opened');
                    resolve(db);
                };
                req.onerror = () => { log.error('STORAGE', 'IndexedDB open failed', req.error); reject(req.error); };
                req.onblocked = () => log.warn?.('STORAGE', 'IndexedDB open blocked by another tab');
            });
            // never cache a rejection: a transient open failure used to poison every
            // later read AND write for the whole session, which is how a collection
            // could look empty and then get saved that way
            idbPromise = attempt.catch(err => { if (idbPromise === attempt) idbPromise = null; throw err; });
            return idbPromise;
        }
        function idbGet(key) {
            return openDB().then(db => new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get(key);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => { log.error('STORAGE', 'IndexedDB read failed', { key, error: req.error }); reject(req.error); };
                tx.onabort = () => reject(tx.error || new Error('IndexedDB read aborted'));
            }));
        }
        function idbSet(key, value) {
            return openDB().then(db => new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).put(value, key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
            }));
        }
        function idbDel(key) {
            return openDB().then(db => new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).delete(key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('IndexedDB delete aborted'));
            }));
        }

        // Browsers evict "best effort" origin data under storage pressure, and Safari
        // clears it outright after ~7 days without a visit. That is a silent, total
        // collection wipe with no error for us to catch, and it is the one cause the
        // guards below cannot detect after the fact. Asking for persistent storage is
        // the only thing that opts an origin out of it.
        async function requestPersistentStorage() {
            try {
                if (!navigator.storage?.persist) return false;
                if (await navigator.storage.persisted()) { log.info('STORAGE', 'Storage already persistent'); return true; }
                const granted = await navigator.storage.persist();
                log.info('STORAGE', 'Persistent storage requested', { granted });
                return granted;
            } catch (e) {
                log.debug('STORAGE', 'Persistent storage request unavailable', e);
                return false;
            }
        }

// older builds could append duplicate entries during overlapping saves;
// normalize on load/save so they can't accumulate
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
        // custom libraries are name-unique in the UI; dedupe by name too
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

        function autoSave(immediate = false) {
            // shared-link/community hub previews are strictly read-only and
            // must never enter the private collection through this function
            if (state.isCommunityPreview) {
                if (state.autoSaveTimer) {
                    clearTimeout(state.autoSaveTimer);
                    state.autoSaveTimer = null;
                }
                autoSaveGeneration++;
                log.debug('STORAGE', 'autoSave skipped during read-only preview');
                return Promise.resolve(false);
            }

            // only save while the editor is actually visible, not stale hidden DOM
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

                // a newer save/delete/route transition owns the editor now
                if (generation !== autoSaveGeneration) {
                    log.debug('STORAGE', 'Discarding stale autosave generation', { generation, current: autoSaveGeneration });
                    return false;
                }

                const done = log.time('STORAGE', 'autoSave commit');
                const fakemon = buildFakemonObject();
                if (!fakemon) return false;

                // claim the ID before the first await so later saves in this session update the same record
                const savedId = state.editingId || fakemon.id;
                state.editingId = savedId;
                fakemon.id = savedId;

                const idx = state.fakemonDB.findIndex(f => String(f.id) === String(savedId));
                if (idx !== -1) state.fakemonDB[idx] = fakemon;
                else state.fakemonDB.push(fakemon);
                normalizeCollections();

                // a refused write must not be reported as a save; the guards in
                // saveToStorage() only help if the user finds out it happened
                const written = await saveToStorage();
                if (!written) {
                    updateSaveStatus('unsaved');
                    return false;
                }

                // don't let a stale in-flight save update UI after a delete/newer session
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
                // customId persisted so a custom ability keeps pointing at its
                // library entry rather than relying on name, which breaks if two share one
                abilities: state.abilities.filter(a => a.name && a.name.trim()).map(a => {
                    const entry = { name: a.name.trim(), source: a.source || 'sd', desc: a.desc || a.description || '' };
                    if (a.customId) entry.customId = a.customId;
                    return entry;
                }),
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
                // empty legacy field kept for older import compatibility
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

        async function saveFakemon() {
            // manual save button forces an immediate auto-save
            const name = document.getElementById('fakemon-name').value.trim();
            if (!name) { api.showToast('Please enter a Pokemon name!', 'error'); return; }
            // awaited so a blocked write reports the failure instead of "Saved!"
            // and leaves the user in the editor with their work still on screen
            if (!await autoSave(true)) return;
            api.showToast('Saved!', 'success');
            api.showCollection();
        }

        async function deleteFakemon(id, event) {
            event.stopPropagation();
            const shouldConfirm = api.getConfirmBeforeDelete ? api.getConfirmBeforeDelete() : true;
            if (shouldConfirm && !confirm('Are you sure you want to delete this Fakemon?')) return;

            // invalidate delayed/in-flight autosaves before removing the record
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

            await saveToStorage({ allowEmpty: true });
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

        
        // local-only (IndexedDB); nothing here reaches the network. The only way
        // a collection leaves the device is the opt-in Cloud Backup button
        // (js/features/cloud-save.js), which is manual, never automatic.
        async function saveToStorage(options = {}) {
            // Nothing in memory is trustworthy until the stored collection has been
            // read back. Writing here would replace a real collection with whatever
            // this session happens to be holding - which is exactly how a failed
            // read turned into a permanent wipe.
            if (!collectionLoaded) {
                log.error('STORAGE', 'Refusing to save: the stored collection was never loaded this session');
                reportLoadFailure(new Error('save attempted before a successful load'));
                return false;
            }

            normalizeCollections();

            // Emptying the collection is only ever the result of deleting the last
            // Fakemon, and that path says so. Any other write that would drop the
            // collection to nothing is a bug somewhere upstream, so drop the write
            // instead of the user's Fakemon.
            if (!options.allowEmpty && !state.fakemonDB.length && lastKnownCount > 0) {
                log.error('STORAGE', 'Refusing to save an empty collection over a non-empty one', { lastKnownCount });
                api.showToast?.('Something tried to empty your collection. The save was blocked - please reload the page.', 'error');
                return false;
            }

            // snapshot now since IndexedDB writes are async and live arrays could
            // change from a delete/edit while a previous write is still in flight
            const snapshot = {
                fakemonDB: JSON.parse(JSON.stringify(state.fakemonDB)),
                folders: JSON.parse(JSON.stringify(state.folders)),
                customMoves: JSON.parse(JSON.stringify(state.customMoves)),
                customAbilities: JSON.parse(JSON.stringify(state.customAbilities)),
                customItems: JSON.parse(JSON.stringify(state.customItems)),
                // battle teams reference Fakemon ids, so editing one updates every team using it
                battleTeams: JSON.parse(JSON.stringify(state.battleTeams || []))
            };

            const revision = ++storageWriteRevision;
            latestStorageWriteRevision = revision;

            storageWriteChain = storageWriteChain.then(async () => {
                // skip if a newer snapshot is already queued, so a delete can't be
                // resurrected by an older autosave still waiting on IndexedDB
                if (revision !== latestStorageWriteRevision) {
                    log.debug('STORAGE', 'Skipping stale storage snapshot', { revision, latest: latestStorageWriteRevision });
                    // true, not false: a newer snapshot of the same live state is
                    // already queued and will be written, so this is superseded
                    // rather than failed, and callers must not report it as unsaved
                    return true;
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
                    await idbSet('woogidexBattleTeams_v1', snapshot.battleTeams);
                    lastKnownCount = snapshot.fakemonDB.length;
                    await writeMirror(snapshot);
                    done({ revision, fakemons: snapshot.fakemonDB.length });
                    log.info('STORAGE', 'Collection saved', { revision });
                    // no-op unless auto-backup is on; coalesces edits into one upload
                    api.scheduleAutoBackup?.();
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

            collectionLoaded = false;
            requestPersistentStorage();  // fire and forget; nothing below depends on it

            // A failed read is NOT an empty collection. Previously this caught the
            // error, set fakemonDB to [], and then the save at the end of this same
            // function wrote that empty array over the real one - one transient
            // IndexedDB error was enough to destroy a collection permanently. Now a
            // read failure leaves state alone and locks saving for the session, so
            // the worst case is a session that cannot save rather than one that
            // deletes everything.
            let attempts = 0;
            for (;;) {
                try {
                    const data = await idbGet('fakemonDB_v4');
                    if (Array.isArray(data)) {
                        state.fakemonDB = data;
                    } else {
                        // one-time migration: earlier versions stored the collection in
                        // localStorage. left in place afterward rather than cleared - see
                        // recovery.js, which treats it as an independent backup copy
                        const legacy = localStorage.getItem('fakemonDB_v4')
                            || localStorage.getItem('fakemonDB_v3')
                            || localStorage.getItem('fakemonDB_v2')
                            || localStorage.getItem('fakemonDB');
                        state.fakemonDB = legacy ? JSON.parse(legacy) : [];
                    }
                    collectionLoaded = true;
                    break;
                } catch (e) {
                    // one retry: the common failures here (a still-opening database, a
                    // connection closed by another tab's upgrade) clear immediately
                    if (++attempts > 2) {
                        reportLoadFailure(e);
                        done({ failed: true });
                        return;
                    }
                    log.warn('STORAGE', 'loadFromStorage: collection read failed, retrying', e);
                    await new Promise(r => setTimeout(r, 250));
                }
            }

            lastKnownCount = state.fakemonDB.length;

            // These are secondary: an empty custom-move library is a real state, and
            // failing to read one is not a reason to refuse to load the collection.
            const loadArray = async (key, label) => {
                try {
                    const value = await idbGet(key);
                    return Array.isArray(value) ? value : [];
                } catch (e) {
                    log.error('STORAGE', `loadFromStorage: ${label} fetch failed, starting from empty`, e);
                    return [];
                }
            };
            state.folders = await loadArray('woogidexFolders_v1', 'folders');
            state.customMoves = await loadArray('woogidexCustomMoves_v1', 'customMoves');
            state.customAbilities = await loadArray('woogidexCustomAbilities_v1', 'customAbilities');
            state.customItems = await loadArray('woogidexCustomItems_v1', 'customItems');
            state.battleTeams = await loadArray('woogidexBattleTeams_v1', 'battleTeams');

            // Mirror what was actually in storage, before this session can change
            // anything. Recovering to the state the collection was in when the
            // page opened is more useful than recovering to some point after the
            // edit that lost something.
            await writeMirror({
                fakemonDB: state.fakemonDB,
                folders: state.folders,
                customMoves: state.customMoves,
                customAbilities: state.customAbilities,
                customItems: state.customItems,
                battleTeams: state.battleTeams
            });

            // whatever loaded above is now the source of truth; log normalization
            // failures but never fall back to wiping it
            try {
                const countsBefore = collectionCounts();
                normalizeCollections();
                migrateCustomLibrariesFromCollection();
                normalizeCollections();
                // Only write if boot actually changed something. Saving on every boot
                // rewrites the whole collection for no reason, and every rewrite is
                // another chance to persist a bad state.
                if (collectionCounts() !== countsBefore) await saveToStorage({ allowEmpty: true });
            } catch (e) {
                log.error('STORAGE', 'loadFromStorage: post-load normalization failed; collection left untouched', e);
            }

            await migrateLearnsetsToMinimal();
            done({ fakemons: state.fakemonDB.length });
        }

        function collectionCounts() {
            return [state.fakemonDB, state.customMoves, state.customAbilities, state.customItems]
                .map(a => (a || []).length).join('/');
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

        // vanilla moves store minimally since Showdown data is authoritative for
        // them; custom moves need their full definition to survive reloads
        async function migrateLearnsetsToMinimal() {
            let changed = false;
            state.fakemonDB.forEach(f => {
                if (!Array.isArray(f.learnset)) return;
                f.learnset = f.learnset.map(m => {
                    if (!m || !m.name) return m;

                    // never strip a custom move back down to a vanilla one on reload
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

                // older builds kept custom moves in a separate array; migrate once
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
                    if (f.customMoves.length) { f.customMoves = []; changed = true; }
                }
            });
            if (changed) await saveToStorage();
        }

        

export { autoSave, buildFakemonObject, updateSaveStatus, saveFakemon, deleteFakemon, duplicateFakemon, saveToStorage, loadFromStorage, migrateLearnsetsToMinimal, migrateCustomLibrariesFromCollection, requestPersistentStorage };