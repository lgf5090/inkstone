/**
 * The to-do container: the rail's `/todo` address, and the frame every view sits in.
 *
 * Two layouts, one state. A desktop gets a fixed sidebar and a board with room for three columns; a
 * phone gets a large title, the same board in two columns, a floating bottom bar for the three
 * cross-cutting views, and a button that adds a task. The breakpoint is a `matchMedia` query rather
 * than CSS alone because the two layouts differ in structure, not only in spacing.
 */

import { useEffect, useRef, useState } from 'react'
import { ListChecks, Plus, Search, Settings2 } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { isEditableTarget } from '../../lib/hotkeys'
import { IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { LoadingBlock } from '../../components/feedback'
import { useTodos } from './store'
import { TaskEditor } from './TaskEditor'
import { useViewTitle } from './TaskViews'
import { TodoFilters } from './TodoFilters'
import { TodoContent, surfaceBadge, surfacesFor } from './views/registry'

type Page = 'main' | 'lists'

function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 768px)')
    const onChange = (): void => setWide(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return wide
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
  const counts = useTodos((state) => state.counts)
  const lists = useTodos((state) => state.lists)
  const tags = useTodos((state) => state.tags)
  const title = useViewTitle()
  const [page, setPage] = useState<Page>('main')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // On a phone the header has no room for a box that is only sometimes used, so the search is one tap
  // away rather than absent: the toggle opens the same field a wide window keeps on screen.
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // The address names the screen, so it is read here before anything is drawn: a cold load of
    // `/todo?view=plan`, or of one task's own address, has to open on the view or the panel it names
    // rather than flash the board and wait for the reader to put it back.
    useTodos.getState().syncFromAddress()
    if (useTodos.getState().status === 'idle') void load()
  }, [load])

  const openList = (target: { listId?: string; tagId?: string }): void => {
    setPage('main')
    if (target.tagId) setView('tag', { tagId: target.tagId })
    else setView('list', { listId: target.listId ?? 'inbox' })
  }

  const newTask = (): void => {
    const preset = view === 'list' && listId && listId !== 'inbox' ? listId : null
    openEditor({ listId: preset })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (isEditableTarget(event.target)) return
      if (event.key === 'n') { event.preventDefault(); newTask(); return }
      if (event.key === '/') {
        event.preventDefault()
        if (wide) searchRef.current?.focus()
        else setSearchOpen(true)
        return
      }
      if (event.key === '[') { event.preventDefault(); setSidebarOpen((open) => !open); return }
      if (event.key === 'Escape') {
        // Out of the field, Escape is the way back out of a search a phone opened full-width; inside it,
        // the field's own handler answers first.
        if (searchOpen) { setSearchOpen(false); return }
        setPage('main')
        return
      }
      if (event.key === 'j' || event.key === 'k') {
        const nodes = [...(contentRef.current?.querySelectorAll<HTMLElement>('[data-todo-open]') ?? [])]
        if (!nodes.length) return
        event.preventDefault()
        const index = nodes.findIndex((node) => node === document.activeElement)
        const next = event.key === 'j' ? Math.min(nodes.length - 1, index + 1) : Math.max(0, index - 1)
        nodes[index === -1 ? 0 : next]?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  /** Escape in the box is the reader taking the words back out — and, on a phone, the box with them. */
  const clearSearch = (event: React.KeyboardEvent<HTMLInputElement>): void => {
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

  const header = (
    <header data-print="hide" className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 pt-[env(safe-area-inset-top)]">
      <span className="min-w-0 shrink truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]">
        {page === 'lists' ? t('todo.action.lists') : title}
      </span>
      <div className="ml-auto flex min-w-0 items-center gap-1">
        {wide ? (
          <div className="relative min-w-0">{searchField}</div>
        ) : searchOpen ? (
          <div className="relative flex min-w-0 flex-1">{searchField}</div>
        ) : (
          /* A finger's height: on a phone this is the only way to reach a search at all. */
          <IconButton label={t('todo.action.search')} size="sm" className="size-11" onClick={() => setSearchOpen(true)}>
            <Search size={15} />
          </IconButton>
        )}
        {/* A finger's height on a phone even though the glyph stays small: these two are the only way
            to reach the lists page and to add a task from the header. */}
        <IconButton label={t('todo.action.lists')} size="sm" className="size-11 md:size-6" active={page === 'lists'} onClick={() => setPage(page === 'lists' ? 'main' : 'lists')}>
          <ListChecks size={15} />
        </IconButton>
        <IconButton label={t('todo.action.new_task')} size="sm" className="size-11 md:size-6" onClick={newTask}>
          <Plus size={15} />
        </IconButton>
      </div>
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
    <nav aria-label={t('todo.a11y.lists')} className="flex h-full w-[240px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-3">
      <div className="flex flex-col gap-0.5">
        {surfacesFor('sidebar').map((surface) => {
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
          <button type="button" aria-label={t('todo.action.new_list')} onClick={() => setPage('lists')} className="text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]"><Plus size={12} /></button>
        </div>
        <SidebarRow icon={<span className="size-2 rounded-full bg-[var(--text-tertiary)]" />} label={t('todo.smart.inbox')} count={counts?.inbox ?? 0} active={view === 'list' && listId === 'inbox'} onClick={() => openList({ listId: 'inbox' })} />
        {lists.map((list) => (
          <SidebarRow
            key={list.id}
            icon={<span className="size-2 rounded-full" style={{ backgroundColor: list.color ?? 'var(--accent)' }} />}
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
      <div className="flex min-h-0 flex-1">
        {wide && sidebarOpen && sidebar}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The order is a question about the tasks, not about one view: the bar stays above every
              list, and the lists page is a different screen with no listing behind it. */}
          {page === 'main' && <TodoFilters />}
          {status === 'loading' && !counts ? <LoadingBlock /> : content}
        </div>
      </div>

      {!wide && (
        <>
          <button
            type="button"
            onClick={newTask}
            aria-label={t('todo.action.new_task')}
            className="fixed bottom-[calc(76px+env(safe-area-inset-bottom))] right-4 z-10 flex size-14 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] shadow-[var(--shadow-modal)] active:scale-95"
          >
            <Plus size={24} />
          </button>
          <nav
            aria-label={t('todo.app.navigation')}
            className="flex h-[calc(64px+env(safe-area-inset-bottom))] shrink-0 items-stretch justify-around border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] pb-[env(safe-area-inset-bottom)]"
          >
            {/* Order, glyphs, labels and the one badge all come from the surface table, so a view that
                earns a tab on the phone is added there rather than here. */}
            {surfacesFor('phone').map((surface) => {
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
          </nav>
        </>
      )}

      <TaskEditor />
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
