import { memo, useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Clock, Columns2, Download, Eye, FileText, FolderPlus, Hash, Keyboard, LayoutTemplate, ListTree, Moon, Palette, Pencil, Plus, Presentation, Search, Settings, Share2, Smile, Star, Sun, Trash2, Waypoints, X, } from 'lucide-react';
import type { NoteSummary, SearchHit } from '@shared/types';
import { truncateText } from '@shared/text-utils';
import { api } from '../../lib/api';
import { fuzzyFilter, splitByRanges, type FuzzyMatch } from '../../lib/fuzzy';
import { useDebounced, useNow } from '../../lib/hooks';
import { shortTime } from '../../lib/time';
import { IconButton, Kbd } from '../../components/primitives';
import { Tooltip, useDialogFocus, useEscape, useLockScroll } from '../../components/overlay';
import { useUi } from '../../store/ui';
import { createContextualNote, useNotes } from '../../store/notes';
import { folderPathLabel, openFolderView } from '../../lib/folders';
import { buildOutlineTree, stringifyOutline } from '../preview/outline-tree';
import { outlineHeadingsFor } from '../preview/outline-registry';
import { useSession } from '../../store/session';
import { openEmojiPicker } from '../../store/emoji-picker';
import { t, useLocale } from "../../lib/i18n";
import { APP_SHORTCUTS } from '../../lib/shortcuts';
import { usePinyinVersion } from '../../lib/pinyin'
interface Item {
    id: string;
    kind: 'command' | 'note' | 'tag' | 'folder';
    label: string;
    detail?: string;
    icon: React.ReactNode;
    combo?: string;
    group: string;
    score: number;
    match?: FuzzyMatch;
    run: () => void;
}
interface Cursor {
    index: number;
    fromPointer: boolean;
}
const ROW_CLASS = 'flex w-full items-center gap-2.5 rounded-[var(--r-md)] px-2.5 py-2 text-left';
const ROW_ACTIVE_CLASS = `${ROW_CLASS} bg-[var(--accent-soft)]`;
const ROW_ICON_CLASS = 'shrink-0 text-[var(--text-quaternary)]';
const ROW_ICON_ACTIVE_CLASS = 'shrink-0 text-[var(--accent)]';
export function CommandPalette({ onClose, initialQuery = '' }: {
    onClose: () => void;
    initialQuery?: string;
}) {
    const locale = useLocale();
    const [query, setQuery] = useState(initialQuery);
    const deferredQuery = useDeferredValue(query);
    const [cursor, setCursor] = useState<Cursor>({ index: 0, fromPointer: false });
    const [remote, setRemote] = useState<{
        query: string;
        results: SearchHit[];
    }>({ query: '', results: [] });
    const panelRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const labelId = useId();
    const listId = useId();
    const notes = useNotes((s) => s.notes);
    const tags = useNotes((s) => s.tags);
    const folders = useNotes((s) => s.folders);
    const openNote = useNotes((s) => s.openNote);
    const createFolder = useNotes((s) => s.createFolder);
    const deleteNote = useNotes((s) => s.deleteNote);
    const patchNote = useNotes((s) => s.patchNote);
    const activeNoteId = useUi((s) => s.activeNoteId);
    const activeNote = useNotes((s) => (activeNoteId ? s.notes[activeNoteId] ?? null : null));
    const recentNoteIds = useUi((s) => s.recentNoteIds);
    const openPanel = useUi((s) => s.openPanel);
    const toggleLocalGraph = useUi((s) => s.toggleLocalGraph);
    const openView = useUi((s) => s.openView);
    const sendOutlineCommand = useUi((s) => s.sendOutlineCommand);
    const toast = useUi((s) => s.toast);
    const appearanceTheme = useSession((s) => s.settings.appearance.theme);
    const updateSettings = useSession((s) => s.updateSettings);
    const debounced = useDebounced(query, 180);
    const now = useNow();
    useEscape(true, onClose);
    useLockScroll(true);
    useDialogFocus(true, panelRef, inputRef);
    const executeItem = useCallback((item: Item) => {
        onClose();
        item.run();
    }, [onClose]);
    const hoverItem = useCallback((index: number) => setCursor((current) => (current.index === index && current.fromPointer ? current : { index, fromPointer: true })), []);
    const moveCursor = useCallback((offset: number, length: number) => setCursor((current) => {
        const index = Math.max(0, Math.min(length - 1, current.index + offset));
        return index === current.index && !current.fromPointer ? current : { index, fromPointer: false };
    }), []);

    useEffect(() => {
        const text = debounced.trim();
        if (text.length < 2 || text.startsWith('>')) {
            setRemote({ query: text, results: [] });
            return;
        }
        const controller = new AbortController();
        api
            .search(text, 20, controller.signal)
            .then((res) => {
            setRemote({ query: text, results: res.results });
        })
            .catch((err) => {
            if ((err as Error)?.name !== 'AbortError')
                setRemote({ query: text, results: [] });
        });
        return () => controller.abort();
    }, [debounced]);
    const commands = useMemo<Omit<Item, 'score' | 'match'>[]>(() => {
        const isDark = document.documentElement.dataset.theme === 'dark';
        return [
            {
                id: 'cmd-new',
                kind: 'command',
                label: t("common.new_note"),
                icon: <Plus size={14}/>,
                combo: APP_SHORTCUTS.newNote,
                group: t("command.commands"),
                run: () => void createContextualNote(),
            },
            {
                id: 'cmd-new-from-template',
                kind: 'command',
                label: t("templates.new_note_from_template"),
                icon: <LayoutTemplate size={14}/>,
                combo: APP_SHORTCUTS.templates,
                group: t("command.commands"),
                run: () => openPanel('templates'),
            },
            {
                id: 'cmd-new-folder',
                kind: 'command',
                label: t("common.new_folder"),
                icon: <FolderPlus size={14}/>,
                group: t("command.commands"),
                run: () => void createFolder(),
            },
            {
                id: 'cmd-emoji',
                kind: 'command',
                label: t("command.open_emoji_picker"),
                icon: <Smile size={14}/>,
                combo: APP_SHORTCUTS.emoji,
                group: t("command.commands"),
                run: () => openEmojiPicker(),
            },
            ...(activeNote
                ? [
                    {
                        id: 'cmd-presentation-mode',
                        kind: 'command' as const,
                        label: t("workspace.presentation_mode"),
                        icon: <Presentation size={14}/>,
                        combo: APP_SHORTCUTS.present,
                        group: t("common.current_note"),
                        run: () => void import('../presentation').then((module) => module.startPresentationFromNote(activeNote.id)),
                    },
                    {
                        id: 'cmd-star',
                        kind: 'command' as const,
                        label: activeNote.isStarred ? t("command.remove_current_note_from_favorites") : t("command.add_current_note_to_favorites"),
                        icon: <Star size={14}/>,
                        combo: APP_SHORTCUTS.star,
                        group: t("common.current_note"),
                        run: () => void patchNote(activeNote.id, { isStarred: !activeNote.isStarred }),
                    },
                    {
                        id: 'cmd-archive',
                        kind: 'command' as const,
                        label: activeNote.isArchived ? t("common.unarchive") : t("command.archive_current_note"),
                        icon: <Archive size={14}/>,
                        group: t("common.current_note"),
                        run: () => void patchNote(activeNote.id, { isArchived: !activeNote.isArchived }),
                    },
                    {
                        id: 'cmd-share',
                        kind: 'command' as const,
                        label: t("command.share_current_note"),
                        icon: <Share2 size={14}/>,
                        group: t("common.current_note"),
                        run: () => openPanel('share'),
                    },
                    {
                        id: 'cmd-delete',
                        kind: 'command' as const,
                        label: t("command.move_the_current_note_to_trash"),
                        icon: <Trash2 size={14}/>,
                        group: t("common.current_note"),
                        run: () => void deleteNote(activeNote.id),
                    },
                    {
                        id: 'cmd-outline-copy',
                        kind: 'command' as const,
                        label: t("command.copy_outline_as_text"),
                        icon: <ListTree size={14}/>,
                        group: t("common.current_note"),
                        run: () => {
                            const headings = outlineHeadingsFor(activeNote.id);
                            if (headings.length === 0) {
                                toast({ title: t("command.outline_empty") });
                                return;
                            }
                            void navigator.clipboard.writeText(stringifyOutline(buildOutlineTree(headings), { numbering: false, indent: '\t' }));
                            toast({ title: t("command.outline_copied", { count: headings.length }), tone: 'success' });
                        },
                    },
                    {
                        id: 'cmd-outline-copy-numbered',
                        kind: 'command' as const,
                        label: t("command.copy_outline_numbered"),
                        icon: <ListTree size={14}/>,
                        group: t("common.current_note"),
                        run: () => {
                            const headings = outlineHeadingsFor(activeNote.id);
                            if (headings.length === 0) {
                                toast({ title: t("command.outline_empty") });
                                return;
                            }
                            void navigator.clipboard.writeText(stringifyOutline(buildOutlineTree(headings), { numbering: true, indent: '' }));
                            toast({ title: t("command.outline_copied", { count: headings.length }), tone: 'success' });
                        },
                    },
                    {
                        id: 'cmd-outline-focus-search',
                        kind: 'command' as const,
                        label: t("command.outline_focus_search"),
                        icon: <Search size={14}/>,
                        group: t("common.interface"),
                        run: () => { sendOutlineCommand('focus-search'); },
                    },
                    {
                        id: 'cmd-outline-level-up',
                        kind: 'command' as const,
                        label: t("command.outline_level_up"),
                        icon: <ListTree size={14}/>,
                        group: t("common.interface"),
                        run: () => { sendOutlineCommand('level-up'); },
                    },
                    {
                        id: 'cmd-outline-level-down',
                        kind: 'command' as const,
                        label: t("command.outline_level_down"),
                        icon: <ListTree size={14}/>,
                        group: t("common.interface"),
                        run: () => { sendOutlineCommand('level-down'); },
                    },
                    {
                        id: 'cmd-outline-reset-level',
                        kind: 'command' as const,
                        label: t("command.outline_reset_level"),
                        icon: <ListTree size={14}/>,
                        group: t("common.interface"),
                        run: () => { sendOutlineCommand('reset-level'); },
                    },
                ]
                : []),
            {
                id: 'cmd-layout-edit',
                kind: 'command',
                label: t("workspace.live_preview"),
                icon: <Pencil size={14}/>,
                group: t("common.interface"),
                run: () => void updateSettings({ preview: { layout: 'live' } }),
            },
            {
                id: 'cmd-layout-split',
                kind: 'command',
                label: t("command.layout_split_view"),
                icon: <Columns2 size={14}/>,
                group: t("common.interface"),
                run: () => void updateSettings({ preview: { layout: 'split' } }),
            },
            {
                id: 'cmd-layout-preview',
                kind: 'command',
                label: t("workspace.reading_mode"),
                icon: <Eye size={14}/>,
                group: t("common.interface"),
                run: () => void updateSettings({ preview: { layout: 'preview' } }),
            },
            {
                id: 'cmd-theme',
                kind: 'command',
                label: isDark ? t("command.switch_to_light_theme") : t("command.switch_to_dark_theme"),
                icon: isDark ? <Sun size={14}/> : <Moon size={14}/>,
                group: t("common.interface"),
                run: () => void updateSettings({ appearance: { theme: isDark ? 'light' : 'dark' } }),
            },
            {
                id: 'cmd-accent',
                kind: 'command',
                label: t("command.change_accent_color"),
                icon: <Palette size={14}/>,
                group: t("common.interface"),
                run: () => openPanel('settings'),
            },
            {
                id: 'cmd-graph',
                kind: 'command',
                label: t("command.open_graph"),
                icon: <Waypoints size={14}/>,
                combo: APP_SHORTCUTS.graph,
                group: t("common.interface"),
                run: () => openPanel('graph'),
            },
            {
                id: 'cmd-local-graph',
                kind: 'command',
                label: t("command.open_local_graph"),
                icon: <Waypoints size={14}/>,
                group: t("common.interface"),
                run: () => { if (useUi.getState().activeNoteId) toggleLocalGraph(); },
            },
            {
                id: 'cmd-settings',
                kind: 'command',
                label: t("common.open_settings"),
                icon: <Settings size={14}/>,
                combo: APP_SHORTCUTS.settings,
                group: t("command.commands"),
                run: () => openPanel('settings'),
            },
            {
                id: 'cmd-shortcuts',
                kind: 'command',
                label: t("command.keyboard_shortcuts"),
                icon: <Keyboard size={14}/>,
                combo: APP_SHORTCUTS.shortcuts,
                group: t("command.commands"),
                run: () => openPanel('shortcuts'),
            },
            {
                id: 'cmd-export',
                kind: 'command',
                label: t("command.export_all_notes_zip"),
                icon: <Download size={14}/>,
                group: t("command.commands"),
                run: () => void api.transfer.save('zip').catch((error) => {
                    useUi.getState().toast({
                        title: t("common.export_failed"),
                        description: error instanceof Error ? error.message : String(error),
                        tone: 'danger',
                    });
                }),
            },
            {
                id: 'cmd-trash',
                kind: 'command',
                label: t("command.open_trash"),
                icon: <Trash2 size={14}/>,
                group: t("common.navigation"),
                run: () => openView('trash'),
            },
            {
                id: 'cmd-starred',
                kind: 'command',
                label: t("command.open_favorites"),
                icon: <Star size={14}/>,
                group: t("common.navigation"),
                run: () => openView('starred'),
            },
        ];
    }, [
        activeNote,
        appearanceTheme,
        locale,
        createFolder,
        deleteNote,
        openPanel,
        openView,
        patchNote,
        updateSettings,
    ]);
    const folderMatchData = useMemo(() => {
        const folderCounts = new Map<string, number>();
        const folderById = new Map(folders.map((folder) => [folder.id, folder]));
        for (const note of Object.values(notes)) {
            if (!note.folderId || note.deletedAt || note.isArchived)
                continue;
            let currentId: string | null = note.folderId;
            const seenFolders = new Set<string>();
            while (currentId && !seenFolders.has(currentId)) {
                seenFolders.add(currentId);
                folderCounts.set(currentId, (folderCounts.get(currentId) ?? 0) + 1);
                currentId = folderById.get(currentId)?.parentId ?? null;
            }
        }
        const folderChoices = folders.map((folder) => ({ folder, path: folderPathLabel(folders, folder.id) }));
        return { folderCounts, folderChoices };
    }, [notes, folders]);
    const pinyinVersion = usePinyinVersion()
    const items = useMemo<Item[]>(() => {
        const text = deferredQuery.trim();
        if (text.startsWith('>')) {
            const term = text.slice(1).trim();
            return term
                ? fuzzyFilter(commands, term, (item) => item.label, 40).map<Item>(({ item, match }) => ({ ...item, score: match.score, match }))
                : commands.map<Item>((item) => ({ ...item, score: 0 }));
        }
        const remoteResults = remote.query === text ? remote.results : [];
        if (!text) {

            const recent = recentNoteIds
                .map((id) => notes[id])
                .filter((n): n is NoteSummary => Boolean(n && !n.deletedAt))
                .slice(0, 6)
                .map<Item>((note) => ({
                id: `note-${note.id}`,
                kind: 'note',
                label: note.title || t("common.untitled_note"),
                detail: shortTime(note.updatedAt, now),
                icon: <Clock size={14}/>,
                group: t("command.recently_opened"),
                score: 0,
                run: () => void openNote(note.id),
            }));
            const quick = commands
                .filter((c) => ['cmd-new', 'cmd-settings', 'cmd-graph', 'cmd-shortcuts'].includes(c.id))
                .map<Item>((c) => ({ ...c, score: 0 }));
            return [...recent, ...quick];
        }
        const noteList = Object.values(notes).filter((n) => !n.deletedAt);
        const matchedCommands = fuzzyFilter(commands, text, (c) => c.label, 8).map<Item>(({ item, match }) => ({ ...item, score: match.score + 60, match }));
        const matchedNotes = fuzzyFilter(noteList, text, (n) => n.title, 14).map<Item>(({ item, match }) => ({
            id: `note-${item.id}`,
            kind: 'note',
            label: item.title || t("common.untitled_note"),
            detail: truncateText(item.excerpt, 60),
            icon: <FileText size={14}/>,
            group: t("common.note"),
            score: match.score + 20,
            match,
            run: () => void openNote(item.id),
        }));
        const seen = new Set(matchedNotes.map((n) => n.id));
        const fullText = remoteResults
            .filter((hit) => !seen.has(`note-${hit.note.id}`))
            .slice(0, 8)
            .map<Item>((hit) => ({
            id: `note-${hit.note.id}`,
            kind: 'note',
            label: hit.note.title || t("common.untitled_note"),
            detail: hit.snippet,
            icon: <Search size={14}/>,
            group: t("command.content_match"),
            score: 10,
            run: () => void openNote(hit.note.id),
        }));
        const matchedTags = fuzzyFilter(tags, text, (t) => t.name, 5).map<Item>(({ item, match }) => ({
            id: `tag-${item.id}`,
            kind: 'tag',
            label: `#${item.name}`,
            detail: t("common.value0_notes", { value0: item.count }),
            icon: <Hash size={14} style={{ color: item.color ?? undefined }}/>,
            group: t("navigation.tag"),
            score: match.score,
            run: () => openView('tag', { tag: item.name }),
        }));
        const { folderCounts, folderChoices } = folderMatchData;
        const matchedFolders = fuzzyFilter(folderChoices, text, (choice) => choice.path, 5).map<Item>(({ item: choice, match }) => ({
            id: `folder-${choice.folder.id}`,
            kind: 'folder',
            label: choice.path,
            detail: t("common.value0_notes", { value0: folderCounts.get(choice.folder.id) ?? 0 }),
            icon: <FolderPlus size={14}/>,
            group: t("navigation.folder"),
            score: match.score,
            run: () => openFolderView(folders, choice.folder.id),
        }));
        const all = [...matchedCommands, ...matchedNotes, ...fullText, ...matchedTags, ...matchedFolders];
        if (!all.length) {
            all.push({
                id: 'create-with-title',
                kind: 'command',
                label: t("command.create_note_value0", { value0: text }),
                icon: <Plus size={14}/>,
                group: t("command.commands"),
                score: 0,
                run: () => void createContextualNote({ title: text }),
            });
        }
        return all.sort((a, b) => b.score - a.score).slice(0, 40);
    }, [
        deferredQuery,    pinyinVersion,
        folderMatchData,
        locale,
        notes,
        tags,
        folders,
        commands,
        remote,
        recentNoteIds,
        openNote,
        openView,
        now,
    ]);
    const groups = useMemo(() => {
        const map = new Map<string, Item[]>();
        for (const item of items) {
            const list = map.get(item.group) ?? [];
            list.push(item);
            map.set(item.group, list);
        }
        return [...map.entries()];
    }, [items]);
    useEffect(() => setCursor({ index: 0, fromPointer: false }), [query]);
    useEffect(() => {
        setCursor((current) => {
            const index = items.length ? Math.min(current.index, items.length - 1) : 0;
            return index === current.index && !current.fromPointer ? current : { index, fromPointer: false };
        });
    }, [items.length]);
    useEffect(() => {
        // The pointer already sits on its row; scrolling would move other rows under it and
        // re-trigger the highlight, so only keyboard movement scrolls.
        if (cursor.fromPointer) return;
        const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor.index}"]`);
        el?.scrollIntoView({ block: 'nearest' });
    }, [cursor]);
    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.nativeEvent.isComposing) return;
        const ctrlNavigation = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
        if (event.key === 'ArrowDown' || (event.key === 'n' && ctrlNavigation)) {
            event.preventDefault();
            moveCursor(1, items.length);
        }
        else if (event.key === 'ArrowUp' || (event.key === 'p' && ctrlNavigation)) {
            event.preventDefault();
            moveCursor(-1, items.length);
        }
        else if (event.key === 'Enter') {
            event.preventDefault();
            const item = items[cursor.index];
            if (item)
                executeItem(item);
        }
    };
    let flatIndex = -1;
    return createPortal(<div className="app-viewport-fixed fixed z-[240] flex items-end justify-center md:items-start md:px-4 md:pt-[13vh]">
      <div className="anim-fade absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden="true"/>

      <div ref={panelRef} className="anim-pop relative flex h-[min(82dvh,var(--app-viewport-height,100dvh))] w-full max-w-[660px] flex-col overflow-hidden rounded-t-[var(--r-2xl)] border border-b-0 border-[var(--border-default)] bg-[var(--bg-overlay)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-modal)] outline-none md:h-auto md:rounded-[var(--r-2xl)] md:border-b md:pb-0" role="dialog" aria-modal="true" aria-labelledby={labelId} tabIndex={-1}>
        <h2 id={labelId} className="sr-only">{t("common.search_notes_or_run_a_command")}</h2>
        <div className="flex items-center gap-2.5 border-b border-[var(--border-subtle)] px-4">
          <Search size={16} className="shrink-0 text-[var(--text-quaternary)]"/>
          <input ref={inputRef} role="combobox" aria-label={t("common.search_notes_or_run_a_command")} aria-expanded="true" aria-controls={listId} aria-activedescendant={items[cursor.index] ? `${listId}-option-${cursor.index}` : undefined} aria-autocomplete="list" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} placeholder={t("command.search_notes_or_type_a_command")} className="h-[52px] flex-1 bg-transparent text-[15px] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] focus:outline-none"/>
          <span className="hidden md:inline-flex"><Kbd keys={['Esc']}/></span>
          <span className="md:hidden">
            <Tooltip label={t("common.close")} side="left">
              <IconButton label={t("common.close")} size="sm" onClick={onClose}>
                <X size={16}/>
              </IconButton>
            </Tooltip>
          </span>
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-labelledby={labelId} className="min-h-0 flex-1 overflow-y-auto p-1.5 md:max-h-[54vh] md:flex-none">
          {groups.length === 0 ? (<div className="px-3 py-10 text-center text-[12.5px] text-[var(--text-quaternary)]">{t("command.no_matching_results")}</div>) : (groups.map(([group, groupItems]) => (<div key={group} role="group" aria-label={group} className="mb-1">
                <div className="px-2.5 pt-2 pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
                  {group}
                </div>
                {groupItems.map((item) => {
                flatIndex++;
                return (<PaletteRow key={item.id} item={item} index={flatIndex} active={flatIndex === cursor.index} listId={listId} onHover={hoverItem} onInvoke={executeItem}/>);
            })}
              </div>)))}
        </div>

        <div className="hidden items-center gap-4 border-t border-[var(--border-subtle)] px-4 py-2 text-[10.5px] text-[var(--text-quaternary)] md:flex">
          <span className="flex items-center gap-1.5">
            <Kbd keys={['↑', '↓']}/>{t("command.select")}</span>
          <span className="flex items-center gap-1.5">
            <Kbd keys={['↵']}/>{t("common.open")}</span>
          <span className="flex items-center gap-1.5">
            <Kbd keys={['Esc']}/>{t("common.close")}</span>
        </div>
      </div>
    </div>, document.body);
}
const PaletteRow = memo(function PaletteRow({ item, index, active, listId, onHover, onInvoke, }: {
    item: Item;
    index: number;
    active: boolean;
    listId: string;
    onHover: (index: number) => void;
    onInvoke: (item: Item) => void;
}) {
    const parts = item.match ? splitByRanges(item.label, item.match.ranges) : null;
    return (<button id={`${listId}-option-${index}`} type="button" role="option" aria-selected={active} tabIndex={-1} data-index={index} onMouseEnter={() => onHover(index)} onClick={() => onInvoke(item)} className={active ? ROW_ACTIVE_CLASS : ROW_CLASS}>
        <span className={active ? ROW_ICON_ACTIVE_CLASS : ROW_ICON_CLASS}>
          {item.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-[var(--text-primary)]">
            {parts
          ? parts.map((part, i) => part.hit ? (<mark key={i} className="ink-hit">
                    {part.text}
                  </mark>) : (<span key={i}>{part.text}</span>))
          : item.label}
          </span>
          {item.detail && (<span className="mt-0.5 block truncate text-[11px] text-[var(--text-quaternary)]">
              {item.detail}
            </span>)}
        </span>
        {item.combo && <Kbd combo={item.combo}/>}
      </button>);
});
