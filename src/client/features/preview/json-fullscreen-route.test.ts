/**
 * The full-screen map keeps working after its block leaves the surface that built it.
 *
 * `enterJsonFullscreen` moves the block into a stage on `<body>` — it has to, because a transformed
 * ancestor would otherwise size "full screen" to the prose column. The cost is that both preview surfaces
 * delegate their block-toolbar clicks from *their own* container, so once the block has moved, a press on
 * the head or on a fold handle bubbles to nothing. Every tool in the overlay is dead while looking entirely
 * wired, and neither gate nor a screenshot of the inline view can see it.
 *
 * The overlay's tools live in the block's own head, which is rebuilt on the way in and on the way out:
 * a second toolbar floating over the canvas was a second copy of the same six presses, and the head
 * already had four of them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installTestGlobals } from '../../lib/test-render';
import type { BlockActionContext } from './block-overlay';
import { enhanceJsonBlockToolbars } from './json-block-toolbar';
import { mountJsonBlocks, reapJsonFullscreen, routeJsonViewPress, runJsonBlockTool } from './json-view-mount';

const BODY = '{\n  "a": {\n    "b": 1\n  },\n  "c": [1, 2]\n}';

function fixture(): { block: HTMLElement, ctx: BlockActionContext, press: (selector: string) => Promise<void> } {
    const block = document.createElement('div');
    block.className = 'code-block';
    block.dataset.jsonBlock = '';
    block.dataset.line = '0';
    block.innerHTML = '<div class="code-block-head"><span class="code-lang">json</span></div>'
      + `<pre><code>${BODY}</code></pre><div class="json-view" data-json-host hidden></div>`;
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
    // The order the two preview surfaces really use: the head is built from the account's default face,
    // then the view layer draws into the host the head declared. Skipping the first step is how a test
    // ends up asserting a head that no block ever has.
    enhanceJsonBlockToolbars(container, { chart: false, jsonView: 'map', jsonFold: 9, sourceNoteId: 'note-1' });
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
const tools = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-json-fullscreen-stage] .json-tools [data-jv]')]
    .map(node => node.dataset.jv!);

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

    it('hands every press the old floating bar carried to the head instead', () => {
        const { block, ctx } = fixture();
        mountJsonBlocks([block], ctx);
        runJsonBlockTool('fullscreen', block, ctx);
        expect(document.querySelector('[data-json-fullscreen-bar]'), 'the overlay must not carry a second toolbar')
            .toBeNull();
        // The head says everything the bar used to, and says it once: a duplicated tool is a duplicated route.
        const seen = tools();
        for (const action of ['exit-fullscreen', 'fit', 'center', 'zoom-out', 'zoom-in', 'export-svg', 'export-png', 'fold-all-map'])
            expect(seen, action).toContain(action);
        expect(seen.filter(action => action === 'zoom-in'), 'a tool must not appear twice').toHaveLength(1);
        expect(seen, 'the enter-fullscreen press has no business in the overlay').not.toContain('fullscreen');
    });

    it('routes a press on the head\'s zoom to the map it belongs to', async () => {
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
        expect(document.querySelector('.jm-row--branch .jm-key')?.textContent).toBe('a: ');
        await press('.jm-fold');
        expect(cards()).toBe(3);
    });

    it('collapses every branch from one head press and brings them all back from the next', async () => {
        const { block, ctx, press } = fixture();
        mountJsonBlocks([block], ctx);
        runJsonBlockTool('fullscreen', block, ctx);
        expect(cards()).toBe(3);
        await press('[data-jv="fold-all-map"]');
        expect(cards(), 'both branches were folded').toBe(1);
        await press('[data-jv="fold-all-map"]');
        expect(cards(), 'the same press is the way back out').toBe(3);
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

    it('gives the inline head its own tool list back on the way out', async () => {
        const { block, ctx, press } = fixture();
        mountJsonBlocks([block], ctx);
        runJsonBlockTool('fullscreen', block, ctx);
        await press('[data-jv="exit-fullscreen"]');
        const back = [...block.querySelectorAll<HTMLElement>('.json-tools [data-jv]')].map(node => node.dataset.jv!);
        expect(back).toContain('fullscreen');
        expect(back, 'the overlay kept the exports').not.toContain('export-svg');
        expect(back).not.toContain('exit-fullscreen');
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

    it('takes its Escape handler back off the document when the stage is reaped', () => {
        // The leave-screen listener lives on `document`, not on the stage. A stage that is reaped without it
        // leaves a capture-phase handler that stops every later Escape in the app — the palette, a dialog,
        // an inline editor — for the rest of the session, with nothing on screen to blame.
        const { block, ctx } = fixture();
        mountJsonBlocks([block], ctx);
        runJsonBlockTool('fullscreen', block, ctx);
        block.remove();
        expect(reapJsonFullscreen()).toBe(true);
        const witness = document.createElement('div');
        document.body.append(witness);
        let reached = false;
        witness.addEventListener('keydown', () => {
            reached = true;
        });
        witness.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(reached, 'the reaped stage is still swallowing Escape').toBe(true);
    });

    it('gives the first Escape to the open card and the next one to the screen', async () => {        // The leave-screen listener sits on `document` in the capture phase, so it sees the press before the
        // map does. Without standing aside, a reader putting away a detail card was thrown out of the
        // full-screen view with it — one gesture, two answers, neither of them asked for.
        const { block, ctx, press } = fixture();
        mountJsonBlocks([block], ctx);
        runJsonBlockTool('fullscreen', block, ctx);
        await press('.jm-card');
        expect(document.querySelector('[data-json-fullscreen-stage] .jm-detail')).not.toBeNull();
        const escape = (): void => {
            document.querySelector('[data-json-fullscreen-stage] [data-json-host]')!
                .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        };
        escape();
        expect(document.querySelector('[data-json-fullscreen-stage] .jm-detail'), 'the card survived the press').toBeNull();
        expect(document.querySelector('[data-json-fullscreen-stage]'), 'the full screen survived the press').not.toBeNull();
        escape();
        expect(document.querySelector('[data-json-fullscreen-stage]')).toBeNull();
    });
});

describe('the map\'s route out to the structure face', () => {
    // `revealJsonPath` keeps the reader's place with `scrollIntoView`, which jsdom does not implement at
    // all — a call into it is a crash rather than a no-op without the repo's own stub.
    installTestGlobals();

    function inline(): { block: HTMLElement, ctx: BlockActionContext } {
        const block = document.createElement('div');
        block.className = 'code-block';
        block.dataset.jsonBlock = '';
        block.dataset.line = '7';
        block.innerHTML = '<div class="code-block-head"><span class="code-lang">json</span></div>'
          + `<pre><code>${BODY}</code></pre><div class="json-view" data-json-host></div>`;
        const container = document.createElement('div');
        container.className = 'ink-prose';
        container.append(block);
        document.body.append(container);
        const ctx: BlockActionContext = {
            content: BODY,
            sourceNoteId: 'note-reveal',
            committedSourceRef: { current: BODY },
            api: { editContent: vi.fn(), toast: vi.fn() },
            jsonView: 'map',
            jsonFold: 9,
        };
        enhanceJsonBlockToolbars(container, { chart: false, jsonView: 'map', jsonFold: 9, sourceNoteId: 'note-reveal' });
        mountJsonBlocks([block], ctx);
        return { block, ctx };
    }

    it('marks the row the card menu asked to see, without opening an editor', async () => {
        const { block, ctx } = inline();
        const row = block.querySelector<HTMLElement>('.jm-row[data-jm-path=\'["a"]\']')!;
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        const reveal = block.querySelector<HTMLElement>('[data-json-map-menu] [data-jt="open-in-tree"]')!;
        routeJsonViewPress(reveal, block, ctx);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(block.dataset.jsonMode, 'the face never changed').toBe('tree');
        const target = block.querySelector<HTMLElement>('.jt-row[data-path=\'["a"]\']');
        expect(target, 'the row the menu named is not on screen').not.toBeNull();
        expect(target!.classList.contains('is-selected'), 'the row is not marked').toBe(true);
        expect(block.querySelector('.jt-input'), 'an editor was opened for a reader who only asked to look')
            .toBeNull();
    });
});
