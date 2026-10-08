import { List, cmpPos, maxPos, minPos, recalculateNumericBullets } from './tree';
import type { CursorStickMode, ListLine, ListPos, Root } from './tree';

export interface OutlinerOperation {
    perform(): void;
    shouldUpdate(): boolean;
    shouldStopPropagation(): boolean;
}

const CHECKBOX_START = /^\[[^\[\]]\][ \t]/;

function isEmptyLineOrEmptyCheckbox(text: string): boolean {
    return text === '' || text === '[ ] ';
}

function isSelfOrDescendant(node: List, candidate: List): boolean {
    if (node === candidate) return true;
    return node.getChildren().some((child) => isSelfOrDescendant(child, candidate));
}

function sameLineSelection(root: Root): { line: number; from: number; to: number } | null {
    const range = root.selections[root.selections.length - 1];
    if (!range || range.anchor.line !== range.head.line) return null;
    return { line: range.anchor.line, from: minPos(range.anchor, range.head).ch, to: maxPos(range.anchor, range.head).ch };
}

export class CreateNewItem implements OutlinerOperation {
    private updated = false;
    private stop = false;

    constructor(private root: Root, private indentChars: string, private after = true) { }

    perform(): void {
        const { root } = this;
        if (!root.hasSingleSelection()) return;
        const selection = sameLineSelection(root);
        if (!selection) return;

        const list = root.getListUnderCursor();
        if (!list) return;
        const lines = list.getLinesInfo();
        if (lines.length === 1 && isEmptyLineOrEmptyCheckbox(lines[0]!.text)) return;

        const cursor = root.getCursor();
        const underCursor = lines.find((entry) => entry.from.line === cursor.line);
        if (!underCursor || cursor.ch < underCursor.from.ch) return;

        const oldLines: string[] = [];
        const newLines: string[] = [];
        for (const entry of lines) {
            if (cursor.line > entry.from.line) oldLines.push(entry.text);
            else if (cursor.line === entry.from.line) {
                oldLines.push(entry.text.slice(0, selection.from - entry.from.ch));
                newLines.push(entry.text.slice(selection.to - entry.from.ch));
            }
            else newLines.push(entry.text);
        }
        if (!oldLines.length || !newLines.length) return;
        if (newLines.length > 1 && !list.getNotesIndent()) return;

        const parent = list.getParent();
        if (!parent) return;
        const onChildLevel = this.after && !list.isEmpty() && !list.isFoldRoot()
            && isAtEnd(list, cursor);

        this.stop = true;
        this.updated = true;

        const firstChild = list.getChildren()[0] ?? null;
        const indent = onChildLevel
            ? (firstChild ? firstChild.getFirstLineIndent() : list.getFirstLineIndent() + this.indentChars)
            : list.getFirstLineIndent();
        const bullet = onChildLevel && firstChild ? firstChild.getBullet() : list.getBullet();
        const space = onChildLevel && firstChild ? firstChild.getSpaceAfterBullet() : list.getSpaceAfterBullet();
        const prefix = CHECKBOX_START.test(oldLines[0]!) ? '[ ] ' : '';

        const newList = new List(root, indent, bullet, prefix, space, prefix + (newLines.shift() ?? ''), false);
        if (newLines.length) {
            newList.setNotesIndent(list.getNotesIndent()!);
            for (const rest of newLines) newList.addLine(rest);
        }

        if (onChildLevel) list.addBeforeAll(newList);
        else {
            if (this.after && (!list.isFoldRoot() || !isAtEnd(list, cursor))) {
                for (const child of list.getChildren()) {
                    list.removeChild(child);
                    newList.addAfterAll(child);
                }
            }
            if (this.after) parent.addAfter(list, newList);
            else parent.addBefore(list, newList);
        }

        list.replaceLines(oldLines);

        const start = newList.getFirstLineContentStart();
        root.replaceCursor({ line: start.line, ch: start.ch + prefix.length });
        recalculateNumericBullets(root);
    }

    shouldUpdate(): boolean {
        return this.updated;
    }

    shouldStopPropagation(): boolean {
        return this.stop;
    }
}

function isAtEnd(list: List, cursor: ListPos): boolean {
    const end = list.getLastLineContentEnd();
    return cursor.line === end.line && cursor.ch === end.ch;
}

export class OutdentList implements OutlinerOperation {
    private updated = false;
    private stop = false;

