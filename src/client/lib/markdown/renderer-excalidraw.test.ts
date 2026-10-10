import { describe, expect, it } from 'vitest';
import { decodeDataValue } from './data-attr';
import { renderMarkdown } from './renderer';
import {
    applyBodyAtFence,
    createDefaultExcalidrawScene,
    findExcalidrawFences,
    parseExcalidrawBody,
    serializeExcalidrawBody,
} from './excalidraw/body';

const SAMPLE_EXCALIDRAW_JSON = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: [
        {
            id: 'el-1',
            type: 'rectangle',
            x: 100,
            y: 100,
            width: 150,
            height: 80,
        },
    ],
    appState: {
        viewBackgroundColor: '#ffffff',
    },
    files: {},
});

function block(html: string): Element {
    const frame = document.createElement('div');
    frame.innerHTML = html;
    return frame.querySelector('[data-excalidraw]')!;
}

describe('the excalidraw fence renderer', () => {
    it('draws an excalidraw block instead of a generic code block', () => {
        const node = block(renderMarkdown(`\`\`\`excalidraw\n${SAMPLE_EXCALIDRAW_JSON}\n\`\`\``).html);
        expect(node).not.toBeNull();
        expect(node.classList.contains('excalidraw-block')).toBe(true);
    });

    it('carries the body encoded so it survives DOMPurify sanitization', () => {
        const node = block(renderMarkdown(`\`\`\`excalidraw\n${SAMPLE_EXCALIDRAW_JSON}\n\`\`\``).html);
        const decoded = decodeDataValue(node.getAttribute('data-excalidraw') ?? '');
        expect(decoded.trim()).toBe(SAMPLE_EXCALIDRAW_JSON);
    });

    it('starts in loading state with placeholder', () => {
        const node = block(renderMarkdown(`\`\`\`excalidraw\n${SAMPLE_EXCALIDRAW_JSON}\n\`\`\``).html);
        expect(node.classList.contains('loading')).toBe(true);
        expect(node.getAttribute('aria-busy')).toBe('true');
        expect(node.querySelector('[data-excalidraw-placeholder]')).not.toBeNull();
    });

    it('numbers excalidraw blocks sequentially in document order', () => {
        const frame = document.createElement('div');
        frame.innerHTML = renderMarkdown([
            '```excalidraw',
            '{}',
            '```',
            '',
            'Some markdown text',
            '',
            '```excalidraw',
            '{}',
            '```',
        ].join('\n')).html;
        const indexes = [...frame.querySelectorAll('[data-excalidraw]')].map((n) =>
            n.getAttribute('data-excalidraw-index')
        );
        expect(indexes).toEqual(['0', '1']);
    });

    it('records source line number for fence', () => {
        const markdown = `# Title\n\nParagraph\n\n\`\`\`excalidraw\n{}\n\`\`\``;
        const html = renderMarkdown(markdown).html;
        const node = block(html);
        expect(node.getAttribute('data-line')).toBe('4');
    });
});

describe('excalidraw body parsing and serialization', () => {
    it('creates default scene when empty', () => {
        const defaultScene = createDefaultExcalidrawScene();
        expect(defaultScene.type).toBe('excalidraw');
        expect(defaultScene.elements).toEqual([]);

        const parsedEmpty = parseExcalidrawBody('');
        expect(parsedEmpty.ok).toBe(true);
        expect(parsedEmpty.data.elements).toEqual([]);
    });

    it('parses valid json elements and appState', () => {
        const parsed = parseExcalidrawBody(SAMPLE_EXCALIDRAW_JSON);
        expect(parsed.ok).toBe(true);
        expect(parsed.data.elements.length).toBe(1);
        expect(parsed.data.elements[0].id).toBe('el-1');
    });

    it('gracefully handles malformed json', () => {
        const parsed = parseExcalidrawBody('{ not valid json');
        expect(parsed.ok).toBe(false);
        expect(parsed.error).toBeDefined();
        expect(parsed.data.elements).toEqual([]);
    });

    it('serializes scene back to valid json', () => {
        const parsed = parseExcalidrawBody(SAMPLE_EXCALIDRAW_JSON);
        const serialized = serializeExcalidrawBody(parsed.data);
        const reParsed = JSON.parse(serialized);
        expect(reParsed.type).toBe('excalidraw');
        expect(reParsed.elements[0].id).toBe('el-1');
    });
});

describe('excalidraw fence surgical updates', () => {
    it('finds fences in markdown content', () => {
        const doc = `# Header\n\n\`\`\`excalidraw\n${SAMPLE_EXCALIDRAW_JSON}\n\`\`\`\n\nFooter text`;
        const fences = findExcalidrawFences(doc);
        expect(fences.length).toBe(1);
        expect(fences[0].index).toBe(0);
        expect(fences[0].body.trim()).toBe(SAMPLE_EXCALIDRAW_JSON);
    });

    it('updates body at targeted fence while preserving surrounding markdown', () => {
        const doc = `# Header\n\n\`\`\`excalidraw\n${SAMPLE_EXCALIDRAW_JSON}\n\`\`\`\n\nFooter text`;
        const updatedJson = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'new' }] });
        const result = applyBodyAtFence(doc, { index: 0, rawBody: SAMPLE_EXCALIDRAW_JSON }, updatedJson);
        expect(result).not.toBeNull();
        expect(result).toContain('# Header');
        expect(result).toContain('Footer text');
        expect(result).toContain('{"type":"excalidraw"');
        expect(result).not.toContain('el-1');
    });

    it('detects concurrent edits and reports conflict', () => {
        const doc = `# Header\n\n\`\`\`excalidraw\n${SAMPLE_EXCALIDRAW_JSON}\n\`\`\`\n\nFooter`;
        const conflictRef = { index: 0, rawBody: '{"different":"body"}' };
        const result = applyBodyAtFence(doc, conflictRef, '{}');
        expect(result).toBeNull();
    });
});
