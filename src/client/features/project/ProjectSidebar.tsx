import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactElement } from 'react'
import { ChevronDown, ChevronRight, Copy, Eye, EyeOff, FolderPlus, MoreHorizontal, Pencil, Settings2, SquareKanban, Trash2 } from 'lucide-react'
import type { ProjectBoardSummary, ProjectCategory, ProjectCategoryBoard } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { confirm, Menu, prompt, type MenuItem } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useProjectStore } from './store'
import { readRandomIconPref, writeRandomIconPref } from './project-icon'
import { setLocale, useLocale } from '../../lib/i18n'
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

export function ProjectSidebar({ boards, onImport }: { boards: ProjectBoardSummary[], onImport: () => void }): ReactElement {
  const [categories, setCategories] = useState<ProjectCategory[]>([])
  const [edges, setEdges] = useState<ProjectCategoryBoard[]>([])
  const [query, setQuery] = useState('')
  const [lastBoard] = useState(readLastBoard)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [randomIcon, setRandomIcon] = useState(readRandomIconPref)
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

  const matches = (board: ProjectBoardSummary) => board.title.toLowerCase().includes(query.trim().toLowerCase())
  const filedIds = new Set(edges.map((edge) => edge.boardId))
  const unfiled = boards.filter((board) => !filedIds.has(board.id) && matches(board))
  const [highlight, setHighlight] = useState(-1)
  const visibleBoards = [
    ...categories.flatMap((category) => edges.filter((edge) => edge.categoryId === category.id).sort((a, b) => a.position - b.position).map((edge) => boards.find((board) => board.id === edge.boardId)).filter((board): board is ProjectBoardSummary => Boolean(board) && matches(board!))),
    ...unfiled,
  ]
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
    const items: MenuItem[] = []
    if (edge) {
      items.push({
        id: 'hide', label: edge.hidden ? t('project.sidebar.unhide') : t('project.sidebar.hide'),
        icon: edge.hidden ? <Eye size={15} /> : <EyeOff size={15} />,
        onSelect: () => { void guard(async () => { await setCategoryBoardHidden(edge.categoryId, board.id, !edge.hidden) }) },
      })
    }
    for (const category of categories) {
      if (edge?.categoryId === category.id) continue
      items.push({
        id: `move-${category.id}`, label: `${t('project.sidebar.move_to')}: ${category.name}`, separatorBefore: items.length === 1,
        onSelect: () => { void guard(async () => { await addBoardToCategory(category.id, board.id) }) },
      })
    }
    items.push({
      id: 'copy', label: t('project.boards.duplicate'), icon: <Copy size={15} />, separatorBefore: items.length > 0,
      onSelect: () => { void guard(async () => { const copy = await useProjectStore.getState().copyBoard(board.id); navigateToPath(`/project/boards/${copy.id}`) }) },
    })
    items.push({
      id: 'delete', label: t('common.delete'), icon: <Trash2 size={15} />, tone: 'danger',
      onSelect: () => {
        void guard(async () => {
          const ok = await confirm({ title: `${t('common.delete')} ${board.title}?`, tone: 'danger', confirmLabel: t('common.delete') })
          if (ok) await useProjectStore.getState().removeBoard(board.id)
        })
      },
    })
    return items
  }

  const renderBoard = (board: ProjectBoardSummary, edge: ProjectCategoryBoard | undefined) => (
    <BoardEntry key={board.id} board={board} edge={edge} items={boardMenu(board, edge)} active={board.id === lastBoard} focused={visibleBoards[highlight]?.id === board.id} onDragStart={(event) => { event.dataTransfer.setData('text/plain', `board:${board.id}`) }} onDrop={(event) => dropBoard(event, edge?.categoryId ?? '', board.id)} />
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

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]" aria-label={t('project.title')}>
      <div className="flex items-center gap-1 p-2">
        <Input className="min-w-0 flex-1" value={query} placeholder={t('project.sidebar.search')} aria-label={t('project.sidebar.search')} onChange={(event) => { setQuery(event.target.value); setHighlight(-1) }} onKeyDown={onSearchKey} />
        <IconButton label={t('project.sidebar.new_category')} size="sm" onClick={newCategory}><FolderPlus size={15} /></IconButton>
        <IconButton ref={settingsAnchor} label={t('project.sidebar.settings')} size="sm" onClick={() => setSettingsOpen(true)}><Settings2 size={15} /></IconButton>
        <Menu anchor={settingsAnchor} open={settingsOpen} onClose={() => setSettingsOpen(false)} items={settingsMenu} label={t('project.sidebar.settings')} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {categories.map((category) => {
          const categoryEdges = edges.filter((edge) => edge.categoryId === category.id).sort((a, b) => a.position - b.position)
          const categoryBoards = categoryEdges.map((edge) => ({ board: boards.find((b) => b.id === edge.boardId), edge })).filter((entry): entry is { board: ProjectBoardSummary, edge: ProjectCategoryBoard } => Boolean(entry.board) && matches(entry.board!))
          return (
            <section key={category.id} className="mb-2" onDragOver={(event) => { if (event.dataTransfer.types.includes('text/plain')) event.preventDefault() }} onDrop={(event) => dropCategory(event, category.id)}>
              <CategoryHeader category={category} onDragStart={(event) => { event.dataTransfer.setData('text/plain', `category:${category.id}`) }} onRename={() => {
                void guard(async () => {
                  const name = await prompt({ title: t('project.sidebar.category_name'), defaultValue: category.name, confirmLabel: t('common.save') })
                  if (name !== null && name.trim()) await patchProjectCategory(category.id, { name: name.trim() })
                })
              }} onDelete={() => {
                void guard(async () => {
                  const ok = await confirm({ title: `${t('common.delete')} ${category.name}?`, tone: 'danger', confirmLabel: t('common.delete') })
                  if (ok) await deleteProjectCategory(category.id)
                })
              }} onToggle={() => { void guard(async () => { await patchProjectCategory(category.id, { collapsed: !category.collapsed }) }) }} />
              {!category.collapsed && <ul className="mt-1 space-y-0.5">{categoryBoards.map(({ board, edge }) => renderBoard(board, edge))}</ul>}
            </section>
          )
        })}
        <section className="mb-2">
          <h3 className="px-1 py-1 text-[length:var(--text-11)] font-semibold uppercase text-[var(--text-tertiary)]">{t('project.sidebar.unfiled')}</h3>
          <ul className="mt-1 space-y-0.5">{unfiled.map((board) => renderBoard(board, undefined))}</ul>
        </section>
      </div>
    </aside>
  )
}

