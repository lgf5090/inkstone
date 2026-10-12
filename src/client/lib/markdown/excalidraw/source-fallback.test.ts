import { describe, expect, it } from 'vitest';
import { enhancePreview, type EnhanceOptions } from '../enhance';
import { renderMarkdown } from '../renderer';
import { registerFenceBodies } from '../fence-bodies';

const SCENE = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    elements: [{ id: 'r1', type: 'rectangle', x: 1, y: 1, width: 10, height: 10 }],
    appState: { viewBackgroundColor: '#ffffff', gridSize: null },
    files: {},
});

const FENCE = '```';

function host(): HTMLElement {
    const node = document.createElement('div');
    const rendered = renderMarkdown(`${FENCE}excalidraw\n${SCENE}\n${FENCE}`);
    node.innerHTML = rendered.html;
    registerFenceBodies(node, rendered.fences);
    return node;
}

const base: Omit<EnhanceOptions, 'excalidraw'> = { math: false, mermaid: false, chart: false, kanban: 'source', mindmap: 'source', dataview: 'source', dark: false };

async function blockIn(options: EnhanceOptions): Promise<HTMLElement> {
    const node = host();
    await enhancePreview(node, options);
    return node.querySelector<HTMLElement>('[data-excalidraw]')!;
}

describe('the excalidraw enhance channel', () => {
    it('shows the scene text instead of a promise nobody will keep', async () => {
        const block = await blockIn({ ...base, excalidraw: 'source' });
        expect(block.classList.contains('loading')).toBe(false);
        expect(block.classList.contains('excalidraw-source')).toBe(true);
        expect(block.getAttribute('aria-busy')).toBe('false');
        expect(block.textContent).toContain('r1');
        const placeholder = block.querySelector('[data-excalidraw-placeholder]');
        expect(placeholder?.textContent).toContain('r1');
        expect(placeholder?.querySelector('pre code')).not.toBeNull();
    });

    it('leaves the block alone when the surface mounts the canvas itself', async () => {
        const block = await blockIn({ ...base, excalidraw: 'live' });
        expect(block.classList.contains('loading')).toBe(true);
        expect(block.classList.contains('excalidraw-source')).toBe(false);
        expect(block.querySelector('[data-excalidraw-placeholder]')).not.toBeNull();
    });

    it('does not stack a second fallback when run twice', async () => {
        const node = host();
        await enhancePreview(node, { ...base, excalidraw: 'source' });
        await enhancePreview(node, { ...base, excalidraw: 'source' });
        const block = node.querySelector<HTMLElement>('[data-excalidraw]')!;
        expect(block.querySelectorAll('pre')).toHaveLength(1);
        expect(block.textContent).toContain('r1');
    });
});
