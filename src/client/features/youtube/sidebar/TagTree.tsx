/**
 * The sidebar tag forest: rows that select a tag, carry a count, open on right-click or a
 * "more" button, rename in place, drag onto another tag to re-parent, and accept a colour from the
 * same flyout the notebook uses.
 */
import { useRef, useState, type DragEvent, type MouseEvent } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  CornerDownRight,
  MoreHorizontal,
  Palette,
  Pencil,
  Pin,
  Search,
  Settings2,
  Trash2,
} from 'lucide-react'
import type { Query } from '../../../lib/query-match'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { treeIndent } from '../../../lib/tree'
import { youtubeViewPath, type YouTubeTag, type YouTubeTagNode } from '@shared/youtube/model'
import { YOUTUBE_DEFAULT_TAG_COLOR } from '@shared/youtube/validate'
import { IconButton } from '../../../components/primitives'
import { Menu, Tooltip, useContextMenu, type MenuItem } from '../../../components/overlay'
import { TagColorMenu } from '../../tags/TagAppearanceMenus'
import { TagNameHighlight, TagRenameField } from '../../tags/tag-row-parts'
import { beginTagDrag, endTagDrag, isTagDrag, droppedTagId } from '../tags/tagDrag'

export interface TagRowActions {
  onToggle: (id: string) => void
  onSelect: (tag: YouTubeTag) => void
  onStartRename: (id: string) => void
  onFinishRename: (tag: YouTubeTag, name: string) => void
  onCancelRename: () => void
  onCreateChild: (tag: YouTubeTag) => void
  onEditColor: (tag: YouTubeTag, color: string) => void
  onTogglePin: (tag: YouTubeTag) => void
  onManage: () => void
  onDelete: (tag: YouTubeTag) => void
  onCopyName: (name: string) => void
  onSearchVideos: (name: string) => void
  onMove: (tag: YouTubeTag, direction: -1 | 1) => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onDrop: (sourceId: string, targetId: string | null) => void
  draggingId: string | null
  dropTargetId: string | null
  renamingId: string | null
}

export interface TagTreeProps extends TagRowActions {
  nodes: YouTubeTagNode[]
  flat?: { tag: YouTubeTag; depth: number }[]
  expanded: ReadonlySet<string>
  activeTagId: string | null
  countFor: (tagId: string) => number
  query: Query
  siblingsOf: (tag: YouTubeTag) => YouTubeTag[]
  draft: { parentId: string | null } | null
  onDraftCommit: (name: string) => void
  onDraftCancel: () => void
}

export function TagTree({
  nodes,
  flat,
  expanded,
  activeTagId,
  countFor,
  query,
  siblingsOf,
  draft,
  onDraftCommit,
  onDraftCancel,
  ...actions
}: TagTreeProps) {
  if (flat) {
    return (
      <div role="tree" aria-label={t('youtube.sidebar.tags')}>
        {draft?.parentId === null && <TagDraftRow depth={0} onCommit={onDraftCommit} onCancel={onDraftCancel} />}
        {flat.map(({ tag, depth }) => (
          <TagRow
            key={tag.id}
            tag={tag}
            depth={depth}
            hasChildren={false}
            expanded={false}
            active={activeTagId === tag.id}
            count={countFor(tag.id)}
            query={query}
            siblings={siblingsOf(tag)}
            {...actions}
          />
        ))}
      </div>
    )
  }
  return (
    <div role="tree" aria-label={t('youtube.sidebar.tags')}>
      {draft?.parentId === null && <TagDraftRow depth={0} onCommit={onDraftCommit} onCancel={onDraftCancel} />}
      {nodes.map((node) => (
        <TagBranch
          key={node.id}
          node={node}
          depth={0}
          expanded={expanded}
          activeTagId={activeTagId}
          countFor={countFor}
          query={query}
          siblingsOf={siblingsOf}
          draft={draft}
          onDraftCommit={onDraftCommit}
          onDraftCancel={onDraftCancel}
          {...actions}
        />
      ))}
    </div>
  )
}

