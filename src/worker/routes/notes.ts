import { Hono } from 'hono'
import type { Context } from 'hono'
import { LIMITS } from '@shared/constants'
import { countText, deriveExcerpt } from '@shared/markdown-utils'
import { duplicateNoteTitle, truncateText } from '@shared/text-utils'
import type {
  CreateNoteBody,
  ListNotesResponse,
  Note,
  PatchNoteBody,
  SortKey,
  SortOrder,
  ViewKind,
} from '@shared/types'
import type { AppBindings } from '../env'
import { toNote, toNoteSummary, type NoteRow } from '../db/rows'
import { assertNoteQuota } from '../db/quota'
import { rebuildDerivedFields, pruneOrphanTags } from '../db/writes'
import {
  NotesStore,
  findLinkedBacklinks,
  findUnlinkedMentions,
  linkMentionInNote,
  rewriteInboundWikiLinks,
  type NotePatchColumns,
  type NotesListCursor,
  type NoteWriteResult,
  type ParsedNotesListCursor,
} from '../notes/store'
import { acquireLease } from '../lib/lease'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'
import { fromBase64Url, fromUtf8, sha256Hex, toBase64Url, utf8 } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { broadcastCursor, scheduleFtsDrain } from '../lib/notify'
import { assertContentSize, clampInt, JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { scheduleAiDrainForNote } from '../mcp/ai-search'
import { blogOwnerUserId, findPostByNoteId, recordBlogAudit, syncBlogPostFromNote, unpublishPost } from '../blog/store'
import { syncBlogPageFromNote } from '../blog/pages'
import type { BlogNoteInput } from '../blog/store'

/**
 * The link and trash panels' shared SQL helpers, kept addressable from this module because
 * `lib/rewrite-drain.ts` and the backlink tests reach them through the notes route.
 */
export const notesRoutes = new Hono<AppBindings>()

notesRoutes.use('*', requireAuth)


const SNAPSHOT_DIFF_THRESHOLD = 400

const NOTE_VIEWS = new Set<ViewKind>(['all', 'recent', 'starred', 'pinned', 'unfiled', 'untagged', 'archived', 'trash', 'folder', 'tag'])
const NOTE_SORTS = new Set<SortKey>(['updated', 'created', 'title'])
/** Ids per dependent-table delete when emptying the trash. */
const TRASH_EMPTY_BATCH = 500

/**
 * The persistence layer for these routes, bound to the account the request authenticated as.
 *
 * Same shape as `assistant.ts`: the route parses and validates, asks the store for a record, and
 * turns that record into a response; no statement is built here.
 */
function store(c: Context<AppBindings>): NotesStore {
  return new NotesStore(c.env.DB, c.get('userId'), c.get('database').ftsEnabled)
}

/**
 * Keep the blog projection in step with the note that owns it. A failure here must not fail the
 * note write: the note is the source of truth, and the admin can retry the projection. It is still
 * recorded as an audit row so the failure is visible rather than silently swallowed.
 */
async function syncBlogForNote(c: Context<AppBindings>, note: BlogNoteInput): Promise<void> {
  const userId = c.get('userId')
  try {
    if (await blogOwnerUserId(c.env.DB) !== userId) return
    const page = await syncBlogPageFromNote(c.env.DB, userId, note)
    if (page) {
      const post = await findPostByNoteId(c.env.DB, userId, note.id)
      if (post && post.status !== 'withdrawn') await unpublishPost(c.env.DB, userId, post.id)
    } else {
      await syncBlogPostFromNote(c.env.DB, userId, note)
    }
  } catch (error) {
    console.warn('[inkstone] blog projection failed:', error)
    await recordBlogAudit(c.env.DB, userId, 'post.sync_failed', 'note', note.id, {
      message: error instanceof Error ? error.message : String(error),
    }).catch((auditError) => console.warn('[inkstone] blog sync audit failed:', auditError))
  }
}


notesRoutes.get('/', async (c) => {
  const requestedView = c.req.query('view') as ViewKind | undefined
  const requestedSort = c.req.query('sort') as SortKey | undefined
  const view = requestedView && NOTE_VIEWS.has(requestedView) ? requestedView : 'all'
  const sort = requestedSort && NOTE_SORTS.has(requestedSort) ? requestedSort : 'updated'
  const order: SortOrder = c.req.query('order') === 'asc' ? 'asc' : 'desc'
  const limit = clampInt(c.req.query('limit'), 1, 1000, 500)
  const cursor = parseNotesListCursor(c.req.query('cursor'), view, sort, order)

  const folderId = view === 'folder' ? c.req.query('folderId') : undefined
  if (view === 'folder' && !folderId) throw ApiError.badRequest('Missing folderId')

  const excludeTags = [...new Set(new URL(c.req.url).searchParams.getAll('excludeTag'))]
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, LIMITS.tagFilterMax)

  let tags: string[] | undefined
  if (view === 'tag') {
    tags = [...new Set(new URL(c.req.url).searchParams.getAll('tag'))]
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, LIMITS.tagFilterMax)
    if (!tags.length) throw ApiError.badRequest('Missing tag')
  }

  // The store returns one row past the page so the route can decide `nextCursor` from the row it
  // would have dropped, and keeps the total only when a fresh count was worth the scan.
  const { rows, total } = await store(c).list({ view, sort, order, limit, cursor, folderId, tags, excludeTags })

  const pageRows = rows.slice(0, limit)
  const notes = pageRows.map(toNoteSummary)
  const body: ListNotesResponse = {
    notes,
    total,
    nextCursor: rows.length > limit && pageRows.length
      ? encodeNotesListCursor(pageRows[pageRows.length - 1]!, view, sort, order)
      : null,
  }
  return c.json(body)
})


