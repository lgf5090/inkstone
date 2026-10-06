import { downloadZip } from 'client-zip';
import type { Folder, NoteSummary } from '@shared/types';
import { api } from './api';
import { folderDescendantIds, folderPath } from './folders';
import { safeFileName } from './export-note';
import { localDb } from './db';
import { useNotes } from '../store/notes';

export interface FolderExportResult {
    count: number;
    filename: string;
}

const CONTENT_FETCH_CONCURRENCY = 4;

function zipSegment(name: string, fallback: string): string {
    const cleaned = safeFileName(name).replace(/^\.+/g, '').trim();
    return cleaned || fallback;
}

export function folderExportFilename(root: Folder): string {
    return `${safeFileName(root.name) || 'folder'}-export.zip`;
}

export function buildFolderExportPaths(folders: Folder[], notes: NoteSummary[], rootFolderId: string): Map<string, string> {
    const descendants = folderDescendantIds(folders, rootFolderId);
    const rootDepth = folderPath(folders, rootFolderId).length - 1;
    const directoryOf = new Map<string, string>();
    for (const folder of folders) {
        if (!descendants.has(folder.id))
            continue;
        const segments = folderPath(folders, folder.id)
            .slice(rootDepth)
            .map((item) => zipSegment(item.name, 'folder'));
        directoryOf.set(folder.id, segments.join('/'));
    }
    const used = new Map<string, number>();
    const paths = new Map<string, string>();
    for (const note of notes) {
        if (!note.folderId)
            continue;
        const directory = directoryOf.get(note.folderId);
        if (directory === undefined)
            continue;
        const base = zipSegment(note.title, 'note');
        const key = `${directory}/${base}`;
        const seen = used.get(key) ?? 0;
        used.set(key, seen + 1);
        paths.set(note.id, `${directory}/${seen === 0 ? base : `${base} (${seen})`}.md`);
    }
    return paths;
}

function exportableNotes(folders: Folder[], rootFolderId: string): NoteSummary[] {
    const state = useNotes.getState();
    const descendants = folderDescendantIds(folders, rootFolderId);
    return Object.values(state.notes)
        .filter((note) => Boolean(note)
            && note.deletedAt === null
            && !note.isArchived
            && Boolean(note.folderId)
            && descendants.has(note.folderId as string))
        .sort((a, b) => a.title.localeCompare(b.title));
}

async function resolveContent(id: string): Promise<string> {
    const cached = useNotes.getState().contents[id];
    if (cached !== undefined)
        return cached;
    const stored = await localDb.getContent(id);
    if (stored)
        return stored.content;
    return (await api.notes.get(id)).content ?? '';
}

async function collectContents(ids: string[]): Promise<Map<string, string>> {
    const contents = new Map<string, string>();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONTENT_FETCH_CONCURRENCY, ids.length) }, async () => {
        while (cursor < ids.length) {
            const id = ids[cursor++];
            contents.set(id, await resolveContent(id));
        }
    });
    await Promise.all(workers);
    return contents;
}

function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.append(anchor);
    try {
        anchor.click();
    }
    finally {
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
}

export async function exportFolderAsZip(folderId: string): Promise<FolderExportResult> {
    const folders = useNotes.getState().folders ?? [];
    const root = folders.find((folder) => folder.id === folderId);
    if (!root)
        throw new Error(`folder ${folderId} is not available`);
    const notes = exportableNotes(folders, folderId);
    const filename = folderExportFilename(root);
    if (notes.length === 0)
        return { count: 0, filename };
    const paths = buildFolderExportPaths(folders, notes, folderId);
    const contents = await collectContents(notes.map((note) => note.id));
    const files = notes.map((note) => {
        const title = note.title.trim();
        const frontMatter = title ? `---\ntitle: ${JSON.stringify(title)}\n---\n\n` : '';
        return {
            name: paths.get(note.id) ?? `${zipSegment(note.title, 'note')}.md`,
            lastModified: new Date(note.updatedAt || Date.now()),
            input: new Response(`${frontMatter}${contents.get(note.id) ?? ''}`),
        };
    });
    downloadBlob(await downloadZip(files).blob(), filename);
    return { count: notes.length, filename };
}
