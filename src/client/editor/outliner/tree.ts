export type CursorStickMode = 'never' | 'bullet' | 'bullet-and-checkbox';

export interface ListPos {
    line: number;
    ch: number;
}

export interface ListRange {
    anchor: ListPos;
    head: ListPos;
}

export interface ListLine {
    text: string;
    from: ListPos;
    to: ListPos;
}

export interface ListSource {
    line(n: number): string;
    lastLine(): number;
    selections(): ListRange[];
    foldedLines(): number[];
}

const BULLET = '(?:[-*+]|\\d+[.)])';
const CHECKBOX = '\\[[^\\[\\]]\\][ \\t]';

const listItemRe = new RegExp(`^[ \\t]*${BULLET}[ \\t]`);
const bareListItemRe = new RegExp(`^${BULLET}[ \\t]`);
const indentRe = /^[ \t]+/;
const leadingIndentRe = /^[ \t]*/;
const parseItemRe = new RegExp(`^([ \\t]*)(${BULLET})([ \\t]+)(${CHECKBOX})?(.*)$`);

/** Print and clone recurse, and a generated note can nest thousands of levels: past this depth the parser declines rather than overflow the stack. */
const MAX_LIST_DEPTH = 200;

export function isListItemLine(text: string): boolean {
    return listItemRe.test(text);
}

export function isIndentedLine(text: string): boolean {
    return indentRe.test(text);
}

export function cmpPos(a: ListPos, b: ListPos): number {
    return a.line - b.line || a.ch - b.ch;
}

export function minPos(a: ListPos, b: ListPos): ListPos {
    return cmpPos(a, b) < 0 ? a : b;
}

export function maxPos(a: ListPos, b: ListPos): ListPos {
    return cmpPos(a, b) < 0 ? b : a;
}

export function rangesIntersect(a: [ListPos, ListPos], b: [ListPos, ListPos]): boolean {
    return cmpPos(a[1], b[0]) >= 0 && cmpPos(a[0], b[1]) <= 0;
}

function leadingIndent(text: string): string {
    return leadingIndentRe.exec(text)?.[0] ?? '';
}

let idSeq = 0;

export class List {
    id = idSeq++;
    parent: List | null = null;
    children: List[] = [];
    notesIndent: string | null = null;

    private lines: string[];

    constructor(private root: Root, private indent: string, private bullet: string, private checkbox: string,
        private spaceAfterBullet: string, firstLine: string, private foldRoot: boolean) {
        this.lines = [firstLine];
    }

    getRoot(): Root {
        return this.root;
    }

    getID(): number {
        return this.id;
    }

    getParent(): List | null {
        return this.parent;
    }

    getChildren(): List[] {
        return this.children.slice();
    }

    isEmpty(): boolean {
        return this.children.length === 0;
    }

    getLevel(): number {
        return this.parent ? this.parent.getLevel() + 1 : 0;
    }

    isFoldRoot(): boolean {
        return this.foldRoot;
    }

    isFolded(): boolean {
        if (this.foldRoot) return true;
        return this.parent ? this.parent.isFolded() : false;
    }

    getTopFoldRoot(): List {
        let node: List | null = this;
        let found: List | null = null;
        while (node) {
            if (node.foldRoot) found = node;
            node = node.parent;
        }
        return found ?? this;
    }

    getFirstLineIndent(): string {
        return this.indent;
    }

    getBullet(): string {
        return this.bullet;
    }

    getSpaceAfterBullet(): string {
        return this.spaceAfterBullet;
    }

    getCheckboxLength(): number {
        return this.checkbox.length;
    }

    getNotesIndent(): string | null {
        return this.notesIndent;
    }

    setNotesIndent(indent: string): void {
        this.notesIndent = indent;
    }

    replateBullet(bullet: string): void {
        this.bullet = bullet;
    }

    getLineCount(): number {
        return this.lines.length;
    }

    getLines(): string[] {
        return this.lines.slice();
    }

    addLine(text: string): void {
        this.lines.push(text);
    }

    replaceLines(lines: string[]): void {
        this.lines = lines;
    }

    contentStartCh(): number {
        return this.indent.length + this.bullet.length + this.spaceAfterBullet.length;
    }

    getLinesInfo(): ListLine[] {
        const range = this.root.getContentLinesRangeOf(this);
        const startLine = range ? range[0] : this.root.getContentStart().line;
        const notesCh = this.notesIndent?.length ?? 0;
        return this.lines.map((text, index) => {
            const line = startLine + index;
            const fromCh = index === 0 ? this.contentStartCh() : notesCh;
            return { text, from: { line, ch: fromCh }, to: { line, ch: fromCh + text.length } };
        });
    }

    getFirstLineContentStart(): ListPos {
        const range = this.root.getContentLinesRangeOf(this);
        return { line: range ? range[0] : this.root.getContentStart().line, ch: this.contentStartCh() };
    }

    getFirstLineContentStartAfterCheckbox(): ListPos {
        const start = this.getFirstLineContentStart();
        return { line: start.line, ch: start.ch + this.getCheckboxLength() };
    }

