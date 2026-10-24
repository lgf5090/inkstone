/**
 * The music cloud: R2 usage, the WebDAV folder the account backs up, and the writes that turn a
 * remote file into a library reference.
 *
 * An import registers metadata only — the audio stays on the reader's WebDAV server, `r2_key` is
 * null and nothing is copied — so it costs no R2 quota and a later deletion of the remote file is a
 * separate, explicit action. Uploads go the other way: one file, at most 64 MB, into the folder the
 * reader is looking at. Every path is normalised relative to the configured music folder; a caller
 * can name a child of it, never an address or a parent segment.
 */
import { Hono } from 'hono'
import {
  MUSIC_DRIVE_IMPORT_MAX_PATHS,
  MUSIC_DRIVE_UPLOAD_MAX_BYTES,
  type MusicDriveDeleteResult,
  type MusicDriveImportResult,
  type MusicDriveSkip,
  type MusicDriveUploadResult,
} from '@shared/music/api'
import { MUSIC_MIME_BY_FORMAT, formatFromFilename } from '@shared/music/constants'
import { MUSIC_PROVIDER_ID_MAX, musicWebdavProviderId, type MusicMount, type MusicTrack } from '@shared/music/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { encryptMusicMountToken } from '../lib/crypto'
import { readFormDataWithinLimit, readJson } from '../lib/request'
import { MusicStore } from '../music/store'
import { resolveMusicWebdav } from '../music/cloud/config'
import {
  alistMountBaseUrl,
  alistMountName,
  alistMountRoot,
  alistMountToken,
  listAlistDirectory,
  resolveAlistMount,
  searchAlist,
  testAlistMount,
} from '../music/cloud/alist'
import {
  deleteMusicObject,
  joinCloudPath,
  listMusicDirectory,
  normalizeCloudPath,
  putMusicObject,
  statMusicObject,
} from '../music/cloud/webdav'

/** Room for fifty maximum-length paths plus their JSON punctuation. */
const IMPORT_BODY_LIMIT = 64 * 1024
/** The multipart envelope around a file at the ceiling, with room for a boundary and the field. */
const UPLOAD_FORM_LIMIT = MUSIC_DRIVE_UPLOAD_MAX_BYTES + 1024 * 1024
const UPLOAD_FILENAME_MAX = 180
const PLAYLIST_ID_MAX = 128

export const musicDriveRoutes = new Hono<AppBindings>()

musicDriveRoutes.get('/', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const [quota, mounts] = await Promise.all([store.quotaUsage(), store.listMounts()])
  const settings = await store.getSettings()
  return c.json({
    r2: { bytes: quota.bytes, objects: quota.count },
    webdav: { configured: Boolean(settings?.cloudWebdavTargetId) },
    mounts: mounts.length,
  })
})

musicDriveRoutes.get('/webdav', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  let path: string
  try {
    path = normalizeCloudPath(c.req.query('path') ?? '', { allowEmpty: true })
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest('That folder path is not valid.')
  }
  try {
    const ctx = await resolveMusicWebdav(c.env, store, c.get('userId'))
    const listing = await listMusicDirectory(ctx, path)
    return c.json({
      configured: true,
      dir: ctx.dir,
      path,
      entries: listing.entries,
      truncated: listing.truncated,
      reason: null,
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) {
      return c.json({
        configured: false,
        dir: '',
        path,
        entries: [],
        truncated: false,
        reason: error.message,
      })
    }
    throw error
  }
})

/**
 * Register remote files in the library without moving their bytes.
 *
 * A path that is missing, is a folder, is not a media extension or would not fit the provider id
 * field is reported in `skipped` and the rest of the batch still lands. Re-importing the same path
 * refreshes the one row its reference already owns, so the call is safe to retry.
 */
