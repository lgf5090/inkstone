import { APP_SHORTCUTS } from '../../lib/shortcuts';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Clock, CornerUpLeft, Download, FilePlus2, FileText, FolderInput, FolderPlus, Inbox, LayoutTemplate, LogOut, Moon, MoreHorizontal, Palette, PanelLeft, PanelLeftClose, Pencil, Search, Settings, Settings2, Smile, SortAsc, Star, Sun, Trash2, Waypoints, X, } from 'lucide-react';import { LIMITS } from '@shared/constants';
import type { NoteSummary, ViewKind } from '@shared/types';
import { cn } from '../../lib/cn';
import { numericCollator } from '../../lib/collator';
import { Avatar, IconButton, Logo, SectionLabel } from '../../components/primitives';
import { commitOnEnter } from '../../components/form';
import { Menu, MenuSubmenuList, Tooltip, confirm, useContextMenu, type MenuItem } from '../../components/overlay';
import { switchThemeWithTransition, useUi } from '../../store/ui';
import { useSession } from '../../store/session';
import { useUpdate } from '../../store/update';
import { createContextualNote, useFolderTree, useNavigationCounts, useNotes, type FolderNode } from '../../store/notes';
import { folderMoveExclusions, folderPath, folderPathLabel, openFolderView } from '../../lib/folders';
import { searchFolders } from '../../lib/folder-search';
import { fuzzyMatch, splitByRanges } from '../../lib/fuzzy';
import { usePinyinVersion } from '../../lib/pinyin';
import { setInboxFolderId, useFolderPreferences } from '../../lib/folder-prefs';
import { saveCalendarPrefs, useCalendarTreePreferences } from '../../lib/calendar-prefs';
import { exportFolderAsZip } from '../../lib/export-folder';
import { FOLDER_DRAG_TYPE, isNoteDrag, leftDropTarget, moveNotesToFolder, readDraggedNoteIds, restoreNoteFolders } from '../../lib/note-drag';
import { FolderPicker } from '../folders/FolderPicker';
import { FolderColorMenu, FolderIconMenu } from '../folders/FolderAppearanceMenus';
import { FolderMoveMenu } from '../folders/FolderMoveMenu';
import { collapseOrLeave, expandOrReveal, moveTreeFocus } from './tree-keyboard';
import { SidebarTags } from '../tags/SidebarTags';
import { SidebarRecent } from './SidebarRecent';
import { SidebarVersions } from './SidebarVersions';
import { SidebarOutlinks } from './SidebarOutlinks';
import { BacklinksPanel } from '../workspace/BacklinksPanel';
import { SIDEBAR_PANEL_ID, SidebarTabStrip, tabId } from './SidebarTabs';
import { t, useLocale } from "../../lib/i18n";
import { SearchButton } from '../shell/SearchButton';
import { ExplorerNote, groupExplorerNotes } from './ExplorerNote';
import { FolderMotionIcon } from './FolderMotionIcon';
import { TemplateQuickActions } from '../templates/quick-actions';
import { useTreeChildrenMount } from './useTreeChildrenMount';
import { CalendarTree, InboxTree, isDropBlockedTarget, TodoTree } from './virtual-tree';
import { SidebarCalendar } from './sidebar-calendar';
import { useBreakpoint } from '../../lib/hooks';
// The graph canvas and its scene maths are only needed once a reader opens that tab, and the
// sidebar rides in the first bundle.
const LocalGraphPanel = lazy(() => import('../graph/LocalGraphPanel').then((m) => ({ default: m.LocalGraphPanel })));

