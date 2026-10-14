import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlignHorizontalJustifyCenter,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    Check,
    Columns2,
    Download,
    Eraser,
    FileCode,
    FolderTree,
    Link2,
    ListTree,
    Maximize2,
    Minimize2,
    Moon,
    MoreHorizontal,
    NotebookPen,
    Redo2,
    Save,
    Scan,
    SidebarClose,
    Sparkles,
    Star,
    Sun,
    Undo2,
    Workflow,
    Zap,
    ZoomIn,
    ZoomOut,
} from 'lucide-react';
import type { NoteSummary } from '@shared/types';
import { IconButton } from '../../components/primitives';
import { Menu, Tooltip, type MenuItem } from '../../components/overlay';
import { t, useLocale } from '../../lib/i18n';
import { useBreakpoint, useThemeDark } from '../../lib/hooks';
import { downloadBlob, safeFileName } from '../../lib/export-note';
import { decodeDataValue } from '../../lib/markdown/data-attr';
import { parseWikiTarget } from '../../lib/markdown/renderer';
import {
    applyTopicCompletion,
    MINDMAP_NODE_LINK_ATTR,
    MINDMAP_TOPIC_EDITOR_ID,
    markdownToMindmapOutline,
    mindmapErrorText,
    mindmapNodeTopic,
    mindmapOutlineToMarkdown,
    parseMindmapNodeLink,
    topicCompletionQuery,
    type MindmapDocumentDirection,
    type MindmapDocumentPalette,
    type MindmapNodeMenuItem,
} from '../../lib/markdown/mindmap';
import { findNoteByTitle, useNotes } from '../../store/notes';
import { useUi, type WorkspacePane } from '../../store/ui';
import { WikiLinkHoverCard } from '../preview/wiki-link-hover-card';
import { useLinkHoverHost } from '../preview/link-hover-host';
import { MindmapNotePicker } from './MindmapNotePicker';
import { useMindmapSettingsStore } from './mindmap-settings-store';
import { useMindmapDocument } from './use-mindmap-document';

interface Props {
    note: NoteSummary;
    content: string;
    onChange: (next: string) => void;
    onTitleChange?: (title: string) => void;
    onMobileBack?: () => void;
    pane?: WorkspacePane | 'active';
}

type ViewMode = 'canvas' | 'code';

/**
 * A whole note drawn as one mind map: the `.elixir` file.
 *
 * The fence block in a Markdown note is mounted by the registry and writes back into
 * the text around it. Here the note *is* the body, so this surface owns one instance
 * for as long as it is on screen, and the two directions of sync are the document's:
 * the map's operations are written out on a debounce, and text that arrives from
 * elsewhere — the source view, an undo, another device — is read back in.
 *
 * What it adds on top of the library's own toolbar is the part only a notebook can
 * give: nodes that name another note open it and can be hovered for a preview, a node
 * can become a note, a note can be poured into the map as branches, and the map can be
 * written back out as an outline note.
 */
