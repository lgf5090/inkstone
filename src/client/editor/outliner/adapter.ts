import { EditorSelection, Text, type EditorState, type TransactionSpec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { foldedListLines } from './fold';
import type { CursorStickMode, ListPos, ListSource, Root } from './tree';
import { parseList } from './tree';
import type { OutlinerOperation } from './operations';

export interface OutlinerOptions {
    enabled: boolean;
    enter: boolean;
    tab: boolean;
    shiftEnter: boolean;
    stickCursor: CursorStickMode;
    selectAll: boolean;
    moveKeys: boolean;
    foldKeys: boolean;
    guides: boolean;
    guideClick: 'none' | 'fold';
    dragDrop: boolean;
    indentChars: string;
}

const PROTECTED_NODES = /^(FencedCode|IndentedCodeBlock|CodeBlock|HTMLBlock|MathBlock|CommentBlock)$/;
const MATH_FENCE = /^[ \t]{0,3}\$\$[ \t]*$/;
const FRONT_MATTER_OPEN = /^---[ \t]*$/;
const FRONT_MATTER_CLOSE = /^(---|\.\.\.|===)[ \t]*$/;

export function offsetToPos(state: EditorState, offset: number): ListPos {
    const line = state.doc.lineAt(Math.max(0, Math.min(offset, state.doc.length)));
    return { line: line.number, ch: offset - line.from };
}

export function posToOffset(state: EditorState, pos: ListPos): number {
    const line = state.doc.line(Math.max(1, Math.min(pos.line, state.doc.lines)));
    return line.from + Math.max(0, Math.min(pos.ch, line.length));
}

/** Lines are memoised on demand: pre-building the array costs a pass over the whole note per command. */
export function stateListSource(state: EditorState): ListSource {
    const array: string[] = [];
    const line = (number: number): string => {
        const cached = array[number - 1];
        if (cached !== undefined) return cached;
        const text = number >= 1 && number <= state.doc.lines ? state.doc.line(number).text : '';
        array[number - 1] = text;
        return text;
    };
    return {
        line,
        lastLine: () => state.doc.lines,
        selections: () => state.selection.ranges.map((range) => ({
            anchor: offsetToPos(state, range.anchor),
            head: offsetToPos(state, range.head),
        })),
        foldedLines: () => foldedListLines(state),
    };
}

interface DocFacts {
    frontMatterEnd: number;
    mathFences: number[] | null;
}

/** A `Text` is immutable, so a document identity is enough to reuse the line scans done over it. */
const docFacts = new WeakMap<Text, DocFacts>();

function factsOf(doc: Text): DocFacts {
    let facts = docFacts.get(doc);
    if (!facts) {
        facts = { frontMatterEnd: 0, mathFences: null };
        if (FRONT_MATTER_OPEN.test(doc.line(1).text)) {
            let number = 2;
            for (const text of doc.iterLines(2, doc.lines + 1)) {
                if (FRONT_MATTER_CLOSE.test(text)) {
                    facts.frontMatterEnd = number;
                    break;
                }
                number++;
            }
        }
        docFacts.set(doc, facts);
    }
    return facts;
}

function mathFencesOf(doc: Text): number[] {
    const facts = factsOf(doc);
    if (!facts.mathFences) {
        const fences: number[] = [];
        let number = 1;
        for (const text of doc.iterLines(1, doc.lines + 1)) {
            if (MATH_FENCE.test(text)) fences.push(number);
            number++;
        }
        facts.mathFences = fences;
    }
    return facts.mathFences;
}

/**
 * A list written inside a fenced block, a display formula or the note's front matter is not a list the
 * outliner may rewrite: printing the tree back would overwrite the author's own text with the parser's
 * reading of it.
 */
export function rootIsProtected(state: EditorState, root: Root): boolean {
    const start = root.getContentStart().line;
    const end = root.getContentEnd().line;
    const frontMatter = factsOf(state.doc).frontMatterEnd;
    if (frontMatter && start <= frontMatter) return true;
    if (insideMathBlock(state.doc, start)) return true;
    const from = state.doc.line(start).from;
    const to = state.doc.line(end).to;
    let hit = false;
    syntaxTree(state).iterate({
        from,
        to,
        enter: (node) => {
            if (hit) return false;
            if (PROTECTED_NODES.test(node.name)) {
                hit = true;
                return false;
            }
            return true;
        },
    });
    return hit;
}

/** `$$` on a line of its own opens a formula, and an unclosed one runs to the end of the note. */
function insideMathBlock(doc: Text, line: number): boolean {
    const fences = mathFencesOf(doc);
    let low = 0;
    let high = fences.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (fences[middle]! < line) low = middle + 1;
        else high = middle;
    }
    return low % 2 === 1;
}

export function parseRootAtLine(state: EditorState, stickCursor: CursorStickMode, line: number): Root | null {
    const source = stateListSource(state);
    const root = parseList(source, line, 1, source.lastLine(), stickCursor);
    if (!root || rootIsProtected(state, root)) return null;
    return root;
}

export interface OutlinerRun {
    handled: boolean;
    spec: TransactionSpec | null;
}

export function runOperation(
    state: EditorState,
    options: OutlinerOptions,
    build: (root: Root, options: OutlinerOptions) => OutlinerOperation,
): OutlinerRun {
    if (!options.enabled) return { handled: false, spec: null };
    const root = parseRootAtLine(state, options.stickCursor, state.doc.lineAt(state.selection.main.head).number);
    if (!root) return { handled: false, spec: null };

    const previous = root.clone();
    const operation = build(root, options);
    operation.perform();
    if (!operation.shouldUpdate()) return { handled: operation.shouldStopPropagation(), spec: null };
    return { handled: true, spec: buildTransaction(state, previous, root) };
}

export function buildTransaction(state: EditorState, previous: Root, next: Root): TransactionSpec {
    const [start, end] = previous.getContentRange();
    const rootFrom = posToOffset(state, start);
    const rootTo = Math.max(rootFrom, posToOffset(state, end));
    const oldText = state.doc.sliceString(rootFrom, rootTo);
    const newText = next.print();

    if (oldText === newText) {
        return { selection: mapSelections(state.doc, next) };
    }

    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const shortest = Math.min(oldLines.length, newLines.length);

    let head = 0;
    while (head + 1 < shortest && oldLines[head] === newLines[head]) head++;
    let tail = 0;
    while (head + tail + 1 < shortest
        && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++;

    const changedFrom = oldLines.slice(0, head).reduce((offset, line) => offset + line.length + 1, rootFrom);
    const oldChanged = oldLines.slice(head, oldLines.length - tail).join('\n');
    const insert = newLines.slice(head, newLines.length - tail).join('\n');
    const changes = { from: changedFrom, to: changedFrom + oldChanged.length, insert };
    const doc = state.changes(changes).apply(state.doc);

    return { changes, selection: mapSelections(doc, next), userEvent: 'input', scrollIntoView: true };
}

function mapSelections(doc: Text, next: Root) {
    return EditorSelection.create(next.getSelections().map((range) => EditorSelection.range(
        posToDocOffset(doc, range.anchor),
        posToDocOffset(doc, range.head),
    )));
}

function posToDocOffset(doc: Text, pos: ListPos): number {
    const line = doc.line(Math.max(1, Math.min(pos.line, doc.lines)));
    return line.from + Math.max(0, Math.min(pos.ch, line.length));
}
