/**
 * The to-do app's state, and the only place it is written.
 *
 * Three rules shape it. Which tasks belong on screen is a question for the server and not for the
 * browser: the view, the list, the tag, the search text and the offset go out as query parameters, and the
 * store keeps one page of the answer plus the count of what the same filter matches — a page cannot be
 * filtered into news about the rows it never received. A write replaces the row with what the server
 * returned rather than patching a guess, so a repeat that rolled forward or a due date the server re-read
 * shows up as it actually is. And the counts are re-read after a write instead of being adjusted by hand:
 * they are a timezone-aware aggregate, and a second implementation in the browser is a second answer
 * waiting to be wrong.
 *
 * A fourth governs the view: which view is up, what it is filtered to, what is being searched for and
 * which task the panel is open on are the address bar's, not the store's private business. The store
 * reads the address when it is created, writes it back through `todo-address.ts` when the reader moves,
 * and follows it when the browser moves on its own — so a reload, a back button and an address pasted
 * into a chat all say the same thing about the screen they name.
 */

import { create } from 'zustand'
import { api, type TaskListEntry } from '../../lib/api'
import { t } from '../../lib/i18n'
import { subscribeToAddress } from '../../lib/app-history'
import { useUi } from '../../store/ui'
import { parseQuickAdd } from '@shared/todos/quick-parse'
import type { MessageKey } from '@shared/locales/en-US'
import {
  toggledStatus,
  type RemindOffset,
  type SnoozeMinutes,
  type TaskBatchOp,
  type TaskBatchResult,
  type TaskCounts,
  type TaskList,
  type TaskSort,
  type TaskStatsBucket,
  type TaskStep,
  type TaskTag,
  type TodoStats,
  type TodoTask,
} from '@shared/todos/model'
import {
  pushTodoAddress,
  pushTodoTaskAddress,
  readTodoAddress,
  replaceTodoAddress,
  replaceTodoTaskAddress,
  type TodoViewSelection,
} from './todo-address'

export type TodoView = 'board' | 'today' | 'plan' | 'calendar' | 'starred' | 'completed' | 'list' | 'tag' | 'stats'

/** The list shape this feature reads, re-exported so its screens do not reach the API module. */
export type { TaskListEntry } from '../../lib/api'

/** One step back: what the toast calls it, and the inverse writes that take it. */
export interface TodoUndoEntry {
  label: string
  undo: () => Promise<void>
}

/** What the editor is open on: an existing task, or a draft for a new one. */
export interface TaskDraft {
  id?: string
  title?: string
  description?: string
  listId?: string | null
  /** An instant, or a local `YYYY-MM-DD[THH:MM]` the server reads in the reader's timezone. */
  dueAt?: number | string | null
  priority?: TodoTask['priority']
  starred?: boolean
  tags?: string[]
  repeat?: TodoTask['repeat']
  /** The task's pending reminders as absolute instants; what the task endpoints accept. */
  reminders?: number[]
  /** One reminder from a quick-add line, as the instant the parser computed. */
  remindAt?: number | null
  /** The quick-add offset; the API client converts it to `reminders` at the network boundary. */
  remind?: RemindOffset
  conversationId?: string | null
  noteId?: string | null
  steps?: string[]
}

