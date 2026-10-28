import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  ChevronRight,
  Copy,
  CornerDownRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  GripVertical,
  Pencil,
  Play,
  Radio,
  Trash2,
  Webhook,
} from 'lucide-react'
import type { CollectionNode, HttpMethod, RequestKind } from '@shared/development/api-tester/types'
import type { MenuItem, MenuSubmenuContext } from '../../../../components/overlay'
import { Menu, MenuSubmenuList, useContextMenu } from '../../../../components/overlay'
import { Badge, IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { treeIndent } from '../../../../lib/tree/indent'
import { isImeComposing } from '../../../../lib/ime'
import { childrenOf, subtreeIds } from '../lib/tree'

export interface CollectionFolderOption {
  id: string
  label: string
}

export interface CollectionDragState {
  sourceId: string | null
  overId: string | null
  position: 'before' | 'after'
}

const METHOD_CLASS: Record<HttpMethod, string> = {
  GET: 'text-[var(--success)]',
  POST: 'text-[var(--warning)]',
  PUT: 'text-[var(--accent)]',
  PATCH: 'text-[var(--accent)]',
  DELETE: 'text-[var(--danger)]',
  HEAD: 'text-[var(--text-tertiary)]',
  OPTIONS: 'text-[var(--text-tertiary)]',
}

function statusTone(status: number): 'success' | 'warning' | 'danger' {
  if (status < 300) return 'success'
  if (status < 400) return 'warning'
  return 'danger'
}

export function CollectionRow({
  node,
  depth,
  nodes,
  allNodes,
  folderOptions,
  activeId,
  expanded,
  compact,
  filtering,
  renameTarget,
  dragState,
  onSelect,
  onToggle,
  onRename,
  onRenameDone,
  onAdd,
  onDelete,
  onDuplicate,
  onMove,
  onReorder,
  onRunCollection,
}: {
  node: CollectionNode
  depth: number
  /** The filtered tree the row is drawn from. */
  nodes: readonly CollectionNode[]
  /** The complete tree, used for moves and reordering that must see hidden siblings. */
  allNodes: readonly CollectionNode[]
  folderOptions: readonly CollectionFolderOption[]
  activeId: string | null
  expanded: ReadonlySet<string>
  compact: boolean
  filtering: boolean
  renameTarget: string | null
  dragState: RefObject<CollectionDragState>
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  onRename: (id: string, name: string) => void
  onRenameDone: (id: string) => void
  onAdd: (kind: RequestKind | 'folder', parentId: string | null) => void
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
  onMove: (id: string, parentId: string | null) => void
  onReorder: (parentId: string | null, orderedIds: string[]) => void
  onRunCollection: (folder: CollectionNode) => void
}) {
  const isFolder = node.type === 'folder'
  const active = activeId === node.id
  const open = expanded.has(node.id)
  const kids = childrenOf(nodes, node.id)

  const moreRef = useRef<HTMLButtonElement>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const contextMenu = useContextMenu()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(node.name)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameDoneRef = useRef(false)
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | null>(null)

  useEffect(() => {
    if (renameTarget !== node.id) return
    renameDoneRef.current = false
    setName(node.name)
    setRenaming(true)
  }, [renameTarget, node.id, node.name])

  useEffect(() => {
    if (!renaming) return
    const input = renameInputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [renaming])

  const startRename = () => {
    renameDoneRef.current = false
    setName(node.name)
    setRenaming(true)
  }

  const finishRename = (commit: boolean) => {
    if (renameDoneRef.current) return
    renameDoneRef.current = true
    const next = name.trim()
    setRenaming(false)
    onRenameDone(node.id)
    if (commit && next && next !== node.name) onRename(node.id, next)
  }

  const excludedIds = useMemo(() => subtreeIds(allNodes, node.id), [allNodes, node.id])
  const moveTargets = useMemo(
    () => folderOptions.filter((option) => !excludedIds.has(option.id)),
    [folderOptions, excludedIds],
  )

  const moveSubmenu = ({ closeMenu }: MenuSubmenuContext) => {
    const items: MenuItem[] = [
      {
        id: 'move-root',
        label: t('development.apitester.root'),
        onSelect: () => {
          onMove(node.id, null)
          closeMenu()
        },
      },
      ...moveTargets.map((target) => ({
        id: `move-${target.id}`,
        label: target.label,
        onSelect: () => {
          onMove(node.id, target.id)
          closeMenu()
        },
      })),
    ]
    return <MenuSubmenuList label={t('development.apitester.move_to')} items={items} />
  }

  const menuItems: MenuItem[] = []
  if (isFolder) {
    menuItems.push(
      { id: 'add-rest', label: t('development.apitester.new_rest'), icon: <Globe size={14} />, onSelect: () => onAdd('rest', node.id) },
      { id: 'add-graphql', label: t('development.apitester.new_graphql'), icon: <Webhook size={14} />, onSelect: () => onAdd('graphql', node.id) },
      { id: 'add-websocket', label: t('development.apitester.new_websocket'), icon: <Radio size={14} />, onSelect: () => onAdd('websocket', node.id) },
      { id: 'add-folder', label: t('development.apitester.new_folder'), icon: <FolderPlus size={14} />, onSelect: () => onAdd('folder', node.id) },
      { id: 'run', label: t('development.apitester.run_collection'), icon: <Play size={14} />, separatorBefore: true, onSelect: () => onRunCollection(node) },
    )
  }
  menuItems.push({
    id: 'rename',
    label: t('development.apitester.rename'),
    icon: <Pencil size={14} />,
    separatorBefore: isFolder,
    onSelect: startRename,
  })
  if (!isFolder) {
    menuItems.push({
      id: 'duplicate',
      label: t('development.apitester.duplicate'),
      icon: <Copy size={14} />,
      onSelect: () => onDuplicate(node.id),
    })
  }
  menuItems.push({
    id: 'move',
    label: t('development.apitester.move_to'),
    icon: <CornerDownRight size={14} />,
    submenu: moveSubmenu,
  })
  menuItems.push({
    id: 'delete',
    label: t('development.apitester.delete'),
    icon: <Trash2 size={14} />,
    tone: 'danger',
    separatorBefore: true,
    onSelect: () => onDelete(node.id),
  })

  const resetDrag = () => {
    dragState.current.sourceId = null
    dragState.current.overId = null
    dragState.current.position = 'after'
    setDropPosition(null)
  }

  const onDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    dragState.current.sourceId = node.id
    dragState.current.overId = null
    dragState.current.position = 'after'
    if (!event.dataTransfer) return
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', node.id)
  }

  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    const drag = dragState.current
    if (!drag.sourceId || drag.sourceId === node.id) return
    const source = allNodes.find((entry) => entry.id === drag.sourceId)
    if (!source || source.parentId !== node.parentId) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    drag.overId = node.id
    drag.position = position
    setDropPosition(position)
  }

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const drag = dragState.current
    if (!drag.sourceId || !drag.overId) return
    event.preventDefault()
    const source = allNodes.find((entry) => entry.id === drag.sourceId)
    const parentId = source?.parentId ?? null
    const target = allNodes.find((entry) => entry.id === drag.overId)
    if (!source || !target || target.parentId !== parentId) {
      resetDrag()
      return
    }
    const ids = childrenOf(allNodes, parentId).map((entry) => entry.id)
    const from = ids.indexOf(source.id)
    const to = ids.indexOf(target.id)
    if (from === -1 || to === -1) {
      resetDrag()
      return
    }
    ids.splice(from, 1)
    const insertAt = ids.indexOf(target.id) + (drag.position === 'after' ? 1 : 0)
    ids.splice(insertAt, 0, source.id)
    onReorder(parentId, ids)
    resetDrag()
  }

  const onDragEnd = () => resetDrag()

  const openContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    setMoreOpen(false)
    contextMenu.onContextMenu(event)
  }

  const method = node.request?.method ?? 'GET'

  return (
    <div data-node-id={node.id}>
      <div
        draggable={!renaming && !filtering}
        data-drag-row={node.id}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropPosition(null)
        }}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
        onContextMenu={openContextMenu}
        data-drop-position={dropPosition ?? undefined}
        className={cn(
          'group flex items-center gap-1 rounded-[var(--r-sm)] pr-1 text-[length:var(--text-12)]',
          compact ? 'min-h-9' : 'min-h-7',
          active ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
          dropPosition === 'before' && 'shadow-[inset_0_2px_0_0_var(--accent)]',
          dropPosition === 'after' && 'shadow-[inset_0_-2px_0_0_var(--accent)]',
        )}
        style={{ paddingLeft: treeIndent(depth) + 2 }}
      >
        <span
          className={cn(
            'flex size-4 shrink-0 cursor-grab items-center justify-center text-[var(--text-quaternary)] active:cursor-grabbing',
            compact ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
          )}
          aria-hidden="true"
          title={t('development.apitester.drag_to_sort')}
        >
          <GripVertical size={12} />
        </span>

        {isFolder ? (
          <button
            type="button"
            aria-label={open ? t('development.apitester.collapse') : t('development.apitester.expand')}
            aria-expanded={open}
            aria-controls={open ? `apitester-children-${node.id}` : undefined}
            data-action="toggle-folder"
            onClick={() => onToggle(node.id)}
            className="flex size-4 shrink-0 items-center justify-center rounded-[var(--r-xs)] text-[var(--text-quaternary)] hover:text-[var(--text-primary)]"
          >
            <ChevronRight size={12} className={cn('transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="size-4 shrink-0" aria-hidden="true" />
        )}

        {isFolder ? (
          open ? (
            <FolderOpen size={13} className="shrink-0 text-[var(--warning)]" aria-hidden="true" />
          ) : (
            <Folder size={13} className="shrink-0 text-[var(--warning)]" aria-hidden="true" />
          )
        ) : node.kind === 'graphql' ? (
          <Webhook size={12} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />
        ) : node.kind === 'websocket' ? (
          <Radio size={12} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />
        ) : (
          <Globe size={12} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
        )}

        {renaming ? (
          <Input
            ref={renameInputRef}
            value={name}
            aria-label={t('development.apitester.rename')}
            data-action="rename-input"
            onChange={(event) => setName(event.target.value)}
            onBlur={() => finishRename(true)}
            onFocus={(event) => event.target.select()}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return
              if (event.key === 'Enter') {
                event.preventDefault()
                finishRename(true)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                finishRename(false)
              }
            }}
            className="h-6 min-w-0 flex-1 px-1 text-[length:var(--text-11)]"
          />
        ) : (
          <button
            type="button"
            data-action={isFolder ? 'toggle-folder-name' : 'select-request'}
            aria-current={active ? 'true' : undefined}
            onClick={() => (isFolder ? onToggle(node.id) : onSelect(node.id))}
            onDoubleClick={startRename}
            title={node.name}
            className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left"
          >
            {!isFolder && (node.kind ?? 'rest') === 'rest' && (
              <span className={cn('shrink-0 font-mono text-[length:var(--text-9)] font-semibold', METHOD_CLASS[method])}>{method}</span>
            )}
            <span className="truncate">{node.name}</span>
          </button>
        )}

        {!isFolder && typeof node.lastStatus === 'number' && node.lastStatus > 0 && (
          <Badge tone={statusTone(node.lastStatus)} className="shrink-0 px-1 font-mono text-[length:var(--text-9)]">
            {node.lastStatus}
          </Badge>
        )}

        <span
          className={cn(
            'shrink-0',
            compact ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
          )}
        >
          <IconButton
            ref={moreRef}
            size="xs"
            label={t('development.apitester.more_actions')}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((value) => !value)}
          >
            <ChevronRight size={12} className="rotate-90" />
          </IconButton>
        </span>

        <Menu
          anchor={moreRef}
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          items={menuItems}
          align="end"
          width={200}
          label={t('development.apitester.more_actions')}
        />
        <Menu
          anchor={contextMenu.point ?? { x: 0, y: 0 }}
          open={Boolean(contextMenu.point)}
          onClose={contextMenu.close}
          items={menuItems}
          width={200}
          label={t('development.apitester.more_actions')}
        />
      </div>

      {isFolder && open && (
        <div id={`apitester-children-${node.id}`}>
          {kids.length === 0 && !filtering && (
            <p
              className="py-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]"
              style={{ paddingLeft: treeIndent(depth) + 40 }}
            >
              {t('development.apitester.empty_folder')}
            </p>
          )}
          {kids.map((child) => (
            <CollectionRow
              key={child.id}
              node={child}
              depth={depth + 1}
              nodes={nodes}
              allNodes={allNodes}
              folderOptions={folderOptions}
              activeId={activeId}
              expanded={expanded}
              compact={compact}
              filtering={filtering}
              renameTarget={renameTarget}
              dragState={dragState}
              onSelect={onSelect}
              onToggle={onToggle}
              onRename={onRename}
              onRenameDone={onRenameDone}
              onAdd={onAdd}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onMove={onMove}
              onReorder={onReorder}
              onRunCollection={onRunCollection}
            />
          ))}
        </div>
      )}
    </div>
  )
}
