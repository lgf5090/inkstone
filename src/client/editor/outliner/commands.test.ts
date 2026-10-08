import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OutlinerOptions } from './adapter';
import { foldEffect } from '@codemirror/language';
import {
    outlinerBackspace,
    outlinerCursorToPrevious,
    outlinerEnter,
    outlinerFoldItem,
    outlinerNoteLine,
    outlinerSelectListItem,
    outlinerShiftTab,
    outlinerTab,
    outlinerUnfoldItem,
} from './commands';
import { outlinerChrome, outlinerFoldSupport } from './index';
import { computeListFold, foldedListLines } from './fold';

const BASE: OutlinerOptions = {
    enabled: true,
    enter: true,
    shiftEnter: true,
    tab: true,
    stickCursor: 'bullet-and-checkbox',
    selectAll: true,
    moveKeys: true,
    foldKeys: true,
    guides: false,
    guideClick: 'fold',
    dragDrop: false,
    indentChars: '  ',
};

const views: EditorView[] = [];

beforeAll(() => {
    const range = globalThis.Range.prototype as unknown as { getClientRects?: unknown, getBoundingClientRect?: unknown };
    if (typeof range.getClientRects !== 'function') {
        range.getClientRects = () => [] as unknown as DOMRectList;
        range.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 }) as DOMRect;
    }
});

afterEach(() => {
    while (views.length) views.pop()!.destroy();
});

function makeView(text: string, cursor: [number, number], options: OutlinerOptions = BASE): EditorView {
    const probe = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage })] });
    const container = document.createElement('div');
    document.body.append(container);
    const view = new EditorView({
        parent: container,
        state: EditorState.create({
            doc: text,
            selection: { anchor: probe.doc.line(cursor[0]).from + cursor[1] },
            extensions: [
                EditorState.allowMultipleSelections.of(true),
                markdown({ base: markdownLanguage }),
                ...outlinerFoldSupport,
                ...outlinerChrome(() => options),
            ],
        }),
    });
    views.push(view);
    return view;
}

function head(view: EditorView): [number, number] {
    const offset = view.state.selection.main.head;
    const line = view.state.doc.lineAt(offset);
    return [line.number, offset - line.from];
}

function clickInto(view: EditorView, line: number, ch: number): void {
    view.dispatch({ selection: { anchor: view.state.doc.line(line).from + ch } });
}

describe('outliner: the Enter switch', () => {
    it('creates the item while the switch is on', () => {
        const view = makeView('- one\n- two\n', [1, 5]);
        expect(outlinerEnter(view)).toBe(true);
        expect(view.state.doc.toString()).toBe('- one\n- \n- two\n');
    });

    it('leaves Enter to the editor when the switch is off', () => {
        const view = makeView('- one\n- two\n', [1, 5], { ...BASE, enter: false });
        expect(outlinerEnter(view)).toBe(false);
        expect(view.state.doc.toString()).toBe('- one\n- two\n');
    });

    it('waits for the input method instead of cutting a composition short', () => {
        const view = makeView('- one\n- two\n', [1, 5]);
        view.contentDOM.dispatchEvent(new Event('compositionstart', { bubbles: true }));
        expect(outlinerEnter(view)).toBe(false);
        expect(view.state.doc.toString()).toBe('- one\n- two\n');
        view.contentDOM.dispatchEvent(new Event('compositionend', { bubbles: true }));
        expect(outlinerEnter(view)).toBe(true);
        expect(view.state.doc.toString()).toBe('- one\n- \n- two\n');
    });
});

describe('outliner: the Tab switch', () => {
    it('indents through Tab and outdents through Shift-Tab', () => {
        const view = makeView('- a\n- b\n', [2, 2]);
        expect(outlinerTab(view)).toBe(true);
        expect(view.state.doc.toString()).toBe('- a\n  - b\n');
        expect(outlinerShiftTab(view)).toBe(true);
        expect(view.state.doc.toString()).toBe('- a\n- b\n');
    });

    it('steps aside for the plain indent keys when the switch is off', () => {
        const view = makeView('- a\n- b\n', [2, 2], { ...BASE, tab: false });
        expect(outlinerTab(view)).toBe(false);
        expect(outlinerShiftTab(view)).toBe(false);
        expect(view.state.doc.toString()).toBe('- a\n- b\n');
    });
});