interface TodosState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  tasks: TodoTask[]
  /** How many tasks the filter on screen matches, whether or not this page holds all of them. */
  total: number
  completed: TodoTask[]
  /** The same count for the finished page, which is the rows the completed view pages through. */
  completedTotal: number
  loadingMore: boolean
  lists: TaskListEntry[]
  /** The put-away lists, read only when the archive shelf is opened. */
  archivedLists: TaskListEntry[]
  tags: TaskTag[]
  counts: TaskCounts | null
  dayEnd: number
  timezone: string

  view: TodoView
  listId: string | null
  tagId: string | null
  query: string
  /** The order the reader picked; null leaves it to the server, which decides it per view. */
  sort: TaskSort | null
  /** Due bounds in local wall time, as `todo-address.ts` carries them. Both null is "any due date". */
  dueFrom: string | null
  dueTo: string | null
  /** The completion window of the finished view, as account-zone days; the upper bound is exclusive. */
  completedFrom: string | null
  completedTo: string | null

  /** The statistics screen's last answer, and the range the address currently names. */
  stats: TodoStats | null
  statsStatus: 'idle' | 'loading' | 'ready' | 'error'
  statsError: string | null
  statsFrom: string | null
  statsTo: string | null
  statsBucket: TaskStatsBucket | null

  selectedId: string | null
  /**
   * The rows picked for a batch write.
   *
   * Separate from `selectedId`, which is the one task the editor is open on: a reader can be editing
   * one task and have a selection of others, and a selection must not change what the panel shows.
   * An empty set is not selection mode.
   */
  selectedIds: Set<string>
  editorOpen: boolean
  draft: TaskDraft | null
  saving: boolean
  /** The single step the toast is offering, if any. A new write replaces it rather than queuing. */
  undo: TodoUndoEntry | null

  load: () => Promise<void>
  loadMore: () => Promise<void>
  refreshCounts: () => Promise<void>
  /** Take the offered step back; a no-op when nothing is offered or the toast has gone. */
  undoLast: () => Promise<void>

  setView: (view: TodoView, target?: { listId?: string; tagId?: string }) => void
  setQuery: (query: string) => void
  /** The order the listing is read in; the address carries it and the server applies it. */
  setSort: (sort: TaskSort | null) => void
  /** A due window in local wall time; both bounds null is the range cleared back to "any date". */
  setDueRange: (range: { from: string | null; to: string | null }) => void
  /** The finished view's completion window, as account-zone days; `from` is included, `to` is not. */
  setCompletedRange: (range: { from: string | null; to: string | null }) => void
  /** Read the statistics for the range the store and the address now name. */
  loadStats: () => Promise<void>
  /** Move the statistics to another range, writing the move into the address and asking again. */
  setStatsRange: (range: { from: string; to: string; bucket: TaskStatsBucket }) => void
  /** Put the store where the address bar says the screen is — what a back button asks of it. */
  syncFromAddress: () => void
  select: (id: string | null) => void
  /** Add or remove one row from the batch selection; selection mode is "at least one row". */
  toggleSelected: (id: string) => void
  /** Leave selection mode; the bar disappears with the last row. */
  clearSelection: () => void
  openEditor: (draft: TaskDraft) => void
  closeEditor: () => void
  openTask: (id: string) => Promise<void>

  createTask: (input: TaskDraft) => Promise<TodoTask | null>
  /**
   * Save a patch, naming the revision the row was read at.
   *
   * `rev` is optional so an undo or a caller holding only an id can still write; when it is left out the
   * store sends the revision of the row on screen. A 409 is not a failure line: it opens the conflict
   * choice below.
   */
  updateTask: (id: string, patch: Record<string, unknown>, rev?: number) => Promise<TodoTask | null>
  toggleTask: (task: TodoTask) => Promise<void>
  removeTask: (id: string) => Promise<boolean>
  /** Put a trashed task back by id and re-read the listing; answers whether the server took it. */
  restoreTask: (id: string) => Promise<boolean>
  /**
   * Apply one change to every selected row and re-read the listing.
   *
   * Answers with the server's own done/failed split so a caller can say what happened to each half; a
   * partial answer is surfaced rather than hidden. A delete offers one undo that restores every id it
   * removed, because the rail holds one step and a batch is one step.
   */
  batchTasks: (op: TaskBatchOp, value?: string | string[] | null) => Promise<TaskBatchResult | null>
  /** Pick a task into an account-zone day, or clear the pick with `null`; re-reads the listing after. */
  planTask: (id: string, date: string | null) => Promise<TodoTask | null>
  /** Append one reminder `minutes` from now; the task's existing reminders stay. */
  snoozeTask: (id: string, minutes: SnoozeMinutes) => Promise<TodoTask | null>
  /** Open tasks matching a title search, for the today screen's picker. Errors are reported, not thrown. */
  searchTasks: (query: string) => Promise<TodoTask[]>

  createList: (input: { name: string; icon?: string | null; color?: string | null }) => Promise<TaskListEntry | null>
  updateList: (id: string, patch: { name?: string; icon?: string | null; color?: string | null; archived?: boolean; parentId?: string | null }) => Promise<TaskListEntry | null>
  removeList: (id: string) => Promise<void>
  /** Read the archive shelf; called when the reader opens it, not on every page load. */
  loadArchivedLists: () => Promise<void>

  createTag: (input: { name: string; color?: string | null }) => Promise<TaskTag | null>
  updateTag: (id: string, patch: { name?: string; color?: string | null }) => Promise<TaskTag | null>
  removeTag: (id: string) => Promise<void>

  reloadSteps: (taskId: string) => Promise<void>
  addStep: (taskId: string, text: string) => Promise<TaskStep | null>
  updateStep: (taskId: string, stepId: string, patch: { text?: string; done?: boolean }) => Promise<void>
  removeStep: (taskId: string, stepId: string) => Promise<void>
}

function toastError(error: unknown): void {
  useUi.getState().toast({
    title: t('todo.toast.failed'),
    description: error instanceof Error ? error.message : String(error),
    tone: 'danger',
  })
}

/** Whether a failed write was refused because the row moved: the 409 every task conflict carries. */
function isRevisionConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 409
}

/**
 * What a 409 offers, and what each answer does.
 *
 * The server row is read before the choice is put up, so "use the server version" adopts what really
 * stands rather than a guess. "Retry my change" sends the same patch again against the revision the
 * server reported: a retry, not a merge. Until the reader answers, the store keeps the row it had —
 * the refused value was never painted, and showing it would claim a save that did not happen.
 *
 * The dialog is the app's own `confirm`; when no host is mounted it answers with the cancelling side,
 * which here is the safe one — the row the server holds.
 */
async function resolveRevisionConflict(
  id: string,
  patch: Record<string, unknown>,
  set: (partial: Partial<TodosState> | ((state: TodosState) => Partial<TodosState>)) => void,
  get: () => TodosState,
): Promise<void> {
  let server: TodoTask
  try {
    server = (await api.todos.get(id)).task
  } catch (error) {
    toastError(error)
    return
  }
  // Loaded on the failure path rather than imported at the top: the chat's task chips reach this store
  // too, and they need no dialog — pulling the whole overlay surface (and the editor stylesheet behind
  // it) into every such entry point is a cost paid by everyone for a prompt almost nobody sees.
  const { confirm } = await import('../../components/overlay')
  const retry = await confirm({
    title: t('todo.conflict.title'),
    description: t('todo.conflict.description'),
    confirmLabel: t('todo.conflict.retry'),
    cancelLabel: t('todo.conflict.use_server'),
  })
  if (retry) {
    await get().updateTask(id, patch, server.rev)
    return
  }
  // The server's row replaces whichever bucket held the old one; a row that finished elsewhere moves
  // to the finished page rather than staying on the open board.
  set((state) => ({
    tasks: server.status === 'done'
      ? state.tasks.filter((entry) => entry.id !== id)
      : [...state.tasks.filter((entry) => entry.id !== id), server],
    completed: server.status === 'done'
      ? [server, ...state.completed.filter((entry) => entry.id !== id)]
      : state.completed.filter((entry) => entry.id !== id),
  }))
}

