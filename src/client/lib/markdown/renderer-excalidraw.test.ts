import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './renderer';
import { registerFenceBodies } from './fence-bodies';
import { excalidrawBody } from './excalidraw/view';
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

    it('keeps the scene out of the markup and hands it through the fence set', () => {
        const rendered = renderMarkdown(`\`\`\`excalidraw\n${SAMPLE_EXCALIDRAW_JSON}\n\`\`\``);
        const frame = document.createElement('div');
        frame.innerHTML = rendered.html;
        registerFenceBodies(frame, rendered.fences);
        const node = frame.querySelector('[data-excalidraw]')!;
        expect(node.getAttribute('data-excalidraw')).toBe('');
        expect(rendered.html).not.toContain('el-1');
        expect(excalidrawBody(node as HTMLElement).trim()).toBe(SAMPLE_EXCALIDRAW_JSON);
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

    it('prunes deleted elements and unreferenced files on serialization', () => {
        const scene = {
            type: 'excalidraw' as const,
            version: 2,
            source: 'https://excalidraw.com',
            elements: [
                { id: 'el-active', type: 'image', fileId: 'file-1', isDeleted: false },
                { id: 'el-deleted', type: 'image', fileId: 'file-2', isDeleted: true },
                { id: 'el-text-deleted', type: 'text', isDeleted: true },
            ],
            appState: { viewBackgroundColor: '#ffffff', gridSize: null },
            files: {
                'file-1': { id: 'file-1', dataURL: 'data:image/png;base64,active' },
                'file-2': { id: 'file-2', dataURL: 'data:image/png;base64,deleted' },
                'file-orphaned': { id: 'file-orphaned', dataURL: 'data:image/png;base64,orphan' },
            },
        };
        const serialized = serializeExcalidrawBody(scene as any);
        const reParsed = JSON.parse(serialized);
        expect(reParsed.elements.length).toBe(1);
        expect(reParsed.elements[0].id).toBe('el-active');
        expect(Object.keys(reParsed.files)).toEqual(['file-1']);
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

    it('finds and replaces empty excalidraw fences', () => {
        const emptyDoc = '```excalidraw\n```';
        const fences = findExcalidrawFences(emptyDoc);
        expect(fences.length).toBe(1);
        expect(fences[0].body).toBe('');
        const updated = applyBodyAtFence(emptyDoc, { index: 0, rawBody: '' }, '{}');
        expect(updated).toBe('```excalidraw\n{}\n```');
    });

    it('supports tilde fenced excalidraw blocks', () => {
        const tildeDoc = '~~~excalidraw\n{}\n~~~';
        const fences = findExcalidrawFences(tildeDoc);
        expect(fences.length).toBe(1);
        expect(fences[0].fenceOpen).toBe('~~~');
        expect(fences[0].body).toBe('{}');
    });
});

describe('excalidraw view helpers and patch guard', () => {
    it('marks excalidraw block ready with is-ready and aria-busy false', async () => {
        const { markExcalidrawReady } = await import('./excalidraw/view');
        const node = block(renderMarkdown(`\`\`\`excalidraw\n${SAMPLE_EXCALIDRAW_JSON}\n\`\`\``).html) as HTMLElement;
        expect(node.classList.contains('loading')).toBe(true);
        expect(node.getAttribute('aria-busy')).toBe('true');
        expect(node.querySelector('[data-excalidraw-placeholder]')).not.toBeNull();

        markExcalidrawReady(node);
        expect(node.classList.contains('loading')).toBe(false);
        expect(node.classList.contains('is-ready')).toBe(true);
        expect(node.getAttribute('aria-busy')).toBe('false');
        expect(node.querySelector('[data-excalidraw-placeholder]')).toBeNull();
    });

    it('marks excalidraw block with error and removes loading/is-ready', async () => {
        const { showExcalidrawError } = await import('./excalidraw/view');
        const node = block(renderMarkdown(`\`\`\`excalidraw\n${SAMPLE_EXCALIDRAW_JSON}\n\`\`\``).html) as HTMLElement;
        showExcalidrawError(node, 'Network error');
        expect(node.classList.contains('loading')).toBe(false);
        expect(node.classList.contains('is-ready')).toBe(false);
        expect(node.classList.contains('has-error')).toBe(true);
        expect(node.getAttribute('aria-busy')).toBe('false');
        expect(node.querySelector('.excalidraw-error-message')?.textContent).toBe('Network error');
    });

    // The case pulls in the whole preview module to reach `patchChildren`, and a full-suite run is
    // contended enough for that transform to cross the 30 s default it would otherwise inherit.
    it('patchChildren preserves a mounted ready excalidraw block across typing', async () => {
        const { patchChildren } = await import('../../features/preview/Preview');
        const { markExcalidrawReady } = await import('./excalidraw/view');

        const initialDoc = `# Title\n\n\`\`\`excalidraw\n${SAMPLE_EXCALIDRAW_JSON}\n\`\`\``;
        const live = document.createElement('div');
        live.innerHTML = renderMarkdown(initialDoc).html;

        const liveBlock = live.querySelector<HTMLElement>('[data-excalidraw]')!;
        markExcalidrawReady(liveBlock);
        const canvasHost = document.createElement('div');
        canvasHost.className = 'excalidraw-canvas-container';
        canvasHost.id = 'live-canvas';
        liveBlock.append(canvasHost);

        const updatedDoc = `# Title\n\n\`\`\`excalidraw\n${SAMPLE_EXCALIDRAW_JSON}\n\`\`\`\n\nNew paragraph`;
        const staged = document.createElement('div');
        staged.innerHTML = renderMarkdown(updatedDoc).html;

        patchChildren(live, staged);

        const preservedBlock = live.querySelector<HTMLElement>('[data-excalidraw]')!;
        expect(preservedBlock).toBe(liveBlock);
        expect(preservedBlock.classList.contains('is-ready')).toBe(true);
        expect(preservedBlock.classList.contains('loading')).toBe(false);
        expect(preservedBlock.querySelector('#live-canvas')).toBe(canvasHost);
    }, 60_000);
});

