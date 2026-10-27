import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { duplicateNoteTitle, NOTE_TYPE_SUFFIXES } from '../src/shared/text-utils';
import { MINDMAP_FILE_EXTENSION, isMindmapDocumentTitle } from '../src/client/lib/markdown/mindmap/document';
import { INK_FILE_EXTENSION, isInkNoteTitle } from '../src/client/lib/inkpad/document';

describe('duplicating a note keeps its file type at the end of the title', () => {
    it('keeps a drawing file a drawing file', () => {
        expect(duplicateNoteTitle('Board.excalidraw', 100)).toBe('Board copy.excalidraw');
    });

    it('keeps a mind map file a mind map file', () => {
        expect(duplicateNoteTitle('Plan.elixir', 100)).toBe('Plan copy.elixir');
    });

    it('keeps an ink file an ink file', () => {
        expect(duplicateNoteTitle('Sketch.ink', 100)).toBe('Sketch copy.ink');
        expect(duplicateNoteTitle('Sketch.INK', 100)).toBe('Sketch copy.INK');
    });

    it('keeps the extension casing the note already had', () => {
        expect(duplicateNoteTitle('Board.Excalidraw', 100)).toBe('Board copy.Excalidraw');
    });

    it('leaves an ordinary title alone', () => {
        expect(duplicateNoteTitle('Release v1.2', 100)).toBe('Release v1.2 copy');
        expect(duplicateNoteTitle('Plain', 100)).toBe('Plain copy');
    });

    it('still fits the ceiling with the type held on', () => {
        const out = duplicateNoteTitle(`${'x'.repeat(200)}.excalidraw`, 30);
        expect(out.length).toBeLessThanOrEqual(30);
        expect(out.endsWith('.excalidraw')).toBe(true);
    });
});

describe('the type list cannot drift away from the editors that read the title', () => {
    it('covers the ink extension the client predicate uses', () => {
        expect(NOTE_TYPE_SUFFIXES).toContain(INK_FILE_EXTENSION);
        expect(isInkNoteTitle(`t${INK_FILE_EXTENSION}`)).toBe(true);
        expect(isInkNoteTitle('t.md')).toBe(false);
    });

    it('covers the mind map extension the client predicate uses', () => {
        expect(NOTE_TYPE_SUFFIXES).toContain(MINDMAP_FILE_EXTENSION);
        for (const suffix of NOTE_TYPE_SUFFIXES) {
            if (suffix === MINDMAP_FILE_EXTENSION) continue;
            expect(isMindmapDocumentTitle(`t${suffix}`), `the mind map editor claims ${suffix}`).toBe(false);
        }
        expect(isMindmapDocumentTitle(`t${MINDMAP_FILE_EXTENSION}`)).toBe(true);
    });

    it('covers every suffix the workspace switches an editor on', () => {
        const source = fs.readFileSync('src/client/features/workspace/Workspace.tsx', 'utf8');
        const seen = [...source.matchAll(/endsWith\(['"](\.[A-Za-z0-9]+)['"]\)/g)].map((m) => m[1]);
        expect(seen.length).toBeGreaterThan(0);
        for (const suffix of seen) {
            expect(NOTE_TYPE_SUFFIXES, `a typed editor reads ${suffix} but the copy helper does not know it`)
                .toContain(suffix);
        }
    });
});
