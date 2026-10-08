import { useEffect, useRef, useState } from 'react';
import { Annotation, Compartment, EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, keymap, lineNumbers, placeholder as placeholderExt, rectangularSelection, } from '@codemirror/view';
import { foldGutter, indentOnInput, indentUnit, } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { EditorSettings } from '@shared/types';
import { cn } from '../lib/cn';
import { useThemeDark } from '../lib/hooks';
import { editorTheme } from './theme';
import { focusModePlugin, markdownDecorations, setFocusMode, typewriterPlugin } from './decorations';
import { codeFenceSource, emojiSource, containerDirectiveSource, tagSource, wikiLinkSource, type CompletionSources } from './completion';
import { pasteExtension, type PasteHandlers } from './paste';
import { completeCodeFenceOnEnter, completeColonFenceOnEnter, getActiveEditorView, setActiveEditorView, smartEnter, tableTab } from './commands';
import { editorKeymap } from './shortcuts';
import { liveBlockContextMenu, liveLinkGesture, livePreview } from './live-preview';
import { linkHoverExtension, linkHoverFacet } from './link-hover-plugin';
import { runRenderedLinkGesture, runSourceLinkGesture } from '../features/links/use-link-editor';
import { registerLinkEditorNote } from '../features/links/store';
import type { EditorContext } from '../features/workspace/context-menu/types';
import { detectEditorContext } from '../features/workspace/context-menu/detect-editor';
import { takePendingEditorCursor } from '../store/new-note';
import { WikiLinkHoverCard } from '../features/preview/wiki-link-hover-card';
import { useLinkHoverHost } from '../features/preview/link-hover-host';
import { TagContextMenuAt, tagMenuRequestFrom, type TagMenuRequest } from '../features/tags/TagContextMenuAt';
import { useLongPress } from '../features/workspace/context-menu/use-long-press';
import type { Heading } from '../lib/markdown/renderer';
import { t } from "../lib/i18n";

