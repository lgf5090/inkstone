import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  AgentChatSchema,
  AiChatSchema,
  ConnectionFlagsSchema,
  ConnectionOrderSchema,
  CreateConnectionSchema,
  D1DatabasesSchema,
  DatabaseIdSchema,
  DatabaseSettingsSchema,
  ExportCreateSchema,
  HistoryQuerySchema,
  QueryBatchSchema,
  QuerySchema,
  SavedQueryCreateSchema,
  SavedQueryUpdateSchema,
  TestConnectionSchema,
  UpdateConnectionSchema,
} from '@shared/development/database/schemas'
import {
  MAX_CONNECTIONS,
  MAX_EXPORT_BYTES,
  MAX_HISTORY_SQL_LENGTH,
  MAX_QUERY_BYTES,
  MAX_SAVED_QUERIES,
  MAX_SAVED_SQL_LENGTH,
  MAX_SQL_LENGTH,
} from '@shared/development/database/types'
import { splitSqlStatements } from '@shared/development/database/sql-utils'
import type { AppBindings } from '../env'
import { newId } from '../lib/id'
import { isValidId } from '../lib/id'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { executeD1Query, listD1Databases } from '../development/database/d1'
import { databaseAiStatus, streamDatabaseAgent, streamDatabaseAi, streamResponse } from '../development/database/ai'
import { assertTursoUrl, executeTursoQuery } from '../development/database/turso'
import {
  executeBatch,
  executeQuery,
  failureFromError,
  failureToApiError,
  QueryFailure,
} from '../development/database/query'
import {
  clearHistory,
  countConnections,
  countSavedQueries,
  deleteConnection,
  deleteExport,
  deleteSavedQuery,
  findConnection,
  findExport,
  findMissingConnectionIds,
  findSavedQuery,
  getSettings,
  insertConnection,
  insertExport,
  insertSavedQuery,
  listConnections,
  listHistory,
  listSavedQueries,
  recordHistory,
  saveSettings,
  toConnectionView,
  updateConnection,
  updateConnectionFlags,
  updateConnectionOrder,
  updateSavedQuery,
} from '../development/database/store'
import type { ConnectionPatch, ConnectionRecord } from '../development/database/store'
import { openConnectionSecret, sealConnectionSecret } from '../development/database/credentials'
import {
  cleanupExpiredExports,
  deleteExportObject,
  deleteExportObjectBestEffort,
  EXPORT_CONTENT_TYPES,
  exportContentDisposition,
  exportFileView,
  putExport,
  readExportObject,
} from '../development/database/r2'

export const developmentDatabaseRoutes = new Hono<AppBindings>()

developmentDatabaseRoutes.use('*', requireAuth)

const CONNECTION_BODY_LIMIT = 64 * 1024
const QUERY_BODY_LIMIT = MAX_SQL_LENGTH * 2 + 64 * 1024
const BATCH_BODY_LIMIT = MAX_QUERY_BYTES
const SAVED_QUERY_BODY_LIMIT = MAX_SAVED_SQL_LENGTH * 2 + 64 * 1024
const EXPORT_BODY_LIMIT = MAX_EXPORT_BYTES * 2
const SETTINGS_BODY_LIMIT = JSON_BODY_LIMITS.small
const AI_BODY_LIMIT = 64 * 1024

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

async function parseBody<T>(
  c: Context<AppBindings>,
  schema: z.ZodType<T>,
  limit: number,
): Promise<T> {
  const raw = await readJson<unknown>(c, limit)
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.join('.') || 'body'
    throw ApiError.badRequest(`${path}: ${issue?.message ?? 'Invalid value'}`)
  }
  return result.data
}

function pathId(c: Context<AppBindings>): string {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.badRequest('Invalid id')
  return id
}

async function requireConnection(
  c: Context<AppBindings>,
  id: string,
): Promise<ConnectionRecord> {
  const connection = await findConnection(c.env.DB, userIdOf(c), id)
  if (!connection) throw ApiError.notFound('Database connection not found')
  return connection
}

async function recordQueryRun(
  c: Context<AppBindings>,
  connectionId: string,
  sql: string,
  durationMs: number,
  error: string | null,
): Promise<void> {
  const userId = userIdOf(c)
  try {
    const settings = await getSettings(c.env.DB, userId)
    const now = Date.now()
    await recordHistory(
      c.env.DB,
      userId,
      {
        id: newId(),
        connectionId,
        query: sql.slice(0, MAX_HISTORY_SQL_LENGTH),
        executedAt: now,
        durationMs,
        error,
      },
      settings.historyLimit,
      now,
    )
  } catch (cause) {
    console.warn('[inkstone] Recording development database history failed:', cause)
  }
}

