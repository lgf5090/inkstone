import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronsUpDown, Hash, MoreHorizontal, Pin, Plus, Tag, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { splitByRanges } from '../../lib/fuzzy';
import { compileQuery, queryMatches, type Query } from '../../lib/query-match';
import { FilterInput } from '../../components/FilterInput';
import { buildTagTree, childTagPath, collectParentPaths, flattenTagTree, renameTagSegment, searchTagTree, siblingParentPaths } from '../../lib/tag-tree';
import type { TagTreeNode } from '../../lib/tag-tree';
import { IconButton, SectionLabel } from '../../components/primitives';
import { commitOnEnter } from '../../components/form';
import { Menu, Tooltip, useContextMenu, type MenuItem } from '../../components/overlay';
import { useNavigationCounts, useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { t } from '../../lib/i18n';
import { ManageTagsModal } from './ManageTagsModal';
import { useTagMenuItems } from './useTagMenuItems';
import { createTag, moveTag, renameTag, tagMoveTarget } from './tagMutations';
import { beginTagDrag, currentTagDrag, droppedTagName, endTagDrag, findDroppedTag, isTagDrag } from './tagDrag';
import { useLinkHoverHost } from '../preview/link-hover-host';
import { WikiLinkHoverCard } from '../preview/wiki-link-hover-card';
import { encodeDataValue } from '../../lib/markdown/data-attr';
import { usePinyinVersion } from '../../lib/pinyin'

const COLLAPSED_ROW_LIMIT = 12;
const ROOT_DROP = '\u0000root';

export function SidebarTags({ mobile = false }: { mobile?: boolean }) {
    const tags = useNotes((s) => s.tags);
    const counts = useNavigationCounts();
    const view = useUi((s) => s.view);
    const listVisible = useUi((s) => !s.listCollapsed && !s.searchList);
    const activeTags = useUi((s) => s.tags);
    const openView = useUi((s) => s.openView);
    const toggleTagFilter = useUi((s) => s.toggleTagFilter);
    const toggleTagExclusion = useUi((s) => s.toggleTagExclusion);
    const excludedTags = useUi((s) => s.excludedTags);
    const [query, setQuery] = useState('');
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    const [listOpen, setListOpen] = useState(false);
    const [cursor, setCursor] = useState(-1);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [draftParent, setDraftParent] = useState<string | null>(null);
    const [manageOpen, setManageOpen] = useState(false);
    const [dropPath, setDropPath] = useState<string | null>(null);
    const [dragPath, setDragPath] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const tree = useMemo(() => buildTagTree(tags), [tags]);
    const hover = useLinkHoverHost(null);
    // Expansion is keyed by path, so a rename or a move would otherwise collapse the branch the
    // user was looking at. Replay the path change against the open set as the tags arrive.
    const previousPaths = useRef(new Map<string, string>());
    useEffect(() => {
        const renamed = new Map<string, string>()
        for (const tag of tags) {
            const before = previousPaths.current.get(tag.id)
            if (before && before !== tag.name) renamed.set(before, tag.name)
        }
        previousPaths.current = new Map(tags.map((tag) => [tag.id, tag.name]))
        if (!renamed.size) return
        setExpanded((current) => {
            let changed = false
            const next = new Set<string>()
            for (const path of current) {
                let translated = path
                for (const [from, to] of renamed) {
                    if (path === from) { translated = to; break }
                    if (path.startsWith(`${from}/`)) { translated = to + path.slice(from.length); break }
                }
                if (translated !== path) changed = true
                next.add(translated)
            }
            return changed ? next : current
        })
    }, [tags]);
    const searching = Boolean(query.trim());
    const pinyinVersion = usePinyinVersion()
    const tagQuery = useMemo(() => compileQuery(query), [query]);
    const searched = useMemo(() => searchTagTree(tree, tagQuery), [tree, tagQuery, pinyinVersion]);
    const shownNodes = searching ? searched.nodes : tree;
    const parentPaths = useMemo(() => collectParentPaths(shownNodes), [shownNodes]);
    const allExpanded = parentPaths.length > 0 && parentPaths.every((path) => expanded.has(path));
    const flattened = useMemo(() => flattenTagTree(shownNodes, searching ? new Set(parentPaths) : expanded), [shownNodes, expanded, searching, parentPaths]);
    const rows = searching || listOpen ? flattened : flattened.slice(0, COLLAPSED_ROW_LIMIT);
    const open = (path: string, additive: boolean) => {
        setCursor(-1);
        if (additive)
            toggleTagFilter(path, true);
        else
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
    const draggedTag = () => {
        const name = dragPath ?? currentTagDrag();
        return name ? findDroppedTag(tags, name) : null;
    };
    return (<>
      <section className="mt-4">
      <div
        className="group/head flex items-center justify-between pr-1"
        onDragOver={(event) => {
          if (!isTagDrag(event.dataTransfer) || !tagMoveTarget(draggedTag(), null)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropPath(ROOT_DROP);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropPath(null);
        }}
        onDrop={(event) => {
          event.preventDefault();
          const name = droppedTagName(event.dataTransfer);
          endTagDrag();
          setDropPath(null);
          setDragPath(null);
          const source = name ? findDroppedTag(tags, name) : null;
          if (source) void moveTag(source, null);
        }}>
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
        <FilterInput value={query} onChange={(next) => {
                setQuery(next);
                setCursor(-1);
            }} query={tagQuery} label={t('tags.filter')} placeholder={t('tags.filter_placeholder')} inputRef={inputRef} data-tag-filter onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    moveCursor(1);
                }
                if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    moveCursor(-1);
                }
                if (event.key === 'Enter' && rows[cursor])
                    open(rows[cursor]!.fullPath, false);
            }}/>
        {searching && rows.length > 0 && <p className="px-2 pt-1 text-[10.5px] tabular text-[var(--text-quaternary)]">{t('tags.match_count', { value0: searched.hitCount })}</p>}
      </>)}

      <div ref={listRef} role="tree" aria-label={t('navigation.tag')} className="mt-0.5 space-y-px" onMouseMove={hover.hover.handleMouseMove} onMouseLeave={hover.onMouseLeave}>
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
        {rows.map((node, index) => (<TagTreeRow key={node.fullPath} node={node} query={tagQuery} expanded={expanded.has(node.fullPath)} active={(mobile || listVisible) && view === 'tag' && activeTags.includes(node.fullPath)} highlighted={index === cursor} renaming={renamingId === node.tag.id} onToggle={() => setExpanded((previous) => toggleSet(previous, node.fullPath))} onOpen={(event) => open(node.fullPath, event.metaKey || event.ctrlKey)} onStartRename={() => setRenamingId(node.tag.id)} onFinishRename={(value) => {
                    setRenamingId(null);
                    void renameTag(node.tag, renameTagSegment(node.fullPath, value));
                }} onCancelRename={() => setRenamingId(null)} excluded={excludedTags.includes(node.fullPath)} onToggleLevel={(paths, open) => setExpanded((previous) => { const next = new Set(previous); for (const path of paths) { if (open) next.add(path); else next.delete(path) } return next })} levelSiblings={siblingParentPaths(tree, node.fullPath)} onCreateChild={startDraft} onManage={() => setManageOpen(true)} dragging={dragPath === node.fullPath} dropTarget={dropPath === node.fullPath} dropHint={dropPath === node.fullPath ? tagMoveTarget(draggedTag(), node.fullPath) : null} onDragStart={(event) => {
                    if (node.isVirtual) return;
                    beginTagDrag(node.fullPath, event.dataTransfer);
                    setDragPath(node.fullPath);
                }} onDragEnd={() => {
                    endTagDrag();
                    setDragPath(null);
                    setDropPath(null);
                }} onDragOver={(event) => {
                    if (!isTagDrag(event.dataTransfer) || !tagMoveTarget(draggedTag(), node.fullPath)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = 'move';
                    setDropPath(node.fullPath);
                }} onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null) && dropPath === node.fullPath) setDropPath(null);
                }} onDrop={(event) => {
                    if (dropPath !== node.fullPath) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const name = droppedTagName(event.dataTransfer);
                    endTagDrag();
                    setDropPath(null);
                    setDragPath(null);
                    const source = name ? findDroppedTag(tags, name) : null;
                    if (source) void moveTag(source, node.fullPath);
                }}/>))}
        {(activeTags.length > 1 || excludedTags.length > 0) && (<div className="flex flex-wrap items-center gap-1 pt-1 text-[11px]">
            {activeTags.length > 1 && <span className="shrink-0 text-[var(--text-quaternary)]">{t('tags.matching_all', { value0: activeTags.length })}</span>}
            {activeTags.map((name) => (<button key={name} type="button" onClick={() => toggleTagFilter(name, true)} className="flex max-w-[10rem] items-center gap-0.5 rounded-[var(--r-sm)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                <span className="truncate">#{name}</span>
                <X size={9} className="shrink-0"/>
              </button>))}
            {excludedTags.map((name) => (<button key={name} type="button" onClick={() => toggleTagExclusion(name)} className="flex max-w-[10rem] items-center gap-0.5 rounded-[var(--r-sm)] bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--text-secondary)] line-through decoration-[var(--danger)]">
                <span className="truncate">#{name}</span>
                <X size={9} className="shrink-0 no-underline"/>
              </button>))}
            <button type="button" onClick={() => {
                    openView('all');
                    for (const name of excludedTags) toggleTagExclusion(name);
                }} className="px-1 text-[var(--accent)] hover:underline">{t('common.clear')}</button>
          </div>)}
        {!searching && flattened.length > COLLAPSED_ROW_LIMIT && (<button type="button" onClick={() => setListOpen((value) => !value)} className="h-10 w-full rounded-[var(--r-md)] px-2 text-left text-[11.5px] text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] md:h-[26px]">
            {listOpen ? t('common.collapse') : t('sidebar.show_all_value0_tags', { value0: flattened.length })}
          </button>)}
      </div>
      </section>
      {hover.hover.card && (<WikiLinkHoverCard
          card={hover.hover.card}
          path={hover.hover.card.noteId ? [hover.hover.card.noteId] : []}
          depth={1}
          dark={(document.documentElement.dataset.theme ?? 'dark') === 'dark'}
          onClose={hover.hover.hideNow}
          onEnter={hover.hover.clearPendingHide}
          onLeave={hover.hover.armHide}
          onPin={hover.handlePin}
        />)}
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
    query: Query;
}) {
    const match = queryMatches(query, name);
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
            commitOnEnter(event, () => finish(event.currentTarget.value));
            if (event.key === 'Escape') {
                finishedRef.current = true;
                onCancel();
            }
            event.stopPropagation();
        }} className="min-w-0 flex-1 rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1 py-px text-[12.5px] outline-none"/>
    </div>);
}
function TagTreeRow({ node, query, expanded, active, highlighted, renaming, onToggle, onOpen, onStartRename, onFinishRename, onCancelRename, excluded, onToggleLevel, levelSiblings, onCreateChild, onManage, dragging, dropTarget, dropHint, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop, }: {
    node: TagTreeNode;
    query: Query;
    expanded: boolean;
    active: boolean;
    highlighted: boolean;
    renaming: boolean;
    onToggle: () => void;
    onOpen: (event: React.MouseEvent<HTMLButtonElement>) => void;
    onStartRename: () => void;
    onFinishRename: (value: string) => void;
    onCancelRename: () => void;
    excluded: boolean;
    onToggleLevel: (paths: readonly string[], open: boolean) => void;
    levelSiblings: readonly string[];
    onCreateChild: (path: string) => void;
    onManage: () => void;
    dragging: boolean;
    dropTarget: boolean;
    dropHint: string | null;
    onDragStart: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragEnd: () => void;
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
    onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
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
    const realTagItems = useTagMenuItems(node.tag.name, {
        excluded,
        onStartRename,
        onCreateChild,
        onManage,
    });
    const menuItems: MenuItem[] = node.isVirtual
        ? levelSiblings.length
            ? [{ id: 'expand', label: expanded ? t('tags.collapse_children') : t('tags.expand_children'), icon: <ChevronRight size={13}/>, onSelect: onToggle },
               { id: 'level', label: t('tags.expand_level'), icon: <ChevronsUpDown size={13}/>, onSelect: () => onToggleLevel(levelSiblings, true) },
               { id: 'level-collapse', label: t('tags.collapse_level'), icon: <ChevronsUpDown size={13}/>, onSelect: () => onToggleLevel(levelSiblings, false) }]
            : [{ id: 'expand', label: expanded ? t('tags.collapse_children') : t('tags.expand_children'), icon: <ChevronRight size={13}/>, onSelect: onToggle }]
        : realTagItems;
    return (<div ref={rowRef} role="treeitem" aria-level={node.depth + 1} aria-expanded={hasChildren ? expanded : undefined} aria-selected={active} data-tag={encodeDataValue(node.fullPath)} data-tag-row data-row-index={node.isVirtual ? undefined : node.tag.id} onContextMenu={(event) => {
            setMenuOpen(false);
            menu.onContextMenu(event);
        }} draggable={!node.isVirtual} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} className={cn('group relative flex h-11 items-center gap-1 rounded-[var(--r-md)] pr-1 text-[12.5px] transition-colors duration-[var(--dur-fast)] md:h-[30px]', highlighted && 'ring-1 ring-[var(--accent-ring)]', dropTarget && 'ring-1 ring-[var(--accent)] bg-[var(--accent-soft)]', dragging && 'opacity-45', active
            ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')} style={{ paddingLeft: 4 + node.depth * 13 }}>
      {hasChildren ? (<button type="button" aria-label={expanded ? t('tags.collapse_children') : t('tags.expand_children')} onClick={onToggle} className="flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] md:size-5">
            <ChevronRight size={13} className={cn('transition-transform duration-[var(--dur-fast)]', expanded && 'rotate-90')}/>
          </button>) : <span className="size-6 shrink-0 md:size-5"/>}
      <Hash size={13} className="shrink-0" style={{ color: node.tag.color ?? (active ? 'var(--accent)' : 'var(--text-quaternary)') }}/>
      {node.tag.isPinned && <Pin size={10} className="shrink-0 text-[var(--text-quaternary)]"/>}
      {excluded && <span aria-hidden="true" className="shrink-0 text-[11px] text-[var(--danger)]">−</span>}
      {renaming ? (<input aria-label={t('tags.rename')} autoFocus defaultValue={node.name} onFocus={() => {
            finishedRef.current = false;
        }} onBlur={(event) => finishRename(event.currentTarget.value)} onKeyDown={(event) => {
            commitOnEnter(event, () => finishRename(event.currentTarget.value));
            if (event.key === 'Escape') {
                finishedRef.current = true;
                onCancelRename();
            }
            event.stopPropagation();
        }} className="min-w-0 flex-1 rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1 py-px text-[12.5px] outline-none"/>) : (<button data-navigation-item type="button" title={t('tags.cmd_click')} aria-current={active ? 'page' : undefined} onClick={onOpen} onDoubleClick={node.isVirtual ? undefined : onStartRename} className="min-w-0 flex-1 truncate py-1 text-left font-medium">
          <TagNameText name={node.name} query={query}/>
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
      {dropHint && (<span className="pointer-events-none absolute top-1/2 right-1 max-w-[72%] -translate-y-1/2 truncate rounded-[var(--r-sm)] bg-[var(--accent)] px-1.5 py-0.5 text-[10.5px] text-[var(--accent-contrast)]">
            {t('tags.move_to_value0', { value0: dropHint })}
          </span>)}
      <Menu anchor={rowRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems}/>
      {menu.point && (<Menu anchor={menu.point} open onClose={menu.close} items={menuItems}/>)}
    </div>);
}
