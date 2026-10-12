/**
 * The view layer, tested where jsdom can actually see it.
 *
 * jsdom performs no layout, so every geometry claim is out of scope here — that is what
 * `json-view/layout.test.ts` and the browser probes are for. What jsdom *can* prove, and what broke in
 * the first round, is the bookkeeping: which branch got built, how many times, and what survived a
 * redraw. Each test below is written so that deleting the line it protects turns it red; the notes say
 * which line that is.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findNode, parseJsonDocument, setCollapsed } from '../../lib/markdown/json-view';
import type { JsonDocument } from '../../lib/markdown/json-view';
import {
    applyJsonAction,
    JSON_FILTER_TEXT_LIMIT,
    JSON_TREE_ROW_BUDGET,
    jsonRowMatches,
    renderJsonTree,
} from './json-tree-view';
import type { JsonViewControl } from './json-tree-view';
import { renderJsonMap, fitJsonMap, showJsonDetail, zoomJsonMap, type JsonMapView } from './json-map-view';

function doc(body: string): JsonDocument {
    const parsed = parseJsonDocument(body);
    if (!parsed.ok || !parsed.document)
        throw new Error(`fixture is not readable: ${parsed.failure?.reason}`);
    return parsed.document;
}

function control(over: Partial<JsonViewControl> = {}): JsonViewControl {
    return { editable: true, commit: () => true, notify: () => {}, ...over };
}

function wide(count: number): string {
    const rows = [];
    for (let i = 0; i < count; i++)
        rows.push(`  "k${i}": "v${i}"${i + 1 === count ? '' : ','}`);
    return `{\n${rows.join('\n')}\n}`;
}

describe('renderJsonTree', () => {
    let host: HTMLElement;

    beforeEach(() => {
        host = document.createElement('div');
        document.body.append(host);
    });

    it('builds nothing for a folded branch, and builds it when the branch opens', () => {
        const document = doc('{"a": {"b": 1, "c": 2}, "d": 3}');
        document.root.children![0].collapsed = true;
        renderJsonTree(host, document, control(), null);
        // The folded branch is an empty container, not a hidden full one: the rows do not exist yet.
        const folded = host.querySelector('[data-jt-children=\'["a"]\']')!;
        expect(folded.childElementCount).toBe(0);
        // Five rows, not three: the two closing-bracket rows are rows too, and the folded branch
        // contributes one of those and no member rows.
        expect(host.querySelectorAll('.jt-row').length).toBe(5);
    });

    it('counts the row budget against what is drawn, not what the document holds', () => {
        const document = doc(wide(JSON_TREE_ROW_BUDGET + 500));
        // Everything but the root is a leaf, so folding the root is what keeps the render inside budget.
        document.root.collapsed = true;
        renderJsonTree(host, document, control(), null);
        expect(host.querySelector('.json-view-note')).toBeNull();
        document.root.collapsed = false;
        renderJsonTree(host, document, control(), null);
        const note = host.querySelector<HTMLElement>('.json-view-note');
        expect(note?.textContent).toBeTruthy();
    });

    it('leaves an open editor alone when a redraw arrives mid-word', () => {
        const document = doc('{"a": 1}');
        renderJsonTree(host, document, control(), null);
        host.innerHTML = '<input class="jt-input">';
        const input = host.querySelector('input')!;
        input.focus();
        renderJsonTree(host, doc('{"a": 2}'), control(), null);
        expect(host.contains(input)).toBe(true);
        input.blur();
        renderJsonTree(host, doc('{"a": 2}'), control(), null);
        expect(host.contains(input)).toBe(false);
    });
});

describe('applyJsonAction', () => {
    function target(body: string) {
        const document = doc(body);
        const commits: string[] = [];
        const controlValue = control({ commit: body => { commits.push(body); return true; } });
        return { document, commits, control: controlValue };
    }

    it('renames one key and leaves every other byte alone', () => {
        const { document, commits, control: c } = target('{\n  "a": 1.0,\n  "b": 12345678901234567890\n}');
        expect(applyJsonAction('rename', document, ['a'], c, 'aa')).toBe('changed');
        expect(commits).toEqual(['{\n  "aa": 1.0,\n  "b": 12345678901234567890\n}']);
    });

    it('refuses to edit a read-only block without touching the model', () => {
        const { document, commits, control: c } = target('{"a": 1}');
        const readonly = control({ editable: false, commit: c.commit });
        expect(applyJsonAction('delete', document, ['a'], readonly)).toBe('noop');
        expect(document.root.children).toHaveLength(1);
        expect(commits).toEqual([]);
    });

    it('tells the reader about a duplicate key instead of dropping the rename', () => {
        const { document, control: c } = target('{"a": 1, "b": 2}');
        const notified: string[] = [];
        const spy = control({ notify: title => { notified.push(title); }, commit: () => true });
        expect(applyJsonAction('rename', document, ['b'], spy, 'a')).toBe('changed');
        expect(notified.length).toBe(1);
        expect(document.root.children?.map(child => child.key)).toEqual(['a', 'a']);
        expect(c.editable).toBe(true);
    });
});

describe('the filter reads at most what a row can show', () => {
    it('does not match text past the cap', () => {
        const needle = 'needle';
        const beyond = `${'x'.repeat(JSON_FILTER_TEXT_LIMIT)}${needle}`;
        const document = doc(JSON.stringify({ a: beyond }));
        const node = document.root.children![0];
        expect(jsonRowMatches(node, needle)).toBe(false);
        expect(jsonRowMatches(node, 'xxx')).toBe(true);
    });
});

describe('renderJsonMap', () => {
    let host: HTMLElement;
    let view: JsonMapView;

    beforeEach(() => {
        host = document.createElement('div');
        // jsdom reports zero for every box, which would let `fit` decline for the wrong reason. The
        // transform is the observable here, so the test gives the layout something to fit against.
        host.getBoundingClientRect = () => ({ width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
        document.body.append(host);
        view = { camera: { x: 0, y: 0, scale: 1 }, fitted: false };
    });

    function canvasTransform(): string {
        return host.querySelector<HTMLElement>('[data-json-map-canvas]')?.style.transform ?? '';
    }

    it('fits once, and never again while the view says it has', () => {
        const document = doc('{"a": 1, "b": {"c": 2}}');
        renderJsonMap(host, document, view);
        const first = canvasTransform();
        // Deleting the `if (!view.fitted)` guard makes this red: the second draw would re-fit and shove
        // the reader's pan away.
        view.camera.x = 1234;
        view.camera.y = -77;
        renderJsonMap(host, document, view);
        expect(first).not.toBe('');
        expect(canvasTransform()).toContain('translate(1234px, -77px)');
        expect(view.fitted).toBe(true);
    });

    it('shrinks a map taller than the box instead of drawing it at 1:1', () => {
        // The box is 800x400 and sixty siblings at 40px of pitch are far taller than that, so a fit that
        // actually ran must report a scale below 1. Without the first-frame fit the camera stays at
        // scale 1 and the reader sees a strip of the picture — which is exactly what shipped in round 1.
        const tall = doc(wide(60));
        renderJsonMap(host, tall, view);
        expect(view.camera.scale).toBeLessThan(1);
        expect(canvasTransform()).toContain(`scale(${view.camera.scale})`);
    });

    it('does not spend the one fit on a frame where the host has no size', () => {
        // The first draw can happen before the browser has laid the block out, and a fit that measured
        // nothing would otherwise be recorded as done: the map stays at 1:1 with 1 084px of card in a
        // 340px window, which is what a 1200-key document looked like in a real browser.
        const parsed = doc(wide(60));
        const flat = document.createElement('div');
        document.body.append(flat);
        renderJsonMap(flat, parsed, view);
        expect(view.fitted, 'a zero-size box must not count as fitted').toBe(false);
        expect(flat.querySelector<HTMLElement>('[data-json-map-canvas]')?.style.transform).toBe('translate(0px, 0px) scale(1)');
        // The next draw, with a box, is allowed to fit.
        flat.getBoundingClientRect = host.getBoundingClientRect;
        renderJsonMap(flat, parsed, view);
        expect(view.fitted).toBe(true);
        expect(flat.querySelector<HTMLElement>('[data-json-map-canvas]')?.style.transform).not.toBe('translate(0px, 0px) scale(1)');
    });

    it('survives the host being replaced, because the camera is the caller\x27s', () => {
        const parsed = doc('{"a": 1}');
        renderJsonMap(host, parsed, view);
        const replacement = document.createElement('div');
        replacement.getBoundingClientRect = host.getBoundingClientRect;
        document.body.append(replacement);
        view.camera = { x: 40, y: 50, scale: 1.5 };
        renderJsonMap(replacement, parsed, view);
        expect(replacement.querySelector<HTMLElement>('[data-json-map-canvas]')?.style.transform)
            .toBe('translate(40px, 50px) scale(1.5)');
    });

    it('names the members a card has more than it can draw', () => {
        const parsed = doc(wide(60));
        renderJsonMap(host, parsed, view);
        // Sixty keys, forty drawn, and the card's last line is the count of what the reader cannot see.
        expect(host.querySelectorAll('.jm-card')).toHaveLength(1);
        expect(host.querySelectorAll('.jm-row')).toHaveLength(41);
        expect(host.querySelector('.jm-row--more')?.textContent).toBe('+20');
        renderJsonMap(host, doc(wide(120)), view);
        expect(host.querySelector('.jm-row--more')?.textContent).toBe('+80');
    });

    it('sizes a card for the widest row it is actually going to draw', () => {
        // The measure callback and the painted row are two call sites that must agree, and nothing but
        // this assertion makes them: jsdom gives no canvas, so the fallback rule — seven pixels a
        // character — is the only thing tying the card's width to its text. Deleting the `: ` from the
        // key span, or letting a flex `gap` add advances, reddens this without reddening anything else.
        const parsed = doc(wide(60));
        renderJsonMap(host, parsed, view);
        const card = host.querySelector<HTMLElement>('.jm-card')!;
        const painted = [...host.querySelectorAll('.jm-row')].map(row => row.textContent!.length * 7);
        // 22px of handle column on every row (a leaf pays it too, or its key starts left of a branch's),
        // 9px of padding on each side, and the 1px border on each side, because the card's width is a
        // border-box: leave either out and the widest row of every card ellipsizes (browser-measured).
        expect(card.style.width).toBe(`${Math.max(...painted) + 22 + 2 * 9 + 2}px`);
    });

    it('paints one row per member and one card per container', () => {
        renderJsonMap(host, doc('{"a": 1, "b": {"c": 2}}'), view);
        expect(host.querySelectorAll('.jm-card')).toHaveLength(2);
        // The branch's name is in its row as well as on the line it hangs: a reader who arrives at the
        // `b` card by eye has to be able to ask which member it is without tracing the curve back.
        expect([...host.querySelectorAll('.jm-key')].map(node => node.textContent)).toEqual(['a: ', 'b: ', 'c: ']);
        const branch = host.querySelector('.jm-row--branch')!;
        // This file runs without `initI18n`, so `t()` hands back the key — which is exactly what makes the
        // assertion say something: `_one` proves a single-member object took the singular branch.
        expect(branch.querySelector('.jm-value')?.textContent).toBe('{preview.json_map_key_one}');
        expect([...host.querySelectorAll('.jm-edge-label')].map(node => node.textContent)).toEqual(['b']);
    });

    it('gives a colour value a chip and every kind its own class', () => {
        renderJsonMap(host, doc('{"tint": "#FF0000", "n": 3, "b": true, "z": null}'), view);
        expect(host.querySelectorAll('.jm-chip')).toHaveLength(1);
        expect(host.querySelector('.jm-chip')?.getAttribute('style')).toBe('background:#FF0000');
        expect(host.querySelector('.jm-value--string')?.textContent).toBe('#FF0000');
        for (const kind of ['string', 'number', 'boolean', 'null'])
            expect(host.querySelector(`.jm-value--${kind}`), kind).not.toBeNull();
    });

    it('folds a branch from its row and keeps the name once the card is gone', () => {
        const parsed = doc('{\n  "a": [1, 2]\n}');
        renderJsonMap(host, parsed, view);
        const fold = host.querySelector<HTMLButtonElement>('.jm-fold')!;
        expect(JSON.parse(fold.dataset.jmPath ?? '[]')).toEqual(['a']);
        expect(fold.getAttribute('aria-expanded')).toBe('true');
        setCollapsed(findNode(parsed.root, ['a'])!, true);
        renderJsonMap(host, parsed, view);
        // No card means no connector, so the row is the only place the name can be.
        expect(host.querySelectorAll('.jm-card')).toHaveLength(1);
        expect(host.querySelector('.jm-row--branch .jm-key')?.textContent).toBe('a: ');
        expect(host.querySelector('.jm-row--branch .jm-value')?.textContent).toBe('[preview.json_map_item_other]');
        expect(host.querySelector('.jm-fold')?.getAttribute('aria-expanded')).toBe('false');
    });

    it('promotes an array of objects into one card per element', () => {
        renderJsonMap(host, doc('{"fruits": [{"name": "apple"}, {"name": "pear"}]}'), view);
        // The array never becomes a card; the root and the two fruits are the three objects on screen.
        expect(host.querySelectorAll('.jm-card--array')).toHaveLength(0);
        expect(host.querySelectorAll('.jm-card--object')).toHaveLength(3);
        expect([...host.querySelectorAll('.jm-edge-label')].map(node => node.textContent)).toEqual(['fruits', 'fruits']);
    });

    it('opens a member\'s own text and path when its row is pressed', () => {
        const parsed = doc('{\n  "a": {\n    "b": 1\n  }\n}');
        renderJsonMap(host, parsed, view);
        showJsonDetail(host, parsed, ['a'], host.querySelector<HTMLElement>('.jm-card')!);
        const card = host.querySelector<HTMLElement>('.jm-detail');
        expect(card, 'the detail card never opened').not.toBeNull();
        expect(card!.querySelector('.jm-detail-body')?.textContent).toContain('"b": 1');
        expect(card!.querySelector<HTMLInputElement>('.jm-detail-path')?.value).toBe('$.a');
        // Close, and the two things worth copying: the member and the name of where it lives.
        expect([...card!.querySelectorAll<HTMLButtonElement>('[data-jt]')].map(button => button.dataset.jt))
            .toEqual(['close-detail', 'copy-value', 'copy-path']);
    });

    it('closes the detail card when the camera moves, because it names a place on the canvas', () => {
        const parsed = doc('{"a": 1}');
        renderJsonMap(host, parsed, view);
        showJsonDetail(host, parsed, ['a'], host.querySelector<HTMLElement>('.jm-card')!);
        expect(host.querySelector('.jm-detail')).not.toBeNull();
        zoomJsonMap(host, view, 1.2);
        expect(host.querySelector('.jm-detail')).toBeNull();
    });

    it('closes the detail card when the reader clicks anywhere else', () => {
        // The complaint this answers: a card that only the × can shut. A reader who has finished reading
        // clicks back on the canvas and expects the picture, not a second click on a small button.
        const parsed = doc('{"a": 1}');
        renderJsonMap(host, parsed, view);
        showJsonDetail(host, parsed, ['a'], host.querySelector<HTMLElement>('.jm-card')!);
        expect(host.querySelector('.jm-detail')).not.toBeNull();
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        expect(host.querySelector('.jm-detail')).toBeNull();
    });

    it('keeps the detail card under a press that lands inside it', () => {
        // The closer runs on `pointerdown`, which is before the `click` that carries out the copy. Closing
        // on the way past the card would remove the button the press was aimed at, and the copy would
        // silently never happen — a gesture that looks like it worked.
        const parsed = doc('{"a": 1}');
        renderJsonMap(host, parsed, view);
        showJsonDetail(host, parsed, ['a'], host.querySelector<HTMLElement>('.jm-card')!);
        const copy = host.querySelector<HTMLElement>('[data-jt="copy-value"]')!;
        copy.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        expect(host.querySelector('.jm-detail'), 'the press was inside the card').not.toBeNull();
    });

    it('keeps the block menu away from a right-click that a card claimed', () => {
        // The live preview asks for the note's block menu from an ancestor of this host. Both menus opening
        // on one press is what shipped first: the block menu painted over the card menu and its search box
        // took the focus. So the press that a card answers for must stop there — and one that no card
        // claims must travel, or the block's own tools become unreachable from the map.
        const parsed = doc('{"a": {"b": 1}}');
        renderJsonMap(host, parsed, view);
        let reached = 0;
        const witness = (): void => {
            reached++;
        };
        document.body.addEventListener('contextmenu', witness);
        try {
            host.querySelector<HTMLElement>('.jm-row')!
                .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
            expect(reached, 'the block menu was asked for as well').toBe(0);
            host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
            expect(reached, 'a right-click on bare canvas has to reach the block menu').toBe(1);
        }
        finally {
            document.body.removeEventListener('contextmenu', witness);
        }
    });

    it('takes the right-click away from the editor so the menu can keep the focus', () => {
        // The block lives inside a `contenteditable` live preview, and a right-click's `mousedown` has a
        // default action — put the caret back in the editor — that runs *after* the `contextmenu` handler.
        // jsdom cannot show the theft, but it can show who claimed the default: without this the card menu
        // opens, focuses its first item, and the browser then hands focus straight back to the editor.
        const parsed = doc('{"a": {"b": 1}}');
        renderJsonMap(host, parsed, view);
        const row = host.querySelector<HTMLElement>('.jm-row')!;
        const left = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
        row.dispatchEvent(left);
        expect(left.defaultPrevented, 'a left press must stay the block\'s own click route').toBe(false);
        const right = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
        row.dispatchEvent(right);
        expect(right.defaultPrevented, 'the caret-restoring default of a right press').toBe(true);
        const elsewhere = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
        host.dispatchEvent(elsewhere);
        expect(elsewhere.defaultPrevented, 'a right-click on bare canvas is the reader\'s own').toBe(false);
    });

    it('opens a card menu on right-click, naming the member under the pointer', () => {
        const parsed = doc('{"a": {"b": 1}, "c": [1, 2]}');
        renderJsonMap(host, parsed, view);
        // A fold redraws into the element that is already on the page, so the second draw is the one that
        // used to leave two context-menu handlers behind: the second deleted the first menu, and focus
        // landed on `<body>` with nothing open. One draw per gesture is what this pins.
        renderJsonMap(host, parsed, view);
        const row = host.querySelector<HTMLElement>('.jm-row[data-jm-path=\'["c"]\']')!;
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 30 }));
        const menu = host.querySelector<HTMLElement>('[data-json-map-menu]');
        expect(menu, 'the right-click never opened a menu').not.toBeNull();
        expect(host.querySelectorAll('[data-json-map-menu]'), 'one draw, one menu').toHaveLength(1);
        expect(menu!.getAttribute('role')).toBe('menu');
        expect(menu!.dataset.jmPath).toBe('["c"]');
        expect([...menu!.querySelectorAll<HTMLButtonElement>('[data-jt]')].map(item => item.dataset.jt))
            .toEqual(['fold-branch', 'expand-all-map', 'fold-all-map', 'copy-value', 'copy-path', 'open-in-tree']);
        // Every item is a real button, and the menu takes the focus, or the keyboard cannot follow the
        // pointer that opened it.
        for (const item of menu!.querySelectorAll('button'))
            expect(item.getAttribute('role')).toBe('menuitem');
        expect(menu!.contains(document.activeElement), 'the menu opened without taking focus').toBe(true);
        // The count of menus cannot see a doubled handler — the second one replaces the first's card, so the
        // page still shows exactly one. The wheel can: two installs zoom twice per notch, a map that runs
        // away from the reader's finger at 1.2544x the scale they asked for. Read last, because a camera
        // change retires the menu this test is holding.
        view.camera.scale = 1;
        view.camera.x = 0;
        view.camera.y = 0;
        host.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -10 }));
        expect(view.camera.scale, 'the wheel ran twice').toBeCloseTo(1.12, 6);
        host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
        expect(view.camera.x, 'the arrow pan ran twice').toBe(24);
    });

    it('says expand rather than collapse for a branch that is already folded', () => {
        const parsed = doc('{"a": {"b": 1}}');
        setCollapsed(findNode(parsed.root, ['a'])!, true);
        renderJsonMap(host, parsed, view);
        host.querySelector<HTMLElement>('.jm-row')!
            .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        const items = [...host.querySelectorAll<HTMLButtonElement>('[data-json-map-menu] [data-jt]')].map(item => item.dataset.jt);
        expect(items[0]).toBe('expand-branch');
        expect(items).not.toContain('fold-branch');
    });

    it('closes the card menu on a click away and on a camera move', () => {
        const parsed = doc('{"a": 1}');
        renderJsonMap(host, parsed, view);
        host.querySelector<HTMLElement>('.jm-row')!
            .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        expect(host.querySelector('[data-json-map-menu]')).not.toBeNull();
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        expect(host.querySelector('[data-json-map-menu]')).toBeNull();
        host.querySelector<HTMLElement>('.jm-row')!
            .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        // The menu names a place on the canvas; a pan leaves it pointing at a different member.
        zoomJsonMap(host, view, 1.2);
        expect(host.querySelector('[data-json-map-menu]')).toBeNull();
    });

    it('fits into the camera the caller handed over, never a replacement', () => {
        // The pan handlers hold this object, so a fit that swaps it for a new one leaves the next drag
        // moving the camera the fit just retired: measured in a browser, entering full screen fitted the
        // map and the first drag snapped it back to the inline position it had left.
        const parsed = doc(wide(60));
        renderJsonMap(host, parsed, view);
        const camera = view.camera;
        view.camera.x = -900;
        view.camera.y = -400;
        expect(fitJsonMap(host, view), 'the fit declined on a box this test gave it size to').toBe(true);
        expect(view.camera, 'the fit replaced the object').toBe(camera);
        expect(camera.x).not.toBe(-900);
    });

    it('keeps a pan that is under way when a redraw arrives', () => {
        // The other pane is a keystroke away, and a commit redraws this host. Re-installing the gestures for
        // that would drop the drag in progress, so the reader's hand lifts and the map stops answering the
        // pointer they are still holding down — the one thing a pan must not do.
        host.setPointerCapture = () => {};
        host.releasePointerCapture = () => {};
        host.hasPointerCapture = () => false;
        const parsed = doc(wide(30));
        renderJsonMap(host, parsed, view);
        const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 4, clientX: 300, clientY: 300 });
        host.dispatchEvent(down);
        host.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 4, clientX: 340, clientY: 320 }));
        const panned = view.camera.x;
        expect(panned, 'the drag never started, so the redraw cannot be said to keep it alive').not.toBe(0);
        renderJsonMap(host, parsed, view);
        host.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 4, clientX: 360, clientY: 320 }));
        expect(view.camera.x, 'the redraw dropped the drag').toBe(panned + 20);
    });

    it('makes the host reachable so the keyboard pan is not dead code', () => {
        renderJsonMap(host, doc('{"a": 1}'), view);
        expect(host.tabIndex).toBe(0);
        expect(host.getAttribute('role')).toBe('group');
    });
});
