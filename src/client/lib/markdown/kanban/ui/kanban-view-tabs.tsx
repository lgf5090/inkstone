import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import {
  BarChart2,
  Calendar,
  ChartGantt,
  Kanban,
  LayoutGrid,
  List,
  MoreHorizontal,
  Plus,
  Table,
  Timeline,
} from 'lucide-react'
import { formatKanbanViewName, formatKanbanViewTypeLabel } from '../i18n-helpers'
import { KANBAN_VIEW_TYPES, kanbanViewCarriesState } from '../view-ops'
import { prompt, Menu, type MenuItem } from '../../../../components/overlay'
import type { KanbanView, KanbanViewType } from '../types'
import { t } from '../../../i18n'

/** Exported so a view looks the same wherever it is named, including the command palette. */
export function kanbanViewIcon(type: KanbanViewType) {
  switch (type) {
    case 'board':
      return <Kanban size={14} />
    case 'table':
      return <Table size={14} />
    case 'calendar':
      return <Calendar size={14} />
    case 'timeline':
      return <Timeline size={14} />
    case 'gantt':
      return <ChartGantt size={14} />
    case 'list':
      return <List size={14} />
    case 'gallery':
      return <LayoutGrid size={14} />
    case 'chart':
      return <BarChart2 size={14} />
    default:
      return <Kanban size={14} />
  }
}

// The whole list drives one panel, so a tab's own name has to be derivable from that panel's id —
// the panel labels itself back with `aria-labelledby` and cannot know the view id by itself.
export function kanbanViewTabId(panelId: string, viewId: string): string {
  return `${panelId}-tab-${viewId}`
}

