import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import { truncateText } from '@shared/text-utils'
import { emptyParsedQuery } from '@shared/search-query'
import type { SearchResponse } from '@shared/types'
import type { AppBindings } from '../env'
import { FTS_DRAIN_ALL_BATCH, purgeStaleFtsRows, queueAllNotesForFtsIndex } from '../db/fts'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { acquireLease } from '../lib/lease'
import { scheduleFtsDrain } from '../lib/notify'
import { clampInt } from '../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'
import { requireAuth } from '../middleware/auth'
import type { GraphLinkDirection } from '../search/store'
import { buildUserGraph, fetchSearchDocuments, searchUserNotes } from '../search/service'

export const searchRoutes = new Hono<AppBindings>()


searchRoutes.get('/search', requireAuth, async (c) => {
  const started = Date.now()
  const userId = c.get('userId')
  const raw = truncateText((c.req.query('q') ?? '').trim(), 512)
  const limit = clampInt(c.req.query('limit'), 1, 200, LIMITS.searchLimit)

  if (!raw) {
    const empty: SearchResponse = {
      results: [],
      mode: 'fts',
      took: 0,
      query: emptyParsedQuery(),
    }
    return c.json(empty)
  }

  const { ftsEnabled } = c.get('database')
  scheduleFtsDrain(c, 50)
  const result = await searchUserNotes(c.env.DB, userId, raw, limit, ftsEnabled)
  const q = result.query

  const body: SearchResponse = {
    results: result.results,
    mode: result.mode,
    took: Date.now() - started,
    query: {
      text: q.text,
      tags: q.tags,
      excludedTags: q.excludedTags,
      folder: q.folder,
      starred: q.starred,
      archived: q.archived,
    },
  }
  return c.json(body)
})


searchRoutes.get('/graph', requireAuth, async (c) => {
  const userId = c.get('userId')
  const mode = c.req.query('mode') === 'local' ? 'local' : 'global'
  const rawCenter = (c.req.query('center') ?? '').trim()
  const centerId = rawCenter && isValidId(rawCenter) ? rawCenter : null
  const depth = clampInt(c.req.query('depth'), LIMITS.graphDepthMin, LIMITS.graphDepthMax, LIMITS.graphDepthDefault)
  const limit = clampInt(c.req.query('limit'), LIMITS.graphNodeLimitMin, LIMITS.graphNodeLimitMax, LIMITS.graphNodeLimitDefault)
  const query = (c.req.query('q') ?? '').trim()
  const rawFolderId = (c.req.query('folderId') ?? '').trim()
  const folderId = rawFolderId && isValidId(rawFolderId) ? rawFolderId : ''
  const tag = (c.req.query('tag') ?? '').trim()
  const tags = [...new Set((c.req.query('tags') ?? '').split(',').map((item) => item.trim()).filter(Boolean))]
    .slice(0, LIMITS.graphTagsMax)
  if (tags.length === 0 && tag) tags.push(tag)
  const tagsMatch = c.req.query('tagsMatch') === 'all' ? 'all' : 'any'
  const includeOrphans = c.req.query('includeOrphans') !== '0'
  const includeUnresolved = c.req.query('includeUnresolved') === '1'
  const showTagNodes = c.req.query('tagNodes') === '1'
  const excluded = [...new Set((c.req.query('excluded') ?? '').split(',').map((item) => item.trim()).filter(isValidId))]
    .slice(0, LIMITS.graphExcludedMax)
  const rawDirection = c.req.query('direction')
  const direction: GraphLinkDirection = rawDirection === 'incoming' || rawDirection === 'outgoing' ? rawDirection : 'both'

  if (rawCenter && !centerId) {
    throw new ApiError(400, 'bad_request', 'The center note id is not a valid note id')
  }
  if (rawFolderId && !folderId) {
    throw new ApiError(400, 'bad_request', 'The folder id is not a valid folder id')
  }
  if (query.length > 200) {
    throw new ApiError(400, 'bad_request', 'The graph search query cannot exceed 200 characters')
  }
  if (tag.length > LIMITS.tagNameMaxLength) {
    throw new ApiError(400, 'bad_request', `The graph tag cannot exceed ${LIMITS.tagNameMaxLength} characters`)
  }
  if (tags.some((item) => item.length > LIMITS.tagNameMaxLength)) {
    throw new ApiError(400, 'bad_request', `The graph tag cannot exceed ${LIMITS.tagNameMaxLength} characters`)
  }
  if (mode === 'local' && !centerId) {
    throw new ApiError(400, 'bad_request', 'A center note is required for the local graph')
  }

  await assertAttemptBudget(() => consumeAttemptBudget(c.env.DB, [{
    key: `graph:${userId}`,
    maxAttempts: 1200,
    windowMs: 10 * 60 * 1000,
    lockMs: 60 * 1000,
  }]), 'Too many graph requests')

  const body = await buildUserGraph(c.env.DB, {
    userId,
    mode,
    centerId,
    depth,
    limit,
    query,
    folderId,
    tags,
    tagsMatch,
    includeOrphans,
    includeUnresolved,
    showTagNodes,
    excluded,
    direction,
  })
  return c.json(body)
})

/**
 * The bodies the client-side Omnisearch index is built from. Ids come from the client because it
 * already holds every summary and knows which ones moved; this route only supplies content.
 *
 * Two ceilings keep a page bounded: per note (the same one the FTS index uses, so local and server
 * search agree on what a long note contains) and per response, so a vault of 1.9 MB notes cannot
 * turn one indexing request into a hundred megabytes of JSON.
 */
const DOCUMENT_IDS_MAX = 40
const DOCUMENT_THROTTLE_PER_10_MIN = 1_200


searchRoutes.post('/search/documents', requireAuth, async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json().catch((): unknown => null)
  const requested = (body as { ids?: unknown } | null)?.ids
  const ids = [...new Set(
    Array.isArray(requested)
      ? requested.filter((item): item is string => typeof item === 'string' && isValidId(item))
      : [],
  )].slice(0, DOCUMENT_IDS_MAX)
  if (!ids.length) throw new ApiError(400, 'bad_request', 'No note ids were given')

  await assertAttemptBudget(() => consumeAttemptBudget(c.env.DB, [{
    key: `search-documents:${userId}`,
    maxAttempts: DOCUMENT_THROTTLE_PER_10_MIN,
    windowMs: 10 * 60 * 1000,
    lockMs: 60 * 1000,
  }]), 'Too many indexing requests')

  return c.json(await fetchSearchDocuments(c.env.DB, userId, ids))
})

searchRoutes.post('/search/reindex', requireAuth, async (c) => {
  const { ftsEnabled } = c.get('database')
  if (!ftsEnabled) throw new ApiError(503, 'internal', 'Full-text indexing is unavailable in this environment; search is using its fallback')
  const userId = c.get('userId')
  const release = await acquireLease(
    c.env.DB,
    `fts-reindex-run:${userId}`,
    15 * 60 * 1000,
    'Search indexing is already running',
  )
  try {
    await assertAttemptBudget(() => consumeAttemptBudget(c.env.DB, [{
      key: `fts-reindex:${userId}`,
      maxAttempts: 6,
      windowMs: 60 * 60 * 1000,
      lockMs: 60 * 60 * 1000,
    }]), 'Too many search reindex requests')
    const queued = await queueAllNotesForFtsIndex(c.env.DB, userId)
    await purgeStaleFtsRows(c.env.DB, userId)
    scheduleFtsDrain(c, FTS_DRAIN_ALL_BATCH)
    return c.json({ ok: true, queued })
  } finally {
    await release()
  }
})
