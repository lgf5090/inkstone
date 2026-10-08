import { Facet, StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { parseWikiTarget, renderMarkdownBlocks, type Heading, type MarkdownBlock } from '../lib/markdown/renderer';
import { subscribeEmojiUnicode } from '../lib/emoji-unicode';
import { registerFenceBodies, type FenceBodies } from '../lib/markdown/fence-bodies';
import { enhancePreview, renderPendingCharts, renderPendingMermaid, toggleCodeBlockCollapse } from '../lib/markdown/enhance';
import { resolveNoteEmbeds } from '../lib/markdown/embeds';
import { useSession } from '../store/session';
import { buildPropertyRenderOptions } from '../lib/property-view';
import { t } from '../lib/i18n';
import { decodeDataValue } from '../lib/markdown/data-attr';
import { findNoteByTitle, useNotes } from '../store/notes';
import { useUi } from '../store/ui';
import { selectMarkdownTab, moveMarkdownTabFocus } from '../features/preview/markdown-tabs';
import { enhanceMediaLayouts } from '../features/preview/media-layout';
import { attachMediaLayoutHost } from '../features/preview/media-layout-drag';
import type { MediaSurface } from '../features/preview/media-layout-drag';
import type { MediaEdit } from '../lib/markdown/media-layout-source';

const focusChanged = StateEffect.define<boolean>();
const refresh = StateEffect.define<boolean>();

/**
 * What a rendered block calls when the reader right-clicks inside it. The host editor supplies it, so
 * the live surface and the source surface answer with one menu. `lineStart` is the source position the
 * rendered markup came from — the one thing coordinates cannot give for a widget, since the block's
 * pixels are not the document's characters.
 */
export type LiveBlockContextMenu = (event: MouseEvent, view: EditorView, lineStart: number) => void;

export const liveBlockContextMenu = Facet.define<LiveBlockContextMenu, LiveBlockContextMenu | null>({
    combine: (handlers) => handlers[0] ?? null,
});

/**
 * What a rendered block calls when the reader clicks or double-clicks a link inside it. The block owns
 * its own click handling — it folds the source back only for the caret, and it swallows event
 * forwarding — so the link editor has to be offered the gesture here rather than listening on the
 * editor's DOM. Returning true means the gesture was taken and the block should leave the caret alone.
 */
export type LiveLinkGesture = (event: MouseEvent, view: EditorView, target: HTMLElement, kind: 'click' | 'dblclick') => boolean;

export const liveLinkGesture = Facet.define<LiveLinkGesture, LiveLinkGesture | null>({
    combine: (handlers) => handlers[0] ?? null,
});

class RenderedBlock extends WidgetType {
    constructor(readonly block: MarkdownBlock, readonly source: string, readonly revision: number, readonly title: string, readonly fences: FenceBodies) { super(); }
    eq(other: RenderedBlock) {
        // The fence set is re-parsed only when the document is, so identity says whether this block's
        // board bodies are still the ones the host was registered with. Comparing by content instead
        // would walk every board on every keystroke, which is the cost the reparse idle window exists
        // to avoid; comparing not at all would keep a board showing the cards from before its edit.
        return this.block.html === other.block.html && this.block.startLine === other.block.startLine
            && this.block.endLine === other.block.endLine && this.revision === other.revision && this.title === other.title
            && this.fences === other.fences
            && (!this.block.html.includes('data-embed-target') || this.source === other.source);
    }
    toDOM(view: EditorView) {
        const host = document.createElement('div');
        host.className = 'ink-prose cm-live-block';
        host.dataset.font = useSession.getState().settings.appearance.proseFont;
        host.innerHTML = this.block.html;
        // A board's cards live in the render's fence set rather than in the markup, so this host has
        // to carry the set before anything asks the block what it holds.
        registerFenceBodies(host, this.fences);
        host.title = t('workspace.live_preview_hint');
        let alive = true;
        blockViews.set(host, view);
        const observer = getSharedBlockResizeObserver();
        observer.observe(host);
        const detachMediaHost = attachMediaLayoutHost(host, () => mediaSurfaceFor(view), true);
        cleanup.set(host, () => {
            alive = false;
            observer.unobserve(host);
            blockViews.delete(host);
            detachMediaHost();
        });
        const settings = useSession.getState().settings.preview;
        const dark = document.documentElement.dataset.theme === 'dark';
        const prepare = async () => {
            await resolveNoteEmbeds(host, { currentContent: this.source, currentTitle: this.title, isCurrent: () => alive });
            if (!alive) return;
            await enhancePreview(host, { math: settings.math, mermaid: settings.mermaid, chart: settings.chart, kanban: 'snapshot', mindmap: 'snapshot', dark, codeBlockCollapseLines: 0 });
            // A layout block is the one rendered block the reader edits with the pointer, so its settings
            // bar and its drag edges are built here too — on this host, which is the live tree.
            if (settings.mediaToolbar) enhanceMediaLayouts(host, { chart: settings.chart, mediaToolbar: true });
            if (alive && settings.mermaid) await renderPendingMermaid(host, dark, { isCurrent: () => alive });
            if (alive && settings.chart) await renderPendingCharts(host, dark);
            if (alive) view.requestMeasure();
        };
        void prepare().catch(() => { if (alive) view.requestMeasure(); });
        host.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            const checkbox = target.closest<HTMLInputElement>('input[data-task-line]');
            if (checkbox) {
                if (checkbox.disabled || checkbox.closest('.note-embed-body')) return;
                const n = Number(checkbox.dataset.taskLine) + 1;
                if (n > 0 && n <= view.state.doc.lines) {
                    const line = view.state.doc.line(n);
                    const match = /^(?:\s*>\s*)*\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]/.exec(line.text);
                    if (match) {
                        const pos = line.from + match[0].length - 2;
                        view.dispatch({ changes: { from: pos, to: pos + 1, insert: match[1] === ' ' ? 'x' : ' ' }, userEvent: 'input' });
                    }
                }
                return;
            }
            const collapse = target.closest<HTMLButtonElement>('[data-code-collapse]');
            if (collapse) { toggleCodeBlockCollapse(collapse); return; }
            const tab = target.closest<HTMLButtonElement>('[data-tab-button]');
            if (tab) { event.preventDefault(); selectMarkdownTab(tab); return; }
            const copy = target.closest<HTMLButtonElement>('[data-copy]');
            if (copy) {
                event.preventDefault();
                const code = copy.closest('.code-block')?.querySelector('pre')?.textContent ?? '';
                void navigator.clipboard?.writeText(code).then(() => useUi.getState().toast({ title: t('common.copied') }))
                    .catch(() => useUi.getState().toast({ title: t('preview.could_not_copy'), tone: 'danger' }));
                return;
            }
            if (target.closest('summary')) return;
            const wiki = target.closest<HTMLElement>('[data-wikilink]');
            if (wiki && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                const parsed = parseWikiTarget(decodeDataValue(wiki.dataset.wikilink));
                const note = findNoteByTitle(parsed.noteTitle);
                if (note) void useNotes.getState().openNote(note.id);
                else if (parsed.noteTitle) void useNotes.getState().createNote({ title: parsed.noteTitle });
                return;
            }
            if ((event.metaKey || event.ctrlKey) && target.closest('a[href]')) return;
            const gesture = view.state.facet(liveLinkGesture);
            if (gesture?.(event, view, target, 'click')) return;
            event.preventDefault();
            // Preserve the source line under the pointer, including rows inside tables/lists.
            const mapped = target.closest<HTMLElement>('[data-line]');
            const n = Math.max(this.block.startLine + 1, Math.min(this.block.endLine, Number(mapped?.dataset.line ?? this.block.startLine) + 1));
            const line = view.state.doc.line(Math.min(n, view.state.doc.lines));
            view.dispatch({ selection: { anchor: line.from }, effects: focusChanged.of(true), userEvent: 'select.pointer' });
            view.focus();
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos !== null && pos >= line.from && pos <= view.state.doc.line(Math.min(this.block.endLine, view.state.doc.lines)).to)
                view.dispatch({ selection: { anchor: pos }, userEvent: 'select.pointer' });
        });
        host.addEventListener('dblclick', (event) => {
            const target = event.target as HTMLElement;
            // A picture in a layout is there to be looked at: the reading view already opens the lightbox
            // on a click, and the live surface would otherwise only ever move the caret. It answers first
            // because a picture inside a link is both, and the reader aimed at the picture.
            if (target.closest?.('.markdown-media-cell')) {
                const image = target.closest('img') ?? target.closest('.markdown-media-cell')?.querySelector('img');
                if (image?.src) {
                    event.preventDefault();
                    useUi.getState().setLightbox({ src: image.src, alt: image.alt });
                    return;
                }
            }
            const gesture = view.state.facet(liveLinkGesture);
            gesture?.(event, view, target, 'dblclick');
        });
        host.addEventListener('keydown', (event) => {
            const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tab-button]');
            if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); moveMarkdownTabFocus(tab, event.key); }
        });
        host.addEventListener('contextmenu', (event) => {
            // A rendered block answers to neither of the two places the note menu is normally asked
            // for: this widget swallows event forwarding, and the markup under the pointer is rendered
            // output rather than source, so the menu has to be requested here or a right-click inside
            // a paragraph, a table row or a board falls through to the browser's own.
            const ask = view.state.facet(liveBlockContextMenu);
            if (!ask) return;
            const target = event.target as HTMLElement;
            const mapped = target.closest<HTMLElement>('[data-line]');
            let wanted = Math.max(this.block.startLine + 1, Math.min(this.block.endLine, Number(mapped?.dataset.line ?? this.block.startLine) + 1));
            // A rendered table stamps only the line it starts on, so the row under the pointer is read
            // from the table's own shape: the header line, then the delimiter row, then one line per
            // body row. Without this a row's menu would edit the header row instead.
            const row = target.closest('tr');
            if (row?.parentElement?.nodeName === 'TBODY') wanted += 2 + row.sectionRowIndex;
            ask(event, view, view.state.doc.line(Math.min(wanted, view.state.doc.lines)).from);
        });
        return host;
    }
    destroy(dom: HTMLElement) { cleanup.get(dom)?.(); cleanup.delete(dom); }
    ignoreEvent() { return true; }
}
const cleanup = new WeakMap<HTMLElement, () => void>();
const blockViews = new WeakMap<Element, EditorView>();

