import { Hono } from 'hono'
import { parseQuickAddText, QUICKADD_VERSION } from '@shared/quickadd'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'

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
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
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
  const userId = c.get('userId')
  const row = await c.env.DB.prepare('SELECT quickadd FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ quickadd: string | null }>()
  const stored = readStored(row?.quickadd ?? null)
  return c.json({ savedAt: stored?.savedAt ?? 0, library: stored?.library ?? null })
})

quickAddRoutes.put('/library', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<{ library?: unknown }>(c, JSON_BODY_LIMITS.quickAdd)
  if (typeof body.library !== 'string') throw ApiError.badRequest('The QuickAdd library must be sent as text')
  const parsed = parseQuickAddText(body.library)
  if (!parsed.data) throw ApiError.badRequest('The QuickAdd library could not be read')
  if (parsed.dropped > 0 || parsed.truncated)
    throw ApiError.badRequest('The QuickAdd library contains entries that cannot be stored')
  const savedAt = Date.now()
  const envelope = JSON.stringify({ savedAt, version: QUICKADD_VERSION, library: parsed.data } satisfies StoredLibrary)
  const result = await c.env.DB.prepare('UPDATE users SET quickadd = ?1 WHERE id = ?2')
    .bind(envelope, userId)
    .run()
  if ((result.meta?.changes ?? 0) === 0) throw ApiError.notFound('Account not found')
  return c.json({ savedAt })
})
