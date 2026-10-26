import { Hono, type Context } from 'hono'
import {
  type HubAttachmentListParams,
  type HubAttachmentSizeRange,
  type AttachmentHubScope,
  type HubAttachmentSort,
  type HubAttachmentType,
  isAttachmentHubScope,
} from '@shared/attachment-hub'
import { attachmentQuotaBytesForEnv } from '../attachments/backend'
import { drainAttachmentCleanup } from '../attachments/cleanup'
import {
  deleteHubRow,
  getHubAttachment,
  listHubAttachments,
  listHubOwners,
  loadHubRowForDeletion,
  patchHubRow,
  pruneHubAttachments,
} from '../attachments/hub-rows'
import { uploadHubFile } from '../attachments/hub-upload'
import {
  createHubFolder,
  createHubTag,
  deleteHubFolder,
  deleteHubTag,
  listHubFolders,
  listHubTags,
  updateHubFolder,
  updateHubTag,
  type HubFolderInput,
  type HubTagInput,
} from '../attachments/organizer'
import { isAttachmentScope } from '../attachments/scopes'
import { sanitizeAttachmentFilename } from '../attachments/storage'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import {
  FORM_BODY_LIMITS,
  JSON_BODY_LIMITS,
  readFormDataWithinLimit,
  readJson,
} from '../lib/request'
import { requireAuth } from '../middleware/auth'

/**
 * The attachment hub: one organiser surface for four applications.
 *
 * There is no SQL in this file, by guard as well as by choice — `tests/worker-layering.test.ts`
 * rejects a route that prepares a statement. The reason that matters here is that these rules are
 * shared with each application's own door, so a check written in a handler would apply to the hub
 * and not to the note editor that can delete the same row.
 */

export const attachmentHubRoutes = new Hono<AppBindings>()

type Ctx = Context<AppBindings>

const TYPES: readonly HubAttachmentType[] = ['image', 'pdf', 'document', 'media', 'archive', 'code']
const SIZES: readonly HubAttachmentSizeRange[] = ['small', 'medium', 'large']
const SORTS: readonly HubAttachmentSort[] = [
  'date_desc',
  'date_asc',
  'name_asc',
  'name_desc',
  'size_desc',
  'size_asc',
]
const ACTIONS = ['move', 'star', 'pin', 'tag', 'delete'] as const
const BATCH_MAX = 100
const TAG_MAX = 100
const TAG_LENGTH_MAX = 100

attachmentHubRoutes.use('*', requireAuth)

/**
 * Resolves the path segment against the registry.
 *
 * The scope names a table and an object prefix downstream, so it is the one client-supplied string
 * in this file that must never reach a statement — an unrecognised value is a 404 here rather than
 * a query shape somebody else chooses.
 */
function scopeOf(c: Ctx): AttachmentHubScope {
  const scope = c.req.param('scope')
  if (!isAttachmentScope(scope) || !isAttachmentHubScope(scope)) {
    throw ApiError.notFound('Unknown attachment scope')
  }
  if (scope === 'email' && c.get('user')?.role !== 'owner') {
    throw ApiError.forbidden('Email attachments are available to the owner only')
  }
  return scope
}

function body(c: Ctx): Promise<Record<string, unknown>> {
  return readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.attachmentHub)
}

function flag(value: string | null): boolean | undefined {
  return value === '1' || value === 'true' ? true : undefined
}

