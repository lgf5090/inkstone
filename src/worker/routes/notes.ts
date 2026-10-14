import { Hono } from 'hono'
import type { Context } from 'hono'
import { LIMITS } from '@shared/constants'
import { countText, deriveExcerpt, extractTags, foldCase, foldIndexOf, linkFirstMention, normalizeLinkKey, plainLinkText, replaceWikiLinkTarget, trimFrontMatterLead } from '@shared/markdown-utils'
import { duplicateNoteTitle, truncateText, utf8ByteLength } from '@shared/text-utils'
import type {
  CreateNoteBody,
  ListNotesResponse,
  Note,
  PatchNoteBody,
  SortKey,
  SortOrder,
  ViewKind,
} from '@shared/types'
import { buildFtsQuery } from './search'
import type { AppBindings } from '../env'
import { NOTE_COLUMNS_FULL, splitTags, toNote, toNoteSummary, type NoteRow } from '../db/rows'
import { assertNoteQuota } from '../db/quota'
import {
  NotesStore,
  type NotesListCursor,
  type NoteWriteResult,
  type ParsedNotesListCursor,
} from '../notes/store'
import { acquireLease } from '../lib/lease'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'
import {
  buildNoteDerivedStatements,
  rebuildDerivedFields,
  INLINE_REWRITE_LIMIT,
  REWRITE_CONCURRENCY,
  REWRITE_LOAD_CHUNK,
  rewriteQueueStatement,
  LINK_TARGET_SUBQUERY,
  pruneOrphanTags,
  shiftSqlPlaceholders,
} from '../db/writes'
import { fromBase64Url, fromUtf8, sha256Hex, toBase64Url, utf8 } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { broadcastCursor, scheduleFtsDrain } from '../lib/notify'
import { assertContentSize, clampInt, JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { noteIndexQueueStatement, scheduleAiDrainForNote } from '../mcp/ai-search'

export const notesRoutes = new Hono<AppBindings>()

notesRoutes.use('*', requireAuth)


const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000

const SNAPSHOT_DIFF_THRESHOLD = 400

const NOTE_VIEWS = new Set<ViewKind>(['all', 'recent', 'starred', 'unfiled', 'untagged', 'archived', 'trash', 'folder', 'tag'])
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

/**
 * The trashed notes of one account are purged page by page; `notesRoutes.post('/trash/empty')` is the
 * only HTTP caller, and `tests/trash-purge-batch.test.ts` builds the statements directly.
 */
export { trashPurgeStatements } from '../notes/store'

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
  const sets: string[] = []
  const binds: unknown[] = []
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
      push(sets, binds, 'content', body.content)
      push(sets, binds, 'content_hash', hash)
      push(sets, binds, 'title', newTitle)
      push(sets, binds, 'excerpt', deriveExcerpt(body.content))
      push(sets, binds, 'word_count', words)
      push(sets, binds, 'char_count', chars)
    }
  } else if (resolvedTitle !== row.title) {
    newTitle = resolvedTitle
    push(sets, binds, 'title', newTitle)
  }

  if (body.folderId !== undefined && body.folderId !== row.folder_id) {
    push(sets, binds, 'folder_id', await resolveFolderId(c, body.folderId))
  }
  if (typeof body.isPinned === 'boolean' && Number(body.isPinned) !== row.is_pinned) push(sets, binds, 'is_pinned', body.isPinned ? 1 : 0)
  if (typeof body.isStarred === 'boolean' && Number(body.isStarred) !== row.is_starred) push(sets, binds, 'is_starred', body.isStarred ? 1 : 0)
  if (typeof body.isArchived === 'boolean' && Number(body.isArchived) !== row.is_archived) push(sets, binds, 'is_archived', body.isArchived ? 1 : 0)

  if (!sets.length) return c.json(toNote(row))

  push(sets, binds, 'updated_at', now)
  const nextRev = row.rev + 1
  push(sets, binds, 'rev', nextRev)
  const mutationGuard = `EXISTS (SELECT 1 FROM notes
    WHERE id = ?1 AND user_id = ?2 AND rev = ?3
      AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
  const mutationValues = [id, userId, nextRev, newHash, newTitle, now] as const

  binds.push(id, userId, body.rev)
  const update = c.env.DB.prepare(
    `UPDATE notes SET ${sets.join(', ')}
      WHERE id = ?${binds.length - 2} AND user_id = ?${binds.length - 1} AND rev = ?${binds.length}`,
  ).bind(...binds)

  const statements: D1PreparedStatement[] = [update]
  let derivedTags: string[] | null = null

  if (contentChanged && !body.quiet && row.content) {
    const bigChange = Math.abs(newContent.length - row.content.length) >= SNAPSHOT_DIFF_THRESHOLD
    const snapshotId = newId()
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
          WHERE ${shiftSqlPlaceholders(mutationGuard, 7)}
            AND (?14 = 1
                 OR NOT EXISTS (SELECT 1 FROM note_versions WHERE note_id = ?2)
                 OR ?15 - COALESCE((SELECT MAX(created_at) FROM note_versions WHERE note_id = ?2), 0) > ?16
                 OR ?17 = 1)`,
      ).bind(
        snapshotId, id, userId, row.title, row.content, utf8ByteLength(row.content), now,
        ...mutationValues,
        body.preserveVersion ? 1 : 0, now, SNAPSHOT_INTERVAL_MS, bigChange ? 1 : 0,
      ),
      c.env.DB.prepare(
        `DELETE FROM note_versions WHERE note_id = ?1
           AND EXISTS (SELECT 1 FROM note_versions WHERE id = ?9)
           AND ${shiftSqlPlaceholders(mutationGuard, 1)}
           AND id IN (
             SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`,
      ).bind(id, ...mutationValues, LIMITS.versionsPerNote, snapshotId),
    )
  }

  if (row.deleted_at === null && (contentChanged || newTitle !== row.title)) {
    const derived = buildNoteDerivedStatements({
      db: c.env.DB,
      userId,
      noteId: id,
      title: newTitle,
      content: newContent,
      ftsEnabled,
      titleChanged: newTitle !== row.title,
      previousTitle: row.title,
      expectedRev: nextRev,
      expectedContentHash: newHash,
      expectedTitle: newTitle,
      expectedUpdatedAt: now,
    })
    statements.push(...derived.statements)
    derivedTags = derived.tags
    if (contentChanged && !sameTagSet(splitTags(row.tag_names), derived.tags)) {
      statements.push(
        c.env.DB.prepare(
          `DELETE FROM tags WHERE user_id = ?1 AND is_manual = 0
             AND ${shiftSqlPlaceholders(mutationGuard, 1)}
             AND NOT EXISTS (SELECT 1 FROM note_tags WHERE tag_id = tags.id)`,
        ).bind(userId, ...mutationValues),
      )
    }
  }

  if (contentChanged || newTitle !== row.title) {
    statements.push(noteIndexQueueStatement(c.env.DB, userId, id, 'embed', now))
  }

  // Whether another note already answers to either title decides the wiki-link rewrite, so
  // it rides along with the mutation instead of costing the rename path its own round trip.
  let ambiguityIndex = -1
  if (newTitle !== row.title) {
    ambiguityIndex = statements.length
    statements.push(c.env.DB.prepare(
      `SELECT 1 AS found FROM notes
        WHERE user_id = ?1 AND id <> ?2 AND deleted_at IS NULL AND title_key IN (?3, ?4)
        LIMIT 1`,
    ).bind(
      userId,
      id,
      normalizeLinkKey(row.title),
      normalizeLinkKey(newTitle),
    ))
  }

  statements.push(
    c.env.DB.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', ?2, 'upsert', ?3
        WHERE ${shiftSqlPlaceholders(mutationGuard, 3)}
       RETURNING seq`,
    ).bind(userId, id, now, ...mutationValues),
  )

  const results = await c.env.DB.batch(statements)
  const updateResult = results[0]
  if (!updateResult?.meta.changes) {
    const current = await loadNote(store(c), id)
    throw ApiError.conflict('This note was modified elsewhere', { server: current })
  }
  const changeResult = results.at(-1) as D1Result<{ seq: number }> | undefined
  let rewroteInbound = false
  if (newTitle !== row.title) {
    const ambiguous = (results[ambiguityIndex]?.results?.length ?? 0) > 0
    if (!ambiguous) {
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
      await c.env.DB.prepare(
        `UPDATE links SET target_note_id = ${LINK_TARGET_SUBQUERY}
          WHERE user_id = ?1 AND target_key = ?2
            AND EXISTS (SELECT 1 FROM notes
              WHERE id = ?3 AND user_id = ?1 AND rev = ?4
                AND title = ?5 AND updated_at = ?6 AND deleted_at IS NULL)`,
      ).bind(
        userId,
        normalizeLinkKey(row.title),
        id,
        nextRev,
        newTitle,
        now,
      ).run()
    }
  }
  await broadcastCursor(c, rewroteInbound ? undefined : changeResult?.results?.[0]?.seq)
  if (contentChanged || newTitle !== row.title) {
    scheduleFtsDrain(c)
    scheduleAiDrainForNote(c, userId)
  }
  const nextTags = contentChanged ? (derivedTags ?? extractTags(newContent)) : null
  return c.json(toNote(applyPatchRow(row, sets, binds, nextTags)))
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


export type LinkMentionOutcome =
  | { status: 'linked'; row: NoteRow; cursor: number | undefined }
  | { status: 'no-mention' }
  | { status: 'missing' }
  | { status: 'conflict' }

export async function linkMentionInNote(
  db: D1Database,
  userId: string,
  sourceNoteId: string,
  title: string,
  ftsEnabled: boolean,
): Promise<LinkMentionOutcome> {
  const load = () => db.prepare(
    `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
  ).bind(sourceNoteId, userId).first<NoteRow>()
  let current = await load()
  if (!current || current.deleted_at !== null) return { status: 'missing' }
  for (let attempt = 0; attempt < 3; attempt++) {
    const content = linkFirstMention(current.content, title)
    if (content === current.content) return { status: 'no-mention' }
    const hash = await sha256Hex(content)
    const { words, chars } = countText(content)
    const now = Math.max(Date.now(), current.updated_at + 1)
    const nextRev = current.rev + 1
    const guard = `EXISTS (SELECT 1 FROM notes
      WHERE id = ?1 AND user_id = ?2 AND rev = ?3
        AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
    const guardValues = [current.id, userId, nextRev, hash, current.title, now] as const
    const statements: D1PreparedStatement[] = [
      db.prepare(
        `UPDATE notes SET content = ?1, excerpt = ?2, word_count = ?3, char_count = ?4,
           content_hash = ?5, rev = ?6, updated_at = ?7
          WHERE id = ?8 AND user_id = ?9 AND rev = ?10 AND content_hash = ?11`,
      ).bind(content, deriveExcerpt(content), words, chars, hash, nextRev, now,
        current.id, userId, current.rev, current.content_hash),
      db.prepare(
        `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${shiftSqlPlaceholders(guard, 7)}`,
      ).bind(newId(), current.id, userId, current.title, current.content,
        utf8ByteLength(current.content), now, ...guardValues),
      db.prepare(
        `DELETE FROM note_versions WHERE note_id = ?1
           AND ${shiftSqlPlaceholders(guard, 1)}
           AND id IN (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`,
      ).bind(current.id, ...guardValues, LIMITS.versionsPerNote),
    ]
    statements.push(...buildNoteDerivedStatements({
      db,
      userId,
      noteId: current.id,
      title: current.title,
      content,
      ftsEnabled,
      expectedRev: nextRev,
      expectedContentHash: hash,
      expectedTitle: current.title,
      expectedUpdatedAt: now,
    }).statements)
    statements.push(noteIndexQueueStatement(db, userId, current.id, 'embed', now))
    statements.push(
      db.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?1, 'note', ?2, 'upsert', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
         RETURNING seq`,
      ).bind(userId, current.id, now, ...guardValues),
    )
    const results = await db.batch(statements)
    if (results[0]?.meta.changes) {
      const row = await load()
      if (!row) return { status: 'missing' }
      const change = results.at(-1)?.results?.[0] as { seq?: number } | undefined
      return { status: 'linked', row, cursor: change?.seq }
    }
    current = await load()
    if (!current || current.deleted_at !== null) return { status: 'missing' }
  }
  return { status: 'conflict' }
}