/**
 * How long a step stays reachable, in milliseconds.
 *
 * The toast is the clock, so the store keeps no second one: the step is only taken while the toast
 * that offers it is still on the rail. A dismissed or expired toast therefore closes the window in
 * both places at once, and hovering — which pauses the toast — pauses the undo with it.
 */
const UNDO_WINDOW_MS = 6000

/** The toast currently offering the step; a new write dismisses it rather than stacking a second. */
let undoToastId: string | null = null
/** Guards inverse writes: an undo that recorded an undo would offer a redo of the undo. */
let undoing = false

/** Puts the one step back on the toast rail, replacing whatever step was offered before. */
function offerUndo(
  set: (partial: Partial<TodosState>) => void,
  get: () => TodosState,
  label: string,
  undo: () => Promise<void>,
): void {
  const ui = useUi.getState()
  if (undoToastId) ui.dismissToast(undoToastId)
  set({ undo: { label, undo } })
  undoToastId = ui.toast({
    title: label,
    action: { label: t('todo.action.undo'), run: () => { void get().undoLast() } },
    duration: UNDO_WINDOW_MS,
  })
}

/** The list a typed name points at, or null. A name that matches nothing is not a list to create. */
export function listNamed(lists: readonly TaskList[], name: string): TaskList | null {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return null
  return lists.find((list) => list.name.trim().toLowerCase() === wanted) ?? null
}

/** The organizer order — position, then name — which is the order the route reads them in. */
function sortLists(entries: TaskListEntry[]): TaskListEntry[] {
  return [...entries].sort((left, right) =>
    left.position - right.position || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
}

const SNOOZE_KEYS: Record<SnoozeMinutes, MessageKey> = {
  10: 'todo.snooze.10m',
  60: 'todo.snooze.1h',
  540: 'todo.snooze.tonight',
  1440: 'todo.snooze.tomorrow',
}

/** What a landed batch announces, per operation. The count is always the server's `done` length. */
const BATCH_TOAST_KEYS: Record<TaskBatchOp, MessageKey> = {
  complete: 'todo.toast.batch_completed',
  delete: 'todo.toast.batch_deleted',
  move: 'todo.toast.batch_moved',
  priority: 'todo.toast.batch_priority',
  star: 'todo.toast.batch_starred',
  tag: 'todo.toast.batch_tagged',
}

/** What one snooze duration reads as, shared by the card menu and the notification row. */
export function snoozeLabel(minutes: SnoozeMinutes): string {
  return t(SNOOZE_KEYS[minutes])
}

/** The offset a stored reminder stands for, as the forms and the create route speak it. */
export function remindOffsetOf(task: { remindAt: number | null; dueAt: number | null }): RemindOffset {
  if (task.remindAt === null || task.dueAt === null) return 'none'
  const delta = task.dueAt - task.remindAt
  if (delta <= 0) return 'due'
  if (delta === 15 * 60_000) return '15m'
  if (delta === 60 * 60_000) return '1h'
  if (delta === 24 * 60 * 60_000) return '1d'
  return 'none'
}

/**
 * One quick-add line as the draft a panel opens on.
 *
 * The parser decides what the words meant; this only decides which of them the account can honour.
 * A list is used only when its name is one the account already has, and a line typed under a card
 * keeps that card's list when it names nothing new. Only fields the line actually carried are set,
 * so a draft is a diff against the form's own defaults rather than a second set of them.
 */
export function quickAddDraft(
  input: string,
  now: number,
  timezone: string,
  lists: readonly TaskList[],
  baseListId: string | null = null,
): TaskDraft | null {
  const text = input.trim()
  if (!text) return null
  const parsed = parseQuickAdd(text, now, timezone)
  const named = parsed.listName ? listNamed(lists, parsed.listName) : null
  const listId = named?.id ?? baseListId
  return {
    title: parsed.title,
    ...(listId !== null ? { listId } : {}),
    ...(parsed.dueAt !== null ? { dueAt: parsed.dueAt } : {}),
    ...(parsed.remindAt !== null ? { remindAt: parsed.remindAt } : {}),
    ...(parsed.priority ? { priority: parsed.priority } : {}),
    ...(parsed.tags.length ? { tags: parsed.tags } : {}),
    ...(parsed.repeat ? { repeat: parsed.repeat } : {}),
  }
}

/** The view part of the state, which is the part the query string carries. */
function viewSelection(
  state: Pick<TodosState, 'view' | 'listId' | 'tagId' | 'query' | 'sort' | 'dueFrom' | 'dueTo'
    | 'completedFrom' | 'completedTo' | 'statsFrom' | 'statsTo' | 'statsBucket'>,
): TodoViewSelection {
  return {
    view: state.view,
    listId: state.listId,
    tagId: state.tagId,
    query: state.query,
    sort: state.sort,
    dueFrom: state.dueFrom,
    dueTo: state.dueTo,
    completedFrom: state.completedFrom,
    completedTo: state.completedTo,
    statsFrom: state.statsFrom,
    statsTo: state.statsTo,
    statsBucket: state.statsBucket,
  }
}

/** The screen the address bar names when the store is first asked for one — a reload opens where it left off. */
const initialAddress = readTodoAddress()

/** How many rows one page of a list carries, in every view that pages. */
const PAGE_SIZE = 100

/**
 * How long the store waits after the last keystroke before asking for a search.
 *
 * A search box is typed into one character at a time, and each character would otherwise be a query. A
 * quarter of a second is shorter than the pause a reader makes between words and longer than a round trip,
 * so the answer lands while the next keystroke is still on its way.
 */
const SEARCH_DEBOUNCE_MS = 250

/** The server-side view each aggregate screen reads. A list or a tag names its own collection instead. */
const SERVER_VIEWS: Record<'board' | 'today' | 'plan' | 'starred', string> = {
  board: 'open',
  today: 'today',
  plan: 'today',
  starred: 'starred',
}

/**
 * How many candidate rows the today screen's picker asks for.
 *
 * Eight is about what fits under the field without turning a picker into a second listing; a reader
 * who does not see the task narrows the words rather than scrolling.
 */
const PICKER_LIMIT = 8

type ListingParams = Parameters<typeof api.todos.list>[0]

/**
 * The listing the screen states, as the route reads it.
 *
 * Every condition that decides *which* tasks are on screen is here, and nothing else is: the browser
 * groups what comes back and asks for the next page of it, and the database decides what matches.
 */
function listingParams(
  state: Pick<TodosState, 'view' | 'listId' | 'tagId' | 'query' | 'sort' | 'dueFrom' | 'dueTo'
    | 'completedFrom' | 'completedTo'>,
  offset = 0,
): ListingParams {
  const params: ListingParams = { limit: PAGE_SIZE }
  // The statistics and calendar screens have no listing of their own, so they ask for nothing more than
  // the counts and the lists that their own frame still needs.
  if (state.view === 'stats' || state.view === 'calendar') return { ...params, limit: 1 }
  const query = state.query.trim()
  if (query) params.q = query
  if (offset > 0) params.offset = offset
  // The order is the reader's when they picked one, and otherwise absent: the route reads the order a
  // view has always had, so the default here is the default there rather than a second answer.
  if (state.sort) params.sort = state.sort
  if (state.dueFrom) params.dueFrom = state.dueFrom
  if (state.dueTo) params.dueTo = state.dueTo
  if (state.view === 'list') {
    // A list shows its finished rows under its open ones, so it asks for both rather than for the open
    // page and a guess about the rest. The inbox is a collection with no row behind it: `none`.
    params.view = 'all'
    params.list = state.listId && state.listId !== 'inbox' ? state.listId : 'none'
  } else if (state.view === 'tag') {
    params.view = 'all'
    if (state.tagId) params.tag = state.tagId
  } else if (state.view === 'completed') {
    // Finished work is one bucket, optionally scoped to one collection and to a completion window. The
    // dropdown is the same `list` parameter the list view uses, because the route already reads a
    // collection there; the window is the route's half-open pair of account-zone days.
    params.view = 'completed'
    if (state.listId) params.list = state.listId === 'inbox' ? 'none' : state.listId
    if (state.completedFrom) params.completedFrom = state.completedFrom
    if (state.completedTo) params.completedTo = state.completedTo
  } else {
    params.view = SERVER_VIEWS[state.view]
  }
  return params
}

/** The completed view pages through its own bucket, because its rows are a different question. */
function isCompletedPage(view: TodoView): boolean {
  return view === 'completed'
}

/** The part of the screen a page footer reads: which bucket is on show, and how full the page is. */
export interface TodoPageInfo {
  view: TodoView
  tasks: TodoTask[]
  completed: TodoTask[]
  total: number
  completedTotal: number
}

/** How many rows the filter on screen still has behind the page the reader is looking at. */
export function remainingCount(state: TodoPageInfo): number {
  return Math.max(0, isCompletedPage(state.view)
    ? state.completedTotal - state.completed.length
    : state.total - state.tasks.length)
}

/**
 * The listing in flight, by number.
 *
 * A reader who moves on while a page is on the wire must not be shown the screen they left, and the last
 * answer to come back is not necessarily the one that was asked for last.
 */
let listingSeq = 0
/** The statistics read in flight: a range the reader moved off must not land on the next one. */
let statsSeq = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null

/** Ask for the listing a beat after the last keystroke, so typing is not one query per character. */
function scheduleListing(get: () => TodosState): void {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { void get().load() }, SEARCH_DEBOUNCE_MS)
}

