import { useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronsUpDown, CornerDownRight, Hash, MoreHorizontal, Palette, Pencil, Pin, Plus, Search, Settings2, Tag, Trash2, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { fuzzyMatch, splitByRanges } from '../../lib/fuzzy';
import { buildTagTree, childTagPath, collectParentPaths, flattenTagTree, searchTagTree } from '../../lib/tag-tree';
import type { TagTreeNode } from '../../lib/tag-tree';
import { IconButton, SectionLabel } from '../../components/primitives';
import { Menu, Tooltip, useContextMenu, type MenuItem } from '../../components/overlay';
import { useNavigationCounts, useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { t } from '../../lib/i18n';
import { ManageTagsModal } from './ManageTagsModal';
import { TagAppearance } from './TagAppearance';
import { createTag, deleteTag, renameTag, setTagColor, setTagPinned } from './tagMutations';

const COLLAPSED_ROW_LIMIT = 12;

export function SidebarTags({ mobile = false }: { mobile?: boolean }) {
    const tags = useNotes((s) => s.tags);
    const counts = useNavigationCounts();
    const view = useUi((s) => s.view);
    const listVisible = useUi((s) => !s.listCollapsed && !s.searchList);
    const activeTag = useUi((s) => s.tag);
    const openView = useUi((s) => s.openView);
    const [query, setQuery] = useState('');
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    const [listOpen, setListOpen] = useState(false);
    const [cursor, setCursor] = useState(-1);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [appearanceId, setAppearanceId] = useState<string | null>(null);
    const [draftParent, setDraftParent] = useState<string | null>(null);
    const [manageOpen, setManageOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const tree = useMemo(() => buildTagTree(tags), [tags]);
    const searching = Boolean(query.trim());
    const searched = useMemo(() => searchTagTree(tree, query), [tree, query]);
    const shownNodes = searching ? searched.nodes : tree;
    const parentPaths = useMemo(() => collectParentPaths(shownNodes), [shownNodes]);
    const allExpanded = parentPaths.length > 0 && parentPaths.every((path) => expanded.has(path));
    const flattened = useMemo(() => flattenTagTree(shownNodes, searching ? new Set(parentPaths) : expanded), [shownNodes, expanded, searching, parentPaths]);
    const rows = searching || listOpen ? flattened : flattened.slice(0, COLLAPSED_ROW_LIMIT);
    const appearanceTag = appearanceId ? tags.find((tag) => tag.id === appearanceId) ?? null : null;
    const open = (path: string) => {
        setCursor(-1);
        openView('tag', { tag: path });
    };
    const moveCursor = (step: number) => {
        if (!rows.length)
            return;
        const next = (cursor + step + rows.length) % rows.length;
        setCursor(next);
        scrollRowIntoView(listRef.current, next);
    };
    const startDraft = (parent: string) => {
        setDraftParent(parent);
        if (parent)
            setExpanded((previous) => previous.has(parent) ? previous : new Set([...previous, parent]));
    };
    const finishCreate = (value: string) => {
        const name = draftParent ? childTagPath(draftParent, value) : value;
        setDraftParent(null);
        const id = createTag(name);
        if (!id)
            return;
        const created = useNotes.getState().tags.find((tag) => tag.id === id);
        if (created)
            openView('tag', { tag: created.name });
    };
    return (<>
      <section className="mt-4">
      <div className="group/head flex items-center justify-between pr-1">
        {mobile
            ? <button data-navigation-item type="button" onClick={() => openView('all')} className="min-h-11 rounded-lg px-2 text-left text-[13px] text-[var(--accent)]">{t('navigation.all_notes')}</button>
            : <SectionLabel>{t('navigation.tag')}</SectionLabel>}
        <div className="flex items-center gap-px">
          {parentPaths.length > 0 && (<Tooltip label={allExpanded ? t('tags.collapse_all') : t('tags.expand_all')} side="left">
              <IconButton label={allExpanded ? t('tags.collapse_all') : t('tags.expand_all')} size="sm" onClick={() => {
                    setExpanded(allExpanded ? new Set() : new Set(parentPaths));
                    setListOpen(!allExpanded);
                }} className="opacity-100 transition-opacity md:opacity-0 md:group-hover/head:opacity-100 md:focus-visible:opacity-100">
                <ChevronsUpDown size={13} className={cn('transition-transform duration-[var(--dur-fast)]', allExpanded && 'rotate-180')}/>
              </IconButton>
            </Tooltip>)}
          <Tooltip label={t('tags.new')} side="left">
            <IconButton label={t('tags.new')} size="sm" onClick={() => startDraft('')} className="opacity-100 transition-opacity md:opacity-0 md:group-hover/head:opacity-100 md:focus-visible:opacity-100">
              <Plus size={13}/>
            </IconButton>
          </Tooltip>
        </div>
      </div>

      {tags.length > 0 && (<>
        <div className="relative mt-1">
          <Search size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[var(--text-quaternary)]"/>
          <input ref={inputRef} aria-label={t('tags.filter')} type="search" value={query} placeholder={t('tags.filter_placeholder')} onChange={(event) => {
                setQuery(event.target.value);
                setCursor(-1);
            }} onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    if (query)
                        setQuery('');
                    else
                        inputRef.current?.blur();
                }
                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    moveCursor(1);
                }
                if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    moveCursor(-1);
                }
                if (event.key === 'Enter' && rows[cursor])
                    open(rows[cursor]!.fullPath);
                event.stopPropagation();
            }} className={cn('h-10 w-full rounded-[var(--r-md)] border border-transparent bg-[var(--bg-inset)] pr-7 pl-7 text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] md:h-[28px] md:pr-6', 'transition-[border-color,box-shadow] duration-[var(--dur-fast)]', 'focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-ring)] focus:outline-none')}/>
          {query && (<button type="button" aria-label={t('notes.clear_filters')} onClick={() => {
                    setQuery('');
                    inputRef.current?.focus();
                }} className="absolute top-1/2 right-1 flex size-8 -translate-y-1/2 items-center justify-center rounded text-[var(--text-quaternary)] hover:text-[var(--text-secondary)] md:size-6">
              <X size={11}/>
            </button>)}
        </div>
        {searching && rows.length > 0 && <p className="px-2 pt-1 text-[10.5px] tabular text-[var(--text-quaternary)]">{t('tags.match_count', { value0: searched.hitCount })}</p>}
      </>)}

      <div ref={listRef} role="tree" aria-label={t('navigation.tag')} className="mt-0.5 space-y-px">
        {!searching && tags.length > 0 && (<button data-navigation-item type="button" aria-current={view === 'untagged' ? 'page' : undefined} onClick={() => {
                    setCursor(-1);
                    openView('untagged');
                }} className={cn('flex h-11 w-full items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[12.5px] font-medium transition-colors duration-[var(--dur-fast)] md:h-[30px]', view === 'untagged'
                    ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
            <Tag size={13} className="shrink-0 text-[var(--text-quaternary)]"/>
            <span className="min-w-0 flex-1 truncate">{t('navigation.untagged')}</span>
            <span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)] transition-opacity md:group-hover:opacity-0">{counts.untagged || ''}</span>
          </button>)}
        {draftParent !== null && <TagDraftRow leaf={draftParent} onFinish={finishCreate} onCancel={() => setDraftParent(null)}/>}
        {!tags.length && draftParent === null && <button type="button" onClick={() => startDraft('')} className="flex h-10 w-full items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[11.5px] text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] md:h-[30px]">
            <Plus size={13}/>{t('tags.create_first')}
          </button>}
        {searching && !rows.length && <p className="flex items-center gap-2 px-2 py-2 text-[11.5px] text-[var(--text-quaternary)]">
            <X size={12}/>{t('tags.no_match')}
            <button type="button" onClick={() => {
                    setQuery('');
                    inputRef.current?.focus();
                }} className="text-[var(--accent)] hover:underline">{t('notes.clear_filters')}</button>
          </p>}
        {rows.map((node, index) => (<TagTreeRow key={node.fullPath} node={node} searching={searching} query={query} expanded={expanded.has(node.fullPath)} active={(mobile || listVisible) && view === 'tag' && activeTag === node.fullPath} highlighted={index === cursor} renaming={renamingId === node.tag.id} onToggle={() => setExpanded((previous) => toggleSet(previous, node.fullPath))} onOpen={() => open(node.fullPath)} onStartRename={() => setRenamingId(node.tag.id)} onFinishRename={(value) => {
                    setRenamingId(null);
                    void renameTag(node.tag, value);
                }} onCancelRename={() => setRenamingId(null)} onEditColor={() => setAppearanceId(node.tag.id)} onCreateChild={startDraft} onManage={() => setManageOpen(true)}/>))}
        {!searching && flattened.length > COLLAPSED_ROW_LIMIT && (<button type="button" onClick={() => setListOpen((value) => !value)} className="h-10 w-full rounded-[var(--r-md)] px-2 text-left text-[11.5px] text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] md:h-[26px]">
            {listOpen ? t('common.collapse') : t('sidebar.show_all_value0_tags', { value0: flattened.length })}
          </button>)}
      </div>
      </section>
      <TagAppearance open={Boolean(appearanceTag)} tag={appearanceTag} onChange={(color) => {
            if (appearanceTag)
                void setTagColor(appearanceTag, color);
        }} onClose={() => setAppearanceId(null)}/>
      <ManageTagsModal open={manageOpen} onClose={() => setManageOpen(false)}/>
    </>);
}
function toggleSet(previous: ReadonlySet<string>, value: string): Set<string> {
    const next = new Set(previous);
    if (next.has(value))
        next.delete(value);
    else
        next.add(value);
    return next;
}
function scrollRowIntoView(list: HTMLElement | null, index: number): void {
    const rows = list?.querySelectorAll('[data-tag-row]');
    rows?.[index]?.scrollIntoView({ block: 'nearest' });
}
function TagNameText({ name, query }: {
    name: string;
    query: string;
}) {
    const match = query.trim() ? fuzzyMatch(name, query) : null;
    if (!match)
        return name;
    return splitByRanges(name, match.ranges).map((part, index) => part.hit
        ? <span key={index} className="font-semibold text-[var(--accent)]">{part.text}</span>
        : <span key={index}>{part.text}</span>);
}
function TagDraftRow({ leaf, onFinish, onCancel }: {
    leaf: string | null;
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
      {leaf && <span className="shrink-0 text-[12.5px] text-[var(--text-quaternary)]">{leaf}/</span>}
      <input aria-label={t('tags.new')} autoFocus placeholder={leaf ? t('tags.new_leaf_placeholder') : t('tags.new_placeholder')} onBlur={(event) => {
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
function TagTreeRow({ node, searching, query, expanded, active, highlighted, renaming, onToggle, onOpen, onStartRename, onFinishRename, onCancelRename, onEditColor, onCreateChild, onManage, }: {
    node: TagTreeNode;
    searching: boolean;
    query: string;
    expanded: boolean;
    active: boolean;
    highlighted: boolean;
    renaming: boolean;
    onToggle: () => void;
    onOpen: () => void;
    onStartRename: () => void;
    onFinishRename: (value: string) => void;
    onCancelRename: () => void;
    onEditColor: () => void;
    onCreateChild: (path: string) => void;
    onManage: () => void;
}) {
    const menu = useContextMenu();
    const rowRef = useRef<HTMLDivElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const finishedRef = useRef(false);
    const hasChildren = node.children.length > 0;
    const finishRename = (value: string) => {
        if (finishedRef.current)
            return;
        finishedRef.current = true;
        onFinishRename(value);
    };
    const menuItems: MenuItem[] = node.isVirtual
        ? [{ id: 'expand', label: expanded ? t('tags.collapse_children') : t('tags.expand_children'), icon: <ChevronRight size={13}/>, onSelect: onToggle }]
        : [
            { id: 'pin', label: node.tag.isPinned ? t('tags.unpin') : t('tags.pin'), icon: <Pin size={13}/>, onSelect: () => void setTagPinned(node.tag, !node.tag.isPinned) },
            { id: 'rename', label: t('tags.rename'), icon: <Pencil size={13}/>, onSelect: onStartRename },
            { id: 'child', label: t('tags.new_child'), icon: <CornerDownRight size={13}/>, onSelect: () => onCreateChild(node.fullPath) },
            { id: 'color', label: t('tags.color'), icon: <Palette size={13}/>, onSelect: onEditColor },
            { id: 'manage', label: t('tags.manage'), icon: <Settings2 size={13}/>, onSelect: onManage },
            { id: 'delete', label: t('tags.delete'), icon: <Trash2 size={13}/>, tone: 'danger', separatorBefore: true, onSelect: () => void deleteTag(node.tag) },
        ];
    return (<div ref={rowRef} role="treeitem" aria-level={node.depth + 1} aria-expanded={hasChildren ? expanded : undefined} aria-selected={active} data-tag-row data-row-index={node.isVirtual ? undefined : node.tag.id} onContextMenu={(event) => {
            setMenuOpen(false);
            menu.onContextMenu(event);
        }} className={cn('group relative flex h-11 items-center gap-1 rounded-[var(--r-md)] pr-1 text-[12.5px] transition-colors duration-[var(--dur-fast)] md:h-[30px]', highlighted && 'ring-1 ring-[var(--accent-ring)]', active
            ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')} style={{ paddingLeft: 4 + node.depth * 13 }}>
      {hasChildren ? (<button type="button" aria-label={expanded ? t('tags.collapse_children') : t('tags.expand_children')} onClick={onToggle} className="flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] md:size-5">
            <ChevronRight size={13} className={cn('transition-transform duration-[var(--dur-fast)]', expanded && 'rotate-90')}/>
          </button>) : <span className="size-6 shrink-0 md:size-5"/>}
      <Hash size={13} className="shrink-0" style={{ color: node.tag.color ?? (active ? 'var(--accent)' : 'var(--text-quaternary)') }}/>
      {node.tag.isPinned && <Pin size={10} className="shrink-0 text-[var(--text-quaternary)]"/>}
      {renaming ? (<input aria-label={t('tags.rename')} autoFocus defaultValue={node.name} onFocus={() => {
            finishedRef.current = false;
        }} onBlur={(event) => finishRename(event.currentTarget.value)} onKeyDown={(event) => {
            if (event.key === 'Enter')
                finishRename(event.currentTarget.value);
            if (event.key === 'Escape') {
                finishedRef.current = true;
                onCancelRename();
            }
            event.stopPropagation();
        }} className="min-w-0 flex-1 rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1 py-px text-[12.5px] outline-none"/>) : (<button data-navigation-item type="button" aria-current={active ? 'page' : undefined} onClick={onOpen} onDoubleClick={node.isVirtual ? undefined : onStartRename} className="min-w-0 flex-1 truncate py-1 text-left font-medium">
          <TagNameText name={node.name} query={searching ? query : ''}/>
        </button>)}
      {!renaming && (<>
          <span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)] transition-opacity md:group-hover:opacity-0">
            {node.count > 0 || hasChildren ? (hasChildren ? node.totalCount : node.count) : ''}
          </span>
          <Tooltip label={t('common.more_actions')} side="left">
            <IconButton label={t('common.more_actions')} size="sm" onClick={(event) => {
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
