import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    FOLDER_PREFS_STORAGE_KEY,
    clearInboxFolderIfDeleted,
    getInboxFolderId,
    loadFolderPrefs,
    saveFolderPrefs,
    setInboxFolderId,
    useFolderPreferences,
} from './folder-prefs';

function renderFolderPreferencesProbe(observe: () => void): () => void {
    function Probe() {
        observe();
        return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => {
        root.render(createElement(Probe));
    });
    return () => root.unmount();
}

function makeStorage(initial: Record<string, string> = {}): Storage {
    const data = new Map(Object.entries(initial));
    return {
        get length() {
            return data.size;
        },
        key: (index: number) => [...data.keys()][index] ?? null,
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => {
            data.set(key, value);
        },
        removeItem: (key: string) => {
            data.delete(key);
        },
        clear: () => data.clear(),
    } satisfies Storage;
}

describe('loadFolderPrefs', () => {
    it('falls back to no inbox when nothing is stored', () => {
        expect(loadFolderPrefs(makeStorage())).toEqual({ inboxFolderId: null });
    });

    it('ignores malformed and non-string payloads', () => {
        const broken = makeStorage({ [FOLDER_PREFS_STORAGE_KEY]: 'not json' });
        expect(loadFolderPrefs(broken)).toEqual({ inboxFolderId: null });
        const wrongType = makeStorage({ [FOLDER_PREFS_STORAGE_KEY]: JSON.stringify({ inboxFolderId: 7 }) });
        expect(loadFolderPrefs(wrongType)).toEqual({ inboxFolderId: null });
        const emptyString = makeStorage({ [FOLDER_PREFS_STORAGE_KEY]: JSON.stringify({ inboxFolderId: '' }) });
        expect(loadFolderPrefs(emptyString)).toEqual({ inboxFolderId: null });
    });

    it('reads a stored inbox id', () => {
        const stored = makeStorage({ [FOLDER_PREFS_STORAGE_KEY]: JSON.stringify({ inboxFolderId: 'f1' }) });
        expect(loadFolderPrefs(stored)).toEqual({ inboxFolderId: 'f1' });
    });

    it('tolerates a storage object that throws', () => {
        const hostile = makeStorage();
        hostile.getItem = () => {
            throw new Error('blocked');
        };
        expect(loadFolderPrefs(hostile)).toEqual({ inboxFolderId: null });
    });
});

describe('inbox preferences', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', makeStorage());
        setInboxFolderId(null);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('persists the inbox and clears it again', () => {
        setInboxFolderId('f1');
        expect(getInboxFolderId()).toBe('f1');
        expect(JSON.parse(localStorage.getItem(FOLDER_PREFS_STORAGE_KEY) ?? '{}')).toEqual({ inboxFolderId: 'f1' });
        setInboxFolderId(null);
        expect(getInboxFolderId()).toBeNull();
    });

    it('notifies subscribers so the hook re-reads the value', () => {
        const seen: Array<string | null> = [];
        const unmount = renderFolderPreferencesProbe(() => {
            seen.push(useFolderPreferences().inboxFolderId);
        });
        act(() => setInboxFolderId('f2'));
        unmount();
        expect(seen).toEqual([null, 'f2']);
    });

    it('keeps unrelated preferences when patching one field', () => {
        saveFolderPrefs({ inboxFolderId: 'f1' });
        expect(loadFolderPrefs(localStorage)).toEqual({ inboxFolderId: 'f1' });
        saveFolderPrefs({});
        expect(loadFolderPrefs(localStorage)).toEqual({ inboxFolderId: 'f1' });
    });

    it('drops the inbox pointer only when that folder is deleted', () => {
        setInboxFolderId('f1');
        clearInboxFolderIfDeleted('f2');
        expect(getInboxFolderId()).toBe('f1');
        clearInboxFolderIfDeleted('f1');
        expect(getInboxFolderId()).toBeNull();
    });

    it('survives a storage that refuses to write', () => {
        const hostile = makeStorage();
        hostile.setItem = () => {
            throw new Error('quota');
        };
        vi.stubGlobal('localStorage', hostile);
        setInboxFolderId('f3');
        expect(getInboxFolderId()).toBe('f3');
    });
});
