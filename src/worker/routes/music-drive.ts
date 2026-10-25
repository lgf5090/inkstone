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
  type MusicDriveBatchResult,
  type MusicDriveDeleteResult,
  type MusicDriveImportResult,
  type MusicDriveR2Listing,
  type MusicDriveR2UploadResult,
  type MusicDriveSkip,
  type MusicDriveUploadResult,
} from '@shared/music/api'
import { MUSIC_LIMITS, MUSIC_MIME_BY_FORMAT, formatFromFilename } from '@shared/music/constants'
import {
  MUSIC_PROVIDER_ID_MAX,
  musicAlistProviderId,
  musicTrackKey,
  musicWebdavProviderId,
  type MusicMount,
  type MusicTrack,
} from '@shared/music/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { encryptMusicMountToken } from '../lib/crypto'
import { readFormDataWithinLimit, readJson } from '../lib/request'
import { MusicDownloadStore } from '../music/download-store'
import { MusicStore } from '../music/store'
import {
  declaredUploadFormat,
  formatCompatibleWithContainer,
  inspectMusicCover,
  sanitizeMusicFilename,
  sanitizeUploadMetadata,
  sniffMusicFormat,
  titleFromFilename,
} from '../music/metadata'
import {
  MUSIC_COVER_CACHE_CONTROL,
  deleteMusicObjects,
  discardMusicObjects,
  hasMusicStorage,
  musicCoverKeyFor,
  musicObjectKeyFor,
  putMusicObject as putR2Object,
  withMusicQuotaLease,
} from '../music/storage'
import { resolveMusicWebdav } from '../music/cloud/config'
import {
  alistMountBaseUrl,
  alistMountName,
  alistMountRoot,
  alistMountToken,
  listAlistDirectory,
  normalizeAlistPath,
  putAlistFile,
  removeAlistFile,
  resolveAlistMount,
  statAlistFile,
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
/** One parsed tag document plus a cover at the image ceiling. */
const METADATA_FORM_LIMIT = MUSIC_LIMITS.coverMaxBytes + 128 * 1024
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

/** The account's R2 objects, with the track snapshot that names each one when it still exists. */
musicDriveRoutes.get('/r2', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const objects = await store.listObjects(500)
  const result: MusicDriveR2Listing = {
    entries: objects.map((object) => ({
      key: object.r2Key,
      trackId: object.trackId,
      title: object.title ?? object.r2Key.split('/').pop() ?? object.r2Key,
      artists: object.artists.map((artist) => artist.name).filter(Boolean),
      format: object.format,
      size: object.size,
      createdAt: object.createdAt,
    })),
    truncated: objects.length >= 500,
  }
  return c.json(result)
})

/**
 * Store one file directly into R2.
 *
 * This is the cloud-drive path, so it also creates the library snapshot: the bytes, the track row and
 * the ledger entry are one operation under the quota lease. Metadata comes from the browser's parser
 * but is trimmed here, and the container is decided from the bytes rather than the extension.
 */
