import { EditorSelection, EditorState } from '@codemirror/state';
import { codeFolding, foldEffect, foldedRanges } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { describe, expect, it } from 'vitest';
import { runOperation, type OutlinerOptions } from './adapter';
import { computeListFold, foldedListLines, listFoldService } from './fold';
import { dragDecorations } from './drag-drop';
import {
    CreateNewItem,
    DeleteTillCurrentLineContentStart,
    DeleteTillNextLineContentStart,
    DeleteTillPreviousLineContentEnd,
    IndentList,
    MoveListDown,
    MoveListToDifferentPosition,
    MoveListUp,
    OutdentList,
    OutdentListIfItsEmpty,
    SelectAllContent,
    type OutlinerOperation,
} from './operations';
import { parseList, type Root } from './tree';

const OPTIONS: OutlinerOptions = {
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
    dragDrop: true,
    indentChars: '  ',
};

const EXTENSIONS = [EditorState.allowMultipleSelections.of(true), codeFolding(), listFoldService, markdown({ base: markdownLanguage })];

function stateWith(text: string, ranges: [number, number][]): EditorState {
    const probe = EditorState.create({ doc: text, extensions: EXTENSIONS });
    const offsets = ranges.map(([line, ch]) => probe.doc.line(line).from + ch);
    return EditorState.create({
        doc: text,
        selection: EditorSelection.create(offsets.map((offset) => EditorSelection.cursor(offset))),
        extensions: EXTENSIONS,
    });
}

function lineCh(state: EditorState, offset: number): [number, number] {
    const line = state.doc.lineAt(offset);
    return [line.number, offset - line.from];
}

interface Result {
    text: string;
    cursor: [number, number];
    handled: boolean;
    selected: string;
}

function apply(text: string, ranges: [number, number][], build: (root: Root) => OutlinerOperation, options = OPTIONS): Result {
    const state = stateWith(text, ranges);
    const run = runOperation(state, options, build);
    if (!run.spec) {
        return {
            text: state.doc.toString(),
            cursor: lineCh(state, state.selection.main.head),
            handled: run.handled,
            selected: state.sliceDoc(state.selection.main.from, state.selection.main.to),
        };
    }
    const transaction = state.update(run.spec);
    const next = transaction.state;
    return {
        text: next.doc.toString(),
        cursor: lineCh(next, next.selection.main.head),
        handled: run.handled,
        selected: next.sliceDoc(next.selection.main.from, next.selection.main.to),
    };
}

const createItem = (root: Root) => new CreateNewItem(root, OPTIONS.indentChars, true);
const indentItem = (root: Root) => new IndentList(root, OPTIONS.indentChars);
const outdentItem = (root: Root) => new OutdentList(root);
const moveUp = (root: Root) => new MoveListUp(root);
const moveDown = (root: Root) => new MoveListDown(root);
const mergeBackward = (root: Root) => new DeleteTillPreviousLineContentEnd(root);
const mergeForward = (root: Root) => new DeleteTillNextLineContentStart(root);
const cutToStart = (root: Root) => new DeleteTillCurrentLineContentStart(root);
const selectItem = (root: Root) => new SelectAllContent(root);
const outdentIfEmpty = (root: Root) => new OutdentListIfItsEmpty(root);

const CORPUS: string[] = [
    '- a\n',
    '- a\n- b\n',
    '- a\n  - b\n    - c\n',
    '- a\n  note\n  more\n- b\n',
    '- [ ] todo\n- [x] done\n',
    '1. one\n2. two\n3. three\n',
    '1) one\n2) two\n',
    '- a\n   \n- b\n',
    '- a\n\t- b\n',
    '-   spaced\n',
    '- a\n\n- b\n',
    '  - orphan indent\n',
    'text\n- a\n- b\ntext\n',
    '- a\n  ```js\n  const x = 1;\n  ```\n- b\n',
    '---\ntags:\n  - a\n  - b\n---\n- note\n',
    '> quote\n- a\n',
    '- a\n- b\n  - b1\n  - b2\n- c\n  - c1\n    - c11\n',
    '1. a\n   1. b\n2. c\n',
    '- a\n  - b\n\n- c\n',
    '- [ ] a\n  - [x] b\n',
    '* star\n+ plus\n- dash\n',
    '- tail space \n- two\n',
    'paragraph\n\n- a\n- b\n\nparagraph\n',
];

