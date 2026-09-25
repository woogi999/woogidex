// The app's one shared, mutable state object. Storage, the editor, battle and
// analysis code read and write it in place; React components read it and
// re-render on notify() (js/app/store.ts). js/core/app.ts re-exports it, so
// older modules keep importing it from there.

import type { Fakemon, FolderEntry, CustomMove, CustomAbility, CustomItem, User, Id } from './types.ts';

function readBool(key: string): boolean {
    try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}

export interface AppState {
    // Showdown data, loaded after boot
    sdMoves: Record<string, any>;
    sdAbilities: Record<string, any>;
    sdItems: Record<string, any>;
    sdPokedex: Record<string, any>;
    sdLearnsets: Record<string, any>;
    sdLearnsetsLoaded: boolean;
    pokeApiSpeciesCache: Record<string, any>;
    sdMoveUsefulness: Record<string, any>;
    sdLoaded: boolean;

    // the collection
    fakemonDB: Fakemon[];
    folders: FolderEntry[];
    customMoves: CustomMove[];
    customAbilities: CustomAbility[];
    customItems: CustomItem[];
    battleTeams: any[];
    currentFolderId: Id | null;

    // the editor's working copy
    editingId: Id | null;
    /** which saved Fakemon the editor was actually populated from; autoSave refuses to overwrite any other */
    editorLoadedId: Id | null;
    abilities: any[];
    learnset: any[];
    sampleSets: any[];
    artworkData: string | null;
    shinyArtworkData: string | null;
    cryData: string | null;
    artCredit: any;
    artworkMode: 'normal' | 'shiny' | string;
    previewArtworkMode: 'normal' | 'shiny' | string;
    collectionShinyPreview: boolean;
    autoSaveTimer: ReturnType<typeof setTimeout> | null;
    lastSavedId: Id | null;
    evolutionGraph: any;
    pendingVanillaDraft?: boolean;
    pendingVanillaId?: string | null;
    isCommunityPreview?: boolean;
    signatureMoveIds?: any;

    // account and pages
    user?: User | null;
    authReady?: boolean;
    profilePageUser: any;
    profilePageEditing: boolean;
    profilePageStatus?: 'loading' | 'ready' | 'error';
    profilePageError?: string;
    community?: any;
    notifications?: any;
    cloud?: any;

    [extra: string]: any;
}

export const state: AppState = {
    sdMoves: {},
    sdAbilities: {},
    sdItems: {},
    sdPokedex: {},
    sdLearnsets: {},
    sdLearnsetsLoaded: false,
    pokeApiSpeciesCache: {},
    sdMoveUsefulness: {},
    sdLoaded: false,
    fakemonDB: [],
    folders: [],
    customMoves: [],
    customAbilities: [],
    customItems: [],
    battleTeams: [],
    currentFolderId: null,
    editingId: null,
    editorLoadedId: null,
    // NOTE: editor draft and saved library share customMoves/customAbilities
    // names; worth splitting into a separate draft object eventually
    abilities: [],
    learnset: [],
    sampleSets: [],
    artworkData: null,
    shinyArtworkData: null,
    cryData: null,
    artCredit: null,
    artworkMode: 'normal',
    previewArtworkMode: 'normal',
    collectionShinyPreview: readBool('woogidex-collection-shiny-preview'),
    autoSaveTimer: null,
    lastSavedId: null,
    evolutionGraph: null,
    profilePageUser: null,
    profilePageEditing: false
};
