import { APP_SHORTCUTS } from '../../lib/shortcuts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowDown, ArrowUp, ChevronRight, ChevronsDownUp, ChevronsUpDown, Clock, CornerUpLeft, Download, FilePlus2, FileText, FolderInput, FolderPlus, Hash, Inbox, LogOut, Moon, MoreHorizontal, Palette, PanelLeft, PanelLeftClose, Pencil, Plus, Settings, Settings2, Smile, SortAsc, Star, Sun, Trash2, Waypoints, } from 'lucide-react';
import { LIMITS } from '@shared/constants';
import type { NoteSummary, Tag, ViewKind } from '@shared/types';
import { compareTagNames } from '@shared/markdown-utils';
import { cn } from '../../lib/cn';
import { numericCollator } from '../../lib/collator';
import { Avatar, IconButton, Logo, SectionLabel } from '../../components/primitives';
import { Menu, Tooltip, confirm, useContextMenu, type MenuItem } from '../../components/overlay';
import { switchThemeWithTransition, useUi } from '../../store/ui';
import { useSession } from '../../store/session';
import { useUpdate } from '../../store/update';
import { createContextualNote, useFolderTree, useNavigationCounts, useNotes, type FolderNode } from '../../store/notes';
import { folderDescendantIds, folderPath, folderPathLabel, openFolderView } from '../../lib/folders';
import { setInboxFolderId, useFolderPreferences } from '../../lib/folder-prefs';
import { saveCalendarPrefs, useCalendarTreePreferences } from '../../lib/calendar-prefs';
import { exportFolderAsZip } from '../../lib/export-folder';
import { FOLDER_DRAG_TYPE, isNoteDrag, leftDropTarget, moveNotesToFolder, readDraggedNoteIds, restoreNoteFolders } from '../../lib/note-drag';
import { FolderPicker } from '../folders/FolderPicker';
import { FolderColorMenu, FolderIconMenu } from '../folders/FolderAppearanceMenus';
import { collapseOrLeave, expandOrReveal, moveTreeFocus } from './tree-keyboard';
import { TagAppearance } from '../tags/TagAppearance';
import { createTag, deleteTag, renameTag, setTagColor } from '../tags/tagMutations';
import { t, useLocale } from "../../lib/i18n";
import { SearchButton } from '../shell/SearchButton';
import { ExplorerNote, groupExplorerNotes } from './ExplorerNote';
import { FolderMotionIcon } from './FolderMotionIcon';
import { useTreeChildrenMount } from './useTreeChildrenMount';
import { CalendarTree, InboxTree, TodoTree } from './virtual-tree';
import { SidebarCalendar } from './sidebar-calendar';
import { useBreakpoint } from '../../lib/hooks';
export function Sidebar({ collapsed = false, onCollapse, }: {
    collapsed?: boolean;
    onCollapse?: () => void;
}) {
    const view = useUi((s) => !s.listCollapsed && !s.searchList ? s.view : null);
    const openView = useUi((s) => s.openView);
    const counts = useNavigationCounts();
    return (<>
        {collapsed ? <SidebarRail onExpand={onCollapse}/> : (<aside className="flex h-full min-h-0 flex-col bg-[var(--bg-sunken)]">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3">
        <div className="flex min-w-0 items-center gap-[9px] select-none">
          <Logo size={24}/>
          <span className="min-w-0 truncate font-serif text-[15.5px] font-semibold tracking-[0.02em] text-[var(--text-primary)]">
            {t("common.product_name")}
          </span>
        </div>
        {onCollapse && (<Tooltip label={t("sidebar.collapse_navigation")}>
            <IconButton label={t("sidebar.collapse_navigation")} size="sm" onClick={onCollapse}>
              <PanelLeftClose size={15}/>
            </IconButton>
          </Tooltip>)}
      </header>

      <div className="shrink-0 px-2 pt-2"><SearchButton /></div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4">
        <SidebarCalendar />
        <div className="space-y-px">
          <ViewItem icon={<FileText size={14}/>} label={t("navigation.all_notes")} view="all" count={counts.all} active={view === 'all'} onSelect={openView}/>
          <ViewItem icon={<Clock size={14}/>} label={t("navigation.recently_edited")} view="recent" active={view === 'recent'} onSelect={openView}/>
          <ViewItem icon={<Star size={14}/>} label={t("navigation.favorites")} view="starred" count={counts.starred} active={view === 'starred'} onSelect={openView}/>
          <ViewItem icon={<Inbox size={14}/>} label={t("navigation.unfiled")} view="unfiled" count={counts.unfiled} active={view === 'unfiled'} onSelect={openView}/>
        </div>

        <FolderSection />
        <TagSection />
      </div>

      <div className="shrink-0 space-y-px border-t border-[var(--border-subtle)] px-2 py-2">
        <ViewItem icon={<Archive size={14}/>} label={t("navigation.archive")} view="archived" count={counts.archived} active={view === 'archived'} onSelect={openView}/>
        <ViewItem icon={<Trash2 size={14}/>} label={t("navigation.trash")} view="trash" count={counts.trash} active={view === 'trash'} onSelect={openView}/>
      </div>

      <div className="shrink-0 border-t border-[var(--border-subtle)] p-2">
        <SidebarAccount />
      </div>
        </aside>)}
    </>);
}
function SidebarRail({ onExpand }: {
    onExpand?: () => void;
}) {
    const view = useUi((s) => !s.listCollapsed && !s.searchList ? s.view : null);
    const openView = useUi((s) => s.openView);
    return (<aside className="flex h-full min-h-0 flex-col items-center bg-[var(--bg-sunken)]">
      <div className="flex h-11 w-full shrink-0 items-center justify-center border-b border-[var(--border-subtle)]">
        <Tooltip label={t("sidebar.expand_navigation")} side="right">
          <IconButton label={t("sidebar.expand_navigation")} onClick={onExpand}>
            <PanelLeft size={16}/>
          </IconButton>
        </Tooltip>
      </div>

      <div className="flex w-full flex-col items-center gap-1 py-2">
        <SearchButton variant="icon" />
        <RailButton label={t("navigation.all_notes")} active={view === 'all'} icon={<FileText size={16}/>} onClick={() => openView('all')}/>
        <RailButton label={t("navigation.favorites")} active={view === 'starred'} icon={<Star size={16}/>} onClick={() => openView('starred')}/>
        <RailButton label={t("navigation.trash")} active={view === 'trash'} icon={<Trash2 size={16}/>} onClick={() => openView('trash')}/>
        <div className="my-1 h-px w-6 bg-[var(--border-subtle)]"/>
        <RailButton label={t("common.new_note")} combo={APP_SHORTCUTS.newNote} accent icon={<FilePlus2 size={16}/>} onClick={() => void createContextualNote()}/>
      </div>

      <span className="flex-1"/>

      <div className="flex w-full shrink-0 justify-center border-t border-[var(--border-subtle)] py-2">
        <SidebarAccount rail/>
      </div>
    </aside>);
}
function RailButton({ label, combo, icon, active, accent, onClick, }: {
    label: string;
    combo?: string;
    icon: React.ReactNode;
    active?: boolean;
    accent?: boolean;
    onClick: () => void;
}) {
    return (<Tooltip label={label} combo={combo} side="right">
      <IconButton label={label} active={active} onClick={onClick} className={accent ? 'text-[var(--accent)]' : undefined}>
        {icon}
      </IconButton>
    </Tooltip>);
}
function SidebarAccount({ rail = false }: {
    rail?: boolean;
}) {
    const user = useSession((s) => s.user);
    const theme = useSession((s) => s.settings.appearance.theme);
    const updateSettings = useSession((s) => s.updateSettings);
    const logout = useSession((s) => s.logout);
    const openPanel = useUi((s) => s.openPanel);
    const updateAvailable = useUpdate((s) => s.available);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    if (!user)
        return null;
    const isDark = theme === 'dark' ||
        (theme === 'system' && document.documentElement.dataset.theme === 'dark');
    const displayName = user.name || user.username;
    const items: MenuItem[] = [
        {
            id: 'settings',
            label: t("common.settings"),
            icon: <SettingsIcon size={13} showDot={user.role === 'owner' && updateAvailable}/>,
            combo: APP_SHORTCUTS.settings,
            onSelect: () => openPanel('settings'),
        },
        {
            id: 'graph',
            label: t("common.graph"),
            icon: <Waypoints size={13}/>,
            onSelect: () => openPanel('graph'),
        },
        {
            id: 'theme',
            label: isDark ? t("sidebar.switch_to_light") : t("sidebar.switch_to_dark"),
            icon: isDark ? <Sun size={13}/> : <Moon size={13}/>,
            separatorBefore: true,
            onSelect: () => {
                const rect = buttonRef.current?.getBoundingClientRect();
                const next = isDark ? 'light' : 'dark';
                switchThemeWithTransition(next, rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : undefined, () => updateSettings({ appearance: { theme: next } }));
            },
        },
        {
            id: 'logout',
            label: t("sidebar.log_out"),
            icon: <LogOut size={13}/>,
            tone: 'danger',
            separatorBefore: true,
            onSelect: () => void logout(),
        },
    ];
    return (<>
      {rail ? (<Tooltip label={`${t("sidebar.account_and_settings")} · ${displayName}`} side="right">
          <button ref={buttonRef} type="button" onClick={() => setMenuOpen(true)} aria-label={t("sidebar.account_and_settings")} className="rounded-full transition-transform duration-[var(--dur-fast)] hover:scale-105 active:scale-95">
            <Avatar src={user.avatarUrl} name={displayName} size={28}/>
          </button>
        </Tooltip>) : (<div className="group flex h-11 w-full items-center rounded-[var(--r-md)] transition-colors hover:bg-[var(--bg-hover)]">
          <button ref={buttonRef} type="button" onClick={() => setMenuOpen(true)} aria-label={t("sidebar.account_and_settings")} className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-l-[var(--r-md)] pl-2 text-left">
            <Avatar src={user.avatarUrl} name={displayName} size={28}/>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-semibold text-[var(--text-primary)]">
                {displayName}
              </span>
              <span className="block truncate text-[10.5px] text-[var(--text-quaternary)]">
                @{user.username}
              </span>
            </span>
          </button>
          <Tooltip label={t("common.settings")} side="top">
            <IconButton label={t("common.settings")} size="sm" onClick={() => openPanel('settings')} className="mr-1 shrink-0 text-[var(--text-quaternary)] group-hover:text-[var(--text-tertiary)]">
              <SettingsIcon size={14} showDot={user.role === 'owner' && updateAvailable}/>
            </IconButton>
          </Tooltip>
        </div>)}

      <Menu anchor={buttonRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} width={252}/>
    </>);
}
function SettingsIcon({ size, showDot }: {
    size: number;
    showDot: boolean;
}) {
    return (<span className="relative inline-flex">
      <Settings size={size}/>
      {showDot && (<span data-update-dot aria-hidden="true" className="absolute -top-1 -right-1 size-2 rounded-full border border-[var(--bg-sunken)] bg-[var(--danger)]"/>)}
    </span>);
}
function ViewItem({ icon, label, view, count, active, onSelect, }: {
    icon: React.ReactNode;
    label: string;
    view: ViewKind;
    count?: number;
    active: boolean;
    onSelect: (view: ViewKind) => void;
}) {
    const [dropping, setDropping] = useDropState(false);
    const patchNote = useNotes((s) => s.patchNote);
    const toast = useUi((s) => s.toast);
    const acceptsDrop = view === 'unfiled' || view === 'starred' || view === 'archived' || view === 'trash';
    const deleteNote = useNotes((s) => s.deleteNote);
    return (<button type="button" aria-current={active ? 'page' : undefined} onClick={() => onSelect(view)} onDragOver={(e) => {
            if (!acceptsDrop || !isNoteDrag(e))
                return;
            e.preventDefault();
            setDropping(true);
        }} onDragLeave={(e) => {
            if (leftDropTarget(e))
                setDropping(false);
        }} onDrop={(e) => {
            setDropping(false);
            const ids = readDraggedNoteIds(e);
            if (ids.length === 0)
                return;
            e.preventDefault();
            if (view === 'unfiled') {
                void (async () => {
                    const previous = await moveNotesToFolder(ids, null);
                    if (previous.length === 0)
                        return;
                    toast({
                        title: t("folders.moved_value0_to_value1", { value0: previous.length, value1: t("navigation.unfiled") }),
                        tone: 'success',
                        action: { label: t("common.undo"), run: () => void restoreNoteFolders(previous) },
                    });
                })();
                return;
            }
            void (async () => {
                for (const id of ids) {
                    if (view === 'starred')
                        await patchNote(id, { isStarred: true });
                    else if (view === 'archived')
                        await patchNote(id, { isArchived: true });
                    else if (view === 'trash')
                        await deleteNote(id);
                }
            })();
        }} className={cn('group relative flex h-10 w-full items-center gap-2.5 rounded-[var(--r-md)] px-2 text-left md:h-[30px]', 'transition-colors duration-[var(--dur-fast)]', active
            ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]', dropping && 'ring-1 ring-[var(--accent)]')}>
      <span className={cn('shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{label}</span>
      {count != null && count > 0 && (<span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)]">{count}</span>)}
    </button>);
}
export function FolderSection({ mobile = false }: { mobile?: boolean }) {
    const locale = useLocale();
    const canOpenToSide = useBreakpoint() === 'desktop';
    const tree = useFolderTree();
    const folders = useNotes((s) => s.folders ?? []);
    const notes = useNotes((s) => s.notes);
    const notesByFolder = useMemo(() => groupExplorerNotes(notes, folders, locale), [notes, folders, locale]);
    const activeNoteId = useUi((s) => s.activeNoteId);
    const activeFolderId = activeNoteId ? notes[activeNoteId]?.folderId : null;
    useEffect(() => {
        const path = folderPath(folders, activeFolderId ?? null);
        for (const folder of path) useUi.getState().expandFolder(folder.id);
    }, [activeNoteId, activeFolderId, folders]);
    const createFolder = useNotes((s) => s.createFolder);
    const patchFolder = useNotes((s) => s.patchFolder);
    const expandFolder = useUi((s) => s.expandFolder);
    const expandedFolders = useUi((s) => s.expandedFolders);
    const openPanel = useUi((s) => s.openPanel);
    const toast = useUi((s) => s.toast);
    const [creating, setCreating] = useState(false);
    const creatingRef = useRef(false);
    const createdTimerRef = useRef<number>(0);
    const [createdFolderId, setCreatedFolderId] = useState<string | null>(null);
    const movingIdsRef = useRef(new Set<string>());
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [movingId, setMovingId] = useState<string | null>(null);
    const [rootDropping, setRootDropping] = useDropState(false);
    const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
    const headerRef = useRef<HTMLDivElement>(null);
    const headerMenu = useContextMenu();
    const { inboxFolderId } = useFolderPreferences();
    const { calendarVisible, todoVisible, inboxVisible } = useCalendarTreePreferences();
    useEffect(() => () => window.clearTimeout(createdTimerRef.current), []);
    const create = (parentId: string | null) => {
        if (creatingRef.current)
            return;
        creatingRef.current = true;
        setCreating(true);
        const startingUi = useUi.getState();
        const startingNavigation = {
            view: startingUi.view,
            folderId: startingUi.folderId,
            tag: startingUi.tag,
            activeNoteId: startingUi.activeNoteId,
        };
        try {
            const folderId = createFolder({ parentId });
            if (!folderId)
                return;
            window.clearTimeout(createdTimerRef.current);
            setCreatedFolderId(folderId);
            createdTimerRef.current = window.setTimeout(() => setCreatedFolderId(null), 1000);
            const currentUi = useUi.getState();
            if (currentUi.view === startingNavigation.view &&
                currentUi.folderId === startingNavigation.folderId &&
                currentUi.tag === startingNavigation.tag &&
                currentUi.activeNoteId === startingNavigation.activeNoteId) {
                if (parentId)
                    expandFolder(parentId);
                if (!mobile) useUi.getState().openExplorer(folderId);
                setRenamingId(folderId);
            }
        }
        finally {
            queueMicrotask(() => {
                creatingRef.current = false;
                setCreating(false);
            });
        }
    };
    const move = (id: string, parentId: string | null, beforeId: string | null) => {
        if (movingIdsRef.current.has(id))
            return false;
        movingIdsRef.current.add(id);
        try {
            if (!patchFolder(id, { parentId, beforeId }))
                return false;
            if (parentId)
                expandFolder(parentId);
            return true;
        }
        catch {
            return false;
        }
        finally {
            movingIdsRef.current.delete(id);
        }
    };
    const movingFolder = movingId ? folders.find((folder) => folder.id === movingId) ?? null : null;
    const excludedMoveTargets = useMemo(() => {
        if (!movingId)
            return undefined;
        const excluded = folderDescendantIds(folders, movingId);
        const movingDepth = Math.max(0, folderPath(folders, movingId).length - 1);
        const relativeSubtreeDepth = Math.max(0, ...[...excluded].map((id) => Math.max(0, folderPath(folders, id).length - 1 - movingDepth)));
        for (const candidate of folders) {
            const movedRootDepth = folderPath(folders, candidate.id).length;
            if (movedRootDepth + relativeSubtreeDepth >= LIMITS.folderDepthMax)
                excluded.add(candidate.id);
        }
        return excluded;
    }, [folders, movingId]);
    const parentFolderIds = useMemo(() => folders
        .filter((folder) => folders.some((child) => child.parentId === folder.id))
        .map((folder) => folder.id), [folders]);
    const allExpanded = parentFolderIds.length > 0 && parentFolderIds.every((id) => expandedFolders.includes(id));
    const toggleAllExpanded = () => {
        if (allExpanded)
            useUi.setState((state) => ({ expandedFolders: state.expandedFolders.filter((id) => !parentFolderIds.includes(id)) }));
        else
            useUi.setState((state) => ({ expandedFolders: [...new Set([...state.expandedFolders, ...parentFolderIds])] }));
    };
    const sortSiblings = (ordered: FolderNode[]) => {
        const collator = numericCollator(locale);
        const target = [...ordered].sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
        if (target.every((node, index) => node.id === ordered[index]?.id))
            return;
        for (const node of target)
            patchFolder(node.id, { beforeId: null });
        toast({ title: t("folders.sorted_by_name"), tone: 'success' });
    };
    const dropNotes = (noteIds: string[], folderId: string | null) => {
        void (async () => {
            const previous = await moveNotesToFolder(noteIds, folderId);
            if (previous.length === 0)
                return;
            const name = folderId ? folders.find((folder) => folder.id === folderId)?.name ?? '' : t("navigation.unfiled");
            toast({
                title: t("folders.moved_value0_to_value1", { value0: previous.length, value1: name }),
                tone: 'success',
                action: { label: t("common.undo"), run: () => void restoreNoteFolders(previous) },
            });
        })();
    };
    const exportZip = (node: FolderNode) => {
        toast({ title: t("folders.export_zip_preparing"), tone: 'default' });
        void exportFolderAsZip(node.id).then((result) => {
            toast({
                title: result.count === 0 ? t("folders.export_zip_empty") : t("folders.export_zip_success", { value0: result.count }),
                tone: result.count === 0 ? 'default' : 'success',
            });
        }, () => toast({ title: t("common.export_failed"), tone: 'danger' }));
    };
    const toggleInbox = (node: FolderNode) => {
        if (inboxFolderId === node.id) {
            setInboxFolderId(null);
            toast({ title: t("folders.inbox_cleared_toast"), tone: 'default' });
            return;
        }
        setInboxFolderId(node.id);
        toast({ title: t("folders.inbox_set_toast", { value0: node.name }), tone: 'success' });
    };
    const headerMenuItems: MenuItem[] = [
        { id: 'new-folder', label: t("common.new_folder"), icon: <FolderPlus size={13}/>, onSelect: () => void create(null) },
        { id: 'manage', label: t("folders.manage_folders"), icon: <Settings2 size={13}/>, onSelect: () => openPanel('folders') },
        { id: 'expand-all', label: allExpanded ? t("folders.collapse_all") : t("folders.expand_all"), icon: allExpanded ? <ChevronsDownUp size={13}/> : <ChevronsUpDown size={13}/>, disabled: parentFolderIds.length === 0, onSelect: toggleAllExpanded },
        { id: 'sort', label: t("folders.sort_by_name"), icon: <SortAsc size={13}/>, disabled: tree.length < 2, onSelect: () => sortSiblings(tree) },
        {
            id: 'show-todo',
            label: t("sidebar.todo_folder"),
            checked: todoVisible,
            separatorBefore: true,
            onSelect: () => saveCalendarPrefs({ todoVisible: !todoVisible }),
        },
        { id: 'show-calendar', label: t("sidebar.calendar_folder"), checked: calendarVisible, onSelect: () => saveCalendarPrefs({ calendarVisible: !calendarVisible }) },
        { id: 'show-inbox', label: t("sidebar.inbox_folder"), checked: inboxVisible, onSelect: () => saveCalendarPrefs({ inboxVisible: !inboxVisible }) },
    ];
    return (<>
      <section id="sidebar-folders" className={cn('mt-4 rounded-[var(--r-md)]', rootDropping && 'ring-1 ring-[var(--accent)]')} onDragOverCapture={(event) => {
            if (!event.dataTransfer.types.includes(FOLDER_DRAG_TYPE) && !isNoteDrag(event))
                return;
            if (event.target instanceof Element && event.target.closest('[data-folder-drop-target]')) {
                setRootDropping(false);
                return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setRootDropping(true);
        }} onDragLeave={(event) => {
            if (leftDropTarget(event))
                setRootDropping(false);
        }} onDrop={(event) => {
            const noteIds = readDraggedNoteIds(event);
            if (noteIds.length > 0) {
                event.preventDefault();
                setRootDropping(false);
                dropNotes(noteIds, null);
                return;
            }
            const folderId = event.dataTransfer.getData(FOLDER_DRAG_TYPE);
            if (!folderId)
                return;
            event.preventDefault();
            setRootDropping(false);
            void move(folderId, null, null);
        }}>
      <div ref={headerRef} className="group/head flex items-center justify-between pr-1" onContextMenu={(event) => {
            setHeaderMenuOpen(false);
            headerMenu.onContextMenu(event);
        }}>
        {mobile ? <button data-navigation-item type="button" onClick={() => useUi.getState().openView('all')} className="min-h-11 rounded-lg px-2 text-left text-[13px] text-[var(--accent)]">{t('navigation.all_notes')}</button> : <SectionLabel>{t("navigation.folder")}</SectionLabel>}
        <div className="flex items-center">
        {parentFolderIds.length > 0 && (<Tooltip label={allExpanded ? t("folders.collapse_all") : t("folders.expand_all")}>
            <IconButton label={allExpanded ? t("folders.collapse_all") : t("folders.expand_all")} size="sm" onClick={toggleAllExpanded} className="opacity-100 transition-opacity md:opacity-0 md:group-hover/head:opacity-100 md:focus-visible:opacity-100">
              {allExpanded ? <ChevronsDownUp size={13}/> : <ChevronsUpDown size={13}/>}
            </IconButton>
          </Tooltip>)}
        <Tooltip label={t("folders.manage_folders")}>
          <IconButton label={t("folders.manage_folders")} size="sm" onClick={() => openPanel('folders')} className="opacity-100 transition-opacity md:opacity-0 md:group-hover/head:opacity-100 md:focus-visible:opacity-100">
            <Settings2 size={13}/>
          </IconButton>
        </Tooltip>
        <Tooltip label={t("common.new_note")} combo={APP_SHORTCUTS.newNote}>
          <IconButton label={t("common.new_note")} size="sm" onClick={() => void createContextualNote()}><FilePlus2 size={13}/></IconButton>
        </Tooltip>
        <Tooltip label={t("common.new_folder")}>
          <IconButton label={t("common.new_folder")} size="sm" disabled={creating} onClick={() => void create(null)}>
            <FolderPlus size={13}/>
          </IconButton>
        </Tooltip>
        </div>
      </div>

      {tree.length === 0 ? (<button type="button" disabled={creating} onClick={() => void create(null)} className="mt-0.5 flex h-10 w-full items-center gap-2 rounded-[var(--r-md)] px-2 text-[12px] text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] disabled:pointer-events-none disabled:opacity-45 md:h-[30px]">
          <FolderPlus size={13}/>{t("sidebar.create_first_folder")}</button>) : null}
        <TodoTree />
        <CalendarTree />
        <InboxTree />
        <div role="tree" aria-label={t("navigation.folder")} className="mt-0.5 space-y-px">
          {tree.map((node, index) => (<FolderRow key={node.id} node={node} notesByFolder={notesByFolder} mobile={mobile} canOpenToSide={canOpenToSide} siblings={tree} index={index} parentNode={null} parentSiblings={[]} onCreateChild={create} onMove={move} onChooseParent={setMovingId} onSortSiblings={sortSiblings} onExportZip={exportZip} onDropNotes={dropNotes} onToggleInbox={toggleInbox} createdFolderId={createdFolderId} renamingId={renamingId} onStartRename={setRenamingId} onFinishRename={() => setRenamingId(null)}/>))}
        </div>
      </section>
      <FolderPicker open={Boolean(movingFolder)} title={t("folders.choose_parent")} folders={folders} currentId={movingFolder?.parentId ?? null} excludedIds={excludedMoveTargets} onSelect={(parentId) => {
            if (movingId)
                void move(movingId, parentId, null);
        }} onClose={() => setMovingId(null)}/>
      <Menu anchor={headerRef} open={headerMenuOpen} onClose={() => setHeaderMenuOpen(false)} items={headerMenuItems}/>
      {headerMenu.point && (<Menu anchor={headerMenu.point} open onClose={headerMenu.close} items={headerMenuItems}/>)}
    </>);
}
function FolderRow({ node, notesByFolder, mobile, canOpenToSide, siblings, index, parentNode, parentSiblings, onCreateChild, onMove, onChooseParent, onSortSiblings, onExportZip, onDropNotes, onToggleInbox, createdFolderId, renamingId, onStartRename, onFinishRename, }: {
    node: FolderNode;
    notesByFolder: Map<string | null, NoteSummary[]>;
    mobile: boolean;
    canOpenToSide: boolean;
    siblings: FolderNode[];
    index: number;
    parentNode: FolderNode | null;
    parentSiblings: FolderNode[];
    onCreateChild: (parentId: string | null) => void;
    onMove: (id: string, parentId: string | null, beforeId: string | null) => boolean;
    onChooseParent: (id: string) => void;
    onSortSiblings: (siblings: FolderNode[]) => void;
    onExportZip: (node: FolderNode) => void;
    onDropNotes: (noteIds: string[], folderId: string | null) => void;
    onToggleInbox: (node: FolderNode) => void;
    createdFolderId: string | null;
    renamingId: string | null;
    onStartRename: (id: string) => void;
    onFinishRename: () => void;
}) {
    const view = useUi((s) => s.view);
    const activeFolderId = useUi((s) => s.folderId);
    const expanded = useUi((s) => s.expandedFolders.includes(node.id));
    const toggleFolder = useUi((s) => s.toggleFolder);
    const folders = useNotes((s) => s.folders ?? []);
    const patchFolder = useNotes((s) => s.patchFolder);
    const deleteFolder = useNotes((s) => s.deleteFolder);
    const { inboxFolderId } = useFolderPreferences();
    const isInbox = inboxFolderId === node.id;
    const directNoteCount = node.directNotes;
    const [dropState, setDropState] = useDropState<'none' | 'before' | 'inside' | 'after'>('none');
    const menu = useContextMenu();
    const buttonRef = useRef<HTMLDivElement>(null);
    const removingRef = useRef(false);
    const renamingRef = useRef(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const active = view === 'folder' && activeFolderId === node.id;
    const hasChildren = node.children.length > 0 || Boolean(notesByFolder.get(node.id)?.length);
    const justCreated = createdFolderId === node.id;
    const renaming = renamingId === node.id;
    const canCreateChild = node.depth + 1 < LIMITS.folderDepthMax;
    const { childrenMounted, childrenVisible } = useTreeChildrenMount(expanded, hasChildren);
    const rename = (name: string) => {
        const trimmed = name.trim();
        if (!trimmed || trimmed === node.name) {
            onFinishRename();
            return;
        }
        if (renamingRef.current)
            return;
        renamingRef.current = true;
        onFinishRename();
        patchFolder(node.id, { name: trimmed });
        queueMicrotask(() => {
            renamingRef.current = false;
        });
    };
    const remove = async () => {
        if (removingRef.current)
            return;
        removingRef.current = true;
        try {
            const hasContent = directNoteCount > 0 || hasChildren;
            const ok = await confirm({
                title: t("sidebar.delete_folder_value0", { value0: node.name }),
                description: hasContent
                    ? t("folders.delete_contents_move_up", { value0: directNoteCount, value1: node.children.length }) : t("sidebar.this_folder_is_empty"),
                confirmLabel: t("common.delete"),
                tone: 'danger',
            });
            if (!ok)
                return;
            deleteFolder(node.id);
        }
        finally {
            removingRef.current = false;
        }
    };
    const moveEarlier = () => {
        const previous = siblings[index - 1];
        if (previous)
            void onMove(node.id, node.parentId, previous.id);
    };
    const moveLater = () => {
        if (index >= siblings.length - 1)
            return;
        void onMove(node.id, node.parentId, siblings[index + 2]?.id ?? null);
    };
    const moveOut = () => {
        if (!parentNode)
            return;
        const parentIndex = parentSiblings.findIndex((folder) => folder.id === parentNode.id);
        if (parentIndex < 0)
            return;
        void onMove(node.id, parentNode.parentId, parentSiblings[parentIndex + 1]?.id ?? null);
    };
    const menuItems: MenuItem[] = [
        { id: 'rename', label: t("sidebar.rename"), icon: <Pencil size={13}/>, onSelect: () => onStartRename(node.id) },
        { id: 'new-note', label: t("sidebar.create_new_note_here"), icon: <FilePlus2 size={13}/>, onSelect: () => {
            useUi.getState().openExplorer(node.id);
            useUi.getState().expandFolder(node.id);
            void useNotes.getState().createNote({ folderId: node.id });
        } },
        { id: 'new-child', label: t("sidebar.new_subfolder"), icon: <FolderPlus size={13}/>, disabled: !canCreateChild, onSelect: () => onCreateChild(node.id) },
        { id: 'color', label: t("folders.color"), icon: <Palette size={13}/>, separatorBefore: true, submenu: ({ closeMenu }) => (<FolderColorMenu color={node.color} onSelectColor={(color) => {
                patchFolder(node.id, { color });
                closeMenu();
            }} onManageFolders={() => {
                closeMenu();
                useUi.getState().openPanel('folders');
            }}/>) },
        { id: 'icon', label: t("folders.icon"), icon: <Smile size={13}/>, submenu: ({ closeMenu }) => (<FolderIconMenu icon={node.icon} onSelectIcon={(icon) => {
                patchFolder(node.id, { icon });
                closeMenu();
            }}/>) },
        { id: 'inbox', label: isInbox ? t("folders.unset_inbox") : t("folders.set_as_inbox"), icon: <Inbox size={13}/>, onSelect: () => onToggleInbox(node) },
        { id: 'move-to', label: t("folders.move_to"), icon: <FolderInput size={13}/>, separatorBefore: true, onSelect: () => onChooseParent(node.id) },
        { id: 'move-earlier', label: t("sidebar.move_earlier"), icon: <ArrowUp size={13}/>, disabled: index === 0, onSelect: moveEarlier },
        { id: 'move-later', label: t("sidebar.move_later"), icon: <ArrowDown size={13}/>, disabled: index === siblings.length - 1, onSelect: moveLater },
        { id: 'move-out', label: t("sidebar.move_out_one_level"), icon: <CornerUpLeft size={13}/>, disabled: !parentNode, onSelect: moveOut },
        { id: 'sort', label: t("folders.sort_by_name"), icon: <SortAsc size={13}/>, disabled: siblings.length < 2, onSelect: () => onSortSiblings(siblings) },
        { id: 'export-zip', label: t("folders.export_zip"), icon: <Download size={13}/>, separatorBefore: true, onSelect: () => onExportZip(node) },
        { id: 'manage', label: t("folders.manage_folders"), icon: <Settings2 size={13}/>, onSelect: () => useUi.getState().openPanel('folders') },
        { id: 'delete', label: t("sidebar.delete_folder"), icon: <Trash2 size={13}/>, tone: 'danger', separatorBefore: true, onSelect: () => void remove() },
    ];
    const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
        if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey)
            return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (moveTreeFocus(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1))
                event.preventDefault();
            return;
        }
        if (event.key === 'ArrowRight') {
            if (expandOrReveal(event.currentTarget))
                event.preventDefault();
            return;
        }
        if (event.key === 'ArrowLeft') {
            if (collapseOrLeave(event.currentTarget))
                event.preventDefault();
            return;
        }
        if (event.key === 'F2') {
            event.preventDefault();
            onStartRename(node.id);
            return;
        }
        if (event.key === 'Delete') {
            event.preventDefault();
            void remove();
        }
    };
    return (<div role="treeitem" aria-level={node.depth + 1} aria-expanded={hasChildren ? expanded : undefined} className={cn(justCreated && 'anim-tree-item-enter')} data-new-folder={justCreated || undefined}>
      <div ref={buttonRef} data-folder-drop-target onContextMenu={(event) => {
            setMenuOpen(false);
            menu.onContextMenu(event);
        }} onDragOver={(e) => {
            if (!isNoteDrag(e) && !e.dataTransfer.types.includes(FOLDER_DRAG_TYPE))
                return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            if (isNoteDrag(e)) {
                setDropState('inside');
                return;
            }
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = rect.height ? (e.clientY - rect.top) / rect.height : 0.5;
            setDropState(ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'inside');
        }} onDragLeave={(e) => {
            if (leftDropTarget(e))
                setDropState('none');
        }} onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDropState('none');
            const noteIds = readDraggedNoteIds(e);
            if (noteIds.length > 0) {
                onDropNotes(noteIds, node.id);
                return;
            }
            const folderId = e.dataTransfer.getData(FOLDER_DRAG_TYPE);
            if (folderId && folderId !== node.id) {
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = rect.height ? (e.clientY - rect.top) / rect.height : 0.5;
                const placement = dropState === 'none'
                    ? ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'inside'
                    : dropState;
                if (placement === 'before')
                    void onMove(folderId, node.parentId, node.id);
                else if (placement === 'after')
                    void onMove(folderId, node.parentId, siblings[index + 1]?.id ?? null);
                else
                    void onMove(folderId, node.id, null);
            }
        }} draggable={!renaming} onDragStart={(e) => {
            e.dataTransfer.setData(FOLDER_DRAG_TYPE, node.id);
            e.dataTransfer.effectAllowed = 'move';
        }} className={cn('group relative flex h-11 items-center gap-1 rounded-[var(--r-md)] pr-1 md:h-[30px]', 'transition-colors duration-[var(--dur-fast)]', active
            ? 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]', dropState === 'inside' && 'ring-1 ring-[var(--accent)]')} style={{ paddingLeft: 6 + node.depth * 13 }}>
        {dropState === 'before' && <span aria-hidden="true" className="pointer-events-none absolute top-0 right-1 left-1 h-px bg-[var(--accent)]"/>}
        {dropState === 'after' && <span aria-hidden="true" className="pointer-events-none absolute right-1 bottom-0 left-1 h-px bg-[var(--accent)]"/>}
        <Tooltip label={expanded ? t("sidebar.collapse") : t("sidebar.expand")} side="right">
          <button type="button" disabled={!hasChildren} aria-hidden={!hasChildren || undefined} tabIndex={hasChildren ? undefined : -1} data-tree-toggle aria-expanded={hasChildren ? expanded : undefined} onClick={(e) => {
                e.stopPropagation();
                toggleFolder(node.id);
            }} aria-label={expanded ? t("sidebar.collapse") : t("sidebar.expand")} className={cn('flex size-8 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] md:size-4', 'transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]', expanded && 'rotate-90', !hasChildren && 'invisible')}>
            <ChevronRight size={12}/>
          </button>
        </Tooltip>

        <span className={cn('shrink-0', active && !node.color ? 'text-[var(--accent)]' : !node.color && 'text-[var(--text-tertiary)]')} style={{ color: node.color ?? undefined }}>
          {node.icon ? (<span className={cn('text-[13px] leading-none', justCreated && 'anim-mark-enter')}>{node.icon}</span>) : (<FolderMotionIcon open={expanded && hasChildren} drawing={justCreated}/>)}
        </span>

        {renaming ? (<input aria-label={t("sidebar.rename")} autoFocus defaultValue={node.name} onBlur={(e) => void rename(e.target.value)} onKeyDown={(e) => {
                if (e.key === 'Enter')
                    void rename(e.currentTarget.value);
                if (e.key === 'Escape') {
                    e.currentTarget.value = node.name;
                    onFinishRename();
                }
                e.stopPropagation();
            }} className="min-w-0 flex-1 rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1 py-px text-[12.5px] outline-none"/>) : (<Tooltip label={folderPathLabel(folders, node.id)} side="right">
            <button data-navigation-item={mobile || undefined} data-tree-row type="button" aria-current={active ? 'page' : undefined} onClick={() => {
                if (mobile) openFolderView(folders, node.id);
                else {
                    useUi.getState().openExplorer(node.id);
                    toggleFolder(node.id);
                }
            }} onDoubleClick={() => onStartRename(node.id)} onKeyDown={onKeyDown} className="flex min-w-0 flex-1 items-center gap-1.5 truncate py-1 pl-1 text-left text-[12.5px] font-medium">
              <span className="min-w-0 truncate">{node.name}</span>
              {isInbox && (<Tooltip label={t("folders.inbox")} side="right">
                <Inbox size={11} aria-label={t("folders.inbox")} className="shrink-0 text-[var(--accent)]"/>
              </Tooltip>)}
            </button>
          </Tooltip>)}

        {!renaming && (<>
            <span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)] transition-opacity md:group-hover:opacity-0">
              {node.totalNotes > 0 ? node.totalNotes : ''}
            </span>
            <Tooltip label={t("common.more_actions")} side="left">
              <IconButton label={t("common.more_actions")} size="sm" onClick={(e) => {
                    e.stopPropagation();
                    menu.close();
                    setMenuOpen(true);
                }} className="shrink-0 opacity-100 transition-opacity md:absolute md:right-1 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100">
                <MoreHorizontal size={13}/>
              </IconButton>
            </Tooltip>
          </>)}
      </div>

      {childrenMounted && (<div role="group" aria-hidden={!childrenVisible} inert={!childrenVisible} className={cn('folder-children-grid', childrenVisible && 'is-expanded')}>
          <div className="min-h-0 space-y-px overflow-hidden">
            {node.children.map((child, childIndex) => (<FolderRow key={child.id} node={child} notesByFolder={notesByFolder} mobile={mobile} canOpenToSide={canOpenToSide} siblings={node.children} index={childIndex} parentNode={node} parentSiblings={siblings} onCreateChild={onCreateChild} onMove={onMove} onChooseParent={onChooseParent} onSortSiblings={onSortSiblings} onExportZip={onExportZip} onDropNotes={onDropNotes} onToggleInbox={onToggleInbox} createdFolderId={createdFolderId} renamingId={renamingId} onStartRename={onStartRename} onFinishRename={onFinishRename}/>))}
            {notesByFolder.get(node.id)?.map((note) => <ExplorerNote key={note.id} note={note} depth={node.depth + 1} canOpenToSide={canOpenToSide}/>)}
          </div>
        </div>)}

      <Menu anchor={buttonRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems}/>
      {menu.point && (<Menu anchor={menu.point} open onClose={menu.close} items={menuItems}/>)}
    </div>);
}
export function TagSection({ mobile = false }: { mobile?: boolean }) {
    const tags = useNotes((s) => s.tags);
    const view = useUi((s) => s.view);
    const listVisible = useUi((s) => !s.listCollapsed && !s.searchList);
    const activeTag = useUi((s) => s.tag);
    const openView = useUi((s) => s.openView);
    const [expanded, setExpanded] = useState(false);
    const [creating, setCreating] = useState(false);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [appearanceId, setAppearanceId] = useState<string | null>(null);
    const sortedTags = useMemo(() => [...tags]
            .sort((a, b) => b.count - a.count || compareTagNames(a.name, b.name)), [tags]);
    const visible = expanded ? sortedTags : sortedTags.slice(0, 8);
    const appearanceTag = appearanceId
        ? tags.find((tag) => tag.id === appearanceId) ?? null
        : null;
    const finishCreate = (value: string) => {
        setCreating(false);
        const id = createTag(value);
        if (!id)
            return;
        const tag = useNotes.getState().tags.find((candidate) => candidate.id === id);
        if (tag)
            openView('tag', { tag: tag.name });
    };
    return (<>
      <section className="mt-4">
      <div className="group/head flex items-center justify-between pr-1">
        {mobile ? <button data-navigation-item type="button" onClick={() => openView('all')} className="min-h-11 rounded-lg px-2 text-left text-[13px] text-[var(--accent)]">{t('navigation.all_notes')}</button> : <SectionLabel>{t("navigation.tag")}</SectionLabel>}
        <Tooltip label={t("tags.new")} side="right">
          <IconButton label={t("tags.new")} size="sm" onClick={() => setCreating(true)} className="opacity-100 transition-opacity md:opacity-0 md:group-hover/head:opacity-100 md:focus-visible:opacity-100">
            <Plus size={13}/>
          </IconButton>
        </Tooltip>
      </div>
      <div className="mt-0.5 space-y-px">
        {creating && <TagDraftRow onFinish={finishCreate} onCancel={() => setCreating(false)}/>}
        {!sortedTags.length && !creating && (<button type="button" onClick={() => setCreating(true)} className="flex h-10 w-full items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[11.5px] text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] md:h-[30px]">
            <Plus size={13}/>{t("tags.create_first")}
          </button>)}
        {visible.map((tag) => (<TagRow key={tag.id} tag={tag} active={(mobile || listVisible) && view === 'tag' && activeTag === tag.name} renaming={renamingId === tag.id} onOpen={() => openView('tag', { tag: tag.name })} onStartRename={() => setRenamingId(tag.id)} onFinishRename={(value) => {
            setRenamingId(null);
            void renameTag(tag, value);
        }} onCancelRename={() => setRenamingId(null)} onEditColor={() => setAppearanceId(tag.id)}/>))}

        {sortedTags.length > 8 && (<button type="button" onClick={() => setExpanded((v) => !v)} className="h-10 w-full rounded-[var(--r-md)] px-2 text-left text-[11.5px] text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] md:h-[26px]">
            {expanded ? t("common.collapse") : t("sidebar.show_all_value0_tags", { value0: sortedTags.length })}
          </button>)}
      </div>
      </section>
      <TagAppearance open={Boolean(appearanceTag)} tag={appearanceTag} onChange={(color) => {
            if (appearanceTag)
                void setTagColor(appearanceTag, color);
        }} onClose={() => setAppearanceId(null)}/>
    </>);
}
function TagDraftRow({ onFinish, onCancel }: {
    onFinish: (value: string) => void;
    onCancel: () => void;
}) {
    const finishedRef = useRef(false);
    const finish = (value: string) => {
        if (finishedRef.current)
            return;
        finishedRef.current = true;
        onFinish(value);
    };
    return (<div className="flex h-10 items-center gap-2 rounded-[var(--r-md)] px-2 md:h-[30px]">
      <Hash size={13} className="shrink-0 text-[var(--text-quaternary)]"/>
      <input aria-label={t("tags.new")} autoFocus placeholder={t("tags.new_placeholder")} onBlur={(event) => {
            if (event.currentTarget.value.trim())
                finish(event.currentTarget.value);
            else
                onCancel();
        }} onKeyDown={(event) => {
            if (event.key === 'Enter')
                finish(event.currentTarget.value);
            if (event.key === 'Escape') {
                finishedRef.current = true;
                onCancel();
            }
            event.stopPropagation();
        }} className="min-w-0 flex-1 rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1 py-px text-[12.5px] outline-none"/>
    </div>);
}
function TagRow({ tag, active, renaming, onOpen, onStartRename, onFinishRename, onCancelRename, onEditColor, }: {
    tag: Tag;
    active: boolean;
    renaming: boolean;
    onOpen: () => void;
    onStartRename: () => void;
    onFinishRename: (value: string) => void;
    onCancelRename: () => void;
    onEditColor: () => void;
}) {
    const menu = useContextMenu();
    const rowRef = useRef<HTMLDivElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const finishedRef = useRef(false);
    const finishRename = (value: string) => {
        if (finishedRef.current)
            return;
        finishedRef.current = true;
        onFinishRename(value);
    };
    const menuItems: MenuItem[] = [
        { id: 'rename', label: t("tags.rename"), icon: <Pencil size={13}/>, onSelect: onStartRename },
        { id: 'color', label: t("tags.color"), icon: <Palette size={13}/>, onSelect: onEditColor },
        { id: 'delete', label: t("tags.delete"), icon: <Trash2 size={13}/>, tone: 'danger', separatorBefore: true, onSelect: () => void deleteTag(tag) },
    ];
    return (<div ref={rowRef} onContextMenu={(event) => {
            setMenuOpen(false);
            menu.onContextMenu(event);
        }} className={cn('group relative flex h-11 items-center gap-2 rounded-[var(--r-md)] px-2 md:h-[30px]', 'transition-colors duration-[var(--dur-fast)]', active
            ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
      <Hash size={13} className="shrink-0" style={{ color: tag.color ?? (active ? 'var(--accent)' : 'var(--text-quaternary)') }}/>
      {renaming ? (<input aria-label={t("tags.rename")} autoFocus defaultValue={tag.name} onFocus={() => {
            finishedRef.current = false;
        }} onBlur={(event) => finishRename(event.currentTarget.value)} onKeyDown={(event) => {
            if (event.key === 'Enter')
                finishRename(event.currentTarget.value);
            if (event.key === 'Escape') {
                finishedRef.current = true;
                onCancelRename();
            }
            event.stopPropagation();
        }} className="min-w-0 flex-1 rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1 py-px text-[12.5px] outline-none"/>) : (<button data-navigation-item type="button" aria-current={active ? 'page' : undefined} onClick={onOpen} onDoubleClick={onStartRename} className="min-w-0 flex-1 truncate py-1 text-left text-[12.5px] font-medium">
          {tag.name}
        </button>)}
      {!renaming && (<>
          <span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)] transition-opacity md:group-hover:opacity-0">
            {tag.count > 0 ? tag.count : ''}
          </span>
          <Tooltip label={t("common.more_actions")} side="left">
            <IconButton label={t("common.more_actions")} size="sm" onClick={(event) => {
                event.stopPropagation();
                menu.close();
                setMenuOpen(true);
            }} className="shrink-0 opacity-100 transition-opacity md:absolute md:right-1 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100">
              <MoreHorizontal size={13}/>
            </IconButton>
          </Tooltip>
        </>)}
      <Menu anchor={rowRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems}/>
      {menu.point && (<Menu anchor={menu.point} open onClose={menu.close} items={menuItems}/>)}
    </div>);
}
function useDropState<T>(idle: T) {
    const [state, setState] = useState(idle);
    useEffect(() => {
        if (state === idle) return;
        const reset = () => setState(idle);
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') reset();
        };
        const onLeaveWindow = (event: DragEvent) => {
            if (event.target === document.documentElement && !event.relatedTarget) reset();
        };
        window.addEventListener('drop', reset, true);
        window.addEventListener('dragend', reset, true);
        window.addEventListener('blur', reset);
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('dragleave', onLeaveWindow, true);
        return () => {
            window.removeEventListener('drop', reset, true);
            window.removeEventListener('dragend', reset, true);
            window.removeEventListener('blur', reset);
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('dragleave', onLeaveWindow, true);
        };
    }, [state, idle]);
    return [state, setState] as const;
}