    constructor(private root: Root) { }

    perform(): void {
        const { root } = this;
        if (!root.hasSingleCursor()) return;

        const list = root.getListUnderCursor();
        if (!list) return;
        this.stop = true;

        const parent = list.getParent();
        const grandParent = parent?.getParent();
        if (!parent || !grandParent) return;

        this.updated = true;
        const before = root.getContentLinesRangeOf(list)?.[0] ?? 0;
        const removeFrom = parent.getFirstLineIndent().length;
        const removeTill = list.getFirstLineIndent().length;

        parent.removeChild(list);
        grandParent.addAfter(parent, list);
        list.unindentContent(removeFrom, removeTill);

        const after = root.getContentLinesRangeOf(list)?.[0] ?? before;
        const cursor = root.getCursor();
        root.replaceCursor({ line: cursor.line + after - before, ch: Math.max(0, cursor.ch - (removeTill - removeFrom)) });
        recalculateNumericBullets(root);
    }

    shouldUpdate(): boolean {
        return this.updated;
    }

    shouldStopPropagation(): boolean {
        return this.stop;
    }
}

export class OutdentListIfItsEmpty implements OutlinerOperation {
    private inner: OutdentList;

    constructor(private root: Root) {
        this.inner = new OutdentList(root);
    }

    perform(): void {
        const { root } = this;
        if (!root.hasSingleCursor()) return;
        const list = root.getListUnderCursor();
        if (!list) return;
        const lines = list.getLines();
        if (lines.length > 1 || !isEmptyLineOrEmptyCheckbox(lines[0] ?? '') || list.getLevel() <= 1) return;
        this.inner.perform();
    }

    shouldUpdate(): boolean {
        return this.inner.shouldUpdate();
    }

    shouldStopPropagation(): boolean {
        return this.inner.shouldStopPropagation();
    }
}

export class IndentList implements OutlinerOperation {
    private updated = false;
    private stop = false;

    constructor(private root: Root, private indentChars: string) { }

    perform(): void {
        const { root } = this;
        if (!root.hasSingleCursor()) return;

        const list = root.getListUnderCursor();
        if (!list) return;
        this.stop = true;

        const parent = list.getParent();
        if (!parent) return;
        const prev = parent.getPrevSiblingOf(list);
        if (!prev) return;

        this.updated = true;
        const before = root.getContentLinesRangeOf(list)?.[0] ?? 0;
        const at = list.getFirstLineIndent().length;

        let chars = '';
        if (!prev.isEmpty()) chars = prev.getChildren()[0]!.getFirstLineIndent().slice(prev.getFirstLineIndent().length);
        if (!chars) chars = list.getFirstLineIndent().slice(parent.getFirstLineIndent().length);
        if (!chars && !list.isEmpty()) chars = list.getChildren()[0]!.getFirstLineIndent();
        if (!chars) chars = this.indentChars;

        parent.removeChild(list);
        prev.addAfterAll(list);
        list.indentContent(at, chars);

        const after = root.getContentLinesRangeOf(list)?.[0] ?? before;
        const cursor = root.getCursor();
        root.replaceCursor({ line: cursor.line + after - before, ch: cursor.ch + chars.length });
        recalculateNumericBullets(root);
    }

    shouldUpdate(): boolean {
        return this.updated;
    }

    shouldStopPropagation(): boolean {
        return this.stop;
    }
}

abstract class MoveList implements OutlinerOperation {
    protected updated = false;
    protected stop = false;

    constructor(protected root: Root) { }

    abstract perform(): void;

    shouldUpdate(): boolean {
        return this.updated;
    }

    shouldStopPropagation(): boolean {
        return this.stop;
    }

    protected relocate(list: List, moved: () => void): void {
        const before = this.root.getContentLinesRangeOf(list)?.[0] ?? 0;
        moved();
        const after = this.root.getContentLinesRangeOf(list)?.[0] ?? before;
        if (before === after) return;
        const cursor = this.root.getCursor();
        this.root.replaceCursor({ line: cursor.line + after - before, ch: cursor.ch });
    }
}