const externalValueUpdate = Annotation.define<boolean>();
export interface CodeEditorProps {
    value: string;
    live?: boolean;
    noteId?: string;
    noteTitle?: string;
    onHeadings?: (headings: Heading[]) => void;
    onChange: (value: string) => void;
    settings: EditorSettings;
    sources: CompletionSources;
    handlers: PasteHandlers;
    onReady?: (view: EditorView | null) => void;
    onScroll?: (view: EditorView) => void;
    onCursorLine?: (line: number) => void;
    /** Ask the host to open the note's context menu at a pointer position. */
    onRequestContextMenu?: (request: { x: number; y: number; editor: EditorContext }) => void;
    placeholder?: string;
    className?: string;
}
export function DeferredCodeEditor({ visible, ...props }: CodeEditorProps & { visible: boolean }) {
    const [initialized, setInitialized] = useState(visible);
    useEffect(() => {
        if (visible) setInitialized(true);
    }, [visible]);
    // Preserve undo history across mode changes once editing has started.
    return visible || initialized ? <CodeEditor {...props}/> : null;
}
export function CodeEditor({ value, live = false, noteId, noteTitle = '', onHeadings, onChange, settings, sources, handlers, onReady, onScroll, onCursorLine, onRequestContextMenu, placeholder = t("editor.start_writing"), className, }: CodeEditorProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    const [tagMenu, setTagMenu] = useState<TagMenuRequest | null>(null);
    const tagMenuRef = useRef<(request: TagMenuRequest | null) => void>(() => {});
    tagMenuRef.current = setTagMenu;
    const viewRef = useRef<EditorView | null>(null);

    const cbRef = useRef({ onChange, onScroll, onCursorLine, sources, handlers, onHeadings, noteTitle, onRequestContextMenu });
    cbRef.current = { onChange, onScroll, onCursorLine, sources, handlers, onHeadings, noteTitle, onRequestContextMenu };
    const { hover, handlePin } = useLinkHoverHost(noteId ?? null);
    const longPress = useLongPress((point, target) => {
        const tag = tagMenuRequestFrom(target, point.x, point.y);
        if (tag) {
            tagMenuRef.current(tag);
            return;
        }
        const view = viewRef.current;
        const ask = cbRef.current.onRequestContextMenu;
        if (!view || !ask) return;
        const pos = view.posAtCoords(point) ?? view.state.selection.main.head;
        ask({ x: point.x, y: point.y, editor: detectEditorContext(view.state, pos) });
    });
    const dark = useThemeDark();
    const hoverRef = useRef({ propose: hover.propose, card: hover.card, hideNow: hover.hideNow });
    hoverRef.current = { propose: hover.propose, card: hover.card, hideNow: hover.hideNow };

    const longPressRef = useRef(longPress);
    longPressRef.current = longPress;
    // One menu for both places a right-click can land: the editor's own DOM answers through
    // `domEventHandlers`, and a rendered block — which swallows event forwarding and whose pixels are
    // not characters — asks us directly with the source line it was rendered from.
    const contextMenuRef = useRef<(event: MouseEvent, view: EditorView, lineStart?: number) => boolean>(() => false);
    contextMenuRef.current = (event, view, lineStart) => {
        // A tag keeps its own menu: it is the one span the source editor decorates with a datum, and
        // the menu that reads that datum is already wired on both panes.
        const request = tagMenuRequestFrom(event.target, event.clientX, event.clientY);
        if (request) {
            event.preventDefault();
            tagMenuRef.current(request);
            return true;
        }
        const ask = cbRef.current.onRequestContextMenu;
        if (!ask) return false;
        if (longPressRef.current.justLongPressed()) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? lineStart ?? view.state.selection.main.head;
        ask({ x: event.clientX, y: event.clientY, editor: detectEditorContext(view.state, pos) });
        return true;
    };
    const liveCompartment = useRef(new Compartment());
    const linkRef = useRef({ settings, noteId });
    linkRef.current = { settings, noteId };
    const linkGestureRef = useRef<(event: MouseEvent, view: EditorView, target: HTMLElement, kind: 'click' | 'dblclick') => boolean>(() => false);
    linkGestureRef.current = (event, view, target, kind) => {
        const current = linkRef.current;
        if (!current.noteId) return false;
        return runRenderedLinkGesture(event, view, target, kind, current.settings, current.noteId);
    };
    const lineNumbersCompartment = useRef(new Compartment());
    const tabSizeCompartment = useRef(new Compartment());
    const placeholderCompartment = useRef(new Compartment());
    const configuredDisplay = useRef({ live, lineNumbers: settings.lineNumbers });

    useEffect(() => {
        const host = hostRef.current;
        if (!host)
            return;
        const extensions: Extension[] = [
            history(),
            drawSelection(),
            dropCursor(),
            rectangularSelection(),
            closeBrackets(),
            indentOnInput(),
            tabSizeCompartment.current.of(indentUnit.of(' '.repeat(settings.tabSize))),
            EditorState.allowMultipleSelections.of(true),
            EditorView.lineWrapping,
            placeholderCompartment.current.of([
                placeholderExt(placeholder),
                EditorView.contentAttributes.of({ 'aria-label': placeholder }),
            ]),
            search({ top: true }),
            autocompletion({
                override: [

                    wikiLinkSource(() => cbRef.current.sources),
                    tagSource(() => cbRef.current.sources),
                    codeFenceSource,
                    containerDirectiveSource,
                    emojiSource,
                ],
                activateOnTyping: true,
                closeOnBlur: true,
                maxRenderedOptions: 24,
                icons: false,
            }),
            markdown({
                base: markdownLanguage,
                addKeymap: false,
            }),
            editorTheme(),
            markdownDecorations,
            liveCompartment.current.of(live ? livePreview((headings) => cbRef.current.onHeadings?.(headings), () => cbRef.current.noteTitle) : []),
            focusModePlugin,
            typewriterPlugin,
            // Ahead of the markdown language on purpose: `@codemirror/lang-markdown` installs its own
            // paste handler that wraps a selected run with a pasted address, and the first handler that
            // claims the event wins. Without this the editor's paste rules would never see a selection.
            Prec.high(pasteExtension(cbRef.current.handlers)),
            keymap.of([
                { key: 'Enter', run: (view) => completeCodeFenceOnEnter(view) || completeColonFenceOnEnter(view) || smartEnter(view) },
                { key: 'Tab', run: (view) => acceptCompletion(view) || tableTab(view) },
                ...editorKeymap,
            ]),
            keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap]),
            keymap.of(defaultKeymap),
            keymap.of([indentWithTab]),
            lineNumbersCompartment.current.of(
                settings.lineNumbers && !live
                    ? [lineNumbers(), foldGutter()]
                    : [],
            ),
            EditorView.updateListener.of((update) => {
                const external = update.transactions.some((transaction) => transaction.annotation(externalValueUpdate));
                if (update.docChanged && !external) {
                    cbRef.current.onChange(update.state.doc.toString());
                }
                if (update.selectionSet && cbRef.current.onCursorLine) {
                    const line = update.state.doc.lineAt(update.state.selection.main.head).number;
                    cbRef.current.onCursorLine(line);
                }
            }),
            EditorView.domEventHandlers({
                scroll(_event, view) {
                    cbRef.current.onScroll?.(view);
                },
                contextmenu(event, view) {
                    return contextMenuRef.current(event, view);
                },
                click(event, view) {
                    const current = linkRef.current;
                    if (current.noteId) runSourceLinkGesture(event, view, 'click', current.settings, current.noteId);
                    return false;
                },
                dblclick(event, view) {
                    const current = linkRef.current;
                    if (current.noteId) runSourceLinkGesture(event, view, 'dblclick', current.settings, current.noteId);
                    return false;
                },
            }),
            liveBlockContextMenu.of((event, view, lineStart) => {
                contextMenuRef.current(event, view, lineStart);
            }),
            liveLinkGesture.of((event, view, target, kind) => linkGestureRef.current(event, view, target, kind)),
            linkHoverExtension(),
            linkHoverFacet.of({
                propose: (link, options) => hoverRef.current.propose(link, options),
                hide: () => {
                    if (!hoverRef.current.card)
                        return false;
                    hoverRef.current.hideNow();
                    return true;
                },
            }),
        ];
        const view = new EditorView({
            state: EditorState.create({ doc: value, extensions }),
            parent: host,
        });
        view.contentDOM.spellcheck = settings.spellcheck;
        viewRef.current = view;
        setActiveEditorView(view);
        if (noteId)
            registerLinkEditorNote(view, noteId);
        const pendingCursor = noteId ? takePendingEditorCursor(noteId) : null;
        if (pendingCursor !== null) {
            view.dispatch({
                selection: EditorSelection.cursor(Math.min(pendingCursor, view.state.doc.length)),
                scrollIntoView: true,
            });
        }
        onReady?.(view);
        return () => {
            onReady?.(null);
            // Only the view that registered may unregister itself: a second editor mounted over this
            // one (a pinned window, a mode switch) owns the cursor now, and clearing it here would
            // leave the show's start key with no view to read.
            if (getActiveEditorView() === view)
                setActiveEditorView(null);
            view.destroy();
            viewRef.current = null;
        };
    }, []);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        if (configuredDisplay.current.live === live && configuredDisplay.current.lineNumbers === settings.lineNumbers)
            return;
        configuredDisplay.current = { live, lineNumbers: settings.lineNumbers };
        view.dispatch({
            effects: lineNumbersCompartment.current.reconfigure(
                settings.lineNumbers && !live
                    ? [lineNumbers(), foldGutter()]
                    : [],
            ),
        });
        view.dispatch({ effects: liveCompartment.current.reconfigure(live ? livePreview((headings) => cbRef.current.onHeadings?.(headings), () => cbRef.current.noteTitle) : []) });
    }, [settings.lineNumbers, live]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
            effects: tabSizeCompartment.current.reconfigure(
                indentUnit.of(' '.repeat(settings.tabSize)),
            ),
        });
    }, [settings.tabSize]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
            effects: placeholderCompartment.current.reconfigure([
                placeholderExt(placeholder),
                EditorView.contentAttributes.of({ 'aria-label': placeholder }),
            ]),
        });
    }, [placeholder]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view)
            return;
        const current = view.state.doc.toString();
        if (current === value)
            return;
        view.dispatch({
            changes: { from: 0, to: current.length, insert: value },
            selection: { anchor: Math.min(view.state.selection.main.anchor, value.length) },
            annotations: externalValueUpdate.of(true),
        });
    }, [value]);

    useEffect(() => {
        const content = viewRef.current?.contentDOM;
        if (content)
            content.spellcheck = settings.spellcheck;
    }, [settings.spellcheck]);

    useEffect(() => {
        viewRef.current?.dispatch({ effects: setFocusMode.of(settings.focusMode) });
    }, [settings.focusMode]);
    return (<>
      <div ref={hostRef} {...longPress.handlers} className={cn('ink-editor', className)} data-live={live} data-family={settings.fontFamily} data-focus-mode={settings.focusMode} data-typewriter={settings.typewriter}/>
      <TagContextMenuAt request={tagMenu} onClose={() => setTagMenu(null)}/>
      {hover.card && (<WikiLinkHoverCard card={hover.card} path={hover.card.noteId ? [hover.card.noteId] : []} depth={1} dark={dark} onClose={hover.hideNow} onEnter={hover.clearPendingHide} onLeave={hover.armHide} onPin={handlePin}/>)}
    </>);
}
