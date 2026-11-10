import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import { ChevronDown, ChevronRight, Copy, Eye, EyeOff, FolderPlus, MoreHorizontal, Pencil, Pin, Settings2, SquareKanban, Star, Trash2 } from 'lucide-react'
import type { ProjectBoardSummary, ProjectCategory, ProjectCategoryBoard } from '@shared/project/model'
import { setLocale, t, useLocale } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { confirm, Menu, prompt, type MenuItem } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useProjectStore } from './store'
import { readRandomIconPref, writeRandomIconPref } from './project-icon'
import {
  readPinnedBoardsPref,
  readStarredBoardsPref,
  writePinnedBoardsPref,
  writeStarredBoardsPref,
} from './project-prefs'
import {
  addBoardToCategory,
  createProjectCategory,
  deleteProjectCategory,
  fetchProjectCategories,
  patchProjectCategory,
  reorderCategoryBoards,
  reorderProjectCategories,
  setCategoryBoardHidden,
} from './api'

const LAST_BOARD_KEY = 'inkstone.project.lastBoard'

function readLastBoard(): string | null {
  try {
    return localStorage.getItem(LAST_BOARD_KEY)
  } catch { /* best-effort: the highlight is optional */
    return null
  }
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

export interface CategoryTreeNode {
  id: string
  name: string
  fullPath: string
  depth: number
  category?: ProjectCategory
  children: CategoryTreeNode[]
  boards: { board: ProjectBoardSummary; edge: ProjectCategoryBoard }[]
}

export function buildCategoryTree(
  categories: ProjectCategory[],
  edges: ProjectCategoryBoard[],
  boards: ProjectBoardSummary[],
  matches: (board: ProjectBoardSummary) => boolean,
): CategoryTreeNode[] {
  const roots: CategoryTreeNode[] = []
  const nodeMap = new Map<string, CategoryTreeNode>()
  const sortedCategories = [...categories].sort((a, b) => a.sortOrder - b.sortOrder)

  for (const cat of sortedCategories) {
    const segments = cat.name.split('/').map((s) => s.trim()).filter(Boolean)
    if (!segments.length) continue

    let path = ''
    let currentSiblings = roots

    for (let depth = 0; depth < segments.length; depth++) {
      const segment = segments[depth]!
      path = depth === 0 ? segment : `${path}/${segment}`
      const isLeaf = depth === segments.length - 1

      let node = nodeMap.get(path)
      if (!node) {
        node = {
          id: isLeaf ? cat.id : `group:${path}`,
          name: segment,
          fullPath: path,
          depth,
          category: isLeaf ? cat : undefined,
          children: [],
          boards: [],
        }
        nodeMap.set(path, node)
        currentSiblings.push(node)
      } else if (isLeaf) {
        node.category = cat
        node.id = cat.id
      }

      if (isLeaf) {
        const catEdges = edges
          .filter((e) => e.categoryId === cat.id)
          .sort((a, b) => a.position - b.position)
        node.boards = catEdges
          .map((edge) => ({ board: boards.find((b) => b.id === edge.boardId)!, edge }))
          .filter((entry): entry is { board: ProjectBoardSummary; edge: ProjectCategoryBoard } =>
            Boolean(entry.board) && matches(entry.board),
          )
      }

      currentSiblings = node.children
    }
  }

  return roots
}

export function ProjectSidebar({ boards, onImport }: { boards: ProjectBoardSummary[], onImport: () => void }): ReactElement {
  const [categories, setCategories] = useState<ProjectCategory[]>([])
  const [edges, setEdges] = useState<ProjectCategoryBoard[]>([])
  const [query, setQuery] = useState('')
  const [lastBoard] = useState(readLastBoard)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [randomIcon, setRandomIcon] = useState(readRandomIconPref)
  const [pinnedIds, setPinnedIds] = useState<string[]>(readPinnedBoardsPref)
  const [starredIds, setStarredIds] = useState<string[]>(readStarredBoardsPref)
  const [contextPoint, setContextPoint] = useState<{ x: number, y: number } | null>(null)
  const [contextItems, setContextItems] = useState<MenuItem[]>([])
  const [contextLabel, setContextLabel] = useState<string>('')
  const [collapsedMap, setCollapsedMap] = useState<Map<string, boolean>>(new Map())

  const settingsAnchor = useRef<HTMLButtonElement>(null)
  const locale = useLocale()
  const theme = useUi((state) => state.theme)
  const applyAppearance = useUi((state) => state.applyAppearance)
  const toast = useUi((state) => state.toast)

  const reload = useCallback(async () => {
    const result = await fetchProjectCategories()
    setCategories(result.categories)
    setEdges(result.categoryBoards)
  }, [])
  useEffect(() => { void reload().catch(() => { /* best-effort: an unreadable category list leaves the board list usable */ return undefined }) }, [reload])

  const guard = async (action: () => Promise<void>) => {
    try { await action(); await reload() } catch (reason) { toast({ title: errorText(reason), tone: 'danger' }) }
  }

  const togglePinBoard = (boardId: string) => {
    const next = pinnedIds.includes(boardId) ? pinnedIds.filter((id) => id !== boardId) : [...pinnedIds, boardId]
    setPinnedIds(next)
    writePinnedBoardsPref(next)
  }

  const toggleStarBoard = (boardId: string) => {
    const next = starredIds.includes(boardId) ? starredIds.filter((id) => id !== boardId) : [...starredIds, boardId]
    setStarredIds(next)
    writeStarredBoardsPref(next)
  }

  const matches = useCallback((board: ProjectBoardSummary) => board.title.toLowerCase().includes(query.trim().toLowerCase()), [query])
  const filedIds = useMemo(() => new Set(edges.map((edge) => edge.boardId)), [edges])
  const unfiled = useMemo(() => boards.filter((board) => !filedIds.has(board.id) && matches(board)), [boards, filedIds, matches])
  const [highlight, setHighlight] = useState(-1)

  const categoryTree = useMemo(() => buildCategoryTree(categories, edges, boards, matches), [categories, edges, boards, matches])

  const visibleBoards = useMemo(() => {
    const fromCategories = categories.flatMap((category) =>
      edges
        .filter((edge) => edge.categoryId === category.id)
        .sort((a, b) => a.position - b.position)
        .map((edge) => boards.find((board) => board.id === edge.boardId))
        .filter((board): board is ProjectBoardSummary => Boolean(board) && matches(board!)),
    )
    return [...fromCategories, ...unfiled]
  }, [categories, edges, boards, unfiled, matches])

  const pinnedBoards = useMemo(() => {
    return pinnedIds
      .map((id) => boards.find((b) => b.id === id))
      .filter((b): b is ProjectBoardSummary => b !== undefined && matches(b))
  }, [pinnedIds, boards, matches])

  const starredBoards = useMemo(() => {
    return starredIds
      .map((id) => boards.find((b) => b.id === id))
      .filter((b): b is ProjectBoardSummary => b !== undefined && matches(b))
  }, [starredIds, boards, matches])

  const onSearchKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight((current) => Math.min(current + 1, visibleBoards.length - 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight((current) => Math.max(current - 1, 0)) }
    else if (event.key === 'Enter') { const board = visibleBoards[highlight]; if (board) navigateToPath(`/project/boards/${board.id}`) }
    else if (event.key === 'Escape') { setQuery(''); setHighlight(-1) }
  }

  const newCategory = () => {
    void guard(async () => {
      const name = await prompt({ title: t('project.sidebar.new_category'), placeholder: t('project.sidebar.category_name'), confirmLabel: t('common.save') })
      if (name !== null && name.trim()) await createProjectCategory(name.trim())
    })
  }

  const boardMenu = (board: ProjectBoardSummary, edge: ProjectCategoryBoard | undefined): MenuItem[] => {
    const isPinned = pinnedIds.includes(board.id)
    const isStarred = starredIds.includes(board.id)
    const items: MenuItem[] = [
      {
        id: 'pin',
        label: isPinned ? t('project.sidebar.unpin') : t('project.sidebar.pin'),
        icon: <Pin size={14} className={isPinned ? 'text-[var(--accent)]' : undefined} />,
        onSelect: () => togglePinBoard(board.id),
      },
      {
        id: 'star',
        label: isStarred ? t('project.sidebar.unfavorite') : t('project.sidebar.favorite'),
        icon: <Star size={14} className={isStarred ? 'fill-[var(--warning)] text-[var(--warning)]' : undefined} />,
        onSelect: () => toggleStarBoard(board.id),
      },
    ]
    if (edge) {
      items.push({
        id: 'hide',
        label: edge.hidden ? t('project.sidebar.unhide') : t('project.sidebar.hide'),
        icon: edge.hidden ? <Eye size={15} /> : <EyeOff size={15} />,
        separatorBefore: true,
        onSelect: () => { void guard(async () => { await setCategoryBoardHidden(edge.categoryId, board.id, !edge.hidden) }) },
      })
    }
    for (const category of categories) {
      if (edge?.categoryId === category.id) continue
      items.push({
        id: `move-${category.id}`,
        label: `${t('project.sidebar.move_to')}: ${category.name}`,
        onSelect: () => { void guard(async () => { await addBoardToCategory(category.id, board.id) }) },
      })
    }
    items.push({
      id: 'copy',
      label: t('project.boards.duplicate'),
      icon: <Copy size={15} />,
      separatorBefore: true,
      onSelect: () => { void guard(async () => { const copy = await useProjectStore.getState().copyBoard(board.id); navigateToPath(`/project/boards/${copy.id}`) }) },
    })
    items.push({
      id: 'delete',
      label: t('common.delete'),
      icon: <Trash2 size={15} />,
      tone: 'danger',
      onSelect: () => {
        void guard(async () => {
          const ok = await confirm({ title: `${t('common.delete')} ${board.title}?`, tone: 'danger', confirmLabel: t('common.delete') })
          if (ok) await useProjectStore.getState().removeBoard(board.id)
        })
      },
    })
    return items
  }

  const categoryMenu = (node: CategoryTreeNode): MenuItem[] => {
    const isSystem = node.category?.type === 'system'
    const items: MenuItem[] = [
      {
        id: 'new-sub',
        label: t('project.sidebar.new_subcategory'),
        icon: <FolderPlus size={14} />,
        onSelect: () => {
          void guard(async () => {
            const prefix = node.fullPath ? `${node.fullPath}/` : ''
            const name = await prompt({
              title: t('project.sidebar.new_subcategory'),
              placeholder: t('project.sidebar.category_name'),
              defaultValue: prefix,
              confirmLabel: t('common.save'),
            })
            if (name !== null && name.trim()) await createProjectCategory(name.trim())
          })
        },
      },
      {
        id: 'rename',
        label: t('project.boards.rename'),
        icon: <Pencil size={14} />,
        disabled: isSystem,
        onSelect: () => {
          void guard(async () => {
            const name = await prompt({
              title: t('project.sidebar.category_name'),
              defaultValue: node.name,
              confirmLabel: t('common.save'),
            })
            if (name === null || !name.trim() || name.trim() === node.name) return
            const newLeaf = name.trim()
            const cut = node.fullPath.lastIndexOf('/')
            const newFullPath = cut >= 0 ? `${node.fullPath.slice(0, cut + 1)}${newLeaf}` : newLeaf

            if (node.category) {
              await patchProjectCategory(node.category.id, { name: newFullPath })
            }
            const prefix = `${node.fullPath}/`
            const descendants = categories.filter((c) => c.name.startsWith(prefix))
            for (const desc of descendants) {
              const suffix = desc.name.slice(prefix.length)
              await patchProjectCategory(desc.id, { name: `${newFullPath}/${suffix}` })
            }
          })
        },
      },
      {
        id: 'delete',
        label: t('common.delete'),
        icon: <Trash2 size={14} />,
        tone: 'danger',
        disabled: isSystem,
        onSelect: () => {
          void guard(async () => {
            const ok = await confirm({
              title: `${t('common.delete')} ${node.name}?`,
              tone: 'danger',
              confirmLabel: t('common.delete'),
            })
            if (!ok) return
            if (node.category && node.category.type !== 'system') {
              await deleteProjectCategory(node.category.id)
            }
            const prefix = `${node.fullPath}/`
            const descendants = categories.filter((c) => c.name.startsWith(prefix) && c.type !== 'system')
            for (const desc of descendants) {
              await deleteProjectCategory(desc.id)
            }
          })
        },
      },
    ]
    return items
  }

  const edgeForBoard = (boardId: string) => edges.find((e) => e.boardId === boardId)

  const renderBoard = (board: ProjectBoardSummary, edge: ProjectCategoryBoard | undefined) => (
    <BoardEntry
      key={board.id}
      board={board}
      edge={edge}
      items={boardMenu(board, edge)}
      active={board.id === lastBoard}
      focused={visibleBoards[highlight]?.id === board.id}
      isPinned={pinnedIds.includes(board.id)}
      isStarred={starredIds.includes(board.id)}
      onDragStart={(event) => { event.dataTransfer.setData('text/plain', `board:${board.id}`) }}
      onDrop={(event) => dropBoard(event, edge?.categoryId ?? '', board.id)}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setContextItems(boardMenu(board, edge))
        setContextLabel(board.title || t('project.boards.untitled'))
        setContextPoint({ x: event.clientX, y: event.clientY })
      }}
    />
  )

  const settingsMenu: MenuItem[] = [
    { id: 'import', label: t('project.sidebar.import_archive'), onSelect: onImport },
    { id: 'export', label: t('project.sidebar.export_archive'), onSelect: () => { window.open('/api/project/export', '_blank') } },
    { id: 'language', label: `${t('project.sidebar.language')}: ${locale}`, onSelect: () => { void setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN') } },
    { id: 'theme', label: `${t('project.sidebar.theme')}: ${theme}`, onSelect: () => { applyAppearance({ theme: theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light' }) } },
    { id: 'random-icon', label: `${t('project.sidebar.random_icon')}${randomIcon ? ' ✓' : ''}`, onSelect: () => { const next = !randomIcon; writeRandomIconPref(next); setRandomIcon(next) } },
  ]

  const dropCategory = (event: DragEvent, targetId: string) => {
    const src = event.dataTransfer.getData('text/plain')
    if (!src.startsWith('category:')) return
    event.preventDefault()
    const source = src.slice('category:'.length)
    if (source === targetId) return
    const ids = categories.map((c) => c.id).filter((id) => id !== source)
    ids.splice(ids.indexOf(targetId), 0, source)
    void guard(async () => { await reorderProjectCategories(ids) })
  }

  const dropBoard = (event: DragEvent, categoryId: string, targetId: string) => {
    const src = event.dataTransfer.getData('text/plain')
    if (!src.startsWith('board:') || !categoryId) return
    event.preventDefault()
    const source = src.slice('board:'.length)
    if (source === targetId) return
    const ids = edges.filter((e) => e.categoryId === categoryId).sort((a, b) => a.position - b.position).map((e) => e.boardId).filter((id) => id !== source)
    const at = ids.indexOf(targetId)
    if (at < 0) return
    ids.splice(at, 0, source)
    void guard(async () => { await reorderCategoryBoards(categoryId, ids) })
  }

  const toggleCollapseNode = (node: CategoryTreeNode) => {
    if (node.category) {
      void guard(async () => {
        await patchProjectCategory(node.category!.id, { collapsed: !node.category!.collapsed })
      })
    } else {
      setCollapsedMap((prev) => {
        const next = new Map(prev)
        next.set(node.id, !next.get(node.id))
        return next
      })
    }
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]" aria-label={t('project.title')}>
      <div className="flex items-center gap-1 p-2">
        <Input className="min-w-0 flex-1" value={query} placeholder={t('project.sidebar.search')} aria-label={t('project.sidebar.search')} onChange={(event) => { setQuery(event.target.value); setHighlight(-1) }} onKeyDown={onSearchKey} />
        <IconButton label={t('project.sidebar.new_category')} size="sm" onClick={newCategory}><FolderPlus size={15} /></IconButton>
        <IconButton ref={settingsAnchor} label={t('project.sidebar.settings')} size="sm" onClick={() => setSettingsOpen(true)}><Settings2 size={15} /></IconButton>
        <Menu anchor={settingsAnchor} open={settingsOpen} onClose={() => setSettingsOpen(false)} items={settingsMenu} label={t('project.sidebar.settings')} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {pinnedBoards.length > 0 && (
          <section className="mb-2">
            <div className="flex items-center gap-1.5 px-2 py-1 text-[length:var(--text-11)] font-semibold uppercase text-[var(--accent)] tracking-wider">
              <Pin size={12} className="shrink-0" />
              <span>{t('project.sidebar.pinned')}</span>
            </div>
            <ul className="mt-0.5 space-y-0.5">
              {pinnedBoards.map((board) => renderBoard(board, edgeForBoard(board.id)))}
            </ul>
          </section>
        )}

        {starredBoards.length > 0 && (
          <section className="mb-2">
            <div className="flex items-center gap-1.5 px-2 py-1 text-[length:var(--text-11)] font-semibold uppercase text-[var(--warning)] tracking-wider">
              <Star size={12} className="shrink-0 fill-[var(--warning)]" />
              <span>{t('project.sidebar.favorites')}</span>
            </div>
            <ul className="mt-0.5 space-y-0.5">
              {starredBoards.map((board) => renderBoard(board, edgeForBoard(board.id)))}
            </ul>
          </section>
        )}

        {categoryTree.map((node) => (
          <CategoryTreeItem
            key={node.id}
            node={node}
            collapsedMap={collapsedMap}
            onToggleCollapse={toggleCollapseNode}
            categoryMenu={categoryMenu}
            onContextMenu={(event, targetNode) => {
              event.preventDefault()
              event.stopPropagation()
              setContextItems(categoryMenu(targetNode))
              setContextLabel(targetNode.name)
              setContextPoint({ x: event.clientX, y: event.clientY })
            }}
            renderBoard={renderBoard}
            dropCategory={dropCategory}
          />
        ))}

        <section className="mb-2">
          <h3 className="px-1 py-1 text-[length:var(--text-11)] font-semibold uppercase text-[var(--text-tertiary)]">{t('project.sidebar.unfiled')}</h3>
          <ul className="mt-1 space-y-0.5">{unfiled.map((board) => renderBoard(board, undefined))}</ul>
        </section>
      </div>

      {contextPoint && (
        <Menu
          anchor={contextPoint}
          open={Boolean(contextPoint)}
          onClose={() => setContextPoint(null)}
          items={contextItems}
          label={contextLabel}
        />
      )}
    </aside>
  )
}

function CategoryTreeItem({
  node,
  collapsedMap,
  onToggleCollapse,
  categoryMenu,
  onContextMenu,
  renderBoard,
  dropCategory,
}: {
  node: CategoryTreeNode
  collapsedMap: Map<string, boolean>
  onToggleCollapse: (node: CategoryTreeNode) => void
  categoryMenu: (node: CategoryTreeNode) => MenuItem[]
  onContextMenu: (event: ReactMouseEvent, node: CategoryTreeNode) => void
  renderBoard: (board: ProjectBoardSummary, edge: ProjectCategoryBoard | undefined) => ReactElement
  dropCategory: (event: DragEvent, categoryId: string) => void
}): ReactElement {
  const isCollapsed = node.category ? node.category.collapsed : (collapsedMap.get(node.id) ?? false)
  const indent = node.depth * 14
  const anchor = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <section
      className="mb-1"
      onDragOver={(event) => { if (event.dataTransfer.types.includes('text/plain')) event.preventDefault() }}
      onDrop={(event) => dropCategory(event, node.category?.id ?? node.id)}
    >
      <div
        className="group/cat flex items-center gap-1"
        style={{ paddingLeft: `${indent}px` }}
        draggable={Boolean(node.category)}
        onDragStart={(event) => {
          if (node.category) event.dataTransfer.setData('text/plain', `category:${node.category.id}`)
        }}
        onContextMenu={(event) => onContextMenu(event, node)}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 rounded-[var(--r-sm)] px-1 py-1 text-left text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          onClick={() => onToggleCollapse(node)}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" /> : <ChevronDown size={14} className="shrink-0 text-[var(--text-tertiary)]" />}
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
        </button>
        <IconButton
          ref={anchor}
          label={node.name}
          size="sm"
          className="opacity-0 group-hover/cat:opacity-100 transition-opacity"
          onClick={() => setMenuOpen(true)}
        >
          <MoreHorizontal size={14} />
        </IconButton>
        <Menu
          anchor={anchor}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          items={categoryMenu(node)}
          label={node.name}
        />
      </div>
      {!isCollapsed && (
        <div className="mt-0.5 space-y-0.5">
          {node.boards.map(({ board, edge }) => renderBoard(board, edge))}
          {node.children.map((child) => (
            <CategoryTreeItem
              key={child.id}
              node={child}
              collapsedMap={collapsedMap}
              onToggleCollapse={onToggleCollapse}
              categoryMenu={categoryMenu}
              onContextMenu={onContextMenu}
              renderBoard={renderBoard}
              dropCategory={dropCategory}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function BoardEntry({
  board,
  edge,
  items,
  active,
  focused,
  isPinned,
  isStarred,
  onDragStart,
  onDrop,
  onContextMenu,
}: {
  board: ProjectBoardSummary
  edge: ProjectCategoryBoard | undefined
  items: MenuItem[]
  active: boolean
  focused: boolean
  isPinned?: boolean
  isStarred?: boolean
  onDragStart: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
  onContextMenu?: (event: ReactMouseEvent) => void
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <li
      className={`group/board flex items-center gap-1 ${edge?.hidden ? 'opacity-50' : ''}`}
      data-sidebar-board={board.id}
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('text/plain')) event.preventDefault() }}
      onDrop={onDrop}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--r-sm)] px-1 py-1 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${active ? 'bg-[var(--bg-hover)] font-semibold' : ''} ${focused ? 'ring-2 ring-[var(--accent)]' : ''}`}
        onClick={() => navigateToPath(`/project/boards/${board.id}`)}
      >
        <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center text-[length:var(--text-12)]">
          {board.icon || <SquareKanban size={13} className="text-[var(--text-quaternary)]" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">
          {board.title || t('project.boards.untitled')}
        </span>
        {isPinned && <Pin size={11} className="shrink-0 text-[var(--accent)]" />}
        {isStarred && <Star size={11} className="shrink-0 fill-[var(--warning)] text-[var(--warning)]" />}
      </button>
      {items.length > 0 && (
        <>
          <IconButton ref={anchor} label={t('project.boards.menu_label')} size="sm" onClick={() => setOpen(true)}>
            <MoreHorizontal size={13} />
          </IconButton>
          <Menu anchor={anchor} open={open} onClose={() => setOpen(false)} items={items} label={t('project.boards.menu_label')} />
        </>
      )}
    </li>
  )
}