    getLastLineContentEnd(): ListPos {
        const range = this.root.getContentLinesRangeOf(this);
        const endLine = range ? range[1] : this.root.getContentStart().line;
        const lastIndex = this.lines.length - 1;
        const endCh = lastIndex === 0
            ? this.contentStartCh() + (this.lines[0]?.length ?? 0)
            : (this.notesIndent?.length ?? 0) + (this.lines[lastIndex]?.length ?? 0);
        return { line: endLine, ch: endCh };
    }

    getContentEndIncludingChildren(): ListPos {
        let node: List = this;
        while (node.children.length) node = node.children[node.children.length - 1]!;
        return node.getLastLineContentEnd();
    }

    addAfterAll(list: List): void {
        this.children.push(list);
        list.parent = this;
    }

    addBeforeAll(list: List): void {
        this.children.unshift(list);
        list.parent = this;
    }

    addBefore(before: List, list: List): void {
        const index = this.children.indexOf(before);
        if (index < 0) return;
        this.children.splice(index, 0, list);
        list.parent = this;
    }

    addAfter(after: List, list: List): void {
        const index = this.children.indexOf(after);
        if (index < 0) return;
        this.children.splice(index + 1, 0, list);
        list.parent = this;
    }

    removeChild(list: List): void {
        const index = this.children.indexOf(list);
        if (index < 0) return;
        this.children.splice(index, 1);
        list.parent = null;
    }

    getPrevSiblingOf(list: List): List | null {
        const index = this.children.indexOf(list);
        return index > 0 ? this.children[index - 1]! : null;
    }

    getNextSiblingOf(list: List): List | null {
        const index = this.children.indexOf(list);
        return index >= 0 && index < this.children.length - 1 ? this.children[index + 1]! : null;
    }

    unindentContent(from: number, till: number): void {
        this.indent = this.indent.slice(0, from) + this.indent.slice(till);
        if (this.notesIndent !== null) this.notesIndent = this.notesIndent.slice(0, from) + this.notesIndent.slice(till);
        for (const child of this.children) child.unindentContent(from, till);
    }

    indentContent(at: number, chars: string): void {
        this.indent = this.indent.slice(0, at) + chars + this.indent.slice(at);
        if (this.notesIndent !== null) this.notesIndent = this.notesIndent.slice(0, at) + chars + this.notesIndent.slice(at);
        for (const child of this.children) child.indentContent(at, chars);
    }

    print(target: string[]): string[] {
        const head = this.indent + this.bullet + this.spaceAfterBullet;
        this.lines.forEach((text, index) => target.push(index === 0 ? head + text : (this.notesIndent ?? '') + text));
        for (const child of this.children) child.print(target);
        return target;
    }

    clone(newRoot: Root): List {
        const copy = new List(newRoot, this.indent, this.bullet, this.checkbox, this.spaceAfterBullet, '', this.foldRoot);
        copy.id = this.id;
        copy.lines = this.lines.slice();
        copy.notesIndent = this.notesIndent;
        for (const child of this.children) copy.addAfterAll(child.clone(newRoot));
        return copy;
    }
}

export class Root {
    rootList: List;
    selections: ListRange[] = [];

    constructor(private start: ListPos, private end: ListPos, selections: ListRange[]) {
        this.rootList = new List(this, '', '', '', '', '', false);
        this.replaceSelections(selections);
    }

    getRootList(): List {
        return this.rootList;
    }

    getChildren(): List[] {
        return this.rootList.getChildren();
    }

    getContentStart(): ListPos {
        return { ...this.start };
    }

    getContentEnd(): ListPos {
        return { ...this.end };
    }

    getContentRange(): [ListPos, ListPos] {
        return [this.getContentStart(), this.getContentEnd()];
    }

    hasSingleSelection(): boolean {
        return this.selections.length === 1;
    }

    hasSingleCursor(): boolean {
        if (!this.hasSingleSelection()) return false;
        const range = this.selections[0]!;
        return range.anchor.line === range.head.line && range.anchor.ch === range.head.ch;
    }

    getSelections(): ListRange[] {
        return this.selections.map((range) => ({ anchor: { ...range.anchor }, head: { ...range.head } }));
    }

    replaceSelections(selections: ListRange[]): void {
        if (!selections.length) throw new Error('a Root needs at least one selection');
        this.selections = selections;
    }

    getCursor(): ListPos {
        return { ...this.selections[this.selections.length - 1]!.head };
    }

    replaceCursor(cursor: ListPos): void {
        this.selections = [{ anchor: cursor, head: cursor }];
    }

    getListUnderCursor(): List | null {
        return this.getListUnderLine(this.getCursor().line);
    }

    getListUnderLine(line: number): List | null {
        if (line < this.start.line || line > this.end.line) return null;
        let found: List | null = null;
        let index = this.start.line;
        const visit = (node: List): boolean => {
            const from = index;
            const to = from + node.getLineCount() - 1;
            if (line >= from && line <= to) {
                found = node;
                return true;
            }
            index = to + 1;
            return node.children.some(visit);
        };
        this.rootList.children.some(visit);
        return found;
    }

