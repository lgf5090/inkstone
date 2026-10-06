import { t } from '../i18n';
import { CALENDAR_TREE, INBOX_TREE, TODO_TREE, parseVirtualId, type VirtualTreeNamespace } from './ids';
import { virtualPathSegments } from './tree';

const ROOT_LABEL_KEYS: Record<string, 'sidebar.calendar_folder' | 'sidebar.todo_folder' | 'sidebar.inbox_folder'> = {
    [CALENDAR_TREE.rootId]: 'sidebar.calendar_folder',
    [TODO_TREE.rootId]: 'sidebar.todo_folder',
    [INBOX_TREE.rootId]: 'sidebar.inbox_folder',
};

export const VIRTUAL_TREES: readonly VirtualTreeNamespace[] = [CALENDAR_TREE, TODO_TREE, INBOX_TREE];

export function virtualTreeNamespace(folderId: string | null | undefined): VirtualTreeNamespace | null {
    if (!folderId)
        return null;
    return VIRTUAL_TREES.find((tree) => folderId === tree.rootId || folderId.startsWith(tree.prefix)) ?? null;
}

export function virtualTreeRootLabel(ns: VirtualTreeNamespace): string {
    const key = ROOT_LABEL_KEYS[ns.rootId];
    return key ? t(key) : '';
}

export function virtualFolderLabel(folderId: string | null | undefined): string | null {
    const ns = virtualTreeNamespace(folderId);
    if (!ns || !folderId)
        return null;
    const segments = virtualPathSegments(folderId, ns);
    const root = virtualTreeRootLabel(ns);
    return segments ? [root, ...segments].join(' / ') : root;
}

export function isKnownVirtualId(folderId: string | null | undefined): boolean {
    const ns = virtualTreeNamespace(folderId);
    return Boolean(ns && folderId && parseVirtualId(folderId, ns));
}