export class MoveListUp extends MoveList {
    perform(): void {
        const { root } = this;
        if (!root.hasSingleCursor()) return;

        const list = root.getListUnderCursor();
        if (!list) return;
        this.stop = true;

        const parent = list.getParent();
        if (!parent) return;
        const grandParent = parent.getParent();
        const prev = parent.getPrevSiblingOf(list);

        if (prev) {
            this.updated = true;
            this.relocate(list, () => {
                parent.removeChild(list);
                parent.addBefore(prev, list);
            });
        }
        else if (grandParent) {
            const uncle = grandParent.getPrevSiblingOf(parent);
            if (!uncle) return;
            this.updated = true;
            this.relocate(list, () => {
                parent.removeChild(list);
                uncle.addAfterAll(list);
            });
        }
        else return;

        recalculateNumericBullets(root);
    }
}

export class MoveListDown extends MoveList {
    perform(): void {
        const { root } = this;
        if (!root.hasSingleCursor()) return;

        const list = root.getListUnderCursor();
        if (!list) return;
        this.stop = true;

        const parent = list.getParent();
        if (!parent) return;
        const grandParent = parent.getParent();
        const next = parent.getNextSiblingOf(list);

        if (next) {
            this.updated = true;
            this.relocate(list, () => {
                parent.removeChild(list);
                parent.addAfter(next, list);
            });
        }
        else if (grandParent) {
            const uncle = grandParent.getNextSiblingOf(parent);
            if (!uncle) return;
            this.updated = true;
            this.relocate(list, () => {
                parent.removeChild(list);
                uncle.addBeforeAll(list);
            });
        }
        else return;

        recalculateNumericBullets(root);
    }
}

export class MoveListToDifferentPosition implements OutlinerOperation {
    private updated = false;
    private stop = false;

    constructor(private root: Root, private moving: List, private target: List,
        private where: 'before' | 'after' | 'inside', private indentChars: string) { }

    perform(): void {
        if (this.moving === this.target || isSelfOrDescendant(this.moving, this.target)) return;

        const targetParent = this.target.getParent();
        if (this.where !== 'inside' && !targetParent) return;

        this.stop = true;
        this.updated = true;

        const anchor = this.cursorAnchor();
        this.detach();
        this.reindent();
        this.restore(anchor);
        recalculateNumericBullets(this.root);
    }

    private cursorAnchor(): { list: List; lineDiff: number; chDiff: number } | null {
        const cursorLine = this.root.getCursor().line;
        const bounds = [
            this.moving.getFirstLineContentStart().line,
            this.moving.getLastLineContentEnd().line,
            this.target.getFirstLineContentStart().line,
            this.target.getLastLineContentEnd().line,
        ];
        if (cursorLine < Math.min(...bounds) || cursorLine > Math.max(...bounds)) return null;
        const cursor = this.root.getCursor();
        const list = this.root.getListUnderLine(cursor.line);
        if (!list) return null;
        const start = list.getFirstLineContentStart();
        return { list, lineDiff: cursor.line - start.line, chDiff: cursor.ch - start.ch };
    }

    private detach(): void {
        const parent = this.moving.getParent();
        if (!parent) return;
        parent.removeChild(this.moving);
        if (this.where === 'inside') {
            this.target.addBeforeAll(this.moving);
            return;
        }
        const targetParent = this.target.getParent();
        if (!targetParent) return;
        if (this.where === 'before') targetParent.addBefore(this.target, this.moving);
        else targetParent.addAfter(this.target, this.moving);
    }

    private reindent(): void {
        const oldIndent = this.moving.getFirstLineIndent();
        const newIndent = this.where === 'inside' ? this.target.getFirstLineIndent() + this.indentChars : this.target.getFirstLineIndent();
        this.moving.unindentContent(0, oldIndent.length);
        this.moving.indentContent(0, newIndent);
    }

    private restore(anchor: { list: List; lineDiff: number; chDiff: number } | null): void {
        if (!anchor) {
            this.root.replaceCursor(this.moving.getLastLineContentEnd());
            return;
        }
        const start = anchor.list.getFirstLineContentStart();
        this.root.replaceCursor({ line: start.line + anchor.lineDiff, ch: start.ch + anchor.chDiff });
    }

    shouldUpdate(): boolean {
        return this.updated;
    }

    shouldStopPropagation(): boolean {
        return this.stop;
    }
}

export class DeleteTillPreviousLineContentEnd implements OutlinerOperation {
    private updated = false;
    private stop = false;

    constructor(private root: Root) { }

