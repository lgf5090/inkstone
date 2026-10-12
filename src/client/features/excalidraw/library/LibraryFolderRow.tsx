import React, { useEffect, useMemo, useRef } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  CornerUpLeft,
  Download,
  Edit2,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  SortAsc,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { confirm, Menu, MenuSubmenuList, useContextMenu } from '../../../components/overlay'
import type { MenuItem } from '../../../components/overlay'
import { useDropState } from '../../../lib/drop-state'
import { leftDropTarget } from '../../../lib/note-drag'
import { splitByRanges } from '../../../lib/fuzzy'
import { queryMatches } from '../../../lib/query-match'
import type { Query } from '../../../lib/query-match'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { useMediaQuery } from '../../../lib/hooks'
import { FolderMoveMenu } from '../../folders/FolderMoveMenu'
import type { MoveMenuFolder } from '../../folders/FolderMoveMenu'
import { getAllFolderDescendants, useExcalidrawLibraryStore } from './library-store'
import {
  beginFolderDrag,
  currentFolderDrag,
  endFolderDrag,
  folderDropPlacement,
  isFolderDrag,
  orderedSiblings,
  pointerRatio,
  resolveFolderDrop,
} from './library-folder-drag'
import type { FolderDropPlacement } from './library-folder-drag'
import type { ExcalidrawLibraryFolder, LibraryFolderNode } from './types'

export interface LibraryFolderRowContext {
  folders: ExcalidrawLibraryFolder[]
  /** The whole folder tree, unfiltered: a move has to be able to reach a folder the query hides. */
  moveTree: MoveMenuFolder[]
  expandedIds: string[]
  activeFolderId: string | null
  query: Query | null
  dragId: string | null
  /** The element the drawing surface has taken over the screen, when it has: a menu portalled to the
   * body would not be painted inside a fullscreen element. */
  overlayContainer: HTMLElement | null
  editingId: string | null
  editingName: string
  addingToId: string | null
  addingName: string
  setDragId: (id: string | null) => void
  onSelect: (id: string | null) => void
  onToggle: (id: string) => void
  onRenameStart: (id: string, name: string) => void
  onRenameChange: (name: string) => void
  onRenameCommit: (id: string) => void
  onRenameCancel: () => void
  onAddChildStart: (id: string) => void
  onAddChildChange: (name: string) => void
  onAddChildCommit: (id: string) => void
  onAddCancel: () => void
  onExport: (id: string) => void
  onImportInto: (id: string) => void
  /** Called after a body-level dialog has been answered, so the host can bring its panel back. */
  onDialogClosed: () => void
}

function placementFrom(event: React.DragEvent<HTMLElement>): FolderDropPlacement {
  return folderDropPlacement(pointerRatio(event, event.currentTarget.getBoundingClientRect()))
}

/** The library's own tree, in the shape the move picker reads. */
export function toMoveTree(nodes: readonly LibraryFolderNode[]): MoveMenuFolder[] {
  return nodes.map((node) => ({
    id: node.id,
    name: node.name,
    directNotes: node.directCount,
    icon: node.icon ?? null,
    color: node.color ?? null,
    children: toMoveTree(node.children),
  }))
}

/**
 * A folder in the stencil library's tree: selectable, renameable, a drop target for another folder,
 * and the host of its own context menu.
 *
 * It is a component rather than a render function because the menu and the drop indicator need state
 * of their own per row - a render function called in a loop would give every row the first row's hooks.
 */
