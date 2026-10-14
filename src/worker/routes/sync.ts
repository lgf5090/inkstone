import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import type { SyncDeletion, SyncResponse } from '@shared/types'
import type { AppBindings } from '../env'
import { toFolder, toNoteSummary, toTag } from '../db/rows'
import { ApiError } from '../lib/errors'
import { clampInt } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { SyncStore } from '../sync/store'

export const syncRoutes = new Hono<AppBindings>()


syncRoutes.get('/', requireAuth, async (c) => {
  const userId = c.get('userId')
  const store = new SyncStore(c.env.DB, userId)
  const since = clampInt(c.req.query('since'), 0, Number.MAX_SAFE_INTEGER, 0)
  const after = (c.req.query('after') ?? '').slice(0, 128)

  const bounds = await store.changeBounds()

  const lo = bounds?.lo ?? 0
  const hi = bounds?.hi ?? 0


  const needFull = since <= 0 || (lo > 0 && since < lo - 1)
  // A non-empty `after` key always means the caller is mid-way through a
  // full snapshot page chain; keep serving snapshot pages regardless of
  // `since`, so following the returned nextKey can never silently drop
  // remaining pages.
  if (needFull || after) {
    const requestedSnapshot = clampInt(
      c.req.query('snapshot'),
      0,
      Number.MAX_SAFE_INTEGER,
      hi,
    )
    const snapshotCursor = after ? Math.min(requestedSnapshot, hi) : hi
    return c.json(await store.fullSnapshot(snapshotCursor, after))
  }

  if (since >= hi) {
    const body: SyncResponse = {
      // Never move the client's cursor backwards, even if it reported a
      // seq ahead of the server (e.g. data was trimmed).
      cursor: Math.max(since, hi),
      full: false,
      hasMore: false,
      nextKey: null,
      facetsFull: false,
      settingsChanged: false,
      profileChanged: false,
      siteChanged: false,
      notes: [],
      folders: [],
      tags: [],
      deletions: [],
      serverTime: Date.now(),
    }
    return c.json(body)
  }

  const changes = await store.changePage(since)

  const cursor = changes.length ? changes[changes.length - 1]!.seq : since
  const hasMore = changes.length === LIMITS.syncBatchSize && cursor < hi


  const latest = new Map<string, { entity: string; id: string; op: string }>()
  for (const ch of changes) {
    latest.set(`${ch.entity}:${ch.entity_id}`, { entity: ch.entity, id: ch.entity_id, op: ch.op })
  }

  const noteIds: string[] = []
  const folderIds: string[] = []
  const tagIds: string[] = []
  const deletions: SyncDeletion[] = []

  for (const item of latest.values()) {
    if (item.op === 'delete') {
      if (item.entity === 'note' || item.entity === 'folder' || item.entity === 'tag') {
        deletions.push({ entity: item.entity, id: item.id })
      }
      continue
    }
    if (item.entity === 'note') noteIds.push(item.id)
    else if (item.entity === 'folder') folderIds.push(item.id)
    else if (item.entity === 'tag') tagIds.push(item.id)
  }
  // Tag counts are a projection over `note_tags`, and a note write only emits a `note` change
  // row. Without this the delta would carry stale counts forever. Note deletions never reach
  // `noteIds` (they become `deletions`), so the flag has to read the raw change rows.
  //
  // Only on the last page: the client applies every delta page through its own applySync, so
  // marking each one full would ship the whole tag list once per page (442 KB per 5 000 tags).
  // The final page's recount already covers everything the earlier pages moved.
  const facetsFull = !hasMore && changes.some((ch) => ch.entity === 'note')
  const settingsChanged = [...latest.values()].some((item) => item.entity === 'settings')
  const profileChanged = [...latest.values()].some((item) => item.entity === 'profile')
  const siteChanged = [...latest.values()].some((item) => item.entity === 'site')

  const [notes, folders, tags] = await Promise.all([
    store.notesByIds(noteIds),
    facetsFull ? store.foldersFull() : store.foldersByIds(folderIds),
    facetsFull ? store.tagsFull() : store.tagsByIds(tagIds),
  ])

  const gotNotes = new Set(notes.map((n) => n.id))
  for (const id of noteIds) if (!gotNotes.has(id)) deletions.push({ entity: 'note', id })
  const gotFolders = new Set(folders.map((f) => f.id))
  for (const id of folderIds) if (!gotFolders.has(id)) deletions.push({ entity: 'folder', id })
  const gotTags = new Set(tags.map((t) => t.id))
  for (const id of tagIds) if (!gotTags.has(id)) deletions.push({ entity: 'tag', id })

  const body: SyncResponse = {
    cursor,
    full: false,
    hasMore,
    nextKey: null,
    facetsFull,
    settingsChanged,
    profileChanged,
    siteChanged,
    notes: notes.map(toNoteSummary),
    folders: folders.map(toFolder),
    tags: tags.map(toTag),
    deletions,
    serverTime: Date.now(),
  }
  return c.json(body)
})


syncRoutes.get('/ws', requireAuth, async (c) => {
  if (!c.env.SYNC_HUB) {
    throw new ApiError(503, 'storage_unavailable', 'The realtime channel is disabled; polling will be used')
  }
  const origin = c.req.header('Origin')
  if (origin && origin !== new URL(c.req.url).origin) {
    throw ApiError.forbidden('The realtime connection origin is not trusted')
  }
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    throw ApiError.badRequest('This endpoint accepts only WebSocket upgrade requests')
  }

  const userId = c.get('userId')
  const stub = c.env.SYNC_HUB.get(c.env.SYNC_HUB.idFromName(userId))
  const hubHeaders = new Headers(c.req.raw.headers)
  if (c.env.DO_AUTH_KEY) hubHeaders.set('X-Inkstone-Internal', c.env.DO_AUTH_KEY)
  else hubHeaders.delete('X-Inkstone-Internal')
  return stub.fetch(
    new Request('https://sync-hub.internal/connect', {
      headers: hubHeaders,
    }),
  )
})
