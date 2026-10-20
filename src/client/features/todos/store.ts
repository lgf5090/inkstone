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
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { subscribeToAddress } from '../../lib/app-history'
import { useUi } from '../../store/ui'
import { toggledStatus, type TaskCounts, type TaskList, type TaskStep, type TaskTag, type TodoTask } from '@shared/todos/model'
import {
  pushTodoAddress,
  pushTodoTaskAddress,
  readTodoAddress,
  replaceTodoAddress,
  replaceTodoTaskAddress,
  type TodoViewSelection,
} from './todo-address'

export type TodoView = 'board' | 'plan' | 'starred' | 'completed' | 'list' | 'tag'

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
  remindAt?: number | null
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
  lists: TaskList[]
  tags: TaskTag[]
  counts: TaskCounts | null
  dayEnd: number
  timezone: string

  view: TodoView
  listId: string | null
  tagId: string | null
  query: string

  selectedId: string | null
  editorOpen: boolean
  draft: TaskDraft | null
  saving: boolean

  load: () => Promise<void>
  loadMore: () => Promise<void>
  refreshCounts: () => Promise<void>

  setView: (view: TodoView, target?: { listId?: string; tagId?: string }) => void
  setQuery: (query: string) => void
  /** Put the store where the address bar says the screen is — what a back button asks of it. */
  syncFromAddress: () => void
  select: (id: string | null) => void
  openEditor: (draft: TaskDraft) => void
  closeEditor: () => void
  openTask: (id: string) => Promise<void>

  createTask: (input: TaskDraft) => Promise<TodoTask | null>
  updateTask: (id: string, patch: Record<string, unknown>) => Promise<TodoTask | null>
  toggleTask: (task: TodoTask) => Promise<void>
  removeTask: (id: string) => Promise<boolean>
  restoreTask: (snapshot: TaskDraft) => Promise<void>

  createList: (input: { name: string; icon?: string | null; color?: string | null }) => Promise<TaskList | null>
  updateList: (id: string, patch: { name?: string; icon?: string | null; color?: string | null }) => Promise<TaskList | null>
  removeList: (id: string) => Promise<void>

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

/** The view part of the state, which is the part the query string carries. */
function viewSelection(state: Pick<TodosState, 'view' | 'listId' | 'tagId' | 'query'>): TodoViewSelection {
  return { view: state.view, listId: state.listId, tagId: state.tagId, query: state.query }
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
const SERVER_VIEWS: Record<'board' | 'plan' | 'starred' | 'completed', string> = {
  board: 'open',
  plan: 'today',
  starred: 'starred',
  completed: 'completed',
}

type ListingParams = Parameters<typeof api.todos.list>[0]

/**
 * The listing the screen states, as the route reads it.
 *
 * Every condition that decides *which* tasks are on screen is here, and nothing else is: the browser
 * groups what comes back and asks for the next page of it, and the database decides what matches.
 */
function listingParams(
  state: Pick<TodosState, 'view' | 'listId' | 'tagId' | 'query'>,
  offset = 0,
): ListingParams {
  const params: ListingParams = { limit: PAGE_SIZE }
  const query = state.query.trim()
  if (query) params.q = query
  if (offset > 0) params.offset = offset
  if (state.view === 'list') {
    // A list shows its finished rows under its open ones, so it asks for both rather than for the open
    // page and a guess about the rest. The inbox is a collection with no row behind it: `none`.
    params.view = 'all'
    params.list = state.listId && state.listId !== 'inbox' ? state.listId : 'none'
  } else if (state.view === 'tag') {
    params.view = 'all'
    if (state.tagId) params.tag = state.tagId
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
  tags: [],
  counts: null,
  dayEnd: 0,
  timezone: 'UTC',

  view: initialAddress.view,
  listId: initialAddress.listId,
  tagId: initialAddress.tagId,
  query: initialAddress.query,

  selectedId: null,
  editorOpen: false,
  draft: null,
  saving: false,

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

  setView: (view, target) => {
    set({ view, listId: target?.listId ?? null, tagId: target?.tagId ?? null, selectedId: null })
    // Opening a view is a move the reader made on purpose, so it gets a history entry: the back button
    // walks the views they stood in instead of dumping them on the board.
    pushTodoAddress(viewSelection(get()))
    // Every view is a different question, so it is asked rather than cut out of the answer to the last.
    void get().load()
  },

  // Typing is not a move: the address follows the text, but no extra back button is left behind for it.
  setQuery: (query) => {
    set({ query })
    replaceTodoAddress(viewSelection(get()))
    scheduleListing(get)
  },

  syncFromAddress: () => {
    const address = readTodoAddress()
    const state = get()
    if (address.view !== state.view || address.listId !== state.listId || address.tagId !== state.tagId || address.query !== state.query) {
      set({ view: address.view, listId: address.listId, tagId: address.tagId, query: address.query })
      // The screen the address names has rows the store never asked for, so they are asked for now: this
      // is the back button, a forward, and an address read out of a chat.
      void get().load()
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

  updateTask: async (id, patch) => {
    set({ saving: true })
    try {
      const { task, next } = await api.todos.update(id, patch)
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
      void get().refreshCounts()
      return task
    } catch (error) {
      set({ saving: false })
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
      }))
      void get().refreshCounts()
      return true
    } catch (error) {
      toastError(error)
      return false
    }
  },

  /** Re-creates a deleted task from the snapshot the reader still has on screen. */
  restoreTask: async (snapshot) => {
    const restored = await get().createTask(snapshot)
    if (restored) useUi.getState().toast({ title: t('todo.toast.restored'), tone: 'success' })
  },

  createList: async (input) => {
    try {
      const { list } = await api.todos.createList(input)
      set((state) => ({ lists: [...state.lists.filter((entry) => entry.id !== list.id), list] }))
      return list
    } catch (error) {
      toastError(error)
      return null
    }
  },

  updateList: async (id, patch) => {
    try {
      const { list } = await api.todos.updateList(id, patch)
      set((state) => ({ lists: state.lists.map((entry) => (entry.id === id ? list : entry)) }))
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
        lists: state.lists.filter((entry) => entry.id !== id),
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