describe('outliner: the tree prints back what it read', () => {
    for (const text of CORPUS) {
        it(`round-trips ${JSON.stringify(text)}`, () => {
            const state = stateWith(text, [[1, 0]]);
            const source = {
                line: (number: number) => (number >= 1 && number <= state.doc.lines ? state.doc.line(number).text : ''),
                lastLine: () => state.doc.lines,
                selections: () => [{ anchor: { line: 1, ch: 0 }, head: { line: 1, ch: 0 } }],
                foldedLines: () => [],
            };
            for (let number = 1; number <= state.doc.lines; number++) {
                const root = parseList(source, number, 1, state.doc.lines, OPTIONS.stickCursor);
                if (!root) continue;
                const from = state.doc.line(root.getContentStart().line).from;
                const to = state.doc.line(root.getContentEnd().line).to;
                expect(root.print(), `line ${number} of ${JSON.stringify(text)}`).toBe(state.doc.sliceString(from, to));
            }
        });
    }
});

describe('outliner: Enter', () => {
    it('creates a sibling when the cursor ends the item', () => {
        expect(apply('- item 1\n- item 2\n', [[1, 8]], createItem)).toEqual({
            text: '- item 1\n- \n- item 2\n', cursor: [2, 2], handled: true, selected: '',
        });
    });

    it('creates a child when the item has children', () => {
        expect(apply('- item 1\n  - child 1\n  - child 2\n- item 2\n', [[1, 8]], createItem)).toEqual({
            text: '- item 1\n  - \n  - child 1\n  - child 2\n- item 2\n', cursor: [2, 4], handled: true, selected: '',
        });
    });

    it('creates a sibling, not a child, while the children are folded', () => {
        const folded = stateWith('- one\n  - two\n', [[1, 5]]).update({ effects: foldEffect.of({ from: 5, to: 13 }) }).state;
        const run = runOperation(folded, OPTIONS, createItem);
        expect(run.spec).not.toBeNull();
        expect(folded.update(run.spec!).newDoc.toString()).toBe('- one\n  - two\n- \n');
    });
    it('splits the item at the cursor', () => {
        expect(apply('- item 1\n- long item 2\n', [[2, 7]], createItem)).toEqual({
            text: '- item 1\n- long \n- item 2\n', cursor: [3, 2], handled: true, selected: '',
        });
    });

    it('gives the new task item an empty checkbox', () => {
        expect(apply('- [ ] task 1\n- [ ] task 2\n', [[1, 12]], createItem)).toEqual({
            text: '- [ ] task 1\n- [ ] \n- [ ] task 2\n', cursor: [2, 6], handled: true, selected: '',
        });
    });

    it('does not invent a checkbox from a bracket written in the text', () => {
        expect(apply('- see [x] marks\n- next\n', [[1, 15]], createItem).text).toBe('- see [x] marks\n- \n- next\n');
    });

    it('hands an empty item back to the caller so Enter can end the list', () => {
        expect(apply('- item 1\n- \n- item 3\n', [[2, 2]], createItem).handled).toBe(false);
    });

    it('hands an empty checkbox back too', () => {
        expect(apply('- item 1\n- [ ] \n- item 3\n', [[2, 6]], createItem).handled).toBe(false);
    });

    it('declines before the bullet and with several cursors', () => {
        expect(apply('- item 1\n- item 2\n', [[2, 0]], createItem).handled).toBe(false);
        expect(apply('- a\n- b\n', [[1, 2], [2, 2]], createItem).handled).toBe(false);
    });

    it('renumbers ordered items, in both spellings', () => {
        expect(apply('1. one\n2. two\n', [[1, 6]], createItem).text).toBe('1. one\n2. \n3. two\n');
        expect(apply('1) one\n2) two\n', [[1, 6]], createItem).text).toBe('1) one\n2) \n3) two\n');
    });

    it('keeps a blank continuation line instead of dropping it', () => {
        expect(apply('- a\n   \n- b\n', [[1, 3]], createItem).text).toBe('- a\n- \n   \n- b\n');
    });
});