/**
 * The layout block's write path through the editor, rather than through the saved note.
 *
 * A line range becomes one CodeMirror change over exactly those lines, so a drag is a single undo step and
 * the caret, the selection and the search all keep their place — and the paragraph being resized is never
 * written from a document the page has not re-rendered yet, because the range is read back off the live
 * doc. A range that has run off the end is refused instead of guessed at.
 */
function mediaSurfaceFor(view: EditorView): MediaSurface {
    return {
        source: () => view.state.doc.toString(),
        commit: (edit: MediaEdit): boolean => {
            const doc = view.state.doc;
            const startLine = edit.start + 1;
            const endLine = edit.end + 1;
            if (startLine < 1 || endLine > doc.lines) return false;
            if (edit.end < edit.start) {
                const at = doc.line(Math.min(startLine, doc.lines)).from;
                view.dispatch({ changes: { from: at, insert: `${edit.lines.join('\n')}\n` }, userEvent: 'input.layout' });
                view.requestMeasure();
                return true;
            }
            const from = doc.line(startLine).from;
            const to = doc.line(endLine).to;
            view.dispatch({ changes: { from, to, insert: edit.lines.join('\n') }, userEvent: 'input.layout' });
            view.requestMeasure();
            return true;
        },
        replaceDocument: (next: string) => {
            const doc = view.state.doc;
            const head = view.state.selection.main.head;
            view.dispatch({
                changes: { from: 0, to: doc.length, insert: next },
                selection: { anchor: Math.min(head, next.length) },
                userEvent: 'input.layout',
                scrollIntoView: false,
            });
            view.requestMeasure();
        },
        toast: (title: string, tone?: 'default' | 'success' | 'warning' | 'danger') => useUi.getState().toast({ title, tone }),
    };
}
let sharedBlockResizeObserver: ResizeObserver | null = null;