/**
 * The notes whose `[[wikilinks]]` the link table already points at this one, each with
 * the text around the link.
 *
 * The window is cut from `hit`, so the column has to survive the outer projection: it
 * did not, and every context came back empty until a test read the row keys.
 */
/**
 * The sentence around a mention, or `null` when the row does not actually carry one.
 *
 * Two reasons not to trust the index pass: SQLite's `lower()` folds ASCII characters only,
 * so a mention written with an accented or Cyrillic capital gives `hit` 0 and leaves the
 * window parked at the top of the note; and the full-text index matches token neighbours,
 * not characters, so it can offer a note where the words only happen to sit next to each
 * other. `foldIndexOf` is exact and length-preserving, so one check answers both.
 */
function mentionExcerpt(window: string, hit: number, len: number, needle: string): string | null {
  const body = trimFrontMatterLead(window)
  const found = foldIndexOf(body, needle)
  if (found < 0) return null
  const from = Math.max(0, found - 60)
  const to = Math.min(body.length, found + needle.length + 90)
  // `trimFrontMatterLead` only ever removes a prefix, so the difference in length is how
  // much of the note the window already left behind.
  const dropped = (hit > 0 ? Math.max(hit - 61, 0) : 0) + (window.length - body.length)
  const headCut = dropped + from > 0
  const tailCut = dropped + to < len
  return (headCut ? '…' : '') + plainLinkText(body.slice(from, to)).replace(/\s+/g, ' ').trim() + (tailCut ? '…' : '')
}