musicDriveRoutes.post('/webdav/import', async (c) => {
  const body = await readJson<{ paths?: unknown; targetPlaylistId?: unknown }>(c, IMPORT_BODY_LIMIT)
  const paths = importPaths(body.paths)
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const playlistId = await targetPlaylist(body.targetPlaylistId, store)
  const ctx = await resolveMusicWebdav(c.env, store, c.get('userId'))

  const tracks: MusicTrack[] = []
  const skipped: MusicDriveSkip[] = []
  for (const raw of paths) {
    const path = normalizeCloudPath(raw, { allowEmpty: false })
    const entry = await statMusicObject(ctx, path)
    if (!entry) {
      skipped.push({ path, reason: 'missing' })
      continue
    }
    if (entry.isDirectory) {
      skipped.push({ path, reason: 'directory' })
      continue
    }
    const format = formatFromFilename(entry.name)
    if (!format) {
      skipped.push({ path, reason: 'unsupported' })
      continue
    }
    const providerId = musicWebdavProviderId(ctx.targetId, path)
    if (providerId.length > MUSIC_PROVIDER_ID_MAX) {
      skipped.push({ path, reason: 'path_too_long' })
      continue
    }
    tracks.push(await store.upsertTrack({
      provider: 'webdav',
      providerId,
      kind: 'song',
      title: trackTitle(entry.name, path),
      format,
      size: entry.sizeBytes,
      r2Key: null,
      source: 'webdav',
      sourceQuality: 'original',
    }))
  }

  if (playlistId && tracks.length > 0) {
    await store.addPlaylistItems(playlistId, tracks.map((track) => track.id))
  }
  const result: MusicDriveImportResult = { tracks, skipped }
  return c.json(result)
})

/**
 * Put one file into the folder the reader is looking at.
 *
 * The name is reduced to its base name and the extension decides the MIME type, so a client-declared
 * type cannot make this route store an HTML page. A file that already exists is refused rather than
 * overwritten: the reader chose a name, and the honest answer is to let them choose another.
 */
musicDriveRoutes.post('/webdav/upload', async (c) => {
  const dir = normalizeCloudPath(c.req.query('path') ?? '', { allowEmpty: true })
  const form = await readFormDataWithinLimit(c.req, UPLOAD_FORM_LIMIT)
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('Attach one file in the "file" field.')
  if (file.size === 0) throw ApiError.badRequest('That file is empty.')
  if (file.size > MUSIC_DRIVE_UPLOAD_MAX_BYTES) {
    throw ApiError.tooLarge(`Files must be ${MUSIC_DRIVE_UPLOAD_MAX_BYTES / (1024 * 1024)} MB or smaller.`)
  }
  const filename = uploadFilename(file.name)
  const format = formatFromFilename(filename)
  if (!format) throw new ApiError(415, 'music_upload_invalid', 'Upload an audio file or an MP4 video.')

  const store = new MusicStore(c.env.DB, c.get('userId'))
  const ctx = await resolveMusicWebdav(c.env, store, c.get('userId'))
  const target = joinCloudPath(dir, filename)
  if (await statMusicObject(ctx, target)) {
    throw new ApiError(409, 'conflict', 'A file with that name already exists in this folder.')
  }
  await putMusicObject(ctx, target, file, MUSIC_MIME_BY_FORMAT[format])
  const result: MusicDriveUploadResult = { path: target, size: file.size }
  return c.json(result, 201)
})

/**
 * Delete the remote file. A library row that references it is deliberately left alone: the reader
 * can still see what they imported, and the stream route answers 404 for the missing bytes.
 */
musicDriveRoutes.delete('/webdav/object', async (c) => {
  const path = normalizeCloudPath(c.req.query('path') ?? '', { allowEmpty: false })
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const ctx = await resolveMusicWebdav(c.env, store, c.get('userId'))
  const removed = await deleteMusicObject(ctx, path)
  const result: MusicDriveDeleteResult = { ok: true, removed }
  return c.json(result)
})

function importPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw ApiError.badRequest('Name at least one file to import.')
  }
  if (value.length > MUSIC_DRIVE_IMPORT_MAX_PATHS) {
    throw ApiError.badRequest(`Import at most ${MUSIC_DRIVE_IMPORT_MAX_PATHS} files at a time.`)
  }
  const paths = value.map((entry) => {
    if (typeof entry !== 'string') throw ApiError.badRequest('Each path must be text.')
    return entry.trim()
  }).filter(Boolean)
  const unique = [...new Set(paths)]
  if (!unique.length) throw ApiError.badRequest('Name at least one file to import.')
  return unique
}