    perform(): void {
        const { root } = this;
        if (!root.hasSingleCursor()) return;

        const list = root.getListUnderCursor();
        if (!list) return;
        const cursor = root.getCursor();
        const lines = list.getLinesInfo();
        const index = lines.findIndex((entry) => cursor.ch === entry.from.ch && cursor.line === entry.from.line);

        if (index === 0) this.mergeWithPreviousItem(root, cursor, list);
        else if (index > 0) this.mergeNotes(root, cursor, list, lines, index);
    }

    private mergeNotes(root: Root, cursor: ListPos, list: List, lines: ListLine[], index: number): void {
        const previous = lines[index - 1]!;
        this.stop = true;
        this.updated = true;
        root.replaceCursor({ line: cursor.line - 1, ch: previous.text.length + previous.from.ch });
        previous.text += lines[index]!.text;
        lines.splice(index, 1);
        list.replaceLines(lines.map((entry) => entry.text));
    }

    private mergeWithPreviousItem(root: Root, cursor: ListPos, list: List): void {
        if (root.getChildren()[0] === list && list.isEmpty()) return;
        this.stop = true;

        const prev = root.getListUnderLine(cursor.line - 1);
        const parent = list.getParent();
        if (!prev || !parent) return;

        const bothAreEmpty = prev.isEmpty() && list.isEmpty();
        const prevEmptySameLevel = prev.isEmpty() && !list.isEmpty() && prev.getLevel() === list.getLevel();
        const listEmptyPrevIsParent = list.isEmpty() && prev.getLevel() === list.getLevel() - 1;
        if (!bothAreEmpty && !prevEmptySameLevel && !listEmptyPrevIsParent) return;

        this.updated = true;
        const prevEnd = prev.getLastLineContentEnd();

        if (!prev.getNotesIndent() && list.getNotesIndent()) {
            const notes = list.getNotesIndent()!;
            prev.setNotesIndent(prev.getFirstLineIndent() + notes.slice(list.getFirstLineIndent().length));
        }

        const oldLines = prev.getLines();
        const newLines = list.getLines();
        oldLines[oldLines.length - 1] = (oldLines[oldLines.length - 1] ?? '') + (newLines[0] ?? '');
        prev.replaceLines(oldLines.concat(newLines.slice(1)));
        parent.removeChild(list);

        for (const child of list.getChildren()) {
            list.removeChild(child);
            prev.addAfterAll(child);
        }

        root.replaceCursor(prevEnd);
        recalculateNumericBullets(root);
    }

    shouldUpdate(): boolean {
        return this.updated;
    }

    shouldStopPropagation(): boolean {
        return this.stop;
    }
}

export class DeleteTillNextLineContentStart implements OutlinerOperation {
    private inner: DeleteTillPreviousLineContentEnd;

    constructor(private root: Root) {
        this.inner = new DeleteTillPreviousLineContentEnd(root);
    }

    perform(): void {
        const { root } = this;
        if (!root.hasSingleCursor()) return;

        const list = root.getListUnderCursor();
        if (!list) return;
        const cursor = root.getCursor();
        const lines = list.getLinesInfo();
        const index = lines.findIndex((entry) => cursor.ch === entry.to.ch && cursor.line === entry.to.line);

        if (index === lines.length - 1) {
            const next = root.getListUnderLine(lines[index]!.to.line + 1);
            if (!next) return;
            root.replaceCursor(next.getFirstLineContentStart());
        }
        else if (index >= 0) root.replaceCursor(lines[index + 1]!.from);
        else return;

        this.inner.perform();
    }

    shouldUpdate(): boolean {
        return this.inner.shouldUpdate();
    }

    shouldStopPropagation(): boolean {
        return this.inner.shouldStopPropagation();
    }
}

export class DeleteTillCurrentLineContentStart implements OutlinerOperation {
    private updated = false;
    private stop = false;

    constructor(private root: Root) { }

    perform(): void {
        const { root } = this;
        if (!root.hasSingleCursor()) return;

        const list = root.getListUnderCursor();
        if (!list) return;
        const cursor = root.getCursor();
        const lines = list.getLinesInfo();
        const index = lines.findIndex((entry) => entry.from.line === cursor.line);
        if (index < 0) return;

        this.stop = true;
        this.updated = true;

        const entry = lines[index]!;
        entry.text = entry.text.slice(Math.max(0, cursor.ch - entry.from.ch));
        list.replaceLines(lines.map((line) => line.text));
        root.replaceCursor(entry.from);
    }

    shouldUpdate(): boolean {
        return this.updated;
    }