/**
 * How far into a note the retry scan looks for a mention the cheap index pass could not
 * place. Sized to cover most notes whole, and applied only to the few rows per page that
 * need it, so the panel never pulls a body at the content limit.
 */
const MENTION_RETRY_SCAN_CHARS = 4000

function backlinkContext(window: string, hit: number, len: number, needle: string): string {
  const located = mentionExcerpt(window, hit, len, needle)
  // A backlink is known from the link table, so the row stays even when the excerpt could
  // not be placed on it; the head of the note is the honest fallback.
  return located ?? plainLinkText(truncateText(window, 120).replace(/\s+/g, ' ').trim())
}

/**
 * The letters SQLite's `lower()` cannot fold, spelled out as `replace()` arguments.
 *
 * `lower()` covers ASCII; `foldCase` covers every letter with a single-code-unit lowercase.
 * The gap between them is exactly this list, so folding the column with these pairs and the
 * needle with `foldCase` leaves both sides in the same alphabet. Capped at twelve pairs: a
 * title made of exotic letters would build a `replace()` chain longer than the scan is worth,
 * and the caller's retry pass picks up what the cap drops.
 */
function caseFoldPairs(title: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const char of title) {
    const folded = foldCase(char)
    if (folded.length !== 1) continue
    for (const variant of [char, char.toUpperCase()]) {
      if (variant.length !== 1 || variant === folded || variant.charCodeAt(0) < 0x80) continue
      if (!pairs.some(([from]) => from === variant)) pairs.push([variant, folded])
    }
  }
  return pairs.slice(0, 12)
}

