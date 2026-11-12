import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Clock, Copy, Download, MoreHorizontal, Pencil, Pin, Plus, Save, Search, Smile, SquareKanban, Star, Trash2, Upload } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import type { ProjectBoardSummary, ProjectRole } from '@shared/project/model'
import { t, useLocale } from '../../lib/i18n'
import { navigateToPath, usePathname } from '../../lib/app-history'
import { Button, IconButton } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { confirm, Menu, Modal, prompt, type MenuItem } from '../../components/overlay'
import { EmojiPicker } from '../emoji/EmojiPicker'
import { useUi } from '../../store/ui'
import { projectBoardExportUrl, saveBoardAsTemplate } from './api'
import { useProjectStore } from './store'
import { BoardPage } from './BoardPage'
import { ImportDialog } from './ImportDialog'
import { ProjectSidebar } from './ProjectSidebar'
import { SearchDialog } from './SearchDialog'
import { TemplatePicker } from './TemplatePicker'
import { TrashDialog } from './TrashDialog'
import { readBoardListLayoutPref, readPinnedBoardsPref, readStarredBoardsPref, writeBoardListLayoutPref, writePinnedBoardsPref, writeStarredBoardsPref } from './project-prefs'
import { PROJECT_OPTION_COLORS, projectOptionCssColor } from '@shared/project/option-color'
import { Seg } from './views/shell'

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
  const addBoardFromTemplate = useProjectStore((state) => state.addBoardFromTemplate)
  const toast = useUi((state) => state.toast)
  const locale = useLocale()
  const [showPicker, setShowPicker] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showTrash, setShowTrash] = useState(false)
  const [layout, setLayout] = useState<'list' | 'cards'>(readBoardListLayoutPref)
  const chooseLayout = (next: 'list' | 'cards'): void => { setLayout(next); writeBoardListLayoutPref(next) }

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
        const board = await addBoardFromTemplate(templateId, locale)
        navigateToPath(`/project/boards/${board.id}`)
      }
    } catch (reason) {
      toast({ title: errorText(reason), tone: 'danger' })
    }
  }

  return (
    <div className="flex h-full min-h-0 bg-[var(--bg-base)]" data-project-app="">
      <ProjectSidebar boards={boards} onImport={() => setShowImport(true)} />
      <div className="flex min-w-0 flex-1 flex-col">
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
        <span className="ml-auto flex items-center gap-2">
          <Seg
            value={layout}
            label={t('project.boards.layout')}
            onChange={chooseLayout}
            options={[
              { value: 'list', label: t('project.boards.layout_list') },
              { value: 'cards', label: t('project.boards.layout_cards') },
            ]}
          />
        </span>
        <IconButton label={t('project.search.title')} size="sm" onClick={() => setShowSearch(true)}><Search size={16} /></IconButton>
        <IconButton label={t('project.trash.title')} size="sm" onClick={() => setShowTrash(true)}><Trash2 size={16} /></IconButton>
        <IconButton label={t('project.import.title')} size="sm" onClick={() => setShowImport(true)}><Upload size={16} /></IconButton>
        <Button variant="primary" size="sm" icon={<Plus size={15} />} onClick={() => setShowPicker(true)}>
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
                layout === 'cards'
                  ? (
                    <div className="pv-scroll min-h-0 flex-1 overflow-y-auto bg-[var(--bg-sunken)] p-3" data-board-cards="">
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
                        {boards.map((board) => <BoardCard key={board.id} board={board} />)}
                      </div>
                    </div>
                  )
                  : (
                    <ul className="pv-scroll min-h-0 flex-1 overflow-y-auto">
                      {boards.map((board) => <BoardRow key={board.id} board={board} />)}
                    </ul>
                  )
              )}
      </div>
      {showPicker && <TemplatePicker onClose={() => setShowPicker(false)} onPick={(id) => void pickTemplate(id)} />}
      {showSearch && <SearchDialog onClose={() => setShowSearch(false)} />}
      {showTrash && <TrashDialog onClose={() => setShowTrash(false)} onRestored={() => { void loadBoards() }} />}
      {showImport && <ImportDialog onClose={() => setShowImport(false)} />}
    </div>
  )
}