describe('outliner: Enter on an empty item outdents it', () => {
    it('lifts a nested empty item one level', () => {
        expect(apply('- a\n  - \n- b\n', [[2, 4]], outdentIfEmpty)).toEqual({
            text: '- a\n- \n- b\n', cursor: [2, 2], handled: true, selected: '',
        });
    });

    it('leaves an empty top level item alone', () => {
        const result = apply('- a\n- \n', [[2, 2]], outdentIfEmpty);
        expect(result.handled).toBe(false);
        expect(result.text).toBe('- a\n- \n');
    });

    it('leaves a filled nested item alone', () => {
        expect(apply('- a\n  - b\n', [[2, 4]], outdentIfEmpty).handled).toBe(false);
    });
});

describe('outliner: Tab and Shift-Tab', () => {
    it('indents an item with its subtree under its previous sibling', () => {
        expect(apply('- a\n- b\n  - b1\n- c\n', [[2, 2]], indentItem)).toEqual({
            text: '- a\n  - b\n    - b1\n- c\n', cursor: [2, 4], handled: true, selected: '',
        });
    });

    it('borrows the indent width the sibling already uses', () => {
        expect(apply('- a\n  - a1\n- b\n', [[3, 2]], indentItem).text).toBe('- a\n  - a1\n  - b\n');
    });

    it('swallows Tab on the first item of a level without changing the text', () => {
        const result = apply('- a\n- b\n', [[1, 2]], indentItem);
        expect(result).toEqual({ text: '- a\n- b\n', cursor: [1, 2], handled: true, selected: '' });
    });

    it('outdents an item and takes its first level of children with it', () => {
        expect(apply('- a\n  - b\n    - c\n', [[2, 4]], outdentItem)).toEqual({
            text: '- a\n- b\n  - c\n', cursor: [2, 2], handled: true, selected: '',
        });
    });

    it('swallows Shift-Tab on a top level item', () => {
        const result = apply('- a\n- b\n', [[1, 2]], outdentItem);
        expect(result).toEqual({ text: '- a\n- b\n', cursor: [1, 2], handled: true, selected: '' });
    });

    it('rewrites continuation notes when the item moves', () => {
        expect(apply('- a\n- b\n  written text\n', [[2, 2]], indentItem).text).toBe('- a\n  - b\n    written text\n');
    });
});

describe('outliner: moving items with their subtree', () => {
    it('moves an item and its children up', () => {
        expect(apply('- a\n- b\n  - b1\n- c\n', [[2, 2]], moveUp)).toEqual({
            text: '- b\n  - b1\n- a\n- c\n', cursor: [1, 2], handled: true, selected: '',
        });
    });

    it('moves an item and its children down', () => {
        expect(apply('- a\n- b\n  - b1\n- c\n', [[2, 2]], moveDown)).toEqual({
            text: '- a\n- c\n- b\n  - b1\n', cursor: [3, 2], handled: true, selected: '',
        });
    });

    it('adopts an only child into the previous uncle', () => {
        expect(apply('- a\n  - x\n- b\n  - y\n', [[4, 4]], moveUp).text).toBe('- a\n  - x\n  - y\n- b\n');
    });

    it('adopts an only child into the next uncle', () => {
        expect(apply('- a\n  - x\n- b\n  - y\n', [[2, 4]], moveDown).text).toBe('- a\n- b\n  - x\n  - y\n');
    });

    it('does nothing at either end of the list', () => {
        expect(apply('- a\n- b\n', [[1, 2]], moveUp).text).toBe('- a\n- b\n');
        expect(apply('- a\n- b\n', [[2, 2]], moveDown).text).toBe('- a\n- b\n');
    });

    it('keeps the cursor with the item that moved', () => {
        expect(apply('- a\n- b\n  - b1\n- c\n', [[3, 6]], moveUp).cursor).toEqual([2, 6]);
    });
});

