/**
 * The to-do container: the rail's `/todo` address, and the frame every view sits in.
 *
 * Two layouts, one state. A desktop gets a fixed sidebar and a board with room for three columns; a
 * phone gets a large title, the same board in two columns, a floating bottom bar for the three
 * cross-cutting views, and a button that adds a task. The breakpoint is a `matchMedia` query rather
 * than CSS alone because the two layouts differ in structure, not only in spacing.
 *
 * The keys this surface answers, and the `?` panel that lists them, live in `use-todo-shortcuts.ts`.
 * What stays here is the half only the frame knows: which field to hand the caret to, whether the
 * sidebar is open, and which page a key was pressed from.
 */

import { useEffect, useRef, useState } from 'react'
import { CalendarRange, ChartNoAxesColumn, Filter, ListChecks, MoreHorizontal, PanelLeft, Paperclip, Plus, Search, Settings2, Sparkles, Sun, X } from 'lucide-react'
import type { SavedTodoFilter } from '@shared/types'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { isImeComposing } from '../../lib/ime'
import { useMediaQuery } from '../../lib/hooks'
import { IconButton } from '../../components/primitives'
import { DEFAULT_TODO_WORKDAY } from '@shared/constants'
import { Input } from '../../components/form'
import { Menu, type MenuItem } from '../../components/overlay'
import { LoadingBlock } from '../../components/feedback'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { useAssistant } from '../chat/assistant-store'
import { AssistantDock } from '../chat/AssistantDock'
import { readsOwnRows, useTodos } from './store'
import { buildTodoAssistantContext } from './assistant-context'
import { BatchBar } from './BatchBar'
import { TaskEditor } from './TaskEditor'
import { ListEditor } from './OrganizerEditors'
import { useViewTitle } from './TaskViews'
import { TodoFilters } from './TodoFilters'
import { ListIcon } from './list-icons'
import { RunningTimerBar } from './running-timer'
import { FocusLayer } from './FocusOverlay'
import { TodoKeysHelp } from './TodoKeysHelp'
import { TODO_ROW_MENU_WIDTH, useTodoShortcuts } from './use-todo-shortcuts'
import { TodoContent, surfaceBadge, surfacesFor } from './views/registry'

type Page = 'main' | 'lists'

/** The empty list a settings object without the field reads as; one instance, so the selector is stable. */
const NO_SAVED_FILTERS: SavedTodoFilter[] = []

/**
 * The phone's fixed chrome, in one place.
 *
 * The floating button sits above the tab bar rather than on top of it, and the bar adds the bottom safe
 * area to its own height — two numbers that used to be written as `76px` and `64px` in three different
 * expressions, where changing one left the button overlapping the bar.
 */
const PHONE_TAB_BAR_CLASS = 'h-[calc(64px+env(safe-area-inset-bottom))]'
const PHONE_FAB_CLASS = 'bottom-[calc(76px+env(safe-area-inset-bottom))]'

const TODO_WRITE_TOOLS = new Set([
  'create_task',
  'create_tasks_from_note',
  'update_task',
  'complete_task',
  'snooze_task',
  'rename_task_tag',
  'create_task_list',
  'update_task_list',
  'add_task_step',
  'check_task_step',
  'delete_task',
  'delete_task_tag',
  'delete_task_list',
  'delete_completed_tasks',
  'delete_task_step',
  'plan_task',
  'move_task',
  'restore_task',
])

function useWide(): boolean {
  return useMediaQuery('(min-width: 768px)')
}

