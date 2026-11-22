import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Files,
  FolderClosed,
  FolderPlus,
  Hash,
  MoreHorizontal,
  Pin,
  Plus,
  Star,
  Trash2,
  Upload,
} from 'lucide-react'
import { OFFICE_LIMITS, type OfficeFileType } from '@shared/office/constants'
import type { OfficeFolder, OfficeTag } from '@shared/office/model'
import { buildTagTree, flattenTagTree, type TagTreeNode } from '../../lib/tag-tree'
import { numericCollator } from '../../lib/collator'
import { cn } from '../../lib/cn'
import { useLocale, t } from '../../lib/i18n'
import { useDropState } from '../../lib/drop-state'
import { leftDropTarget } from '../../lib/note-drag'
import { treeIndent, treeItemProps, useExpandedSet, useTreeKeyboard, type MoveMenuFolder } from '../../lib/tree'
import { IconButton, SectionLabel } from '../../components/primitives'
import { Menu, Tooltip, useContextMenu, type MenuItem } from '../../components/overlay'
import type { OfficeFolderPatch, OfficeTagPatch } from './api'
import type { OfficeSmartView } from './office-address'
import { OFFICE_SMART_VIEWS } from './office-address'
import { beginOfficeDrag, endOfficeDrag, hasOfficeDrag, readOfficeDrag, type OfficeDragPayload } from './office-drag'
import { folderMenuItems, officeNewFileMenuItems, officeSmartViewLabel, tagMenuItems } from './office-menus'

export interface OfficeFolderNode {
  folder: OfficeFolder
  depth: number
  children: OfficeFolderNode[]
}

/** The folder forest, sorted by the stored position and then by name in the reader's locale. */
export function buildOfficeFolderTree(folders: readonly OfficeFolder[], collator: Intl.Collator): OfficeFolderNode[] {
  const ids = new Set(folders.map((folder) => folder.id))
  const byParent = new Map<string | null, OfficeFolder[]>()
  for (const folder of folders) {
    const parent = folder.parentId && ids.has(folder.parentId) ? folder.parentId : null
    const list = byParent.get(parent) ?? []
    list.push(folder)
    byParent.set(parent, list)
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.position - b.position || collator.compare(a.name, b.name) || a.id.localeCompare(b.id))
  }
  const build = (parentId: string | null, depth: number, seen: ReadonlySet<string>): OfficeFolderNode[] => {
    if (depth > 64) return []
    const nodes: OfficeFolderNode[] = []
    for (const folder of byParent.get(parentId) ?? []) {
      if (seen.has(folder.id)) continue
      const next = new Set(seen)
      next.add(folder.id)
      nodes.push({ folder, depth, children: build(folder.id, depth + 1, next) })
    }
    return nodes
  }
  return build(null, 0, new Set())
}

export function flattenOfficeFolderTree(nodes: readonly OfficeFolderNode[], expanded: ReadonlySet<string>): OfficeFolderNode[] {
  const rows: OfficeFolderNode[] = []
  const walk = (list: readonly OfficeFolderNode[]): void => {
    for (const node of list) {
      rows.push(node)
      if (node.children.length && expanded.has(node.folder.id)) walk(node.children)
    }
  }
  walk(nodes)
  return rows
}

/** Ancestors first, the folder itself last; a cycle stops at the first repeated id. */
export function officeFolderPath(folders: readonly OfficeFolder[], id: string): OfficeFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const path: OfficeFolder[] = []
  const seen = new Set<string>()
  let current = byId.get(id) ?? null
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.unshift(current)
    current = current.parentId ? byId.get(current.parentId) ?? null : null
  }
  return path
}

export function officeFolderDescendantIds(folders: readonly OfficeFolder[], id: string): Set<string> {
  const children = new Map<string | null, string[]>()
  for (const folder of folders) {
    const list = children.get(folder.parentId) ?? []
    list.push(folder.id)
    children.set(folder.parentId, list)
  }
  const out = new Set<string>()
  const queue = [...(children.get(id) ?? [])]
  while (queue.length) {
    const next = queue.shift()!
    if (out.has(next)) continue
    out.add(next)
    queue.push(...(children.get(next) ?? []))
  }
  return out
}

