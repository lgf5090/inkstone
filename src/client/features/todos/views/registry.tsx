/**
 * The surfaces the to-do container can show, and the two navs that reach them.
 *
 * Everything that differs per view — its content, its glyph, the badge, and the words each nav uses —
 * lives in one entry here. The container keeps the frame (header, sidebar, phone tabs, keyboard) and asks
 * this table what to draw, so adding a calendar or a stats page is one entry and one component rather
 * than edits in the header, the sidebar, the phone bar and the content switch at once.
 *
 * The two navs are deliberately not the same list: a phone shows the board first because it is the only
 * way back home from an aggregate view, while the sidebar labels the board "All" and puts the starred
 * list above it. Each surface therefore names its own label per nav, and one that only earns a badge on
 * the phone (`plan`, whose count is today's work) says so — a badge on every sidebar row would be three
 * numbers the reader did not ask for. Since "My Day" arrived, the sidebar's today badge is the one
 * number for both "picked for today" and "due by today", and the plan row beside it carries none: its
 * page holds the whole open set, not one day's. The upcoming row does carry one, because the server
 * counts that horizon through the same filter the row opens.
 */
import type { ComponentType, ReactNode } from 'react'
import { CalendarClock, CalendarDays, CalendarRange, ChartNoAxesColumn, CheckCircle2, Flame, LayoutGrid, Star, Sun, Sunset } from 'lucide-react'
import type { TaskCounts } from '@shared/todos/model'
import type { MessageKey } from '../../../lib/i18n'
import { useTodos, type TodoView } from '../store'
import { BoardView } from '../BoardView'
import { CompletedView, ListTaskView, PlanView, StarredView, UpcomingView } from '../TaskViews'
import { TodayView } from '../TodayView'
import { CalendarView } from '../CalendarView'
import { ListsView } from '../ListsView'
import { StatsView } from '../StatsView'
import { FinishDayView } from '../FinishDayView'
import { CountersView } from '../CountersView'

/** What every glyph in this table accepts; lucide icons all match it. */
type Glyph = ComponentType<{ size?: number }>

interface NavPlacement {
  /** Lower comes first. Kept explicit so the sidebar's order can differ from the phone's. */
  order: number
  labelKey: MessageKey
  badge?: (counts: TaskCounts | null) => number
  /**
   * Whether the account has this row switched on.
   *
   * A row that is not offered is a row the sidebar does not draw — it is not a screen that stops
   * existing, and the address still reaches it. Switching the end-of-day page off in settings should
   * quiet the app's offer of it, not lock a reader out of a page they typed in or bookmarked.
   */
  requires?: (flags: TodoNavFlags) => boolean
}

/** The settings a nav row's presence can depend on, as the frame reads them. */
export interface TodoNavFlags {
  finishDayEnabled: boolean
}

export interface TodoSurface {
  view: TodoView
  icon: Glyph
  /** Absent means the surface is not reachable from that nav. */
  sidebar?: NavPlacement
  phone?: NavPlacement
  render: (props: { onOpenList: (listId: string) => void }) => ReactNode
}

const NONE = (): number => 0
const OFFERED = (): boolean => true

