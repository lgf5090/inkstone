import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  CreateWorkspaceSchema,
  HistoryAppendSchema,
  StatePutSchema,
  UpdateWorkspaceSchema,
  WorkspaceIdQuerySchema,
  HISTORY_JSON_LIMIT,
  STATE_JSON_LIMIT,
} from '@shared/development/api-tester/schemas'
import type {
  ApiTesterStateData,
  ApiTesterStateResponse,
  HistoryEntry,
} from '@shared/development/api-tester/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { sealHistory, sealState, openState, openHistory } from '../development/api-tester/crypto'
import { relayRoutes } from '../development/api-tester/relay'
import { oauthRoutes } from '../development/api-tester/oauth'
import { wsRoutes } from '../development/api-tester/ws'
import { fileRoutes } from '../development/api-tester/files'
import {
  assertWorkspace,
  clearHistory,
  createWorkspace,
  deleteWorkspace,
  ensureDefaultWorkspace,
  getStateRow,
  insertHistory,
  listHistoryRows,
  saveState,
  updateWorkspace,
} from '../development/api-tester/store'

export const developmentApiTesterRoutes = new Hono<AppBindings>()

developmentApiTesterRoutes.use('*', requireAuth)
developmentApiTesterRoutes.route('/', relayRoutes)
developmentApiTesterRoutes.route('/', oauthRoutes)
developmentApiTesterRoutes.route('/', wsRoutes)
developmentApiTesterRoutes.route('/', fileRoutes)

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

async function parseBody<T>(c: Context<AppBindings>, schema: z.ZodType<T>, limit: number): Promise<T> {
  const raw = await readJson<unknown>(c, limit)
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.join('.') || 'body'
    throw ApiError.badRequest(`${path}: ${issue?.message ?? 'Invalid value'}`)
  }
  return result.data
}

function workspaceIdOf(c: Context<AppBindings>): string {
  const parsed = WorkspaceIdQuerySchema.safeParse({ workspaceId: c.req.query('workspaceId') })
  if (!parsed.success) throw ApiError.badRequest('workspaceId is required')
  return parsed.data.workspaceId
}

developmentApiTesterRoutes.get('/workspaces', async (c) => {
  return c.json(await ensureDefaultWorkspace(c.env.DB, userIdOf(c)))
})

developmentApiTesterRoutes.post('/workspaces', async (c) => {
  const input = await parseBody(c, CreateWorkspaceSchema, 4 * 1024)
  return c.json(await createWorkspace(c.env.DB, userIdOf(c), input))
})

developmentApiTesterRoutes.put('/workspaces/:id', async (c) => {
  const input = await parseBody(c, UpdateWorkspaceSchema, 4 * 1024)
  return c.json(await updateWorkspace(c.env.DB, userIdOf(c), c.req.param('id'), input))
})

developmentApiTesterRoutes.delete('/workspaces/:id', async (c) => {
  return c.json(await deleteWorkspace(c.env.DB, userIdOf(c), c.req.param('id')))
})

developmentApiTesterRoutes.get('/state', async (c) => {
  const userId = userIdOf(c)
  const workspaceId = workspaceIdOf(c)
  await assertWorkspace(c.env.DB, userId, workspaceId)
  const row = await getStateRow(c.env.DB, userId, workspaceId)
  if (!row) throw ApiError.notFound('This workspace has not been saved yet')
  const data = await openState<ApiTesterStateData>(c.env, workspaceId, row.data)
  const response: ApiTesterStateResponse = { data, rev: row.rev, updatedAt: row.updated_at }
  return c.json(response)
})

developmentApiTesterRoutes.put('/state', async (c) => {
  const userId = userIdOf(c)
  const input = await parseBody(c, StatePutSchema, STATE_JSON_LIMIT)
  await assertWorkspace(c.env.DB, userId, input.workspaceId)
  const sealed = await sealState(c.env, input.workspaceId, input.data)
  const result = await saveState(c.env.DB, userId, input.workspaceId, sealed.ciphertext, input.rev)
  return c.json(result)
})

developmentApiTesterRoutes.get('/history', async (c) => {
  const userId = userIdOf(c)
  const workspaceId = workspaceIdOf(c)
  await assertWorkspace(c.env.DB, userId, workspaceId)
  const rows = await listHistoryRows(c.env.DB, userId, workspaceId)
  return c.json(await Promise.all(rows.map((entry) => openHistory<HistoryEntry>(c.env, entry.id, entry.data))))
})

developmentApiTesterRoutes.post('/history', async (c) => {
  const userId = userIdOf(c)
  const input = await parseBody(c, HistoryAppendSchema, HISTORY_JSON_LIMIT)
  await assertWorkspace(c.env.DB, userId, input.workspaceId)
  const ciphertext = await sealHistory(c.env, input.entry.id, input.entry.data)
  await insertHistory(c.env.DB, userId, input.workspaceId, {
    id: input.entry.id,
    ts: input.entry.ts,
    ciphertext,
  })
  return c.json({ ok: true })
})

developmentApiTesterRoutes.delete('/history', async (c) => {
  const userId = userIdOf(c)
  const workspaceId = workspaceIdOf(c)
  await assertWorkspace(c.env.DB, userId, workspaceId)
  await clearHistory(c.env.DB, userId, workspaceId)
  return c.json({ ok: true })
})