// A tablist is one entry point: the arrows carry both focus and selection, wrapping at the ends.
function rovingTabIndex(current: number, key: string, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count
    case 'ArrowLeft':
      return (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

export interface KanbanViewOperations {
  createView: (type: KanbanViewType) => void
  renameView: (viewId: string, name: string) => void
  duplicateView: (viewId: string) => void
  deleteView: (viewId: string) => void
  moveView: (viewId: string, offset: -1 | 1) => void
}

// The two management controls stand in the header beside the tabs, so they take the header's own
// size step: a finger's target on a phone, the tighter one the row was designed around on a desktop.
const TRIGGER_CLASS =
  'inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-7'

/** One control per menu: it says whether its own list is open and names the panel it opened. */
function useMenuTrigger() {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  return { open, toggle: () => setOpen((o) => !o), close: () => setOpen(false), anchor, panelId }
}

interface MenuTriggerProps {
  anchor: RefObject<HTMLButtonElement | null>
  open: boolean
  toggle: () => void
  panelId: string
  label: string
  icon: ReactNode
}

function MenuTrigger({ anchor, open, toggle, panelId, label, icon }: MenuTriggerProps) {
  return (
    <button
      ref={anchor}
      type='button'
      onClick={toggle}
      className={TRIGGER_CLASS}
      aria-label={label}
      aria-haspopup='menu'
      aria-expanded={open}
      {...(open ? { 'aria-controls': panelId } : {})}
    >
      {icon}
    </button>
  )
}

/**
 * The rows that create a view. Shared with the compact header's own menu: the two must offer the same
 * set, since the list of view types is the field's contract rather than either control's own idea.
 */
export function kanbanNewViewItems(onCreate: (type: KanbanViewType) => void): MenuItem[] {
  return KANBAN_VIEW_TYPES.map((type) => ({
    id: type,
    label: formatKanbanViewTypeLabel(type),
    icon: kanbanViewIcon(type),
    onSelect: () => onCreate(type),
  }))
}

function KanbanNewViewMenu({ onCreate }: { onCreate: (type: KanbanViewType) => void }) {
  const { open, toggle, close, anchor, panelId } = useMenuTrigger()
  const label = t('preview.kanban_new_view')
  const items = kanbanNewViewItems(onCreate)

  return (
    <>
      <MenuTrigger anchor={anchor} open={open} toggle={toggle} panelId={panelId} label={label} icon={<Plus size={14} />} />
      <Menu anchor={anchor} open={open} onClose={close} items={items} panelId={panelId} label={label} align='end' />
    </>
  )
}

async function renameViewWithPrompt(view: KanbanView, viewOps: KanbanViewOperations) {
  const name = await prompt({
    title: t('preview.kanban_view_rename'),
    defaultValue: formatKanbanViewName(view),
  })
  // A blank answer is not a rename: committing one would push an undo step that changes nothing.
  if (name?.trim()) viewOps.renameView(view.id, name)
}

/**
 * The rows that act on the view the strip is showing. Shared with the compact header's own menu for
 * the same reason the creation rows are — one list of what can be done to a view, with the same
 * disabled rules (a blank answer is not a rename, and a board keeps at least one view to draw).
 */
export function kanbanViewActionItems(
  views: KanbanView[],
  activeViewId: string,
  viewOps: KanbanViewOperations,
): MenuItem[] {
  const index = views.findIndex((view) => view.id === activeViewId)
  const view = views[index]
  if (!view) return []
  return [
    { id: 'rename', label: t('preview.kanban_view_rename'), onSelect: () => { void renameViewWithPrompt(view, viewOps) } },
    { id: 'duplicate', label: t('preview.kanban_view_duplicate'), onSelect: () => viewOps.duplicateView(view.id) },
    {
      id: 'move-earlier',
      label: t('preview.kanban_view_move_earlier'),
      disabled: index <= 0,
      onSelect: () => viewOps.moveView(view.id, -1),
    },
    {
      id: 'move-later',
      label: t('preview.kanban_view_move_later'),
      disabled: index >= views.length - 1,
      onSelect: () => viewOps.moveView(view.id, 1),
    },
    {
      id: 'delete',
      label: t('preview.kanban_view_delete'),
      tone: 'danger',
      separatorBefore: true,
      // With its last view gone the board has nothing to render, so that one cannot be deleted.
      disabled: views.length < 1 + 1,
      onSelect: () => viewOps.deleteView(view.id),
    },
  ]
}

function KanbanActiveViewMenu({
  views,
  activeViewId,
  viewOps,
}: {
  views: KanbanView[]
  activeViewId: string
  viewOps: KanbanViewOperations
}) {
  const { open, toggle, close, anchor, panelId } = useMenuTrigger()
  if (!views.some((view) => view.id === activeViewId)) return null
  const label = t('preview.kanban_view_actions')
  const items = kanbanViewActionItems(views, activeViewId, viewOps)

  return (
    <>
      <MenuTrigger anchor={anchor} open={open} toggle={toggle} panelId={panelId} label={label} icon={<MoreHorizontal size={14} />} />
      <Menu anchor={anchor} open={open} onClose={close} items={items} panelId={panelId} label={label} align='end' />
    </>
  )
}

interface TabListProps {
  views: KanbanView[]
  activeViewId: string
  panelId: string
  onSelectView: (viewId: string) => void
}

/**
 * A strip that scrolls hides its own ends, and the one tab that must never be the hidden one is the
 * selected one: with eight views the reader could switch to one from the header's menu and be shown
 * a row that does not contain it.
 *
 * Only the strip's own `scrollLeft` moves — `scrollIntoView` would drag every scroll container above
 * it along, and this row sits inside the note. It is read on every commit rather than on the
 * selection changing: the row is not laid out when the first effect runs, and its geometry moves for
 * reasons the props do not carry (the pane being resized, a view renamed wider, the header's
 * container query dropping to the compact layout).
 */

/** Bring one tab fully inside the strip's visible box, if it is not already. The geometry is read at
 *  call time — what this answers to is whatever the strip has now, not what it had when it mounted. */
function revealSelectedTab(strip: HTMLDivElement | null, tab: HTMLElement | null): void {
  if (!strip || !tab) return
  const left = tab.offsetLeft
  const right = left + tab.offsetWidth
  if (left < strip.scrollLeft) strip.scrollLeft = left
  else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth
}

function useSelectedTabInView(
  stripRef: RefObject<HTMLDivElement | null>,
  tabsRef: RefObject<(HTMLButtonElement | null)[]>,
  activeIndex: number,
): void {
  useLayoutEffect(() => {
    revealSelectedTab(stripRef.current, tabsRef.current?.[activeIndex] ?? null)
  })
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    // The strip's box changes size without a render whenever the board changes homes: the same
    // elements are *moved* between the note and the full screen overlay (no React effect re-runs on
    // a move), and the overlay lays them out at a different width. A `scrollLeft` clamped while the
    // strip was still at its transient pre-move width survives the move, and the selected first tab
    // ends up cut on its left with the reveal never asked to run again — the observer is what runs it
    // whenever the strip's box settles into its new size.
    const observer = new ResizeObserver(() => {
      revealSelectedTab(strip, tabsRef.current?.[activeIndex] ?? null)
    })
    observer.observe(strip)
    return () => observer.disconnect()
  }, [stripRef, tabsRef, activeIndex])
}

