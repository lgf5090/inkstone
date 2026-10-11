/**
 * The full-screen map keeps working after its block leaves the surface that built it.
 *
 * `enterJsonFullscreen` moves the block into a stage on `<body>` — it has to, because a transformed
 * ancestor would otherwise size "full screen" to the prose column. The cost is that both preview surfaces
 * delegate their block-toolbar clicks from *their own* container, so once the block has moved, a press on
 * the bar or on a fold handle bubbles to nothing. Every tool in the overlay is dead while looking entirely
 * wired, and neither gate nor a screenshot of the inline view can see it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlockActionContext } from './block-overlay';
import { mountJsonBlocks, reapJsonFullscreen, runJsonBlockTool } from './json-view-mount';

const BODY = '{\n  "a": {\n    "b": 1\n  },\n  "c": [1, 2]\n}';

function fixture(): { block: HTMLElement, ctx: BlockActionContext, press: (selector: string) => Promise<void> } {
    const block = document.createElement('div');
    block.className = 'code-block';
    block.dataset.jsonBlock = '';
    block.dataset.line = '0';
    block.innerHTML = `<pre><code>${BODY}</code></pre><div class="json-view" data-json-host hidden></div>`;
    // Deliberately a container with no click listener of its own: the route this test is about has to come
    // from the stage, or every press here would silently do nothing.
    const container = document.createElement('div');
    container.className = 'ink-prose';
    container.append(block);
    document.body.append(container);
    const ctx: BlockActionContext = {
        content: BODY,
        sourceNoteId: 'note-1',
        committedSourceRef: { current: BODY },
        api: { editContent: vi.fn(), toast: vi.fn() },
        jsonView: 'map',
        jsonFold: 9,
    };
    return {
        block,
        ctx,
        // The route reaches the view through the lazy chunk, so a press only lands a turn of the loop later.
        async press(selector: string) {
            const target = document.querySelector<HTMLElement>(`[data-json-fullscreen-stage] ${selector}`);
            if (!target)
                throw new Error(`nothing matches ${selector} in the stage`);
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await new Promise(resolve => setTimeout(resolve, 0));
        },
    };
}

const canvas = (): HTMLElement | null => document.querySelector('[data-json-fullscreen-stage] [data-json-map-canvas]');
const cards = (): number => document.querySelectorAll('[data-json-fullscreen-stage] .jm-card').length;

afterEach(() => {
    document.body.replaceChildren();
    reapJsonFullscreen();
});

describe('the json map full screen', () => {
    it('draws the map and moves the block into a stage of its own', () => {
        const { block, ctx } = fixture();
        mountJsonBlocks([block], ctx);
        expect(block.querySelector('[data-json-map-canvas]'), 'the map face never drew').not.toBeNull();
        runJsonBlockTool('fullscreen', block, ctx);
        expect(document.querySelector('[data-json-fullscreen-stage]')).not.toBeNull();
        expect(block.classList.contains('is-json-fullscreen')).toBe(true);
    });

    it('routes a press on the bar\'s zoom to the map it belongs to', async () => {
        const { block, ctx, press } = fixture();
        mountJsonBlocks([block], ctx);
        runJsonBlockTool('fullscreen', block, ctx);
        const before = canvas()!.style.transform;
        await press('[data-jv="zoom-in"]');
        expect(canvas()!.style.transform).not.toBe(before);
        expect(canvas()!.style.transform).toContain('scale(1.2)');
    });

    it('routes a press on a fold handle to the same model the inline view edits', async () => {
        const { block, ctx, press } = fixture();
        mountJsonBlocks([block], ctx);
        runJsonBlockTool('fullscreen', block, ctx);
        expect(cards()).toBe(3);
        await press('.jm-fold');
        expect(cards(), 'the folded branch should have lost its card').toBe(2);
        expect(document.querySelector('.jm-row--branch .jm-key')?.textContent).toBe('a : ');
        await press('.jm-fold');
        expect(cards()).toBe(3);
    });

    it('leaves by the same route it entered, and takes the stage with it', async () => {
        const { block, ctx, press } = fixture();
        mountJsonBlocks([block], ctx);
        runJsonBlockTool('fullscreen', block, ctx);
        await press('[data-jv="exit-fullscreen"]');
        expect(document.querySelector('[data-json-fullscreen-stage]')).toBeNull();
        expect(document.querySelector('.code-block')).toBe(block);
        expect(block.classList.contains('is-json-fullscreen')).toBe(false);
    });

    it('reaps the stage when the block it holds is gone', () => {
        const { block, ctx } = fixture();
        mountJsonBlocks([block], ctx);
        runJsonBlockTool('fullscreen', block, ctx);
        block.remove();
        expect(reapJsonFullscreen()).toBe(true);
        expect(document.querySelector('[data-json-fullscreen-stage]')).toBeNull();
        expect(reapJsonFullscreen()).toBe(false);
    });
});
