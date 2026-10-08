import { EditorSelection, EditorState, Facet, Prec, StateEffect, type Extension } from '@codemirror/state';
import { foldEffect, foldedRanges, unfoldEffect } from '@codemirror/language';
import { PluginValue, ViewPlugin, keymap, type Command, type DOMEventHandlers, type EditorView } from '@codemirror/view';
import { computeListFold, foldedRangeStartingAt } from './fold';
import { offsetToPos, parseRootAtLine, runOperation, type OutlinerOptions } from './adapter';
import type { List, Root } from './tree';
import {
    CreateNewItem,
    DeleteTillCurrentLineContentStart,
    DeleteTillNextLineContentStart,
    DeleteTillPreviousLineContentEnd,
    IndentList,
    KeepCursorWithinListContent,
    MoveCursorToPreviousUnfoldedLine,
    MoveListDown,
    MoveListUp,
    OutdentList,
    OutdentListIfItsEmpty,
    SelectAllContent,
    type OutlinerOperation,
} from './operations';

export type OutlinerOptionsReader = () => OutlinerOptions;
export type OutlinerGate = (options: OutlinerOptions) => boolean;

/**
 * The options arrive through a reader, so nothing in the state changes when a switch flips; a plugin
 * that paints from them would keep the last picture forever. The host dispatches this after it has
 * written the new settings into the reader.
 */
export const outlinerOptionsChanged = StateEffect.define<null>();

export const outlinerOptions = Facet.define<OutlinerOptionsReader, OutlinerOptionsReader | null>({
    combine: (readers) => (readers.length ? readers[readers.length - 1]! : null),
});

export function readOutlinerOptions(state: EditorState): OutlinerOptions | null {
    return state.facet(outlinerOptions)?.() ?? null;
}

const enabled: OutlinerGate = (options) => options.enabled;
const stickGate: OutlinerGate = (options) => options.enabled && options.stickCursor !== 'never';
const tabGate: OutlinerGate = (options) => options.enabled && options.tab;
const enterGate: OutlinerGate = (options) => options.enabled && options.enter;
const selectGate: OutlinerGate = (options) => options.enabled && options.selectAll;
const moveGate: OutlinerGate = (options) => options.enabled && options.moveKeys;
const foldGate: OutlinerGate = (options) => options.enabled && options.foldKeys;

const ZONE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(?:\[[ \tXx]\][ \t]+)?/;
const INDENT = /^[ \t]*/;
const CHECKBOX_WIDTH = 4;

/**
 * Parsing a root costs as much as the list it covers is long, so a caret that is nowhere near the
 * bullet, checkbox or indent gutter of its own line cannot be moved by the stick rules: the width here
 * is the widest prefix this line could own, and callers only add the checkbox a parent line carries.
 */
function zoneWidth(text: string): number {
    const matched = ZONE.exec(text);
    if (matched) return matched[0].length;
    return INDENT.exec(text)![0].length;
}

function nearZone(state: EditorState, offset: number, extra: number): boolean {
    const line = state.doc.lineAt(offset);
    return offset - line.from <= zoneWidth(line.text) + extra;
}

class CompositionWatch implements PluginValue {
    composing = false;
}

export const outlinerComposition: ViewPlugin<CompositionWatch> = ViewPlugin.fromClass(CompositionWatch, {
    eventHandlers: {
        compositionstart(this: CompositionWatch) {
            this.composing = true;
        },
        compositionend(this: CompositionWatch) {
            this.composing = false;
        },
    } as DOMEventHandlers<CompositionWatch>,
});

/**
 * The outliner must not rewrite a line while an input method is still building a word out of the
 * same keystrokes. `view.composing` only turns on after the first composed character, so the editor
 * keeps its own count from the moment composition starts.
 */
function isComposing(view: EditorView): boolean {
    return view.composing || (view.plugin(outlinerComposition)?.composing ?? false);
}

function listCommand(
    build: (root: Root, options: OutlinerOptions) => OutlinerOperation,
    gate: OutlinerGate = enabled,
    zoneExtra: number | null = null,
): Command {
    return (view) => {
        const options = readOutlinerOptions(view.state);
        if (!options || !gate(options) || isComposing(view)) return false;
        if (zoneExtra !== null && !nearZone(view.state, view.state.selection.main.head, zoneExtra)) return false;
        const run = runOperation(view.state, options, build);
        if (!run.handled) return false;
        if (run.spec) view.dispatch(run.spec);
        return true;
    };
}

function when(gate: OutlinerGate, command: Command): Command {
    return (view) => {
        const options = readOutlinerOptions(view.state);
        return options && gate(options) ? command(view) : false;
    };
}

export const outlinerIndentItem: Command = listCommand((root, options) => new IndentList(root, options.indentChars));
export const outlinerOutdentItem: Command = listCommand((root) => new OutdentList(root));
export const outlinerMoveItemUp: Command = listCommand((root) => new MoveListUp(root));
export const outlinerMoveItemDown: Command = listCommand((root) => new MoveListDown(root));
export const outlinerOutdentEmptyItem: Command = listCommand((root) => new OutdentListIfItsEmpty(root));
export const outlinerCreateItem: Command = listCommand((root, options) => new CreateNewItem(root, options.indentChars, true));
export const outlinerTab = when(tabGate, outlinerIndentItem);
export const outlinerShiftTab = when(tabGate, outlinerOutdentItem);
export const outlinerMoveUp = when(moveGate, outlinerMoveItemUp);
export const outlinerMoveDown = when(moveGate, outlinerMoveItemDown);

