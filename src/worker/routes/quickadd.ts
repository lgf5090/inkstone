import { Hono } from 'hono'
import { parseQuickAddText, QUICKADD_VERSION } from '@shared/quickadd'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { parseStoredJson } from '../lib/json'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { FIELD_VALUE_MAX_LENGTH, QuickAddStore } from '../quickadd/store'

export const quickAddRoutes = new Hono<AppBindings>()

quickAddRoutes.use('*', requireAuth)

/** Envelope stored in `users.quickadd`: when the account last saved, plus the library. */
interface StoredLibrary {
  savedAt: number
  version: number
  library: unknown
}

function readStored(raw: string | null): StoredLibrary | null {
  if (!raw) return null
  const parsed = parseStoredJson(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const value = parsed as { savedAt?: unknown; version?: unknown; library?: unknown }
  if (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) return null
  if (!value.library || typeof value.library !== 'object') return null
  return {
    savedAt: Math.trunc(value.savedAt),
    version: typeof value.version === 'number' ? Math.trunc(value.version) : 0,
    library: value.library,
  }
}

quickAddRoutes.get('/library', async (c) => {
  const store = new QuickAddStore(c.env.DB, c.get('userId'))
  const stored = readStored(await store.readLibrary())
  return c.json({ savedAt: stored?.savedAt ?? 0, library: stored?.library ?? null })
})

quickAddRoutes.put('/library', async (c) => {
  const store = new QuickAddStore(c.env.DB, c.get('userId'))
  const body = await readJson<{ library?: unknown }>(c, JSON_BODY_LIMITS.quickAdd)
  if (typeof body.library !== 'string') throw ApiError.badRequest('The QuickAdd library must be sent as text')
  const parsed = parseQuickAddText(body.library)
  if (!parsed.data) throw ApiError.badRequest('The QuickAdd library could not be read')
  if (parsed.dropped > 0 || parsed.truncated)
    throw ApiError.badRequest('The QuickAdd library contains entries that cannot be stored')
  const savedAt = Date.now()
  const envelope = JSON.stringify({ savedAt, version: QUICKADD_VERSION, library: parsed.data } satisfies StoredLibrary)
  if (!(await store.writeLibrary(envelope))) throw ApiError.notFound('Account not found')
  return c.json({ savedAt })
})

quickAddRoutes.get('/field-values', async (c) => {
  const store = new QuickAddStore(c.env.DB, c.get('userId'))
  const name = c.req.query('name') ?? ''
  if (!name || name.length > 60) throw ApiError.badRequest('A property name is required')
  const values = await store.fieldValues({
    name,
    folder: c.req.query('folder'),
    tag: c.req.query('tag'),
    excludeTag: c.req.query('excludeTag'),
    limit: c.req.query('limit'),
  })
  return c.json({ values })
})

/** The notes a `property:field=value` capture target would write into. */
quickAddRoutes.get('/field-notes', async (c) => {
  const store = new QuickAddStore(c.env.DB, c.get('userId'))
  const name = c.req.query('name') ?? ''
  if (!name || name.length > 60) throw ApiError.badRequest('A property name is required')
  const value = c.req.query('value') ?? ''
  if (value.length > FIELD_VALUE_MAX_LENGTH) throw ApiError.badRequest('That property value is too long to match')
  const notes = await store.fieldNotes({
    name,
    value,
    folder: c.req.query('folder'),
    tag: c.req.query('tag'),
    excludeTag: c.req.query('excludeTag'),
    limit: c.req.query('limit'),
  })
  return c.json({ notes })
})