musicDriveRoutes.post('/r2/upload', async (c) => {
  const form = await readFormDataWithinLimit(c.req, UPLOAD_FORM_LIMIT)
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('Attach one file in the "file" field.')
  if (file.size === 0) throw ApiError.badRequest('That file is empty.')
  if (file.size > MUSIC_DRIVE_UPLOAD_MAX_BYTES) {
    throw ApiError.tooLarge(`Files must be ${MUSIC_DRIVE_UPLOAD_MAX_BYTES / (1024 * 1024)} MB or smaller.`)
  }
  const filename = sanitizeMusicFilename(file.name)
  const declared = declaredUploadFormat(filename, form.get('format') ?? undefined)
  if (!declared) throw new ApiError(415, 'music_upload_invalid', 'Upload an audio file or an MP4 video.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const format = sniffMusicFormat(bytes, declared)
  if (!format) {
    throw new ApiError(415, 'music_upload_invalid', 'The file is not a supported audio or video container')
  }
  if (!formatCompatibleWithContainer(declared, format)) {
    throw new ApiError(415, 'music_upload_invalid', 'The file content does not match its extension')
  }
  const rawMetadata = form.get('metadata')
  let parsedMetadata: unknown = {}
  if (typeof rawMetadata === 'string' && rawMetadata) {
    try {
      parsedMetadata = JSON.parse(rawMetadata)
    } catch {
      throw ApiError.badRequest('The metadata field must be JSON')
    }
  }
  const metadata = sanitizeUploadMetadata(parsedMetadata, titleFromFilename(filename))

  const store = new MusicStore(c.env.DB, c.get('userId'))
  const trackId = newId()
  const userId = c.get('userId')
  const key = musicObjectKeyFor({ format, userId, trackId, quality: 'original' })
  const track = await withMusicQuotaLease(c.env, store, bytes.length, async () => {
    await putR2Object(c.env, key, bytes, {
      contentType: MUSIC_MIME_BY_FORMAT[format],
      userId,
      trackId,
      kind: 'track',
    })
    try {
      const created = await store.upsertTrack({
        id: trackId,
        provider: 'upload',
        providerId: trackId,
        kind: 'song',
        title: metadata.title,
        artists: metadata.artists.map((name) => ({ id: '', name })),
        album: metadata.album,
        durationMs: metadata.durationMs,
        format,
        bitrate: metadata.bitrate,
        size: bytes.length,
        r2Key: key,
        source: 'upload',
        sourceQuality: 'original',
      })
      await store.registerObject({
        r2Key: key,
        trackId: created.id,
        format,
        quality: 'original',
        size: bytes.length,
      })
      if (metadata.lyrics) {
        await store.saveLyric({
          trackKey: `upload:${created.id}`,
          source: 'embedded',
          lrc: metadata.lyrics,
          tlyric: '',
          yrc: '',
        }).catch((error: unknown) => {
          console.warn('[inkstone] Embedded music lyrics could not be cached:', error)
        })
      }
      return created
    } catch (error) {
      await discardMusicObjects(c.env, store, [key])
      throw error
    }
  })
  const result: MusicDriveR2UploadResult = {
    track,
    entry: {
      key,
      trackId: track.id,
      title: track.title,
      artists: track.artists.map((artist) => artist.name).filter(Boolean),
      format,
      size: bytes.length,
      createdAt: track.createdAt,
    },
  }
  return c.json(result, 201)
})

/** Delete objects, and the library tracks that name them, when nothing else still references them. */
musicDriveRoutes.post('/r2/delete', async (c) => {
  const body = await readJson<{ keys?: unknown }>(c, IMPORT_BODY_LIMIT)
  const keys = objectKeys(body.keys)
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const result: MusicDriveBatchResult = { removed: [], skipped: [] }
  for (const key of keys) {
    try {
      const object = await store.getObject(key)
      if (!object) {
        result.skipped.push({ path: key, reason: 'missing' })
        continue
      }
      const track = object.trackId ? await store.getTrack(object.trackId) : null
      if (track && track.r2Key === key) {
        const deleted = await store.deleteTrack(track.id)
        if (!deleted.deleted) {
          result.skipped.push({ path: key, reason: 'failed' })
          continue
        }
        if (!deleted.queuedObjects.includes(key)) {
          result.skipped.push({ path: key, reason: 'referenced' })
          continue
        }
        await deleteMusicObjects(c.env, store, deleted.queuedObjects)
        for (const queued of deleted.queuedObjects) await store.dropCleanup(queued)
        result.removed.push(key)
        continue
      }
      // A cache object (a download) leaves its track snapshot alone; only the file and its task go.
      const downloadId = await store.findDownloadByObjectKey(key)
      if (downloadId) await new MusicDownloadStore(c.env.DB, c.get('userId')).remove(downloadId)
      if (!(await store.removeObject(key))) {
        result.skipped.push({ path: key, reason: 'referenced' })
        continue
      }
      await deleteMusicObjects(c.env, store, [key])
      await store.dropCleanup(key)
      result.removed.push(key)
    } catch (error) {
      console.warn('[inkstone] R2 object could not be deleted:', error)
      result.skipped.push({ path: key, reason: 'failed' })
    }
  }
  return c.json(result)
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
 * Attach the tags the browser read from an imported reference.
 *
 * The import route registers a path without touching the audio, so duration, artwork and embedded
 * lyrics are unknown until something reads the file. The browser reads only the prefix it needs and
 * posts the result here; this route validates it, stores the cover beside the account's other music
 * objects and caches the lyric under the same provider key the lyric route reads. Re-running the
 * import and then this route refreshes the row instead of creating a second one.
 */
musicDriveRoutes.post('/imported/:trackId/metadata', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const trackId = c.req.param('trackId')
  if (!trackId || trackId.length > 128) throw ApiError.notFound('That track does not exist')
  const track = await store.getTrack(trackId)
  if (!track) throw ApiError.notFound('That track does not exist')
  if (track.provider !== 'webdav' && track.provider !== 'alist') {
    throw ApiError.badRequest('Only WebDAV and Alist imports can take embedded metadata')
  }

  const form = await readFormDataWithinLimit(c.req, METADATA_FORM_LIMIT)
  const raw = form.get('metadata')
  if (typeof raw !== 'string' || !raw) {
    throw ApiError.badRequest('Attach the parsed tags in the "metadata" field')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw ApiError.badRequest('The metadata field must be JSON')
  }
  const metadata = sanitizeUploadMetadata(parsed, track.title)

  let coverKey = track.coverKey
  let previousCoverKey = ''
  const cover = form.get('cover')
  if (cover instanceof File) {
    if (cover.size === 0) throw ApiError.badRequest('The cover is empty')
    if (cover.size > MUSIC_LIMITS.coverMaxBytes) {
      throw ApiError.tooLarge(`The cover exceeds the ${MUSIC_LIMITS.coverMaxBytes / (1024 * 1024)} MB limit`)
    }
    if (hasMusicStorage(c.env)) {
      const bytes = new Uint8Array(await cover.arrayBuffer())
      const info = inspectMusicCover(bytes, cover.type)
      const key = musicCoverKeyFor({ userId: c.get('userId'), trackId: track.id, extension: info.extension })
      await putR2Object(c.env, key, bytes, {
        contentType: info.mime,
        cacheControl: MUSIC_COVER_CACHE_CONTROL,
        userId: c.get('userId'),
        trackId: track.id,
        kind: 'cover',
      })
      previousCoverKey = track.coverKey
      coverKey = key
    } else {
      // The deployment has a music library without object storage; tags and lyrics still apply.
      console.warn('[inkstone] Imported music cover was skipped because this deployment has no music storage')
    }
  }

  const artists = metadata.artists.length > 0
    ? metadata.artists.map((name) => ({ id: '', name }))
    : track.artists
  const durationMs = metadata.durationMs > 0 ? metadata.durationMs : track.durationMs
  const bitrate = metadata.bitrate ?? track.bitrate
  let updated: MusicTrack | null
  try {
    updated = await store.attachEmbeddedMetadata(track.id, {
      title: metadata.title,
      artists,
      album: metadata.album || track.album,
      durationMs,
      bitrate,
      coverKey,
    })
  } catch (error) {
    if (coverKey !== previousCoverKey) await discardMusicObjects(c.env, store, [coverKey])
    throw error
  }
  if (!updated) throw ApiError.notFound('That track does not exist')

  if (metadata.lyrics) {
    await store.saveLyric({
      trackKey: musicTrackKey(track.provider, track.providerId),
      source: 'embedded',
      lrc: metadata.lyrics,
      tlyric: '',
      yrc: '',
    }).catch((error: unknown) => {
      console.warn('[inkstone] Embedded cloud music lyrics could not be cached:', error)
    })
  }
  if (previousCoverKey && previousCoverKey !== coverKey) {
    await discardMusicObjects(c.env, store, [previousCoverKey])
  }
  return c.json({ track: updated })
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

/** The batch form of the same delete, so a multi-selection is one round trip. */
musicDriveRoutes.post('/webdav/delete', async (c) => {
  const body = await readJson<{ paths?: unknown }>(c, IMPORT_BODY_LIMIT)
  const paths = importPaths(body.paths)
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const ctx = await resolveMusicWebdav(c.env, store, c.get('userId'))
  const result: MusicDriveBatchResult = { removed: [], skipped: [] }
  for (const raw of paths) {
    const path = normalizeCloudPath(raw, { allowEmpty: false })
    try {
      if (await deleteMusicObject(ctx, path)) result.removed.push(path)
      else result.skipped.push({ path, reason: 'missing' })
    } catch (error) {
      console.warn('[inkstone] WebDAV file could not be deleted:', error)
      result.skipped.push({ path, reason: 'failed' })
    }
  }
  return c.json(result)
})

const OBJECT_BATCH_MAX = 100

function objectKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw ApiError.badRequest('Name at least one object to delete.')
  }
  if (value.length > OBJECT_BATCH_MAX) {
    throw ApiError.badRequest(`Delete at most ${OBJECT_BATCH_MAX} objects at a time.`)
  }
  const keys = value.map((entry) => {
    if (typeof entry !== 'string') throw ApiError.badRequest('Each object key must be text.')
    return entry.trim()
  }).filter(Boolean)
  const unique = [...new Set(keys)]
  if (!unique.length) throw ApiError.badRequest('Name at least one object to delete.')
  for (const key of unique) {
    if (key.length > 512 || !key.startsWith('music/') || key.includes('..')) {
      throw ApiError.badRequest('That object key is not a music object.')
    }
  }
  return unique
}

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

musicDriveRoutes.post('/alist/:id/import', async (c) => {
  const body = await readJson<{ paths?: unknown }>(c, IMPORT_BODY_LIMIT)
  const paths = importPaths(body.paths)
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const ctx = await resolveAlistMount(c.env, store, c.req.param('id'))

  const tracks: MusicTrack[] = []
  const skipped: MusicDriveSkip[] = []
  for (const raw of paths) {
    const path = normalizeAlistPath(raw)
    const info = await statAlistFile(ctx, path)
    if (info.isDirectory) {
      skipped.push({ path, reason: 'directory' })
      continue
    }
    const format = formatFromFilename(info.name)
    if (!format) {
      skipped.push({ path, reason: 'unsupported' })
      continue
    }
    const providerId = musicAlistProviderId(ctx.mount.id, path)
    if (providerId.length > MUSIC_PROVIDER_ID_MAX) {
      skipped.push({ path, reason: 'path_too_long' })
      continue
    }
    tracks.push(await store.upsertTrack({
      provider: 'alist',
      providerId,
      kind: 'song',
      title: trackTitle(info.name.split('/').pop()?.slice(0, 500) || info.name, path),
      format,
      size: info.sizeBytes,
      r2Key: null,
      source: 'alist',
      sourceQuality: 'original',
    }))
  }
  const result: MusicDriveImportResult = { tracks, skipped }
  return c.json(result)
})

/** Upload into the folder on screen. As with WebDAV, the file name decides the type. */
musicDriveRoutes.post('/alist/:id/upload', async (c) => {
  const dir = normalizeAlistPath(c.req.query('path') ?? '')
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
  const ctx = await resolveAlistMount(c.env, store, c.req.param('id'))
  const target = normalizeAlistPath(dir ? `${dir}/${filename}` : filename)
  // The parent directory is already the one on screen: listing it is the one check that separates
  // "missing" from "the token is wrong" before a PUT could overwrite a same-named remote file.
  const listing = await listAlistDirectory(ctx, dir)
  if (listing.entries.some((entry) => entry.name === filename)) {
    throw new ApiError(409, 'conflict', 'A file with that name already exists in this folder.')
  }
  await putAlistFile(ctx, target, new Uint8Array(await file.arrayBuffer()), MUSIC_MIME_BY_FORMAT[format])
  const result: MusicDriveUploadResult = { path: target, size: file.size }
  return c.json(result, 201)
})

musicDriveRoutes.post('/alist/:id/delete', async (c) => {
  const body = await readJson<{ paths?: unknown }>(c, IMPORT_BODY_LIMIT)
  const paths = importPaths(body.paths)
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const ctx = await resolveAlistMount(c.env, store, c.req.param('id'))
  const result: MusicDriveBatchResult = { removed: [], skipped: [] }
  for (const raw of paths) {
    const path = normalizeAlistPath(raw)
    if (!path) {
      result.skipped.push({ path, reason: 'missing' })
      continue
    }
    try {
      if (await removeAlistFile(ctx, path)) result.removed.push(path)
      else result.skipped.push({ path, reason: 'missing' })
    } catch (error) {
      console.warn('[inkstone] Alist file could not be deleted:', error)
      result.skipped.push({ path, reason: 'failed' })
    }
  }
  return c.json(result)
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
