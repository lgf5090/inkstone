import { Hono } from 'hono'
import type { Context } from 'hono'
import { LIMITS } from '@shared/constants'
import { isUsableTagName, tagKey } from '@shared/markdown-utils'
import { organizerColorOrNull } from '@shared/organizer-colors'
import type { AppBindings } from '../env'
import { assertOrganizerQuota } from '../db/quota'
import { toTag } from '../db/rows'
import {
  applyTagFamily,
  planTagFamily,
  rewriteTagInNotes,
  TagsStore,
} from '../tags/store'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { broadcastCursor, scheduleFtsDrain } from '../lib/notify'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'

/**
 * The note-body rewrite, kept addressable from this module because `lib/rewrite-drain.ts` and the MCP
 * library reach it through the tags route. The SQL itself lives in `tags/store.ts`.
 */
export { rewriteTagInNotes } from '../tags/store'

export const tagsRoutes = new Hono<AppBindings>()

tagsRoutes.use('*', requireAuth)

/**
 * The persistence layer for these routes, bound to the account the request authenticated as.
 *
 * Same shape as `routes/notes.ts`: the route parses and validates, asks the store for a record, and
 * turns that record into a response; no statement is built here.
 */
function store(c: Context<AppBindings>): TagsStore {
  return new TagsStore(c.env.DB, c.get('userId'))
}

tagsRoutes.get('/', async (c) => {
  const rows = await store(c).listTags()
  return c.json({ tags: rows.map(toTag) })
})

tagsRoutes.post('/', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<{ id?: string; name?: string; color?: string | null }>(
    c,
    JSON_BODY_LIMITS.small,
  )
  if (typeof body.name !== 'string') throw ApiError.badRequest('name must be a string')
  if (body.id !== undefined && !isValidId(body.id)) {
    throw ApiError.badRequest('id must be a valid tag id')
  }
  if (body.color !== undefined && body.color !== null && !organizerColorOrNull(body.color)) {
    throw ApiError.badRequest('Tag color is not supported')
  }
  const name = body.name.trim().replace(/^#+/, '')
  if (!name) throw ApiError.badRequest('Tag name cannot be empty')
  if (name.length > LIMITS.tagNameMaxLength) throw ApiError.badRequest('Tag name is too long')
  if (!isUsableTagName(name)) throw ApiError.badRequest('Tag names cannot contain spaces or #')

  const id = body.id ?? newId()
  const s = store(c)
  if (body.id) {
    const existing = await loadTag(s, id)
    if (existing) return c.json(existing)
    if (await s.idTakenByAnyone(id)) throw ApiError.conflict('This tag id is already in use')
  }
  if (await s.hasTagNamed(name)) throw ApiError.conflict('A tag with this name already exists')

  await assertOrganizerQuota(c.env.DB, userId, 'tag')
  const now = Date.now()
  const { created, changeSeq, row } = await s.createTag({
    id,
    name,
    color: organizerColorOrNull(body.color),
    now,
  })
  if (!created) throw ApiError.conflict('A tag with this name already exists')
  await broadcastCursor(c, changeSeq)
  return c.json(toTag(row!), 201)
})

tagsRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const body = await readJson<{ name?: string; color?: string | null; isPinned?: boolean }>(c, JSON_BODY_LIMITS.small)
  if (body.isPinned !== undefined && typeof body.isPinned !== 'boolean') {
    throw ApiError.badRequest('isPinned must be a boolean')
  }
  if (typeof body.name === 'string' && body.isPinned !== undefined) {
    throw ApiError.badRequest('Rename and pinning have to be sent as separate requests')
  }

  const s = store(c)
  const tag = await s.tagCore(id)
  if (!tag) throw ApiError.notFound('Tag not found')

  if (body.color !== undefined && body.color !== null && typeof body.color !== 'string') {
    throw ApiError.badRequest('color must be a string or null')
  }
  if (typeof body.color === 'string' && !/^#[0-9a-f]{6}$/i.test(body.color)) {
    throw ApiError.badRequest('color must be a six-digit hexadecimal color')
  }
  if (body.name !== undefined && typeof body.name !== 'string') {
    throw ApiError.badRequest('name must be a string')
  }

  const color = body.color === undefined ? tag.color : body.color
  const explicitColor = (body.color !== undefined ? 1 : 0) as 0 | 1
  const ftsEnabled = c.get('database').ftsEnabled

  if (typeof body.name === 'string') {
    const next = body.name.trim().replace(/^#+/, '')
    if (!next) throw ApiError.badRequest('Tag name cannot be empty')
    if (next.length > LIMITS.tagNameMaxLength) throw ApiError.badRequest('Tag name is too long')
    if (!isUsableTagName(next)) throw ApiError.badRequest('Tag names cannot contain spaces or #')

    if (next !== tag.name) {
      // The family snapshot doubles as the descendant probe: the root is always a step (next
      // differs from its name), so more than one step means a subtree has to move with it.
      // A parent rename that left `a/x` behind would orphan the whole subtree.
      const plan = await planTagFamily(c.env.DB, userId, { id, name: tag.name }, next)
      if (plan.length > 1) {
        const overflow = plan.find((step) => step.to.length > LIMITS.tagNameMaxLength)
        if (overflow) {
          throw ApiError.badRequest(`Renaming this tag would push "${overflow.to}" past ${LIMITS.tagNameMaxLength} characters`)
        }
        // Merging into an existing `next` is still allowed: the batch copies onto the
        // destination row rather than refusing.
        const applied = await applyTagFamily(c.env, ftsEnabled, userId, plan, color)
        await broadcastCursor(c)
        scheduleFtsDrain(c)
        return c.json({ ok: true as const, renamed: applied.rewritten, moved: applied.moved })
      }
      const existing = await s.findRenameDestination(next, id)
      const destinationName = existing?.name ?? next
      const rewrite = await rewriteTagInNotes(c.env, ftsEnabled, userId, id, tag.name, destinationName)
      const now = Date.now()
      const rewrittenDestination = await s.findOldestByName(destinationName)
      if (rewrittenDestination?.id === id) {
        try {
          const renamed = await s.applyDirectRename({
            sourceId: id, from: tag.name, to: destinationName, color, explicitColor, now,
          })
          if (!renamed) {
            throw ApiError.conflict('The tag changed elsewhere. Refresh and try again')
          }
        } catch (error) {
          try {
            await rewrite.rollback()
          } catch {
            throw ApiError.conflict('Tag rename could not be rolled back safely; refresh and try again')
          }
          throw error
        }
        await broadcastCursor(c)
        scheduleFtsDrain(c)
        return c.json({ ok: true, renamed: rewrite.rewritten })
      }
      try {
        const merged = await s.mergeRenamedTag({
          sourceId: id,
          from: tag.name,
          to: destinationName,
          color,
          explicitColor,
          now,
          targetId: newId(),
        })
        if (!merged) {
          throw ApiError.conflict('The tag changed elsewhere. Refresh and try again')
        }
      } catch (error) {
        try {
          await rewrite.rollback()
        } catch {
          throw ApiError.conflict('Tag rename could not be rolled back safely; refresh and try again')
        }
        throw error
      }
      await broadcastCursor(c)
      scheduleFtsDrain(c)
      return c.json({ ok: true, renamed: rewrite.rewritten })
    }
  }

  if (typeof body.isPinned === 'boolean' && body.isPinned !== (tag.is_pinned === 1)) {
    const now = Date.now()
    const pinned = body.isPinned ? 1 : 0
    const { applied, changeSeq } = await s.setPinned({ id, name: tag.name, from: tag.is_pinned, to: pinned, now })
    if (!applied) throw ApiError.conflict('The tag changed elsewhere. Refresh and try again')
    await broadcastCursor(c, changeSeq)
  }

  if (color !== tag.color) {
    const now = Date.now()
    const { applied, changeSeq } = await s.setColor({ id, name: tag.name, color, previous: tag.color, now })
    if (!applied) throw ApiError.conflict('The tag changed elsewhere. Refresh and try again')
    await broadcastCursor(c, changeSeq)
  }
  const row = await s.tagRow(id)
  return c.json(row ? toTag(row) : { ok: true })
})