describe('outliner: deleting across item boundaries', () => {
    it('merges an item into the one above', () => {
        expect(apply('- a\n- b\n', [[2, 2]], mergeBackward)).toEqual({
            text: '- ab\n', cursor: [1, 3], handled: true, selected: '',
        });
    });

    it('merges a continuation note into the line above', () => {
        expect(apply('- a\n  bb\n', [[2, 2]], mergeBackward)).toEqual({
            text: '- abb\n', cursor: [1, 3], handled: true, selected: '',
        });
    });

    it('lifts the children when an empty parent is deleted', () => {
        expect(apply('- a\n- \n  - b\n', [[2, 2]], mergeBackward).text).toBe('- a\n  - b\n');
    });

    it('joins a nested item to its parent', () => {
        expect(apply('- a\n  - b\n', [[2, 4]], mergeBackward).text).toBe('- ab\n');
    });

    it('declines on the first item and away from a boundary', () => {
        expect(apply('- a\n- b\n', [[1, 2]], mergeBackward).handled).toBe(false);
        expect(apply('- ab\n- cd\n', [[2, 3]], mergeBackward).handled).toBe(false);
    });

    it('joins the next item at the delete key', () => {
        expect(apply('- a\n- b\n', [[1, 3]], mergeForward)).toEqual({
            text: '- ab\n', cursor: [1, 3], handled: true, selected: '',
        });
    });

    it('joins a note up at the delete key', () => {
        expect(apply('- a\n  bb\n', [[1, 3]], mergeForward).text).toBe('- abb\n');
    });

    it('declines past the end of the list', () => {
        expect(apply('- a\nplain\n', [[1, 3]], mergeForward).handled).toBe(false);
    });

    it('cuts from the cursor back to the content start', () => {
        expect(apply('- hello\n- world\n', [[1, 5]], cutToStart)).toEqual({
            text: '- lo\n- world\n', cursor: [1, 2], handled: true, selected: '',
        });
    });
});

describe('outliner: progressive select all', () => {
    it('selects the item content on the first press', () => {
        expect(apply('- hello world\n- second\n', [[1, 4]], selectItem).selected).toBe('hello world');
    });

    it('widens to the sub lists, then to the whole list', () => {
        const first = apply('- a\n  - b\n- c\n', [[1, 2]], selectItem);
        expect(first.selected).toBe('a');
        const state = stateWith('- a\n  - b\n- c\n', [[1, 2]]);
        const pressed = state.update({ selection: { anchor: state.doc.line(1).from + 2, head: state.doc.line(1).from + 3 } }).state;
        const second = runOperation(pressed, OPTIONS, selectItem);
        const widened = pressed.update(second.spec!).state;
        expect(widened.sliceDoc(widened.selection.main.from, widened.selection.main.to)).toBe('a\n  - b');
        const third = runOperation(widened, OPTIONS, selectItem);
        const whole = widened.update(third.spec!).state;
        expect(whole.sliceDoc(whole.selection.main.from, whole.selection.main.to)).toBe('- a\n  - b\n- c');
    });

    it('declines once the whole list is selected so Ctrl+A can reach the document', () => {
        const state = stateWith('- a\n- b\n', [[1, 0]]);
        const all = state.update({ selection: { anchor: 0, head: state.doc.length } }).state;
        const run = runOperation(all, OPTIONS, selectItem);
        expect(run.handled).toBe(false);
        expect(run.spec).toBeNull();
    });
});