/** `expression`, folded down to the alphabet `foldCase` reports for `title`. */
function foldSql(expression: string, pairs: Array<[string, string]>, firstSlot: number): string {
  return pairs.reduce(
    (sql, _pair, index) => `replace(${sql}, ?${firstSlot + index * 2}, ?${firstSlot + index * 2 + 1})`,
    expression,
  )
}

export async function findLinkedBacklinks(
  db: D1Database,
  userId: string,
  target: { id: string; title: string },
): Promise<Array<{ id: string; title: string; context: string }>> {
  const needle = `[[${target.title}`
  const pairs = caseFoldPairs(target.title)
  // One fold and one instr per row: SQLite does not share the repeated subexpression
  // across the references below.
  const { results } = await db.prepare(
    `SELECT id, title, hit, len,
       substr(content, MAX(hit - 60, 1), ?4) AS window
     FROM (
       SELECT n.id AS id, n.title AS title, n.content AS content,
              instr(${foldSql('lower(n.content)', pairs, 5)}, ?3) AS hit, length(n.content) AS len
         FROM links l
           JOIN notes n ON n.id = l.source_note_id
        WHERE l.user_id = ?1 AND l.target_note_id = ?2
          AND n.deleted_at IS NULL AND n.id != ?2
        ORDER BY n.updated_at DESC LIMIT 50
     )`,
  )
    .bind(userId, target.id, foldCase(needle), needle.length + 150, ...pairs.flat())
    .all<{ id: string; title: string; hit: number; len: number; window: string }>()

  return results.map((row) => ({
    id: row.id,
    title: row.title,
    context: backlinkContext(row.window, row.hit, row.len, needle),
  }))
}