export const useTodos = create<TodosState>((set, get) => ({
  status: 'idle',
  error: null,
  tasks: [],
  total: 0,
  completed: [],
  completedTotal: 0,
  loadingMore: false,
  lists: [],
  archivedLists: [],
  tags: [],
  counts: null,
  dayEnd: 0,
  timezone: 'UTC',

  view: initialAddress.view,
  listId: initialAddress.listId,
  tagId: initialAddress.tagId,
  query: initialAddress.query,
  sort: initialAddress.sort,
  dueFrom: initialAddress.dueFrom,
  dueTo: initialAddress.dueTo,
  completedFrom: initialAddress.completedFrom ?? null,
  completedTo: initialAddress.completedTo ?? null,

  stats: null,
  statsStatus: 'idle',
  statsError: null,
  statsFrom: initialAddress.statsFrom ?? null,
  statsTo: initialAddress.statsTo ?? null,
  statsBucket: initialAddress.statsBucket ?? null,

  selectedId: null,
  selectedIds: new Set<string>(),
  editorOpen: false,
  draft: null,
  saving: false,
  undo: null,

  load: async () => {
    if (get().status === 'idle') set({ status: 'loading' })
    const seq = ++listingSeq
    const params = listingParams(get())
    try {
      const [page, lists, tags] = await Promise.all([
        api.todos.list(params),
        api.todos.lists(),
        api.todos.tags(),
      ])
      // A reader who moved on while this was in flight must not be shown the screen they left.
      if (seq !== listingSeq) return
      const shared = {
        counts: page.counts,
        dayEnd: page.dayEnd,
        timezone: page.timezone,
        lists: lists.lists,
        tags: tags.tags,
        status: 'ready' as const,
        error: null,
      }
      // A new listing starts its own first page: what the reader had scrolled to belongs to the filter
      // that produced it, and keeping it would show the old screen under the new heading.
      set(isCompletedPage(get().view)
        ? { ...shared, completed: page.tasks, completedTotal: page.total }
        : { ...shared, tasks: page.tasks, total: page.total })
    } catch (error) {
      if (seq !== listingSeq) return
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      toastError(error)
    }
  },

  loadMore: async () => {
    const state = get()
    const completed = isCompletedPage(state.view)
    const loaded = completed ? state.completed.length : state.tasks.length
    const total = completed ? state.completedTotal : state.total
    if (state.loadingMore || loaded >= total) return
    set({ loadingMore: true })
    try {
      const page = await api.todos.list(listingParams(state, loaded))
      // Appended, not replaced: the rows already on screen were read for the same filter, and swapping
      // them out would move what the reader is in the middle of looking at.
      if (completed) set({ completed: [...state.completed, ...page.tasks], completedTotal: page.total, loadingMore: false })
      else set({ tasks: [...state.tasks, ...page.tasks], total: page.total, loadingMore: false })
    } catch (error) {
      set({ loadingMore: false })
      toastError(error)
    }
  },

  refreshCounts: async () => {
    try {
      const page = await api.todos.list({ limit: 1 })
      set({ counts: page.counts, dayEnd: page.dayEnd, timezone: page.timezone })
    } catch (error) {
      toastError(error)
    }
  },

  undoLast: async () => {
    const entry = get().undo
    const toastId = undoToastId
    const offered = toastId !== null && useUi.getState().toasts.some((item) => item.id === toastId)
    undoToastId = null
    set({ undo: null })
    if (toastId) useUi.getState().dismissToast(toastId)
    if (!entry || !offered) return
    undoing = true
    try {
      await entry.undo()
    } catch (error) {
      toastError(error)
    } finally {
      undoing = false
    }
  },

  setView: (view, target) => {
    set({
      view,
      listId: target?.listId ?? null,
      tagId: target?.tagId ?? null,
      selectedId: null,
      // A selection belongs to the listing it was made on: carrying it to another screen would leave a
      // bar acting on rows the reader can no longer see.
      selectedIds: new Set<string>(),
      // Opening the finished view is a deliberate move, and the completion window is chosen on that
      // screen: it starts over at "all years". A back button or a reload restores one from the address
      // through `syncFromAddress`, which writes the state directly rather than coming through here.
      ...(view === 'completed' ? { completedFrom: null, completedTo: null } : {}),
    })
    // Opening a view is a move the reader made on purpose, so it gets a history entry: the back button
    // walks the views they stood in instead of dumping them on the board.
    pushTodoAddress(viewSelection(get()))
    // Every view is a different question, so it is asked rather than cut out of the answer to the last.
    if (view === 'stats') void get().loadStats()
    else void get().load()
  },

  // Typing is not a move: the address follows the text, but no extra back button is left behind for it.
  setQuery: (query) => {
    set({ query })
    replaceTodoAddress(viewSelection(get()))
    scheduleListing(get)
  },

  // An order or a date window is a deliberate move, so it gets the same history entry a view change
  // does, and the listing is asked for again rather than re-sliced from the order it was read in.
  setSort: (sort) => {
    if (get().sort === sort) return
    set({ sort })
    pushTodoAddress(viewSelection(get()))
    void get().load()
  },

  setDueRange: ({ from, to }) => {
    set({ dueFrom: from, dueTo: to })
    pushTodoAddress(viewSelection(get()))
    void get().load()
  },

  // The completion window is a question about finished work, so it is only asked from that view and
  // takes the same history entry a date window does.
  setCompletedRange: ({ from, to }) => {
    if (get().completedFrom === from && get().completedTo === to) return
    set({ completedFrom: from, completedTo: to })
    pushTodoAddress(viewSelection(get()))
    void get().load()
  },

  loadStats: async () => {
    const state = get()
    const seq = ++statsSeq
    const params: { from?: string; to?: string; bucket?: TaskStatsBucket } = {}
    // An address that names both bounds is the question; one that names neither asks the route for its
    // own default, and the echoed range is then written back so a reload opens the same days.
    const explicit = Boolean(state.statsFrom && state.statsTo)
    if (explicit) {
      params.from = state.statsFrom!
      params.to = state.statsTo!
    }
    if (state.statsBucket) params.bucket = state.statsBucket
    set({ statsStatus: 'loading', statsError: null })
    try {
      const stats = await api.todos.stats(params)
      // A reader who picked another range while this was in flight must not see the old answer land.
      if (seq !== statsSeq) return
      set({
        stats,
        statsStatus: 'ready',
        statsError: null,
        statsFrom: stats.range.from,
        statsTo: stats.range.to,
        statsBucket: stats.range.bucket,
      })
      if (!explicit && get().view === 'stats') {
        // No back button for the range the server chose: the reader did not pick those days.
        replaceTodoAddress(viewSelection(get()))
      }
    } catch (error) {
      if (seq !== statsSeq) return
      set({ statsStatus: 'error', statsError: error instanceof Error ? error.message : String(error) })
    }
  },

  setStatsRange: (range) => {
    set({ statsFrom: range.from, statsTo: range.to, statsBucket: range.bucket })
    pushTodoAddress(viewSelection(get()))
    void get().loadStats()
  },

  syncFromAddress: () => {
    const address = readTodoAddress()
    const state = get()
    const completedFrom = address.completedFrom ?? null
    const completedTo = address.completedTo ?? null
    const statsFrom = address.statsFrom ?? null
    const statsTo = address.statsTo ?? null
    const statsBucket = address.statsBucket ?? null
    if (
      address.view !== state.view || address.listId !== state.listId || address.tagId !== state.tagId
      || address.query !== state.query || address.sort !== state.sort
      || address.dueFrom !== state.dueFrom || address.dueTo !== state.dueTo
      || completedFrom !== state.completedFrom || completedTo !== state.completedTo
      || statsFrom !== state.statsFrom || statsTo !== state.statsTo || statsBucket !== state.statsBucket
    ) {
      set({
        view: address.view,
        listId: address.listId,
        tagId: address.tagId,
        query: address.query,
        sort: address.sort,
        dueFrom: address.dueFrom,
        dueTo: address.dueTo,
        completedFrom,
        completedTo,
        statsFrom,
        statsTo,
        statsBucket,
        // The back button moved the reader to another listing, so the rows picked on the old one are no
        // longer the rows on screen.
        selectedIds: new Set<string>(),
      })
      // The screen the address names has rows the store never asked for, so they are asked for now: this
      // is the back button, a forward, and an address read out of a chat.
      if (address.view === 'stats') void get().loadStats()
      else void get().load()
    }
    if (address.taskId) {
      // The panel is either already on that task or on its way there; anything else is a screen the
      // address names and the store has not caught up with.
      const open = state.editorOpen && state.draft?.id === address.taskId
      if (!open && state.selectedId !== address.taskId) void get().openTask(address.taskId)
      return
    }
    // Nothing names a task, so a panel left open on one belongs to an address the reader has moved off.
    if (state.editorOpen && state.draft?.id) set({ editorOpen: false, draft: null, selectedId: null })
  },

  select: (id) => set({ selectedId: id }),

  toggleSelected: (id) => set((state) => {
    const next = new Set(state.selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return { selectedIds: next }
  }),

  clearSelection: () => set({ selectedIds: new Set<string>() }),

  openEditor: (draft) => {
    set({ editorOpen: true, draft })
    // An existing task has an address of its own, so opening its panel goes there: what the reader can
    // copy out of the bar is the task they are looking at, and back closes the panel. A draft for a new
    // task names no task, so it takes the previous one out of the bar instead of leaving it claiming the
    // screen the panel has stopped being.
    if (draft.id) pushTodoTaskAddress(draft.id, viewSelection(get()))
    else if (readTodoAddress().taskId) replaceTodoTaskAddress(viewSelection(get()))
  },

  closeEditor: () => {
    set({ editorOpen: false, draft: null })
    // The task screen is left behind rather than pushed: a back button after a close should go to where
    // the reader came from, not to a panel they just shut.
    if (readTodoAddress().taskId) replaceTodoTaskAddress(viewSelection(get()))
  },

  /**
   * Open one task by id, wherever the reader came from.
   *
   * A chip in the chat names a task that may not be on the open page at all — it can be completed, or
   * older than the page the board loaded. The row is read on its own in that case, because the panel
   * edits from the store and an id it cannot find would open an empty form over a task that exists.
   *
   * The address is taken before the read, so a screen reached from two directions — a pasted link and a
   * press — arrives at the same place, and the selection is written first so the second arrival is
   * recognised as the same request rather than turned into a second fetch. A read that fails is corrected
   * out loud: the id goes back out of the address, leaving the view it was opened from.
   */
  openTask: async (id) => {
    set({ selectedId: id })
    if (readTodoAddress().taskId !== id) pushTodoTaskAddress(id, viewSelection(get()))
    if (get().status !== 'ready') await get().load()
    const found = get().tasks.find((task) => task.id === id) ?? get().completed.find((task) => task.id === id)
    if (!found) {
      try {
        const { task } = await api.todos.get(id)
        set((state) => (task.status === 'done'
          ? { completed: [task, ...state.completed.filter((entry) => entry.id !== task.id)] }
          : { tasks: [...state.tasks.filter((entry) => entry.id !== task.id), task] }))
      } catch (error) {
        toastError(error)
        set({ selectedId: null })
        if (readTodoAddress().taskId === id) replaceTodoTaskAddress(viewSelection(get()))
        return
      }
    }
    set({ selectedId: id, editorOpen: true, draft: { id } })
  },

  createTask: async (input) => {
    set({ saving: true })
    try {
      const { id: _ignored, ...body } = input
      const { task } = await api.todos.create(body as Record<string, unknown>)
      set((state) => ({ tasks: [...state.tasks, task], saving: false }))
      void get().refreshCounts()
      return task
    } catch (error) {
      set({ saving: false })
      toastError(error)
      return null
    }
  },

  updateTask: async (id, patch, rev) => {
    const before = get().tasks.find((entry) => entry.id === id)
      ?? get().completed.find((entry) => entry.id === id)
      ?? null
    // The guard names the row the reader is looking at. A caller that hands one in (the conflict
    // retry) wins, because the row on screen is the stale one in that case.
    const expectedRev = rev ?? before?.rev
    set({ saving: true })
    try {
      const { task, next } = await api.todos.update(id, patch, expectedRev)
      set((state) => ({
        // The next occurrence of a repeating task arrives with the completion, so the reader who ticked
        // the box sees the following one on the list instead of finding out about it on the next reload.
        tasks: [
          ...state.tasks.filter((entry) => entry.id !== id && entry.id !== next?.id),
          ...(task.status === 'done' ? [] : [task]),
          ...(next ? [next] : []),
        ],
        completed: task.status === 'done'
          ? [task, ...state.completed.filter((entry) => entry.id !== id)]
          : state.completed.filter((entry) => entry.id !== id),
        saving: false,
      }))
      // A tick is the one write whose answer carries a second row, so its inverse owns both: the
      // occurrence the server filed goes back first, and only then does the original reopen.
      if (!undoing && before && before.status !== 'done' && patch.status === 'done') {
        const restoreStatus = before.status
        offerUndo(set, get, t('todo.toast.completed'), async () => {
          if (next) {
            await api.todos.remove(next.id)
            set((state) => ({ tasks: state.tasks.filter((entry) => entry.id !== next.id) }))
          }
          await get().updateTask(id, { status: restoreStatus })
        })
      } else if (!undoing && before) {
        // A save may carry both fields at once, and half a step back is not a step back: one inverse
        // puts back whatever the save changed of the two.
        const listChanged = 'listId' in patch && (patch.listId ?? null) !== before.listId
        const priorityChanged = 'priority' in patch && patch.priority !== before.priority
        if (listChanged || priorityChanged) {
          const inverse = {
            ...(listChanged ? { listId: before.listId } : {}),
            ...(priorityChanged ? { priority: before.priority } : {}),
          }
          offerUndo(set, get, t(listChanged ? 'todo.toast.moved' : 'todo.toast.priority'), async () => {
            await get().updateTask(id, inverse)
          })
        }
      }
      void get().refreshCounts()
      return task
    } catch (error) {
      set({ saving: false })
      if (isRevisionConflict(error)) {
        // Nothing landed, so nothing is painted: the choice decides between the server's row and
        // another guarded attempt at this one.
        await resolveRevisionConflict(id, patch, set, get)
        return null
      }
      toastError(error)
      return null
    }
  },

  toggleTask: async (task) => {
    await get().updateTask(task.id, { status: toggledStatus(task.status) })
  },

  removeTask: async (id) => {
    try {
      await api.todos.remove(id)
      set((state) => ({
        tasks: state.tasks.filter((entry) => entry.id !== id),
        completed: state.completed.filter((entry) => entry.id !== id),
        selectedId: state.selectedId === id ? null : state.selectedId,
        selectedIds: state.selectedIds.has(id)
          ? new Set([...state.selectedIds].filter((entry) => entry !== id))
          : state.selectedIds,
      }))
      void get().refreshCounts()
      // The delete only stamps the row, so the step back is the server's restore of the same id —
      // not a re-creation that would lose steps and mint a second row.
      offerUndo(set, get, t('todo.toast.deleted'), async () => {
        await get().restoreTask(id)
      })
      return true
    } catch (error) {
      toastError(error)
      return false
    }
  },

  /** The way back from the trash, shared by the delete undo and the trash screen. */
  restoreTask: async (id) => {
    try {
      await api.todos.restore(id)
      useUi.getState().toast({ title: t('todo.toast.restored'), tone: 'success' })
      await get().load()
      return true
    } catch (error) {
      toastError(error)
      return false
    }
  },

  /**
   * One change over the selection, then one read of the listing.
   *
   * The listing is asked for again rather than patched row by row: a completed row may leave the
   * filter, a moved one may leave the list, and a repeating task's completion files a row the client
   * has never seen. The server already answers which rows it changed and which it did not, and both
   * halves are reported: a toast that said "done" over a partly failed batch would be a lie.
   *
   * A delete leaves one undo on the rail. It restores every id the server said it changed, in the
   * order the server answered, because the rail holds one step; the batch is that step. Restoring
   * the same rows rather than re-creating them is what keeps their steps, tags and ids.
   */
  batchTasks: async (op, value) => {
    const state = get()
    const ids = [...state.selectedIds]
    if (!ids.length) return null
    try {
      const result = await api.todos.batch({ ids, op, ...(value !== undefined ? { value } : {}) })
      set({ selectedIds: new Set<string>() })
      await get().load()
      if (result.failed.length) {
        const reasons = [...new Set(result.failed.map((entry) => entry.reason))].slice(0, 3).join(' · ')
        useUi.getState().toast({
          title: t('todo.toast.batch_partial', { failed: result.failed.length, total: ids.length }),
          description: reasons,
          tone: 'danger',
        })
      } else {
        useUi.getState().toast({ title: t(BATCH_TOAST_KEYS[op], { count: result.done.length }), tone: 'success' })
      }
      if (op === 'delete' && result.done.length) {
        const deleted = result.done
        offerUndo(set, get, t('todo.toast.batch_deleted', { count: deleted.length }), async () => {
          for (const id of deleted) {
            try {
              await api.todos.restore(id)
            } catch (error) {
              throw new Error(`A deleted task could not be restored: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          await get().load()
        })
      }
      return result
    } catch (error) {
      toastError(error)
      return null
    }
  },

  /**
   * Pick a task into today, or take it back out.
   *
   * The pick is a write like any other, so the listing is asked for again rather than patched here:
   * a row that leaves today because its plan was cleared and a row that enters it because of one are
   * the same question, and the server already answers it. The task's own answer is returned so the
   * caller can tell a landed pick from a refused one.
   */
  planTask: async (id, date) => {
    try {
      const { task } = await api.todos.plan(id, date)
      await get().load()
      return task
    } catch (error) {
      toastError(error)
      return null
    }
  },

  /**
   * Snooze one task: append a reminder a fixed distance from now.
   *
   * The server answers with the whole pending list, so the store replaces the row with what landed
   * rather than guessing one more timestamp. Both lists are patched because the notification centre
   * can snooze a task that the completed page is showing.
   */
  snoozeTask: async (id, minutes) => {
    try {
      const { task } = await api.todos.snooze(id, minutes)
      set((state) => ({
        tasks: state.tasks.map((entry) => (entry.id === id ? task : entry)),
        completed: state.completed.map((entry) => (entry.id === id ? task : entry)),
      }))
      useUi.getState().toast({ title: t('todo.toast.snoozed'), tone: 'success' })
      return task
    } catch (error) {
      toastError(error)
      return null
    }
  },

  /**
   * The picker's search: open tasks whose title (or note, or tag) says what the reader typed.
   *
   * A read on its own, not the page's listing: the picker is looking across the whole shelf while the
   * page behind it stays scoped to today. A failure is reported through the same toast every other
   * failed read uses and answers with nothing, so the field stays usable rather than throwing inside
   * an effect.
   */
  searchTasks: async (query) => {
    const text = query.trim()
    if (!text) return []
    try {
      const page = await api.todos.list({ view: 'open', q: text, limit: PICKER_LIMIT })
      return page.tasks
    } catch (error) {
      toastError(error)
      return []
    }
  },

  createList: async (input) => {
    try {
      const { list } = await api.todos.createList(input)
      set((state) => ({ lists: sortLists([...state.lists.filter((entry) => entry.id !== list.id), list]) }))
      return list
    } catch (error) {
      toastError(error)
      return null
    }
  },

  updateList: async (id, patch) => {
    try {
      const { list } = await api.todos.updateList(id, patch)
      // Archiving moves the row between the working page and the shelf; the two arrays are the whole
      // difference, so one write updates both and no reload is needed.
      set((state) => ({
        lists: list.archivedAt === null
          ? sortLists([...state.lists.filter((entry) => entry.id !== id), list])
          : state.lists.filter((entry) => entry.id !== id),
        archivedLists: list.archivedAt !== null
          ? sortLists([...state.archivedLists.filter((entry) => entry.id !== id), list])
          : state.archivedLists.filter((entry) => entry.id !== id),
      }))
      // A put-away list leaves every account-wide count, so the badge has to be read again.
      if (patch.archived !== undefined) void get().refreshCounts()
      return list
    } catch (error) {
      toastError(error)
      return null
    }
  },

  removeList: async (id) => {
    try {
      await api.todos.removeList(id)
      set((state) => ({
        lists: state.lists
          .filter((entry) => entry.id !== id)
          // The server lifts a deleted container's children to the top level; the local copy follows
          // so the tree does not keep pointing at a row that is gone.
          .map((entry) => (entry.parentId === id ? { ...entry, parentId: null } : entry)),
        archivedLists: state.archivedLists.filter((entry) => entry.id !== id),
        tasks: state.tasks.map((task) => (task.listId === id ? { ...task, listId: null } : task)),
        view: state.view === 'list' && state.listId === id ? 'board' : state.view,
        listId: state.listId === id ? null : state.listId,
      }))
      // A view that was taken away is not a screen the reader chose, so the address is corrected in place
      // rather than given another entry to back out of.
      if (get().view === 'board' && !get().listId) replaceTodoAddress(viewSelection(get()))
      void get().refreshCounts()
    } catch (error) {
      toastError(error)
    }
  },

  loadArchivedLists: async () => {
    try {
      const { lists } = await api.todos.lists({ archived: '1' })
      set({ archivedLists: lists })
    } catch (error) {
      toastError(error)
    }
  },

  createTag: async (input) => {
    try {
      const { tag } = await api.todos.createTag(input)
      set((state) => ({ tags: [...state.tags.filter((entry) => entry.id !== tag.id), tag] }))
      return tag
    } catch (error) {
      toastError(error)
      return null
    }
  },

  updateTag: async (id, patch) => {
    try {
      const { tag } = await api.todos.updateTag(id, patch)
      set((state) => ({
        tags: state.tags.map((entry) => (entry.id === id ? tag : entry)),
        tasks: state.tasks.map((task) => ({
          ...task,
          tags: task.tags.map((entry) => (entry.id === id ? tag : entry)),
        })),
      }))
      return tag
    } catch (error) {
      toastError(error)
      return null
    }
  },

  removeTag: async (id) => {
    try {
      await api.todos.removeTag(id)
      set((state) => ({
        tags: state.tags.filter((entry) => entry.id !== id),
        tasks: state.tasks.map((task) => ({ ...task, tags: task.tags.filter((entry) => entry.id !== id) })),
        view: state.view === 'tag' && state.tagId === id ? 'board' : state.view,
        tagId: state.tagId === id ? null : state.tagId,
      }))
      // The same correction as a deleted list: the address must stop naming a tag that is gone.
      if (get().view === 'board' && !get().tagId) replaceTodoAddress(viewSelection(get()))
      void get().refreshCounts()
    } catch (error) {
      toastError(error)
    }
  },

  addStep: async (taskId, text) => {
    try {
      const { step } = await api.todos.addStep(taskId, text)
      void get().reloadSteps(taskId)
      return step
    } catch (error) {
      toastError(error)
      return null
    }
  },

  updateStep: async (taskId, stepId, patch) => {
    try {
      await api.todos.updateStep(taskId, stepId, patch)
      void get().reloadSteps(taskId)
    } catch (error) {
      toastError(error)
    }
  },

  removeStep: async (taskId, stepId) => {
    try {
      await api.todos.removeStep(taskId, stepId)
      void get().reloadSteps(taskId)
    } catch (error) {
      toastError(error)
    }
  },

  /** Re-reads one task so its step counts match the rows the detail panel is showing. */
  reloadSteps: async (taskId: string) => {
    try {
      const { task } = await api.todos.get(taskId)
      set((state) => ({
        tasks: state.tasks.map((entry) => (entry.id === taskId ? task : entry)),
        completed: state.completed.map((entry) => (entry.id === taskId ? task : entry)),
      }))
    } catch (error) {
      toastError(error)
    }
  },
}))

/**
 * Follow the address bar when the browser moves it.
 *
 * `popstate` is the back button, a forward, and a history entry the reader picked out of the bar's own
 * list — the moves the app was not asked for. A store that kept its own answer would leave the screen and
 * the address describing two different places, which is the failure this state was moved out of memory to
 * stop. The writers above announce their own changes through the same listener set, so the sync they
 * trigger is a comparison that finds nothing to do.
 *
 * The guard is for a build without a window: nothing here renders in one today, and an import that threw
 * on `addEventListener` would take the chat's task chips down with it, since they reach this store too.
 */
if (typeof window !== 'undefined') {
  subscribeToAddress(() => { useTodos.getState().syncFromAddress() })
}