function TagBranch({
  node,
  depth,
  expanded,
  activeTagId,
  countFor,
  query,
  siblingsOf,
  draft,
  onDraftCommit,
  onDraftCancel,
  ...actions
}: {
  node: YouTubeTagNode
  depth: number
  expanded: ReadonlySet<string>
  activeTagId: string | null
  countFor: (tagId: string) => number
  query: Query
  siblingsOf: (tag: YouTubeTag) => YouTubeTag[]
  draft: { parentId: string | null } | null
  onDraftCommit: (name: string) => void
  onDraftCancel: () => void
} & TagRowActions) {
  const open = expanded.has(node.id)
  return (
    <>
      <TagRow
        tag={node}
        depth={depth}
        hasChildren={node.children.length > 0}
        expanded={open}
        active={activeTagId === node.id}
        count={countFor(node.id)}
        query={query}
        siblings={siblingsOf(node)}
        {...actions}
      />
      {draft?.parentId === node.id && (
        <TagDraftRow depth={depth + 1} onCommit={onDraftCommit} onCancel={onDraftCancel} />
      )}
      {open && node.children.length > 0 && (
        <div role="group">
          {node.children.map((child) => (
            <TagBranch
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              activeTagId={activeTagId}
              countFor={countFor}
              query={query}
              siblingsOf={siblingsOf}
              draft={draft}
              onDraftCommit={onDraftCommit}
              onDraftCancel={onDraftCancel}
              {...actions}
            />
          ))}
        </div>
      )}
    </>
  )
}