notesRoutes.post('/trash/empty', async (c) => {
  const userId = c.get('userId')
  const s = store(c)
  let purged = 0
  let deletionCursor: number | undefined

  // One statement per dependent table, over 500 ids at a time. The old shape inlined the same
  // unbounded `SELECT id FROM notes WHERE deleted_at IS NOT NULL` into 8 statements, so a 20k
  // note trash walked 8×20k rows inside a single D1 request and hit its CPU ceiling.
  let cursor = ''
  for (;;) {
    const ids = await s.trashedNoteIdsAfter(cursor, TRASH_EMPTY_BATCH)
    if (!ids.length) break
    cursor = ids[ids.length - 1]!
    const batchResults = await s.purgeTrashed(ids, Date.now())
    purged += batchResults.at(-1)?.meta.changes ?? 0
    if (ids.length < TRASH_EMPTY_BATCH) break
  }
  if (purged) {
    deletionCursor = await s.latestChangeSeq()
    scheduleFtsDrain(c)
  }
  await pruneOrphanTags(c.env.DB, userId)
  await broadcastCursor(c, deletionCursor)
  return c.json({ purged })
})

notesRoutes.get('/:id', async (c) => {
  return c.json(await loadNote(store(c), c.req.param('id')))
})

notesRoutes.post('/', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<CreateNoteBody>(c, JSON_BODY_LIMITS.note)

  if (body.content !== undefined && typeof body.content !== 'string') {
    throw ApiError.badRequest('content must be a string')
  }
  if (body.title !== undefined && typeof body.title !== 'string') {
    throw ApiError.badRequest('title must be a string')
  }
  if (body.folderId !== undefined && body.folderId !== null && typeof body.folderId !== 'string') {
    throw ApiError.badRequest('folderId must be a string or null')
  }
  if (body.isStarred !== undefined && typeof body.isStarred !== 'boolean') {
    throw ApiError.badRequest('isStarred must be a boolean')
  }
  if (body.id !== undefined && !isValidId(body.id)) {
    throw ApiError.badRequest('id must be a valid note id')
  }
  const content = typeof body.content === 'string' ? body.content : ''
  assertContentSize(content)

  const id = body.id ?? newId()
  if (body.id) {
    // A client-supplied id makes the create idempotent: the account's own note answers with 200,
    // another account's with 409, and only an unclaimed id is inserted.
    const s = store(c)
    const existing = await s.noteRow(id)
    if (existing) return c.json(toNote(existing))
    if (await s.idTakenByAnyone(id)) throw ApiError.conflict('This note id is already in use')
  }
  const now = Date.now()
  const title = resolveNoteTitle(body.title)
  const excerpt = deriveExcerpt(content)
  const { words, chars } = countText(content)
  // The quota read rides along with hashing instead of adding a serial round trip.
  const [hash] = await Promise.all([sha256Hex(content), assertNoteQuota(c.env.DB, userId)])
  const folderId = await resolveFolderId(c, body.folderId ?? null)

  const { row, changeSeq, created } = await store(c).create({
    id,
    folderId,
    title,
    content,
    excerpt,
    words,
    chars,
    isStarred: Boolean(body.isStarred),
    contentHash: hash,
    now,
  })
  if (!row) throw ApiError.conflict('This note id is already in use')
  await broadcastCursor(c, changeSeq)
  if (created) {
    scheduleFtsDrain(c)
    scheduleAiDrainForNote(c, userId)
  }
  const note = toNote(row)
  await syncBlogForNote(c, row)
  return c.json(note, created ? 201 : 200)
})

notesRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const { ftsEnabled } = c.get('database')
  const body = await readJson<PatchNoteBody>(c, JSON_BODY_LIMITS.note)

  const s = store(c)
  const row = await s.noteRow(id)
  if (!row) {
    throw ApiError.notFound('Note not found', { deletionCursor: await s.latestDeletionSeq(id) })
  }

  if (!Number.isInteger(body.rev) || body.rev < 1) {
    throw ApiError.badRequest('rev must be a positive integer')
  }
  if (body.rev !== row.rev) {
    throw ApiError.conflict('This note was modified elsewhere', { server: toNote(row) })
  }
  if (body.content !== undefined && typeof body.content !== 'string') {
    throw ApiError.badRequest('content must be a string')
  }
  if (body.title !== undefined && typeof body.title !== 'string') {
    throw ApiError.badRequest('title must be a string')
  }
  if (body.folderId !== undefined && body.folderId !== null && typeof body.folderId !== 'string') {
    throw ApiError.badRequest('folderId must be a string or null')
  }
  for (const [key, value] of [
    ['isPinned', body.isPinned],
    ['isStarred', body.isStarred],
    ['isArchived', body.isArchived],
    ['quiet', body.quiet],
    ['preserveVersion', body.preserveVersion],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw ApiError.badRequest(`${key} must be a boolean`)
    }
  }

  const now = Math.max(Date.now(), row.updated_at + 1)
  const columns: NotePatchColumns = {}
  let contentChanged = false
  let newTitle = row.title
  let newContent = row.content
  let newHash = row.content_hash
  const resolvedTitle = resolveNoteTitle(body.title, row.title)

  if (typeof body.content === 'string' && body.content !== row.content) {
    assertContentSize(body.content)
    const hash = await sha256Hex(body.content)
    if (hash !== row.content_hash) {
      contentChanged = true
      newHash = hash
      newContent = body.content
      newTitle = resolvedTitle
      const { words, chars } = countText(body.content)
      columns.content = body.content
      columns.content_hash = hash
      columns.title = newTitle
      columns.excerpt = deriveExcerpt(body.content)
      columns.word_count = words
      columns.char_count = chars
    }
  } else if (resolvedTitle !== row.title) {
    newTitle = resolvedTitle
    columns.title = newTitle
  }

  if (body.folderId !== undefined && body.folderId !== row.folder_id) {
    columns.folder_id = await resolveFolderId(c, body.folderId)
  }
  if (typeof body.isPinned === 'boolean' && Number(body.isPinned) !== row.is_pinned) columns.is_pinned = body.isPinned ? 1 : 0
  if (typeof body.isStarred === 'boolean' && Number(body.isStarred) !== row.is_starred) columns.is_starred = body.isStarred ? 1 : 0
  if (typeof body.isArchived === 'boolean' && Number(body.isArchived) !== row.is_archived) columns.is_archived = body.isArchived ? 1 : 0

  if (!Object.keys(columns).length) return c.json(toNote(row))

  const titleChanged = newTitle !== row.title
  const nextRev = row.rev + 1
  const patch = await s.patch({
    current: row,
    expectedRev: body.rev,
    columns,
    title: newTitle,
    content: newContent,
    contentHash: newHash,
    now,
    contentChanged,
    titleChanged,
    derive: row.deleted_at === null && (contentChanged || titleChanged),
    snapshot: contentChanged && !body.quiet && row.content
      ? {
          preserve: Boolean(body.preserveVersion),
          bigChange: Math.abs(newContent.length - row.content.length) >= SNAPSHOT_DIFF_THRESHOLD,
        }
      : null,
  })
  if (!patch.applied) {
    const current = await loadNote(s, id)
    throw ApiError.conflict('This note was modified elsewhere', { server: current })
  }
  let rewroteInbound = false
  if (titleChanged) {
    if (!patch.ambiguous) {
      const rewrite = await rewriteInboundWikiLinks(
        c.env.DB,
        userId,
        id,
        row.title,
        newTitle,
        ftsEnabled,
      )
      if (rewrite.skipped) {
        console.warn(`Could not update ${rewrite.skipped} wiki-link source notes after renaming note ${id}`)
      }
      if (rewrite.deferred) {
        console.info(`Deferred ${rewrite.deferred} wiki-link source note rewrites for note ${id} to the background queue`)
      }
      rewroteInbound = rewrite.rewritten > 0
    } else {
      await s.retargetAmbiguousLinks({
        noteId: id,
        previousTitle: row.title,
        title: newTitle,
        nextRev,
        now,
      })
    }
  }
  await broadcastCursor(c, rewroteInbound ? undefined : patch.changeSeq)
  if (contentChanged || titleChanged) {
    scheduleFtsDrain(c)
    scheduleAiDrainForNote(c, userId)
    await syncBlogForNote(c, patch.next)
  }
  return c.json(toNote(patch.next))
})

notesRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const s = store(c)
  const row = await loadNoteRow(s, id)
  if (row.deleted_at !== null) throw ApiError.notFound('The note does not exist or is in the trash')
  const now = Math.max(Date.now(), row.updated_at + 1)
  const nextRev = row.rev + 1
  const { applied, changeSeq } = await s.trash({ current: row, now, nextRev })
  if (!applied) {
    throw ApiError.conflict('This note was modified elsewhere', { server: await loadNote(s, id) })
  }
  await broadcastCursor(c, changeSeq)
  scheduleFtsDrain(c)
  const note = toNote({ ...row, deleted_at: now, updated_at: now, rev: nextRev })
  await syncBlogForNote(c, { id: row.id, title: row.title, content: row.content, deleted_at: now })
  return c.json(note)
})

notesRoutes.post('/:id/restore', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const s = store(c)
  const row = await loadNoteRow(s, id)
  if (row.deleted_at === null) throw ApiError.badRequest('The note is not in the trash')
  await assertNoteQuota(c.env.DB, userId)

  const now = Math.max(Date.now(), row.updated_at + 1)
  const nextRev = row.rev + 1
  const { applied, row: restored, changeSeq } = await s.restore({ current: row, now, nextRev })
  if (!applied) {
    throw ApiError.conflict('This note was modified elsewhere', { server: await loadNote(s, id) })
  }
  await broadcastCursor(c, changeSeq)
  scheduleFtsDrain(c)
  scheduleAiDrainForNote(c, userId)
  await syncBlogForNote(c, restored!)
  return c.json(toNote(restored!))
})

notesRoutes.delete('/:id/purge', async (c) => {
  const id = c.req.param('id')
  const s = store(c)
  const row = await loadNoteRow(s, id)
  if (row.deleted_at === null) throw ApiError.notFound('The note does not exist or is not in the trash')
  const { changeSeq, deleted } = await s.purge(row)
  if (!deleted) throw ApiError.conflict('Note state changed. Refresh and try again')
  const broadcastedCursor = await broadcastCursor(c, changeSeq)
  const deletionCursor = changeSeq
  scheduleFtsDrain(c)
  await syncBlogForNote(c, { id: row.id, title: row.title, content: row.content, deleted_at: row.deleted_at })
  return c.json({
    ok: true,
    cursor: Number.isSafeInteger(deletionCursor) ? deletionCursor! : broadcastedCursor,
  })
})