describe('outliner: drag and drop', () => {
    it('moves the dragged item inside another one', () => {
        const dropped = (root: Root) => {
            const moving = root.getListUnderLine(2)!;
            const into = root.getListUnderLine(3)!;
            return new MoveListToDifferentPosition(root, moving, into, 'inside', OPTIONS.indentChars);
        };
        expect(apply('- a\n- b\n- c\n  - c1\n', [[2, 2]], dropped).text).toBe('- a\n- c\n  - b\n  - c1\n');
    });

    it('moves the dragged item before another one at the same level', () => {
        const dropped = (root: Root) => {
            const moving = root.getListUnderLine(4)!;
            const into = root.getListUnderLine(1)!;
            return new MoveListToDifferentPosition(root, moving, into, 'before', OPTIONS.indentChars);
        };
        expect(apply('- a\n- b\n- c\n- d\n', [[4, 2]], dropped).text).toBe('- d\n- a\n- b\n- c\n');
    });

    it('refuses to drop an item into its own child', () => {
        let captured: Root | null = null;
        runOperation(stateWith('- a\n  - b\n    - c\n', [[1, 2]]), OPTIONS, (root) => {
            captured = root;
            return { perform() { }, shouldUpdate: () => false, shouldStopPropagation: () => false };
        });
        const root = captured!;
        const operation = new MoveListToDifferentPosition(root, root.getListUnderLine(1)!, root.getListUnderLine(2)!, 'before', OPTIONS.indentChars);
        operation.perform();
        expect(operation.shouldUpdate()).toBe(false);
        expect(operation.shouldStopPropagation()).toBe(false);
        expect(root.print()).toBe('- a\n  - b\n    - c');
    });

    it('paints a drop target that sits above the dragged subtree', () => {
        const state = stateWith('- a\n  - b\n  - c\n', [[2, 4]]);
        const dragged = { from: state.doc.line(2).from, to: state.doc.line(2).to };
        expect(dragDecorations({ ...dragged, drop: state.doc.line(1).from }, state).size).toBe(2);
        expect(dragDecorations({ ...dragged, drop: state.doc.line(3).from }, state).size).toBe(2);
        expect(dragDecorations({ ...dragged, drop: dragged.from }, state).size).toBe(1);
        expect(dragDecorations(null, state).size).toBe(0);
    });
});

describe('outliner: it never rewrites text that is not a list it owns', () => {
    const fenced = '- a\n  ```js\n  const x = 1;\n  ```\n- b\n';
    const frontMatter = '---\ntags:\n  - a\n  - b\n---\n- note\n';
    const formula = '$$\n- 1 + 1 = 2\n$$\n- item\n';

    it('leaves fenced code alone', () => {
        expect(apply(fenced, [[2, 4]], createItem).handled).toBe(false);
        expect(apply(fenced, [[2, 4]], indentItem).handled).toBe(false);
        expect(apply(fenced, [[3, 4]], outdentItem).handled).toBe(false);
    });

    it('leaves YAML list items in the front matter alone', () => {
        expect(apply(frontMatter, [[3, 4]], outdentItem).handled).toBe(false);
        expect(apply(frontMatter, [[3, 4]], createItem).handled).toBe(false);
        expect(apply(frontMatter, [[4, 4]], mergeBackward).handled).toBe(false);
    });

    it('leaves a bare YAML sequence in the front matter alone', () => {
        expect(apply('---\n- a\n- b\n---\n\n- note\n', [[2, 2]], outdentItem).handled).toBe(false);
        expect(apply('---\n- a\n- b\n---\n\n- note\n', [[3, 2]], createItem).handled).toBe(false);
        expect(apply('---\n- a\n- b\n---\n\n- note\n', [[3, 2]], moveUp).handled).toBe(false);
    });

    it('leaves a display formula alone', () => {
        expect(apply(formula, [[2, 4]], createItem).handled).toBe(false);
    });

    it('lets a real list below the front matter still work', () => {
        expect(apply('---\ntags:\n  - a\n---\n- one\n- two\n', [[6, 2]], moveUp).text).toBe('---\ntags:\n  - a\n---\n- two\n- one\n');
    });

    it('does nothing at all when the master switch is off', () => {
        const off: OutlinerOptions = { ...OPTIONS, enabled: false };
        expect(apply('- a\n- b\n', [[1, 3]], createItem, off).handled).toBe(false);
    });

    it('declines a chain nested past the print depth guard', () => {
        const chain = (levels: number) => Array.from({ length: levels }, (_, i) => ' '.repeat(i) + `- node ${i}`).join('\n');
        const parse = (levels: number) => {
            const state = stateWith(chain(levels), [[1, 0]]);
            return parseList({
                line: (number: number) => (number >= 1 && number <= state.doc.lines ? state.doc.line(number).text : ''),
                lastLine: () => state.doc.lines,
                selections: () => [{ anchor: { line: 1, ch: 0 }, head: { line: 1, ch: 0 } }],
                foldedLines: () => [],
            }, levels, 1, state.doc.lines, OPTIONS.stickCursor);
        };
        expect(parse(201)?.getContentEnd().line).toBe(201);
        expect(parse(202)).toBeNull();
        expect(parse(1000)).toBeNull();
        expect(() => apply(`${chain(1000)}\n`, [[1000, 1002]], createItem)).not.toThrow();
        expect(apply(`${chain(1000)}\n`, [[1000, 1002]], createItem).handled).toBe(false);
    });
});

