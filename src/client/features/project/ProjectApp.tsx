import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Copy, MoreHorizontal, Pencil, Plus, Save, SquareKanban, Trash2 } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import type { ProjectBoardSummary, ProjectRole } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { navigateToPath, usePathname } from '../../lib/app-history'
import { Button, IconButton } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { confirm, Menu, prompt, type MenuItem } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { createBoardFromTemplate, saveBoardAsTemplate } from './api'
import { useProjectStore } from './store'
import { BoardPage } from './BoardPage'
import { TemplatePicker } from './TemplatePicker'

const ROLE_LABEL_KEYS: Record<ProjectRole, MessageKey> = {
  viewer: 'project.role.viewer',
  commenter: 'project.role.commenter',
  editor: 'project.role.editor',
  admin: 'project.role.admin',
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

export function ProjectApp(): ReactElement {
  const pathname = usePathname()
  const match = /^\/project\/boards\/([^/]+)/.exec(pathname)
  if (match) return <BoardPage boardId={decodeURIComponent(match[1]!)} />
  return <BoardList />
}

function BoardList(): ReactElement {
  const boards = useProjectStore((state) => state.boards)
  const status = useProjectStore((state) => state.boardsStatus)
  const error = useProjectStore((state) => state.boardsError)
  const ensureBoards = useProjectStore((state) => state.ensureBoards)
  const loadBoards = useProjectStore((state) => state.loadBoards)
  const addBoard = useProjectStore((state) => state.addBoard)
  const toast = useUi((state) => state.toast)
  const [showPicker, setShowPicker] = useState(false)

  useEffect(() => {
    ensureBoards()
  }, [ensureBoards])

  const pickTemplate = async (templateId: string | null) => {
    setShowPicker(false)
    try {
      if (templateId === null) {
        const title = await prompt({
          title: t('project.boards.create_title'),
          placeholder: t('project.boards.create_placeholder'),
          confirmLabel: t('project.boards.create_confirm'),
        })
        if (title === null) return
        const board = await addBoard(title.trim())
        navigateToPath(`/project/boards/${board.id}`)
      } else {
        const board = await createBoardFromTemplate(templateId)
        navigateToPath(`/project/boards/${board.id}`)
      }
    } catch (reason) {
      toast({ title: errorText(reason), tone: 'danger' })
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-project-app="">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]">
          <SquareKanban size={16} />
        </span>
        <h1 className="min-w-0 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('project.title')}</h1>
        {status === 'ready' && (
          <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('project.boards.count', { count: boards.length })}
          </span>
        )}
        <Button className="ml-auto" variant="primary" size="sm" icon={<Plus size={15} />} onClick={() => setShowPicker(true)}>
          {t('project.boards.new')}
        </Button>
      </header>
      {status === 'idle' || status === 'loading'
        ? <LoadingBlock />
        : status === 'error'
          ? (
              <Empty
                art="select"
                title={t('project.boards.load_failed')}
                description={error ?? undefined}
                action={<Button variant="primary" onClick={() => void loadBoards()}>{t('common.retry')}</Button>}
              />
            )
          : boards.length === 0
            ? <Empty art="folder" title={t('project.boards.empty_title')} description={t('project.boards.empty_description')} />
            : (
                <ul className="min-h-0 flex-1 overflow-y-auto">
                  {boards.map((board) => <BoardRow key={board.id} board={board} />)}
                </ul>
              )}
      {showPicker && <TemplatePicker onClose={() => setShowPicker(false)} onPick={(id) => void pickTemplate(id)} />}
    </div>
  )
}

function BoardRow({ board }: { board: ProjectBoardSummary }): ReactElement {
  const removeBoard = useProjectStore((state) => state.removeBoard)
  const copyBoard = useProjectStore((state) => state.copyBoard)
  const renameBoard = useProjectStore((state) => state.renameBoard)
  const toast = useUi((state) => state.toast)
  const anchor = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const title = board.title || t('project.boards.untitled')
  const canEdit = board.role === 'editor' || board.role === 'admin'

  const guard = async (action: () => Promise<void>) => {
    try {
      await action()
    } catch (reason) {
      toast({ title: errorText(reason), tone: 'danger' })
    }
  }

  const items: MenuItem[] = [
    {
      id: 'rename', label: t('project.boards.rename'), icon: <Pencil size={15} />, disabled: !canEdit,
      onSelect: () => {
        void guard(async () => {
          const next = await prompt({ title: t('project.boards.rename_title'), defaultValue: board.title, confirmLabel: t('project.boards.create_confirm') })
          if (next !== null) await renameBoard(board.id, next.trim())
        })
      },
    },
    {
      id: 'duplicate', label: t('project.boards.duplicate'), icon: <Copy size={15} />,
      onSelect: () => {
        void guard(async () => {
          const copy = await copyBoard(board.id)
          navigateToPath(`/project/boards/${copy.id}`)
        })
      },
    },
    {
      id: 'save-template', label: t('project.templates.save_as'), icon: <Save size={15} />, disabled: board.role !== 'admin',
      onSelect: () => { void guard(async () => { await saveBoardAsTemplate(board.id) }) },
    },
    {
      id: 'delete', label: t('project.boards.delete_confirm'), icon: <Trash2 size={15} />, tone: 'danger', separatorBefore: true, disabled: board.role !== 'admin',
      onSelect: () => {
        void guard(async () => {
          const ok = await confirm({ title: t('project.boards.delete_title', { title }), description: t('project.boards.delete_description'), tone: 'danger', confirmLabel: t('project.boards.delete_confirm') })
          if (ok) await removeBoard(board.id)
        })
      },
    },
  ]

  return (
    <li className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2" data-project-board={board.id}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--r-sm)] text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        onClick={() => navigateToPath(`/project/boards/${board.id}`)}
      >
        <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center text-[length:var(--text-14)]">
          {board.icon || <SquareKanban size={15} className="text-[var(--text-quaternary)]" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{title}</span>
      </button>
      <span className="shrink-0 rounded-[var(--r-sm)] bg-[var(--bg-hover)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
        {t(ROLE_LABEL_KEYS[board.role])}
      </span>
      <IconButton ref={anchor} label={t('project.boards.menu_label')} size="sm" onClick={() => setMenuOpen(true)}>
        <MoreHorizontal size={16} />
      </IconButton>
      <Menu anchor={anchor} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} align="end" label={t('project.boards.menu_label')} />
    </li>
  )
}