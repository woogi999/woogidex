// The shapes the app stores and passes around. Records come back from
// IndexedDB, imports and the cloud backup written by older versions of the
// site, so every field beyond the id is optional, and each type stays open
// (`[extra: string]: any`) for fields a newer or older version added.

export type Id = string;

/** Stats as the editor saves them. */
export interface StatBlock { hp: number; atk: number; def: number; spa: number; spd: number; spe: number; }

export interface AbilityRef { name: string; source?: 'sd' | 'custom' | string; desc?: string; customId?: Id; [extra: string]: any; }

export interface LearnsetEntry {
    name: string;
    learnMethod?: 'level' | 'tm' | 'egg' | 'tutor' | 'none' | string;
    level?: number | null;
    source?: string;
    custom?: boolean;
    [extra: string]: any;
}

/** Membership shared by everything that can sit in a folder and in regions. */
export interface Filed {
    folderId?: Id | null;
    /** first of regionIds, kept for older readers */
    regionId?: Id | null;
    regionIds?: Id[];
    pinned?: boolean;
    /** a region's copy of a main-game entry */
    vanillaId?: string | null;
    /** a copy only opened, never changed; not shown or saved */
    pendingVanilla?: boolean;
}

export interface Fakemon extends Filed {
    id: Id;
    name: string;
    species?: string;
    number?: string;
    type1?: string;
    type2?: string;
    isMega?: boolean;
    isFormeChange?: boolean;
    level?: number;
    stats?: StatBlock;
    abilities?: AbilityRef[];
    learnset?: LearnsetEntry[];
    sampleSets?: any[];
    dexEntry1?: string;
    dexEntry2?: string;
    height?: string;
    weight?: string;
    color?: string;
    eggGroups?: string[] | string;
    genderRatio?: any;
    artwork?: string | null;
    shinyArtwork?: string | null;
    cry?: string | null;
    artCredit?: any;
    evolutionGraph?: any;
    evolutionStage?: number;
    createdAt?: number;
    updatedAt?: number;
    [extra: string]: any;
}

export interface CustomMove extends Filed {
    id: Id; name: string; type?: string; category?: string; basePower?: number | string; accuracy?: number | string | boolean;
    pp?: number | string; priority?: number; desc?: string; artwork?: string | null; [extra: string]: any;
}
export interface CustomAbility extends Filed { id: Id; name: string; desc?: string; artwork?: string | null; [extra: string]: any; }
export interface CustomItem extends Filed { id: Id; name: string; desc?: string; artwork?: string | null; isMegaStone?: boolean; [extra: string]: any; }

export type LibraryKind = 'moves' | 'abilities' | 'items';
export type CollectionTab = 'fakemon' | LibraryKind | 'types';

/** An ordinary folder: `type` is the collection tab it belongs to (older ones have none: Fakémon). */
export interface Folder extends Filed { id: Id; name: string; type?: 'fakemon' | LibraryKind | 'types'; color?: string | null; [extra: string]: any; }

export interface VanillaPool { mode: string; ids: string[]; }
export interface Region {
    id: Id; type: 'region'; name: string; tagline?: string; bio?: string; banner?: string; color?: string;
    vanilla?: Partial<Record<'pokemon' | 'moves' | 'abilities' | 'items' | 'types', VanillaPool>>;
    createdAt?: number; [extra: string]: any;
}
export interface CustomType extends Filed { id: Id; type: 'custom-type'; name: string; color?: string; gradient?: any; [extra: string]: any; }

/** state.folders holds all three, told apart by `type`. */
export type FolderEntry = Folder | Region | CustomType;

export interface User {
    id: Id;
    email?: string;
    hasPassword?: boolean;
    hasRealEmail?: boolean;
    tosAcceptedAt?: string | null;
    username: string;
    displayName: string;
    avatarUrl?: string;
    providerName?: string;
    role?: string;
    badges?: string[];
    [extra: string]: any;
}

export interface BadgeDefinition { label: string; icon: string; image?: string; color: string; tooltip: string; rank?: number; }

export type ToastKind = 'success' | 'error' | 'info' | 'warning';
