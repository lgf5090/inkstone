import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import { Crosshair, Download, Expand, FileJson, Heading, ImageDown, Keyboard, List, ListTree, Redo2, Undo2, X } from 'lucide-react';
import { IconButton } from '../../components/primitives';
import { Menu, Modal, Tooltip, useClickOutside, type MenuItem } from '../../components/overlay';
import { t } from '../../lib/i18n';
import { downloadBlob, safeFileName } from '../../lib/export-note';
import { decodeDataValue } from '../../lib/markdown/data-attr';
import { parseWikiTarget } from '../../lib/markdown/renderer';
import { MINDMAP_NODE_LINK_ATTR, captureMindmapFocus, subscribeMindmaps, type MindmapMode, type MindmapSession } from '../../lib/markdown/mindmap';
import { findNoteByTitle, useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { writeMindmapOutline, type MindmapOutlinePlacement } from './mindmap-outline';

const MINDMAP_MENU_WIDTH = 220;

const SHORTCUT_KEYS = [
    'preview.mindmap_shortcut_navigate',
    'preview.mindmap_shortcut_add_sibling',
    'preview.mindmap_shortcut_add_child',
    'preview.mindmap_shortcut_add_parent',
    'preview.mindmap_shortcut_edit',
    'preview.mindmap_shortcut_move',
    'preview.mindmap_shortcut_remove',
    'preview.mindmap_shortcut_center',
    'preview.mindmap_shortcut_zoom',
] as const;

type RaiseToast = ReturnType<typeof useUi.getState>['toast'];

interface MindmapActions {
    copy(text: string | null): void
    convert(mode: MindmapMode): void
    download(kind: 'svg' | 'png'): void
    /** Writes the tree into the note as headings and lists. */
    outline(placement: MindmapOutlinePlacement): void
}

async function copyBody(text: string | null, toast: RaiseToast): Promise<void> {
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
}

/** Format conversion rewrites the fence, so the undo it offers restores the previous body. */
function convertBody(session: MindmapSession, mode: MindmapMode, toast: RaiseToast): void {
    const previous = session.serialize(session.mode());
    const next = session.serialize(mode);
    if (next === null || previous === null)
        return;
    const result = session.apply(next);
    if (result !== 'written' && result !== 'moved') {
        toast({ title: t('preview.mindmap_source_moved'), tone: 'warning' });
        return;
    }
    const format = mode === 'json' ? t('preview.mindmap_mode_json') : t('preview.mindmap_mode_outline');
    toast({
        title: t('preview.mindmap_convert_done', { format }),
        action: { label: t('common.undo'), run: () => session.apply(previous) },
        duration: 5000,
    });
}

async function downloadBody(session: MindmapSession, kind: 'svg' | 'png', toast: RaiseToast): Promise<void> {
    const blob = kind === 'svg' ? await session.exportSvg() : await session.exportPng();
    if (!blob) {
        toast({ title: t('preview.mindmap_render_failed'), tone: 'danger' });
        return;
    }
    downloadBlob(`${safeFileName(session.title()) || 'mindmap'}.${kind}`, blob);
}

function buildMenuItems(session: MindmapSession, actions: MindmapActions): MenuItem[] {
    const mode = session.mode();
    const convertMode: MindmapMode = mode === 'json' ? 'outline' : 'json';
    const items: MenuItem[] = [
        { id: 'export-svg', label: t('preview.mindmap_export_svg'), icon: <Download size={13}/>, onSelect: () => actions.download('svg') },
        { id: 'export-png', label: t('preview.mindmap_export_png'), icon: <ImageDown size={13}/>, onSelect: () => actions.download('png') },
        { id: 'copy-json', label: t('preview.mindmap_copy_json'), icon: <FileJson size={13}/>, onSelect: () => actions.copy(session.serialize('json')), separatorBefore: true },
        { id: 'copy-outline', label: t('preview.mindmap_copy_outline'), icon: <ListTree size={13}/>, onSelect: () => actions.copy(session.serialize('outline')) },
    ];
    if (session.isEditable()) {
        items.push({
            id: `convert-${convertMode}`,
            label: convertMode === 'json' ? t('preview.mindmap_convert_json') : t('preview.mindmap_convert_outline'),
            icon: convertMode === 'json' ? <FileJson size={13}/> : <ListTree size={13}/>,
            onSelect: () => actions.convert(convertMode),
            separatorBefore: true,
        });
        items.push(
            { id: 'outline-replace', label: t('preview.mindmap_outline_replace'), icon: <Heading size={13}/>, onSelect: () => actions.outline('replace'), separatorBefore: true },
            { id: 'outline-insert', label: t('preview.mindmap_outline_insert'), icon: <List size={13}/>, onSelect: () => actions.outline('after') },
        );
    }
    return items;
}

/** Why the tree could not be written out, as the message the user gets. */
function outlineFailure(result: 'empty' | 'conflict' | 'missing'): { title: string; tone: 'warning' | 'danger' } {
    if (result === 'conflict')
        return { title: t('preview.mindmap_source_moved'), tone: 'warning' };
    if (result === 'empty')
        return { title: t('preview.mindmap_outline_empty'), tone: 'warning' };
    return { title: t('preview.mindmap_outline_failed'), tone: 'danger' };
}

function outlineBody(session: MindmapSession, placement: MindmapOutlinePlacement, toast: RaiseToast, onDone: () => void): void {
    const result = writeMindmapOutline(session, placement);
    if (result === 'written') {
        // A replaced fence takes the block out of the note, so the overlay has
        // nothing left to be full screen on.
        if (placement === 'replace')
            onDone();
        return;
    }
    toast(outlineFailure(result));
}

/**
 * Opening a wiki target from the overlay. The preview's own wiki click handler
 * cannot see these clicks (the modal is portaled outside its host), so the
 * navigation is repeated here without the scroll-into-view part: the preview
 * it would scroll is hidden behind the overlay. The overlay is closed by the
 * click handler first, so the jump the user just asked for is the thing on
 * screen.
 */
async function openWikiTargetFromOverlay(raw: string, sourceNoteId: string | null, toast: RaiseToast): Promise<void> {
    const parsed = parseWikiTarget(raw);
    const state = useNotes.getState();
    const note = parsed.noteTitle ? findNoteByTitle(parsed.noteTitle) : sourceNoteId ? state.notes[sourceNoteId] : undefined;
    if (!note) {
        if (!parsed.noteTitle)
            return;
        const id = await state.createNote({ title: parsed.noteTitle, open: false });
        if (id)
            toast({ title: t('preview.created_title', { title: parsed.noteTitle }), tone: 'success' });
        return;
    }
    await state.openNote(note.id);
    const source = sourceNoteId ? useNotes.getState().notes[sourceNoteId] : undefined;
    if (source && useUi.getState().activeNoteId !== source.id) {
        toast({
            title: source.title,
            action: { label: t('preview.mindmap_node_link_return'), run: () => void useNotes.getState().openNote(source.id) },
            duration: 8000,
        });
    }
}

/**
 * Keeps the header in step with the block and hands the overlay the live
 * instance while it is open — moving the element, never copying it, so the
 * camera, selection and undo stack carry over.
 */
function useOverlaySession(session: MindmapSession, bodyRef: RefObject<HTMLDivElement | null>, onClose: () => void): void {
    const [, refresh] = useReducer((count: number) => count + 1, 0);
    useEffect(() => subscribeMindmaps(() => refresh()), []);
    useEffect(() => {
        const body = bodyRef.current;
        if (!body)
            return;
        session.moveInto(body);
        // The map's key bindings are its main input method; hand it the focus.
        session.focus();
        // The modal is portaled outside the preview host, so clicks on the full
        // screen canvas need their own pointer listener.
        const releaseFocusCapture = captureMindmapFocus(body);
        const onWikiClick = (event: MouseEvent) => {
            if (!(event.target instanceof Element))
                return;
            const link = event.target.closest<HTMLElement>(`[${MINDMAP_NODE_LINK_ATTR}]`);
            if (!link)
                return;
            event.preventDefault();
            event.stopPropagation();
            onClose();
            void openWikiTargetFromOverlay(decodeDataValue(link.dataset.wikilink ?? ''), session.noteId(), useUi.getState().toast);
        };
        body.addEventListener('click', onWikiClick);
        return () => {
            releaseFocusCapture();
            body.removeEventListener('click', onWikiClick);
            session.moveBack();
        };
    }, [onClose, session, bodyRef]);
}

function MindmapActionsButton(props: {
    isMenuOpen: boolean
    onToggle: () => void
    buttonRef: RefObject<HTMLButtonElement | null>
    menuItems: MenuItem[]
}) {
    const { isMenuOpen, onToggle, buttonRef, menuItems } = props;
    return (
      <>
        <Tooltip label={t('preview.mindmap_actions')}>
          <IconButton ref={buttonRef} label={t('preview.mindmap_actions')} size="sm" active={isMenuOpen} onClick={onToggle}>
            <Download size={15}/>
          </IconButton>
        </Tooltip>
        <Menu anchor={buttonRef} open={isMenuOpen} onClose={onToggle} items={menuItems} align="end" width={MINDMAP_MENU_WIDTH}/>
      </>
    );
}

/** Keyboard is the map's main input method, so the reference is one click away. */
function MindmapShortcutToggle({ isOpen, onToggle, buttonRef }: {
    isOpen: boolean
    onToggle: () => void
    buttonRef: RefObject<HTMLButtonElement | null>
}) {
    return (
      <Tooltip label={t('preview.mindmap_shortcuts')}>
        <IconButton ref={buttonRef} label={t('preview.mindmap_shortcuts')} size="sm" active={isOpen} onClick={onToggle}>
          <Keyboard size={15}/>
        </IconButton>
      </Tooltip>
    );
}

/**
 * The keyboard reference is a card over the map, not a row inside the toolbar:
 * growing the toolbar reflows the head and moves the button the user just
 * pressed away from the pointer. It belongs to the drawing area instead, and
 * Escape or a click outside dismisses it like any other popover.
 */
function MindmapShortcuts({ open, onClose, anchor }: {
    open: boolean
    onClose: () => void
    anchor: RefObject<HTMLButtonElement | null>
}) {
    const panelRef = useRef<HTMLElement>(null);
    useClickOutside([panelRef, anchor], open, onClose);
    if (!open)
        return null;
    return (
      <section ref={panelRef} className="mindmap-shortcuts" aria-label={t('preview.mindmap_shortcuts')}>
        <ul>{SHORTCUT_KEYS.map((key) => <li key={key}>{t(key)}</li>)}</ul>
      </section>
    );
}

function MindmapHeader(props: {
    session: MindmapSession
    actions: MindmapActions
    onClose: () => void
    isShortcutsOpen: boolean
    onToggleShortcuts: () => void
    shortcutButtonRef: RefObject<HTMLButtonElement | null>
}) {
    const { session, actions, onClose, isShortcutsOpen, onToggleShortcuts, shortcutButtonRef } = props;
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [isMenuOpen, setMenuOpen] = useState(false);
    const editable = session.isEditable();
    const mode = session.mode();
    const title = session.title() || t('preview.mindmap');
    const menuItems = useMemo(() => buildMenuItems(session, actions), [session, actions]);
    return (
      <header className="mindmap-fullscreen-head">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.012em] text-[var(--text-primary)]">{title}</h2>
          <p className="text-[12px] text-[var(--text-secondary)]">
            {mode === 'json' ? t('preview.mindmap_mode_json') : t('preview.mindmap_mode_outline')}
            {!editable && ` · ${t('preview.mindmap_readonly')}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {editable && (
          <>
            <Tooltip label={t('preview.mindmap_undo')}>
              <IconButton label={t('preview.mindmap_undo')} size="sm" onClick={() => session.undo()}>
                <Undo2 size={15}/>
              </IconButton>
            </Tooltip>
            <Tooltip label={t('preview.mindmap_redo')}>
              <IconButton label={t('preview.mindmap_redo')} size="sm" onClick={() => session.redo()}>
                <Redo2 size={15}/>
              </IconButton>
            </Tooltip>
          </>
          )}
          <Tooltip label={t('preview.mindmap_fit')}>
            <IconButton label={t('preview.mindmap_fit')} size="sm" onClick={() => session.fit()}>
              <Expand size={15}/>
            </IconButton>
          </Tooltip>
          <Tooltip label={t('preview.mindmap_center')}>
            <IconButton label={t('preview.mindmap_center')} size="sm" onClick={() => session.center()}>
              <Crosshair size={15}/>
            </IconButton>
          </Tooltip>
          <MindmapShortcutToggle isOpen={isShortcutsOpen} onToggle={onToggleShortcuts} buttonRef={shortcutButtonRef}/>
          <MindmapActionsButton isMenuOpen={isMenuOpen} onToggle={() => setMenuOpen((open) => !open)} buttonRef={buttonRef} menuItems={menuItems}/>
          <Tooltip label={t('preview.mindmap_exit_fullscreen')} combo="escape">
            <IconButton label={t('preview.mindmap_exit_fullscreen')} size="sm" onClick={onClose}>
              <X size={15}/>
            </IconButton>
          </Tooltip>
        </div>
      </header>
    );
}

/**
 * Full screen view of one block. On top of the library's own toolbar, context
 * menu and key bindings it adds the view controls, the shortcut reference and
 * the export/copy/convert actions, all acting on the same instance the preview
 * mounts — so edits keep writing back to the note exactly as they do inline.
 */
export function MindmapFullscreen({ session, onClose }: { session: MindmapSession; onClose: () => void }) {
    const bodyRef = useRef<HTMLDivElement>(null);
    const shortcutButtonRef = useRef<HTMLButtonElement>(null);
    const [isShortcutsOpen, setShortcutsOpen] = useState(false);
    const toast = useUi((state) => state.toast);
    useOverlaySession(session, bodyRef, onClose);

    const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
    const toggleShortcuts = useCallback(() => setShortcutsOpen((open) => !open), []);

    // While a topic is being edited the library consumes Escape to cancel that
    // edit (see the overlay hook exemption), so this only leaves full screen. The
    // reference card is the transient layer Escape puts away first; the header's
    // close button leaves full screen outright.
    const handleClose = useCallback(() => {
        if (session.isEditing())
            return;
        if (isShortcutsOpen) {
            closeShortcuts();
            return;
        }
        onClose();
    }, [closeShortcuts, isShortcutsOpen, onClose, session]);

    const actions = useMemo<MindmapActions>(() => ({
        copy: (text) => void copyBody(text, toast),
        convert: (mode) => convertBody(session, mode, toast),
        download: (kind) => void downloadBody(session, kind, toast),
        outline: (placement) => outlineBody(session, placement, toast, onClose),
    }), [onClose, session, toast]);

    return (
      <Modal open onClose={handleClose} variant="fullscreen" ariaLabel={session.title() || t('preview.mindmap')} className="mindmap-fullscreen" bodyClassName="mindmap-fullscreen-body">
        <MindmapHeader session={session} actions={actions} onClose={onClose} isShortcutsOpen={isShortcutsOpen} onToggleShortcuts={toggleShortcuts} shortcutButtonRef={shortcutButtonRef}/>
        <div className="mindmap-fullscreen-stage">
          <div ref={bodyRef} className="mindmap-fullscreen-canvas"/>
          <MindmapShortcuts open={isShortcutsOpen} onClose={closeShortcuts} anchor={shortcutButtonRef}/>
        </div>
      </Modal>
    );
}
