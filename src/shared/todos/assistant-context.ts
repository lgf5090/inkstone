import type { TaskPriority, TaskStatus } from './model'

export interface TodoAssistantTask {
  id: string
  title: string
  status: TaskStatus
  priority: TaskPriority
  due: string | null
  list: string | null
  starred: boolean
  plannedFor: string | null
}

export interface TodoAssistantContext {
  view: string
  listId: string | null
  listName: string | null
  tagName: string | null
  taskId: string | null
  taskTitle: string | null
  query: string
  dueFrom: string | null
  dueTo: string | null
  tasks: TodoAssistantTask[]
}

export const MAX_TODO_CONTEXT_TASKS = 20
export const TODO_CONTEXT_MAX_TITLE = 300
