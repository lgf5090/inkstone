import { useSyncExternalStore } from 'react';

export const FOLDER_PREFS_STORAGE_KEY = 'inkstone.folder-preferences.v1';

export interface FolderPreferences {
    inboxFolderId: string | null;
}

const DEFAULT_PREFERENCES: FolderPreferences = { inboxFolderId: null };

const listeners = new Set<() => void>();

function readStorage(): Storage | null {
    return typeof localStorage === 'undefined' ? null : localStorage;
}

export function loadFolderPrefs(storage: Storage | null = readStorage()): FolderPreferences {
    if (!storage)
        return { ...DEFAULT_PREFERENCES };
    try {
        const raw = storage.getItem(FOLDER_PREFS_STORAGE_KEY);
        if (!raw)
            return { ...DEFAULT_PREFERENCES };
        const parsed = JSON.parse(raw) as Partial<FolderPreferences>;
        return {
            inboxFolderId: typeof parsed.inboxFolderId === 'string' && parsed.inboxFolderId
                ? parsed.inboxFolderId
                : null,
        };
    }
    catch {
        return { ...DEFAULT_PREFERENCES };
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
