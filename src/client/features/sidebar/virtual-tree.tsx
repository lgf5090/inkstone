import { useMemo, useRef, useState } from 'react';
import { CalendarDays, CheckSquare, ChevronRight, Inbox } from 'lucide-react';
import type { NoteSummary } from '@shared/types';
import { cn } from '../../lib/cn';
import { IconButton } from '../../components/primitives';
import { Menu, Tooltip, useContextMenu, type MenuItem } from '../../components/overlay';
import { t } from '../../lib/i18n';
import { useLocale } from '../../lib/i18n';
import {
    CALENDAR_TREE,
    TODO_TREE,
    buildVirtualTreeCached,
    resolveTodoTag,
    splitTodoTags,
    treeRowIndent,
    virtualAncestorIds,
    virtualPathSegments,
    virtualPeriodKeyRange,
    virtualTreeRootLabel,
    virtualTreeRowIndent,
    type CalendarNode,
    type VirtualTreeNamespace,
} from '../../lib/calendar-tree';
import { saveCalendarPrefs, useCalendarTreePreferences } from '../../lib/calendar-prefs';
import { useNotes } from '../../store/notes';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { ExplorerNote } from './ExplorerNote';
import { FolderMotionIcon } from './FolderMotionIcon';
import { collapseOrLeave, expandOrReveal, moveTreeFocus } from './tree-keyboard';
import { useTreeChildrenMount } from './useTreeChildrenMount';

const VIRTUAL_DRAG_BLOCK = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
};

function useVirtualNotes(ns: VirtualTreeNamespace): { notes: Record<string, NoteSummary>; todoTags: string[] } {
    const notes = useNotes((s) => s.notes);
    const todoTag = useSession((s) => s.settings.notes?.todoTag ?? '');
    return useMemo(() => ({
        notes,
        todoTags: ns === TODO_TREE ? splitTodoTags(resolveTodoTag(todoTag)) : [],
    }), [notes, ns, todoTag]);
}

function descendantIds(nodes: CalendarNode[]): string[] {
    const ids: string[] = [];
    const walk = (list: CalendarNode[]) => {
        for (const node of list) {
            ids.push(node.id);
            walk(node.children);
        }
    };
    walk(nodes);
    return ids;
}

export function CalendarTree() {
    const { calendarVisible } = useCalendarTreePreferences();
    return calendarVisible
        ? <VirtualTree ns={CALENDAR_TREE} rootIcon={<CalendarDays size={14}/>} periodTree/>
        : null;
}

export function TodoTree() {
    const { todoVisible } = useCalendarTreePreferences();
    return todoVisible
        ? <VirtualTree ns={TODO_TREE} rootIcon={<CheckSquare size={14}/>} periodTree/>
        : null;
}

function VirtualTree({ ns, rootIcon, periodTree }: {
    ns: VirtualTreeNamespace;
    rootIcon: React.ReactNode;
    periodTree: boolean;
}) {
    const { showEmptyPeriods } = useCalendarTreePreferences();
    const { notes, todoTags } = useVirtualNotes(ns);
    const children = useMemo(
        () => buildVirtualTreeCached(notes, ns, showEmptyPeriods, ns === TODO_TREE ? todoTags : null),
        [ns, notes, showEmptyPeriods, todoTags],
    );
    const rootCount = useMemo(() => children.reduce((sum, child) => sum + child.count, 0), [children]);
    const root: CalendarNode = { id: ns.rootId, name: '', depth: -1, count: rootCount, children };
    return (<div role="tree" aria-label={virtualTreeRootLabel(ns)} className="mt-0.5 space-y-px" onDragOver={VIRTUAL_DRAG_BLOCK} onDrop={VIRTUAL_DRAG_BLOCK}>
      <VirtualRow ns={ns} rootIcon={rootIcon} node={root} allIds={periodTree ? descendantIds(children) : []} showEmptyToggle={periodTree}/>
    </div>);
}