export const TODO_SURFACES: readonly TodoSurface[] = [
  {
    view: 'today',
    icon: Sun,
    // The one row that answers "what am I doing today": the badge counts the page it opens.
    sidebar: { order: 1, labelKey: 'todo.view.today', badge: (counts) => counts?.today ?? 0 },
    render: () => <TodayView />,
  },
  {
    view: 'board',
    icon: LayoutGrid,
    sidebar: { order: 6, labelKey: 'todo.smart.all', badge: (counts) => counts?.all ?? 0 },
    phone: { order: 1, labelKey: 'todo.view.board' },
    render: ({ onOpenList }) => <BoardView onOpenList={onOpenList} />,
  },
  {
    view: 'starred',
    icon: Star,
    sidebar: { order: 2, labelKey: 'todo.view.starred', badge: (counts) => counts?.starred ?? 0 },
    phone: { order: 2, labelKey: 'todo.view.starred' },
    render: () => <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto"><StarredView /></div>,
  },
  {
    view: 'plan',
    icon: CalendarDays,
    sidebar: { order: 3, labelKey: 'todo.view.plan' },
    // The one number a phone's nav carries: today's work is the reason the plan tab is pressed.
    phone: { order: 3, labelKey: 'todo.view.plan', badge: (counts) => counts?.today ?? 0 },
    render: () => <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto"><PlanView /></div>,
  },
  {
    view: 'upcoming',
    icon: CalendarClock,
    // The horizon between today and the rest: the server counts it through the same filter the page
    // reads, so the number on the row is the number behind it. A phone leaves it out — four tabs are
    // what a thumb can reach, and the plan row above divides the same week among its own headings.
    sidebar: { order: 4, labelKey: 'todo.view.upcoming', badge: (counts) => counts?.upcoming ?? 0 },
    render: () => <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto"><UpcomingView /></div>,
  },
  {
    view: 'calendar',
    icon: CalendarRange,
    // A calendar is read on a wide window; a phone reaches it from the header instead of a fifth tab.
    sidebar: { order: 5, labelKey: 'todo.view.calendar' },
    render: () => <CalendarView />,
  },
  {
    view: 'completed',
    icon: CheckCircle2,
    sidebar: { order: 7, labelKey: 'todo.smart.completed', badge: (counts) => counts?.completed ?? 0 },
    phone: { order: 4, labelKey: 'todo.view.completed' },
    render: () => <CompletedView />,
  },
  {
    view: 'stats',
    icon: ChartNoAxesColumn,
    // A wide window has room for a row beyond the phone's four tabs. A phone's bottom bar does not:
    // four tabs are what a thumb can reach, so the phone reaches this screen from the header instead.
    sidebar: { order: 8, labelKey: 'todo.view.stats' },
    render: () => <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto"><StatsView /></div>,
  },
  {
    view: 'finish-day',
    icon: Sunset,
    // The close-out is a ritual rather than a place to browse, so it gets the sidebar's last row and no
    // phone tab — and the row only appears while the account has asked to be offered the page.
    sidebar: {
      order: 9,
      labelKey: 'todo.view.finish_day',
      requires: (flags) => flags.finishDayEnabled,
    },
    render: () => <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto"><FinishDayView /></div>,
  },
  {
    view: 'counters',
    icon: Flame,
    // Habits are browsed rather than reached on the way home, so the sidebar carries the row and the
    // phone's four tabs do not — the same placement the statistics and the close-out accepted.
    sidebar: { order: 10, labelKey: 'todo.view.counters' },
    render: () => <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto"><CountersView /></div>,
  },
]

/** The badge a surface shows in one nav, or 0 for none. */
export function surfaceBadge(surface: TodoSurface, nav: 'sidebar' | 'phone', counts: TaskCounts | null): number {
  return (surface[nav]?.badge ?? NONE)(counts)
}

/**
 * The rows one nav draws, in its own order, with the ones the account has switched off left out.
 *
 * The flags come from the frame rather than from a store read inside here: a nav that went and looked at
 * settings on its own would not redraw when the reader switched the page back on.
 */
export function surfacesFor(nav: 'sidebar' | 'phone', flags: TodoNavFlags): TodoSurface[] {
  return TODO_SURFACES
    .filter((surface) => surface[nav] !== undefined)
    .slice()
    .sort((left, right) => left[nav]!.order - right[nav]!.order)
    .filter((surface) => (surface[nav]!.requires ?? OFFERED)(flags))
}

/**
 * The rows the phone's overflow menu offers.
 *
 * A surface the sidebar carries and the phone's four tabs do not still has to come from somewhere on a
 * phone, so the table answers that question rather than the header keeping its own list: a screen that
 * earns a sidebar row cannot then ship without a way in on the other layout. The calendar is the one
 * surface left out by hand, because its header glyph is the way in — the phone reaches a calendar from
 * wherever it is standing, more often than it reaches the screens below it.
 */
export function surfacesForPhoneMore(flags: TodoNavFlags): TodoSurface[] {
  return surfacesFor('sidebar', flags).filter((surface) => surface.phone === undefined && surface.view !== 'calendar')
}

/**
 * What the frame draws for one address.
 *
 * The lists page is not a surface: it is reached from the header and from the sidebar's own footer, it
 * has no tab of its own, and it is not a `TodoView`. A `list` or `tag` view is the task list filtered by
 * the address's own id, which is why both fall through to the same component.
 */
export function TodoContent({ page, onOpen }: {
  page: 'main' | 'lists'
  onOpen: (target: { listId?: string; tagId?: string }) => void
}): ReactNode {
  const view = useTodos((state) => state.view)
  if (page === 'lists') return <ListsView onOpen={onOpen} />
  const surface = TODO_SURFACES.find((entry) => entry.view === view)
  return surface ? surface.render({ onOpenList: (listId) => onOpen({ listId }) }) : <ListTaskView />
}
