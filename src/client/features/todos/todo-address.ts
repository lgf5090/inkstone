/**
 * The grammar of the to-do address, and nothing else.
 *
 * The app's screen is its address: `/todo` for the board, `?view=plan` for a smart view, `?list=<id>`
 * or `?tag=<id>` for one collection, `&q=<text>` for a search on top of it, and `/todo/<task id>` for
 * the one task the panel is open on. Two shapes are deliberately *not* written: the board, because it is
 * what an empty address already means, and the view name beside a list or a tag, because the parameter
 * that names the collection already says which view is up. An address the app never writes is an address
 * nobody is reading, and a reader who types one anyway gets the board rather than a broken screen.
 *
 * Everything that reads or writes this address goes through here, so the store, the container and a link
 * pasted into a chat cannot drift into three spellings of the same screen.
 */
import { isTaskStatsBucket, TASK_SORTS, type TaskSort, type TaskStatsBucket } from '@shared/todos/model'
import { currentPathname, currentSearch, navigateToAddress, replaceAddress } from '../../lib/app-history'
import { BOARD_DIMENSIONS, type BoardDimension } from './task-groups'
import type { TodoView } from './store'

/** The app's own address, and the prefix every screen under it hangs off. */
export const TODO_PATH = '/todo'

/** The arrangement a list's own screen can be read in: the plain list, or one column per group. */
export type TodoLayout = 'list' | 'columns'

/** The field one column of that arrangement stands for. */
export type TodoGroup = BoardDimension

/**
 * Whether an address is one of the to-do app's screens.
 *
 * The container says this about itself because it is the only thing that knows the shape: the host asks it
 * before falling back to the table of tab paths, so `/todo/<task id>` is the to-do app rather than whatever
 * an unrecognised address answers with.
 */
export function isTodoPath(pathname: string): boolean {
  return pathname === TODO_PATH || (pathname.startsWith(`${TODO_PATH}/`) && pathname.slice(TODO_PATH.length + 1).replace(/\/$/, '') !== '')
}

/**
 * The prefix a notification carries before a task id.
 *
 * A notice names its subject as `<app>:<id>` rather than as an address, and the client is the only thing that
 * knows what an `app` means: `todo:` is read here, in the app that owns the tasks, and the writer that stored
 * the string never decided where it would be opened.
 */
export const TODO_TASK_LINK_PREFIX = 'todo:'

/**
 * The task a stored pointer names, or null for a notice that points elsewhere or nowhere.
 *
 * The id has to be the whole rest of the string and nothing but an id: a link that carries a slash, a query,
 * a scheme or an empty tail is not this app's shape, and reading it anyway would mean opening whatever the
 * writer chose rather than the task the reader was told about. Callers treat null as "no destination" — the
 * notice stays a message — rather than as a failure to report.
 */
export function taskIdFromNotificationLink(link: string | null | undefined): string | null {
  if (!link || !link.startsWith(TODO_TASK_LINK_PREFIX)) return null
  const id = link.slice(TODO_TASK_LINK_PREFIX.length)
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null
}

/** The views the container draws, which is what a `view=` parameter can name. */
export const TODO_VIEWS: readonly TodoView[] = ['board', 'today', 'plan', 'upcoming', 'calendar', 'starred', 'completed', 'list', 'tag', 'stats']

/** The orders a `sort=` parameter may name, which are the ones the route reads. */
export const TODO_SORTS: readonly TaskSort[] = TASK_SORTS

/** The dimensions a `group=` parameter may name, which are the ones the column board draws. */
export const TODO_GROUPS: readonly TodoGroup[] = BOARD_DIMENSIONS

