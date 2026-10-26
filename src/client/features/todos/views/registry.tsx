/**
 * What the to-do container draws for one address.
 *
 * The navigation table — order, glyph, badge, labels — is `views/nav`, and it is kept apart from this
 * file on purpose: the organizer page offers every other surface, and if the table lived here it would
 * have to import that page to be read, while that page imports the table to list what it can jump to.
 * This file is the half that is allowed to know what a screen looks like.
 */
import type { ReactNode } from 'react'
import { useTodos } from '../store'
import { BoardView } from '../BoardView'
import { CompletedView, ListTaskView, PlanView, StarredView, UpcomingView } from '../TaskViews'
import { TodayView } from '../TodayView'
import { CalendarView } from '../CalendarView'
import { ListsView } from '../ListsView'
import { StatsView } from '../StatsView'
import { FinishDayView } from '../FinishDayView'
import { CountersView } from '../CountersView'
import type { SurfaceRenderer } from './nav'
import type { TodoView } from '../store'

/** Every surface the nav table can name, with the component that draws it. */
const RENDERERS: Record<TodoView, SurfaceRenderer> = {
  today: () => <TodayView />,
  board: ({ onOpenList }) => <BoardView onOpenList={onOpenList} />,
  starred: () => <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto"><StarredView /></div>,
  plan: () => <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto"><PlanView /></div>,
  upcoming: () => <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto"><UpcomingView /></div>,
  calendar: () => <CalendarView />,
  completed: () => <CompletedView />,
  stats: () => <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto"><StatsView /></div>,
  'finish-day': () => <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto"><FinishDayView /></div>,
  counters: () => <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto"><CountersView /></div>,
  // A `list` or `tag` view is the task list filtered by the address's own id, which is why both fall
  // through to the same component; neither is a surface the nav table offers.
  list: () => <ListTaskView />,
  tag: () => <ListTaskView />,
}

/**
 * What the frame draws for one address.
 *
 * The lists page is not a surface: it is reached from the header and from the sidebar's own footer, it
 * has no tab of its own, and it is not a `TodoView`.
 */
export function TodoContent({ page, onOpen }: {
  page: 'main' | 'lists'
  onOpen: (target: { listId?: string; tagId?: string }) => void
}): ReactNode {
  const view = useTodos((state) => state.view)
  if (page === 'lists') return <ListsView onOpen={onOpen} />
  return RENDERERS[view]({ onOpenList: (listId) => onOpen({ listId }) })
}