function TagRow({
  tag,
  depth,
  hasChildren,
  expanded,
  active,
  count,
  query,
  siblings,
  onToggle,
  onSelect,
  onStartRename,
  onFinishRename,
  onCancelRename,
  onCreateChild,
  onEditColor,
  onTogglePin,
  onManage,
  onDelete,
  onCopyName,
  onSearchVideos,
  onMove,
  onDragStart,
  onDragEnd,
  onDrop,
  draggingId,
  dropTargetId,
  renamingId,
}: {
  tag: YouTubeTag
  depth: number
  hasChildren: boolean
  expanded: boolean
  active: boolean
  count: number
  query: Query
  siblings: YouTubeTag[]
} & TagRowActions) {
  const menu = useContextMenu()
  const rowRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const index = siblings.findIndex((entry) => entry.id === tag.id)
  const items: MenuItem[] = [
    {
      id: 'pin',
      label: tag.pinned ? t('tags.unpin') : t('tags.pin'),
      icon: <Pin size={13} />,
      onSelect: () => onTogglePin(tag),
    },
    { id: 'rename', label: t('tags.rename'), icon: <Pencil size={13} />, onSelect: () => onStartRename(tag.id) },
    {
      id: 'child',
      label: t('tags.new_child'),
      icon: <CornerDownRight size={13} />,
      onSelect: () => onCreateChild(tag),
    },
    {
      id: 'color',
      label: t('tags.color'),
      icon: <Palette size={13} />,
      submenu: ({ closeMenu }) => (
        <TagColorMenu
          color={tag.color}
          onSelectColor={(color) => {
            onEditColor(tag, color ?? YOUTUBE_DEFAULT_TAG_COLOR)
            closeMenu()
          }}
          onManageTags={() => {
            closeMenu()
            onManage()
          }}
        />
      ),
    },
    {
      id: 'search-videos',
      label: t('youtube.tags.search_videos', { query: tag.name }),
      icon: <Search size={13} />,
      onSelect: () => onSearchVideos(tag.name),
    },
    {
      id: 'copy-name',
      label: t('youtube.tags.copy_name'),
      icon: <Copy size={13} />,
      onSelect: () => onCopyName(tag.name),
    },
    {
      id: 'move-up',
      label: t('youtube.sidebar.move_up'),
      icon: <ArrowUp size={13} />,
      disabled: index <= 0,
      onSelect: () => onMove(tag, -1),
    },
    {
      id: 'move-down',
      label: t('youtube.sidebar.move_down'),
      icon: <ArrowDown size={13} />,
      disabled: index < 0 || index >= siblings.length - 1,
      onSelect: () => onMove(tag, 1),
    },
    { id: 'manage', label: t('tags.manage'), icon: <Settings2 size={13} />, onSelect: onManage },
    {
      id: 'delete',
      label: t('tags.delete'),
      icon: <Trash2 size={13} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => onDelete(tag),
    },
  ]

  const activate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onSelect(tag)
  }

  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={active}
      data-tag-id={tag.id}
      data-tag-depth={depth}
      onContextMenu={(event) => {
        setMenuOpen(false)
        menu.onContextMenu(event)
      }}
      draggable
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        beginTagDrag(tag.id, tag.name, event.dataTransfer)
        onDragStart(tag.id)
      }}
      onDragEnd={() => {
        endTagDrag()
        onDragEnd()
        setDropActive(false)
      }}
      onDragOver={(event) => {
        const source = droppedTagId(event.dataTransfer) ?? draggingId
        if (!source || source === tag.id || !isTagDrag(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        setDropActive(true)
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(event) => {
        const source = droppedTagId(event.dataTransfer)
        setDropActive(false)
        if (!source || source === tag.id) return
        event.preventDefault()
        event.stopPropagation()
        onDrop(source, tag.id)
      }}
      className={cn(
        'group relative flex h-8 items-center gap-1 rounded-[var(--r-sm)] pr-1 text-[length:var(--text-12)] transition-colors duration-[var(--dur-fast)]',
        active ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
        draggingId === tag.id && 'opacity-45',
        (dropTargetId === tag.id || dropActive) && 'ring-1 ring-[var(--accent)] bg-[var(--accent-soft)]',
      )}
      style={{ paddingLeft: treeIndent(depth) }}
    >
      {hasChildren ? (
        <button
          type="button"
          aria-label={expanded ? t('tags.collapse_children') : t('tags.expand_children')}
          onClick={() => onToggle(tag.id)}
          className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
        >
          <ChevronRight size={12} className={cn('transition-transform duration-[var(--dur-fast)]', expanded && 'rotate-90')} />
        </button>
      ) : (
        <span className="size-5 shrink-0" />
      )}
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-[var(--r-full)]"
        style={{ backgroundColor: tag.color }}
      />
      {tag.pinned && <Pin size={9} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />}
      {renamingId === tag.id ? (
        <TagRenameField
          initial={tag.name}
          onCommit={(value) => onFinishRename(tag, value)}
          onCancel={onCancelRename}
        />
      ) : (
        <a
          href={youtubeViewPath({ kind: 'tag', tagId: tag.id })}
          aria-current={active ? 'page' : undefined}
          onClick={activate}
          onDoubleClick={() => onStartRename(tag.id)}
          className="min-w-0 flex-1 truncate py-1 text-left font-medium"
        >
          <TagNameHighlight name={tag.name} query={query} />
        </a>
      )}
      {renamingId !== tag.id && (
        <>
          <span className="shrink-0 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
            {count > 0 ? count : ''}
          </span>
          <Tooltip label={t('common.more_actions')} side="left">
            <IconButton
              label={t('common.more_actions')}
              size="xs"
              onClick={(event) => {
                event.stopPropagation()
                menu.close()
                setMenuOpen(true)
              }}
              className="shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
            >
              <MoreHorizontal size={12} />
            </IconButton>
          </Tooltip>
        </>
      )}
      {menuOpen && <Menu anchor={rowRef} open onClose={() => setMenuOpen(false)} items={items} align="end" />}
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items} />}
    </div>
  )
}

export function TagDraftRow({
  depth,
  onCommit,
  onCancel,
}: {
  depth: number
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  return (
    <div className="relative flex h-8 items-center gap-1" style={{ paddingLeft: treeIndent(depth) }}>
      <span className="size-5 shrink-0" />
      <Check size={11} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
      <TagRenameField initial="" onCommit={onCommit} onCancel={onCancel} />
    </div>
  )
}