export function toOfficeMoveTree(nodes: readonly OfficeFolderNode[]): MoveMenuFolder[] {
  return nodes.map((node) => ({
    id: node.folder.id,
    name: node.folder.name,
    children: toOfficeMoveTree(node.children),
    directNotes: 0,
    icon: node.folder.icon,
    color: node.folder.color,
  }))
}

function toTagNodes(tags: readonly OfficeTag[]): TagTreeNode[] {
  return buildTagTree(tags.map((tag) => ({
    id: tag.id,
    name: tag.name,
    color: tag.color,
    count: tag.count,
    isPinned: tag.isPinned,
    createdAt: tag.createdAt,
  })))
}

const SMART_VIEW_ICONS: Record<OfficeSmartView, React.ReactNode> = {
  all: <Files size={14} aria-hidden="true" />,
  recent: <Clock size={14} aria-hidden="true" />,
  starred: <Star size={14} aria-hidden="true" />,
  pinned: <Pin size={14} aria-hidden="true" />,
  trash: <Trash2 size={14} aria-hidden="true" />,
}

export interface OfficeSidebarProps {
  view: OfficeSmartView
  folderId: string | null
  tagId: string | null
  folders: readonly OfficeFolder[]
  tags: readonly OfficeTag[]
  clipboardHasFiles: boolean
  onSelectView: (view: OfficeSmartView) => void
  onSelectFolder: (id: string | null) => void
  onSelectTag: (id: string | null) => void
  onCreateFile: (folderId: string | null, type: OfficeFileType) => void
  onImportJson: () => void
  onCreateFolder: (parentId: string | null) => void
  onRenameFolder: (folder: OfficeFolder) => void
  onPatchFolder: (id: string, patch: OfficeFolderPatch) => void
  onMoveFolder: (id: string, parentId: string | null) => void
  onSortFolderSiblings: (parentId: string | null, key: 'name' | 'updated') => void
  onDeleteFolder: (folder: OfficeFolder, strategy: 'move-up' | 'delete') => void
  onMoveFiles: (ids: readonly string[], folderId: string | null) => void
  onPaste: (folderId: string | null) => void
  onCreateTag: (parentPath: string | null) => void
  onRenameTag: (tag: OfficeTag) => void
  onPatchTag: (id: string, patch: OfficeTagPatch) => void
  onMoveTag: (tag: OfficeTag, parentPath: string) => void
  onDeleteTag: (tag: OfficeTag) => void
}