function CategoryHeader({ category, onRename, onDelete, onToggle, onDragStart }: { category: ProjectCategory, onRename: () => void, onDelete: () => void, onToggle: () => void, onDragStart: (event: DragEvent) => void }): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const items: MenuItem[] = [
    { id: 'rename', label: t('project.boards.rename'), icon: <Pencil size={15} />, onSelect: onRename },
    { id: 'delete', label: t('common.delete'), icon: <Trash2 size={15} />, tone: 'danger', disabled: category.type === 'system', onSelect: onDelete },
  ]
  return (
    <div className="flex items-center gap-1" draggable onDragStart={onDragStart}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1 rounded-[var(--r-sm)] px-1 py-1 text-left text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={onToggle} aria-expanded={!category.collapsed}>
        {category.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span className="min-w-0 flex-1 truncate">{category.name}</span>
      </button>
      <IconButton ref={anchor} label={category.name} size="sm" onClick={() => setOpen(true)}><MoreHorizontal size={14} /></IconButton>
      <Menu anchor={anchor} open={open} onClose={() => setOpen(false)} items={items} label={category.name} />
    </div>
  )
}

function BoardEntry({ board, edge, items, active, focused, onDragStart, onDrop }: { board: ProjectBoardSummary, edge: ProjectCategoryBoard | undefined, items: MenuItem[], active: boolean, focused: boolean, onDragStart: (event: DragEvent) => void, onDrop: (event: DragEvent) => void }): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <li className={`flex items-center gap-1 ${edge?.hidden ? 'opacity-50' : ''}`} data-sidebar-board={board.id} draggable onDragStart={onDragStart} onDragOver={(event) => { if (event.dataTransfer.types.includes('text/plain')) event.preventDefault() }} onDrop={onDrop}>
      <button type="button" aria-current={active ? 'true' : undefined} className={`flex min-w-0 flex-1 items-center gap-2 rounded-[var(--r-sm)] px-1 py-1 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${active ? 'bg-[var(--bg-hover)] font-semibold' : ''} ${focused ? 'ring-2 ring-[var(--accent)]' : ''}`} onClick={() => navigateToPath(`/project/boards/${board.id}`)}>
        <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center text-[length:var(--text-12)]">{board.icon || <SquareKanban size={13} className="text-[var(--text-quaternary)]" />}</span>
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{board.title || t('project.boards.untitled')}</span>
      </button>
      {items.length > 0 && (
        <>
          <IconButton ref={anchor} label={t('project.boards.menu_label')} size="sm" onClick={() => setOpen(true)}><MoreHorizontal size={13} /></IconButton>
          <Menu anchor={anchor} open={open} onClose={() => setOpen(false)} items={items} label={t('project.boards.menu_label')} />
        </>
      )}
    </li>
  )
}