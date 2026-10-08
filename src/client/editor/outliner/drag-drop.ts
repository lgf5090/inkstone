import { BlockType, Decoration, EditorView, PluginValue, ViewPlugin, type DecorationSet, type DOMEventHandlers, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Text } from '@codemirror/state';
import { foldEffect, unfoldEffect } from '@codemirror/language';
import { computeListFold, foldedRangeStartingAt } from './fold';
import { buildTransaction, parseRootAtLine, type OutlinerOptions } from './adapter';
import { outlinerOptionsChanged, readOutlinerOptions } from './commands';
import { MoveListToDifferentPosition } from './operations';
import type { List, Root } from './tree';

const BULLET_HANDLE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)((?:\[[ \tXx]\][ \t]+))?/;

const draggingLine = Decoration.line({ class: 'ink-outliner-dragging-line' });
const droppingLine = Decoration.line({ class: 'ink-outliner-dropping-line' });
const bulletMark = Decoration.mark({ class: 'ink-outliner-bullet' });
const TRAVEL_TO_START = 4;

export interface DragVisual {
    from: number;
    to: number;
    drop: number | null;
}

const dragStarted = StateEffect.define<{ from: number; to: number }>()
const dragMoved = StateEffect.define<number | null>()
const dragEnded = StateEffect.define<null>()

const dragVisualField = StateField.define<DragVisual | null>({
    create: () => null,
    update(value, transaction) {
        let next = value
        if (next && transaction.docChanged) {
            const from = transaction.changes.mapPos(next.from, 1)
            const to = transaction.changes.mapPos(next.to, -1)
            next = to > from ? { from, to, drop: next.drop === null ? null : transaction.changes.mapPos(next.drop, 1) } : null
        }
        for (const effect of transaction.effects) {
            if (effect.is(dragStarted)) next = { from: effect.value.from, to: effect.value.to, drop: null }
            if (effect.is(dragMoved) && next) next = { ...next, drop: effect.value }
            if (effect.is(dragEnded)) next = null
        }
        return next
    },
    provide: (field) => EditorView.decorations.from(field, (value) => (view: EditorView) => dragDecorations(value, view.state)),
})

/**
 * The drop line can sit above the dragged subtree, and a RangeSetBuilder refuses ranges that are not
 * ascending, so marks are collected by position first and the drop wins where both land.
 */
export function dragDecorations(value: DragVisual | null, state: EditorState): DecorationSet {
    if (!value) return Decoration.none
    const marks = new Map<number, Decoration>()
    const first = state.doc.lineAt(Math.min(value.from, state.doc.length)).number
    const last = Math.min(state.doc.lines, Math.max(first, state.doc.lineAt(Math.min(value.to, state.doc.length)).number))
    for (let number = first; number <= last; number++) marks.set(state.doc.line(number).from, draggingLine)
    if (value.drop !== null) marks.set(state.doc.lineAt(Math.min(value.drop, state.doc.length)).from, droppingLine)
    const builder = new RangeSetBuilder<Decoration>()
    for (const from of [...marks.keys()].sort((a, b) => a - b)) builder.add(from, from, marks.get(from)!)
    return builder.finish()
}

export const outlinerDragVisual: Extension = dragVisualField

interface DropVariant {
    where: 'before' | 'after' | 'inside';
    place: List;
    placeLine: number;
    anchorLine: number;
    indentLength: number;
    top: number;
    left: number;
}

interface Snapshot {
    root: Root;
    list: List;
    line: number;
    doc: Text;
}

export class DragController implements PluginValue {
    decorations: DecorationSet = Decoration.none;
    private zone: HTMLElement;
    private snapshot: Snapshot | null = null;
    private dragging = false;
    private pending: { x: number; y: number } | null = null;
    private variants: DropVariant[] = [];
    private nearest: DropVariant | null = null;
    private lastDrop: number | null = null;
    private moveHandler: ((event: MouseEvent) => void) | null = null;
    private upHandler: (() => void) | null = null;
    private keyHandler: ((event: KeyboardEvent) => void) | null = null;

    constructor(private view: EditorView) {
        this.zone = document.createElement('div');
        this.zone.className = 'ink-outliner-drop-zone';
        this.zone.setAttribute('aria-hidden', 'true');
        this.zone.style.display = 'none';
        this.view.dom.appendChild(this.zone);
        this.decorations = this.bulletMarks(view);
    }

    handleMouseDown(event: MouseEvent): boolean {
        if (this.pending || this.snapshot || event.button !== 0) return false;
        const options = readOutlinerOptions(this.view.state);
        if (!options?.enabled || !options.dragDrop) return false;
        const line = this.grabbedBulletLine(event);
        if (line === null) return false;
        const snapshot = this.capture(line, options);
        if (!snapshot) return false;
        this.snapshot = snapshot;
        this.pending = { x: event.clientX, y: event.clientY };
        event.preventDefault();
        this.listen();
        return true;
    }