function queryFailure(error: unknown): never {
  if (error instanceof QueryFailure) throw failureToApiError(error)
  if (error instanceof ApiError) throw error
  throw failureToApiError(failureFromError(error))
}

developmentDatabaseRoutes.get('/health', (c) => c.json({ ok: true, data: { ready: true } }))

developmentDatabaseRoutes.get('/connections', async (c) => {
  const connections = await listConnections(c.env.DB, userIdOf(c))
  return c.json({ ok: true, data: connections.map(toConnectionView) })
})

developmentDatabaseRoutes.post('/connections', async (c) => {
  const userId = userIdOf(c)
  const body = await parseBody(c, CreateConnectionSchema, CONNECTION_BODY_LIMIT)
  if ((await countConnections(c.env.DB, userId)) >= MAX_CONNECTIONS) {
    throw ApiError.badRequest(`Connections are limited to ${MAX_CONNECTIONS} per account`)
  }
  const secret = body.secret.trim()
  if (!secret) throw ApiError.badRequest('The credential cannot be blank')
  if (body.type === 'turso') {
    try {
      assertTursoUrl(body.tursoUrl)
    } catch (error) {
      throw ApiError.badRequest(error instanceof Error ? error.message : 'The Turso URL is not valid')
    }
  }
  const id = newId()
  const secretCiphertext = await sealConnectionSecret(c.env, id, secret)
  const now = Date.now()
  await insertConnection(c.env.DB, userId, {
    id,
    name: body.name,
    type: body.type,
    d1AccountId: body.type === 'd1' ? body.d1AccountId : '',
    d1DatabaseId: body.type === 'd1' ? body.d1DatabaseId : '',
    d1DatabaseName: body.type === 'd1' ? (body.d1DatabaseName ?? '') : '',
    tursoUrl: body.type === 'turso' ? body.tursoUrl : '',
    secretCiphertext,
    createdAt: now,
    updatedAt: now,
  })
  const connection = await requireConnection(c, id)
  return c.json({ ok: true, data: toConnectionView(connection) })
})

developmentDatabaseRoutes.post('/connections/test', async (c) => {
  const body = await parseBody(c, TestConnectionSchema, CONNECTION_BODY_LIMIT)
  const started = Date.now()
  if (body.type === 'd1') {
    let accountId = body.d1AccountId ?? ''
    let databaseId = body.d1DatabaseId ?? ''
    let apiToken = body.secret ?? ''
    if (body.connectionId) {
      const connection = await requireConnection(c, body.connectionId)
      if (connection.type !== 'd1') throw ApiError.badRequest('The saved connection is not a D1 connection')
      accountId ||= connection.d1AccountId
      databaseId ||= connection.d1DatabaseId
      if (!apiToken) apiToken = await openConnectionSecret(c.env, connection.id, connection.secretCiphertext)
    }
    try {
      await executeD1Query({ accountId, databaseId, apiToken, sql: 'SELECT 1' })
      return c.json({ ok: true, data: { ok: true, latencyMs: Date.now() - started } })
    } catch (error) {
      queryFailure(failureFromError(error, [apiToken]))
    }
  }
  let url = body.tursoUrl ?? ''
  let token = body.secret ?? ''
  if (body.connectionId) {
    const connection = await requireConnection(c, body.connectionId)
    if (connection.type !== 'turso') throw ApiError.badRequest('The saved connection is not a Turso connection')
    url ||= connection.tursoUrl
    if (!token) token = await openConnectionSecret(c.env, connection.id, connection.secretCiphertext)
  }
  try {
    assertTursoUrl(url)
    await executeTursoQuery({ url, token, sql: 'SELECT 1' })
    return c.json({ ok: true, data: { ok: true, latencyMs: Date.now() - started } })
  } catch (error) {
    queryFailure(failureFromError(error, [token]))
  }
})