export function MindmapStandaloneEditor({ note, content, onChange, onTitleChange, onMobileBack, pane = 'active' }: Props) {
    const isMobile = useBreakpoint() === 'mobile';
    const locale = useLocale();
    const dark = useThemeDark();
    const openInAdjacentPane = useMindmapSettingsStore((s) => s.openInAdjacentPane);
    const autoSaveIntervalMs = useMindmapSettingsStore((s) => s.autoSaveIntervalMs);
    const undoHistoryLimit = useMindmapSettingsStore((s) => s.undoHistoryLimit);
    const patchNote = useNotes((s) => s.patchNote);
    const saveStatus = useNotes((s) => s.saveStatus);
    const closeSecondaryNote = useUi((s) => s.closeSecondaryNote);
    const toast = useUi((s) => s.toast);

    const [view, setView] = useState<ViewMode>('canvas');
    const [isMenuOpen, setMenuOpen] = useState(false);
    const [isPicking, setPicking] = useState<null | 'link' | 'outline'>(null);
    const [pickSeed, setPickSeed] = useState('');
    const [isFullscreen, setIsFullscreen] = useState(false);
    const menuRef = useRef<HTMLButtonElement>(null);
    const shellRef = useRef<HTMLDivElement>(null);
    /** The node a `[[` was typed into, and the text it held when the list opened. */
    const completion = useRef<{ id: string, text: string } | null>(null);

    const onChangeRef = useRef(onChange);
    useEffect(() => {
        onChangeRef.current = onChange;
    });

    const handleBodyChange = useCallback((next: string) => {
        onChangeRef.current(next);
    }, []);

    /**
     * The rows added to the node context menu. They are assembled before the map exists —
     * the hook takes them when it builds one — so each reaches its action through a box the
     * render below refills, rather than through a closure over a map that is not there yet.
     */
    const nodeActions = useRef<{ openLink: () => void, createNote: () => void }>({ openLink: () => {}, createNote: () => {} });
    const nodeMenu = useMemo<MindmapNodeMenuItem[]>(() => [
        { id: 'link-note', label: t('mindmap.link_note'), onSelect: () => nodeActions.current.openLink() },
        { id: 'new-note', label: t('mindmap.create_note_from_node'), onSelect: () => nodeActions.current.createNote() },
    ], []);

    const surface = useMindmapDocument({
        content,
        editable: true,
        dark,
        locale,
        autoSaveMs: autoSaveIntervalMs,
        undoStepLimit: undoHistoryLimit,
        nodeMenu,
        onBodyChange: handleBodyChange,
    });
    const map = surface.map;

    // The fields come out of the map's own parse rather than a second one here: this body is
    // note text, and re-reading 144 KB of JSON on every write tick to answer three toggles
    // was the price the header paid for showing them.
    const fields = surface.fields;
    const ready = surface.status === 'ready';
    const isSynced = saveStatus === 'synced' || saveStatus === 'idle';
    const { hover, handlePin, onMouseLeave } = useLinkHoverHost(note.id);

    /**
     * `[[` in a node opens the same list the menu does, with the characters typed so far
     * already in its search box.
     *
     * The library owns the editor the brackets go into — a contenteditable it blurs to
     * commit — so this only watches it: opening the picker takes the focus, which writes the
     * half-finished text into the node as it stands, and the pick is spliced into that.
     */
    useEffect(() => {
        const host = surface.hostRef.current;
        if (!host)
            return;
        const onInput = (event: Event) => {
            const editor = event.target;
            if (!(editor instanceof HTMLElement) || editor.id !== MINDMAP_TOPIC_EDITOR_ID)
                return;
            const query = topicCompletionQuery(editor.textContent ?? '');
            if (query === null)
                return;
            const id = map()?.selectedNodeId();
            if (!id)
                return;
            completion.current = { id, text: editor.textContent ?? '' };
            setPickSeed(query);
            setPicking('link');
        };
        host.addEventListener('input', onInput);
        return () => host.removeEventListener('input', onInput);
    }, [map, surface.hostRef]);

    /** The link the reader was writing: the open `[[query` gives way to the note they picked. */
    const applyCompletion = useCallback((title: string) => {
        const pending = completion.current;
        completion.current = null;
        const handle = map();
        if (!pending || !handle)
            return;
        // Spliced into the topic the node holds now rather than the text as it was typed a
        // moment ago: the editor committed — and trimmed — it in between.
        const topic = mindmapNodeTopic(handle.getData(), pending.id) ?? pending.text;
        handle.renameNode(pending.id, applyTopicCompletion(topic, title));
    }, [map]);

    const openLinkPicker = useCallback(() => {
        completion.current = null;
        setPickSeed('');
        setPicking('link');
    }, []);

    /**
     * A node that names another note carries the same `data-wikilink` a prose link does,
     * so the only thing left to decide is which pane answers. The library owns every
     * other click in the canvas — it selects the node — so this listens in the capture
     * phase and takes the gesture only when it landed on a link.
     */
    useEffect(() => {
        const host = surface.hostRef.current;
        if (!host)
            return;
        const onClick = (event: MouseEvent) => {
            if (!(event.target instanceof Element))
                return;
            const link = event.target.closest<HTMLElement>(`[${MINDMAP_NODE_LINK_ATTR}]`);
            if (!link)
                return;
            event.preventDefault();
            event.stopPropagation();
            const parsed = parseWikiTarget(decodeDataValue(link.dataset.wikilink ?? ''));
            if (!parsed.noteTitle)
                return;
            const target = findNoteByTitle(parsed.noteTitle);
            if (target) {
                const active = useUi.getState().activeWorkspacePane;
                const paneFor = openInAdjacentPane && active === 'primary' ? 'secondary' : active;
                void useNotes.getState().openNote(target.id, { pane: paneFor });
                return;
            }
            // An unresolved link is still an invitation — this is where a reader means to
            // write the note — and the map keeps pointing at it either way.
            void useNotes.getState().createNote({ title: parsed.noteTitle, open: false }).then((id) => {
                if (id)
                    toast({ title: t('preview.created_title', { title: parsed.noteTitle }), tone: 'success' });
            });
        };
        host.addEventListener('click', onClick, true);
        return () => host.removeEventListener('click', onClick, true);
    }, [openInAdjacentPane, surface.hostRef, toast]);

    useEffect(() => {
        const onChangeFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement));
        document.addEventListener('fullscreenchange', onChangeFullscreen);
        return () => document.removeEventListener('fullscreenchange', onChangeFullscreen);
    }, []);

    const toggleFullscreen = useCallback(() => {
        const shell = shellRef.current;
        if (!shell)
            return;
        if (document.fullscreenElement)
            void document.exitFullscreen().catch(() => {});
        else
            void shell.requestFullscreen().catch(() => {});
    }, []);

    /** The node an action works on, or nothing at all: acting on a guess edits the wrong branch. */
    const requireSelection = useCallback((): string | null => {
        const handle = map();
        const id = handle?.selectedNodeId() ?? null;
        if (!id)
            toast({ title: t('mindmap.select_a_node_first'), tone: 'warning' });
        return id;
    }, [map, toast]);

    const linkSelection = useCallback((title: string) => {
        const id = requireSelection();
        if (id)
            map()?.renameNode(id, `[[${title}]]`);
    }, [map, requireSelection]);

    const importOutline = useCallback((sourceId: string) => {
        const state = useNotes.getState();
        const source = state.notes[sourceId];
        const body = state.contents[sourceId];
        const handle = map();
        if (!source || body === undefined || !handle)
            return;
        const outline = markdownToMindmapOutline(body);
        if (!outline) {
            toast({ title: t('mindmap.nothing_to_import'), tone: 'warning' });
            return;
        }
        const topics = outline.split('\n').map((line) => line.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
        const parent = handle.selectedNodeId() ?? rootId(handle.getData());
        if (!parent || topics.length === 0) {
            toast({ title: t('mindmap.nothing_to_import'), tone: 'warning' });
            return;
        }
        handle.appendChildren(parent, topics);
        toast({ title: t('mindmap.imported_from_note', { title: source.title }), tone: 'success' });
    }, [map, toast]);

    const createNoteFromSelection = useCallback(async () => {
        const handle = map();
        const id = handle ? requireSelection() : null;
        if (!handle || !id)
            return;
        const written = mindmapNodeTopic(handle.getData(), id)?.trim() ?? '';
        // A node that already names a note is asked to make the note it names, not one
        // spelled after the brackets: `[[Reading]]` is a pointer at "Reading", and the
        // pointer is what the reader wrote.
        const topic = parseMindmapNodeLink(written)?.trim() ?? written;
        if (!topic) {
            toast({ title: t('mindmap.node_is_untitled'), tone: 'warning' });
            return;
        }
        const existing = findNoteByTitle(topic);
        if (existing) {
            handle.renameNode(id, `[[${existing.title}]]`);
            void useNotes.getState().openNote(existing.id);
            return;
        }
        const created = await useNotes.getState().createNote({ title: topic, open: false });
        if (!created)
            return;
        handle.renameNode(id, `[[${topic}]]`);
        toast({
            title: t('mindmap.note_created', { title: topic }),
            action: { label: t('common.open'), run: () => void useNotes.getState().openNote(created) },
            duration: 6000,
        });
    }, [map, requireSelection, toast]);

    nodeActions.current = {
        openLink: openLinkPicker,
        createNote: () => void createNoteFromSelection(),
    };

    const writeOutlineNote = useCallback(() => {
        const outline = surface.serializeAs('outline');
        const markdown = outline === null ? null : mindmapOutlineToMarkdown(outline);
        if (!markdown) {
            toast({ title: t('preview.mindmap_outline_empty'), tone: 'warning' });
            return;
        }
        const title = rootTopic(map()?.getData()) || note.title;
        void useNotes.getState().createNote({ title, content: `${markdown}\n`, open: true });
    }, [map, note.title, surface.serializeAs, toast]);

    /**
     * The history the reader cannot see is the memory they cannot account for: the library
     * holds a full copy of the document per step, so a long session on a large map carries
     * every version it ever had. Bounded by a setting, and worth a button for the moment
     * the reader notices they are paying for it.
     */
    const clearHistory = useCallback(() => {
        map()?.clearHistory();
        toast({ title: t('mindmap.history_cleared'), tone: 'success' });
    }, [map, toast]);

    const copy = useCallback(async (text: string | null) => {
        if (!text || !navigator.clipboard?.writeText) {
            toast({ title: t('preview.could_not_copy'), tone: 'danger' });
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            toast({ title: t('common.copied'), tone: 'success' });
        }
        catch {
            toast({ title: t('preview.could_not_copy'), tone: 'danger' });
        }
    }, [toast]);

    const download = useCallback(async (kind: 'svg' | 'png') => {
        const handle = map();
        const blob = handle
            ? kind === 'svg' ? await handle.exportSvg().catch(() => null) : await handle.exportPng().catch(() => null)
            : null;
        if (!blob) {
            toast({ title: t('preview.mindmap_render_failed'), tone: 'danger' });
            return;
        }
        downloadBlob(`${safeFileName(note.title) || 'mindmap'}.${kind}`, blob);
    }, [map, note.title, toast]);

    const menuItems = useMemo<MenuItem[]>(() => [
        { id: 'link-note', label: t('mindmap.link_note'), icon: <Link2 size={13}/>, onSelect: () => setPicking('link') },
        { id: 'new-note', label: t('mindmap.create_note_from_node'), icon: <NotebookPen size={13}/>, onSelect: () => void createNoteFromSelection() },
        { id: 'import-outline', label: t('mindmap.import_note_outline'), icon: <FolderTree size={13}/>, onSelect: () => setPicking('outline'), separatorBefore: true },
        { id: 'write-outline', label: t('mindmap.write_outline_note'), icon: <ListTree size={13}/>, onSelect: writeOutlineNote },
        { id: 'export-svg', label: t('preview.mindmap_export_svg'), icon: <Download size={13}/>, onSelect: () => void download('svg'), separatorBefore: true },
        { id: 'export-png', label: t('preview.mindmap_export_png'), icon: <Download size={13}/>, onSelect: () => void download('png') },
        { id: 'copy-json', label: t('preview.mindmap_copy_json'), icon: <FileCode size={13}/>, onSelect: () => void copy(surface.serializeAs('json')) },
        { id: 'copy-outline', label: t('preview.mindmap_copy_outline'), icon: <ListTree size={13}/>, onSelect: () => void copy(surface.serializeAs('outline')) },
        { id: 'clear-history', label: t('mindmap.clear_history'), icon: <Eraser size={13}/>, onSelect: clearHistory, separatorBefore: true },
    ], [clearHistory, copy, createNoteFromSelection, download, surface.serializeAs, writeOutlineNote]);

    return (
      <div ref={shellRef} className="relative flex h-full min-h-0 w-full flex-col bg-[var(--bg-base)] text-[var(--text-primary)]" data-mindmap-document>
        <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 select-none">
          <div className="flex min-w-0 items-center gap-2">
            {isMobile && onMobileBack && (
              <IconButton label={t('workspace.back_to_notes')} size="sm" onClick={onMobileBack}>
                <Columns2 size={16}/>
              </IconButton>
            )}
            <Workflow size={16} className="shrink-0 text-[var(--accent)]"/>
            <input
              type="text"
              value={note.title}
              onChange={(event) => onTitleChange?.(event.target.value)}
              aria-label={t('mindmap.file_title')}
              className="min-w-0 max-w-[280px] truncate rounded bg-transparent px-1.5 py-0.5 text-sm font-semibold text-[var(--text-primary)] focus:bg-[var(--bg-surface)] focus:ring-1 focus:ring-[var(--accent)] focus:outline-none md:max-w-md"
            />
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Tooltip label={isSynced ? t('workspace.mindmap_saved') : t('workspace.save_mindmap')}>
              <span
                className="mr-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[var(--text-secondary)]"
                data-mindmap-save-state={isSynced ? 'saved' : 'pending'}
              >
                {isSynced ? <Check size={13} className="text-[var(--accent)]"/> : <Save size={13} className="text-[var(--warning)]"/>}
                <span className="hidden text-[11px] sm:inline">{isSynced ? t('workspace.mindmap_saved') : t('workspace.save_mindmap')}</span>
              </span>
            </Tooltip>

            <Tooltip label={t('mindmap.compact')}>
              <IconButton label={t('mindmap.compact')} size="sm" disabled={!ready} active={fields.compact ?? false} onClick={() => surface.patchFields({ compact: !(fields.compact ?? false) })}>
                <Zap size={14}/>
              </IconButton>
            </Tooltip>

            <Tooltip label={`${t('mindmap.direction')}: ${t(DIRECTION_LABELS[fields.direction ?? 2])}`}>
              <IconButton label={t('mindmap.direction')} size="sm" disabled={!ready} onClick={() => surface.patchFields({ direction: nextDirection(fields.direction) })}>
                <DirectionGlyph direction={fields.direction ?? 2}/>
              </IconButton>
            </Tooltip>

            <Tooltip label={t(PALETTE_LABELS[fields.palette ?? 'auto'])}>
              <IconButton label={t('mindmap.palette')} size="sm" disabled={!ready} onClick={() => surface.patchFields({ palette: nextPalette(fields.palette) })}>
                {fields.palette === 'dark' ? <Moon size={14}/> : fields.palette === 'light' ? <Sun size={14}/> : <Sparkles size={14}/>}
              </IconButton>
            </Tooltip>

            <Tooltip label={view === 'canvas' ? t('mindmap.open_source') : t('mindmap.open_canvas')}>
              <IconButton label={view === 'canvas' ? t('mindmap.open_source') : t('mindmap.open_canvas')} size="sm" onClick={() => setView(view === 'canvas' ? 'code' : 'canvas')}>
                {view === 'canvas' ? <FileCode size={15}/> : <Scan size={15}/>}
              </IconButton>
            </Tooltip>

            <Tooltip label={note.isStarred ? t('common.remove_from_favorites') : t('navigation.favorites')}>
              <IconButton label={note.isStarred ? t('common.remove_from_favorites') : t('navigation.favorites')} size="sm" active={note.isStarred} onClick={() => void patchNote(note.id, { isStarred: !note.isStarred })}>
                <Star size={14} className={note.isStarred ? 'fill-current' : undefined}/>
              </IconButton>
            </Tooltip>

            <Menu anchor={menuRef} open={isMenuOpen} onClose={() => setMenuOpen(false)} items={menuItems} align="end" width={240}/>
            <Tooltip label={t('mindmap.actions')}>
              <IconButton ref={menuRef} label={t('mindmap.actions')} size="sm" active={isMenuOpen} onClick={() => setMenuOpen((open) => !open)}>
                <MoreHorizontal size={14}/>
              </IconButton>
            </Tooltip>

            {pane === 'secondary' && (
              <Tooltip label={t('workspace.close_right_note')}>
                <IconButton label={t('workspace.close_right_note')} size="sm" onClick={closeSecondaryNote}>
                  <SidebarClose size={15}/>
                </IconButton>
              </Tooltip>
            )}
          </div>
        </header>

        <div className="relative min-h-0 w-full flex-1 overflow-hidden">
          {view === 'code' && (
            <div className="h-full w-full overflow-auto p-4">
              <textarea
                value={content}
                spellCheck={false}
                aria-label={t('mindmap.source')}
                onChange={(event) => onChangeRef.current(event.target.value)}
                className="h-full w-full resize-none rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 font-mono text-xs leading-relaxed text-[var(--text-primary)] transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus:border-[var(--accent)] focus:shadow-[var(--shadow-ring-focus)] focus:outline-none"
              />
            </div>
          )}

          <div
            ref={surface.hostRef}
            data-mindmap-document-canvas
            className="h-full w-full"
            style={{ display: view === 'canvas' ? 'block' : 'none' }}
            onMouseMove={hover.handleMouseMove}
            onMouseLeave={onMouseLeave}
          />

          {view === 'canvas' && surface.status === 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-tertiary)]">
              {t('preview.mindmap_loading')}
            </div>
          )}

          {view === 'canvas' && surface.status === 'error' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center">
              <p className="text-sm text-[var(--danger)]">{t('preview.mindmap_render_failed')}</p>
              <p className="max-w-[520px] text-xs break-words text-[var(--text-tertiary)]">{surface.error ? mindmapErrorText(surface.error) : null}</p>
            </div>
          )}

          {view === 'canvas' && ready && (
            <MindmapDocumentCapsule
              isFullscreen={isFullscreen}
              onToggleFullscreen={toggleFullscreen}
              onUndo={() => map()?.undo()}
              onRedo={() => map()?.redo()}
              onZoomIn={() => map()?.zoom(1)}
              onZoomOut={() => map()?.zoom(-1)}
              onFit={() => map()?.scaleFit()}
              onCenter={() => map()?.toCenter()}
            />
          )}

          {hover.card && (
            <WikiLinkHoverCard
              card={hover.card}
              path={hover.card.noteId ? [hover.card.noteId] : []}
              depth={1}
              dark={dark}
              onClose={hover.hideNow}
              onEnter={hover.clearPendingHide}
              onLeave={hover.armHide}
              onPin={handlePin}
            />
          )}
        </div>

        <MindmapNotePicker
          open={isPicking !== null}
          title={isPicking === 'outline' ? t('mindmap.import_note_outline') : t('mindmap.link_note')}
          initialQuery={pickSeed}
          excludeNoteId={note.id}
          onClose={() => setPicking(null)}
          onSelect={(picked) => {
            if (isPicking === 'outline')
                importOutline(picked.id);
            else if (completion.current)
                applyCompletion(picked.title || t('common.untitled_note'));
            else
                linkSelection(picked.title || t('common.untitled_note'));
          }}
        />
      </div>
    );
}