export function Sidebar({ collapsed = false, onCollapse, }: {
    collapsed?: boolean;
    onCollapse?: () => void;
}) {
    const view = useUi((s) => !s.listCollapsed && !s.searchList ? s.view : null);
    const openView = useUi((s) => s.openView);
    const sidebarTab = useUi((s) => s.sidebarTab);
    const activeNoteId = useUi((s) => s.activeNoteId);
    const openPanel = useUi((s) => s.openPanel);
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

      <div className="min-h-0 shrink overflow-y-auto px-2 pt-2 pb-1" data-sidebar-fixed>
        <SidebarCalendar />
        <div className="space-y-px">
          <ViewItem icon={<FileText size={14}/>} label={t("navigation.all_notes")} view="all" count={counts.all} active={view === 'all'} onSelect={openView}/>
          <ViewItem icon={<Clock size={14}/>} label={t("navigation.recently_edited")} view="recent" active={view === 'recent'} onSelect={openView}/>
          <ViewItem icon={<Star size={14}/>} label={t("navigation.favorites")} view="starred" count={counts.starred} active={view === 'starred'} onSelect={openView}/>
          <ViewItem icon={<Inbox size={14}/>} label={t("navigation.unfiled")} view="unfiled" count={counts.unfiled} active={view === 'unfiled'} onSelect={openView}/>
        </div>
      </div>

      <SidebarTabStrip />

      <div id={SIDEBAR_PANEL_ID} role="tabpanel" aria-labelledby={tabId(sidebarTab)} className={cn('min-h-[10rem] flex-1 px-2 pt-1 pb-4', sidebarTab === 'graph' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto')}>
        {sidebarTab === 'library' && <FolderSection />}
        {sidebarTab === 'tags' && <SidebarTags />}
        {sidebarTab === 'recent' && <SidebarRecent />}
        {sidebarTab === 'backlinks' && (activeNoteId
          ? <BacklinksPanel noteId={activeNoteId} fill/>
          : <NoNotePanel label={t("common.backlinks")} message={t("sidebar.links_no_note")}/>)}
        {sidebarTab === 'outlinks' && <SidebarOutlinks />}
        {sidebarTab === 'history' && <SidebarVersions />}
        {sidebarTab === 'graph' && (activeNoteId ? (<Suspense fallback={<PanelLoading/>}><LocalGraphPanel noteId={activeNoteId} fill onOpenFullGraph={() => openPanel('graph')}/></Suspense>) : <NoNotePanel label={t("graph.local_graph")} message={t("sidebar.graph_no_note")}/>)}
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
function NoNotePanel({ label, message }: {
    label: string;
    message: string;
}) {
    return (<>
      <SectionLabel>{label}</SectionLabel>
      <p className="px-2 py-3 text-[12px] leading-relaxed text-[var(--text-quaternary)]">{message}</p>
    </>);
}
function PanelLoading() {
    return <p className="px-2 py-3 text-[12px] text-[var(--text-quaternary)]">{t("common.loading")}</p>;
}
function SidebarRail({ onExpand }: {
    onExpand?: () => void;
}) {
    const view = useUi((s) => !s.listCollapsed && !s.searchList ? s.view : null);
    const panel = useUi((s) => s.panel);
    const togglePanel = useUi((s) => s.togglePanel);
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
        <RailButton label={t("templates.new_note_from_template")} combo={APP_SHORTCUTS.templates} icon={<LayoutTemplate size={16}/>} active={panel === 'templates'} onClick={() => togglePanel('templates')}/>
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
            combo: APP_SHORTCUTS.graph,
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
    const [folderQuery, setFolderQuery] = useState('');
    const folderQueryRef = useRef<HTMLInputElement>(null);
    const pinyinVersion = usePinyinVersion();
    const searchedFolders = useMemo(() => searchFolders(tree, folderQuery), [tree, folderQuery, pinyinVersion]);
    const filteringFolders = Boolean(folderQuery.trim());
    const folderSearch = { open: filteringFolders, matched: searchedFolders.matched, query: folderQuery };
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
            tags: startingUi.tags,
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
                currentUi.tags === startingNavigation.tags &&
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
    const excludedMoveTargets = useMemo(() => movingId ? folderMoveExclusions(folders, movingId) : undefined, [folders, movingId]);
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
            if ((event.target instanceof Element && event.target.closest('[data-folder-drop-target]')) || isDropBlockedTarget(event.target)) {
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
        <div className="flex shrink-0 items-center">
        <TemplateQuickActions iconSize={13}/>
        <Tooltip label={t("common.new_note")} combo={APP_SHORTCUTS.newNote}>
          <IconButton label={t("common.new_note")} size="sm" onClick={() => void createContextualNote()}><FilePlus2 size={13}/></IconButton>
        </Tooltip>
        <Tooltip label={t("common.new_folder")}>
          <IconButton label={t("common.new_folder")} size="sm" disabled={creating} onClick={() => void create(null)}>
            <FolderPlus size={13}/>
          </IconButton>
        </Tooltip>
        <Tooltip label={t("common.more_actions")}>
          <IconButton label={t("common.more_actions")} size="sm" onClick={() => setHeaderMenuOpen(true)} className="opacity-100 transition-opacity md:opacity-0 md:group-hover/head:opacity-100 md:focus-visible:opacity-100">
            <MoreHorizontal size={13}/>
          </IconButton>
        </Tooltip>
        </div>
      </div>

      {tree.length > 0 && (<>
        <div className="relative mt-1">
          <Search size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[var(--text-quaternary)]"/>
          <input
            ref={folderQueryRef}
            aria-label={t("folders.search")}
            type="search"
            value={folderQuery}
            placeholder={t("folders.filter_placeholder")}
            data-folder-filter
            onChange={(event) => setFolderQuery(event.target.value)}
            onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                if (folderQuery)
                                    setFolderQuery('');
                                else
                                    folderQueryRef.current?.blur();
                            }
                            // Enter opens what the reader was about to click: the first row of the
                            // filtered tree, which is the best guess the filter has.
                            if (event.key === 'Enter' && searchedFolders.nodes[0]) {
                                event.preventDefault();
                                openFolderView(folders, searchedFolders.nodes[0].id);
                            }
                            event.stopPropagation();
                        }}
            className="h-10 w-full rounded-[var(--r-md)] border border-transparent bg-[var(--bg-inset)] pr-7 pl-7 text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-ring)] focus:outline-none md:h-[28px] md:pr-6"
          />
          {folderQuery && (<button type="button" aria-label={t("notes.clear_filters")} onClick={() => {
                            setFolderQuery('');
                            folderQueryRef.current?.focus();
                        }} className="absolute top-1/2 right-1 flex size-8 -translate-y-1/2 items-center justify-center rounded text-[var(--text-quaternary)] hover:text-[var(--text-secondary)] md:size-6">
              <X size={11}/>
            </button>)}
        </div>
        {filteringFolders && searchedFolders.shown > 0 && (<p data-folder-match-count className="px-2 pt-1 text-[10.5px] tabular text-[var(--text-quaternary)]">{t("folders.match_count", { value0: searchedFolders.shown })}</p>)}
      </>)}

      {!filteringFolders && (<>
        <TodoTree />
        <CalendarTree />
        <InboxTree />
      </>)}
      {tree.length === 0 && !filteringFolders ? (<button type="button" disabled={creating} onClick={() => void create(null)} className="mt-0.5 flex h-10 w-full items-center gap-2 rounded-[var(--r-md)] px-2 text-[12px] text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] disabled:pointer-events-none disabled:opacity-45 md:h-[30px]">
        <FolderPlus size={13}/>{t("sidebar.create_first_folder")}</button>) : null}
      {filteringFolders && searchedFolders.nodes.length === 0 ? (<p data-folder-no-match className="px-2 py-2 text-[11.5px] text-[var(--text-quaternary)]">{t("folders.no_match")}</p>) : null}
        <div role="tree" aria-label={t("navigation.folder")} className="mt-0.5 space-y-px">
          {searchedFolders.nodes.map((node, index) => (<FolderRow key={node.id} node={node} notesByFolder={notesByFolder} mobile={mobile} canOpenToSide={canOpenToSide} siblings={searchedFolders.nodes} index={index} parentNode={null} parentSiblings={[]} onCreateChild={create} onMove={move} onChooseParent={setMovingId} rootTree={tree} onSortSiblings={sortSiblings} onExportZip={exportZip} onDropNotes={dropNotes} onToggleInbox={toggleInbox} createdFolderId={createdFolderId} renamingId={renamingId} onStartRename={setRenamingId} onFinishRename={() => setRenamingId(null)} search={folderSearch}/>))}
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
/**
 * The folder's own name, with the letters the query reached underlined.
 *
 * A reading-based hit (the pinyin initials of a Chinese name) has no letters in the label to
 * mark, so it renders as plain text rather than underlining the wrong characters.
 */
function FolderNameText({ name, search }: { name: string; search: { open: boolean; matched: ReadonlySet<string>; query: string } }) {
    if (!search.open)
        return name;
    const match = fuzzyMatch(name, search.query);
    if (!match)
        return name;
    return splitByRanges(name, match.ranges).map((part, index) => part.hit
        ? <span key={index} className="font-semibold text-[var(--accent)]">{part.text}</span>
        : <span key={index}>{part.text}</span>);
}
function FolderRow({ node, notesByFolder, mobile, canOpenToSide, siblings, index, parentNode, parentSiblings, onCreateChild, onMove, onChooseParent, rootTree, onSortSiblings, onExportZip, onDropNotes, onToggleInbox, createdFolderId, renamingId, onStartRename, onFinishRename, search, }: {
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
    rootTree: FolderNode[];
    onSortSiblings: (siblings: FolderNode[]) => void;
    onExportZip: (node: FolderNode) => void;
    onDropNotes: (noteIds: string[], folderId: string | null) => void;
    onToggleInbox: (node: FolderNode) => void;
    createdFolderId: string | null;
    renamingId: string | null;
    onStartRename: (id: string) => void;
    onFinishRename: () => void;
    search: { open: boolean; matched: ReadonlySet<string>; query: string };
}) {
    const view = useUi((s) => s.view);
    const activeFolderId = useUi((s) => s.folderId);
    const storedExpanded = useUi((s) => s.expandedFolders.includes(node.id));
    const expanded = search.open || storedExpanded;
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
        { id: 'move-to', label: t("folders.move_to"), icon: <FolderInput size={13}/>, separatorBefore: true, ...(mobile ? { onSelect: () => onChooseParent(node.id) } : { submenu: ({ closeMenu }) => (<FolderMoveMenu tree={rootTree} subject={node} currentParentId={node.parentId} excludedIds={folderMoveExclusions(folders, node.id)} inboxFolderId={inboxFolderId} onSelect={(parentId) => {
                    void onMove(node.id, parentId, null);
                    closeMenu();
                }}/>) }) },
        { id: 'arrange', label: t("folders.group_arrange"), icon: <ArrowUpDown size={13}/>, separatorBefore: true, submenu: ({ closeMenu }) => (<MenuSubmenuList label={t("folders.group_arrange")} items={[
                { id: 'move-earlier', label: t("sidebar.move_earlier"), icon: <ArrowUp size={13}/>, disabled: index === 0, onSelect: () => {
                    moveEarlier();
                    closeMenu();
                } },
                { id: 'move-later', label: t("sidebar.move_later"), icon: <ArrowDown size={13}/>, disabled: index === siblings.length - 1, onSelect: () => {
                    moveLater();
                    closeMenu();
                } },
                { id: 'move-out', label: t("sidebar.move_out_one_level"), icon: <CornerUpLeft size={13}/>, disabled: !parentNode, onSelect: () => {
                    moveOut();
                    closeMenu();
                } },
                { id: 'sort', label: t("folders.sort_by_name"), icon: <SortAsc size={13}/>, disabled: siblings.length < 2, separatorBefore: true, onSelect: () => {
                    onSortSiblings(siblings);
                    closeMenu();
                } },
            ]}/>) },
        { id: 'archive', label: t("folders.group_archive"), icon: <Archive size={13}/>, submenu: ({ closeMenu }) => (<MenuSubmenuList label={t("folders.group_archive")} items={[
                { id: 'export-zip', label: t("folders.export_zip"), icon: <Download size={13}/>, onSelect: () => {
                    onExportZip(node);
                    closeMenu();
                } },
                { id: 'manage', label: t("folders.manage_folders"), icon: <Settings2 size={13}/>, onSelect: () => {
                    useUi.getState().openPanel('folders');
                    closeMenu();
                } },
            ]}/>) },
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
                commitOnEnter(e, () => void rename(e.currentTarget.value));
                if (e.key === 'Escape') {
                    e.currentTarget.value = node.name;
                    onFinishRename();
                }
                e.stopPropagation();
            }} className="min-w-0 flex-1 rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1 py-px text-[12.5px] outline-none"/>) : (<Tooltip label={folderPathLabel(folders, node.id)} side="right">
            <button data-navigation-item={mobile || undefined} data-tree-row type="button" aria-label={node.name} aria-current={active ? 'page' : undefined} onClick={() => {
                if (mobile) openFolderView(folders, node.id);
                else {
                    useUi.getState().openExplorer(node.id);
                    toggleFolder(node.id);
                }
            }} onDoubleClick={() => onStartRename(node.id)} onKeyDown={onKeyDown} className="flex min-w-0 flex-1 items-center gap-1.5 truncate py-1 pl-1 text-left text-[12.5px] font-medium">
              <span className="min-w-0 truncate"><FolderNameText name={node.name} search={search}/></span>
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
            {node.children.map((child, childIndex) => (<FolderRow key={child.id} node={child} notesByFolder={notesByFolder} mobile={mobile} canOpenToSide={canOpenToSide} siblings={node.children} index={childIndex} parentNode={node} parentSiblings={siblings} onCreateChild={onCreateChild} onMove={onMove} onChooseParent={onChooseParent} rootTree={rootTree} onSortSiblings={onSortSiblings} onExportZip={onExportZip} onDropNotes={onDropNotes} onToggleInbox={onToggleInbox} createdFolderId={createdFolderId} renamingId={renamingId} onStartRename={onStartRename} onFinishRename={onFinishRename} search={search}/>))}
            {notesByFolder.get(node.id)?.map((note) => <ExplorerNote key={note.id} note={note} depth={node.depth + 1} canOpenToSide={canOpenToSide}/>)}
          </div>
        </div>)}

      <Menu anchor={buttonRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems}/>
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