developmentDatabaseRoutes.patch('/connections/:id', async (c) => {
  const id = pathId(c)
  const body = await parseBody(c, UpdateConnectionSchema, CONNECTION_BODY_LIMIT)
  const existing = await requireConnection(c, id)
  const patch: ConnectionPatch = {}
  if (body.name !== undefined) patch.name = body.name
  if (existing.type === 'd1') {
    if (body.d1AccountId !== undefined) patch.d1AccountId = body.d1AccountId
    if (body.d1DatabaseId !== undefined) patch.d1DatabaseId = body.d1DatabaseId
    if (body.d1DatabaseName !== undefined) patch.d1DatabaseName = body.d1DatabaseName
  } else {
    if (body.tursoUrl !== undefined) {
      try {
        assertTursoUrl(body.tursoUrl)
      } catch (error) {
        throw ApiError.badRequest(error instanceof Error ? error.message : 'The Turso URL is not valid')
      }
      patch.tursoUrl = body.tursoUrl
    }
  }
  if (body.secret !== undefined) {
    if (body.secret === '') {
      patch.secretCiphertext = ''
    } else {
      const secret = body.secret.trim()
      if (!secret) throw ApiError.badRequest('The credential cannot be blank')
      patch.secretCiphertext = await sealConnectionSecret(c.env, existing.id, secret)
    }
  }
  if (Object.keys(patch).length > 0) {
    await updateConnection(c.env.DB, userIdOf(c), id, patch, Date.now())
  }
  const connection = await requireConnection(c, id)
  return c.json({ ok: true, data: toConnectionView(connection) })
})

developmentDatabaseRoutes.delete('/connections/:id', async (c) => {
  const id = pathId(c)
  const deleted = await deleteConnection(c.env.DB, userIdOf(c), id)
  if (!deleted) throw ApiError.notFound('Database connection not found')
  return c.json({ ok: true, data: { deleted: true } })
})

developmentDatabaseRoutes.put('/connections/order', async (c) => {
  const userId = userIdOf(c)
  const body = await parseBody(c, ConnectionOrderSchema, CONNECTION_BODY_LIMIT)
  if (new Set(body.ids).size !== body.ids.length) {
    throw ApiError.badRequest('Connection ids must be unique')
  }
  const missing = await findMissingConnectionIds(c.env.DB, userId, body.ids)
  if (missing.length > 0) {
    throw ApiError.badRequest('Some connections do not exist', { missing })
  }
  await updateConnectionOrder(c.env.DB, userId, body.ids)
  return c.json({ ok: true, data: { updated: true } })
})

developmentDatabaseRoutes.patch('/connections/:id/flags', async (c) => {
  const id = pathId(c)
  const body = await parseBody(c, ConnectionFlagsSchema, CONNECTION_BODY_LIMIT)
  await requireConnection(c, id)
  if (body.isFavorite !== undefined || body.isPinned !== undefined) {
    await updateConnectionFlags(c.env.DB, userIdOf(c), id, body, Date.now())
  }
  const connection = await requireConnection(c, id)
  return c.json({ ok: true, data: toConnectionView(connection) })
})

developmentDatabaseRoutes.post('/d1/databases', async (c) => {
  const body = await parseBody(c, D1DatabasesSchema, CONNECTION_BODY_LIMIT)
  let accountId: string
  let apiToken: string
  if (body.connectionId) {
    const connection = await requireConnection(c, body.connectionId)
    if (connection.type !== 'd1') {
      throw ApiError.badRequest('The saved connection is not a D1 connection')
    }
    accountId = connection.d1AccountId
    apiToken = await openConnectionSecret(c.env, connection.id, connection.secretCiphertext)
  } else {
    accountId = body.accountId ?? ''
    apiToken = body.apiToken ?? ''
    if (!accountId || !apiToken) {
      throw ApiError.badRequest('Provide connectionId or accountId with apiToken')
    }
  }
  try {
    const databases = await listD1Databases({ accountId, apiToken })
    return c.json({ ok: true, data: { databases } })
  } catch (error) {
    queryFailure(failureFromError(error, [apiToken]))
  }
})