    getContentLinesRangeOf(list: List): [number, number] | null {
        let found: [number, number] | null = null;
        let line = this.start.line;
        const visit = (node: List): boolean => {
            const from = line;
            const to = from + node.getLineCount() - 1;
            if (node === list) {
                found = [from, to];
                return true;
            }
            line = to + 1;
            return node.children.some(visit);
        };
        this.rootList.children.some(visit);
        return found;
    }

    print(): string {
        const target: string[] = [];
        for (const child of this.rootList.children) child.print(target);
        return target.join('\n');
    }

    clone(): Root {
        const copy = new Root({ ...this.start }, { ...this.end }, this.getSelections());
        copy.rootList = this.rootList.clone(copy);
        return copy;
    }
}

export function recalculateNumericBullets(node: List | Root): void {
    let index = 1;
    for (const child of node.getChildren()) {
        if (/^\d+[.)]$/.test(child.getBullet())) child.replateBullet(`${index++}${child.getBullet().slice(-1)}`);
        recalculateNumericBullets(child);
    }
}

export function parseRange(source: ListSource, fromLine: number, toLine: number, stickCursor: CursorStickMode): Root[] {
    const roots: Root[] = [];
    for (let number = fromLine; number <= toLine; number++) {
        if (number === fromLine || isListItemLine(source.line(number))) {
            const root = parseList(source, number, fromLine, toLine, stickCursor);
            if (root) {
                roots.push(root);
                number = root.getContentEnd().line;
            }
        }
    }
    return roots;
}

export function parseList(source: ListSource, parsingStartLine: number, limitFrom: number,
    limitTo: number, stickCursor: CursorStickMode): Root | null {
    if (parsingStartLine < 1 || parsingStartLine > source.lastLine()) return null;
    const keepCheckbox = stickCursor === 'bullet-and-checkbox';
    const text = source.line(parsingStartLine);

    let lookingAt: number | null = null;
    if (isListItemLine(text)) {
        lookingAt = parsingStartLine;
    }
    else if (isIndentedLine(text)) {
        for (let search = parsingStartLine - 1; search >= limitFrom; search--) {
            const earlier = source.line(search);
            if (isListItemLine(earlier)) {
                lookingAt = search;
                break;
            }
            if (!isIndentedLine(earlier)) break;
        }
    }
    if (lookingAt === null) return null;

    let startLine: number | null = null;
    for (let search = lookingAt; search >= 1; search--) {
        const earlier = source.line(search);
        if (!isListItemLine(earlier) && !isIndentedLine(earlier)) break;
        if (bareListItemRe.test(earlier)) {
            startLine = search;
            if (search <= limitFrom) break;
        }
    }
    if (startLine === null) return null;

    let endLine = lookingAt;
    for (let search = lookingAt; search <= source.lastLine(); search++) {
        const later = source.line(search);
        if (!isListItemLine(later) && !isIndentedLine(later)) break;
        if (later.length > 0) endLine = search;
        if (search >= limitTo) {
            endLine = limitTo;
            break;
        }
    }
    if (startLine > parsingStartLine || endLine < parsingStartLine) return null;

    if (endLine > startLine) {
        const last = source.line(endLine);
        if (last.trim().length === 0 && !last.startsWith(leadingIndent(source.line(endLine - 1)))) endLine--;
    }

    const root = new Root({ line: startLine, ch: 0 }, { line: endLine, ch: source.line(endLine).length }, source.selections());
    const folded = new Set(source.foldedLines());
    let parent: List = root.getRootList();
    let current: List | null = null;
    let currentIndent = '';
    let depth = 0;

    for (let number = startLine; number <= endLine; number++) {
        const line = source.line(number);
        const match = parseItemRe.exec(line);
        if (match) {
            const indent = match[1]!;
            const bullet = match[2]!;
            const space = match[3]!;
            const checkbox = match[4] ?? '';
            const content = checkbox + (match[5] ?? '');

            const shared = Math.min(currentIndent.length, indent.length);
            if (indent.slice(0, shared) !== currentIndent.slice(0, shared)) return null;

            if (indent.length > currentIndent.length) {
                if (!current) return null;
                parent = current;
                currentIndent = indent;
                depth++;
                if (depth > MAX_LIST_DEPTH) return null;
            }
            else if (indent.length < currentIndent.length) {
                while (parent.getParent() && parent.getFirstLineIndent().length >= indent.length) {
                    parent = parent.getParent()!;
                    depth--;
                }
                currentIndent = indent;
            }

            current = new List(root, indent, bullet, keepCheckbox ? checkbox : '', space, content, folded.has(number));
            parent.addAfterAll(current);
            continue;
        }

        if (isIndentedLine(line)) {
            if (!current) return null;
            const run = indentRe.exec(line)![0];
            if (current.notesIndent === null) {
                if (run.length <= currentIndent.length && run.length !== line.length) return null;
                if (!line.startsWith(currentIndent)) return null;
                current.notesIndent = run;
            }
            if (!line.startsWith(current.notesIndent)) return null;
            current.addLine(line.slice(current.notesIndent.length));
            continue;
        }

        return null;
    }

    return root;
}
