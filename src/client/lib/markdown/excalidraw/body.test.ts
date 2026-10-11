import { describe, expect, it } from 'vitest';
import {
    EXCALIDRAW_BODY_LIMIT_BYTES,
    EXCALIDRAW_MAX_ELEMENTS,
    findExcalidrawFences,
    parseExcalidrawBody,
} from './body';

function sceneWith(elements: unknown[], files: unknown = {}) {
    return JSON.stringify({ type: 'excalidraw', version: 2, elements, appState: { viewBackgroundColor: '#ffffff' }, files });
}

const rect = { id: 'r1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 };

describe('the excalidraw scene sanitizer', () => {
    it('accepts an ordinary scene untouched', () => {
        const result = parseExcalidrawBody(sceneWith([rect]));
        expect(result.ok).toBe(true);
        expect(result.data.elements).toHaveLength(1);
        expect(result.dropped ?? 0).toBe(0);
    });

    it('drops embeddable elements instead of handing the note an iframe', () => {
        const result = parseExcalidrawBody(sceneWith([
            rect,
            { id: 'e1', type: 'embeddable', x: 0, y: 0, width: 10, height: 10, customData: { 'excalidraw-link': 'https://evil.test' } },
        ]));
        expect(result.ok).toBe(true);
        expect(result.data.elements.map((e: any) => e.id)).toEqual(['r1']);
        expect(result.dropped).toBe(1);
    });

    it.each([
        ['javascript', 'javascript:alert(1)'],
        ['data', 'data:text/html,<script>alert(1)</script>'],
        ['uppercase scheme', 'JaVaScRiPt:alert(1)'],
        ['scheme with leading space', '  javascript:alert(1)'],
        ['bare word', 'vbscript:msgbox'],
    ])('neutralises a %s link', (_label, link) => {
        const result = parseExcalidrawBody(sceneWith([{ ...rect, link }]));
        expect(result.data.elements[0].link).toBeNull();
    });

    it.each([
        ['wikilink', '[[Some Note]]'],
        ['https', 'https://example.test/a'],
        ['http', 'http://example.test/a'],
        ['mailto', 'mailto:someone@example.test'],
    ])('keeps a %s link', (_label, link) => {
        const result = parseExcalidrawBody(sceneWith([{ ...rect, link }]));
        expect(result.data.elements[0].link).toBe(link);
    });

    it('rejects a scene over the byte ceiling before encoding anything', () => {
        const huge = sceneWith([{ ...rect, text: 'x'.repeat(EXCALIDRAW_BODY_LIMIT_BYTES) }]);
        const result = parseExcalidrawBody(huge);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('characters');
    });

    it('rejects an element count over the ceiling', () => {
        const elements = Array.from({ length: EXCALIDRAW_MAX_ELEMENTS + 1 }, (_, i) => ({ ...rect, id: 'r' + i }));
        const result = parseExcalidrawBody(sceneWith(elements));
        expect(result.ok).toBe(false);
        expect(result.error).toContain('elements');
    });

    it('drops files whose mime is not an image the img-src policy can load', () => {
        const result = parseExcalidrawBody(sceneWith(
            [{ ...rect, type: 'image', fileId: 'f1' }],
            {
                f1: { id: 'f1', dataURL: 'data:text/html;base64,AAAA', mimeType: 'text/html', created: 1 },
                f2: { id: 'f2', dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png', created: 1 },
            },
        ));
        expect(Object.keys(result.data.files ?? {})).toEqual(['f2']);
        expect(result.dropped).toBe(1);
    });

    it('drops a single file over the per-file ceiling', () => {
        const result = parseExcalidrawBody(sceneWith(
            [{ ...rect, type: 'image', fileId: 'big' }],
            { big: { id: 'big', dataURL: 'data:image/png;' + 'A'.repeat(1_600_000), mimeType: 'image/png', created: 1 } },
        ));
        expect(Object.keys(result.data.files ?? {})).toEqual([]);
        expect(result.dropped).toBe(1);
    });

    it('rejects more files than the table may hold', () => {
        const files: Record<string, unknown> = {};
        for (let i = 0; i < 70; i++) files['f' + i] = { id: 'f' + i, dataURL: 'data:image/png;base64,AA', mimeType: 'image/png', created: 1 };
        const result = parseExcalidrawBody(sceneWith([rect], files));
        expect(result.ok).toBe(false);
        expect(result.error).toContain('files');
    });

    it('still reports malformed json as a failure', () => {
        const result = parseExcalidrawBody('{ not json');
        expect(result.ok).toBe(false);
    });
});

describe('findExcalidrawFences', () => {
    it('reports one fence when it is never closed, because the rest is its body', () => {
        const fences = findExcalidrawFences('```excalidraw\n{"a":1}\n```excalidraw\n{"b":2}\n');
        expect(fences).toHaveLength(1);
        expect(fences[0].index).toBe(0);
        expect(fences[0].body).toContain('```excalidraw');
    });

    it('still numbers the fences that follow a closed one', () => {
        const fences = findExcalidrawFences('```excalidraw\n{"a":1}\n```\ntext\n```excalidraw\n{"b":2}\n```\n');
        expect(fences.map((f) => f.index)).toEqual([0, 1]);
        expect(fences[1].body).toBe('{"b":2}');
    });
});