developmentDatabaseRoutes.post('/query', async (c) => {
  const body = await parseBody(c, QuerySchema, QUERY_BODY_LIMIT)
  const statements = splitSqlStatements(body.sql)
  if (statements.length === 0) throw ApiError.badRequest('SQL cannot be empty')
  if (statements.length > 1) {
    throw ApiError.badRequest('Run one statement per query; use the batch endpoint for multiple statements')
  }
  const startedAt = Date.now()
  try {
    const result = await executeQuery(
      c.env,
      c.env.DB,
      userIdOf(c),
      body.connectionId,
      body.sql,
      body.params ?? [],
    )
    if (body.recordHistory) await recordQueryRun(c, body.connectionId, body.sql, Date.now() - startedAt, null)
    return c.json({ ok: true, data: result })
  } catch (error) {
    if (error instanceof QueryFailure) {
      const detail = error.detail || error.message
      if (body.recordHistory) await recordQueryRun(c, body.connectionId, body.sql, Date.now() - startedAt, detail)
      throw failureToApiError(error)
    }
    throw error
  }
})

developmentDatabaseRoutes.post('/query/batch', async (c) => {
  const body = await parseBody(c, QueryBatchSchema, BATCH_BODY_LIMIT)
  for (const statement of body.statements) {
    const parts = splitSqlStatements(statement.sql)
    if (parts.length === 0) throw ApiError.badRequest('SQL cannot be empty')
    if (parts.length > 1) {
      throw ApiError.badRequest('Each batch statement must contain a single SQL statement')
    }
  }
  const startedAt = Date.now()
  const joined = body.statements.map((statement) => statement.sql).join(';\n')
  try {
    const results = await executeBatch(
      c.env,
      c.env.DB,
      userIdOf(c),
      body.connectionId,
      body.statements,
    )
    if (body.recordHistory) await recordQueryRun(c, body.connectionId, joined, Date.now() - startedAt, null)
    return c.json({ ok: true, data: { results } })
  } catch (error) {
    if (body.recordHistory) {
      const detail = error instanceof QueryFailure ? (error.detail || error.message) : (error instanceof Error ? error.message : String(error))
      await recordQueryRun(c, body.connectionId, joined, Date.now() - startedAt, detail)
    }
    queryFailure(error)
  }
})

developmentDatabaseRoutes.get('/saved-queries', async (c) => {
  const rawConnectionId = c.req.query('connectionId')
  let connectionId: string | undefined
  if (rawConnectionId !== undefined) {
    const parsed = DatabaseIdSchema.safeParse(rawConnectionId)
    if (!parsed.success) throw ApiError.badRequest('Invalid connectionId')
    await requireConnection(c, parsed.data)
    connectionId = parsed.data
  }
  const queries = await listSavedQueries(c.env.DB, userIdOf(c), connectionId)
  return c.json({ ok: true, data: queries })
})

developmentDatabaseRoutes.post('/saved-queries', async (c) => {
  const userId = userIdOf(c)
  const body = await parseBody(c, SavedQueryCreateSchema, SAVED_QUERY_BODY_LIMIT)
  await requireConnection(c, body.connectionId)
  if ((await countSavedQueries(c.env.DB, userId)) >= MAX_SAVED_QUERIES) {
    throw ApiError.badRequest(`Saved queries are limited to ${MAX_SAVED_QUERIES} per account`)
  }
  const id = newId()
  const now = Date.now()
  await insertSavedQuery(c.env.DB, userId, {
    id,
    connectionId: body.connectionId,
    name: body.name,
    sql: body.sql,
    namespace: body.namespace || 'default',
    createdAt: now,
    updatedAt: now,
  })
  const query = await findSavedQuery(c.env.DB, userId, id)
  if (!query) throw ApiError.notFound('Saved query not found')
  return c.json({ ok: true, data: query })
})

developmentDatabaseRoutes.patch('/saved-queries/:id', async (c) => {
  const id = pathId(c)
  const userId = userIdOf(c)
  const body = await parseBody(c, SavedQueryUpdateSchema, SAVED_QUERY_BODY_LIMIT)
  const existing = await findSavedQuery(c.env.DB, userId, id)
  if (!existing) throw ApiError.notFound('Saved query not found')
  const query = await updateSavedQuery(
    c.env.DB,
    userId,
    id,
    {
      name: body.name,
      sql: body.sql,
      namespace: body.namespace === undefined ? undefined : body.namespace || 'default',
    },
    Date.now(),
  )
  if (!query) throw ApiError.notFound('Saved query not found')
  return c.json({ ok: true, data: query })
})

developmentDatabaseRoutes.delete('/saved-queries/:id', async (c) => {
  const id = pathId(c)
  const deleted = await deleteSavedQuery(c.env.DB, userIdOf(c), id)
  if (!deleted) throw ApiError.notFound('Saved query not found')
  return c.json({ ok: true, data: { deleted: true } })
})

