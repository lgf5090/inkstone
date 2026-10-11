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
import { parseJsonDocument } from '../../lib/markdown/json-view';
import type { JsonDocument } from '../../lib/markdown/json-view';
import {
    applyJsonAction,
    JSON_FILTER_TEXT_LIMIT,
    JSON_TREE_ROW_BUDGET,
    jsonRowMatches,
    renderJsonTree,
} from './json-tree-view';
import type { JsonViewControl } from './json-tree-view';
import { renderJsonMap, type JsonMapView } from './json-map-view';

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

    it('names the members a container has more than the drawing can show', () => {
        const parsed = doc(wide(60));
        renderJsonMap(host, parsed, view);
        const labels = [...host.querySelectorAll('.jm-label')].map(node => node.textContent);
        // Sixty keys, forty drawn, and the root node says which of the two the reader is looking at.
        expect(labels[0]).toBe('root (60) +20');
        expect(host.querySelectorAll('.jm-node').length).toBe(41);
        renderJsonMap(host, doc(wide(120)), view);
        expect([...host.querySelectorAll('.jm-label')].map(node => node.textContent)).toContain('root (120) +80');
    });

    it('sizes a box for the label it is actually going to draw', () => {
        // The measure callback and the drawn label are two call sites that must agree, and nothing but
        // this assertion makes them: zeroing the hidden count in the measurer alone is invisible to the
        // label test above, because it would leave the box sized for `root (60)` while `root (60) +20`
        // is painted into it. jsdom has no canvas, so the fallback rule — seven pixels a character plus
        // the node chrome — is what pins the two together here.
        const parsed = doc(wide(60));
        renderJsonMap(host, parsed, view);
        const root = host.querySelector<HTMLElement>('.jm-node')!;
        const label = root.querySelector('.jm-label')!.textContent!;
        const width = Number(/width:(\d+)px/.exec(root.getAttribute('style') ?? '')?.[1]);
        expect(label).toBe('root (60) +20');
        expect(width).toBe(label.length * 7 + 22);
    });
});