/** The part of the screen the query carries. */
export interface TodoViewSelection {
  view: TodoView
  listId: string | null
  tagId: string | null
  query: string
  /** The order the reader picked, or null for the one the server uses for the view on screen. */
  sort: TaskSort | null
  /** The first local instant a task may be due at, in the same shape the route reads. */
  dueFrom: string | null
  /** The first local instant a task must be due before; the bound is exclusive, as on the route. */
  dueTo: string | null
  /**
   * The completion window the finished view is read through, as account-zone days. The route accepts
   * these on `view=completed` alone, which is also the only view this address writes them for.
   */
  completedFrom?: string | null
  completedTo?: string | null
  /**
   * The statistics range, in the account-zone days the stats route reads. Only the stats view writes
   * these, and they are optional so every older selection shape keeps naming the same screen.
   */
  statsFrom?: string | null
  statsTo?: string | null
  statsBucket?: TaskStatsBucket | null
  /**
   * The list screen's arrangement. Optional because the store's selection describes the view, not
   * the arrangement: an address writer carries the current layout over when a caller does not name
   * one, and only a named list has a layout to write at all.
   */
  layout?: TodoLayout | null
  /**
   * The field a column of that arrangement stands for, read with the layout it belongs to. Optional
   * for the same reason: `status` is what the columns mean without being told, so an address writer
   * carries the dimension across and only the columns have one to carry.
   */
  group?: TodoGroup | null
}

/** A due bound the address can mean: a local calendar day, or that day at a wall-clock minute. */
const LOCAL_BOUND = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/

/** A statistics bound: a calendar day, which is the only shape the stats route accepts. */
const STATS_DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * A due bound a pasted address names, or null for one this app never writes.
 *
 * The screen writes only local wall time, so a value of any other shape is somebody else's parameter
 * rather than a filter this app can honour; the board is a better answer than a 400 on a cold load.
 */
function dueBound(value: string | null): string | null {
  return value && LOCAL_BOUND.test(value) ? value : null
}

/** A completion bound: one calendar day, the only shape the route accepts for a completion window. */
function completionDay(value: string | null): string | null {
  return value && STATS_DAY.test(value) ? value : null
}

/**
 * The arrangement a query names for the list screen.
 *
 * The plain list is what an address without the parameter already means, so it is the answer for
 * every other value as well: a pasted `layout=nonsense` opens the list rather than a broken screen.
 */
export function todoLayoutFromSearch(search: string): TodoLayout {
  return searchParamsOf(search).get('layout') === 'columns' ? 'columns' : 'list'
}

/** The query parameters of a search, with or without its leading `?`. */
function searchParamsOf(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
}

/**
 * The dimension a `group=` value names, or the status columns for anything else.
 *
 * Status is what the board has always meant, so it is the fallback rather than a failure: a pasted
 * `group=nonsense` cuts the columns the way they were cut before the switch existed.
 */
function groupParam(value: string | null): TodoGroup {
  return TODO_GROUPS.includes(value as TodoGroup) ? (value as TodoGroup) : 'status'
}

/**
 * The dimension a query names for the columns on screen.
 *
 * Read apart from the layout, because a caller that has the columns up only wants to know what one
 * column stands for; a query that never asked for columns answers with the default all the same.
 */
export function todoGroupFromSearch(search: string): TodoGroup {
  return groupParam(searchParamsOf(search).get('group'))
}

/** The whole screen, as the address states it: which view, and which task is open on it. */
export interface TodoAddress extends TodoViewSelection {
  /** The task the path names, or null when the address names no single task. */
  taskId: string | null
}

/** The address of one task's own screen. */
export function todoPathForTask(id: string): string {
  return `${TODO_PATH}/${encodeURIComponent(id)}`
}

/** The task a pathname names, or null: anything below `/todo` that is not one path segment names nothing. */
function taskIdFromPathname(pathname: string): string | null {
  if (!pathname.startsWith(`${TODO_PATH}/`)) return null
  const rest = pathname.slice(TODO_PATH.length + 1).replace(/\/$/, '')
  if (!rest || rest.includes('/')) return null
  try {
    return decodeURIComponent(rest)
  } catch {
    // A percent-escape the browser cannot read is not a task id, and the board is a better answer than
    // an exception on the way to it.
    return null
  }
}

