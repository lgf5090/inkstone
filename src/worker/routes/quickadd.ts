import { Hono } from 'hono'
import { parseQuickAddText, QUICKADD_VERSION } from '@shared/quickadd'
import { parseFrontMatter } from '@shared/markdown-utils'
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

/** A property's values across the newest notes, for `{{FIELD:property}}` suggestions.
 *
 * The schema has no property index, so this reads note text and parses it. Two things bound the cost:
 * the scan stops at the newest few hundred notes, and `folder:` matches the note's own folder name
 * rather than walking the tree — a value list is a convenience, and a slow one is worse than the
 * author typing the word.
 */
const FIELD_SCAN_LIMIT = 400
const FIELD_VALUE_LIMIT = 200
const FIELD_VALUE_MAX_LENGTH = 200

function clampCount(value: string | undefined, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return max
  return Math.min(Math.trunc(parsed), max)
}

function collectValues(content: unknown, name: string, into: Map<string, number>): void {
  if (typeof content !== 'string' || !content) return
  const parsed = parseFrontMatter(content)
  if (parsed.errors.length) return
  const value = parsed.data[name] ?? parsed.data[name.toLowerCase()] ?? Object.entries(parsed.data)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  const items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
  for (const item of items) {
    if (typeof item === 'object') continue
    const text = String(item).trim()
    if (!text || text.length > FIELD_VALUE_MAX_LENGTH) continue
    const key = text.toLocaleLowerCase()
    into.set(key, (into.get(key) ?? 0) + 1)
  }
}

quickAddRoutes.get('/field-values', async (c) => {
  const userId = c.get('userId')
  const name = c.req.query('name') ?? ''
  if (!name || name.length > 60) throw ApiError.badRequest('A property name is required')
  const folder = c.req.query('folder')
  const tag = c.req.query('tag')
  const excludeTag = c.req.query('excludeTag')
  const limit = clampCount(c.req.query('limit'), FIELD_VALUE_LIMIT)

  const where = ['n.user_id = ?1', 'n.deleted_at IS NULL']
  const args: string[] = [userId]
  if (folder) {
    where.push('EXISTS (SELECT 1 FROM folders f WHERE f.id = n.folder_id AND LOWER(f.name) = ?' + String(args.length + 1) + ')')
    args.push(folder.toLocaleLowerCase())
  }
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM note_tags nt JOIN tags tg ON tg.id = nt.tag_id WHERE nt.note_id = n.id AND LOWER(tg.name) = ?' + String(args.length + 1) + ')')
    args.push(tag.toLocaleLowerCase())
  }
  if (excludeTag) {
    where.push('NOT EXISTS (SELECT 1 FROM note_tags nt JOIN tags tg ON tg.id = nt.tag_id WHERE nt.note_id = n.id AND LOWER(tg.name) = ?' + String(args.length + 1) + ')')
    args.push(excludeTag.toLocaleLowerCase())
  }
  const rows = await c.env.DB.prepare(
    `SELECT content FROM notes n WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ${FIELD_SCAN_LIMIT}`,
  )
    .bind(...args)
    .all<{ content: string }>()

  const counts = new Map<string, number>()
  for (const row of rows.results) collectValues(row.content, name, counts)
  const values = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value)
  return c.json({ values })
})
