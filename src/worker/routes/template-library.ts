import { Hono } from 'hono'
import { parseTemplateLibraryExport, type TemplateLibraryExport } from '@shared/note-templates'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { parseStoredJson } from '../lib/json'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { TemplateLibraryStore } from '../templates/library-store'

export const templateLibraryRoutes = new Hono<AppBindings>()

templateLibraryRoutes.use('*', requireAuth)

/** Envelope stored in `users.template_library`: when the account last saved, plus the library. */
interface StoredLibrary {
  savedAt: number
  library: TemplateLibraryExport
}

function readStored(raw: string | null): StoredLibrary | null {
  if (!raw) return null
  const parsed = parseStoredJson(raw)
  if (!parsed || typeof parsed !== 'object') return null
  const value = parsed as { savedAt?: unknown; library?: unknown }
  if (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) return null
  if (!value.library || typeof value.library !== 'object') return null
  return { savedAt: Math.trunc(value.savedAt), library: value.library as TemplateLibraryExport }
}

templateLibraryRoutes.get('/library', async (c) => {
  const store = new TemplateLibraryStore(c.env.DB, c.get('userId'))
  const stored = readStored(await store.readLibrary())
  return c.json({ savedAt: stored?.savedAt ?? 0, library: stored?.library ?? null })
})

templateLibraryRoutes.put('/library', async (c) => {
  const store = new TemplateLibraryStore(c.env.DB, c.get('userId'))
  const body = await readJson<{ library?: unknown }>(c, JSON_BODY_LIMITS.templateLibrary)
  if (typeof body.library !== 'string') throw ApiError.badRequest('The template library must be sent as text')
  const parsed = parseTemplateLibraryExport(body.library, { keepFlags: true })
  if (!parsed.data) throw ApiError.badRequest('The template library could not be read')
  if (parsed.dropped > 0 || parsed.truncated) throw ApiError.badRequest('The template library contains entries that cannot be stored')
  const savedAt = Date.now()
  const envelope = JSON.stringify({ savedAt, library: parsed.data } satisfies StoredLibrary)
  if (!(await store.writeLibrary(envelope))) throw ApiError.notFound('Account not found')
  return c.json({ savedAt })
})