/** The state a pathname and a query name. Unrecognisable parts fall back rather than fail. */
export function parseTodoAddress(pathname: string, search: string): TodoAddress {
  if (pathname !== TODO_PATH && !pathname.startsWith(`${TODO_PATH}/`)) {
    return {
      view: 'board', listId: null, tagId: null, query: '', sort: null, dueFrom: null, dueTo: null,
      completedFrom: null, completedTo: null, statsFrom: null, statsTo: null, statsBucket: null,
      layout: null, group: null, taskId: null,
    }
  }
  const params = searchParamsOf(search)
  const listId = params.get('list')
  const tagId = params.get('tag')
  const named = params.get('view')
  const query = params.get('q') ?? ''
  const namedSort = params.get('sort')
  const sort = namedSort && (TODO_SORTS as readonly string[]).includes(namedSort) ? (namedSort as TaskSort) : null
  const layout: TodoLayout | null = params.get('layout') === 'columns' ? 'columns' : null
  // The dimension is only ever an answer while the columns are up; the plain list has nothing to cut.
  const group: TodoGroup | null = layout ? groupParam(params.get('group')) : null
  const dueFrom = dueBound(params.get('dueFrom'))
  const dueTo = dueBound(params.get('dueTo'))
  // A completion window belongs to the finished view; the other views are not narrowed by one, and a
  // pasted address that pairs them is the view its own parameters name.
  const completedFrom = named === 'completed' ? completionDay(params.get('completedFrom')) : null
  const completedTo = named === 'completed' ? completionDay(params.get('completedTo')) : null
  const rawFrom = params.get('from')
  const rawTo = params.get('to')
  const statsFrom = rawFrom && STATS_DAY.test(rawFrom) ? rawFrom : null
  const statsTo = rawTo && STATS_DAY.test(rawTo) ? rawTo : null
  const rawBucket = params.get('bucket')
  const statsBucket = isTaskStatsBucket(rawBucket) ? rawBucket : null
  const common = {
    query, sort, dueFrom, dueTo, completedFrom, completedTo,
    statsFrom, statsTo, statsBucket,
    layout: null as TodoLayout | null, group: null as TodoGroup | null,
    taskId: taskIdFromPathname(pathname),
  }
  // The completed view is the one screen a `list=` narrows rather than renames: there is no
  // completed list view to confuse it with, and the dropdown there scopes finished work to one
  // collection. Everywhere else the collection still names its own view and wins.
  if (named === 'completed') return { ...common, view: 'completed', listId, tagId: null }
  // A collection names its own view, and it wins over a `view=` left beside it: the two spellings of the
  // same screen have to have one reading, and the narrower one is the one a reader can paste.
  if (listId) return { ...common, view: 'list', listId, tagId: null, layout, group }
  if (tagId) return { ...common, view: 'tag', listId: null, tagId }
  const view: TodoView = TODO_VIEWS.includes(named as TodoView) ? (named as TodoView) : 'board'
  return { ...common, view, listId: null, tagId: null }
}

/** The query for one view state, in the one spelling this app writes. */
export function writeTodoSearch(selection: TodoViewSelection): string {
  const params = new URLSearchParams()
  if (selection.view === 'list') {
    if (selection.listId) params.set('list', selection.listId)
    // The plain list is what an address without the parameter already means, so only the split is
    // written, and only beside the list it belongs to.
    if (selection.listId && selection.layout === 'columns') {
      params.set('layout', 'columns')
      // Status is what the columns mean when the address says nothing, so only another dimension is
      // written — the same rule that keeps the plain list out of an address that means it.
      if (selection.group && selection.group !== 'status') params.set('group', selection.group)
    }
  } else if (selection.view === 'tag') {
    if (selection.tagId) params.set('tag', selection.tagId)
  } else if (selection.view === 'completed') {
    params.set('view', 'completed')
    if (selection.listId) params.set('list', selection.listId)
    // The year control is a half-open day window on when each task was finished. It is written only
    // beside `view=completed`, because that is the only listing the route applies it to.
    if (selection.completedFrom) params.set('completedFrom', selection.completedFrom)
    if (selection.completedTo) params.set('completedTo', selection.completedTo)
  } else if (selection.view !== 'board') {
    params.set('view', selection.view)
  }
  if (selection.sort) params.set('sort', selection.sort)
  if (selection.dueFrom) params.set('dueFrom', selection.dueFrom)
  if (selection.dueTo) params.set('dueTo', selection.dueTo)
  if (selection.view === 'stats') {
    if (selection.statsFrom && selection.statsTo) {
      params.set('from', selection.statsFrom)
      params.set('to', selection.statsTo)
    }
    if (selection.statsBucket) params.set('bucket', selection.statsBucket)
  }
  if (selection.query) params.set('q', selection.query)
  return params.toString()
}