function parseHistoryQuery(c: Context<AppBindings>): { connectionId: string; limit?: number } {
  const rawLimit = c.req.query('limit')
  const parsed = HistoryQuerySchema.safeParse({
    connectionId: c.req.query('connectionId'),
    limit: rawLimit === undefined ? undefined : Number(rawLimit),
  })
  if (!parsed.success) throw ApiError.badRequest('connectionId is required and must be an id')
  return parsed.data
}

developmentDatabaseRoutes.get('/history', async (c) => {
  const { connectionId, limit } = parseHistoryQuery(c)
  await requireConnection(c, connectionId)
  const settings = await getSettings(c.env.DB, userIdOf(c))
  const effective = Math.min(limit ?? settings.historyLimit, settings.historyLimit)
  const history = await listHistory(c.env.DB, userIdOf(c), connectionId, effective)
  return c.json({ ok: true, data: history })
})

developmentDatabaseRoutes.delete('/history', async (c) => {
  const { connectionId } = parseHistoryQuery(c)
  await requireConnection(c, connectionId)
  await clearHistory(c.env.DB, userIdOf(c), connectionId)
  return c.json({ ok: true, data: { deleted: true } })
})

developmentDatabaseRoutes.get('/settings', async (c) => {
  const settings = await getSettings(c.env.DB, userIdOf(c))
  return c.json({ ok: true, data: settings })
})

developmentDatabaseRoutes.put('/settings', async (c) => {
  const body = await parseBody(c, DatabaseSettingsSchema, SETTINGS_BODY_LIMIT)
  const settings = await saveSettings(c.env.DB, userIdOf(c), body.historyLimit, Date.now())
  return c.json({ ok: true, data: settings })
})

developmentDatabaseRoutes.post('/exports', async (c) => {
  const userId = userIdOf(c)
  const body = await parseBody(c, ExportCreateSchema, EXPORT_BODY_LIMIT)
  await cleanupExpiredExports(c.env, c.env.DB, userId)
  const id = newId()
  const createdAt = Date.now()
  const written = await putExport(c.env, {
    userId,
    id,
    format: body.format,
    content: body.content,
  })
  try {
    await insertExport(c.env.DB, userId, {
      id,
      filename: body.filename,
      format: body.format,
      r2Key: written.key,
      size: written.size,
      createdAt,
    })
  } catch (error) {
    await deleteExportObjectBestEffort(c.env, written.key)
    throw error
  }
  return c.json({
    ok: true,
    data: exportFileView(id, body.filename, body.format, written.size, createdAt),
  })
})

developmentDatabaseRoutes.get('/exports/:id', async (c) => {
  const id = pathId(c)
  const record = await findExport(c.env.DB, userIdOf(c), id)
  if (!record) throw ApiError.notFound('Export not found')
  const object = await readExportObject(c.env, record.r2Key)
  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': EXPORT_CONTENT_TYPES[record.format],
      'Content-Length': String(object.size),
      'Content-Disposition': exportContentDisposition(record.filename),
      'Cache-Control': 'private, no-store',
    },
  })
})

developmentDatabaseRoutes.delete('/exports/:id', async (c) => {
  const id = pathId(c)
  const record = await findExport(c.env.DB, userIdOf(c), id)
  if (!record) throw ApiError.notFound('Export not found')
  await deleteExportObject(c.env, record.r2Key)
  const deleted = await deleteExport(c.env.DB, userIdOf(c), id)
  if (!deleted) throw ApiError.notFound('Export not found')
  return c.json({ ok: true, data: { deleted: true } })
})


developmentDatabaseRoutes.get('/ai/status', async (c) => {
  return c.json({ ok: true, data: await databaseAiStatus(c.env, userIdOf(c)) })
})

developmentDatabaseRoutes.post('/ai/chat', async (c) => {
  const body = await parseBody(c, AiChatSchema, AI_BODY_LIMIT)
  return streamResponse(streamDatabaseAi(c.env, userIdOf(c), body, c.req.raw.signal))
})

developmentDatabaseRoutes.post('/agent/chat', async (c) => {
  const body = await parseBody(c, AgentChatSchema, AI_BODY_LIMIT)
  return streamResponse(streamDatabaseAgent(c.env, userIdOf(c), body.messages, c.req.raw.signal, body.allowWrites === true))
})
