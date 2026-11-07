import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { ChevronDown, ChevronRight, Eye, EyeOff, FolderPlus, MoreHorizontal, Pencil, SquareKanban, Trash2 } from 'lucide-react'
import type { ProjectBoardSummary, ProjectCategory, ProjectCategoryBoard } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { confirm, Menu, prompt, type MenuItem } from '../../components/overlay'
import { useUi } from '../../store/ui'
import {
  addBoardToCategory,
  createProjectCategory,
  deleteProjectCategory,
  fetchProjectCategories,
  patchProjectCategory,
  setCategoryBoardHidden,
} from './api'

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

export function ProjectSidebar({ boards }: { boards: ProjectBoardSummary[] }): ReactElement {
  const [categories, setCategories] = useState<ProjectCategory[]>([])
  const [edges, setEdges] = useState<ProjectCategoryBoard[]>([])
  const [query, setQuery] = useState('')
  const toast = useUi((state) => state.toast)

  const reload = useCallback(async () => {
    const result = await fetchProjectCategories()
    setCategories(result.categories)
    setEdges(result.categoryBoards)
  }, [])
  useEffect(() => { void reload().catch(() => undefined) }, [reload])

  const guard = async (action: () => Promise<void>) => {
    try { await action(); await reload() } catch (reason) { toast({ title: errorText(reason), tone: 'danger' }) }
  }

  const matches = (board: ProjectBoardSummary) => board.title.toLowerCase().includes(query.trim().toLowerCase())
  const filedIds = new Set(edges.map((edge) => edge.boardId))
  const unfiled = boards.filter((board) => !filedIds.has(board.id) && matches(board))

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
    return items
  }

  const renderBoard = (board: ProjectBoardSummary, edge: ProjectCategoryBoard | undefined) => (
    <BoardEntry key={board.id} board={board} edge={edge} items={boardMenu(board, edge)} />
  )

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-subtle)]" aria-label={t('project.title')}>
      <div className="flex items-center gap-1 p-2">
        <Input className="min-w-0 flex-1" value={query} placeholder={t('project.sidebar.search')} aria-label={t('project.sidebar.search')} onChange={(event) => setQuery(event.target.value)} />
        <IconButton label={t('project.sidebar.new_category')} size="sm" onClick={newCategory}><FolderPlus size={15} /></IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {categories.map((category) => {
          const categoryEdges = edges.filter((edge) => edge.categoryId === category.id).sort((a, b) => a.position - b.position)
          const categoryBoards = categoryEdges.map((edge) => ({ board: boards.find((b) => b.id === edge.boardId), edge })).filter((entry): entry is { board: ProjectBoardSummary, edge: ProjectCategoryBoard } => Boolean(entry.board) && matches(entry.board!))
          return (
            <section key={category.id} className="mb-2">
              <CategoryHeader category={category} onRename={() => {
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

function CategoryHeader({ category, onRename, onDelete, onToggle }: { category: ProjectCategory, onRename: () => void, onDelete: () => void, onToggle: () => void }): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const items: MenuItem[] = [
    { id: 'rename', label: t('project.boards.rename'), icon: <Pencil size={15} />, onSelect: onRename },
    { id: 'delete', label: t('common.delete'), icon: <Trash2 size={15} />, tone: 'danger', disabled: category.type === 'system', onSelect: onDelete },
  ]
  return (
    <div className="flex items-center gap-1">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1 rounded-[var(--r-sm)] px-1 py-1 text-left text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={onToggle} aria-expanded={!category.collapsed}>
        {category.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span className="min-w-0 flex-1 truncate">{category.name}</span>
      </button>
      <IconButton ref={anchor} label={category.name} size="sm" onClick={() => setOpen(true)}><MoreHorizontal size={14} /></IconButton>
      <Menu anchor={anchor} open={open} onClose={() => setOpen(false)} items={items} label={category.name} />
    </div>
  )
}

function BoardEntry({ board, edge, items }: { board: ProjectBoardSummary, edge: ProjectCategoryBoard | undefined, items: MenuItem[] }): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <li className={`flex items-center gap-1 ${edge?.hidden ? 'opacity-50' : ''}`} data-sidebar-board={board.id}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--r-sm)] px-1 py-1 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => navigateToPath(`/project/boards/${board.id}`)}>
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