export function LibraryFolderRow({ node, ctx }: { node: LibraryFolderNode; ctx: LibraryFolderRowContext }) {
  const moveFolder = useExcalidrawLibraryStore((s) => s.moveFolder)
  const sortFolders = useExcalidrawLibraryStore((s) => s.sortFolders)
  const deleteFolder = useExcalidrawLibraryStore((s) => s.deleteFolder)
  const expandFolder = useExcalidrawLibraryStore((s) => s.expandFolder)

  const [placement, setPlacement] = useDropState<FolderDropPlacement | 'none'>('none')
  const menu = useContextMenu()
  const [menuOpen, setMenuOpen] = React.useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const renameRef = useRef<HTMLInputElement>(null)
  const childRef = useRef<HTMLInputElement>(null)
  const noHover = useMediaQuery('(hover: none)')
  const isEditing = ctx.editingId === node.id
  const isAddingChild = ctx.addingToId === node.id

  // The context menu hands focus back to whatever was focused before it opened, and that cleanup runs
  // after these fields mount - so an autoFocus here produced a field that looked editable and
  // swallowed every keystroke. Focusing after the commit, and selecting the name so the first
  // keystroke replaces it, is what makes the menu's rename and new-subfolder rows type somewhere.
  useEffect(() => {
    const field = isEditing ? renameRef.current : isAddingChild ? childRef.current : null
    if (!field) return
    field.focus({ preventScroll: true })
    field.select()
  }, [isEditing, isAddingChild])

  const expanded = node.children.length === 0 || ctx.expandedIds.includes(node.id) || ctx.query !== null
  const isActive = ctx.activeFolderId === node.id
  const isDragging = ctx.dragId === node.id
  const hasChildren = node.children.length > 0
  const match = ctx.query ? queryMatches(ctx.query, node.name) : null
  const parentId = node.parentId ?? null
  const siblings = useMemo(() => orderedSiblings(ctx.folders, parentId), [ctx.folders, parentId])
  const index = siblings.findIndex((folder) => folder.id === node.id)
  const parentNode = parentId === null ? null : ctx.folders.find((folder) => folder.id === parentId) ?? null
  const parentSiblings = useMemo(() => orderedSiblings(ctx.folders, parentNode?.parentId ?? null), [ctx.folders, parentNode])
  const descendants = useMemo(() => getAllFolderDescendants(ctx.folders, node.id), [ctx.folders, node.id])

  const move = (beforeId: string | null, targetParentId: string | null = parentId) => {
    moveFolder(node.id, targetParentId, beforeId)
    if (targetParentId) expandFolder(targetParentId)
  }

  const commitDrop = (subjectId: string, where: FolderDropPlacement) => {
    const next = resolveFolderDrop({ folders: ctx.folders, subjectId, targetId: node.id, placement: where })
    if (!next) return
    if (next.changed) moveFolder(subjectId, next.parentId, next.beforeId)
    if (where === 'inside') expandFolder(node.id)
  }

  const requestDelete = async () => {
    // The confirmation is a body-level portal, and a fullscreen element paints nothing of the body
    // that is not inside it: asked while the drawing surface owns the screen, the answer never shows.
    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      await document.exitFullscreen().catch(() => {})
    }
    const removed = node.itemCount
    const subfolders = descendants.size - 1
    const answer = await confirm({
      title: t('excalidraw.delete_library_folder_value0', { value0: node.name }),
      description: removed > 0 || subfolders > 0
        ? t('excalidraw.delete_library_folder_contents', { value0: removed, value1: subfolders })
        : t('sidebar.this_folder_is_empty'),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    ctx.onDialogClosed()
    if (!answer) return
    deleteFolder(node.id)
  }

  const moveSubject: MoveMenuFolder = {
    id: node.id,
    name: node.name,
    directNotes: node.directCount,
    icon: node.icon ?? null,
    color: node.color ?? null,
    children: [],
  }

  const menuItems: MenuItem[] = [
    { id: 'rename', label: t('sidebar.rename'), icon: <Pencil size={13} />, onSelect: () => ctx.onRenameStart(node.id, node.name) },
    { id: 'new-child', label: t('sidebar.new_subfolder'), icon: <FolderPlus size={13} />, onSelect: () => ctx.onAddChildStart(node.id) },
    {
      id: 'toggle',
      label: expanded && hasChildren ? t('excalidraw.collapse') : t('excalidraw.expand'),
      icon: expanded && hasChildren ? <ChevronDown size={13} /> : <ChevronRight size={13} />,
      disabled: !hasChildren,
      onSelect: () => ctx.onToggle(node.id),
    },
    {
      id: 'move-to',
      label: t('folders.move_to'),
      icon: <FolderInput size={13} />,
      separatorBefore: true,
      submenu: ({ closeMenu }) => (
        <FolderMoveMenu
          tree={ctx.moveTree}
          subject={moveSubject}
          currentParentId={parentId}
          excludedIds={descendants}
          rootLabel={t('excalidraw.all_folders')}
          onSelect={(nextParent) => {
            move(null, nextParent)
            closeMenu()
          }}
        />
      ),
    },
    {
      id: 'arrange',
      label: t('folders.group_arrange'),
      icon: <ArrowUpDown size={13} />,
      separatorBefore: true,
      submenu: () => (
        <MenuSubmenuList
          label={t('folders.group_arrange')}
          items={[
            {
              id: 'move-earlier',
              label: t('sidebar.move_earlier'),
              icon: <ArrowUp size={13} />,
              disabled: index <= 0,
              onSelect: () => move(siblings[index - 1]?.id ?? null),
            },
            {
              id: 'move-later',
              label: t('sidebar.move_later'),
              icon: <ArrowDown size={13} />,
              disabled: index < 0 || index >= siblings.length - 1,
              onSelect: () => move(siblings[index + 2]?.id ?? null),
            },
            {
              id: 'move-out',
              label: t('sidebar.move_out_one_level'),
              icon: <CornerUpLeft size={13} />,
              disabled: !parentNode,
              onSelect: () => {
                if (!parentNode) return
                const at = parentSiblings.findIndex((folder) => folder.id === parentNode.id)
                move(parentSiblings[at + 1]?.id ?? null, parentNode.parentId ?? null)
              },
            },
            {
              id: 'sort',
              label: t('folders.sort_by_name'),
              icon: <SortAsc size={13} />,
              separatorBefore: true,
              disabled: siblings.length < 2,
              onSelect: () => sortFolders(parentId),
            },
          ]}
        />
      ),
    },
    { id: 'export', label: t('excalidraw.export_folder'), icon: <Download size={13} />, separatorBefore: true, onSelect: () => ctx.onExport(node.id) },
    { id: 'import', label: t('excalidraw.import_into_folder'), icon: <Upload size={13} />, onSelect: () => ctx.onImportInto(node.id) },
    { id: 'delete', label: t('sidebar.delete_folder'), icon: <Trash2 size={13} />, tone: 'danger', separatorBefore: true, onSelect: () => void requestDelete() },
  ]

  return (
    <div className="flex flex-col select-none">
      <div
        ref={rowRef}
        data-library-folder={node.id}
        onContextMenu={(event) => {
          setMenuOpen(false)
          menu.onContextMenu(event)
        }}
        onDragOver={(event) => {
          if (!isFolderDrag(event.dataTransfer)) return
          // Swallowed even where the row refuses: a folder drag that fell through to the panel's own
          // background would be read there as "move this to the top level".
          event.stopPropagation()
          const subjectId = currentFolderDrag()
          const where = placementFrom(event)
          const next = subjectId ? resolveFolderDrop({ folders: ctx.folders, subjectId, targetId: node.id, placement: where }) : null
          if (!next) {
            event.dataTransfer.dropEffect = 'none'
            setPlacement('none')
            return
          }
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setPlacement(where)
        }}
        onDragLeave={(event) => {
          if (leftDropTarget(event)) setPlacement('none')
        }}
        onDrop={(event) => {
          const subjectId = currentFolderDrag()
          if (!subjectId) return
          event.preventDefault()
          event.stopPropagation()
          commitDrop(subjectId, placement === 'none' ? placementFrom(event) : placement)
          setPlacement('none')
          endFolderDrag()
          ctx.setDragId(null)
        }}
        draggable={!isEditing && !isAddingChild}
        onDragStart={(event) => {
          beginFolderDrag(node.id, event.dataTransfer)
          ctx.setDragId(node.id)
        }}
        onDragEnd={() => {
          endFolderDrag()
          ctx.setDragId(null)
          setPlacement('none')
        }}
        onClick={() => ctx.onSelect(isActive ? null : node.id)}
        className={`group relative flex h-8 items-center gap-1 rounded-md px-1 text-xs cursor-pointer transition-colors ${
          isActive
            ? 'bg-[var(--accent)]/15 text-[var(--accent)] font-medium'
            : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
        }${isDragging ? ' opacity-50' : ''}${placement === 'inside' ? ' ring-1 ring-[var(--accent)]' : ''}`}
        style={{ paddingLeft: `${6 + node.depth * 14}px` }}
      >
        {placement === 'before' && <span aria-hidden="true" className="pointer-events-none absolute top-0 right-1 left-1 h-px bg-[var(--accent)]" />}
        {placement === 'after' && <span aria-hidden="true" className="pointer-events-none absolute right-1 bottom-0 left-1 h-px bg-[var(--accent)]" />}

        <button
          type="button"
          aria-label={t('excalidraw.expand_or_collapse_folder')}
          onClick={(event) => {
            event.stopPropagation()
            ctx.onToggle(node.id)
          }}
          className={`p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5 text-[var(--text-tertiary)] ${
            !hasChildren ? 'invisible' : ''
          }`}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        {isActive ? (
          <FolderOpen size={15} className="shrink-0 text-[var(--accent)]" />
        ) : (
          <Folder size={15} className="shrink-0 text-[var(--text-tertiary)]" />
        )}

        {isEditing ? (
          <div className="flex items-center gap-1 flex-1 min-w-0" onClick={(event) => event.stopPropagation()}>
            <input
              ref={renameRef}
              type="text"
              value={ctx.editingName}
              aria-label={t('sidebar.rename')}
              onChange={(event) => ctx.onRenameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') ctx.onRenameCommit(node.id)
                else if (event.key === 'Escape') ctx.onRenameCancel()
              }}
              className="h-6 w-full rounded border border-[var(--accent)] bg-[var(--bg-surface)] px-1.5 text-xs text-[var(--text-primary)] focus:outline-none"
            />
            <button
              type="button"
              aria-label={t('excalidraw.rename_folder')}
              onClick={() => ctx.onRenameCommit(node.id)}
              className="p-1 text-[var(--accent)] hover:opacity-80"
            >
              <Check size={12} />
            </button>
          </div>
        ) : (
          <span className="flex-1 min-w-0 truncate ml-0.5">
            {match
              ? splitByRanges(node.name, match.ranges).map(
                  (part: { text: string; hit: boolean }, i: number) =>
                    part.hit ? (
                      <span key={i} className="font-semibold text-[var(--accent)]">
                        {part.text}
                      </span>
                    ) : (
                      <span key={i}>{part.text}</span>
                    ),
                )
              : node.name}
          </span>
        )}

        <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--text-quaternary)] mr-1 transition-opacity group-hover:opacity-0">
          {node.itemCount}
        </span>

        <div
          className={cn(
            'flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
            // Nothing ever hovers on a touch screen, and an invisible button is still a button you can
            // hit: where there is no hover, the quick actions are simply painted.
            noHover && 'opacity-100',
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            title={t('sidebar.new_subfolder')}
            aria-label={t('sidebar.new_subfolder')}
            onClick={() => ctx.onAddChildStart(node.id)}
            className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-black/5 dark:hover:bg-white/5 rounded"
          >
            <Plus size={12} />
          </button>
          <button
            type="button"
            title={t('sidebar.rename')}
            aria-label={t('sidebar.rename')}
            onClick={() => ctx.onRenameStart(node.id, node.name)}
            className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-black/5 dark:hover:bg-white/5 rounded"
          >
            <Edit2 size={12} />
          </button>
          <button
            type="button"
            title={t('common.more_actions')}
            aria-label={t('common.more_actions')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => {
              event.stopPropagation()
              menu.close()
              setMenuOpen(true)
            }}
            className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-black/5 dark:hover:bg-white/5 rounded"
          >
            <MoreHorizontal size={12} />
          </button>
          <button
            type="button"
            title={t('common.delete')}
            aria-label={t('common.delete')}
            onClick={() => void requestDelete()}
            className="p-1 text-[var(--text-tertiary)] hover:text-[var(--danger)] hover:bg-black/5 dark:hover:bg-white/5 rounded"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {isAddingChild && (
        <div
          className="flex items-center gap-1 py-1 pr-2 my-0.5 rounded-md bg-[var(--bg-sunken)]"
          style={{ paddingLeft: `${24 + node.depth * 14}px` }}
        >
          <input
            ref={childRef}
            type="text"
            placeholder={t('sidebar.new_subfolder')}
            aria-label={t('sidebar.new_subfolder')}
            value={ctx.addingName}
            onChange={(event) => ctx.onAddChildChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') ctx.onAddChildCommit(node.id)
              else if (event.key === 'Escape') ctx.onAddCancel()
            }}
            className="h-6 flex-1 rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
          />
          <button
            type="button"
            aria-label={t('sidebar.new_subfolder')}
            onClick={() => ctx.onAddChildCommit(node.id)}
            className="p-1 text-[var(--accent)]"
          >
            <Check size={13} />
          </button>
          <button
            type="button"
            aria-label={t('common.cancel')}
            onClick={ctx.onAddCancel}
            className="p-1 text-[var(--text-tertiary)]"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {expanded && node.children.map((child) => <LibraryFolderRow key={child.id} node={child} ctx={ctx} />)}

      <Menu anchor={rowRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems} container={ctx.overlayContainer} label={t('excalidraw.folder_actions_value0', { value0: node.name })} />
      {menu.point && (
        <Menu anchor={menu.point} open onClose={menu.close} items={menuItems} container={ctx.overlayContainer} label={t('excalidraw.folder_actions_value0', { value0: node.name })} />
      )}
    </div>
  )
}