tagsRoutes.post('/:id/move', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const body = await readJson<{ parent?: string | null }>(c, JSON_BODY_LIMITS.small)
  if (body.parent === undefined) throw ApiError.badRequest('parent is required')
  if (body.parent !== null && typeof body.parent !== 'string') {
    throw ApiError.badRequest('parent must be a string or null')
  }
  const parent = body.parent === null ? '' : body.parent.trim().replace(/^#+/, '')
  if (body.parent !== null && !parent) throw ApiError.badRequest('parent cannot be empty')
  if (parent && !isUsableTagName(parent)) throw ApiError.badRequest('Tag names cannot contain spaces or #')

  const tag = await loadTag(store(c), id)
  if (!tag) throw ApiError.notFound('Tag not found')
  const s = store(c)

  const leaf = tag.name.split('/').filter(Boolean).at(-1)!
  const destination = parent ? `${parent}/${leaf}` : leaf
  if (destination === tag.name) return c.json({ ok: true as const, moved: 0 })
  if (isWithin(destination, tag.name)) throw ApiError.badRequest('A tag cannot be moved inside itself')

  const plan = await planTagFamily(c.env.DB, userId, { id, name: tag.name }, destination)
  const destinations = plan.map((step) => step.to)
  const familyIds = new Set(plan.map((step) => step.id))
  const rowsByName = new Map<string, string[]>()
  // One IN query per chunk of names instead of two round trips per step; see `findRowsNamed`.
  for (const row of await s.findRowsNamed(destinations)) {
    const key = tagKey(row.name)
    const bucket = rowsByName.get(key)
    if (bucket) bucket.push(row.id)
    else rowsByName.set(key, [row.id])
  }
  for (const step of plan) {
    if (step.to.length > LIMITS.tagNameMaxLength) {
      throw ApiError.badRequest(`Moving this tag would push "${step.to}" past ${LIMITS.tagNameMaxLength} characters`)
    }
    const rows = rowsByName.get(tagKey(step.to))
    if (rows?.some((rowId) => !familyIds.has(rowId))) {
      throw ApiError.conflict(`A tag named "${step.to}" already exists`)
    }
  }
  if (!plan.length) return c.json({ ok: true as const, moved: 0 })

  const applied = await applyTagFamily(c.env, c.get('database').ftsEnabled, userId, plan)
  await broadcastCursor(c)
  scheduleFtsDrain(c)
  return c.json({ ok: true as const, moved: applied.moved })
})

tagsRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const s = store(c)

  const tag = await s.tagName(id)
  if (!tag) throw ApiError.notFound('Tag not found')

  const rewrite = await rewriteTagInNotes(c.env, c.get('database').ftsEnabled, userId, id, tag.name, null)

  const now = Date.now()
  try {
    if (!await s.deleteTag({ id, name: tag.name, now })) {
      throw ApiError.conflict('The tag changed elsewhere. Refresh and try again')
    }
  } catch (error) {
    try {
      await rewrite.rollback()
    } catch {
      throw ApiError.conflict('Tag deletion could not be rolled back safely; refresh and try again')
    }
    throw error
  }
  await broadcastCursor(c)
  scheduleFtsDrain(c)
  return c.json({ ok: true, affected: rewrite.rewritten })
})

function isWithin(name: string, ancestor: string): boolean {
  const lower = tagKey(name)
  const want = tagKey(ancestor)
  return lower === want || lower.startsWith(`${want}/`)
}

async function loadTag(s: TagsStore, id: string): Promise<ReturnType<typeof toTag> | null> {
  const row = await s.tagRow(id)
  return row ? toTag(row) : null
}
