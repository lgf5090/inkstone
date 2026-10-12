/**
 * The JSON block's head: the tools it offers per face, and the filter box's one job.
 *
 * The filter is the reason this file exists. The box was built, opened, focused and read by five
 * call sites — and nothing ever wrote `state.filter`, so typing into it changed the picture on neither
 * face while the code that consumed the value looked entirely wired. A control has to be asserted at the
 * place it is supposed to land, which for the box is the drawn map, not the string in the input.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockActionContext } from './block-overlay';
import { jsonBlockToolbar, rebuildJsonBlockHead } from './json-block-toolbar';
import { mountJsonBlocks } from './json-view-mount';

const BODY = '{\n  "color": "#FF0000",\n  "name": "Apple",\n  "size": { "width": 2 }\n}';

/**
 * Each fixture gets its own note id.
 *
 * The block's memory is keyed by note *and* line, and every fixture here is drawn at line 0: sharing one
 * id would make the first test's face the second test's face, and a filter test that silently ran on the
 * tree would assert tree rows and call them cards.
 */
let sequence = 0;

function fixture(mode: 'map' | 'tree'): { block: HTMLElement, ctx: BlockActionContext } {
    const note = `note-filter-${++sequence}`;
    const block = document.createElement('div');
    block.className = 'code-block';
    block.dataset.jsonBlock = '';
    block.dataset.line = '0';
    block.innerHTML = '<div class="code-block-head"><span class="code-lang">json</span></div>'
      + `<pre><code>${BODY}</code></pre><div class="json-view" data-json-host></div>`;
    const container = document.createElement('div');
    container.className = 'ink-prose';
    container.append(block);
    document.body.append(container);
    const ctx: BlockActionContext = {
        content: BODY,
        sourceNoteId: note,
        committedSourceRef: { current: BODY },
        api: { editContent: vi.fn(), toast: vi.fn() },
        jsonView: mode,
        jsonFold: 9,
    };
    jsonBlockToolbar.enhance(container, { chart: false, jsonView: mode, jsonFold: 9, sourceNoteId: note });
    mountJsonBlocks([block], ctx);
    return { block, ctx };
}

/** Opens the box the way the reader does — by pressing the tool — then types. */
async function type(block: HTMLElement, ctx: BlockActionContext, value: string): Promise<void> {
    const trigger = block.querySelector<HTMLElement>('[data-jv="toggle-filter"]')!;
    jsonBlockToolbar.handle(new MouseEvent('click', { bubbles: true }), trigger, ctx);
    const input = block.querySelector<HTMLInputElement>('input[data-json-filter-input]')!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // The box settles before the picture is rebuilt; a redraw per keystroke cost more than the reader sees.
    await new Promise(resolve => setTimeout(resolve, 260));
    await new Promise(resolve => setTimeout(resolve, 0));
}

const texts = (block: HTMLElement): string[] => [...block.querySelectorAll('.jm-row, .jt-row')].map(node => node.textContent ?? '');

beforeEach(() => {
    document.body.replaceChildren();
});

afterEach(() => {
    document.body.replaceChildren();
});

describe('the json block head', () => {
    it('offers the camera and fold tools only on the faces that can use them', async () => {
        const { block, ctx } = fixture('map');
        const mapTools = [...block.querySelectorAll<HTMLElement>('.json-tools [data-jv]')].map(node => node.dataset.jv);
        for (const action of ['fullscreen', 'fold-all-map', 'fit', 'center', 'zoom-out', 'zoom-in'])
            expect(mapTools, action).toContain(action);
        expect(mapTools, 'exports stay with the full screen').not.toContain('export-svg');
        // The face changes by pressing the tab, the way a reader does it: the head is rebuilt from the
        // block's own state, and a hand-written context only supplies the default for a state brand new.
        const treeTab = block.querySelector<HTMLElement>('[data-jv="mode"][data-json-mode="tree"]')!;
        jsonBlockToolbar.handle(new MouseEvent('click', { bubbles: true }), treeTab, ctx);
        await new Promise(resolve => setTimeout(resolve, 0));
        const treeTools = [...block.querySelectorAll<HTMLElement>('.json-tools [data-jv]')].map(node => node.dataset.jv);
        expect(treeTools).toEqual(['fold-all', 'toggle-filter', 'copy']);
    });

    it('filters the map to what matches, and only to that', async () => {
        const { block, ctx } = fixture('map');
        expect(texts(block).length).toBeGreaterThan(3);
        await type(block, ctx, 'color');
        const rows = texts(block);
        expect(rows.some(row => row.includes('color')), 'the match vanished').toBe(true);
        expect(rows.some(row => row.includes('name')), 'a row that does not match is still drawn').toBe(false);
        expect(block.querySelectorAll('.jm-card').length).toBe(1);
    });

    it('filters the structure face from the same box', async () => {
        const { block, ctx } = fixture('tree');
        await type(block, ctx, 'width');
        const rows = texts(block);
        expect(rows.some(row => row.includes('width'))).toBe(true);
        expect(rows.some(row => row.includes('Apple'))).toBe(false);
    });

    it('draws the whole document again when the box is emptied', async () => {
        const { block, ctx } = fixture('map');
        const before = block.querySelectorAll('.jm-card').length;
        await type(block, ctx, 'color');
        expect(block.querySelectorAll('.jm-card').length).toBeLessThan(before);
        await type(block, ctx, '');
        expect(block.querySelectorAll('.jm-card').length).toBe(before);
    });

    it('says so when nothing matches instead of showing an empty picture', async () => {
        const { block, ctx } = fixture('map');
        await type(block, ctx, 'zzzznothing');
        expect(block.querySelector('.json-view-note')?.textContent).toContain('preview.json_no_matches');
        // The card that says "nothing matched" still counts what the filter hid, because three members do
        // exist and a bare notice would read as an empty document.
        expect(block.querySelectorAll('.jm-card')).toHaveLength(1);
        expect(block.querySelector('.jm-row--more')?.textContent).toBe('+3');
    });

    it('keeps the box showing what the picture is filtered to after the head is rebuilt', async () => {
        // The preview hands the block a fresh head on every commit; the state survives, so the box has to
        // be told, or a reader watching a filtered map sees an empty filter beside it.
        const { block, ctx } = fixture('map');
        await type(block, ctx, 'color');
        rebuildJsonBlockHead(block, ctx);
        expect(block.querySelector<HTMLInputElement>('input[data-json-filter-input]')?.value).toBe('color');
        expect(block.querySelectorAll('.jm-card')).toHaveLength(1);
    });
});
