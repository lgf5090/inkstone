import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import { ChevronDown, ChevronRight, Clock, Copy, Download, Eye, EyeOff, FolderPlus, GripVertical, MoreHorizontal, Pencil, Pin, Plus, Settings2, Smile, SquareKanban, Star, Trash2, Upload } from 'lucide-react'
import type { ProjectBoardSummary, ProjectCategory, ProjectCategoryBoard } from '@shared/project/model'
import { setLocale, t, useLocale } from '../../lib/i18n'
import { navigateToPath, usePathname } from '../../lib/app-history'
import { IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { confirm, Menu, Modal, prompt, submenuFor, type MenuItem } from '../../components/overlay'
import type { SkinTone } from '@shared/types'
import { EmojiPicker } from '../emoji/EmojiPicker'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { useProjectStore } from './store'
import { readRandomIconPref, writeRandomIconPref } from './project-icon'
import { categoryDropZone, planCategoryDrop } from './sidebar-drag'
import { useBandDrag, type BandDragState } from './views/use-band-drag'
import { isImeComposing } from '../../lib/ime'
import { useEvent } from '../../lib/hooks'
import { PROJECT_SIDEBAR_MAX_WIDTH, PROJECT_SIDEBAR_MIN_WIDTH, readSidebarWidthPref, useProjectBoardMarks, writeSidebarWidthPref } from './project-prefs'
import {
  addBoardToCategory,
  createProjectCategory,
  deleteProjectCategory,
  fetchProjectCategories,
  patchProjectCategory,
  reorderCategoryBoards,
  reorderProjectCategories,
  setCategoryBoardHidden,
  projectBoardExportUrl,
} from './api'

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
  const boardsById = new Map(boards.map((board) => [board.id, board]))
  const edgesByCategory = new Map<string, ProjectCategoryBoard[]>()
  for (const edge of edges) {
    const list = edgesByCategory.get(edge.categoryId)
    if (list) list.push(edge)
    else edgesByCategory.set(edge.categoryId, [edge])
  }

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
        const catEdges = [...(edgesByCategory.get(cat.id) ?? [])].sort((a, b) => a.position - b.position)
        node.boards = catEdges.flatMap((edge) => {
          const board = boardsById.get(edge.boardId)
          return board && matches(board) ? [{ board, edge }] : []
        })
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
  // The open board comes from the address, not from a value read once at mount: switching between
  // two boards keeps this sidebar mounted, and a mount-time read would leave the highlight behind.
  const pathname = usePathname()
  const lastBoard = /^\/project\/boards\/([^/]+)/.exec(pathname)?.[1] ?? null
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [randomIcon, setRandomIcon] = useState(readRandomIconPref)
  const { pinned: pinnedIds, starred: starredIds, togglePin: togglePinBoard, toggleStar: toggleStarBoard } = useProjectBoardMarks()
  const [contextPoint, setContextPoint] = useState<{ x: number, y: number } | null>(null)
  const [contextItems, setContextItems] = useState<MenuItem[]>([])
  const [contextLabel, setContextLabel] = useState<string>('')
  const [collapsedMap, setCollapsedMap] = useState<Map<string, boolean>>(new Map())
  const [width, setWidth] = useState(readSidebarWidthPref)
  const [iconBoard, setIconBoard] = useState<string | null>(null)
  const [iconTone, setIconTone] = useState<SkinTone>(0)

  const settingsAnchor = useRef<HTMLButtonElement>(null)
  const currentUserId = useSession((state) => state.user?.id)
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

  const matches = useCallback((board: ProjectBoardSummary) => board.title.toLowerCase().includes(query.trim().toLowerCase()), [query])
  const filedIds = useMemo(() => new Set(edges.map((edge) => edge.boardId)), [edges])
  const boardsById = useMemo(() => new Map(boards.map((board) => [board.id, board])), [boards])
  const edgesByCategory = useMemo(() => {
    const map = new Map<string, ProjectCategoryBoard[]>()
    for (const edge of edges) {
      const list = map.get(edge.categoryId)
      if (list) list.push(edge)
      else map.set(edge.categoryId, [edge])
    }
    return map
  }, [edges])
  const edgeByBoard = useMemo(() => {
    const map = new Map<string, ProjectCategoryBoard>()
    for (const edge of edges) if (!map.has(edge.boardId)) map.set(edge.boardId, edge)
    return map
  }, [edges])
  const unfiled = useMemo(() => boards.filter((board) => !filedIds.has(board.id) && matches(board)), [boards, filedIds, matches])
  const [highlight, setHighlight] = useState(-1)

  const categoryTree = useMemo(() => buildCategoryTree(categories, edges, boards, matches), [categories, edges, boards, matches])

  const visibleBoards = useMemo(() => {
    const fromCategories = categories.flatMap((category) =>
      [...(edgesByCategory.get(category.id) ?? [])]
        .sort((a, b) => a.position - b.position)
        .flatMap((edge) => {
          const board = boardsById.get(edge.boardId)
          return board && matches(board) ? [board] : []
        }),
    )
    return [...fromCategories, ...unfiled]
  }, [categories, edgesByCategory, boardsById, unfiled, matches])

  const pinnedBoards = useMemo(() => {
    return pinnedIds
      .map((id) => boards.find((b) => b.id === id))
      .filter((b): b is ProjectBoardSummary => b !== undefined && matches(b))
  }, [pinnedIds, boards, matches])

  const recentBoards = useMemo(() => [...boards]
    .filter((board) => matches(board))
    .sort((left, right) => right.updateAt - left.updateAt)
    .slice(0, 5), [boards, matches])

  const starredBoards = useMemo(() => {
    return starredIds
      .map((id) => boards.find((b) => b.id === id))
      .filter((b): b is ProjectBoardSummary => b !== undefined && matches(b))
  }, [starredIds, boards, matches])

  const onSearchKey = (event: KeyboardEvent) => {
    if (isImeComposing(event)) return
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
    const isEditor = board.role === 'editor' || board.role === 'admin'
    const isOwner = board.ownerId === currentUserId
    const items: MenuItem[] = [
      { id: 'open', label: t('project.sidebar.open_board'), icon: <SquareKanban size={14} />, onSelect: () => navigateToPath(`/project/boards/${board.id}`) },
      {
        id: 'rename',
        label: t('project.boards.rename'),
        icon: <Pencil size={14} />,
        disabled: !isEditor,
        onSelect: () => {
          void guard(async () => {
            const name = await prompt({ title: t('project.boards.rename_title'), defaultValue: board.title, confirmLabel: t('common.save') })
            if (name !== null && name.trim()) await useProjectStore.getState().renameBoard(board.id, name.trim())
          })
        },
      },
      { id: 'icon', label: t('project.sidebar.change_icon'), icon: <Smile size={14} />, disabled: !isEditor, onSelect: () => setIconBoard(board.id) },
      {
        id: 'pin',
        label: isPinned ? t('project.sidebar.unpin') : t('project.sidebar.pin'),
        icon: <Pin size={14} className={isPinned ? 'text-[var(--accent)]' : undefined} />,
        separatorBefore: true,
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
        onSelect: () => { void guard(async () => { await setCategoryBoardHidden(edge.categoryId, board.id, !edge.hidden) }) },
      })
    }
    const targets = categories.filter((category) => category.id !== edge?.categoryId).map((category) => ({
      id: `move-${category.id}`,
      label: category.name,
      onSelect: () => { void guard(async () => { await addBoardToCategory(category.id, board.id) }) },
    }))
    if (targets.length > 0) {
      items.push({ id: 'move', label: t('project.sidebar.move_to_folder'), icon: <FolderPlus size={14} />, separatorBefore: true, subItems: targets, submenu: submenuFor(targets) })
    }
    items.push({
      id: 'copy',
      label: t('project.boards.duplicate'),
      icon: <Copy size={15} />,
      separatorBefore: true,
      onSelect: () => { void guard(async () => { const copy = await useProjectStore.getState().copyBoard(board.id); navigateToPath(`/project/boards/${copy.id}`) }) },
    })
    items.push({ id: 'export-csv', label: t('project.sidebar.export_csv'), icon: <Download size={14} />, onSelect: () => { window.open(projectBoardExportUrl(board.id, 'csv'), '_blank') } })
    items.push({ id: 'export-archive', label: t('project.sidebar.export_archive'), icon: <Download size={14} />, onSelect: () => { window.open(projectBoardExportUrl(board.id, 'archive'), '_blank') } })
    items.push({
      id: 'delete',
      label: t('common.delete'),
      icon: <Trash2 size={15} />,
      separatorBefore: true,
      tone: 'danger',
      disabled: !isOwner,
      onSelect: () => {
        void guard(async () => {
          const ok = await confirm({ title: t('project.boards.delete_title', { title: board.title }), tone: 'danger', confirmLabel: t('common.delete') })
          if (!ok) return
          await useProjectStore.getState().removeBoard(board.id)
          // Deleting the board on screen would otherwise leave the reader staring at a dead page.
          if (pathname === `/project/boards/${board.id}`) navigateToPath('/project')
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
            await Promise.all(descendants.map((desc) => {
              const suffix = desc.name.slice(prefix.length)
              return patchProjectCategory(desc.id, { name: `${newFullPath}/${suffix}` })
            }))
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
              title: t('project.sidebar.delete_category', { name: node.name }),
              tone: 'danger',
              confirmLabel: t('common.delete'),
            })
            if (!ok) return
            if (node.category && node.category.type !== 'system') {
              await deleteProjectCategory(node.category.id)
            }
            const prefix = `${node.fullPath}/`
            const descendants = categories.filter((c) => c.name.startsWith(prefix) && c.type !== 'system')
            await Promise.all(descendants.map((desc) => deleteProjectCategory(desc.id)))
          })
        },
      },
    ]
    return items
  }

  const buildBoardMenu = useEvent((board: ProjectBoardSummary, edge: ProjectCategoryBoard | undefined) => boardMenu(board, edge))
  const buildCategoryMenu = useEvent((node: CategoryTreeNode) => categoryMenu(node))
  const openBoardContext = useEvent((event: ReactMouseEvent, board: ProjectBoardSummary, edge: ProjectCategoryBoard | undefined) => {
    event.preventDefault()
    event.stopPropagation()
    setContextItems(boardMenu(board, edge))
    setContextLabel(board.title || t('project.boards.untitled'))
    setContextPoint({ x: event.clientX, y: event.clientY })
  })
  const openCategoryContext = useEvent((event: ReactMouseEvent, node: CategoryTreeNode) => {
    event.preventDefault()
    event.stopPropagation()
    setContextItems(categoryMenu(node))
    setContextLabel(node.name)
    setContextPoint({ x: event.clientX, y: event.clientY })
  })

  const edgeForBoard = (boardId: string) => edgeByBoard.get(boardId)

  const renderBoard = (board: ProjectBoardSummary, edge: ProjectCategoryBoard | undefined) => (
    <BoardEntry
      key={board.id}
      board={board}
      edge={edge}
      active={board.id === lastBoard}
      focused={visibleBoards[highlight]?.id === board.id}
      isPinned={pinnedIds.includes(board.id)}
      isStarred={starredIds.includes(board.id)}
      isDropTarget={sidebarDrag.overId === `board:${board.id}` && sidebarDrag.draggingId !== `board:${board.id}`}
      isDragging={sidebarDrag.draggingId === `board:${board.id}`}
      buildItems={buildBoardMenu}
      onDragStart={sidebarDrag.start}
      onContextMenu={openBoardContext}
    />
  )

  const settingsMenu: MenuItem[] = [
    { id: 'import', label: t('project.sidebar.import_archive'), onSelect: onImport },
    { id: 'export', label: t('project.sidebar.export_archive'), onSelect: () => { window.open('/api/project/export', '_blank') } },
    { id: 'language', label: `${t('project.sidebar.language')}: ${locale === 'zh-CN' ? t('project.sidebar.language_name_zh') : t('project.sidebar.language_name_en')}`, onSelect: () => { void setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN') } },
    { id: 'theme', label: `${t('project.sidebar.theme')}: ${t(`project.sidebar.theme_${theme}` as Parameters<typeof t>[0])}`, onSelect: () => { applyAppearance({ theme: theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light' }) } },
    { id: 'random-icon', label: `${t('project.sidebar.random_icon')}${randomIcon ? ' ✓' : ''}`, onSelect: () => { const next = !randomIcon; writeRandomIconPref(next); setRandomIcon(next) } },
  ]

  const asideRef = useRef<HTMLElement>(null)

  /**
   * One pointer drag for the whole tree. Rows carry a `board:`/`category:` payload, so a drop reads
   * the pair: a board onto a folder files it, a board onto a board reorders within that folder, and a
   * folder onto a folder nests or places beside depending on which third of the row was released.
   */
  const dropSidebarRow = (source: string, target: string, point: { x: number, y: number }) => {
    if (source.startsWith('board:')) {
      const boardId = source.slice('board:'.length)
      if (target.startsWith('category:')) {
        const categoryId = target.slice('category:'.length)
        if ((edgesByCategory.get(categoryId) ?? []).some((edge) => edge.boardId === boardId)) return
        void guard(async () => { await addBoardToCategory(categoryId, boardId) })
        return
      }
      if (!target.startsWith('board:')) return
      const targetId = target.slice('board:'.length)
      const categoryId = edgeForBoard(targetId)?.categoryId ?? ''
      if (!categoryId || boardId === targetId) return
      const ids = [...(edgesByCategory.get(categoryId) ?? [])].sort((a, b) => a.position - b.position).map((e) => e.boardId).filter((id) => id !== boardId)
      const at = ids.indexOf(targetId)
      if (at < 0) return
      ids.splice(at, 0, boardId)
      void guard(async () => { await reorderCategoryBoards(categoryId, ids) })
      return
    }
    if (!source.startsWith('category:') || !target.startsWith('category:')) return
    const row = asideRef.current?.querySelector<HTMLElement>(`[data-sidebar-drop="${target}"]`)
    if (!row) return
    const box = row.getBoundingClientRect()
    const plan = planCategoryDrop(categories, source.slice('category:'.length), target.slice('category:'.length), categoryDropZone(point.y - box.top, box.height))
    if (!plan) return
    void guard(async () => {
      if (plan.kind === 'reorder') await reorderProjectCategories(plan.ids)
      else for (const rename of plan.renames) await patchProjectCategory(rename.id, { name: rename.name })
    })
  }

  const sidebarDrag = useBandDrag({
    enabled: true,
    axis: 'y',
    measure: () => [...(asideRef.current?.querySelectorAll<HTMLElement>('[data-sidebar-drop]') ?? [])].map((node) => {
      const rect = node.getBoundingClientRect()
      return { id: node.dataset.sidebarDrop ?? '', from: rect.top, to: rect.bottom }
    }),
    onDrop: dropSidebarRow,
  })

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
    <aside ref={asideRef} className="relative flex shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]" style={{ '--pv-sidebar-w': `${width}px`, width: 'var(--pv-sidebar-w)' } as React.CSSProperties} aria-label={t('project.title')}>
      <button
        type="button"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('project.sidebar.width')}
        aria-valuenow={width}
        aria-valuemin={PROJECT_SIDEBAR_MIN_WIDTH}
        aria-valuemax={PROJECT_SIDEBAR_MAX_WIDTH}
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        onKeyDown={(event) => {
          const delta = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
          if (!delta) return
          event.preventDefault()
          setWidth((current) => { const next = Math.min(PROJECT_SIDEBAR_MAX_WIDTH, Math.max(PROJECT_SIDEBAR_MIN_WIDTH, current + delta)); writeSidebarWidthPref(next); return next })
        }}
        onPointerDown={(event) => {
          const startX = event.clientX
          const startWidth = width
          const target = event.currentTarget
          target.setPointerCapture(event.pointerId)
          let latest = startWidth
          const move = (moveEvent: PointerEvent) => {
            const next = Math.min(PROJECT_SIDEBAR_MAX_WIDTH, Math.max(PROJECT_SIDEBAR_MIN_WIDTH, startWidth + moveEvent.clientX - startX))
            latest = next
            asideRef.current?.style.setProperty('--pv-sidebar-w', `${next}px`)
          }
          const up = () => {
            target.removeEventListener('pointermove', move)
            target.removeEventListener('pointerup', up)
            setWidth(latest)
            writeSidebarWidthPref(latest)
          }
          target.addEventListener('pointermove', move)
          target.addEventListener('pointerup', up)
        }}
      />
      <div className="space-y-2 p-2">
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1.5 rounded-[var(--r-md)] border border-dashed border-[var(--border-default)] px-2 py-2 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          onClick={() => { void guard(async () => {
            const title = await prompt({ title: t('project.boards.create_title'), placeholder: t('project.boards.create_placeholder'), confirmLabel: t('project.boards.create_confirm') })
            if (title === null || !title.trim()) return
            const board = await useProjectStore.getState().addBoard(title.trim())
            navigateToPath(`/project/boards/${board.id}`)
          }) }}
        >
          <Plus size={14} aria-hidden="true" />{t('project.sidebar.new_board')}
        </button>
        <Input className="w-full" value={query} placeholder={t('project.sidebar.search')} aria-label={t('project.sidebar.search')} onChange={(event) => { setQuery(event.target.value); setHighlight(-1) }} onKeyDown={onSearchKey} />
        <div className="flex items-center gap-1">
          <IconButton label={t('project.sidebar.new_category')} size="sm" onClick={newCategory}><FolderPlus size={15} /></IconButton>
          <IconButton label={t('project.sidebar.import_archive')} size="sm" onClick={onImport}><Upload size={15} /></IconButton>
          <IconButton ref={settingsAnchor} className="ml-auto" label={t('project.sidebar.settings')} size="sm" onClick={() => setSettingsOpen(true)}><Settings2 size={15} /></IconButton>
          <Menu anchor={settingsAnchor} open={settingsOpen} onClose={() => setSettingsOpen(false)} items={settingsMenu} label={t('project.sidebar.settings')} />
        </div>
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

        {recentBoards.length > 0 && (
          <section className="mb-2">
            <div className="flex items-center gap-1.5 px-2 py-1 text-[length:var(--text-11)] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
              <Clock size={12} className="shrink-0" />
              <span>{t('project.sidebar.recent')}</span>
            </div>
            <ul className="mt-0.5 space-y-0.5">
              {recentBoards.map((board) => renderBoard(board, edgeForBoard(board.id)))}
            </ul>
          </section>
        )}

        {categoryTree.map((node) => (
          <CategoryTreeItem
            key={node.id}
            node={node}
            collapsedMap={collapsedMap}
            onToggleCollapse={toggleCollapseNode}
            buildCategoryMenu={buildCategoryMenu}
            onContextMenu={openCategoryContext}
            renderBoard={renderBoard}
            drag={sidebarDrag}
          />
        ))}

        <section className="mb-2">
          <h3 className="px-1 py-1 text-[length:var(--text-11)] font-semibold uppercase text-[var(--text-tertiary)]">{t('project.sidebar.unfiled')}</h3>
          <ul className="mt-1 space-y-0.5">{unfiled.map((board) => renderBoard(board, undefined))}</ul>
        </section>
      </div>

      {iconBoard && (
        <Modal open onClose={() => setIconBoard(null)} title={t('project.sidebar.change_icon')} width={420}>
          <EmojiPicker tone={iconTone} onTone={setIconTone} onInsert={(glyph) => {
            const target = iconBoard
            setIconBoard(null)
            void guard(async () => { await useProjectStore.getState().setBoardIcon(target, glyph) })
          }} />
        </Modal>
      )}
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
  buildCategoryMenu,
  onContextMenu,
  renderBoard,
  drag,
}: {
  node: CategoryTreeNode
  collapsedMap: Map<string, boolean>
  onToggleCollapse: (node: CategoryTreeNode) => void
  buildCategoryMenu: (node: CategoryTreeNode) => MenuItem[]
  onContextMenu: (event: ReactMouseEvent, node: CategoryTreeNode) => void
  renderBoard: (board: ProjectBoardSummary, edge: ProjectCategoryBoard | undefined) => ReactElement
  drag: BandDragState
}): ReactElement {
  const payload = node.category ? `category:${node.category.id}` : null
  const isCollapsed = node.category ? node.category.collapsed : (collapsedMap.get(node.id) ?? false)
  const indent = node.depth * 14
  const anchor = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <section className="mb-1">
      <div
        className="group/cat flex items-center gap-1"
        style={{ paddingLeft: `${indent}px` }}
        data-sidebar-drop={payload ?? undefined}
        data-drop-target={payload !== null && drag.overId === payload && drag.draggingId !== payload}
        data-dragging={payload !== null && drag.draggingId === payload}
        onContextMenu={(event) => onContextMenu(event, node)}
      >
        {payload && (
          <button
            type="button"
            className="pv-side-grip"
            data-sidebar-grip={payload}
            aria-label={t('project.sidebar.drag_row', { title: node.name })}
            onPointerDown={(event) => drag.start(event, payload)}
          >
            <GripVertical size={12} aria-hidden="true" />
          </button>
        )}
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
          className="opacity-0 group-hover/cat:opacity-100 focus-visible:opacity-100 transition-opacity" data-touch-reveal=""
          onClick={() => setMenuOpen(true)}
        >
          <MoreHorizontal size={14} />
        </IconButton>
        <Menu
          anchor={anchor}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          items={menuOpen ? buildCategoryMenu(node) : []}
          label={node.name}
        />
      </div>
      {!isCollapsed && (
        <div className="mt-0.5 space-y-0.5">
          {/* A board sits one level deeper than the folder holding it, or the tree reads flat. */}
          <div className="space-y-0.5" style={{ paddingLeft: `${(node.depth + 1) * 14}px` }}>
            {node.boards.map(({ board, edge }) => renderBoard(board, edge))}
          </div>
          {node.children.map((child) => (
            <CategoryTreeItem
              key={child.id}
              node={child}
              collapsedMap={collapsedMap}
              onToggleCollapse={onToggleCollapse}
              buildCategoryMenu={buildCategoryMenu}
              onContextMenu={onContextMenu}
              renderBoard={renderBoard}
              drag={drag}
            />
          ))}
        </div>
      )}
    </section>
  )
}

const BoardEntry = memo(function BoardEntry({
  board,
  edge,
  active,
  focused,
  isPinned,
  isStarred,
  isDropTarget,
  isDragging,
  buildItems,
  onDragStart,
  onContextMenu,
}: {
  board: ProjectBoardSummary
  edge: ProjectCategoryBoard | undefined
  active: boolean
  focused: boolean
  isPinned?: boolean
  isStarred?: boolean
  isDropTarget: boolean
  isDragging: boolean
  buildItems: (board: ProjectBoardSummary, edge: ProjectCategoryBoard | undefined) => MenuItem[]
  onDragStart: (event: React.PointerEvent, id: string) => void
  onContextMenu: (event: ReactMouseEvent, board: ProjectBoardSummary, edge: ProjectCategoryBoard | undefined) => void
}): ReactElement {
  const payload = `board:${board.id}`
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const items = open ? buildItems(board, edge) : []
  return (
    <li
      className={`group/board flex items-center gap-1 ${edge?.hidden ? 'opacity-50' : ''}`}
      data-sidebar-board={board.id}
      data-sidebar-drop={payload}
      data-drop-target={isDropTarget}
      data-dragging={isDragging}
      onContextMenu={(event) => onContextMenu(event, board, edge)}
    >
      <button
        type="button"
        className="pv-side-grip"
        data-sidebar-grip={payload}
        aria-label={t('project.sidebar.drag_row', { title: board.title || t('project.boards.untitled') })}
        onPointerDown={(event) => onDragStart(event, payload)}
      >
        <GripVertical size={12} aria-hidden="true" />
      </button>
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
        {board.cardCount !== undefined && (
          <span className="shrink-0 tabular text-[length:var(--text-10)] text-[var(--text-quaternary)]" aria-label={t('project.board.cards_count', { count: board.cardCount })}>{board.cardCount}</span>
        )}
        {isPinned && <Pin size={11} className="shrink-0 text-[var(--accent)]" />}
        {isStarred && <Star size={11} className="shrink-0 fill-[var(--warning)] text-[var(--warning)]" />}
      </button>
      <IconButton ref={anchor} label={t('project.boards.menu_label')} size="sm" onClick={() => setOpen(true)}>
        <MoreHorizontal size={13} />
      </IconButton>
      <Menu anchor={anchor} open={open} onClose={() => setOpen(false)} items={items} label={t('project.boards.menu_label')} />
    </li>
  )
})