/**
 * Notes that say the target's title in their text without linking to it.
 *
 * The full-text index finds the candidates and `mentionExcerpt` confirms the literal phrase:
 * the index is tokenised and case-folded, so it can offer a note where the words only
 * happen to sit next to each other, and a mention the reader cannot see is worse than a
 * shorter list. Notes that already carry a `[[title]]` are left to the linked half of the
 * panel, since a row would otherwise show up twice with two different meanings.
 *
 * The index pass over-fetches by three because the confirmation drops rows the index should
 * not have offered, and a candidate whose mention the first window missed gets one more look
 * at its first `MENTION_RETRY_SCAN_CHARS` characters, which is where an accented or Cyrillic
 * capital that SQLite could not fold usually lives. Without the index the same answer comes
 * from scanning every body, which is what the search endpoint already falls back to.
 */
export async function findUnlinkedMentions(
  db: D1Database,
  userId: string,
  target: { id: string; title: string },
  ftsEnabled: boolean,
  limit: number,
): Promise<Array<{ id: string; title: string; context: string }>> {
  const title = target.title.trim()
  if (Array.from(title).length < LIMITS.mentionMinChars)
    return []
  const match = ftsEnabled ? buildFtsQuery([title]) : ''
  if (ftsEnabled && !match)
    return []
  const needle = title
  const pairs = caseFoldPairs(title)
  // ?1 is the match expression only when the index is in play, so every later slot shifts.
  const k = ftsEnabled ? 1 : 0
  const { results } = await db
    .prepare(
      `SELECT id, title, hit, len,
         substr(content, MAX(hit - 60, 1), ?${4 + k}) AS window
       FROM (
         SELECT n.id AS id, n.title AS title, n.content AS content,
                instr(${foldSql('lower(n.content)', pairs, 6 + k)}, ?${3 + k}) AS hit, length(n.content) AS len
           ${ftsEnabled ? 'FROM notes_fts JOIN notes n ON n.id = notes_fts.note_id AND n.user_id = notes_fts.user_id' : 'FROM notes n'}
          ${ftsEnabled ? 'WHERE notes_fts MATCH ?1 AND notes_fts.user_id = ?2 AND n.user_id = ?2' : 'WHERE n.user_id = ?1'}
            ${ftsEnabled ? '' : `AND instr(${foldSql('lower(n.content)', pairs, 6 + k)}, ?${3 + k}) > 0`}
            AND n.deleted_at IS NULL
            AND n.id != ?${2 + k}
            AND NOT EXISTS (
              SELECT 1 FROM links l
               WHERE l.user_id = ?${1 + k} AND l.source_note_id = n.id AND l.target_note_id = ?${2 + k}
            )
         ORDER BY n.updated_at DESC, n.id ASC
         LIMIT ?${5 + k}
       )`,
    )
    .bind(...(ftsEnabled
      ? [match, userId, target.id, foldCase(needle), needle.length + 150, limit * 3, ...pairs.flat()]
      : [userId, target.id, foldCase(needle), needle.length + 150, limit * 3, ...pairs.flat()]))
    .all<{ id: string; title: string; hit: number; len: number; window: string }>()

  const found = new Map<string, string>()
  const missed: Array<{ id: string; len: number }> = []
  for (const row of results) {
    const context = mentionExcerpt(row.window, row.hit, row.len, needle)
    if (context === null) missed.push({ id: row.id, len: row.len })
    else found.set(row.id, context)
  }

  if (missed.length) {
    const placeholders = missed.map((_, index) => `?${index + 3}`).join(', ')
    const { results: heads } = await db.prepare(
      `SELECT id, title, length(content) AS len, substr(content, 1, ?2) AS window
         FROM notes WHERE user_id = ?1 AND id IN (${placeholders})`,
    ).bind(userId, MENTION_RETRY_SCAN_CHARS, ...missed.map((row) => row.id))
      .all<{ id: string; title: string; len: number; window: string }>()
    for (const head of heads) {
      if (found.size >= limit) break
      const context = mentionExcerpt(head.window, 0, head.len, needle)
      if (context !== null) found.set(head.id, context)
    }
  }

  const order = new Map(results.map((row, index) => [row.id, index]))
  return [...found.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
    .slice(0, limit)
    .map(([id, context]) => ({ id, title: results.find((row) => row.id === id)?.title ?? '', context }))
}


async function loadNote(store: NotesStore, id: string): Promise<Note> {
  return toNote(await loadNoteRow(store, id))
}

async function loadNoteRow(store: NotesStore, id: string): Promise<NoteRow> {
  const row = await store.noteRow(id)
  if (!row) throw ApiError.notFound('Note not found')
  return row
}

export async function rewriteInboundWikiLinks(
  db: D1Database,
  userId: string,
  targetNoteId: string,
  fromTitle: string,
  toTitle: string,
  ftsEnabled: boolean,
  forceInline = false,
  budgetNotes = Number.POSITIVE_INFINITY,
): Promise<{ rewritten: number; skipped: number; deferred: number; remaining: number }> {
  const previousKey = normalizeLinkKey(fromTitle)
  const { results: candidates } = await db.prepare(
    `SELECT DISTINCT n.id FROM links l
      JOIN notes n ON n.id = l.source_note_id AND n.user_id = l.user_id
     WHERE l.user_id = ?1 AND l.target_note_id = ?2 AND l.target_key = ?3
       AND n.id <> ?2 AND n.deleted_at IS NULL`,
  ).bind(userId, targetNoteId, previousKey).all<{ id: string }>()
  if (!candidates.length) return { rewritten: 0, skipped: 0, deferred: 0, remaining: 0 }
  if (!forceInline && candidates.length > INLINE_REWRITE_LIMIT) {
    await db.batch([
      rewriteQueueStatement(db, userId, 'note-title', targetNoteId, fromTitle, toTitle),
    ])
    return { rewritten: 0, skipped: 0, deferred: candidates.length, remaining: 0 }
  }
  let rewritten = 0
  let skipped = 0

  const candidateIds = candidates.map((c) => c.id)
  const plan = Number.isFinite(budgetNotes) ? candidateIds.slice(0, budgetNotes) : candidateIds
  const remaining = candidateIds.length - plan.length
  type CandidateNoteRecord = {
    id: string
    title: string
    content: string
    content_hash: string
    rev: number
    updated_at: number
    deleted_at: number | null
  }
  // Load and rewrite in small windows: a hub note referenced by thousands of others must
  // not pin every candidate body in the isolate before the first write happens.
  for (let start = 0; start < plan.length; start += REWRITE_LOAD_CHUNK) {
    const windowIds = plan.slice(start, start + REWRITE_LOAD_CHUNK)
    const placeholders = windowIds.map((_, idx) => `?${idx + 2}`).join(', ')
    const { results: loaded } = await db.prepare(
      `SELECT id, title, content, content_hash, rev, updated_at, deleted_at
         FROM notes WHERE user_id = ?1 AND id IN (${placeholders})`,
    ).bind(userId, ...windowIds).all<CandidateNoteRecord>()
    const notesToRewrite = loaded.filter((note) => note.deleted_at === null
      && replaceWikiLinkTarget(note.content, fromTitle, toTitle) !== note.content)
    skipped += loaded.length - notesToRewrite.length
    for (let i = 0; i < notesToRewrite.length; i += REWRITE_CONCURRENCY) {
      const batch = notesToRewrite.slice(i, i + REWRITE_CONCURRENCY)
      const outcomes = await Promise.all(
        batch.map(async (initialNote) => {
          let currentNote: CandidateNoteRecord | null = initialNote
          for (let attempt = 0; attempt < 5; attempt++) {
            if (!currentNote || currentNote.deleted_at !== null) return false
            const content = replaceWikiLinkTarget(currentNote.content, fromTitle, toTitle)
            if (content === currentNote.content) return true
            const hash = await sha256Hex(content)
            const { words, chars } = countText(content)
            const now = Math.max(Date.now(), currentNote.updated_at + 1)
            const nextRev = currentNote.rev + 1
            const guard = `EXISTS (SELECT 1 FROM notes
              WHERE id = ?1 AND user_id = ?2 AND rev = ?3
                AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
            const guardValues = [currentNote.id, userId, nextRev, hash, currentNote.title, now] as const
            const statements: D1PreparedStatement[] = [
              db.prepare(
                `UPDATE notes SET content = ?1, excerpt = ?2, word_count = ?3, char_count = ?4,
                   content_hash = ?5, rev = ?6, updated_at = ?7
                  WHERE id = ?8 AND user_id = ?9 AND rev = ?10 AND content_hash = ?11`,
              ).bind(content, deriveExcerpt(content), words, chars, hash, nextRev, now,
                currentNote.id, userId, currentNote.rev, currentNote.content_hash),
              db.prepare(
                `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${shiftSqlPlaceholders(guard, 7)}`,
              ).bind(newId(), currentNote.id, userId, currentNote.title, currentNote.content,
                utf8ByteLength(currentNote.content), now, ...guardValues),
              db.prepare(
                `DELETE FROM note_versions WHERE note_id = ?1
                   AND ${shiftSqlPlaceholders(guard, 1)}
                   AND id IN (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`,
              ).bind(currentNote.id, ...guardValues, LIMITS.versionsPerNote),
            ]
            statements.push(...buildNoteDerivedStatements({
              db,
              userId,
              noteId: currentNote.id,
              title: currentNote.title,
              content,
              ftsEnabled,
              expectedRev: nextRev,
              expectedContentHash: hash,
              expectedTitle: currentNote.title,
              expectedUpdatedAt: now,
            }).statements)
            statements.push(noteIndexQueueStatement(db, userId, currentNote.id, 'embed', now))
            statements.push(
              db.prepare(
                `INSERT INTO changes (user_id, entity, entity_id, op, at)
                 SELECT ?1, 'note', ?2, 'upsert', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}`,
              ).bind(userId, currentNote.id, now, ...guardValues),
            )
            const [updated] = await db.batch(statements)
            if (updated?.meta.changes) {
              return true
            }
            currentNote = await db.prepare(
              `SELECT id, title, content, content_hash, rev, updated_at, deleted_at
                 FROM notes WHERE id = ?1 AND user_id = ?2`,
            ).bind(currentNote.id, userId).first<CandidateNoteRecord>()
          }
          return false
        }),
      )
    for (const success of outcomes) {
      if (success) rewritten++
      else skipped++
    }
    }
  }
  return { rewritten, skipped, deferred: 0, remaining }
}

function sameTagSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every((name) => set.has(name))
}

function applyPatchRow(
  row: NoteRow,
  sets: string[],
  binds: unknown[],
  tagNames: string[] | null,
): NoteRow {
  const next: NoteRow = { ...row }
  for (let index = 0; index < sets.length; index++) {
    const column = sets[index]!.split(' ')[0]!
    const value = binds[index]
    switch (column) {
      case 'content':
        next.content = value as string
        break
      case 'content_hash':
        next.content_hash = value as string
        break
      case 'title':
        next.title = value as string
        break
      case 'excerpt':
        next.excerpt = value as string
        break
      case 'word_count':
        next.word_count = value as number
        break
      case 'char_count':
        next.char_count = value as number
        break
      case 'folder_id':
        next.folder_id = value as string | null
        break
      case 'is_pinned':
        next.is_pinned = value as number
        break
      case 'is_starred':
        next.is_starred = value as number
        break
      case 'is_archived':
        next.is_archived = value as number
        break
      case 'updated_at':
        next.updated_at = value as number
        break
      case 'rev':
        next.rev = value as number
        break
      default:
        break
    }
  }
  if (tagNames !== null) next.tag_names = tagNames.join('\u0001')
  return next
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

function push(sets: string[], binds: unknown[], column: string, value: unknown): void {
  binds.push(value)
  sets.push(`${column} = ?${binds.length}`)
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