function num(value: string | null): number | undefined {
  if (value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

function listParams(search: URLSearchParams): HubAttachmentListParams {
  const folderId = search.get('folderId')
  return {
    folderId: folderId ?? undefined,
    type: oneOf(search.get('type'), TYPES),
    sizeRange: oneOf(search.get('sizeRange'), SIZES),
    sort: oneOf(search.get('sort'), SORTS),
    minBytes: num(search.get('minBytes')),
    maxBytes: num(search.get('maxBytes')),
    limit: num(search.get('limit')),
    tag: search.get('tag') ?? undefined,
    extension: search.get('extension') ?? undefined,
    search: search.get('search') ?? undefined,
    cursor: search.get('cursor') ?? undefined,
    starred: flag(search.get('starred')),
    pinned: flag(search.get('pinned')),
    unreferenced: flag(search.get('unreferenced')),
  }
}

attachmentHubRoutes.get('/:scope/files', async (c) => {
  const scope = scopeOf(c)
  const result = await listHubAttachments(c.env.DB, c.get('userId'), scope, listParams(new URL(c.req.url).searchParams), attachmentQuotaBytesForEnv(c.env))
  return c.json(result)
})

attachmentHubRoutes.post('/:scope/files', async (c) => {
  const scope = scopeOf(c)
  const userId = c.get('userId')
  const form = await readFormDataWithinLimit(c.req, FORM_BODY_LIMITS.attachment)
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('No file was uploaded')
  const folderIdRaw = form.get('folderId')
  const folderId = typeof folderIdRaw === 'string' && isValidId(folderIdRaw) ? folderIdRaw : null
  const stored = await uploadHubFile(c.env, {
    userId,
    scope,
    bytes: new Uint8Array(await file.arrayBuffer()),
    filename: file.name,
    mime: file.type,
    folderId,
  })
  return c.json(stored, 201)
})

attachmentHubRoutes.post('/:scope/files/batch', async (c) => {
  const scope = scopeOf(c)
  const userId = c.get('userId')
  const input = await body(c)
  const action = oneOf(typeof input.action === 'string' ? input.action : null, ACTIONS)
  if (!action) throw ApiError.badRequest('Unsupported batch action')
  const rawIds = Array.isArray(input.ids) ? input.ids : []
  if (!rawIds.length || rawIds.length > BATCH_MAX) {
    throw ApiError.badRequest(`Select between 1 and ${BATCH_MAX} files`)
  }
  const ids = rawIds.filter((id): id is string => typeof id === 'string' && isValidId(id))
  if (!ids.length) throw ApiError.badRequest('No valid file ids')

  let count = 0
  for (const id of ids) {
    if (await applyBatch(c, scope, userId, id, action, input)) count++
  }
  return c.json({ ok: true, count })
})

attachmentHubRoutes.post('/:scope/files/prune', async (c) => {
  const scope = scopeOf(c)
  const userId = c.get('userId')
  if (scope === 'email') {
    return c.json({ supported: false, removed: 0, freedBytes: 0, cleanupPending: false })
  }
  const outcome = await pruneHubAttachments(c.env.DB, userId, scope)
  const drained = await drainAttachmentCleanup(c.env, userId, 500).catch(() => null)
  return c.json({
    supported: true,
    removed: outcome.removed,
    freedBytes: outcome.freedBytes,
    cleanupPending: Boolean(drained?.pending),
  })
})

attachmentHubRoutes.get('/:scope/files/:id/owners', async (c) => {
  const scope = scopeOf(c)
  const id = c.req.param('id') ?? ''
  if (!isValidId(id)) throw ApiError.notFound('Attachment not found')
  return c.json({ owners: await listHubOwners(c.env.DB, c.get('userId'), scope, id) })
})

attachmentHubRoutes.patch('/:scope/files/:id', async (c) => {
  const scope = scopeOf(c)
  const userId = c.get('userId')
  const id = c.req.param('id') ?? ''
  if (!isValidId(id)) throw ApiError.notFound('Attachment not found')
  const input = await body(c)
  const patch: Parameters<typeof patchHubRow>[4] = {}

  if (typeof input.filename === 'string' && input.filename.trim()) {
    patch.filename = sanitizeAttachmentFilename(input.filename)
  }
  if (input.folderId !== undefined) {
    if (input.folderId === null) patch.folderId = null
    else if (typeof input.folderId === 'string' && isValidId(input.folderId)) {
      const folders = await listHubFolders(c.env.DB, userId, scope)
      if (!folders.some((folder) => folder.id === input.folderId)) {
        throw ApiError.badRequest('Unknown folder')
      }
      patch.folderId = input.folderId
    } else throw ApiError.badRequest('Unknown folder')
  }
  if (typeof input.isStarred === 'boolean') patch.isStarred = input.isStarred
  if (typeof input.isPinned === 'boolean') patch.isPinned = input.isPinned
  if (Array.isArray(input.tags)) patch.tags = cleanTags(input.tags)

  if (!Object.keys(patch).length) throw ApiError.badRequest('Nothing to change')
  if (!(await patchHubRow(c.env.DB, userId, scope, id, patch))) {
    throw ApiError.notFound('Attachment not found')
  }
  const updated = await getHubAttachment(c.env.DB, userId, scope, id)
  if (!updated) throw ApiError.notFound('Attachment not found')
  return c.json(updated)
})

attachmentHubRoutes.delete('/:scope/files/:id', async (c) => {
  const scope = scopeOf(c)
  const userId = c.get('userId')
  const id = c.req.param('id') ?? ''
  if (!isValidId(id)) throw ApiError.notFound('Attachment not found')
  if (!(await loadHubRowForDeletion(c.env.DB, userId, scope, id))) {
    throw ApiError.notFound('Attachment not found')
  }
  if (!(await deleteHubRow(c.env.DB, userId, scope, id))) {
    throw ApiError.conflict('This file is still in use')
  }
  const drained = await drainAttachmentCleanup(c.env, userId, 500).catch(() => null)
  return c.json({ ok: true, cleanupPending: Boolean(drained?.pending) })
})

attachmentHubRoutes.get('/:scope/folders', async (c) =>
  c.json(await listHubFolders(c.env.DB, c.get('userId'), scopeOf(c))),
)

attachmentHubRoutes.post('/:scope/folders', async (c) => {
  const scope = scopeOf(c)
  return c.json(await createHubFolder(c.env.DB, c.get('userId'), scope, await folderInput(c)), 201)
})

attachmentHubRoutes.patch('/:scope/folders/:id', async (c) => {
  const scope = scopeOf(c)
  const input = await folderInput(c)
  return c.json(await updateHubFolder(c.env.DB, c.get('userId'), scope, c.req.param('id') ?? '', input))
})

attachmentHubRoutes.delete('/:scope/folders/:id', async (c) => {
  const scope = scopeOf(c)
  const removed = await deleteHubFolder(c.env.DB, c.get('userId'), scope, c.req.param('id') ?? '')
  if (!removed) throw ApiError.notFound('Folder not found')
  return c.json({ ok: true })
})

attachmentHubRoutes.get('/:scope/tags', async (c) => c.json(await listHubTags(c.env.DB, c.get('userId'), scopeOf(c))))

attachmentHubRoutes.post('/:scope/tags', async (c) => {
  const scope = scopeOf(c)
  return c.json(await createHubTag(c.env.DB, c.get('userId'), scope, await tagInput(c)), 201)
})

attachmentHubRoutes.patch('/:scope/tags/:id', async (c) => {
  const scope = scopeOf(c)
  const input = await tagInput(c)
  return c.json(await updateHubTag(c.env.DB, c.get('userId'), scope, c.req.param('id') ?? '', input))
})

attachmentHubRoutes.delete('/:scope/tags/:id', async (c) => {
  const scope = scopeOf(c)
  const removed = await deleteHubTag(c.env.DB, c.get('userId'), scope, c.req.param('id') ?? '')
  if (!removed) throw ApiError.notFound('Tag not found')
  return c.json({ ok: true })
})

async function folderInput(c: Ctx): Promise<HubFolderInput> {
  const input = await body(c)
  const position = typeof input.position === 'number' ? input.position : undefined
  return {
    id: typeof input.id === 'string' ? input.id : undefined,
    name: typeof input.name === 'string' ? input.name : undefined,
    parentId: input.parentId === null ? null : typeof input.parentId === 'string' ? input.parentId : undefined,
    color: input.color === null ? null : typeof input.color === 'string' ? input.color : undefined,
    icon: input.icon === null ? null : typeof input.icon === 'string' ? input.icon : undefined,
    position,
  }
}

async function tagInput(c: Ctx): Promise<HubTagInput> {
  const input = await body(c)
  return {
    id: typeof input.id === 'string' ? input.id : undefined,
    name: typeof input.name === 'string' ? input.name : undefined,
    color: input.color === null ? null : typeof input.color === 'string' ? input.color : undefined,
    isPinned: typeof input.isPinned === 'boolean' ? input.isPinned : undefined,
  }
}

function cleanTags(values: unknown[]): string[] {
  return values
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim().slice(0, TAG_LENGTH_MAX))
    .filter(Boolean)
    .slice(0, TAG_MAX)
}

async function applyBatch(
  c: Ctx,
  scope: AttachmentHubScope,
  userId: string,
  id: string,
  action: (typeof ACTIONS)[number],
  input: Record<string, unknown>,
): Promise<boolean> {
  switch (action) {
    case 'move': {
      const folderId =
        input.folderId === null ? null : typeof input.folderId === 'string' && isValidId(input.folderId) ? input.folderId : null
      return patchHubRow(c.env.DB, userId, scope, id, { folderId })
    }
    case 'star':
      return patchHubRow(c.env.DB, userId, scope, id, { isStarred: input.isStarred !== false })
    case 'pin':
      return patchHubRow(c.env.DB, userId, scope, id, { isPinned: input.isPinned !== false })
    case 'tag':
      return Array.isArray(input.tags)
        ? patchHubRow(c.env.DB, userId, scope, id, { tags: cleanTags(input.tags) })
        : false
    case 'delete':
      if (!(await loadHubRowForDeletion(c.env.DB, userId, scope, id))) return false
      return deleteHubRow(c.env.DB, userId, scope, id)
  }
}