const DIRECTION_LABELS = {
    0: 'mindmap.direction_left',
    1: 'mindmap.direction_right',
    2: 'mindmap.direction_side',
    3: 'mindmap.direction_down',
} as const;

const PALETTE_LABELS = {
    auto: 'mindmap.palette_auto',
    light: 'mindmap.palette_light',
    dark: 'mindmap.palette_dark',
} as const;

/** The four layouts, cycled in the order a reader learns them: both sides, then one, then down. */
const DIRECTION_CYCLE: MindmapDocumentDirection[] = [2, 1, 0, 3];

function nextDirection(current: MindmapDocumentDirection | undefined): MindmapDocumentDirection {
    const at = DIRECTION_CYCLE.indexOf(current ?? 2);
    return DIRECTION_CYCLE[(at + 1) % DIRECTION_CYCLE.length]!;
}

/** auto → light → dark → auto: a document either names a palette or says nothing. */
function nextPalette(current: MindmapDocumentPalette | undefined): MindmapDocumentPalette | null {
    if (current === undefined)
        return 'light';
    return current === 'light' ? 'dark' : null;
}

function DirectionGlyph({ direction }: { direction: MindmapDocumentDirection }) {
    if (direction === 3)
        return <ArrowDown size={14}/>;
    if (direction === 0)
        return <ArrowLeft size={14}/>;
    if (direction === 1)
        return <ArrowRight size={14}/>;
    return <Workflow size={14}/>;
}

