/** Scheduled maintenance tasks and their execution history. */
import { cfRequest } from './client'

export const TASK_TYPES = ['quota_report', 'kv_cleanup', 'd1_backup', 'r2_cleanup'] as const
export type TaskType = typeof TASK_TYPES[number]

export interface CloudflareTask {
  id: string
  name: string
  type: TaskType
  cron: string
  config: string | null
  enabled: number
  created_at: number
  updated_at: number
}

export interface CloudflareTaskExecution {
  id: string
  task_id: string
  status: 'running' | 'success' | 'error'
  detail: string | null
  started_at: number
  finished_at: number | null
}

export interface TaskConfigInput {
  account_id?: string
  namespace_id?: string
  database_id?: string
  bucket?: string
  key_prefix?: string
  prefix?: string
  max_age_days?: number
}

export const tasksApi = {
  list: () => cfRequest<{ tasks: CloudflareTask[] }>('/tasks'),
  create: (input: { name: string; type: TaskType; cron: string; config?: TaskConfigInput }) =>
    cfRequest<{ task: CloudflareTask }>('/tasks', { method: 'POST', body: input }),
  update: (id: string, patch: { name?: string; cron?: string; config?: TaskConfigInput; enabled?: boolean }) =>
    cfRequest<{ ok: true }>(`/tasks/${encodeURIComponent(id)}`, { method: 'PUT', body: patch }),
  remove: (id: string) => cfRequest<{ ok: true }>(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  run: (id: string) =>
    cfRequest<{ status: 'success' | 'error'; detail: string }>(`/tasks/${encodeURIComponent(id)}/run`, { method: 'POST' }),
  history: (id: string) =>
    cfRequest<{ executions: CloudflareTaskExecution[] }>(`/tasks/${encodeURIComponent(id)}/history`),
}
