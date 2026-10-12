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

function fixture(mode: 'map' | 'tree', options: { fold?: number, body?: string } = {}): { block: HTMLElement, ctx: BlockActionContext } {
    const note = `note-filter-${++sequence}`;
    const body = options.body ?? BODY;
    const fold = options.fold ?? 9;
    const block = document.createElement('div');
    block.className = 'code-block';
    block.dataset.jsonBlock = '';
    block.dataset.line = '0';
    block.innerHTML = '<div class="code-block-head"><span class="code-lang">json</span></div>'
      + `<pre><code>${body}</code></pre><div class="json-view" data-json-host></div>`;
    const container = document.createElement('div');
    container.className = 'ink-prose';
    container.append(block);
    document.body.append(container);
    const ctx: BlockActionContext = {
        content: body,
        sourceNoteId: note,
        committedSourceRef: { current: body },
        api: { editContent: vi.fn(), toast: vi.fn() },
        jsonView: mode,
        jsonFold: fold,
    };
    jsonBlockToolbar.enhance(container, { chart: false, jsonView: mode, jsonFold: fold, sourceNoteId: note });
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

describe('the depth each face arrives at', () => {
    const NESTED = '{\n  "fruits": [\n    { "a": 1 },\n    { "b": 2 }\n  ]\n}';

    const cards = (block: HTMLElement) => [...block.querySelectorAll<HTMLElement>('.jm-card')].map(card => card.getAttribute('aria-label'));
    const rowTexts = (block: HTMLElement) => [...block.querySelectorAll('.jm-row')].map(row => row.textContent ?? '');
    const treeTexts = (block: HTMLElement) => [...block.querySelectorAll('.jt-row')].map(row => row.textContent ?? '');

    it('opens the map one column wider than the list at the same depth', () => {
        // The setting counts source levels, which is what the list shows. The map promotes an array's
        // elements out of the row and into a card of their own, so the same number would otherwise cost it
        // a whole level: an array of objects at the default 2 arrived as one lonely row.
        const { block } = fixture('map', { fold: 2, body: NESTED });
        expect(cards(block)).toHaveLength(3);
        // This file runs without `initI18n`, so `t()` hands back the key. A leaf row carries no fold glyph
        // at all — only the array's own row has one — which is what the spacer is there to keep aligned.
        expect(rowTexts(block)).toEqual(['−fruits: [preview.json_map_item_other]', 'a: 1', 'b: 2']);
        // The array's row says expanded, and there really are two cards hanging off it.
        const handle = block.querySelector<HTMLButtonElement>('.jm-card .jm-fold')!;
        expect(handle.getAttribute('aria-expanded')).toBe('true');
        expect(block.querySelectorAll('.jm-edge-label')).toHaveLength(2);
    });

    /** The row that only exists one level further down: the array element's own member. */
    const deepRow = (block: HTMLElement) => treeTexts(block).some(row => row.startsWith('a:1'));

    it('leaves the list at the depth the setting says', () => {
        const { block } = fixture('tree', { fold: 2, body: NESTED });
        const rows = treeTexts(block);
        expect(rows.some(row => row.includes('fruits'))).toBe(true);
        // Both elements are visible as rows, and both are folded: their own member is not on screen.
        expect(rows.filter(row => row.startsWith('0:') || row.startsWith('1:'))).toHaveLength(2);
        expect(deepRow(block), 'the list showed a row it should have folded').toBe(false);
        // The same document one level deeper does show it, so the assertion above can tell the two apart.
        const deeper = fixture('tree', { fold: 3, body: NESTED }).block;
        expect(deepRow(deeper), 'the control case folded it too, so nothing was being measured').toBe(true);
    });

    it('re-prepares the model when the face changes, both ways', () => {
        const { block, ctx } = fixture('map', { fold: 2, body: NESTED });
        expect(cards(block)).toHaveLength(3);
        const treeTab = block.querySelector<HTMLElement>('[data-jv="mode"][data-json-mode="tree"]')!;
        jsonBlockToolbar.handle(new MouseEvent('click', { bubbles: true }), treeTab, ctx);
        return new Promise(resolve => setTimeout(resolve, 0)).then(() => {
            // The list is back at the depth the setting says: the elements are rows again, folded, and the
            // row the map had drawn is gone rather than leaking across the switch.
            expect(treeTexts(block).length).toBe(8);
            expect(deepRow(block), 'the map’s extra column leaked into the list').toBe(false);
            const mapTab = block.querySelector<HTMLElement>('[data-jv="mode"][data-json-mode="map"]')!;
            jsonBlockToolbar.handle(new MouseEvent('click', { bubbles: true }), mapTab, ctx);
            return new Promise(resolve => setTimeout(resolve, 0));
        }).then(() => {
            expect(cards(block)).toHaveLength(3);
        });
    });

    it('still folds everything when the fence says fold=0', () => {
        // The compensation is one column, not an override: `fold=0` has to stay "show me the top row only",
        // and the array's row must read folded because its elements were never given cards.
        const { block } = fixture('map', { fold: 0, body: NESTED });
        expect([...block.querySelectorAll('.jm-row')].map(row => row.textContent)).toEqual(['+fruits: [preview.json_map_item_other]']);
        const handle = block.querySelector<HTMLButtonElement>('.jm-fold')!;
        expect(handle.getAttribute('aria-expanded')).toBe('false');
        expect(block.querySelectorAll('.jm-card')).toHaveLength(1);
        expect(block.querySelectorAll('.jm-edge-label')).toHaveLength(0);
    });

    it('draws the whole structure when the fence says fold=9', () => {
        const { block } = fixture('map', { fold: 9, body: NESTED });
        // root + the array's card + one per element: promotion is on because the elements are open.
        expect(block.querySelectorAll('.jm-card')).toHaveLength(3);
        expect([...block.querySelectorAll('.jm-row')].map(row => row.textContent)).toEqual(['−fruits: [preview.json_map_item_other]', 'a: 1', 'b: 2']);
    });

    it('keeps a hand-folded card folded across a face change', () => {
        const { block, ctx } = fixture('map', { fold: 2, body: NESTED });
        const handle = block.querySelector<HTMLButtonElement>('.jm-card .jm-fold')!;
        jsonBlockToolbar.handle(new MouseEvent('click', { bubbles: true }), handle, ctx);
        return new Promise(resolve => setTimeout(resolve, 0)).then(() => {
            expect(cards(block), 'the array did not fold').toHaveLength(1);
            const treeTab = block.querySelector<HTMLElement>('[data-jv="mode"][data-json-mode="tree"]')!;
            jsonBlockToolbar.handle(new MouseEvent('click', { bubbles: true }), treeTab, ctx);
            return new Promise(resolve => setTimeout(resolve, 0));
        }).then(() => {
            // The list shows the array folded too: its elements never become rows at all.
            expect(treeTexts(block).filter(row => row.startsWith('0:') || row.startsWith('1:'))).toHaveLength(0);
            const mapTab = block.querySelector<HTMLElement>('[data-jv="mode"][data-json-mode="map"]')!;
            jsonBlockToolbar.handle(new MouseEvent('click', { bubbles: true }), mapTab, ctx);
            return new Promise(resolve => setTimeout(resolve, 0));
        }).then(() => {
            expect(cards(block), 'the fold the reader made was undone by the round trip').toHaveLength(1);
        });
    });

    it('records only the fold the reader made, not the map\'s extra column', async () => {
        // The exception ledger is compared against the depth the model was actually prepared at. Compared
        // against the setting instead, every container the map's extra column had opened is filed as a
        // choice the reader made — and the list then shows one level more than the setting says, as soon as
        // the reader switches face. A fold on a third-level container is the case that cannot hide it: the
        // wrongly filed exceptions are the elements above it, which stay visible in the list.
        const deep = '{\n  "fruits": [\n    { "a": { "x": 1 } },\n    { "b": { "y": 2 } }\n  ]\n}';
        const { block, ctx } = fixture('map', { fold: 2, body: deep });
        expect([...block.querySelectorAll('.jm-row')].map(row => row.textContent))
            .toEqual(['−fruits: [preview.json_map_item_other]', '+a: {preview.json_map_key_one}', '+b: {preview.json_map_key_one}']);
        const handle = [...block.querySelectorAll<HTMLElement>('.jm-row')]
            .find(row => row.textContent?.startsWith('+a:'))!
            .querySelector<HTMLElement>('.jm-fold')!;
        jsonBlockToolbar.handle(new MouseEvent('click', { bubbles: true }), handle, ctx);
        await new Promise(resolve => setTimeout(resolve, 0));
        const treeTab = block.querySelector<HTMLElement>('[data-jv="mode"][data-json-mode="tree"]')!;
        jsonBlockToolbar.handle(new MouseEvent('click', { bubbles: true }), treeTab, ctx);
        await new Promise(resolve => setTimeout(resolve, 0));
        const rows = treeTexts(block);
        expect(rows.filter(row => row.startsWith('0:') || row.startsWith('1:'))).toHaveLength(2);
        expect(rows.some(row => row.startsWith('a:') || row.startsWith('b:')), 'the list opened a level the reader never asked for')
            .toBe(false);
    });
});
