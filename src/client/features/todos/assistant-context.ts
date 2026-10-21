import { toLocalMinute } from '@shared/assistant-time'
import type { TaskTag, TodoTask } from '@shared/todos/model'
import { MAX_TODO_CONTEXT_TASKS, type TodoAssistantContext } from '@shared/todos/assistant-context'
import type { TaskListEntry } from '../../lib/api'
import { t } from '../../lib/i18n'
import type { TodoView } from './store'

export interface TodoAssistantSource {
  view: TodoView
  listId: string | null
  tagId: string | null
  query: string
  dueFrom: string | null
  dueTo: string | null
  lists: readonly TaskListEntry[]
  tags: readonly TaskTag[]
  tasks: readonly TodoTask[]
  completed: readonly TodoTask[]
  draft: { id?: string } | null
  editorOpen: boolean
  timezone: string
}

export function buildTodoAssistantContext(source: TodoAssistantSource): TodoAssistantContext {
  const openTask = source.editorOpen && source.draft?.id
    ? source.tasks.find((task) => task.id === source.draft!.id)
      ?? source.completed.find((task) => task.id === source.draft!.id)
      ?? null
    : null
  const visible = source.view === 'completed' ? source.completed : source.tasks
  const snapshot = source.view === 'stats' || source.view === 'calendar' ? [] : visible
  return {
    view: source.view,
    listId: source.listId,
    listName: source.listId === 'inbox'
      ? t('todo.smart.inbox')
      : source.lists.find((list) => list.id === source.listId)?.name ?? null,
    tagName: source.tags.find((tag) => tag.id === source.tagId)?.name ?? null,
    taskId: openTask?.id ?? null,
    taskTitle: openTask?.title ?? null,
    query: source.query,
    dueFrom: source.dueFrom,
    dueTo: source.dueTo,
    tasks: snapshot.slice(0, MAX_TODO_CONTEXT_TASKS).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      due: task.dueAt === null ? null : toLocalMinute(task.dueAt, source.timezone),
      list: task.listId === null ? null : source.lists.find((list) => list.id === task.listId)?.name ?? null,
      starred: task.starred,
      plannedFor: task.plannedFor ?? null,
    })),
  }
}
