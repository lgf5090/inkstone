/**
 * `/api/cloudflare/tasks` — the scheduled maintenance rows and their history.
 *
 * The platform's cron trigger is what runs them (`runDueCloudflareTasks` in `cloudflare/tasks.ts`);
 * these routes only create, edit, enable and run on demand. A malformed cron is refused here rather
 * than stored and silently never fired.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import {
  createTask,
  deleteTask,
  getTask,
  listExecutions,
  listTasks,
  runTaskNow,
  TASK_TYPES,
  updateTask,
} from '../../cloudflare/tasks'

export const tasksRouter = new Hono<AppBindings>()

function badRequest(error: unknown): ApiError {
  return ApiError.badRequest(error instanceof Error ? error.message : String(error))
}

tasksRouter.get('/', async (c) => {
  return c.json({ tasks: await listTasks(c.env, c.get('userId')) })
})

tasksRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => null) as {
    name?: unknown
    type?: unknown
    cron?: unknown
    config?: unknown
  } | null
  const name = typeof body?.name === 'string' ? body.name : ''
  const type = typeof body?.type === 'string' ? body.type : ''
  const cron = typeof body?.cron === 'string' ? body.cron : ''
  if (!TASK_TYPES.includes(type as never)) throw ApiError.badRequest(`Unknown task type: ${type}`)
  try {
    const id = await createTask(c.env, c.get('userId'), { name, type, cron, config: body?.config })
    return c.json({ task: await getTask(c.env, c.get('userId'), id) }, 201)
  } catch (error) {
    throw badRequest(error)
  }
})

tasksRouter.put('/:id', async (c) => {
  const body = await c.req.json().catch(() => null) as {
    name?: unknown
    cron?: unknown
    config?: unknown
    enabled?: unknown
  } | null
  try {
    await updateTask(c.env, c.get('userId'), c.req.param('id'), {
      ...(typeof body?.name === 'string' ? { name: body.name } : {}),
      ...(typeof body?.cron === 'string' ? { cron: body.cron } : {}),
      ...(body?.config !== undefined ? { config: body.config } : {}),
      ...(typeof body?.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    })
  } catch (error) {
    throw badRequest(error)
  }
  return c.json({ ok: true })
})

tasksRouter.delete('/:id', async (c) => {
  await deleteTask(c.env, c.get('userId'), c.req.param('id'))
  return c.json({ ok: true })
})

tasksRouter.post('/:id/run', async (c) => {
  const task = await getTask(c.env, c.get('userId'), c.req.param('id'))
  if (!task) throw ApiError.notFound('That task does not exist')
  try {
    return c.json(await runTaskNow(c.env, c.get('userId'), task.id))
  } catch (error) {
    throw badRequest(error)
  }
})

tasksRouter.get('/:id/history', async (c) => {
  const task = await getTask(c.env, c.get('userId'), c.req.param('id'))
  if (!task) throw ApiError.notFound('That task does not exist')
  const limit = Number(c.req.query('limit') ?? 20) || 20
  return c.json({ executions: await listExecutions(c.env, c.get('userId'), task.id, limit) })
})