function rootId(data: unknown): string | null {
    const nodeData = (data as { nodeData?: { id?: unknown } } | null)?.nodeData;
    return typeof nodeData?.id === 'string' ? nodeData.id : null;
}

function rootTopic(data: unknown): string {
    const topic = (data as { nodeData?: { topic?: unknown } } | null)?.nodeData?.topic;
    if (typeof topic !== 'string')
        return '';
    // A root that *is* a link to another note names the new note after that note: a title
    // spelled `[[Something]]` is a broken link in the one place a title has to be plain.
    const link = parseMindmapNodeLink(topic);
    if (!link)
        return topic.trim();
    const parsed = parseWikiTarget(link);
    return (parsed.alias || parsed.noteTitle || '').trim();
}

/**
 * The view controls that belong over the canvas rather than in the head: the head is
 * already at its width on a phone.
 *
 * This is the whole of the map's chrome on this surface. The library draws two bars of its
 * own — a layout one at the top left, a zoom and full screen one at the bottom right — and
 * both are switched off where this capsule lives: the bottom-right one occupied the same
 * corner, and the full screen button in it asked the browser to fullscreen the map alone,
 * which is a different picture from the one the reader clicked on. What those bars offered
 * that this did not — zoom in and out — is answered here, and what the layout bar offered
 * the head has offered all along.
 */
