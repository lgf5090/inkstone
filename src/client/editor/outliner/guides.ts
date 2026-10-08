import { BlockType, EditorView, PluginValue, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { readOutlinerOptions, outlinerOptionsChanged } from './commands';
import { stateListSource } from './adapter';
import { outlinerDragDrop, type DragController } from './drag-drop';
import { parseRange, type List } from './tree';

const BAR_CLASS = 'ink-outliner-guide';
const HIT_WIDTH = 8;

interface Guide {
    top: number;
    left: number;
    height: number;
    lineStart: number;
}

class GuideLayer implements PluginValue {
    private layer: HTMLElement;
    private inner: HTMLElement;
    private bars: HTMLElement[] = [];
    private timer = 0;
    private guides: Guide[] = [];

    constructor(private view: EditorView) {
        this.layer = document.createElement('div');
        this.layer.className = 'ink-outliner-guide-layer';
        this.inner = document.createElement('div');
        this.inner.className = 'ink-outliner-guide-inner';
        this.layer.append(this.inner);
        this.view.dom.appendChild(this.layer);
        this.view.scrollDOM.addEventListener('scroll', this.onScroll);
        this.layer.addEventListener('mousedown', this.onBarMouseDown);
        this.schedule();
    }

    /** The layer lives beside the editable content, so CodeMirror's own handlers never see its presses. */
    private onBarMouseDown = (event: MouseEvent): void => {
        if (this.handleMouseDown(event, this.view)) event.preventDefault();
    };

    private offsetY(): number {
        return this.view.documentTop - this.view.dom.getBoundingClientRect().top;
    }

    private onScroll = (): void => {
        this.inner.style.transform = `translateY(${this.offsetY()}px)`;
    };

    update(update: ViewUpdate): void {
        if (update.viewportChanged || update.geometryChanged || update.docChanged || update.selectionSet
            || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(outlinerOptionsChanged)))) this.schedule();
    }

    private schedule(): void {
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(this.draw, 0);
    }

    private draw = (): void => {
        const options = readOutlinerOptions(this.view.state);
        this.layer.dataset.action = options?.enabled && options.guideClick === 'fold' ? 'fold' : 'none';
        this.guides = this.collect();
        this.render();
    };

    private collect(): Guide[] {
        const options = readOutlinerOptions(this.view.state);
        const guides: Guide[] = [];
        if (!options?.enabled || !options.guides) return guides;
        const state = this.view.state;
        const source = stateListSource(state);
        const left = this.view.dom.getBoundingClientRect().left;
        for (const { from, to } of this.view.visibleRanges) {
            const first = state.doc.lineAt(from).number;
            const last = state.doc.lineAt(to).number;
            for (const root of parseRange(source, first, last, options.stickCursor)) {
                const endLine = root.getContentEnd().line;
                for (const child of root.getChildren()) this.walk(child, endLine, guides, left);
            }
        }
        return guides.sort((a, b) => a.top - b.top || a.left - b.left);
    }

    private nextSibling(list: List): List | null {
        let node = list;
        let parent = node.getParent();
        while (parent) {
            const sibling = parent.getNextSiblingOf(node);
            if (sibling) return sibling;
            node = parent;
            parent = node.getParent();
        }
        return null;
    }

    private walk(list: List, endLine: number, guides: Guide[], left: number): void {
        const children = list.getChildren();
        if (!children.length) return;
        const bar = this.barFor(list, children[0]!, endLine, left);
        if (bar) guides.push(bar);
        for (const child of children) if (!child.isEmpty()) this.walk(child, endLine, guides, left);
    }

    private barFor(list: List, firstChild: List, endLine: number, left: number): Guide | null {
        const view = this.view;
        const state = view.state;
        const sibling = this.nextSibling(list);
        const fromLine = firstChild.getFirstLineContentStart().line;
        const toLine = Math.min(sibling ? sibling.getFirstLineContentStart().line - 1 : endLine, list.getContentEndIncludingChildren().line);
        if (toLine < fromLine || toLine > state.doc.lines) return null;

        const start = state.doc.line(fromLine).from;
        const end = state.doc.line(toLine).from;
        if (view.lineBlockAt(start).type !== BlockType.Text || view.lineBlockAt(end).type !== BlockType.Text) return null;

        const coords = view.coordsAtPos(start + list.getFirstLineIndent().length);
        if (!coords) return null;
        const top = view.lineBlockAt(start).top;
        const height = view.lineBlockAt(end).bottom - top;
        if (height <= 0) return null;
        return { top, left: Math.round(coords.left - left), height, lineStart: state.doc.line(list.getFirstLineContentStart().line).from };
    }

    private render(): void {
        while (this.bars.length < this.guides.length) {
            const bar = document.createElement('div');
            bar.className = BAR_CLASS;
            this.inner.appendChild(bar);
            this.bars.push(bar);
        }
        for (const [index, bar] of this.bars.entries()) {
            const guide = this.guides[index];
            if (!guide) {
                bar.style.display = 'none';
                continue;
            }
            bar.dataset.lineStart = String(guide.lineStart);
            bar.style.cssText = `display:block;top:${guide.top}px;left:${guide.left}px;height:${guide.height}px;width:${HIT_WIDTH}px`;
        }
        this.inner.style.transform = `translateY(${this.offsetY()}px)`;
    }

    /**
     * A press on a guide means the guide, never the text beside it: the band is where the user asks
     * to fold, and the drag controller would otherwise read the same press as a grab on the bullet.
     */
    handleMouseDown(event: MouseEvent, view: EditorView): boolean {
        const target = event.target as HTMLElement | null;
        if (!target?.classList.contains(BAR_CLASS)) return false;
        const drag = view.plugin(outlinerDragDrop) as DragController | null;
        event.preventDefault();
        event.stopPropagation();
        const raw = target.dataset.lineStart;
        if (!raw) return true;
        drag?.toggleFoldAtLineStart(Number(raw));
        return true;
    }

    destroy(): void {
        window.clearTimeout(this.timer);
        this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
        this.layer.remove();
    }
}

export const outlinerGuides = ViewPlugin.fromClass(GuideLayer);