function VirtualRow({ ns, rootIcon, node, allIds, showEmptyToggle }: {
    ns: VirtualTreeNamespace;
    rootIcon: React.ReactNode;
    node: CalendarNode;
    allIds: string[];
    showEmptyToggle: boolean;
}) {
    const view = useUi((s) => s.view);
    const activeFolderId = useUi((s) => s.folderId);
    const expanded = useUi((s) => s.expandedFolders.includes(node.id));
    const toggleFolder = useUi((s) => s.toggleFolder);
    const hasChildren = node.children.length > 0;
    const isRoot = node.depth < 0;
    const active = view === 'folder' && activeFolderId === node.id;
    const { childrenMounted, childrenVisible } = useTreeChildrenMount(expanded, hasChildren);
    const { showEmptyPeriods } = useCalendarTreePreferences();
    const menu = useContextMenu();
    const anchor = useRef<HTMLDivElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const open = () => {
        const ancestors = virtualAncestorIds(node.id, ns);
        if (ancestors.length) {
            useUi.setState((state) => ({ expandedFolders: [...new Set([...state.expandedFolders, ...ancestors])] }));
        }
        useUi.getState().openView('folder', { folderId: node.id });
    };
    const segments = virtualPathSegments(node.id, ns);
    const rootLabel = virtualTreeRootLabel(ns);
    const pathLabel = segments ? [rootLabel, ...segments].join(' / ') : rootLabel;
    const range = virtualPeriodKeyRange(node.id, ns);
    const tooltip = range ? `${pathLabel} · ${range.start} ~ ${range.end}` : pathLabel;
    const hint = ns === TODO_TREE
        ? t("sidebar.todo_hint_value0", { value0: resolveTodoTag(useSession.getState().settings.notes?.todoTag) })
        : ns === CALENDAR_TREE ? t("sidebar.calendar_hint") : '';
    const menuItems: MenuItem[] = [
        {
            id: 'toggle',
            label: expanded ? t("sidebar.collapse") : t("sidebar.expand"),
            icon: <ChevronRight size={13}/>,
            disabled: !hasChildren,
            onSelect: () => toggleFolder(node.id),
        },
        {
            id: 'expand-all',
            label: t("sidebar.expand_branch"),
            disabled: allIds.length === 0,
            onSelect: () => useUi.setState((state) => ({ expandedFolders: [...new Set([...state.expandedFolders, node.id, ...allIds])] })),
        },
        {
            id: 'collapse-all',
            label: t("sidebar.collapse_branch"),
            disabled: allIds.length === 0,
            onSelect: () => useUi.setState((state) => ({ expandedFolders: state.expandedFolders.filter((id) => id !== node.id && !allIds.includes(id)) })),
        },
        { id: 'open', label: t("sidebar.open_in_list"), icon: <Inbox size={13}/>, separatorBefore: true, onSelect: open },
    ];
    if (showEmptyToggle) {
        menuItems.push({
            id: 'empty',
            label: showEmptyPeriods ? t("sidebar.hide_empty_periods") : t("sidebar.show_empty_periods"),
            separatorBefore: true,
            onSelect: () => saveCalendarPrefs({ showEmptyPeriods: !showEmptyPeriods }),
        });
    }
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
        }
    };
    return (<div role="treeitem" aria-level={node.depth + 2} aria-expanded={hasChildren ? expanded : undefined}>
      <div ref={anchor} onContextMenu={(event) => {
            setMenuOpen(false);
            menu.onContextMenu(event);
        }} className={cn('group relative flex h-11 items-center gap-1 rounded-[var(--r-md)] pr-1 md:h-[30px]', 'transition-colors duration-[var(--dur-fast)]', active
            ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]', node.count === 0 && !isRoot && 'opacity-60')} style={{ paddingLeft: virtualTreeRowIndent(node.depth) }}>
        <Tooltip label={expanded ? t("sidebar.collapse") : t("sidebar.expand")} side="right">
          <button type="button" disabled={!hasChildren} aria-hidden={!hasChildren || undefined} tabIndex={hasChildren ? undefined : -1} data-tree-toggle onClick={(event) => {
                event.stopPropagation();
                toggleFolder(node.id);
            }} aria-label={expanded ? t("sidebar.collapse") : t("sidebar.expand")} className={cn('flex size-8 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] md:size-4', 'transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]', expanded && 'rotate-90', !hasChildren && 'invisible')}>
            <ChevronRight size={12}/>
          </button>
        </Tooltip>
        <span className={cn('shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}>
          {isRoot ? rootIcon : <FolderMotionIcon open={expanded && hasChildren} drawing={false}/>}
        </span>
        <Tooltip label={hint ? `${tooltip} · ${hint}` : tooltip} side="right">
          <button data-tree-row type="button" aria-current={active ? 'page' : undefined} onClick={open} onKeyDown={onKeyDown} className="min-w-0 flex-1 truncate py-1 pl-1 text-left text-[12.5px] font-medium">
            {isRoot ? rootLabel : node.name}
          </button>
        </Tooltip>
        {node.count > 0 && (<span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)] transition-opacity md:group-hover:opacity-0">
          {node.count}
        </span>)}
        <Tooltip label={t("common.more_actions")} side="left">
          <IconButton label={t("common.more_actions")} size="sm" onClick={(event) => {
                event.stopPropagation();
                menu.close();
                setMenuOpen(true);
            }} className="shrink-0 opacity-100 transition-opacity md:absolute md:right-1 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100">
            <ChevronRight size={13} className="rotate-90"/>
          </IconButton>
        </Tooltip>
      </div>
      {childrenMounted && (<div role="group" aria-hidden={!childrenVisible} inert={!childrenVisible} className={cn('folder-children-grid', childrenVisible && 'is-expanded')}>
        <div className="min-h-0 space-y-px overflow-hidden">
          {node.children.map((child) => (<VirtualRow key={child.id} ns={ns} rootIcon={rootIcon} node={child} allIds={descendantIds(child.children)} showEmptyToggle={false}/>))}
        </div>
      </div>)}
      <Menu anchor={anchor} open={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems}/>
      {menu.point && (<Menu anchor={menu.point} open onClose={menu.close} items={menuItems}/>)}
    </div>);
}