interface TabProps {
  view: KanbanView
  panelId: string
  isActive: boolean
  index: number
  register: (node: HTMLButtonElement | null) => void
  onSelectView: (viewId: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void
}

/**
 * One view tab. The selected one is the accent on its own tint — the app's own "this is the current
 * one" pair (the music hub's playlists and deck rail paint it the same way), and the one pairing the
 * token layer calibrates for all seven accents. `--bg-raised` is what it used to be, and on both
 * light themes that token is the header's own `--bg-surface`: the selection was invisible in exactly
 * the mode the reader reported it in.
 *
 * A view that narrows or reorders the cards on its own carries a dot: the tab looks identical to the
 * plain one beside it while showing fewer cards, and without the mark that reads as data loss rather
 * than as a lens the reader left on. The dot is decoration; the sentence is the accessible form.
 */
function KanbanTab({ view, panelId, isActive, index, register, onSelectView, onKeyDown }: TabProps) {
  const carriesState = kanbanViewCarriesState(view)
  return (
    <button
      ref={register}
      id={kanbanViewTabId(panelId, view.id)}
      role='tab'
      aria-selected={isActive}
      aria-controls={panelId}
      data-view-type={view.type}
      type='button'
      tabIndex={isActive ? 0 : -1}
      onClick={() => onSelectView(view.id)}
      onKeyDown={(event) => onKeyDown(event, index)}
      className={`flex h-[var(--sp-9)] shrink-0 items-center gap-[var(--sp-1-5)] rounded-[var(--r-md)] px-[var(--sp-2-5)] text-[length:var(--text-12)] transition-colors md:h-[var(--sp-7)] md:py-[var(--sp-1)] ${
        isActive
          ? 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)]'
          : 'font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
      }`}
    >
      {kanbanViewIcon(view.type)}
      {/* The strip is the first thing to give up its words when the bar is narrow: eight named tabs
          cannot share a few hundred pixels with the controls, and the icon still names the type. */}
      <span className='hidden @4xl:inline'>{formatKanbanViewName(view)}</span>
      {carriesState && (
        <>
          <span aria-hidden={true} className='size-1.5 shrink-0 rounded-full bg-[var(--accent)]' />
          <span className='sr-only'>{t('preview.kanban_view_carries_state')}</span>
        </>
      )}
    </button>
  )
}

function KanbanTabList({ views, activeViewId, panelId, onSelectView }: TabListProps) {
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([])
  const stripRef = useRef<HTMLDivElement>(null)
  useSelectedTabInView(stripRef, tabsRef, views.findIndex((v) => v.id === activeViewId))

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = rovingTabIndex(index, event.key, views.length)
    if (next === null) return
    event.preventDefault()
    onSelectView(views[next]!.id)
    tabsRef.current[next]?.focus()
  }

  return (
    <div
      ref={stripRef}
      // `relative` is load-bearing: the reveal reads the selected tab's `offsetLeft`, and without a
      // positioned strip that value is measured against whichever ancestor the browser picks instead —
      // in the full screen overlay a stage far to the tab's left, whose number made the reveal scroll
      // the first tab out of its own view (measured by the visual gate's tab check, 2026-09-24).
      className='relative flex min-w-0 items-center gap-[var(--sp-1)] overflow-x-auto'
      role='tablist'
      aria-label={t('preview.kanban_views')}
    >
      {views.map((view, index) => (
        <KanbanTab
          key={view.id}
          view={view}
          panelId={panelId}
          index={index}
          isActive={view.id === activeViewId}
          register={(node) => {
            tabsRef.current[index] = node
          }}
          onSelectView={onSelectView}
          onKeyDown={handleKeyDown}
        />
      ))}
    </div>
  )
}

export function KanbanViewTabs({
  views,
  activeViewId,
  panelId,
  onSelectView,
  viewOps,
}: {
  views: KanbanView[]
  activeViewId: string
  panelId: string
  onSelectView: (viewId: string) => void
  viewOps: KanbanViewOperations
}) {
  return (
    // The strip holds one row however many views a board has: it sits in the header's own flex row,
    // so wrapping would push the whole board down instead. `min-w-0` lets the list give way to the
    // header's other controls and scroll sideways instead, and `shrink-0` keeps a tab from being
    // squeezed below its own width by that scroll. The two management controls stay outside the
    // list — anything inside a tablist is announced as a tab.
    <div className='flex min-w-0 items-center gap-[var(--sp-1)]'>
      <KanbanTabList views={views} activeViewId={activeViewId} panelId={panelId} onSelectView={onSelectView} />
      <KanbanNewViewMenu onCreate={viewOps.createView} />
      <KanbanActiveViewMenu views={views} activeViewId={activeViewId} viewOps={viewOps} />
    </div>
  )
}