    shouldStopPropagation(): boolean {
        return this.stop;
    }
}

export class KeepCursorWithinListContent implements OutlinerOperation {
    private updated = false;
    private stop = false;

    constructor(private root: Root, private stickCursor: CursorStickMode) { }

    perform(): void {
        if (this.stickCursor === 'never' || !this.root.hasSingleCursor()) return;
        const cursor = this.root.getCursor();
        const list = this.root.getListUnderCursor();
        if (!list) return;
        const contentStart = list.getFirstLineContentStartAfterCheckbox();
        const prefix = contentStart.line === cursor.line ? contentStart.ch : (list.getNotesIndent()?.length ?? 0);
        if (cursor.ch >= prefix) return;
        this.updated = true;
        this.stop = true;
        this.root.replaceCursor({ line: cursor.line, ch: prefix });
    }

    shouldUpdate(): boolean {
        return this.updated;
    }

    shouldStopPropagation(): boolean {
        return this.stop;
    }
}

export class MoveCursorToPreviousUnfoldedLine implements OutlinerOperation {
    private updated = false;
    private stop = false;

    constructor(private root: Root, private stickCursor: CursorStickMode) { }

    perform(): void {
        const { root } = this;
        if (this.stickCursor === 'never' || !root.hasSingleCursor()) return;

        const list = root.getListUnderCursor();
        if (!list) return;
        const cursor = root.getCursor();
        const lines = list.getLinesInfo();
        const index = lines.findIndex((entry) => cursor.ch === entry.from.ch + list.getCheckboxLength() && cursor.line === entry.from.line);

        if (index === 0) this.jumpToPreviousItem(root, cursor);
        else if (index > 0) {
            this.stop = true;
            this.updated = true;
            root.replaceCursor(lines[index - 1]!.to);
        }
    }

    private jumpToPreviousItem(root: Root, cursor: ListPos): void {
        const prev = root.getListUnderLine(cursor.line - 1);
        if (!prev) return;
        this.stop = true;
        this.updated = true;
        if (prev.isFolded()) {
            const end = prev.getTopFoldRoot().getLinesInfo()[0]?.to;
            if (end) root.replaceCursor(end);
            return;
        }
        root.replaceCursor(prev.getLastLineContentEnd());
    }

    shouldUpdate(): boolean {
        return this.updated;
    }

    shouldStopPropagation(): boolean {
        return this.stop;
    }
}

export class SelectAllContent implements OutlinerOperation {
    private updated = false;
    private stop = false;

    constructor(private root: Root) { }

    perform(): void {
        const { root } = this;
        if (!root.hasSingleSelection()) return;

        const selection = root.selections[0]!;
        const [rootStart, rootEnd] = root.getContentRange();
        const from = minPos(selection.anchor, selection.head);
        const to = maxPos(selection.anchor, selection.head);

        if (from.line < rootStart.line || to.line > rootEnd.line) return;
        if (cmpPos(from, rootStart) === 0 && cmpPos(to, rootEnd) === 0) return;

        const list = root.getListUnderCursor();
        const selected = root.getListUnderLine(from.line);
        if (!list || !selected) return;

        const contentStart = list.getFirstLineContentStartAfterCheckbox();
        const contentEnd = list.getLastLineContentEnd();
        const listStart = selected.getFirstLineContentStartAfterCheckbox();
        const listEnd = selected.getContentEndIncludingChildren();

        if (cmpPos(from, contentStart) === 0 && cmpPos(to, contentEnd) === 0) {
            this.accept(list.getChildren().length
                ? [{ anchor: contentStart, head: list.getContentEndIncludingChildren() }]
                : [{ anchor: rootStart, head: rootEnd }]);
        }
        else if (listStart.ch === from.ch && listEnd.line === to.line && listEnd.ch === to.ch) {
            this.accept([{ anchor: rootStart, head: rootEnd }]);
        }
        else if (cmpPos(from, contentStart) >= 0 && cmpPos(to, contentEnd) <= 0) {
            this.accept([{ anchor: contentStart, head: contentEnd }]);
        }
    }

    private accept(selections: { anchor: ListPos; head: ListPos }[]): void {
        this.stop = true;
        this.updated = true;
        this.root.replaceSelections(selections);
    }

    shouldUpdate(): boolean {
        return this.updated;
    }

    shouldStopPropagation(): boolean {
        return this.stop;
    }
}
