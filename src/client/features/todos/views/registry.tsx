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
 * numbers the reader did not ask for.
 */
import type { ComponentType, ReactNode } from 'react'
import { CalendarDays, CheckCircle2, LayoutGrid, Star } from 'lucide-react'
import type { TaskCounts } from '@shared/todos/model'
import type { MessageKey } from '../../../lib/i18n'
import { useTodos, type TodoView } from '../store'
import { BoardView } from '../BoardView'
import { CompletedView, ListTaskView, PlanView, StarredView } from '../TaskViews'
import { ListsView } from '../ListsView'

/** What every glyph in this table accepts; lucide icons all match it. */
type Glyph = ComponentType<{ size?: number }>

interface NavPlacement {
  /** Lower comes first. Kept explicit so the sidebar's order can differ from the phone's. */
  order: number
  labelKey: MessageKey
  badge?: (counts: TaskCounts | null) => number
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

export const TODO_SURFACES: readonly TodoSurface[] = [
  {
    view: 'board',
    icon: LayoutGrid,
    sidebar: { order: 3, labelKey: 'todo.smart.all', badge: (counts) => counts?.all ?? 0 },
    phone: { order: 1, labelKey: 'todo.view.board' },
    render: ({ onOpenList }) => <BoardView onOpenList={onOpenList} />,
  },
  {
    view: 'starred',
    icon: Star,
    sidebar: { order: 1, labelKey: 'todo.view.starred', badge: (counts) => counts?.starred ?? 0 },
    phone: { order: 2, labelKey: 'todo.view.starred' },
    render: () => <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto"><StarredView /></div>,
  },
  {
    view: 'plan',
    icon: CalendarDays,
    sidebar: { order: 2, labelKey: 'todo.view.plan', badge: (counts) => counts?.today ?? 0 },
    // The one number a phone's nav carries: today's work is the reason the plan tab is pressed.
    phone: { order: 3, labelKey: 'todo.view.plan', badge: (counts) => counts?.today ?? 0 },
    render: () => <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto"><PlanView /></div>,
  },
  {
    view: 'completed',
    icon: CheckCircle2,
    sidebar: { order: 4, labelKey: 'todo.smart.completed', badge: (counts) => counts?.completed ?? 0 },
    phone: { order: 4, labelKey: 'todo.view.completed' },
    render: () => <CompletedView />,
  },
]

/** The badge a surface shows in one nav, or 0 for none. */
export function surfaceBadge(surface: TodoSurface, nav: 'sidebar' | 'phone', counts: TaskCounts | null): number {
  return (surface[nav]?.badge ?? NONE)(counts)
}

export function surfacesFor(nav: 'sidebar' | 'phone'): TodoSurface[] {
  return TODO_SURFACES
    .filter((surface) => surface[nav] !== undefined)
    .slice()
    .sort((left, right) => left[nav]!.order - right[nav]!.order)
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
