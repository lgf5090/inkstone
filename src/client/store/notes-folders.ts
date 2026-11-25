import type { Folder } from '@shared/types';

export type FolderMutationPatch = {
    name?: string;
    parentId?: string | null;
    beforeId?: string | null;
    icon?: string | null;
    color?: string | null;
};

export function replaceFolder(folders: Folder[], saved: Folder): Folder[] {
    const index = folders.findIndex((folder) => folder.id === saved.id);
    if (index < 0)
        return [...folders, saved];
    const next = [...folders];
    next[index] = saved;
    return next;
}

export function applyOptimisticFolderPatch(folders: Folder[], id: string, patch: FolderMutationPatch): Folder[] {
    const current = folders.find((folder) => folder.id === id);
    if (!current)
        return folders;
    const parentId = patch.parentId === undefined ? current.parentId : patch.parentId;
    const shouldPlace = patch.beforeId !== undefined || parentId !== current.parentId;
    const updated: Folder = {
        ...current,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.parentId !== undefined ? { parentId } : {}),
        ...(shouldPlace ? { position: insertionPositionForFolders(folders, id, parentId, patch.beforeId ?? null) } : {}),
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    return folders.map((folder) => folder.id === id ? updated : folder);
}

export function insertionPositionForFolders(folders: Folder[], id: string, parentId: string | null, beforeId: string | null): number {
    const siblings = folders
        .filter((folder) => folder.id !== id && folder.parentId === parentId)
        .sort(compareFolders);
    const index = beforeId === null ? siblings.length : siblings.findIndex((folder) => folder.id === beforeId);
    const target = index < 0 ? siblings.length : index;
    const previous = siblings[target - 1]?.position;
    const next = siblings[target]?.position;
    if (previous === undefined && next === undefined)
        return 1000;
    if (previous === undefined)
        return next! - 1000;
    if (next === undefined)
        return previous + 1000;
    return previous + (next - previous) / 2;
}

export function removeFolderAndPromoteChildren(folders: Folder[], id: string): Folder[] {
    const removed = folders.find((folder) => folder.id === id);
    if (!removed)
        return folders;
    const siblings = folders.filter((folder) => folder.parentId === removed.parentId).sort(compareFolders);
    const children = folders.filter((folder) => folder.parentId === id).sort(compareFolders);
    const removedIndex = siblings.findIndex((folder) => folder.id === id);
    const previous = siblings[removedIndex - 1]?.position;
    const next = siblings[removedIndex + 1]?.position;
    const positions = positionsForPromotedFolders(previous, next, children.length);
    if (positions) {
        const promoted = new Map(children.map((child, index) => [child.id, positions[index]!]));
        return folders.flatMap((folder) => {
            if (folder.id === id)
                return [];
            const position = promoted.get(folder.id);
            return position === undefined ? [folder] : [{ ...folder, parentId: removed.parentId, position, updatedAt: Date.now() }];
        });
    }
    const desired = [...siblings];
    desired.splice(removedIndex, 1, ...children);
    const normalized = new Map(desired.map((folder, index) => [folder.id, (index + 1) * 1000]));
    return folders.flatMap((folder) => {
        if (folder.id === id)
            return [];
        const position = normalized.get(folder.id);
        if (position === undefined)
            return [folder];
        return [{
                ...folder,
                ...(folder.parentId === id ? { parentId: removed.parentId, updatedAt: Date.now() } : {}),
                position,
            }];
    });
}

export function positionsForPromotedFolders(previous: number | undefined, next: number | undefined, count: number): number[] | null {
    if (!count)
        return [];
    if (previous === undefined && next === undefined)
        return Array.from({ length: count }, (_, index) => (index + 1) * 1000);
    if (previous === undefined)
        return Array.from({ length: count }, (_, index) => next! - (count - index) * 1000);
    if (next === undefined)
        return Array.from({ length: count }, (_, index) => previous + (index + 1) * 1000);
    const step = (next - previous) / (count + 1);
    return Number.isFinite(step) && step > 0
        ? Array.from({ length: count }, (_, index) => previous + step * (index + 1))
        : null;
}

export function compareFolders(left: Folder, right: Folder): number {
    return left.position - right.position || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

export function availableLocalFolderName(folders: Folder[], parentId: string | null, base: string): string {
    const names = new Set(folders
        .filter((folder) => folder.parentId === parentId)
        .map((folder) => folder.name.toLocaleLowerCase()));
    if (!names.has(base.toLocaleLowerCase()))
        return base;
    let suffix = 2;
    while (names.has(`${base} ${suffix}`.toLocaleLowerCase()))
        suffix++;
    return `${base} ${suffix}`;
}
