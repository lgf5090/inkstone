import { foldService, foldedRanges } from '@codemirror/language';
import type { EditorState, Text } from '@codemirror/state';

const LIST_LINE = /^([ \t]*)(?:[-*+]|\d+[.)])([ \t])/;
const ATTACHED = /^[ \t]/;

export interface ListFoldRange {
    from: number;
    to: number;
}

interface FoldFacts {
    subtreeEnds: Int32Array;
}

const foldFacts = new WeakMap<Text, FoldFacts>();

/**
 * The fold gutter asks about every line in the viewport, and an item's subtree can run to the end of the
 * note, so scanning per question costs a document walk per visible line. One pass answers all of them.
 */
function subtreeEndsOf(doc: Text): Int32Array {
    let facts = foldFacts.get(doc);
    if (!facts) {
        facts = { subtreeEnds: buildSubtreeEnds(doc) };
        foldFacts.set(doc, facts);
    }
    return facts.subtreeEnds;
}

function buildSubtreeEnds(doc: Text): Int32Array {
    const ends = new Int32Array(doc.lines + 2);
    const open: number[] = [];
    const indents: number[] = [];
    let last = 0;
    const close = (): void => {
        while (open.length) {
            const line = open.pop()!;
            indents.pop();
            if (last > line) ends[line] = last;
        }
    };
    let number = 1;
    for (const text of doc.iterLines(1, doc.lines + 1)) {
        if (text.length === 0) {
            number++;
            continue;
        }
        const match = LIST_LINE.exec(text);
        if (match) {
            const indent = match[1]!.length;
            while (open.length && indents[indents.length - 1]! >= indent) {
                const line = open.pop()!;
                indents.pop();
                if (last > line) ends[line] = last;
            }
            open.push(number);
            indents.push(indent);
            last = number;
        }
        else if (ATTACHED.test(text)) last = number;
        else close();
        number++;
    }
    close();
    return ends;
}

/** The last line that belongs to the item at `lineNumber`, or null when it has no children. */
export function listSubtreeEnd(state: EditorState, lineNumber: number): number | null {
    if (lineNumber < 1 || lineNumber > state.doc.lines) return null;
    if (!LIST_LINE.test(state.doc.line(lineNumber).text)) return null;
    const end = subtreeEndsOf(state.doc)[lineNumber] ?? 0;
    return end > lineNumber ? end : null;
}

export function computeListFold(state: EditorState, lineStart: number, lineEnd: number): ListFoldRange | null {
    const line = state.doc.lineAt(lineStart);
    if (line.from !== lineStart || line.to !== lineEnd) return null;
    if (!LIST_LINE.test(line.text)) return null;
    const last = listSubtreeEnd(state, line.number);
    if (last === null) return null;
    return { from: line.to, to: state.doc.line(last).to };
}

export const listFoldService = foldService.of(computeListFold);

export function foldedListLines(state: EditorState): number[] {
    const lines: number[] = [];
    foldedRanges(state).between(0, state.doc.length, (from) => {
        lines.push(state.doc.lineAt(from).number);
    });
    return lines;
}

export function foldedRangeStartingAt(state: EditorState, lineEnd: number): ListFoldRange | null {
    let found: ListFoldRange | null = null;
    foldedRanges(state).between(lineEnd, lineEnd, (from, to) => {
        if (!found || found.from > from) found = { from, to };
    });
    return found;
}