    private grabbedBulletLine(event: MouseEvent): number | null {
        const position = this.view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
        if (position === null) return null;
        if (this.view.lineBlockAt(position).type !== BlockType.Text) return null;
        const line = this.view.state.doc.lineAt(position);
        const match = BULLET_HANDLE.exec(line.text);
        if (!match) return null;
        const start = match[1]!.length;
        const end = start + match[2]!.length + match[3]!.length + (match[4]?.length ?? 0);
        const offset = position - line.from;
        return offset >= start && offset < end ? line.number : null;
    }

    private capture(lineNumber: number, options: OutlinerOptions): Snapshot | null {
        const root = parseRootAtLine(this.view.state, options.stickCursor, lineNumber);
        const list = root?.getListUnderLine(lineNumber);
        if (!root || !list) return null;
        return { root, list, line: lineNumber, doc: this.view.state.doc };
    }

    update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged || update.geometryChanged
            || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(outlinerOptionsChanged)))) {
            this.decorations = this.bulletMarks(update.view);
        }
    }

    private bulletMarks(view: EditorView): DecorationSet {
        const options = readOutlinerOptions(view.state);
        if (!options?.enabled || !options.dragDrop) return Decoration.none;
        const ranges = [];
        for (const { from, to } of view.visibleRanges) {
            for (let number = view.state.doc.lineAt(from).number; number <= view.state.doc.lineAt(to).number; number++) {
                const line = view.state.doc.line(number);
                if (view.lineBlockAt(line.from).type !== BlockType.Text) continue;
                const match = BULLET_HANDLE.exec(line.text);
                if (!match) continue;
                const end = match[1]!.length + match[2]!.length + match[3]!.length + (match[4]?.length ?? 0);
                ranges.push(bulletMark.range(line.from + match[1]!.length, line.from + end));
            }
        }
        return Decoration.set(ranges, true);
    }

    private listen(): void {
        this.moveHandler = (event) => this.onMouseMove(event);
        this.upHandler = () => this.onMouseUp();
        this.keyHandler = (event) => {
            if (event.key === 'Escape') this.finish(false);
        };
        window.addEventListener('mousemove', this.moveHandler);
        window.addEventListener('mouseup', this.upHandler);
        window.addEventListener('keydown', this.keyHandler, true);
    }

    private unlisten(): void {
        if (this.moveHandler) window.removeEventListener('mousemove', this.moveHandler);
        if (this.upHandler) window.removeEventListener('mouseup', this.upHandler);
        if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler, true);
        this.moveHandler = this.upHandler = null;
        this.keyHandler = null;
    }

    private onMouseMove(event: MouseEvent): void {
        if (this.pending) {
            const travelled = Math.abs(event.clientX - this.pending.x) + Math.abs(event.clientY - this.pending.y);
            if (travelled < TRAVEL_TO_START) return;
            this.pending = null;
            this.beginDrag();
        }
        if (!this.variants.length) return;
        this.nearest = this.pickVariant(event.clientX, event.clientY);
        this.paint();
    }

    private beginDrag(): void {
        const options = readOutlinerOptions(this.view.state);
        if (!this.snapshot || !options) return;
        this.variants = collectVariants(this.snapshot.root, this.snapshot.list, options.indentChars);
        if (!this.variants.length) {
            this.finish(false);
            return;
        }
        this.view.contentDOM.classList.add('ink-outliner-dragging');
        const range = this.dragRange()
        if (range) {
            this.dragging = true
            this.view.dispatch({ effects: dragStarted.of(range) })
        }
    }

    private dragRange(): { from: number; to: number } | null {
        const snapshot = this.snapshot
        if (!snapshot) return null
        const state = this.view.state
        const first = snapshot.list.getFirstLineContentStart().line
        const last = Math.min(state.doc.lines, Math.max(first, snapshot.list.getContentEndIncludingChildren().line))
        return { from: state.doc.line(first).from, to: state.doc.line(last).to }
    }

    private pickVariant(x: number, y: number): DropVariant | null {
        const dom = this.view.dom.getBoundingClientRect();
        let best: DropVariant | null = null;
        for (const variant of this.variants) {
            if (!this.measure(variant, dom)) {
                variant.top = Number.NaN;
                continue;
            }
            if (!best || Math.abs(variant.top - (y - dom.top)) < Math.abs(best.top - (y - dom.top))) best = variant;
        }
        if (!best) return null;
        const row = this.variants.filter((variant) => Number.isFinite(variant.top) && Math.abs(variant.top - best!.top) <= 5);
        if (!row.length) return best;
        return row.reduce((nearest, variant) => Math.abs(variant.left - (x - dom.left)) < Math.abs(nearest.left - (x - dom.left)) ? variant : nearest, row[0]!);
    }

    private measure(variant: DropVariant, dom: DOMRect): boolean {
        const state = this.view.state;
        const number = Math.max(1, Math.min(variant.anchorLine, state.doc.lines));
        const line = state.doc.line(number);
        const block = this.view.lineBlockAt(line.from);
        if (block.type !== BlockType.Text) return false;
        const column = Math.min(variant.indentLength, line.length);
        const coords = this.view.coordsAtPos(line.from + column, variant.where === 'before' ? 1 : -1);
        if (!coords) return false;
        variant.left = coords.left - dom.left;
        variant.top = (variant.where === 'before' ? block.top : block.bottom) + this.view.documentTop - dom.top;
        return true;
    }

    private paint(): void {
        const drop = this.nearest;
        if (!drop) {
            this.zone.style.display = 'none';
            this.dispatchDrop(null);
            return;
        }
        const state = this.view.state
        const line = state.doc.line(Math.max(1, Math.min(drop.anchorLine, state.doc.lines)))
        this.dispatchDrop(line.from)
        const dom = this.view.dom.getBoundingClientRect();
        const content = this.view.contentDOM.getBoundingClientRect();
        this.zone.style.display = 'block';
        this.zone.style.top = `${Math.round(drop.top)}px`;
        this.zone.style.left = `${Math.round(drop.left)}px`;
        this.zone.style.width = `${Math.max(24, Math.round(content.right - dom.left - drop.left))}px`;
    }

    private dispatchDrop(offset: number | null): void {
        if (offset === this.lastDrop) return;
        this.lastDrop = offset;
        this.view.dispatch({ effects: dragMoved.of(offset) });
    }

    private onMouseUp(): void {
        this.finish(this.nearest !== null);
    }

    private finish(apply: boolean): void {
        const snapshot = this.snapshot;
        const drop = this.nearest;
        const dragging = this.dragging;
        this.pending = null;
        this.nearest = null;
        this.variants = [];
        this.snapshot = null;
        this.dragging = false;
        this.decorations = this.bulletMarks(this.view);
        this.lastDrop = null;
        if (dragging) this.view.dispatch({ effects: dragEnded.of(null) });
        this.zone.style.display = 'none';
        this.view.contentDOM.classList.remove('ink-outliner-dragging');
        this.unlisten();
        if (!apply || !drop || !snapshot) return;
        this.commit(snapshot, drop);
    }

    private commit(snapshot: Snapshot, drop: DropVariant): void {
        const options = readOutlinerOptions(this.view.state);
        const state = this.view.state;
        if (!options || state.doc !== snapshot.doc) return;
        const root = parseRootAtLine(state, options.stickCursor, snapshot.line);
        const moving = root?.getListUnderLine(snapshot.list.getFirstLineContentStart().line);
        const place = root?.getListUnderLine(drop.placeLine);
        if (!root || !moving || !place) return;
        const previous = root.clone();
        const operation = new MoveListToDifferentPosition(root, moving, place, drop.where, options.indentChars);
        operation.perform();
        if (!operation.shouldUpdate()) return;
        this.view.dispatch(buildTransaction(state, previous, root));
    }

    toggleFoldAtLineStart(lineStart: number): boolean {
        const options = readOutlinerOptions(this.view.state);
        if (!options?.enabled || options.guideClick !== 'fold') return false;
        const line = this.view.state.doc.lineAt(Math.max(0, Math.min(lineStart, this.view.state.doc.length)));
        const range = computeListFold(this.view.state, line.from, line.to);
        if (!range) return false;
        const open = foldedRangeStartingAt(this.view.state, range.from);
        this.view.dispatch({ effects: open ? unfoldEffect.of(open) : foldEffect.of(range), scrollIntoView: true });
        return true;
    }

    destroy(): void {
        this.finish(false);
        this.zone.remove();
    }
}