function MindmapDocumentCapsule(props: {
    isFullscreen: boolean
    onToggleFullscreen: () => void
    onUndo: () => void
    onRedo: () => void
    onZoomIn: () => void
    onZoomOut: () => void
    onFit: () => void
    onCenter: () => void
}) {
    const { isFullscreen, onToggleFullscreen, onUndo, onRedo, onZoomIn, onZoomOut, onFit, onCenter } = props;
    return (
      <div className="pointer-events-none absolute right-3 bottom-3 left-3 flex justify-end">
        <div data-mindmap-capsule className="pointer-events-auto flex items-center gap-1 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-1 shadow-[var(--shadow-pop)]">
          <Tooltip label={t('preview.mindmap_undo')} side="top">
            <IconButton label={t('preview.mindmap_undo')} size="sm" onClick={onUndo}>
              <Undo2 size={15}/>
            </IconButton>
          </Tooltip>
          <Tooltip label={t('preview.mindmap_redo')} side="top">
            <IconButton label={t('preview.mindmap_redo')} size="sm" onClick={onRedo}>
              <Redo2 size={15}/>
            </IconButton>
          </Tooltip>
          <Tooltip label={t('mindmap.zoom_out')} side="top">
            <IconButton label={t('mindmap.zoom_out')} size="sm" onClick={onZoomOut}>
              <ZoomOut size={15}/>
            </IconButton>
          </Tooltip>
          <Tooltip label={t('mindmap.zoom_in')} side="top">
            <IconButton label={t('mindmap.zoom_in')} size="sm" onClick={onZoomIn}>
              <ZoomIn size={15}/>
            </IconButton>
          </Tooltip>
          <Tooltip label={t('preview.mindmap_fit')} side="top">
            <IconButton label={t('preview.mindmap_fit')} size="sm" onClick={onFit}>
              <Scan size={15}/>
            </IconButton>
          </Tooltip>
          <Tooltip label={t('preview.mindmap_center')} side="top">
            <IconButton label={t('preview.mindmap_center')} size="sm" onClick={onCenter}>
              <AlignHorizontalJustifyCenter size={15}/>
            </IconButton>
          </Tooltip>
          <Tooltip label={isFullscreen ? t('mindmap.exit_fullscreen') : t('mindmap.fullscreen')} side="top">
            <IconButton label={isFullscreen ? t('mindmap.exit_fullscreen') : t('mindmap.fullscreen')} size="sm" active={isFullscreen} onClick={onToggleFullscreen}>
              {isFullscreen ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}
            </IconButton>
          </Tooltip>
        </div>
      </div>
    );
}