export function OfficeSidebar(props: OfficeSidebarProps) {
  const {
    view, folderId, tagId, folders, tags,
    onSelectView, onSelectFolder, onSelectTag, onCreateFile, onImportJson,
  } = props
  const locale = useLocale()
  const collator = useMemo(() => numericCollator(locale), [locale])
  const tree = useMemo(() => buildOfficeFolderTree(folders, collator), [folders, collator])
  const moveTree = useMemo(() => toOfficeMoveTree(tree), [tree])
  const folderExpanded = useExpandedSet()
  const tagExpanded = useExpandedSet()
  const [newFileOpen, setNewFileOpen] = useState(false)
  const newFileRef = useRef<HTMLButtonElement>(null)
  const [rootDropping, setRootDropping] = useDropState(false)

  const parentFolderIds = useMemo(
    () => folders.filter((folder) => folders.some((child) => child.parentId === folder.id)).map((folder) => folder.id),
    [folders],
  )
  const allFoldersExpanded = parentFolderIds.length > 0 && parentFolderIds.every((id) => folderExpanded.expanded.has(id))
  const folderRows = useMemo(
    () => flattenOfficeFolderTree(tree, folderExpanded.expanded),
    [tree, folderExpanded.expanded],
  )

  const tagTree = useMemo(() => toTagNodes(tags), [tags])
  const tagParentPaths = useMemo(() => {
    const paths: string[] = []
    const walk = (nodes: readonly TagTreeNode[]): void => {
      for (const node of nodes) {
        if (!node.children.length) continue
        paths.push(node.fullPath)
        walk(node.children)
      }
    }
    walk(tagTree)
    return paths
  }, [tagTree])
  const allTagsExpanded = tagParentPaths.length > 0 && tagParentPaths.every((path) => tagExpanded.expanded.has(path))
  const tagRows = useMemo(() => flattenTagTree(tagTree, tagExpanded.expanded), [tagTree, tagExpanded.expanded])

  // Keep the branch holding the current folder or tag open when a deep link or a drop selects it.
  useEffect(() => {
    if (!folderId) return
    folderExpanded.setMany(officeFolderPath(folders, folderId).map((folder) => folder.id), true)
    // The setter is stable; folding the path into the dependency list would re-run on every toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId, folders])

  useEffect(() => {
    if (!tagId) return
    const tag = tags.find((entry) => entry.id === tagId)
    if (!tag) return
    const segments = tag.name.split('/').filter(Boolean)
    const paths = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'))
    tagExpanded.setMany(paths, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagId, tags])

  const createTargetFolder = view === 'all' ? folderId : null
  const rootDropActive = (payload: OfficeDragPayload | null): boolean => {
    if (!payload) return false
    if (payload.kind === 'files') return payload.ids.length > 0
    return payload.kind === 'folder'
  }

  const dropAtRoot = (payload: OfficeDragPayload | null): void => {
    if (!payload) return
    if (payload.kind === 'files') {
      props.onMoveFiles(payload.ids, null)
      return
    }
    if (payload.kind === 'folder') props.onMoveFolder(payload.id, null)
  }

  return (
    <aside aria-label={t('office.pane.sidebar')} className="flex h-full min-h-0 w-[232px] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2">
        <h2 className="min-w-0 flex-1 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('office.title')}
        </h2>
        <Tooltip label={t('office.action.new_file')} side="bottom">
          <IconButton ref={newFileRef} label={t('office.action.new_file')} size="sm" onClick={() => setNewFileOpen(true)}>
            <Plus size={14} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('office.action.import')} side="bottom">
          <IconButton label={t('office.action.import')} size="sm" onClick={onImportJson}>
            <Upload size={14} />
          </IconButton>
        </Tooltip>
      </header>
      <Menu
        anchor={newFileRef}
        open={newFileOpen}
        onClose={() => setNewFileOpen(false)}
        items={officeNewFileMenuItems((type) => onCreateFile(createTargetFolder, type))}
        width={216}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4">
        <nav aria-label={t('office.view.label')} className="space-y-px">
          {OFFICE_SMART_VIEWS.map((entry) => (
            <button
              key={entry}
              type="button"
              aria-current={view === entry ? 'page' : undefined}
              onClick={() => onSelectView(entry)}
              className={cn(
                'flex h-9 w-full items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)] font-medium transition-colors duration-[var(--dur-fast)] md:h-[30px]',
                view === entry && !folderId && !tagId
                  ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              <span className={cn('shrink-0', view === entry && !folderId && !tagId ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}>
                {SMART_VIEW_ICONS[entry]}
              </span>
              <span className="min-w-0 flex-1 truncate">{officeSmartViewLabel(entry)}</span>
            </button>
          ))}
        </nav>

        <section className="mt-3">
          <div className="group/head flex items-center gap-0.5">
            <SectionLabel className="min-w-0 flex-1">{t('office.sidebar.folders')}</SectionLabel>
            {parentFolderIds.length > 0 && (
              <Tooltip label={allFoldersExpanded ? t('office.sidebar.collapse_all') : t('office.sidebar.expand_all')} side="left">
                <IconButton
                  label={allFoldersExpanded ? t('office.sidebar.collapse_all') : t('office.sidebar.expand_all')}
                  size="sm"
                  onClick={() => folderExpanded.setMany(parentFolderIds, !allFoldersExpanded)}
                >
                  <ChevronsUpDown size={13} className={cn('transition-transform duration-[var(--dur-fast)]', allFoldersExpanded && 'rotate-180')} />
                </IconButton>
              </Tooltip>
            )}
            <Tooltip label={t('office.folder.new')} side="left">
              <IconButton label={t('office.folder.new')} size="sm" onClick={() => props.onCreateFolder(null)}>
                <FolderPlus size={13} />
              </IconButton>
            </Tooltip>
          </div>

          <div
            role="tree"
            aria-label={t('office.sidebar.folders')}
            className={cn('mt-0.5 space-y-px rounded-[var(--r-md)]', rootDropping && 'ring-1 ring-[var(--accent)]')}
            onDragOver={(event) => {
              if (!hasOfficeDrag(event.dataTransfer)) return
              const target = event.target
              if (target instanceof Element && target.closest('[data-office-folder-row]')) {
                setRootDropping(false)
                return
              }
              if (!rootDropActive(readOfficeDrag(event))) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setRootDropping(true)
            }}
            onDragLeave={(event) => {
              if (leftDropTarget(event)) setRootDropping(false)
            }}
            onDrop={(event) => {
              if (!hasOfficeDrag(event.dataTransfer)) return
              event.preventDefault()
              setRootDropping(false)
              dropAtRoot(readOfficeDrag(event))
            }}
          >
            {folderRows.map((node) => (
              <FolderRow
                key={node.folder.id}
                node={node}
                moveTree={moveTree}
                folders={folders}
                expanded={folderExpanded.expanded.has(node.folder.id)}
                active={folderId === node.folder.id}
                clipboardHasFiles={props.clipboardHasFiles}
                onToggle={() => folderExpanded.toggle(node.folder.id)}
                onSelect={() => onSelectFolder(node.folder.id)}
                onCreateFile={props.onCreateFile}
                onCreateFolder={props.onCreateFolder}
                onRename={props.onRenameFolder}
                onPatch={props.onPatchFolder}
                onMove={props.onMoveFolder}
                onSort={props.onSortFolderSiblings}
                onDelete={props.onDeleteFolder}
                onMoveFiles={props.onMoveFiles}
                onPaste={props.onPaste}
              />
            ))}
            {folders.length === 0 && (
              <p className="px-2 py-2 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('office.sidebar.empty_folders')}</p>
            )}
          </div>
        </section>

        <section className="mt-4">
          <div className="group/head flex items-center gap-0.5">
            <SectionLabel className="min-w-0 flex-1">{t('office.sidebar.tags')}</SectionLabel>
            {tagParentPaths.length > 0 && (
              <Tooltip label={allTagsExpanded ? t('office.sidebar.collapse_all') : t('office.sidebar.expand_all')} side="left">
                <IconButton
                  label={allTagsExpanded ? t('office.sidebar.collapse_all') : t('office.sidebar.expand_all')}
                  size="sm"
                  onClick={() => tagExpanded.setMany(tagParentPaths, !allTagsExpanded)}
                >
                  <ChevronsUpDown size={13} className={cn('transition-transform duration-[var(--dur-fast)]', allTagsExpanded && 'rotate-180')} />
                </IconButton>
              </Tooltip>
            )}
            <Tooltip label={t('office.tag.new')} side="left">
              <IconButton label={t('office.tag.new')} size="sm" onClick={() => props.onCreateTag(null)}>
                <Plus size={13} />
              </IconButton>
            </Tooltip>
          </div>
          <div role="tree" aria-label={t('office.sidebar.tags')} className="mt-0.5 space-y-px">
            {tagRows.map((node) => (
              <TagRow
                key={node.fullPath}
                node={node}
                tags={tags}
                expanded={tagExpanded.expanded.has(node.fullPath)}
                active={!node.isVirtual && tagId === node.tag.id}
                required={!node.isVirtual && tagId === node.tag.id}
                onToggle={() => tagExpanded.toggle(node.fullPath)}
                onSelect={() => {
                  if (node.isVirtual) {
                    tagExpanded.toggle(node.fullPath)
                    return
                  }
                  onSelectTag(tagId === node.tag.id ? null : node.tag.id)
                }}
                onCreateTag={props.onCreateTag}
                onRenameTag={props.onRenameTag}
                onPatchTag={props.onPatchTag}
                onMoveTag={props.onMoveTag}
                onDeleteTag={props.onDeleteTag}
              />
            ))}
            {tags.length === 0 && (
              <p className="px-2 py-2 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('office.sidebar.empty_tags')}</p>
            )}
          </div>
        </section>
      </div>
    </aside>
  )
}

function FolderRow({
  node, moveTree, folders, expanded, active, clipboardHasFiles,
  onToggle, onSelect, onCreateFile, onCreateFolder, onRename, onPatch, onMove, onSort, onDelete, onMoveFiles, onPaste,
}: {
  node: OfficeFolderNode
  moveTree: readonly MoveMenuFolder[]
  folders: readonly OfficeFolder[]
  expanded: boolean
  active: boolean
  clipboardHasFiles: boolean
  onToggle: () => void
  onSelect: () => void
  onCreateFile: (folderId: string | null, type: OfficeFileType) => void
  onCreateFolder: (parentId: string | null) => void
  onRename: (folder: OfficeFolder) => void
  onPatch: (id: string, patch: OfficeFolderPatch) => void
  onMove: (id: string, parentId: string | null) => void
  onSort: (parentId: string | null, key: 'name' | 'updated') => void
  onDelete: (folder: OfficeFolder, strategy: 'move-up' | 'delete') => void
  onMoveFiles: (ids: readonly string[], folderId: string | null) => void
  onPaste: (folderId: string | null) => void
}) {
  const { folder } = node
  const menu = useContextMenu()
  const rowRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [dropping, setDropping] = useDropState(false)
  const hasChildren = node.children.length > 0
  const canCreateChild = node.depth + 1 < OFFICE_LIMITS.folderDepthMax
  const excludedIds = useMemo(() => {
    const ids = officeFolderDescendantIds(folders, folder.id)
    ids.add(folder.id)
    return ids
  }, [folders, folder.id])

  const items: MenuItem[] = folderMenuItems({
    folder,
    moveTree,
    excludedIds,
    clipboardEmpty: !clipboardHasFiles,
    canCreateChild,
    onOpen: () => onSelect(),
    onCreateFile: (folderId, type) => onCreateFile(folderId, type),
    onCreateChild: (folderId) => onCreateFolder(folderId),
    onRename,
    onColor: (target, color) => onPatch(target.id, { color }),
    onIcon: (target, icon) => onPatch(target.id, { icon }),
    onMove: (target, parentId) => onMove(target.id, parentId),
    onSort: (target, key) => onSort(target.parentId, key),
    onPaste: (folderId) => onPaste(folderId),
    onDelete,
  })

  const openAtRow = () => {
    const rect = rowRef.current?.getBoundingClientRect()
    if (rect) menu.openAt({ x: rect.left + 24, y: rect.top + rect.height })
  }

  const openFromContextMenu = (event: React.MouseEvent) => {
    setMenuOpen(false)
    if (event.clientX !== 0 || event.clientY !== 0) {
      menu.onContextMenu(event)
      return
    }
    // A keyboard ContextMenu/F10 press carries no pointer position; anchor to the row instead.
    event.preventDefault()
    event.stopPropagation()
    openAtRow()
  }

  const acceptsDrop = (payload: OfficeDragPayload | null): boolean => {
    if (!payload) return false
    if (payload.kind === 'files') return payload.ids.length > 0
    if (payload.kind === 'folder') return payload.id !== folder.id && !excludedIds.has(payload.id)
    return false
  }

  const handleDrop = (payload: OfficeDragPayload | null): void => {
    if (!payload) return
    if (payload.kind === 'files') {
      onMoveFiles(payload.ids, folder.id)
      return
    }
    if (payload.kind === 'folder' && acceptsDrop(payload)) onMove(payload.id, folder.id)
  }

  const onKeyDown = useTreeKeyboard({
    onKey: (event) => {
      if (event.key === 'F2') {
        onRename(folder)
        return true
      }
      if (event.key === 'Delete') {
        openAtRow()
        return true
      }
      return false
    },
  })

  return (
    <div
      ref={rowRef}
      data-office-folder-row=""
      {...treeItemProps({ level: node.depth + 1, expanded: hasChildren ? expanded : undefined, selected: active })}
      onContextMenu={openFromContextMenu}
      onDragOver={(event) => {
        if (!hasOfficeDrag(event.dataTransfer)) return
        if (!acceptsDrop(readOfficeDrag(event))) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        setDropping(true)
      }}
      onDragLeave={(event) => {
        if (leftDropTarget(event)) setDropping(false)
      }}
      onDrop={(event) => {
        if (!hasOfficeDrag(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        setDropping(false)
        handleDrop(readOfficeDrag(event))
      }}
      onDragEnd={() => setDropping(false)}
      className={cn(
        'group flex h-10 items-center gap-1 rounded-[var(--r-md)] pr-1 transition-colors duration-[var(--dur-fast)] md:h-[30px]',
        active ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
        dropping && 'ring-1 ring-[var(--accent)]',
      )}
      style={{ paddingLeft: treeIndent(node.depth) }}
    >
      <button
        type="button"
        disabled={!hasChildren}
        tabIndex={hasChildren ? undefined : -1}
        data-tree-toggle
        aria-expanded={hasChildren ? expanded : undefined}
        aria-label={expanded ? t('office.sidebar.collapse') : t('office.sidebar.expand')}
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        className={cn('flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] md:size-5', !hasChildren && 'invisible')}
      >
        <ChevronRight size={12} className={cn('transition-transform duration-[var(--dur-fast)]', expanded && 'rotate-90')} />
      </button>
      <span
        className={cn('flex size-4 shrink-0 items-center justify-center text-[length:var(--text-13)] leading-none', !folder.color && 'text-[var(--text-tertiary)]')}
        style={folder.color ? { color: folder.color } : undefined}
        aria-hidden="true"
      >
        {folder.icon || <FolderClosed size={13} />}
      </span>
      <button
        type="button"
        data-tree-row
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
        onDoubleClick={() => onRename(folder)}
        onKeyDown={onKeyDown}
        draggable
        onDragStart={(event) => {
          event.stopPropagation()
          beginOfficeDrag(event, { kind: 'folder', id: folder.id })
        }}
        onDragEnd={endOfficeDrag}
        className="min-w-0 flex-1 truncate py-1 text-left text-[length:var(--text-12-5)] font-medium"
      >
        {folder.name}
      </button>
      <Tooltip label={t('common.more_actions')} side="left">
        <IconButton
          label={t('common.more_actions')}
          size="sm"
          className="shrink-0 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            menu.close()
            setMenuOpen(true)
          }}
        >
          <MoreHorizontal size={13} />
        </IconButton>
      </Tooltip>
      <Menu anchor={rowRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} width={224} />
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items} width={224} />}
    </div>
  )
}

function TagRow({
  node, tags, expanded, active, required, onToggle, onSelect, onCreateTag, onRenameTag, onPatchTag, onMoveTag, onDeleteTag,
}: {
  node: TagTreeNode
  tags: readonly OfficeTag[]
  expanded: boolean
  active: boolean
  required: boolean
  onToggle: () => void
  onSelect: () => void
  onCreateTag: (parentPath: string | null) => void
  onRenameTag: (tag: OfficeTag) => void
  onPatchTag: (id: string, patch: OfficeTagPatch) => void
  onMoveTag: (tag: OfficeTag, parentPath: string) => void
  onDeleteTag: (tag: OfficeTag) => void
}) {
  const menu = useContextMenu()
  const rowRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [dropping, setDropping] = useDropState(false)
  const hasChildren = node.children.length > 0
  const real: OfficeTag | null = node.isVirtual ? null : tags.find((tag) => tag.id === node.tag.id) ?? null

  const items: MenuItem[] = real
    ? [
        ...tagMenuItems({
          tag: real,
          path: node.fullPath,
          required,
          onRequire: () => onSelect(),
          onRename: onRenameTag,
          onCreateChild: onCreateTag,
          onColor: (tag, color) => onPatchTag(tag.id, { color }),
          onTogglePin: (tag) => onPatchTag(tag.id, { isPinned: !tag.isPinned }),
          onDelete: onDeleteTag,
        }),
        ...(hasChildren
          ? [{
              id: 'expand-level',
              label: expanded ? t('office.sidebar.collapse') : t('office.sidebar.expand'),
              icon: <ChevronRight size={13} />,
              separatorBefore: true,
              onSelect: onToggle,
            } satisfies MenuItem]
          : []),
      ]
    : [
        {
          id: 'new-child',
          label: t('office.tag.new_child'),
          icon: <Plus size={13} />,
          onSelect: () => onCreateTag(node.fullPath),
        },
        ...(hasChildren
          ? [{
              id: 'expand',
              label: expanded ? t('office.sidebar.collapse') : t('office.sidebar.expand'),
              icon: <ChevronRight size={13} />,
              onSelect: onToggle,
            } satisfies MenuItem]
          : []),
      ]

  const openAtRow = () => {
    const rect = rowRef.current?.getBoundingClientRect()
    if (rect) menu.openAt({ x: rect.left + 24, y: rect.top + rect.height })
  }

  const openFromContextMenu = (event: React.MouseEvent) => {
    setMenuOpen(false)
    if (event.clientX !== 0 || event.clientY !== 0) {
      menu.onContextMenu(event)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    openAtRow()
  }

  const acceptsDrop = (payload: OfficeDragPayload | null): boolean => {
    if (!payload || payload.kind !== 'tag') return false
    if (payload.name === node.fullPath) return false
    return !node.fullPath.startsWith(`${payload.name}/`)
  }

  const onKeyDown = useTreeKeyboard({
    onKey: (event) => {
      if (event.key === 'F2' && real) {
        onRenameTag(real)
        return true
      }
      if (event.key === 'Delete' && real) {
        openAtRow()
        return true
      }
      return false
    },
  })

  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-level={node.depth + 1}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={active}
      data-office-tag-row=""
      onContextMenu={openFromContextMenu}
      onDragOver={(event) => {
        if (!hasOfficeDrag(event.dataTransfer)) return
        if (!acceptsDrop(readOfficeDrag(event))) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        setDropping(true)
      }}
      onDragLeave={(event) => {
        if (leftDropTarget(event)) setDropping(false)
      }}
      onDrop={(event) => {
        if (!hasOfficeDrag(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        setDropping(false)
        const payload = readOfficeDrag(event)
        if (payload?.kind !== 'tag' || !acceptsDrop(payload)) return
        const tag = tags.find((entry) => entry.name === payload.name)
        if (tag) onMoveTag(tag, node.fullPath)
      }}
      onDragEnd={() => setDropping(false)}
      className={cn(
        'group flex h-10 items-center gap-1 rounded-[var(--r-md)] pr-1 text-[length:var(--text-12-5)] transition-colors duration-[var(--dur-fast)] md:h-[30px]',
        active ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
        dropping && 'ring-1 ring-[var(--accent)] bg-[var(--accent-soft)]',
      )}
      style={{ paddingLeft: treeIndent(node.depth) }}
    >
      <button
        type="button"
        disabled={!hasChildren}
        tabIndex={hasChildren ? undefined : -1}
        data-tree-toggle
        aria-expanded={hasChildren ? expanded : undefined}
        aria-label={expanded ? t('office.sidebar.collapse') : t('office.sidebar.expand')}
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        className={cn('flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] md:size-5', !hasChildren && 'invisible')}
      >
        <ChevronRight size={12} className={cn('transition-transform duration-[var(--dur-fast)]', expanded && 'rotate-90')} />
      </button>
      <Hash size={13} className="shrink-0" style={{ color: node.tag.color ?? (active ? 'var(--accent)' : 'var(--text-quaternary)') }} aria-hidden="true" />
      {(node.isPinned || node.tag.isPinned) && <Pin size={10} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden="true" />}
      <button
        type="button"
        data-tree-row
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
        onDoubleClick={real ? () => onRenameTag(real) : undefined}
        onKeyDown={onKeyDown}
        draggable={Boolean(real)}
        onDragStart={(event) => {
          if (!real) {
            event.preventDefault()
            return
          }
          event.stopPropagation()
          beginOfficeDrag(event, { kind: 'tag', name: real.name })
        }}
        onDragEnd={endOfficeDrag}
        className="min-w-0 flex-1 truncate py-1 text-left font-medium"
      >
        {node.name}
      </button>
      {!node.isVirtual && node.totalCount > 0 && (
        <span className="shrink-0 text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]">{node.totalCount}</span>
      )}
      <Tooltip label={t('common.more_actions')} side="left">
        <IconButton
          label={t('common.more_actions')}
          size="sm"
          className="shrink-0 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            menu.close()
            setMenuOpen(true)
          }}
        >
          <MoreHorizontal size={13} />
        </IconButton>
      </Tooltip>
      <Menu anchor={rowRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} width={216} />
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items} width={216} />}
    </div>
  )
}