const outlinerEnterChain: Command = (view) => outlinerOutdentEmptyItem(view) || outlinerCreateItem(view);
export const outlinerEnter: Command = when(enterGate, outlinerEnterChain);

export const outlinerBackspace = when(stickGate, listCommand((root) => new DeleteTillPreviousLineContentEnd(root)));
export const outlinerDelete = when(stickGate, listCommand((root) => new DeleteTillNextLineContentStart(root)));
export const outlinerDeleteToLineStart = when(stickGate, listCommand((root) => new DeleteTillCurrentLineContentStart(root)));
export const outlinerSelectListItem = when(selectGate, listCommand((root) => new SelectAllContent(root)));
export const outlinerCursorToPrevious = when(stickGate, listCommand((root, options) => new MoveCursorToPreviousUnfoldedLine(root, options.stickCursor), stickGate, CHECKBOX_WIDTH));

export const outlinerNoteLine: Command = (view) => {
    const options = readOutlinerOptions(view.state);
    if (!options || !options.enabled || !options.shiftEnter || isComposing(view)) return false;

    const state = view.state;
    const range = state.selection.main;
    if (!range.empty || state.selection.ranges.length !== 1) return false;

    const root = parseRootAtLine(state, options.stickCursor, state.doc.lineAt(range.head).number);
    const list = root?.getListUnderCursor();
    if (!list) return false;

    const line = state.doc.lineAt(range.head);
    if (range.head < line.from + list.contentStartCh() + list.getCheckboxLength()) return false;

    const insert = `\n${list.getNotesIndent() ?? continuationIndent(list)}`;
    view.dispatch({
        changes: { from: range.head, insert },
        selection: EditorSelection.cursor(range.head + insert.length),
        scrollIntoView: true,
        userEvent: 'input',
    });
    return true;
};

function continuationIndent(list: List): string {
    return list.getFirstLineIndent() + ' '.repeat(list.getBullet().length + list.getSpaceAfterBullet().length);
}

export const outlinerFoldItem: Command = (view) => {
    const options = readOutlinerOptions(view.state);
    if (!options?.enabled) return false;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const range = computeListFold(view.state, line.from, line.to);
    if (!range || foldedRangeStartingAt(view.state, range.from)) return false;
    view.dispatch({ effects: foldEffect.of(range), scrollIntoView: true, userEvent: 'select' });
    return true;
};

export const outlinerUnfoldItem: Command = (view) => {
    const options = readOutlinerOptions(view.state);
    if (!options?.enabled) return false;
    const open = foldedRangeStartingAt(view.state, view.state.doc.lineAt(view.state.selection.main.head).to);
    if (!open) return false;
    view.dispatch({ effects: unfoldEffect.of(open), scrollIntoView: true, userEvent: 'select' });
    return true;
};

export const outlinerUnfoldAll: Command = (view) => {
    const options = readOutlinerOptions(view.state);
    if (!options?.enabled) return false;
    const ranges: { from: number; to: number }[] = [];
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
        ranges.push({ from, to });
    });
    if (!ranges.length) return false;
    view.dispatch({ effects: ranges.map((range) => unfoldEffect.of(range)), scrollIntoView: true, userEvent: 'select' });
    return true;
};

export const outlinerFoldKey: Command = when(foldGate, outlinerFoldItem);
export const outlinerUnfoldKey: Command = when(foldGate, outlinerUnfoldItem);

export const outlinerKeymap: Extension = Prec.highest(keymap.of([
    { key: 'Shift-Enter', run: when(enabled, outlinerNoteLine) },
    { key: 'Backspace', run: outlinerBackspace },
    { key: 'Delete', run: outlinerDelete },
    { key: 'Mod-Backspace', run: outlinerDeleteToLineStart },
    { key: 'Mod-a', run: outlinerSelectListItem },
    { key: 'ArrowLeft', run: outlinerCursorToPrevious },
    { win: 'Mod-ArrowLeft', linux: 'Mod-ArrowLeft', run: outlinerCursorToPrevious },
]));

export const outlinerCursorGuard: Extension = EditorState.transactionFilter.of((transaction) => {
    if (!transaction.selection || transaction.docChanged) return transaction;
    const options = readOutlinerOptions(transaction.state);
    if (!options?.enabled || options.stickCursor === 'never') return transaction;
    const selection = clampSelection(transaction.state, options);
    return selection ? [transaction, { selection }] : transaction;
});

function clampSelection(state: EditorState, options: OutlinerOptions) {
    let changed = false;
    const ranges = state.selection.ranges.map((range) => {
        if (!range.empty) return range;
        const offset = clampCursor(state, options, range.head);
        if (offset === null || offset === range.head) return range;
        changed = true;
        return EditorSelection.cursor(offset);
    });
    return changed ? EditorSelection.create(ranges) : null;
}

function clampCursor(state: EditorState, options: OutlinerOptions, offset: number): number | null {
    if (!nearZone(state, offset, 0)) return null;
    const pos = offsetToPos(state, offset);
    const root = parseRootAtLine(state, options.stickCursor, pos.line);
    if (!root) return null;
    root.replaceSelections([{ anchor: pos, head: pos }]);

    const within = new KeepCursorWithinListContent(root, options.stickCursor);
    within.perform();
    if (!within.shouldUpdate()) return null;

    const target = root.getCursor();
    const line = state.doc.line(Math.max(1, Math.min(target.line, state.doc.lines)));
    return line.from + Math.max(0, Math.min(target.ch, line.length));
}