export const outlinerDragDrop: ViewPlugin<DragController> = ViewPlugin.fromClass(DragController, {
    decorations: (value) => value.decorations,
    eventHandlers: {
        mousedown(this: DragController, event: MouseEvent): boolean {
            return this.handleMouseDown(event);
        },
    } as DOMEventHandlers<DragController>,
});

function collectVariants(root: Root, moving: List, indentChars: string): DropVariant[] {
    const variants = new Map<string, DropVariant>();
    const lastLine = root.getContentEnd().line;
    const make = (where: DropVariant['where'], place: List, anchorLine: number, indentLength: number): DropVariant => {
        return { where, place, placeLine: place.getFirstLineContentStart().line, anchorLine, indentLength, top: Number.NaN, left: Number.NaN };
    };
    const add = (variant: DropVariant) => {
        if (variant.anchorLine < 1 || variant.anchorLine > lastLine + 1) return;
        variants.set(`${variant.anchorLine}:${variant.indentLength}:${variant.where}`, variant);
    };
    const visit = (lists: List[]) => {
        for (const place of lists) {
            const first = place.getFirstLineContentStart().line;
            const last = Math.max(first, place.getContentEndIncludingChildren().line);
            const indent = place.getFirstLineIndent().length;
            if (!contains(moving, place)) {
                add(make('before', place, first, indent));
                add(make('after', place, last, indent));
                if (place.isEmpty()) add(make('inside', place, last, indent + indentChars.length));
            }
            visit(place.getChildren());
        }
    };
    visit(root.getChildren());
    return [...variants.values()];
}

function contains(node: List, candidate: List): boolean {
    return node === candidate || node.getChildren().some((child) => contains(child, candidate));
}
