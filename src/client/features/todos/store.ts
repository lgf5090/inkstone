/**
 * The to-do app's state, and the only place it is written.
 *
 * Three rules shape it. The open set is read once and the smart lists are derived from it, because
 * every one of them answers a question about the same tasks and a second fetch would let two panes
 * disagree. A write replaces the row with what the server returned rather than patching a guess, so a
 * repeat that rolled forward or a due date the server re-read shows up as it actually is. And the
 * counts are re-read after a write instead of being adjusted by hand: they are a timezone-aware
 * aggregate, and a second implementation in the browser is a second answer waiting to be wrong.
 */

import { create } from 'zustand'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { toggledStatus, type TaskCounts, type TaskList, type TaskStep, type TaskTag, type TodoTask } from '@shared/todos/model'

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
  completed: TodoTask[]
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
  loadCompleted: () => Promise<void>
  refreshCounts: () => Promise<void>

  setView: (view: TodoView, target?: { listId?: string; tagId?: string }) => void
  setQuery: (query: string) => void
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

export const useTodos = create<TodosState>((set, get) => ({
  status: 'idle',
  error: null,
  tasks: [],
  completed: [],
  lists: [],
  tags: [],
  counts: null,
  dayEnd: 0,
  timezone: 'UTC',

  view: 'board',
  listId: null,
  tagId: null,
  query: '',

  selectedId: null,
  editorOpen: false,
  draft: null,
  saving: false,

  load: async () => {
    if (get().status === 'idle') set({ status: 'loading' })
    try {
      const [page, lists, tags] = await Promise.all([
        api.todos.list({ view: 'open', limit: 500 }),
        api.todos.lists(),
        api.todos.tags(),
      ])
      set({
        tasks: page.tasks,
        counts: page.counts,
        dayEnd: page.dayEnd,
        timezone: page.timezone,
        lists: lists.lists,
        tags: tags.tags,
        status: 'ready',
        error: null,
      })
    } catch (error) {
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      toastError(error)
    }
  },

  loadCompleted: async () => {
    try {
      const page = await api.todos.list({ view: 'completed', limit: 200 })
      set({ completed: page.tasks })
    } catch (error) {
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
    if (view === 'completed' && !get().completed.length) void get().loadCompleted()
  },

  setQuery: (query) => set({ query }),
  select: (id) => set({ selectedId: id }),

  openEditor: (draft) => set({ editorOpen: true, draft }),
  closeEditor: () => set({ editorOpen: false, draft: null }),

  /**
   * Open one task by id, wherever the reader came from.
   *
   * A chip in the chat names a task that may not be on the open page at all — it can be completed, or
   * older than the page the board loaded. The row is read on its own in that case, because the panel
   * edits from the store and an id it cannot find would open an empty form over a task that exists.
   */
  openTask: async (id) => {
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
      const { task } = await api.todos.update(id, patch)
      set((state) => ({
        tasks: task.status === 'done' ? state.tasks.filter((entry) => entry.id !== id) : [
          ...state.tasks.filter((entry) => entry.id !== id),
          task,
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