notesRoutes.post('/:id/duplicate', async (c) => {
  const userId = c.get('userId')
  const source = await loadNoteRow(store(c), c.req.param('id'))
  const body = c.req.header('Content-Type')?.includes('application/json')
    ? await readJson<{ id?: string }>(c, JSON_BODY_LIMITS.small)
    : {}
  if (body.id !== undefined && !isValidId(body.id)) {
    throw ApiError.badRequest('id must be a valid note id')
  }

  const id = body.id ?? newId()
  if (body.id) {
    const existing = await store(c).noteRow(id)
    if (existing) return c.json(toNote(existing))
    if (await store(c).idTakenByAnyone(id)) throw ApiError.conflict('This note id is already in use')
  }
  const now = Date.now()
  const title = duplicateNoteTitle(source.title, LIMITS.titleMaxLength)
  const content = source.content
  // The quota read rides along with hashing instead of adding a serial round trip.
  const [hash] = await Promise.all([sha256Hex(content), assertNoteQuota(c.env.DB, userId)])

  let outcome: NoteWriteResult
  try {
    outcome = await store(c).duplicate({
      id,
      folderId: source.folder_id,
      title,
      content,
      excerpt: source.excerpt,
      words: source.word_count,
      chars: source.char_count,
      isArchived: source.is_archived,
      contentHash: hash,
      now,
    })
  } catch (error) {
    if (body.id) {
      // The batch failed on the id: answer with the note that got there first when it is this
      // account's, and with a conflict when it is somebody else's.
      const existing = await store(c).noteRow(id)
      if (existing) return c.json(toNote(existing))
      if (await store(c).idTakenByAnyone(id)) throw ApiError.conflict('This note id is already in use')
    }
    throw error
  }
  await broadcastCursor(c, outcome.changeSeq)
  scheduleFtsDrain(c)
  scheduleAiDrainForNote(c, userId)
  // The readback rides in the same batch as the insert, so a missing row is a broken invariant
  // rather than a state a client can reach.
  const note = toNote(outcome.row!)
  return c.json(note, 201)
})


notesRoutes.get('/:id/versions', async (c) => {
  const versions = await store(c).versions(c.req.param('id'))

  return c.json({
    versions: versions.map((r) => ({
      id: r.id,
      noteId: r.note_id,
      title: r.title,
      size: r.size,
      createdAt: r.created_at,
    })),
  })
})

notesRoutes.get('/:id/versions/:versionId', async (c) => {
  const row = await store(c).version(c.req.param('id'), c.req.param('versionId'))
  if (!row) throw ApiError.notFound('Version not found')
  return c.json({
    id: row.id,
    noteId: row.note_id,
    title: row.title,
    content: row.content,
    size: row.size,
    createdAt: row.created_at,
  })
})

notesRoutes.post('/:id/versions/:versionId/restore', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const s = store(c)

  const version = await s.versionContent(id, c.req.param('versionId'))
  if (!version) throw ApiError.notFound('Version not found')

  const current = await loadNoteRow(s, id)
  const now = Math.max(Date.now(), current.updated_at + 1)
  const { words, chars } = countText(version.content)
  const title = restoredVersionTitle(version.title)
  const hash = await sha256Hex(version.content)
  const { applied, row, changeSeq } = await s.restoreVersion({
    noteId: id,
    current,
    title,
    content: version.content,
    excerpt: deriveExcerpt(version.content),
    words,
    chars,
    contentHash: hash,
    now,
  })
  if (!applied) {
    throw ApiError.conflict('This note was modified elsewhere', { server: await loadNote(s, id) })
  }
  await broadcastCursor(c, changeSeq)
  scheduleFtsDrain(c)
  scheduleAiDrainForNote(c, userId)
  await syncBlogForNote(c, row!)
  return c.json(toNote(row!))
})


notesRoutes.get('/:id/backlinks', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const { ftsEnabled } = c.get('database')
  const title = await store(c).noteTitle(id)
  if (title === null) throw ApiError.notFound('Note not found')
  const note = { id, title }
  return c.json({
    backlinks: await findLinkedBacklinks(c.env.DB, userId, note),
    unlinked: await findUnlinkedMentions(c.env.DB, userId, note, ftsEnabled, LIMITS.mentionLimit),
  })
})


/**
 * Link one bare mention: the button beside a row of the panel's "mentions" half.
 *
 * The rewrite happens here rather than in the panel because the note being edited is
 * usually not the one being read — the client may not even hold its text, and whatever
 * copy it does hold can be older than the row the reader clicked. The write is a
 * compare-and-swap on `rev` and `content_hash`, retried against a fresh read, so a note
 * that changed underneath is reported instead of quietly overwritten. The text that was
 * there is kept as a version first, so the reader can take it back.
 */