async function targetPlaylist(value: unknown, store: MusicStore): Promise<string | null> {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > PLAYLIST_ID_MAX) {
    throw ApiError.badRequest('That playlist id is not valid.')
  }
  const playlist = await store.getPlaylist(value)
  if (!playlist) throw ApiError.notFound('That playlist does not exist.')
  return playlist.id
}

function uploadFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') throw ApiError.badRequest('That file has no usable name.')
  if (cleaned.length > UPLOAD_FILENAME_MAX) throw ApiError.badRequest('That file name is too long.')
  return cleaned
}

/** The file name without its extension; the path is the fallback when the name is all extension. */
function trackTitle(filename: string, path: string): string {
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot).trim() : ''
  return stem || filename || path
}

const MOUNT_BODY_LIMIT = 8 * 1024

function mountNotFound(): ApiError {
  return ApiError.notFound('That Alist mount does not exist.')
}

async function loadMount(store: MusicStore, id: string): Promise<MusicMount> {
  const mount = await store.getMount(id)
  if (!mount || mount.kind !== 'alist') throw mountNotFound()
  return mount
}

/** Tokens are write-only over HTTP: the route returns the row, never the ciphertext or its plaintext. */
musicDriveRoutes.get('/alist', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  return c.json({ mounts: await store.listMounts() })
})

musicDriveRoutes.post('/alist', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, MOUNT_BODY_LIMIT)
  const name = alistMountName(body.name)
  const baseUrl = alistMountBaseUrl(body.baseUrl)
  const rootPath = alistMountRoot(body.rootPath)
  const token = alistMountToken(body.token, true)
  if (!token) throw ApiError.badRequest('The Alist token is required.')
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const id = newId()
  const mount = await store.createMount({
    kind: 'alist',
    name,
    baseUrl,
    rootPath,
    secret: await encryptMusicMountToken(c.env, id, token),
    status: 'active',
  }, id)
  return c.json({ mount }, 201)
})

musicDriveRoutes.patch('/alist/:id', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, MOUNT_BODY_LIMIT)
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const id = c.req.param('id')
  await loadMount(store, id)
  const patch: Parameters<MusicStore['updateMount']>[1] = {
    ...(body.name === undefined ? {} : { name: alistMountName(body.name) }),
    ...(body.baseUrl === undefined ? {} : { baseUrl: alistMountBaseUrl(body.baseUrl) }),
    ...(body.rootPath === undefined ? {} : { rootPath: alistMountRoot(body.rootPath) }),
    ...(body.token === undefined
      ? {}
      : {
          secret: body.token === ''
            ? ''
            : await encryptMusicMountToken(c.env, id, alistMountToken(body.token, true) ?? ''),
        }),
  }
  const mount = await store.updateMount(id, patch)
  if (!mount) throw mountNotFound()
  return c.json({ mount })
})

musicDriveRoutes.delete('/alist/:id', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const id = c.req.param('id')
  await loadMount(store, id)
  if (!(await store.deleteMount(id))) throw mountNotFound()
  return c.json({ ok: true })
})

musicDriveRoutes.get('/alist/:id/list', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const ctx = await resolveAlistMount(c.env, store, c.req.param('id'))
  const listing = await listAlistDirectory(ctx, c.req.query('path') ?? '')
  if (ctx.mount.status !== 'active') {
    await store.updateMount(ctx.mount.id, { status: 'active' }).catch(() => undefined)
  }
  return c.json({ mount: ctx.mount, listing })
})

musicDriveRoutes.get('/alist/:id/search', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const ctx = await resolveAlistMount(c.env, store, c.req.param('id'))
  const entries = await searchAlist(ctx, c.req.query('keywords') ?? '')
  return c.json({ mount: ctx.mount, entries })
})

musicDriveRoutes.post('/alist/:id/test', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const id = c.req.param('id')
  try {
    const ctx = await resolveAlistMount(c.env, store, id)
    await testAlistMount(ctx)
    await store.updateMount(id, { status: 'active' })
    return c.json({ ok: true })
  } catch (error) {
    await store.updateMount(id, { status: 'error' }).catch(() => undefined)
    throw error
  }
})
