// The Fakemon editor's form: every field on the Basic and Stats tabs, as data.
//
// This used to live in the inputs themselves, and the save, the exports, the
// analysis, the sample-set builder and the name roller all read it back with
// getElementById. Now they read `form`, the editor (js/app/pages/EditorPage.tsx)
// draws it, and nothing has to exist on screen for the numbers to be right.
//
// The rest of what's being edited (abilities, learnset, sample sets, artwork,
// the evolution graph) is still on the shared `state` object.

import { api } from '../core/app.ts';
import { notifySync } from '../app/store.ts';
import type { StatBlock } from '../app/types.ts';

export type StatKey = keyof StatBlock;

export const EGG_GROUPS = ['Monster', 'Water 1', 'Bug', 'Flying', 'Field', 'Fairy', 'Grass', 'Human-Like', 'Water 3', 'Mineral',
    'Amorphous', 'Water 2', 'Ditto', 'Dragon', 'Undiscovered'];
export const STAT_KEYS: StatKey[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

export interface EditorForm {
    name: string;
    species: string;
    type1: string;
    type2: string;
    number: string;
    isMega: boolean;
    isForme: boolean;
    dexEntry1: string;
    dexEntry2: string;
    /** as typed, in heightUnit */
    height: string;
    heightUnit: 'm' | 'ft';
    weight: string;
    weightUnit: 'kg' | 'lb';
    /** a colour name from POKEMON_COLORS */
    color: string;
    egg1: string;
    egg2: string;
    genderless: boolean;
    /** percent male; female is 100 minus this */
    male: number;
    level: number;
    stats: StatBlock;
    regionIds: string[];
}

export function blankForm(): EditorForm {
    return {
        name: '', species: '', type1: '', type2: '', number: '', isMega: false, isForme: false,
        dexEntry1: '', dexEntry2: '', height: '', heightUnit: 'm', weight: '', weightUnit: 'kg',
        color: '', egg1: '', egg2: '', genderless: false, male: 50, level: 100,
        stats: { hp: 60, atk: 60, def: 60, spa: 60, spd: 60, spe: 60 }, regionIds: []
    };
}

/** The editor's current values. Read it freely; change it through setForm/editForm. */
export const form: EditorForm = blankForm();

/** Replaces fields without counting as an edit (loading a Fakemon, a reset). */
export function setForm(patch: Partial<EditorForm>): void {
    Object.assign(form, patch);
    // the fields are controlled inputs (see notifySync)
    notifySync();
}

/** A change made in the editor: redraws, then updates the board and autosaves, as typing always did. */
export function editForm(patch: Partial<EditorForm>): void {
    setForm(patch);
    api.updatePreview?.();
    api.autoSave?.();
}

// ---- stats ----

/** A base stat as the games allow it: a whole number from 1 to 255. */
export function clampBaseStat(value: unknown): number {
    const parsed = Number.parseInt(String(value).replace(/[^0-9-]/g, ''), 10);
    if (!Number.isFinite(parsed)) return 1;
    return Math.max(1, Math.min(255, parsed));
}

export function setStat(key: StatKey, value: unknown): void {
    editForm({ stats: { ...form.stats, [key]: clampBaseStat(value) } });
    api.updateBulkComparison?.();
}

export function formBst(): number {
    return STAT_KEYS.reduce((sum, k) => sum + (Number(form.stats[k]) || 0), 0);
}

// ---- the text a saved Fakemon keeps ----

/** "0.9 m", or '' when no height is set. */
export function heightDisplay(): string {
    return form.height ? `${form.height} ${form.heightUnit}` : '';
}

export function weightDisplay(): string {
    return form.weight ? `${form.weight} ${form.weightUnit}` : '';
}

/** "Monster, Dragon", or 'None'. */
export function eggGroupsText(): string {
    const groups = [form.egg1, form.egg2 !== form.egg1 ? form.egg2 : ''].filter(Boolean);
    return groups.join(', ') || 'None';
}

export function eggGroupsFromText(value: string | string[] | undefined | null): Pick<EditorForm, 'egg1' | 'egg2'> {
    const text = Array.isArray(value) ? value.filter(Boolean).join(', ') : String(value || '');
    if (!text || text === 'None') return { egg1: '', egg2: '' };
    const groups = text.split(',').map(s => s.trim()).filter(Boolean);
    return { egg1: groups[0] || '', egg2: groups[1] || '' };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** "87.5-12.5", or 'genderless'. */
export function genderRatioText(): string {
    return form.genderless ? 'genderless' : `${round1(form.male)}-${round1(100 - form.male)}`;
}

export function genderFromText(ratio: string | undefined | null): Pick<EditorForm, 'genderless' | 'male'> {
    if (ratio === 'genderless') return { genderless: true, male: form.male };
    const [m] = String(ratio || '50-50').split('-').map(Number);
    return { genderless: false, male: Number.isFinite(m) ? Math.max(0, Math.min(100, m)) : 50 };
}

/** A height or weight as the save writes it ("3.5 ft"), split back into value and unit. */
function measurement<U extends string>(text: unknown, units: Record<string, U>, fallback: U): [string, U] {
    const raw = String(text || '').trim();
    if (!raw) return ['', fallback];
    const m = raw.match(/^([\d.]+)\s*([a-z]+)?$/i);
    if (!m) return [raw, fallback];
    const unit = m[2] ? units[m[2].toLowerCase()[0]] || fallback : fallback;
    return [m[1], unit];
}

/** The form for a saved Fakemon. */
export function formFromFakemon(f: any): EditorForm {
    const [height, heightUnit] = measurement(f.height, { m: 'm', f: 'ft' }, 'm');
    const [weight, weightUnit] = measurement(f.weight, { k: 'kg', l: 'lb', p: 'lb' }, 'kg');
    const ratio = typeof f.genderRatio === 'string' ? f.genderRatio : (f.genderRatio?.value || '50-50');
    return {
        ...blankForm(),
        name: f.name || '', species: f.species || '', type1: f.type1 || '', type2: f.type2 || '', number: f.number || '',
        isMega: !!f.isMega, isForme: !!f.isFormeChange,
        dexEntry1: f.dexEntry1 || '', dexEntry2: f.dexEntry2 || '',
        height, heightUnit, weight, weightUnit, color: f.color || '',
        ...eggGroupsFromText(f.eggGroups),
        ...genderFromText(ratio),
        level: Number(f.level) || 100,
        stats: Object.fromEntries(STAT_KEYS.map(k => [k, clampBaseStat(f.stats?.[k] ?? 60)])) as unknown as StatBlock,
        regionIds: api.entryRegionIds ? api.entryRegionIds(f) : []
    };
}

// ---- height and weight: typing and switching units ----

/** Digits and at most one decimal point. */
export function cleanMeasurement(text: string): string {
    const val = text.replace(/[^0-9.]/g, '');
    const parts = val.split('.');
    return parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : val;
}

const toFixed2 = (n: number) => String(parseFloat(n.toFixed(2)));

/** Switches the height unit, converting what's typed. */
export function setHeightUnit(unit: 'm' | 'ft'): void {
    if (unit === form.heightUnit) return;
    const val = parseFloat(form.height);
    const height = Number.isNaN(val) ? form.height : toFixed2(unit === 'ft' ? val * 3.28084 : val / 3.28084);
    editForm({ heightUnit: unit, height });
}

export function setWeightUnit(unit: 'kg' | 'lb'): void {
    if (unit === form.weightUnit) return;
    const val = parseFloat(form.weight);
    const weight = Number.isNaN(val) ? form.weight : toFixed2(unit === 'lb' ? val * 2.20462 : val / 2.20462);
    editForm({ weightUnit: unit, weight });
}