/** The screen the address bar is standing on right now. */
export function readTodoAddress(): TodoAddress {
  // The store reads this once when it is created, which in a build without a window — none today, and
  // one guard rather than a crash if that changes — means the board.
  if (typeof window === 'undefined') {
    return {
      view: 'board', listId: null, tagId: null, query: '', sort: null, dueFrom: null, dueTo: null,
      completedFrom: null, completedTo: null, statsFrom: null, statsTo: null, statsBucket: null,
      layout: null, group: null, taskId: null,
    }
  }
  return parseTodoAddress(currentPathname(), currentSearch())
}

/** The path the address is standing on, keeping a task's own screen if one is open. */
function currentTaskPath(taskId: string | null): string {
  return taskId ? todoPathForTask(taskId) : TODO_PATH
}

/**
 * The arrangement a write keeps when its caller did not name one.
 *
 * The store's selection describes which view is up, not how a list screen is arranged, so a search,
 * a sort or opening a task rewrites the address without a layout or a dimension. Dropping them there
 * would take the reader back to the plain list — or to the status columns — on the next keystroke;
 * only a list has an arrangement to carry, and an explicit null is the reader choosing the plain list
 * rather than the writer not knowing.
 */
function withCarriedArrangement(selection: TodoViewSelection): TodoViewSelection {
  if (selection.view !== 'list' || selection.layout !== undefined) return selection
  const current = readTodoAddress()
  return { ...selection, layout: current.layout ?? null, group: current.group ?? null }
}

/**
 * Put a view state into the address as a deliberate move.
 *
 * The task part of the path is carried over rather than cleared: switching from the plan to a list while
 * a panel is open leaves that panel's address standing, which is what the back button then goes back to.
 */
export function pushTodoAddress(selection: TodoViewSelection): void {
  navigateToAddress(currentTaskPath(readTodoAddress().taskId), writeTodoSearch(withCarriedArrangement(selection)))
}

/** The same screen, without another back button — the one for state that moves while the reader types. */
export function replaceTodoAddress(selection: TodoViewSelection): void {
  replaceAddress(currentTaskPath(readTodoAddress().taskId), writeTodoSearch(withCarriedArrangement(selection)))
}

/** Take one task's screen into the address, with the view the reader was on still named. */
export function pushTodoTaskAddress(taskId: string, selection: TodoViewSelection): void {
  navigateToAddress(todoPathForTask(taskId), writeTodoSearch(withCarriedArrangement(selection)))
}

/** Drop the task from the address, leaving the view it was open over. */
export function replaceTodoTaskAddress(selection: TodoViewSelection): void {
  replaceAddress(TODO_PATH, writeTodoSearch(withCarriedArrangement(selection)))
}

/**
 * The address as a view selection, arrangement left out.
 *
 * The two switches below answer for one part of the arrangement each and carry the rest of the screen
 * untouched; naming the whole selection twice would be two lists of the same fields to keep in step.
 */
function selectionOf(current: TodoAddress): TodoViewSelection {
  return {
    view: current.view, listId: current.listId, tagId: current.tagId, query: current.query,
    sort: current.sort, dueFrom: current.dueFrom, dueTo: current.dueTo,
    completedFrom: current.completedFrom, completedTo: current.completedTo,
    statsFrom: current.statsFrom, statsTo: current.statsTo, statsBucket: current.statsBucket,
  }
}

/**
 * Choose the arrangement of the list screen on show.
 *
 * The arrangement is the address's, like the view and the filters: a reload or a pasted link opens the
 * same screen. A deliberate choice earns its own history entry, the way opening another view does; a
 * choice that is already up writes nothing. The dimension travels with it, so back to the plain list
 * drops the reading that has nothing left to cut.
 */
export function setTodoLayout(layout: TodoLayout): void {
  const current = readTodoAddress()
  const next = layout === 'columns' ? 'columns' : null
  if ((current.layout ?? null) === next) return
  pushTodoAddress({
    ...selectionOf(current),
    layout: next,
    group: next ? (current.group ?? 'status') : null,
  })
}

/**
 * Choose the field one column of the board stands for.
 *
 * The question is only ever asked while the columns are up, so the layout is written along with it: a
 * dimension beside the plain list would be a switch that changed nothing on the screen it stands on.
 */
export function setTodoGroup(group: TodoGroup): void {
  const current = readTodoAddress()
  if ((current.group ?? 'status') === group) return
  pushTodoAddress({ ...selectionOf(current), layout: current.layout ?? 'columns', group })
}