describe('outliner: Shift-Enter writes a continuation line', () => {
    it('indents the new line under the item content', () => {
        const view = makeView('- one\n- two\n', [1, 5]);
        expect(outlinerNoteLine(view)).toBe(true);
        expect(view.state.doc.toString()).toBe('- one\n  \n- two\n');
        expect(head(view)).toEqual([2, 2]);
    });

    it('reuses the indent the item already writes its notes with', () => {
        const view = makeView('- one\n   deep note\n- two\n', [2, 3]);
        expect(outlinerNoteLine(view)).toBe(true);
        expect(view.state.doc.toString()).toBe('- one\n   \n   deep note\n- two\n');
    });

    it('declines before the content starts and when the switch is off', () => {
        expect(outlinerNoteLine(makeView('- one\n- two\n', [1, 1]))).toBe(false);
        expect(outlinerNoteLine(makeView('- one\n- two\n', [1, 5], { ...BASE, shiftEnter: false }))).toBe(false);
    });
});

describe('outliner: the select-all switch', () => {
    it('selects the item content while on', () => {
        const view = makeView('- hello there\n- next\n', [1, 6]);
        expect(outlinerSelectListItem(view)).toBe(true);
        expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('hello there');
    });

    it('leaves Ctrl+A alone when off', () => {
        const view = makeView('- hello there\n- next\n', [1, 6], { ...BASE, selectAll: false });
        expect(outlinerSelectListItem(view)).toBe(false);
    });
});

describe('outliner: sticking the cursor to the content', () => {
    it('pushes a cursor dropped on the bullet forward', () => {
        const view = makeView('- hello\n- world\n', [1, 5]);
        clickInto(view, 2, 0);
        expect(head(view)).toEqual([2, 2]);
    });

    it('pushes it past the checkbox when the mode says so', () => {
        const view = makeView('- [ ] hello\n', [1, 5]);
        clickInto(view, 1, 2);
        expect(head(view)).toEqual([1, 6]);
    });

    it('leaves the cursor on the checkbox when the mode is bullet-only', () => {
        const view = makeView('- [ ] hello\n', [1, 5], { ...BASE, stickCursor: 'bullet' });
        clickInto(view, 1, 2);
        expect(head(view)).toEqual([1, 2]);
    });

    it('does nothing when the mode is never', () => {
        const view = makeView('- hello\n', [1, 5], { ...BASE, stickCursor: 'never' });
        clickInto(view, 1, 0);
        expect(head(view)).toEqual([1, 0]);
    });

    it('keeps a selection that starts on the bullet intact', () => {
        const view = makeView('- hello\n- world\n', [1, 0]);
        const from = view.state.doc.line(1).from;
        view.dispatch({ selection: { anchor: from, head: from + 7 } });
        expect(view.state.selection.main.anchor).toBe(from);
        expect(view.state.selection.main.empty).toBe(false);
    });

    it('jumps to the previous item when ArrowLeft sits at the content start', () => {
        const view = makeView('- one\n- two\n', [2, 2]);
        expect(outlinerCursorToPrevious(view)).toBe(true);
        expect(head(view)).toEqual([1, 5]);
    });

    it('declines ArrowLeft away from the content start', () => {
        const view = makeView('- one\n- two\n', [2, 4]);
        expect(outlinerCursorToPrevious(view)).toBe(false);
    });

    it('unfolds the item when the cursor is placed inside it', () => {
        const view = makeView('- one\n  - two\n- three\n', [1, 2]);
        const range = computeListFold(view.state, view.state.doc.line(1).from, view.state.doc.line(1).to)!;
        view.dispatch({ effects: foldEffect.of(range) });
        expect(foldedListLines(view.state)).toEqual([1]);
        clickInto(view, 2, 4);
        expect(foldedListLines(view.state)).toEqual([]);
    });
});
describe('outliner: folding commands', () => {
    it('folds and unfolds the item under the cursor', () => {
        const view = makeView('- one\n  - two\n- three\n', [1, 4]);
        expect(outlinerFoldItem(view)).toBe(true);
        expect(foldedListLines(view.state)).toEqual([1]);
        expect(outlinerUnfoldItem(view)).toBe(true);
        expect(foldedListLines(view.state)).toEqual([]);
    });

    it('reaches the palette action even when only the keys are off', () => {
        const view = makeView('- one\n  - two\n', [1, 4], { ...BASE, foldKeys: false });
        expect(outlinerFoldItem(view)).toBe(true);
        expect(foldedListLines(view.state)).toEqual([1]);
    });

    it('declines to fold an item with nothing under it', () => {
        const view = makeView('- one\n- two\n', [2, 2]);
        expect(outlinerFoldItem(view)).toBe(false);
    });

    it('declines backspace away from a boundary', () => {
        expect(outlinerBackspace(makeView('- one\n- two\n', [2, 3]))).toBe(false);
    });

    it('does nothing at all when the master switch is off', () => {
        const view = makeView('- a\n- b\n', [1, 3], { ...BASE, enabled: false });
        expect(outlinerEnter(view)).toBe(false);
        expect(outlinerTab(view)).toBe(false);
        expect(outlinerFoldItem(view)).toBe(false);
        clickInto(view, 2, 0);
        expect(head(view)).toEqual([2, 0]);
    });
});
