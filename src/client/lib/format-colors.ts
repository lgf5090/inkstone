import { useSyncExternalStore } from 'react';
import { ORGANIZER_COLORS, isCustomOrganizerColor, organizerColorContrast } from '@shared/organizer-colors';
import { HIGHLIGHT_ALPHA } from '../editor/text-format';

export const TEXT_COLORS = ORGANIZER_COLORS;

/**
 * Highlights are painted as a wash, so what matters here is the hue: each of these is saturated
 * enough to still read at {@link HIGHLIGHT_ALPHA} over a light page or a dark one.
 */
export const HIGHLIGHT_COLORS = [
    '#facc15',
    '#a3e635',
    '#34d399',
    '#22d3ee',
    '#60a5fa',
    '#818cf8',
    '#c084fc',
    '#f472b6',
    '#fb7185',
    '#fb923c',
    '#94a3b8',
    '#a8a29e',
] as const;

export const TEXT_MIN_CONTRAST = 3;
export const HIGHLIGHT_MIN_CONTRAST = 1.3;

export type ColorKind = 'text' | 'highlight';

export function paletteOf(kind: ColorKind): readonly string[] {
    return kind === 'text' ? TEXT_COLORS : HIGHLIGHT_COLORS;
}

/** The colour a swatch must show so the panel and the page agree, wash and all. */
export function swatchColor(kind: ColorKind, color: string): string {
    return kind === 'highlight' ? `${color}${HIGHLIGHT_ALPHA}` : color;
}

/**
 * Whether a picked colour will show up on the page it is being picked for. A highlight is judged on
 * its own hue rather than the composited wash: at a fixed alpha the two move together, so a hue too
 * close to the page is the only way the wash can come out invisible. An unresolvable surface reads
 * as usable, the same way the folder guard reads it.
 */
export function isColorUsable(kind: ColorKind, color: string, surface: string): boolean {
    const ratio = organizerColorContrast(color, surface);
    if (ratio === null)
        return true;
    return kind === 'text' ? ratio >= TEXT_MIN_CONTRAST : ratio >= HIGHLIGHT_MIN_CONTRAST;
}

export function colorContrast(color: string, surface: string): number | null {
    return organizerColorContrast(color, surface);
}

export const FORMAT_COLOR_STORAGE_KEY = 'inkstone.editor-format-colors.v1';
export const RECENT_COLOR_LIMIT = 8;

export type RecentColors = Record<ColorKind, string[]>;

const listeners = new Set<() => void>();

function emptyRecent(): RecentColors {
    return { text: [], highlight: [] };
}

function isStoredColor(kind: ColorKind, value: unknown): value is string {
    return typeof value === 'string' && (isCustomOrganizerColor(value) || paletteOf(kind).includes(value));
}

function readStorage(): Storage | null {
    return typeof localStorage === 'undefined' ? null : localStorage;
}

export function loadRecentColors(storage: Storage | null = readStorage()): RecentColors {
    if (!storage)
        return emptyRecent();
    try {
        const raw = storage.getItem(FORMAT_COLOR_STORAGE_KEY);
        if (!raw)
            return emptyRecent();
        const parsed = JSON.parse(raw) as Partial<Record<ColorKind, unknown>>;
        return {
            text: Array.isArray(parsed.text) ? [...new Set(parsed.text.filter(value => isStoredColor('text', value)))].slice(0, RECENT_COLOR_LIMIT) : [],
            highlight: Array.isArray(parsed.highlight) ? [...new Set(parsed.highlight.filter(value => isStoredColor('highlight', value)))].slice(0, RECENT_COLOR_LIMIT) : [],
        };
    }
    catch {
        return emptyRecent();
    }
}

let recent = loadRecentColors();

export function pushRecentColor(kind: ColorKind, color: string): void {
    if (!isStoredColor(kind, color))
        return;
    recent = { ...recent, [kind]: [color, ...recent[kind].filter(item => item !== color)].slice(0, RECENT_COLOR_LIMIT) };
    const storage = readStorage();
    try {
        storage?.setItem(FORMAT_COLOR_STORAGE_KEY, JSON.stringify(recent));
    }
    catch {
    }
    for (const listener of listeners)
        listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useRecentColors(): RecentColors {
    return useSyncExternalStore(subscribe, () => recent, emptyRecent);
}