function useBoardMenu(board: ProjectBoardSummary): { items: MenuItem[], canEdit: boolean, title: string, iconPicker: ReactElement | null } {
  const removeBoard = useProjectStore((state) => state.removeBoard)
  const copyBoard = useProjectStore((state) => state.copyBoard)
  const renameBoard = useProjectStore((state) => state.renameBoard)
  const toast = useUi((state) => state.toast)
  const setBoardIcon = useProjectStore((state) => state.setBoardIcon)
  const [pinned, setPinned] = useState(readPinnedBoardsPref)
  const [starred, setStarred] = useState(readStarredBoardsPref)
  const [iconOpen, setIconOpen] = useState(false)
  const title = board.title || t('project.boards.untitled')
  const canEdit = board.role === 'editor' || board.role === 'admin'
  const toggle = (kind: 'pin' | 'star'): void => {
    const read = kind === 'pin' ? pinned : starred
    const next = read.includes(board.id) ? read.filter((id) => id !== board.id) : [...read, board.id]
    if (kind === 'pin') { setPinned(next); writePinnedBoardsPref(next) } else { setStarred(next); writeStarredBoardsPref(next) }
  }

  const guard = async (action: () => Promise<void>) => {
    try {
      await action()
    } catch (reason) {
      toast({ title: errorText(reason), tone: 'danger' })
    }
  }

  const items: MenuItem[] = [
    { id: 'open', label: t('project.sidebar.open_board'), icon: <SquareKanban size={15} />, onSelect: () => navigateToPath(`/project/boards/${board.id}`) },
    { id: 'icon', label: t('project.sidebar.change_icon'), icon: <Smile size={15} />, disabled: !canEdit, onSelect: () => setIconOpen(true) },
    {
      id: 'pin',
      label: pinned.includes(board.id) ? t('project.sidebar.unpin') : t('project.sidebar.pin'),
      icon: <Pin size={15} className={pinned.includes(board.id) ? 'text-[var(--accent)]' : undefined} />,
      separatorBefore: true,
      onSelect: () => toggle('pin'),
    },
    {
      id: 'star',
      label: starred.includes(board.id) ? t('project.sidebar.unfavorite') : t('project.sidebar.favorite'),
      icon: <Star size={15} className={starred.includes(board.id) ? 'fill-[var(--warning)] text-[var(--warning)]' : undefined} />,
      onSelect: () => toggle('star'),
    },
    {
      id: 'rename', label: t('project.boards.rename'), icon: <Pencil size={15} />, separatorBefore: true, disabled: !canEdit,
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
    { id: 'export-csv', label: t('project.sidebar.export_csv'), icon: <Download size={15} />, separatorBefore: true, onSelect: () => { window.open(projectBoardExportUrl(board.id, 'csv'), '_blank') } },
    { id: 'export-archive', label: t('project.sidebar.export_archive'), icon: <Download size={15} />, onSelect: () => { window.open(projectBoardExportUrl(board.id, 'archive'), '_blank') } },
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

  const iconPicker = iconOpen
    ? (
      <Modal open onClose={() => setIconOpen(false)} title={t('project.sidebar.change_icon')} width={420}>
        <EmojiPicker tone={0} onTone={() => {}} onInsert={(glyph) => {
          setIconOpen(false)
          void guard(async () => { await setBoardIcon(board.id, glyph) })
        }} />
      </Modal>
    )
    : null

  return { items, canEdit, title, iconPicker }
}

function BoardRow({ board }: { board: ProjectBoardSummary }): ReactElement {
  const { items, title, iconPicker } = useBoardMenu(board)
  const anchor = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [context, setContext] = useState<{ x: number, y: number } | null>(null)
  return (
    <li
      className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2"
      data-project-board={board.id}
      onContextMenu={(event) => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY }) }}
    >
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
      {context && <Menu anchor={context} open onClose={() => setContext(null)} items={items} label={title} />}
      {iconPicker}
    </li>
  )
}

/**
 * A board has no colour field, so its plate borrows one from the tag palette by id: stable across
 * reloads, and different enough that a wall of boards is not one flat wash.
 */
function boardTint(id: string): string {
  // FNV-1a plus an avalanche step: a plain rolling sum put ids that differ in one character on the
  // same swatch, which is exactly the case a wall of sibling boards hits.
  let hash = 2166136261
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  hash ^= hash >>> 15
  hash = Math.imul(hash, 2246822507) >>> 0
  hash = (hash ^ (hash >>> 13)) >>> 0
  return projectOptionCssColor(PROJECT_OPTION_COLORS[hash % PROJECT_OPTION_COLORS.length]!) ?? 'var(--accent)'
}

/** The same board as a tile: icon, blurb, size and last edit, with the row's whole menu behind it. */
function BoardCard({ board }: { board: ProjectBoardSummary }): ReactElement {
  const { items, title, iconPicker } = useBoardMenu(board)
  const locale = useLocale()
  const anchor = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [context, setContext] = useState<{ x: number, y: number } | null>(null)
  return (
    <article
      className="pv-tile group"
      data-project-board={board.id}
      onContextMenu={(event) => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY }) }}
    >
      <button
        type="button"
        className="flex flex-col text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        onClick={() => navigateToPath(`/project/boards/${board.id}`)}
      >
        <span className="pv-tile-placeholder" aria-hidden="true" style={{ '--pv-cover-h': '92px', '--pv-card-color': boardTint(board.id) } as React.CSSProperties}>
          {board.icon || <SquareKanban size={26} className="text-[var(--text-quaternary)]" />}
        </span>
        <span className="pv-tile-body">
          <span className="pv-tile-title">{title}</span>
          {board.description && <span className="pv-card-desc">{board.description}</span>}
          <span className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            <span className="rounded-[var(--r-sm)] bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--text-secondary)]">{t(ROLE_LABEL_KEYS[board.role])}</span>
            {board.cardCount !== undefined && <span className="tabular">{t('project.board.cards_count', { count: board.cardCount })}</span>}
            <span className="flex items-center gap-1"><Clock size={10} aria-hidden="true" />{new Date(board.updateAt).toLocaleDateString(locale)}</span>
          </span>
        </span>
      </button>
      <span className="absolute right-1.5 top-1.5 z-[1] rounded-[var(--r-sm)] bg-[var(--bg-base)]/80 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <IconButton ref={anchor} label={t('project.boards.menu_label')} size="sm" onClick={() => setMenuOpen(true)}>
          <MoreHorizontal size={15} />
        </IconButton>
      </span>
      <Menu anchor={anchor} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} align="end" label={t('project.boards.menu_label')} />
      {context && <Menu anchor={context} open onClose={() => setContext(null)} items={items} label={title} />}
      {iconPicker}
    </article>
  )
}