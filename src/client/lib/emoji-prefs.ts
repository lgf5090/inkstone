import { useSyncExternalStore } from 'react';

export const EMOJI_PREFS_STORAGE_KEY = 'inkstone.emoji-preferences.v1';

export const RECENT_EMOJI_LIMIT = 28;

const RECENT_MAX_CODE_UNITS = 16;

export interface EmojiPreferences {
    recentEmojis: string[];
}

function defaultPreferences(): EmojiPreferences {
    return { recentEmojis: [] };
}

const listeners = new Set<() => void>();

function readStorage(): Storage | null {
    return typeof localStorage === 'undefined' ? null : localStorage;
}

function isRecentGlyph(value: unknown): value is string {
    if (typeof value !== 'string' || !value.length || value.length > RECENT_MAX_CODE_UNITS)
        return false;
    // No emoji is spelled with a letter — the regional indicators and the keycaps are symbols — so
    // a word that wandered into the key is refused rather than drawn as a tile.
    if (/\p{L}/u.test(value))
        return false;
    for (const character of value) {
        const point = character.codePointAt(0)!;
        if (point < 0x20 || (point >= 0x7f && point <= 0x9f))
            return false;
    }
    return true;
}

function readRecentEmojis(value: unknown): string[] {
    if (!Array.isArray(value))
        return [];
    return [...new Set(value.filter(isRecentGlyph))].slice(0, RECENT_EMOJI_LIMIT);
}

export function loadEmojiPrefs(storage: Storage | null = readStorage()): EmojiPreferences {
    if (!storage)
        return defaultPreferences();
    try {
        const raw = storage.getItem(EMOJI_PREFS_STORAGE_KEY);
        if (!raw)
            return defaultPreferences();
        const parsed = JSON.parse(raw) as Partial<EmojiPreferences>;
        return { recentEmojis: readRecentEmojis(parsed.recentEmojis) };
    }
    catch {
        return defaultPreferences();
    }
}

let currentPreferences = loadEmojiPrefs();

function writeStorage(next: EmojiPreferences): void {
    const storage = readStorage();
    if (!storage)
        return;
    try {
        storage.setItem(EMOJI_PREFS_STORAGE_KEY, JSON.stringify(next));
    }
    catch {
    }
}

export function saveEmojiPrefs(patch: Partial<EmojiPreferences>): void {
    currentPreferences = { ...currentPreferences, ...patch };
    writeStorage(currentPreferences);
    for (const listener of listeners)
        listener();
}

export function pushRecentEmoji(glyph: string): void {
    if (!isRecentGlyph(glyph))
        return;
    const previous = currentPreferences.recentEmojis;
    const next = [glyph, ...previous.filter((item) => item !== glyph)].slice(0, RECENT_EMOJI_LIMIT);
    if (next[0] === previous[0] && next.length === previous.length)
        return;
    saveEmojiPrefs({ recentEmojis: next });
}

export function clearRecentEmojis(): void {
    if (!currentPreferences.recentEmojis.length)
        return;
    saveEmojiPrefs({ recentEmojis: [] });
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function getSnapshot(): EmojiPreferences {
    return currentPreferences;
}

export function useEmojiPreferences(): EmojiPreferences {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
