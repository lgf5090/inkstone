import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppBindings } from '../env'
import { requireAuth } from '../middleware/auth'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { JSON_BODY_LIMITS, clampInt, readJson } from '../lib/request'
import {
  ShareOrganizer,
  shareBatchNoteIds,
  shareEnabledFlag,
  shareFilingWrite,
  toShareFolder,
  toShareTag,
} from '../share/organizer'
import { readShareAudit, shareAuditPageLimit } from '../share/audit'

/**
 * The share hub's organizer endpoints: the folder tree and the tag list a published link is filed
 * under, the filing writes themselves, and the batch actions a hub selection runs.
 *
 * This file does three things and no more: it reads a body, hands the values to `ShareOrganizer`, and
 * turns the row that comes back into the shape the hub holds. Every rule — the depth of the tree, which
 * tag names exist, how many links a batch may name — is the organizer's, so the notebook's organizer and
 * this one cannot drift into meaning different things by the time somebody reads them both.
 *
 * Mounted under `/api/share` behind `requireAuth`, and it asks for that middleware itself too: an
 * organizer that answered the account that was already in the request would be a way to file somebody
 * else's links.
 */

export const shareOrganizerRoutes = new Hono<AppBindings>()

shareOrganizerRoutes.use('*', requireAuth)

/** The page's ceiling on how deep a hub may ask for history to go. */
const AUDIT_PAGE_MAX = 100

function organizer(c: Context<AppBindings>): ShareOrganizer {
  return new ShareOrganizer(c.env.DB, c.get('userId'))
}

/** The id in the path, or the same 404 a foreign one gets: no route here tells the two apart. */
function pathId(value: string | undefined, label: string): string {
  if (!value || !isValidId(value)) throw ApiError.notFound(`The ${label} does not exist`)
  return value
}

shareOrganizerRoutes.get('/folders', async (c) => {
  const folders = await organizer(c).listFolders()
  return c.json({ folders: folders.map(toShareFolder) })
})

shareOrganizerRoutes.post('/folders', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const folder = await organizer(c).createFolder({
    name: body.name,
    parentId: body.parentId,
    icon: body.icon,
    color: body.color,
    position: body.position,
  })
  return c.json(toShareFolder(folder), 201)
})

shareOrganizerRoutes.patch('/folders/:id', async (c) => {
  const id = pathId(c.req.param('id'), 'folder')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const row = await organizer(c).patchFolder(id, {
    name: body.name,
    parentId: body.parentId,
    icon: body.icon,
    color: body.color,
    position: body.position,
  })
  if (!row) throw ApiError.notFound('Folder not found')
  return c.json(toShareFolder(row))
})

/**
 * Deleting a folder answers the same way whether it held links or not.
 *
 * The organizer's batch detaches the links it held, so the count is what the hub can show as the reason
 * a folder's links went unfiled — but the response never names them.
 */
shareOrganizerRoutes.delete('/folders/:id', async (c) => {
  const id = pathId(c.req.param('id'), 'folder')
  if (!(await organizer(c).deleteFolder(id))) throw ApiError.notFound('Folder not found')
  return c.json({ ok: true })
})

shareOrganizerRoutes.get('/tags', async (c) => {
  const tags = await organizer(c).listTags()
  return c.json({ tags: tags.map(toShareTag) })
})

shareOrganizerRoutes.post('/tags', async (c) => {
  const body = await readJson<{ name?: unknown; color?: unknown }>(c, JSON_BODY_LIMITS.small)
  const tag = await organizer(c).createTag(body.name, body.color)
  return c.json(toShareTag(tag), 201)
})

/**
 * A tag write, and the link rewrite that came with it.
 *
 * `rewritten` is the count of links whose stored tag name moved. A rename is exactly that visible in
 * the hub's own list, and an answer that left it out would have the client reload the whole list to work
 * out whether anything happened.
 */
shareOrganizerRoutes.patch('/tags/:id', async (c) => {
  const id = pathId(c.req.param('id'), 'tag')
  const body = await readJson<{ name?: unknown; color?: unknown; isPinned?: unknown }>(c, JSON_BODY_LIMITS.small)
  const { row, rewritten } = await organizer(c).patchTag(id, body)
  if (!row) throw ApiError.notFound('Tag not found')
  return c.json({ tag: toShareTag(row), rewritten })
})

shareOrganizerRoutes.delete('/tags/:id', async (c) => {
  const id = pathId(c.req.param('id'), 'tag')
  const { removed, rewritten } = await organizer(c).deleteTag(id)
  if (!removed) throw ApiError.notFound('Tag not found')
  return c.json({ ok: true, rewritten })
})

/**
 * Files one link: its folder and its whole tag list, as the panel's dialog holds them.
 *
 * A tag name the account does not own is a 400 that says which, rather than a write that stores a name
 * nothing can ever select again.
 */
shareOrganizerRoutes.put('/note/:noteId/organize', async (c) => {
  const noteId = pathId(c.req.param('noteId'), 'note')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const filing = await organizer(c).organizeNote(noteId, shareFilingWrite(body))
  if (!filing) throw ApiError.notFound('This note has no share link')
  return c.json({ filing })
})

/** Applies one folder and one tag list to a hub selection. */
shareOrganizerRoutes.post('/batch/organize', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const noteIds = shareBatchNoteIds(body.noteIds)
  const count = await organizer(c).batchOrganize(noteIds, shareFilingWrite(body))
  return c.json({ ok: true, count })
})

/** Pauses or resumes a hub selection. */
shareOrganizerRoutes.post('/batch/enabled', async (c) => {
  const body = await readJson<{ noteIds?: unknown; enabled?: unknown }>(c, JSON_BODY_LIMITS.small)
  const noteIds = shareBatchNoteIds(body.noteIds)
  const count = await organizer(c).batchEnabled(noteIds, shareEnabledFlag(body.enabled))
  return c.json({ ok: true, count })
})

/**
 * Revokes a hub selection.
 *
 * The count is the number of links that stopped existing, so a selection that had already lost some of
 * them says so rather than promising the whole list went.
 */
shareOrganizerRoutes.post('/batch/revoke', async (c) => {
  const body = await readJson<{ noteIds?: unknown }>(c, JSON_BODY_LIMITS.small)
  const noteIds = shareBatchNoteIds(body.noteIds)
  const count = await organizer(c).batchRevoke(noteIds)
  return c.json({ ok: true, count })
})

/**
 * One page of one link's history, newest first.
 *
 * The read is scoped by both the account and the note, so another account's link answers with the same
 * empty page a link that never had a share does — history is not a way to ask whether somebody else owns
 * a note id.
 */
shareOrganizerRoutes.get('/audit/:noteId', async (c) => {
  const noteId = pathId(c.req.param('noteId'), 'note')
  const page = clampInt(c.req.query('page'), 1, AUDIT_PAGE_MAX, 1)
  const limit = shareAuditPageLimit(c.req.query('limit'))
  const organizerId = c.get('userId')
  return c.json(await readShareAudit(c.env.DB, organizerId, noteId, page, limit))
})