notesRoutes.post('/:id/link-mention', async (c) => {
  const userId = c.get('userId')
  const targetId = c.req.param('id')
  const body = await readJson<{ sourceNoteId?: unknown }>(c, JSON_BODY_LIMITS.small)
  const sourceId = typeof body.sourceNoteId === 'string' ? body.sourceNoteId : ''
  if (!isValidId(sourceId)) throw ApiError.badRequest('sourceNoteId must be a valid note id')
  const { ftsEnabled } = c.get('database')
  const title = await store(c).noteTitle(targetId, { liveOnly: true })
  if (title === null) throw ApiError.notFound('Note not found')
  const outcome = await linkMentionInNote(c.env.DB, userId, sourceId, title, ftsEnabled)
  if (outcome.status === 'missing') throw ApiError.notFound('Note not found')
  if (outcome.status === 'conflict') throw ApiError.conflict('That note changed while it was being linked; try again')
  if (outcome.status === 'no-mention') return c.json({ status: outcome.status })
  await broadcastCursor(c, outcome.cursor)
  scheduleFtsDrain(c)
  scheduleAiDrainForNote(c, userId)
  return c.json({ status: outcome.status, note: toNote(outcome.row) })
})

async function loadNote(store: NotesStore, id: string): Promise<Note> {
  return toNote(await loadNoteRow(store, id))
}

async function loadNoteRow(store: NotesStore, id: string): Promise<NoteRow> {
  const row = await store.noteRow(id)
  if (!row) throw ApiError.notFound('Note not found')
  return row
}

export function restoredVersionTitle(title: string): string {
  return resolveNoteTitle(title)
}

export function resolveNoteTitle(title: string | undefined, current = ''): string {
  return title === undefined ? current : truncateText(title.trim(), LIMITS.titleMaxLength)
}

export function encodeNotesListCursor(
  row: NoteRow,
  view: ViewKind,
  sort: SortKey,
  order: SortOrder,
): string {
  const value = view === 'trash'
    ? row.deleted_at
    : sort === 'created'
      ? row.created_at
      : sort === 'title'
        ? row.title
        : row.updated_at
  const payload: NotesListCursor = {
    view,
    sort,
    order,
    pinned: view === 'trash' ? 0 : row.is_pinned,
    value: value ?? 0,
    id: row.id,
  }
  return `n1.${toBase64Url(utf8(JSON.stringify(payload)))}`
}

export function parseNotesListCursor(
  raw: string | undefined,
  view: ViewKind,
  sort: SortKey,
  order: SortOrder,
): ParsedNotesListCursor {
  if (!raw) return { kind: 'first' }
  if (/^\d+$/.test(raw)) {
    return { kind: 'legacy', offset: clampInt(raw, 0, 1_000_000, 0) }
  }
  if (raw.length > 4096 || !raw.startsWith('n1.')) throw ApiError.badRequest('Invalid notes cursor')
  try {
    const value = JSON.parse(fromUtf8(fromBase64Url(raw.slice(3)))) as Partial<NotesListCursor>
    const expectedTitle = view !== 'trash' && sort === 'title'
    const validValue = expectedTitle
      ? typeof value.value === 'string' && value.value.length <= LIMITS.titleMaxLength
      : typeof value.value === 'number' && Number.isSafeInteger(value.value) && value.value >= 0
    if (
      value.view !== view ||
      value.sort !== sort ||
      value.order !== order ||
      (value.pinned !== 0 && value.pinned !== 1) ||
      !validValue ||
      typeof value.id !== 'string' ||
      value.id.length < 1 ||
      value.id.length > 128
    ) {
      throw new Error('invalid')
    }
    return { kind: 'keyset', cursor: value as NotesListCursor }
  } catch {
    throw ApiError.badRequest('Invalid notes cursor')
  }
}

async function resolveFolderId(
  c: Context<AppBindings>,
  folderId: string | null | undefined,
): Promise<string | null> {
  if (!folderId) return null
  if (!await store(c).folderExists(folderId)) throw ApiError.badRequest('Folder not found')
  return folderId
}

notesRoutes.post('/rebuild-derived', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json().catch(() => ({})) as { cursor?: string | null }
  const cursor = typeof body.cursor === 'string' && body.cursor ? body.cursor : null
  const release = await acquireLease(
    c.env.DB,
    `derived-rebuild:${userId}`,
    5 * 60 * 1000,
    'Summary rebuild is already running',
  )
  try {
    await assertAttemptBudget(() => consumeAttemptBudget(c.env.DB, [{
      key: `derived-rebuild:${userId}`,
      maxAttempts: 600,
      windowMs: 10 * 60 * 1000,
      lockMs: 60 * 1000,
    }]), 'Too many rebuild requests')
    return c.json({ ok: true, ...(await rebuildDerivedFields(c.env.DB, userId, cursor)) })
  } finally {
    await release()
  }
})