export function TodosApp() {
  const wide = useWide()
  const status = useTodos((state) => state.status)
  const load = useTodos((state) => state.load)
  const view = useTodos((state) => state.view)
  const setView = useTodos((state) => state.setView)
  const listId = useTodos((state) => state.listId)
  const tagId = useTodos((state) => state.tagId)
  const query = useTodos((state) => state.query)
  const setQuery = useTodos((state) => state.setQuery)
  const openEditor = useTodos((state) => state.openEditor)
  const selecting = useTodos((state) => state.selectedIds.size > 0)
  const counts = useTodos((state) => state.counts)
  const lists = useTodos((state) => state.lists)
  const tags = useTodos((state) => state.tags)
  const tasks = useTodos((state) => state.tasks)
  const completed = useTodos((state) => state.completed)
  const draft = useTodos((state) => state.draft)
  const editorOpen = useTodos((state) => state.editorOpen)
  const openListEditor = useTodos((state) => state.openListEditor)
  const timezone = useTodos((state) => state.timezone)
  const dueFrom = useTodos((state) => state.dueFrom)
  const dueTo = useTodos((state) => state.dueTo)
  const assistantDockOpen = useUi((state) => state.assistantDockOpen)
  const assistantTurn = useAssistant((state) => state.turn)
  const applySavedFilter = useTodos((state) => state.applySavedFilter)
  const savedFilters = useSession((state) => state.settings.todo.savedFilters) ?? NO_SAVED_FILTERS
  // The two navs ask the account which rows it wants drawn. Read here rather than inside the registry,
  // so switching the end-of-day page back on redraws the sidebar on the same tick.
  const workday = useSession((state) => state.settings.todo.workday) ?? DEFAULT_TODO_WORKDAY
  const navFlags = { finishDayEnabled: workday.finishDayEnabled }
  const updateSettings = useSession((state) => state.updateSettings)
  const title = useViewTitle()
  const [page, setPage] = useState<Page>('main')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // On a phone the header has no room for a box that is only sometimes used, so the search is one tap
  // away rather than absent: the toggle opens the same field a wide window keeps on screen.
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  /** The phone's overflow: the surfaces that do not fit beside the title. */
  const moreRef = useRef<HTMLButtonElement>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const lastAssistantScreen = useRef<string | null>(null)
  const refreshedTurn = useRef<number | null>(null)
  const assistantScreen = `${view}|${listId ?? ''}|${tagId ?? ''}|${query}|${dueFrom ?? ''}|${dueTo ?? ''}|${editorOpen ? draft?.id ?? 'new' : ''}`

  useEffect(() => {
    // The address names the screen, so it is read here before anything is drawn: a cold load of
    // `/todo?view=plan`, or of one task's own address, has to open on the view or the panel it names
    // rather than flash the board and wait for the reader to put it back.
    useTodos.getState().syncFromAddress()
    void load()
  }, [load])

  useEffect(() => {
    const context = buildTodoAssistantContext({
      view,
      listId,
      tagId,
      query,
      dueFrom,
      dueTo,
      lists,
      tags,
      tasks,
      completed,
      draft,
      editorOpen,
      timezone,
    })
    const assistant = useAssistant.getState()
    assistant.setTodoContext(context)
    if (lastAssistantScreen.current !== assistantScreen) {
      lastAssistantScreen.current = assistantScreen
      assistant.setTodoContextOn(true)
    }
  }, [assistantScreen, completed, draft, editorOpen, dueFrom, dueTo, listId, lists, query, tagId, tags, tasks, timezone, view])

  useEffect(() => {
    if (!assistantTurn?.done || assistantTurn.token === undefined) return
    if (refreshedTurn.current === assistantTurn.token) return
    refreshedTurn.current = assistantTurn.token
    if (assistantTurn.tools.some((tool) => TODO_WRITE_TOOLS.has(tool.name) && tool.status === 'success')) {
      void useTodos.getState().load()
    }
  }, [assistantTurn])

  const openList = (target: { listId?: string; tagId?: string }): void => {
    setPage('main')
    if (target.tagId) setView('tag', { tagId: target.tagId })
    else setView('list', { listId: target.listId ?? 'inbox' })
  }

  const newTask = (): void => {
    const preset = view === 'list' && listId && listId !== 'inbox' ? listId : null
    openEditor({ listId: preset })
  }

  /** Removes one saved filter from the account settings the sidebar reads back. */
  const removeSavedFilter = (id: string): void => {
    updateSettings({ todo: { savedFilters: savedFilters.filter((entry) => entry.id !== id) } })
  }

  // Every keystroke the container answers lives in `use-todo-shortcuts.ts`, which also holds the list
  // the `?` panel prints. What used to sit here was a five-key handler inside an effect with no
  // dependency list, so each render left another listener on the document behind it (defect A18).
  const shortcuts = useTodoShortcuts({
    wide,
    page,
    searchOpen,
    contentRef,
    searchRef,
    openSearch: () => setSearchOpen(true),
    closeSearch: () => setSearchOpen(false),
    toggleSidebar: () => setSidebarOpen((open) => !open),
    newTask,
    goMain: () => setPage('main'),
  })

  /** Escape in the box is the reader taking the words back out — and, on a phone, the box with them. */
  const clearSearch = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (isImeComposing(event)) return
    if (event.key !== 'Escape') return
    if (query) setQuery('')
    else if (!wide) setSearchOpen(false)
  }

  const searchField = (
    <Input
      ref={searchRef}
      autoFocus={!wide}
      value={query}
      onChange={(event) => setQuery(event.target.value)}
      onKeyDown={clearSearch}
      placeholder={t('todo.search_placeholder')}
      aria-label={t('todo.action.search')}
      leading={<Search size={12} />}
      className={wide ? 'h-8 w-40 md:w-56' : 'h-11 w-full'}
    />
  )

  /**
   * What the phone's `⋯` opens.
   *
   * These four used to be header buttons; on a 360px screen they pushed the title down to a few
   * characters. Each row is the same surface the sidebar names on a wide window, so the two layouts
   * offer one vocabulary in two shapes.
   */
  const phoneMoreItems: MenuItem[] = [
    {
      id: 'today',
      label: t('todo.view.today'),
      icon: <Sun size={14} />,
      onSelect: () => { setPage('main'); setView('today') },
    },
    {
      id: 'stats',
      label: t('todo.view.stats'),
      icon: <ChartNoAxesColumn size={14} />,
      onSelect: () => { setPage('main'); setView('stats') },
    },
    {
      id: 'lists',
      label: t('todo.action.lists'),
      icon: <ListChecks size={14} />,
      separatorBefore: true,
      onSelect: () => setPage('lists'),
    },
    ...(IS_DEMO_MODE
      ? []
      : [{
          id: 'assistant',
          label: t('todo.action.ask_assistant'),
          icon: <Sparkles size={14} />,
          onSelect: () => useUi.getState().setAssistantDock(!assistantDockOpen),
        }]),
  ]

  const header = (
    <header
      data-print="hide"
      className="flex h-[calc(44px+env(safe-area-inset-top))] shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 pt-[env(safe-area-inset-top)] md:h-11 md:px-3"
    >
      {/* The search takes the title's place while it is open on a phone, rather than sharing a 360px
          row with it: a field squeezed to 180px is a field nobody can read what they typed in. */}
      {!(searchOpen && !wide) && (
        <span className="min-w-0 shrink truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]">
          {page === 'lists' ? t('todo.action.lists') : title}
        </span>
      )}
      <div className="ml-auto flex min-w-0 items-center gap-0.5">
        {wide ? (
          <>
            <div className="relative min-w-0">{searchField}</div>
            <IconButton
              label={t('todo.action.toggle_sidebar')}
              size="sm"
              className="size-7"
              active={sidebarOpen}
              onClick={() => setSidebarOpen((open) => !open)}
            >
              <PanelLeft size={15} />
            </IconButton>
            {!IS_DEMO_MODE && (
              <IconButton
                label={t('todo.action.ask_assistant')}
                size="sm"
                className="size-7"
                active={assistantDockOpen}
                onClick={() => useUi.getState().setAssistantDock(!assistantDockOpen)}
              >
                <Sparkles size={15} />
              </IconButton>
            )}
            <IconButton label={t('attachments.manage')} size="sm" className="size-7" onClick={() => useUi.getState().setAttachmentHub('todos')}>
              <Paperclip size={15} />
            </IconButton>
            <IconButton label={t('todo.action.lists')} size="sm" className="size-7" active={page === 'lists'} onClick={() => setPage(page === 'lists' ? 'main' : 'lists')}>
              <ListChecks size={15} />
            </IconButton>
            <IconButton label={t('todo.action.new_task')} size="sm" className="size-7" onClick={newTask}>
              <Plus size={15} />
            </IconButton>
          </>
        ) : (
          <>
            {searchOpen ? (
              <div className="relative flex min-w-0 flex-1">{searchField}</div>
            ) : (
              /* A finger's height: on a phone this is the only way to reach a search at all. */
              <IconButton label={t('todo.action.search')} size="sm" className="size-11" onClick={() => setSearchOpen(true)}>
                <Search size={16} />
              </IconButton>
            )}
            {!searchOpen && (
              <>
                {/* The calendar keeps a button of its own: it is the surface a phone reaches most often
                    from wherever it is standing. Today, statistics and the lists page fold into the
                    menu beside it — four glyphs plus a title do not fit across 360px. */}
                <IconButton
                  label={t('todo.view.calendar')}
                  size="sm"
                  className="size-11"
                  active={view === 'calendar'}
                  data-calendar-entry=""
                  onClick={() => { setPage('main'); setView('calendar') }}
                >
                  <CalendarRange size={16} />
                </IconButton>
                <IconButton
                  ref={moreRef}
                  label={t('todo.action.more')}
                  size="sm"
                  className="size-11"
                  active={moreOpen}
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((open) => !open)}
                >
                  <MoreHorizontal size={16} />
                </IconButton>
              </>
            )}
          </>
        )}
      </div>
      {!wide && (
        <Menu
          anchor={moreRef}
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          items={phoneMoreItems}
          align="end"
          width={200}
          label={t('todo.action.more')}
        />
      )}
    </header>
  )

  if (IS_DEMO_MODE) {
    return (
      <section className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-todos-app="">
        {header}
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <div className="max-w-sm text-center">
            <p className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{t('todo.title')}</p>
            <p className="mt-1.5 text-[length:var(--text-12-5)] leading-relaxed text-[var(--text-tertiary)]">{t('todo.demo_notice')}</p>
          </div>
        </div>
      </section>
    )
  }

  const sidebar = (
    <nav aria-label={t('todo.a11y.lists')} className="flex h-full w-[232px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-3">
      <div className="flex flex-col gap-0.5">
        {surfacesFor('sidebar', navFlags).map((surface) => {
          const Icon = surface.icon
          return (
            <SidebarRow
              key={surface.view}
              icon={<Icon size={14} />}
              label={t(surface.sidebar!.labelKey)}
              count={surfaceBadge(surface, 'sidebar', counts)}
              active={view === surface.view}
              onClick={() => { setPage('main'); setView(surface.view) }}
            />
          )
        })}
      </div>

      <div className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">{t('todo.a11y.lists')}</span>
          <button type="button" aria-label={t('todo.action.new_list')} onClick={() => openListEditor(null)} className="text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]"><Plus size={12} /></button>
        </div>
        <SidebarRow icon={<span className="size-2 rounded-full bg-[var(--text-tertiary)]" />} label={t('todo.smart.inbox')} count={counts?.inbox ?? 0} active={view === 'list' && listId === 'inbox'} onClick={() => openList({ listId: 'inbox' })} />
        {lists.map((list) => (
          <SidebarRow
            key={list.id}
            icon={list.icon
              ? <ListIcon icon={list.icon} size={13} />
              : <span className="size-2 rounded-full" style={{ backgroundColor: list.color ?? 'var(--accent)' }} />}
            label={list.name}
            count={list.openCount}
            active={view === 'list' && listId === list.id}
            onClick={() => openList({ listId: list.id })}
          />
        ))}
      </div>

      {tags.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span className="px-2 pb-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">{t('todo.task.tags_label')}</span>
          {tags.map((tag) => (
            <SidebarRow
              key={tag.id}
              icon={<span className="size-2 rounded-full" style={{ backgroundColor: tag.color ?? 'var(--accent)' }} />}
              label={tag.name}
              count={tag.openCount}
              active={view === 'tag' && tagId === tag.id}
              onClick={() => openList({ tagId: tag.id })}
            />
          ))}
        </div>
      )}

      {/* A saved filter is a screen of its own, so opening one starts from the board and the line
          decides everything else. The × is the same delete the settings row offers: one list, two
          doors, so a shortcut removed in either place is gone from both. */}
      {savedFilters.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span className="px-2 pb-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">{t('todo.saved_filters')}</span>
          {savedFilters.map((filter) => {
            const active = view === 'board' && query === filter.query
            return (
              <div key={filter.id} className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => applySavedFilter(filter)}
                  aria-current={active ? 'page' : undefined}
                  title={filter.query}
                  className={cn(
                    'flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)]',
                    active ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center"><Filter size={12} /></span>
                  <span className="min-w-0 flex-1 truncate">{filter.name}</span>
                </button>
                <IconButton
                  label={t('todo.saved_filter.delete', { name: filter.name })}
                  size="xs"
                  onClick={() => removeSavedFilter(filter.id)}
                >
                  <X size={12} />
                </IconButton>
              </div>
            )
          })}
        </div>
      )}

      <button
        type="button"
        onClick={() => setPage('lists')}
        className="mt-auto flex min-h-9 items-center gap-2 rounded-[var(--r-md)] px-2 text-[length:var(--text-12)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]"
      >
        <Settings2 size={14} />{t('todo.action.lists')}
      </button>
    </nav>
  )

  const content = (
    <div ref={contentRef} className="flex min-h-0 flex-1 flex-col">
      <TodoContent page={page} onOpen={openList} />
    </div>
  )

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--bg-base)]" data-todos-app="">
      {header}
      {/* The running interval, above every screen and above the filters: it belongs to the account
          rather than to the view, so it is the one line that has to survive a change of screen. The
          header itself is the narrowest row in the app on a phone, which is why it is a strip under
          that row rather than a sixth control inside it. */}
      <RunningTimerBar />
      {/* The focus session's own two faces, mounted by the frame rather than by a view: a block started on
          the board has to survive a trip to the calendar, and the strip that stands in for the panel while
          `Esc` has taken it away belongs to the same lifetime. */}
      <FocusLayer />
      <div className="flex min-h-0 flex-1">
        {wide && sidebarOpen && sidebar}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The order is a question about the tasks, not about one view: the bar stays above every
              list, and the lists page is a different screen with no listing behind it. The statistics,
              the calendar and the close-out read their own rows, so their own controls replace this bar
              rather than join it — a filter that narrowed nothing would be a control that lies. */}
          {page === 'main' && !readsOwnRows(view) && <TodoFilters />}
          {status === 'loading' && !counts ? <LoadingBlock /> : content}
        </div>
        {assistantDockOpen && !IS_DEMO_MODE && <AssistantDock surface="todos" />}
      </div>

      {/* Above the phone tabs and below the listing, so the bar is the last thing the thumb passes on
          its way to navigation — and the heading it names stays readable while the mode is on. */}
      <BatchBar />

      {!wide && (
        <>
          {/* Adding a task is not what a selection is for, and the floating button would sit on top of
              the bar; it stands down until the selection does. */}
          {!selecting && <button
            type="button"
            onClick={newTask}
            aria-label={t('todo.action.new_task')}
            className={cn('fixed right-4 z-[var(--z-float)] flex size-14 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] shadow-[var(--shadow-modal)] active:scale-95', PHONE_FAB_CLASS)}
          >
            <Plus size={24} />
          </button>}
          <nav
            aria-label={t('todo.app.navigation')}
            className={cn('flex shrink-0 items-stretch justify-around border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] pb-[env(safe-area-inset-bottom)]', PHONE_TAB_BAR_CLASS)}
          >
            {/* Order, glyphs, labels and the one badge all come from the surface table, so a view that
                earns a tab on the phone is added there rather than here. */}
            {surfacesFor('phone', navFlags).map((surface) => {
              const Icon = surface.icon
              return (
                <MobileTab
                  key={surface.view}
                  icon={<Icon size={18} />}
                  label={t(surface.phone!.labelKey)}
                  active={view === surface.view}
                  badge={surfaceBadge(surface, 'phone', counts)}
                  onClick={() => { setPage('main'); setView(surface.view) }}
                />
              )
            })}
            <MobileTab
              icon={<Sparkles size={18} />}
              label={t('todo.action.ask_assistant')}
              active={assistantDockOpen}
              badge={0}
              onClick={() => useUi.getState().setAssistantDock(!assistantDockOpen)}
            />
          </nav>
        </>
      )}

      <TaskEditor />
      {/* Rendered here rather than inside the lists page: the sidebar's "+" opens it from any
          screen, so the editor cannot be unmounted with the page that also renders a button for it. */}
      <ListEditor />

      {/* The panel `q` or `s` opened, anchored at the row that asked for it. Its rows come from
          `task-menu.ts` — the list a kebab and a right-click already answer with — so a key is a third
          way to reach them rather than a fourth copy of them. */}
      {shortcuts.menu && (
        <Menu
          anchor={shortcuts.menu.point}
          open
          onClose={shortcuts.closeMenu}
          items={shortcuts.menu.items}
          width={TODO_ROW_MENU_WIDTH}
          label={shortcuts.menu.label}
        />
      )}
      <TodoKeysHelp open={shortcuts.helpOpen} onClose={shortcuts.closeHelp} />
    </section>
  )
}

function SidebarRow({ icon, label, count, active, onClick }: {
  icon: React.ReactNode
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-h-8 items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)]',
        active ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count > 0 && <span className="shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">{count}</span>}
    </button>
  )
}

function MobileTab({ icon, label, active, badge, onClick }: {
  icon: React.ReactNode
  label: string
  active: boolean
  badge: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn('relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[length:var(--text-10-5)]', active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}
    >
      {icon}
      <span className="truncate">{label}</span>
      {badge > 0 && (
        <span className="absolute right-[22%] top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--danger)] px-1 text-[length:var(--text-9)] font-semibold text-white">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  )
}
