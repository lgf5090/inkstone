import { describe, expect, it, vi } from 'vitest';
import type { Folder, NoteSummary } from '@shared/types';
import { buildFolderExportPaths, folderExportFilename } from './export-folder';

vi.mock('../store/notes', () => ({
    useNotes: {
        getState: () => ({ notes: {}, contents: {}, folders: [] }),
    },
}));
vi.mock('./api', () => ({
    api: { notes: { get: vi.fn() } },
}));
vi.mock('./db', () => ({
    localDb: { getContent: vi.fn() },
}));

function folder(id: string, name: string, parentId: string | null): Folder {
    return {
        id,
        parentId,
        name,
        icon: null,
        color: null,
        position: 0,
        createdAt: 0,
        updatedAt: 0,
    };
}

function note(id: string, title: string, folderId: string | null): NoteSummary {
    return {
        id,
        title,
        excerpt: '',
        folderId,
        tags: [],
        isPinned: false,
        isStarred: false,
        isArchived: false,
        wordCount: 0,
        charCount: 0,
        rev: 1,
        position: 0,
        createdAt: 0,
        updatedAt: 1700000000000,
        deletedAt: null,
    };
}

const PROJECTS = folder('root', 'Projects', null);
const ALPHA = folder('alpha', 'Alpha', 'root');
const BETA = folder('beta', 'Beta/2024', 'root');
const DEEP = folder('deep', 'Deep One', 'alpha');
const OUTSIDE = folder('outside', 'Elsewhere', null);
const FOLDERS = [PROJECTS, ALPHA, BETA, DEEP, OUTSIDE];

describe('buildFolderExportPaths', () => {
    it('nests notes under the exported folder name', () => {
        const paths = buildFolderExportPaths(FOLDERS, [
            note('n1', 'Top', 'root'),
            note('n2', 'In alpha', 'alpha'),
            note('n3', 'In deep', 'deep'),
        ], 'root');
        expect(paths.get('n1')).toBe('Projects/Top.md');
        expect(paths.get('n2')).toBe('Projects/Alpha/In alpha.md');
        expect(paths.get('n3')).toBe('Projects/Alpha/Deep One/In deep.md');
    });

    it('sanitizes separators out of folder and note names', () => {
        const paths = buildFolderExportPaths(FOLDERS, [note('n1', 'a/b:c*d?', 'alpha')], 'root');
        expect(paths.get('n1')).toBe('Projects/Alpha/a b c d.md');
    });

    it('keeps identical titles apart inside one directory only', () => {
        const paths = buildFolderExportPaths(FOLDERS, [
            note('n1', 'Same', 'alpha'),
            note('n2', 'Same', 'alpha'),
            note('n3', 'Same', 'deep'),
            note('n4', 'Same', 'alpha'),
        ], 'root');
        expect(paths.get('n1')).toBe('Projects/Alpha/Same.md');
        expect(paths.get('n2')).toBe('Projects/Alpha/Same (1).md');
        expect(paths.get('n4')).toBe('Projects/Alpha/Same (2).md');
        expect(paths.get('n3')).toBe('Projects/Alpha/Deep One/Same.md');
    });

    it('falls back to a named file for untitled notes', () => {
        const paths = buildFolderExportPaths(FOLDERS, [note('n1', '   ', 'root')], 'root');
        expect(paths.get('n1')).toBe('Projects/note.md');
    });

    it('ignores notes that live outside the exported subtree', () => {
        const paths = buildFolderExportPaths(FOLDERS, [
            note('n1', 'Elsewhere', 'outside'),
            note('n2', 'Unfiled', null),
            note('n3', 'Gone', 'missing-folder'),
        ], 'root');
        expect(paths.size).toBe(0);
    });

    it('exports a single folder without its parent prefix', () => {
        const paths = buildFolderExportPaths(FOLDERS, [
            note('n1', 'In alpha', 'alpha'),
            note('n2', 'In deep', 'deep'),
            note('n3', 'In projects', 'root'),
        ], 'alpha');
        expect(paths.get('n1')).toBe('Alpha/In alpha.md');
        expect(paths.get('n2')).toBe('Alpha/Deep One/In deep.md');
        expect(paths.get('n3')).toBeUndefined();
    });
});

describe('folderExportFilename', () => {
    it('names the archive after the folder and strips path characters', () => {
        expect(folderExportFilename(PROJECTS)).toBe('Projects-export.zip');
        expect(folderExportFilename(BETA)).toBe('Beta 2024-export.zip');
        expect(folderExportFilename(folder('empty', '   ', null))).toBe('folder-export.zip');
    });
});

describe('zip entry safety', () => {
    it('never lets a folder or note name escape the archive root', () => {
        const escapee: Folder = { ...PROJECTS, id: 'dotdot', parentId: 'root', name: '..' };
        const dotted: Folder = { ...PROJECTS, id: 'dots', parentId: 'root', name: '...' };
        const paths = buildFolderExportPaths([PROJECTS, escapee, dotted], [
            note('n1', 'ok', 'dotdot'),
            note('n2', 'ok', 'dots'),
            note('n3', '..', 'root'),
            note('n4', '../evil', 'root'),
        ], 'root');
        for (const path of paths.values()) {
            expect(path.startsWith('/'), path).toBe(false);
            expect(path.split('/').includes('..'), path).toBe(false);
            expect(path.startsWith('../'), path).toBe(false);
        }
        expect(paths.get('n1')).toBe('Projects/folder/ok.md');
        expect(paths.get('n3')).toBe('Projects/note.md');
        expect(paths.get('n4')).toBe('Projects/evil.md');
    });
});