function getSharedBlockResizeObserver(): ResizeObserver {
    if (!sharedBlockResizeObserver) {
        sharedBlockResizeObserver = new ResizeObserver((entries) => {
            const views = new Set<EditorView>();
            for (const entry of entries) {
                const view = blockViews.get(entry.target);
                if (view) views.add(view);
            }
            for (const view of views) {
                view.requestMeasure();
            }
        });
    }
    return sharedBlockResizeObserver;
}

interface LiveState {
    blocks: MarkdownBlock[];
    headings: Heading[];
    /** The fence bodies `blocks` were rendered from; a block's host is registered with this set. */
    fences: FenceBodies;
    decorations: DecorationSet;
    focused: boolean;
    revision: number;
}

/**
 * Reparsing the whole document costs tens to hundreds of ms on big notes, so the idle
 * window widens with the document instead of reparsing on every keystroke pause.
 */
function parseDelayFor(state: EditorState): number {
    if (state.doc.lines > 5000) return 600;
    if (state.doc.lines > 2000) return 250;
    return 90;
}

let docSourceCache: { doc: unknown; text: string } | null = null;

/** Text.toString() rebuilds the whole document, so reuse it while the doc is unchanged. */
function docSource(state: EditorState): string {
    if (docSourceCache && docSourceCache.doc === state.doc) return docSourceCache.text;
    const text = state.doc.toString();
    docSourceCache = { doc: state.doc, text };
    return text;
}

