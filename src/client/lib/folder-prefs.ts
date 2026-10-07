import { useSyncExternalStore } from 'react';
import { isUsableIconGlyph } from './emoji-glyph';

export const FOLDER_PREFS_STORAGE_KEY = 'inkstone.folder-preferences.v1';

export const RECENT_ICON_LIMIT = 12;

export interface FolderPreferences {
    inboxFolderId: string | null;
    recentIcons: string[];
}

function defaultPreferences(): FolderPreferences {
    return { inboxFolderId: null, recentIcons: [] };
}

const listeners = new Set<() => void>();

function readStorage(): Storage | null {
    return typeof localStorage === 'undefined' ? null : localStorage;
}

function readRecentIcons(value: unknown): string[] {
    if (!Array.isArray(value))
        return [];
    return [...new Set(value.filter((item): item is string => typeof item === 'string' && isUsableIconGlyph(item)))].slice(0, RECENT_ICON_LIMIT);
}

export function loadFolderPrefs(storage: Storage | null = readStorage()): FolderPreferences {
    if (!storage)
        return defaultPreferences();
    try {
        const raw = storage.getItem(FOLDER_PREFS_STORAGE_KEY);
        if (!raw)
            return defaultPreferences();
        const parsed = JSON.parse(raw) as Partial<FolderPreferences>;
        return {
            inboxFolderId: typeof parsed.inboxFolderId === 'string' && parsed.inboxFolderId
                ? parsed.inboxFolderId
                : null,
            recentIcons: readRecentIcons(parsed.recentIcons),
        };
    }
    catch {
        return defaultPreferences();
    }
}

let currentPreferences = loadFolderPrefs();

function writeStorage(next: FolderPreferences): void {
    const storage = readStorage();
    if (!storage)
        return;
    try {
        storage.setItem(FOLDER_PREFS_STORAGE_KEY, JSON.stringify(next));
    }
    catch {
    }
}

export function saveFolderPrefs(patch: Partial<FolderPreferences>): void {
    currentPreferences = { ...currentPreferences, ...patch };
    writeStorage(currentPreferences);
    for (const listener of listeners)
        listener();
}

export function getInboxFolderId(): string | null {
    return currentPreferences.inboxFolderId;
}

export function setInboxFolderId(folderId: string | null): void {
    saveFolderPrefs({ inboxFolderId: folderId });
}

export function clearInboxFolderIfDeleted(folderId: string): void {
    if (currentPreferences.inboxFolderId === folderId)
        setInboxFolderId(null);
}

export function pushRecentIcon(icon: string): void {
    if (!isUsableIconGlyph(icon))
        return;
    const previous = currentPreferences.recentIcons;
    const next = [icon, ...previous.filter((item) => item !== icon)].slice(0, RECENT_ICON_LIMIT);
    if (next[0] === previous[0] && next.length === previous.length)
        return;
    saveFolderPrefs({ recentIcons: next });
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function getSnapshot(): FolderPreferences {
    return currentPreferences;
}

export function useFolderPreferences(): FolderPreferences {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
