import type { SyncResponse } from '@shared/types';

export function consolidateFullSync(snapshot: SyncResponse, increments: SyncResponse[]): SyncResponse {
    const notes = new Map(snapshot.notes.map((note) => [note.id, note]));
    let folders = new Map(snapshot.folders.map((folder) => [folder.id, folder]));
    let tags = new Map(snapshot.tags.map((tag) => [tag.id, tag]));
    let cursor = snapshot.cursor;
    let serverTime = snapshot.serverTime;
    let settingsChanged = snapshot.settingsChanged;
    let profileChanged = snapshot.profileChanged;
    let siteChanged = snapshot.siteChanged;
    for (const update of increments) {
        settingsChanged ||= update.settingsChanged;
        profileChanged ||= update.profileChanged;
        siteChanged ||= update.siteChanged;
        for (const note of update.notes)
            notes.set(note.id, note);
        if (update.facetsFull) {
            folders = new Map(update.folders.map((folder) => [folder.id, folder]));
            tags = new Map(update.tags.map((tag) => [tag.id, tag]));
        }
        else {
            for (const folder of update.folders)
                folders.set(folder.id, folder);
            for (const tag of update.tags)
                tags.set(tag.id, tag);
        }
        for (const deletion of update.deletions) {
            if (deletion.entity === 'note')
                notes.delete(deletion.id);
            else if (deletion.entity === 'folder')
                folders.delete(deletion.id);
            else if (deletion.entity === 'tag')
                tags.delete(deletion.id);
        }
        cursor = update.cursor;
        serverTime = update.serverTime;
    }
    return {
        ...snapshot,
        cursor,
        hasMore: false,
        nextKey: null,
        facetsFull: true,
        settingsChanged,
        profileChanged,
        siteChanged,
        notes: [...notes.values()],
        folders: [...folders.values()],
        tags: [...tags.values()],
        deletions: [],
        serverTime,
    };
}

export function reconcileList<T extends {
    id: string;
}>(current: T[], incoming: T[], equal: (a: T, b: T) => boolean): T[] {
    const byId = new Map(current.map((item) => [item.id, item]));
    const next = incoming.map((item) => {
        const existing = byId.get(item.id);
        return existing && equal(existing, item) ? existing : item;
    });
    return next.length === current.length && next.every((item, index) => item === current[index])
        ? current
        : next;
}

export function mergeById<T extends {
    id: string;
}>(current: T[], incoming: T[], deletions: {
    entity: string;
    id: string;
}[], entity: string, equal: (a: T, b: T) => boolean): T[] {
    const currentMap = new Map(current.map((item) => [item.id, item]));
    let map: Map<string, T> | null = null;
    for (const item of incoming) {
        const existing = currentMap.get(item.id);
        if (existing && equal(existing, item))
            continue;
        if (!map)
            map = new Map(currentMap);
        map.set(item.id, item);
    }
    for (const deletion of deletions) {
        if (deletion.entity !== entity || !currentMap.has(deletion.id))
            continue;
        if (!map)
            map = new Map(currentMap);
        map.delete(deletion.id);
    }
    return map ? [...map.values()] : current;
}