function decorate(state: EditorState, live: LiveState, title: string): DecorationSet {
    const ranges: Range<Decoration>[] = [];
    const hasEmbeds = live.blocks.some((b) => b.html.includes('data-embed-target'));
    const source = hasEmbeds ? docSource(state) : '';
    for (const block of live.blocks) {
        if (block.startLine >= state.doc.lines || block.endLine <= block.startLine) continue;
        const from = state.doc.line(block.startLine + 1).from;
        const to = state.doc.line(Math.min(block.endLine, state.doc.lines)).to;
        const active = state.selection.ranges.some((range) =>
            (live.focused || !range.empty) && range.from <= to && range.to >= from);
        if (active || from === to) continue;
        ranges.push(Decoration.replace({ block: true, widget: new RenderedBlock(block, source, live.revision, title, live.fences) }).range(from, to));
    }
    return Decoration.set(ranges, true);
}

function blockOptions(): { emojiShortcodes: boolean, properties: ReturnType<typeof buildPropertyRenderOptions> } {
    const session = useSession.getState().settings;
    return {
        emojiShortcodes: session.preview.emojiShortcodes,
        properties: buildPropertyRenderOptions(session.properties, useNotes.getState().tags),
    };
}

/** Decorations change presentation only; all editing, undo, search and saving use Markdown. */
export function livePreview(onHeadings: (headings: Heading[]) => void, getTitle: () => string = () => ''): Extension {
    const field = StateField.define<LiveState>({
        create(state) {
            const result = renderMarkdownBlocks(state.doc.toString(), blockOptions());
            const value: LiveState = { ...result, decorations: Decoration.none, focused: false, revision: 0 };
            value.decorations = decorate(state, value, getTitle());
            return value;
        },
        update(value, tr) {
            const focused = tr.effects.find((effect) => effect.is(focusChanged));
            const refreshed = tr.effects.find((effect) => effect.is(refresh));
            if (!tr.docChanged && !tr.selection && !focused && !refreshed) return value;
            // Keep typing synchronous and cheap. Reparse after a short idle window; never
            // display stale HTML for a block whose source was touched in the meantime.
            const mapped = tr.docChanged ? value.blocks.flatMap((block) => {
                const from = tr.startState.doc.line(block.startLine + 1).from;
                const to = tr.startState.doc.line(Math.min(block.endLine, tr.startState.doc.lines)).to;
                if (tr.changes.touchesRange(from, to)) return [];
                const startLine = tr.state.doc.lineAt(tr.changes.mapPos(from, 1)).number - 1;
                const delta = startLine - block.startLine;
                return [{ ...block, startLine,
                    html: delta ? block.html.replace(/(data-(?:task-)?line=")(\d+)(")/g, (_, before, line, after) => `${before}${Number(line) + delta}${after}`) : block.html,
                    endLine: tr.state.doc.lineAt(tr.changes.mapPos(to, -1)).number }];
            }) : value.blocks;
            const next = { ...value, blocks: mapped, ...(refreshed ? renderMarkdownBlocks(tr.state.doc.toString(), blockOptions()) : {}),
                focused: focused ? focused.value : value.focused, revision: value.revision + (refreshed?.value ? 1 : 0) };
            next.decorations = decorate(tr.state, next, getTitle());
            return next;
        },
        provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
    });
    return [field, ViewPlugin.fromClass(class {
        timer = 0;
        parseTimer = 0;
        observer: MutationObserver;
        unsubscribe: () => void;
        unsubscribeEmoji: () => void;
        constructor(readonly view: EditorView) {
            const refreshView = () => {
                window.clearTimeout(this.timer);
                this.timer = window.setTimeout(() => view.dispatch({ effects: refresh.of(true) }), 0);
            };
            this.observer = new MutationObserver(refreshView);
            this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'lang'] });
            this.unsubscribeEmoji = subscribeEmojiUnicode(refreshView);
            this.unsubscribe = useSession.subscribe((state, previous) => {
                if (state.settings.preview.emojiShortcodes !== previous.settings.preview.emojiShortcodes
                    || state.settings.preview.math !== previous.settings.preview.math
                    || state.settings.preview.mermaid !== previous.settings.preview.mermaid
                    || state.settings.preview.chart !== previous.settings.preview.chart
                    || state.settings.properties !== previous.settings.properties
                    || state.settings.preview.mediaToolbar !== previous.settings.preview.mediaToolbar
                    || state.settings.appearance.proseFont !== previous.settings.appearance.proseFont) refreshView();
            });
            queueMicrotask(() => { const value = view.state.field(field, false); if (value) onHeadings(value.headings); });
        }
        update(update: { docChanged: boolean; state: EditorState }) {
            if (update.docChanged) {
                clearTimeout(this.parseTimer);
                this.parseTimer = window.setTimeout(() => this.view.dispatch({ effects: refresh.of(false) }), parseDelayFor(update.state));
            }
            const headings = update.state.field(field).headings;
            queueMicrotask(() => { if (this.view.state.field(field, false)) onHeadings(headings); });
        }
        destroy() { clearTimeout(this.timer); clearTimeout(this.parseTimer); this.observer.disconnect(); this.unsubscribe(); this.unsubscribeEmoji(); }
    }), EditorView.domEventHandlers({
        focus(_event, view) { view.dispatch({ effects: focusChanged.of(true) }); },
        blur(_event, view) { view.dispatch({ effects: focusChanged.of(false) }); },
    }), EditorView.baseTheme({
        '.cm-live-strong': { fontWeight: '700' },
        '.cm-live-em': { fontStyle: 'italic' },
        '.cm-live-heading': { fontSize: '1.35em', fontWeight: '650' },
    }), ViewPlugin.fromClass(class {
        decorations: DecorationSet = Decoration.none;
        constructor(view: EditorView) { this.build(view); }
        update(update: { view: EditorView }) { this.build(update.view); }
        build(view: EditorView) {
            const ranges: Range<Decoration>[] = [];
            for (const { from, to } of view.visibleRanges) syntaxTree(view.state).iterate({ from, to, enter(node) {
                const cls = node.name === 'StrongEmphasis' ? 'cm-live-strong' : node.name === 'Emphasis' ? 'cm-live-em' : /^ATXHeading/.test(node.name) ? 'cm-live-heading' : '';
                if (cls) ranges.push(Decoration.mark({ class: cls }).range(node.from, node.to));
            } });
            this.decorations = Decoration.set(ranges, true);
        }
    }, { decorations: (plugin) => plugin.decorations })];
}