export function InboxTree() {
    const { inboxVisible } = useCalendarTreePreferences();
    const notes = useNotes((s) => s.notes);
    const locale = useLocale();
    const unfiled = useMemo(() => Object.values(notes)
        .filter((note) => !note.deletedAt && !note.isArchived && !note.folderId)
        .sort((a, b) => a.title.localeCompare(b.title, locale)), [locale, notes]);
    const expanded = useUi((s) => s.expandedFolders.includes('inbox'));
    const view = useUi((s) => s.view);
    const active = view === 'unfiled';
    const menu = useContextMenu();
    const anchor = useRef<HTMLDivElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const open = () => useUi.getState().openView('unfiled');
    if (!inboxVisible)
        return null;
    const menuItems: MenuItem[] = [
        {
            id: 'toggle',
            label: expanded ? t("sidebar.collapse") : t("sidebar.expand"),
            icon: <ChevronRight size={13}/>,
            disabled: unfiled.length === 0,
            onSelect: () => useUi.getState().toggleFolder('inbox'),
        },
        { id: 'open', label: t("sidebar.open_in_list"), separatorBefore: true, onSelect: open },
    ];
    return (<div role="tree" aria-label={t("sidebar.inbox_folder")} className="mt-0.5 space-y-px" onDragOver={VIRTUAL_DRAG_BLOCK} onDrop={VIRTUAL_DRAG_BLOCK}>
      <div role="treeitem" aria-level={1} aria-expanded={unfiled.length > 0 ? expanded : undefined}>
      <div ref={anchor} onContextMenu={(event) => {
            setMenuOpen(false);
            menu.onContextMenu(event);
        }} className={cn('group relative flex h-11 items-center gap-1 rounded-[var(--r-md)] pr-1 md:h-[30px]', 'transition-colors duration-[var(--dur-fast)]', active
            ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')} style={{ paddingLeft: treeRowIndent(0) }}>
        <Tooltip label={expanded ? t("sidebar.collapse") : t("sidebar.expand")} side="right">
          <button type="button" disabled={unfiled.length === 0} aria-hidden={unfiled.length === 0 || undefined} tabIndex={unfiled.length ? undefined : -1} data-tree-toggle onClick={(event) => {
                event.stopPropagation();
                useUi.getState().toggleFolder('inbox');
            }} aria-label={expanded ? t("sidebar.collapse") : t("sidebar.expand")} className={cn('flex size-8 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] md:size-4', 'transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]', expanded && 'rotate-90', unfiled.length === 0 && 'invisible')}>
            <ChevronRight size={12}/>
          </button>
        </Tooltip>
        <span className={cn('shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}>
          <Inbox size={14}/>
        </span>
        <Tooltip label={t("sidebar.inbox_hint")} side="right">
          <button data-tree-row type="button" aria-current={active ? 'page' : undefined} onClick={open} className="min-w-0 flex-1 truncate py-1 pl-1 text-left text-[12.5px] font-medium">
            {t("sidebar.inbox_folder")}
          </button>
        </Tooltip>
        {unfiled.length > 0 && (<span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)] transition-opacity md:group-hover:opacity-0">
          {unfiled.length}
        </span>)}
        <Tooltip label={t("common.more_actions")} side="left">
          <IconButton label={t("common.more_actions")} size="sm" onClick={(event) => {
                event.stopPropagation();
                menu.close();
                setMenuOpen(true);
            }} className="shrink-0 opacity-100 transition-opacity md:absolute md:right-1 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100">
            <ChevronRight size={13} className="rotate-90"/>
          </IconButton>
        </Tooltip>
      </div>
      {expanded && unfiled.length > 0 && (<div role="group" className="min-h-0 space-y-px overflow-hidden">
        {unfiled.map((note) => <ExplorerNote key={note.id} note={note} depth={1} canOpenToSide={false}/>)}
      </div>)}
      </div>
      <Menu anchor={anchor} open={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems}/>
      {menu.point && (<Menu anchor={menu.point} open onClose={menu.close} items={menuItems}/>)}
    </div>);
}
