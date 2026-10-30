import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'

export const clouddriveTaskRoutes = new Hono<AppBindings>()

clouddriveTaskRoutes.use('*', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

interface TaskRow {
  id: string
  type: string
  status: string
  payload: string
  progress: string
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  updated_at: number
}

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function toView(row: TaskRow) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    payload: parseJsonObject(row.payload),
    progress: parseJsonObject(row.progress),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  }
}

clouddriveTaskRoutes.get('/tasks', async (c) => {
  const requested = Number(c.req.query('limit'))
  const limit = Number.isSafeInteger(requested) && requested >= 1 && requested <= MAX_LIMIT
    ? requested
    : DEFAULT_LIMIT
  const { results } = await c.env.DB.prepare(
    `SELECT id, type, status, payload, progress, error, created_at, started_at, finished_at, updated_at
       FROM CloudDrive_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).bind(userIdOf(c), limit).all<TaskRow>()
  return c.json({ tasks: (results ?? []).map(toView) })
})

clouddriveTaskRoutes.post('/tasks/:id/cancel', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Task not found')
  const result = await c.env.DB.prepare(
    `UPDATE CloudDrive_tasks SET status = 'cancelled', finished_at = ?, updated_at = ?
      WHERE user_id = ? AND id = ? AND status IN ('queued', 'running')`,
  ).bind(Date.now(), Date.now(), userIdOf(c), id).run()
  if ((result.meta.changes ?? 0) === 0) throw ApiError.conflict('The task is not running')
  return c.json({ ok: true })
})