describe('outliner: folding', () => {
    it('folds the subtree of an item that has children', () => {
        const state = stateWith('- a\n  - b\n    - c\n- d\n', [[1, 2]]);
        const range = computeListFold(state, state.doc.line(1).from, state.doc.line(1).to);
        expect(range).not.toBeNull();
        const folded = state.update({ effects: foldEffect.of(range!) }).state;
        expect(foldedListLines(folded)).toEqual([1]);
        const text: string[] = [];
        foldedRanges(folded).between(0, folded.doc.length, (from, to) => {
            text.push(folded.doc.sliceString(from, to));
        });
        expect(text).toEqual(['\n  - b\n    - c']);
    });

    it('offers no fold for a childless item', () => {
        const state = stateWith('- a\n- b\n', [[2, 2]]);
        expect(computeListFold(state, state.doc.line(2).from, state.doc.line(2).to)).toBeNull();
    });

    it('stops the subtree at the next item of the same level', () => {
        const state = stateWith('- a\n  - b\n- c\n', [[1, 2]]);
        const range = computeListFold(state, state.doc.line(1).from, state.doc.line(1).to)!;
        expect(state.doc.sliceString(range.from, range.to)).toBe('\n  - b');
    });

    it('treats an indented continuation as part of the folded subtree', () => {
        const state = stateWith('- a\n  note\n  - b\n- c\n', [[1, 2]]);
        const range = computeListFold(state, state.doc.line(1).from, state.doc.line(1).to)!;
        expect(state.doc.sliceString(range.from, range.to)).toBe('\n  note\n  - b');
    });

    it('maps every item to the last line of its own subtree', () => {
        const endsOf = (doc: string) => {
            const state = stateWith(doc, [[1, 2]]);
            return Array.from({ length: state.doc.lines }, (_, index) => {
                const line = state.doc.line(index + 1);
                const range = computeListFold(state, line.from, line.to);
                return range ? state.doc.lineAt(range.to).number : 0;
            });
        };
        expect(endsOf('- a\n  - b\n    - c\n  - d\n- e\n')).toEqual([4, 3, 0, 0, 0, 0]);
        expect(endsOf('- a\n  - b\n\n- c\n')).toEqual([2, 0, 0, 0, 0]);
        expect(endsOf('- a\n  - b\ntext\n  - c\n')).toEqual([2, 0, 0, 0, 0]);
        expect(endsOf('- a\n  - b\n-\n')).toEqual([2, 0, 0, 0]);
        expect(endsOf('1. a\n   - b\n2. c\n')).toEqual([2, 0, 0, 0]);
        expect(endsOf('- a\n  - b')).toEqual([2, 0]);
        expect(endsOf('- a\n  note\n- b\n')).toEqual([2, 0, 0, 0]);
    });

    it('records the folded line so the parser can mark the item', () => {
        const state = stateWith('- one\n  - two\n', [[1, 5]]).update({ effects: foldEffect.of({ from: 5, to: 13 }) }).state;
        expect(foldedListLines(state)).toEqual([1]);
    });
});
