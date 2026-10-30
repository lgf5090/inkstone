import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireImgbedActor } from './auth'
import { StorageError } from './storage'
import { uploadSingle, type UploadQuery } from './upload-service'
import { buildFileId, sanitizeFileName, sanitizeFolderPath, type ImgbedPart, type ImgbedChannelType } from '@shared/imgbed/model'
import { getSettingsGroup, fileExists, insertFile } from './store'
import { availableChannelsForUpload, listResolvedChannels } from './channels'
import { pickChannel } from './upload-service'
import { abortMultipart, completeMultipart, createMultipart, putDiscordPart, putTelegramPart, uploadMultipartPart, type MultipartSession } from './storage'
import { newId } from '../lib/id'
import { ImgbedSettingsError } from '@shared/imgbed/settings'
import { UrlGuardError, assertPublicHttpUrl } from './url-guard'

export const imgbedUploadRoutes = new Hono<AppBindings>()

function queryFrom(requestUrl: string): UploadQuery {
  const url = new URL(requestUrl)
  return {
    uploadChannel: url.searchParams.get('uploadChannel') ?? undefined,
    channelName: url.searchParams.get('channelName') ?? undefined,
    uploadFolder: url.searchParams.get('uploadFolder') ?? undefined,
    uploadNameType: url.searchParams.get('uploadNameType') ?? undefined,
    returnFormat: url.searchParams.get('returnFormat') ?? undefined,
    autoRetry: url.searchParams.get('autoRetry') ?? undefined,
  }
}

function uploadFailure(c: { json: (body: unknown, status?: number) => Response }, error: unknown): Response {
  if (error instanceof ApiError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status)
  }
  if (error instanceof StorageError) {
    return c.json({ error: { code: 'UPLOAD_FAILED', message: error.message } }, error.status as 400 | 413 | 502 | 503)
  }
  if (error instanceof ImgbedSettingsError) {
    return c.json({ error: { code: 'INVALID_SETTINGS', message: error.message } }, 400)
  }
  console.warn('[inkstone] image-bed upload failed:', error)
  return c.json({ error: { code: 'UPLOAD_FAILED', message: 'The upload failed' } }, 500)
}

imgbedUploadRoutes.post('/upload', async (c) => {
  try {
    const actor = await requireImgbedActor(c, 'upload')
    if (!actor) throw ApiError.unauthenticated()
    const length = Number(c.req.header('content-length') ?? 0)
    if (length > 100 * 1024 * 1024) throw new StorageError('This upload is too large for a single request', 413)
    const form = await c.req.formData()
    const result = await uploadSingle(c.env, c.env.DB, actor, c.req.raw, form, queryFrom(c.req.url))
    return c.json([result])
  } catch (error) {
    return uploadFailure(c, error)
  }
})

interface SessionRow {
  id: string
  actor_key: string
  file_name: string
  file_type: string
  folder: string
  name_type: string
  channel: string
  channel_name: string
  total_parts: number
  part_size: number
  remote_upload_id: string
  object_key: string
  parts: string
  status: string
  file_id: string | null
  expires_at: number
}

async function session(c: { env: AppBindings['Bindings'] }, id: string): Promise<SessionRow> {
  const row = await c.env.DB.prepare('SELECT * FROM imgbed_upload_sessions WHERE id = ?1').bind(id).first<SessionRow>()
  if (!row) throw ApiError.notFound('Upload session not found')
  if (row.expires_at < Date.now()) throw ApiError.badRequest('Upload session expired')
  return row
}

function canonical(type: string): string {
  return type === 'cfr2' ? 'CloudflareR2' : type === 'telegram' ? 'TelegramNew' : type === 's3' ? 'S3'
    : type === 'discord' ? 'Discord' : type === 'huggingface' ? 'HuggingFace' : 'WebDAV'
}

imgbedUploadRoutes.post('/uploads/init', async (c) => {
  try {
    const actor = await requireImgbedActor(c, 'upload')
    if (!actor) throw ApiError.unauthenticated()
    const body = await c.req.json().catch(() => null) as {
      fileName?: string; fileType?: string; size?: number; folder?: string; nameType?: string;
      channel?: string; channelName?: string
    } | null
    const fileName = sanitizeFileName(body?.fileName ?? '')
    const size = Number(body?.size ?? 0)
    if (!fileName || !Number.isFinite(size) || size <= 0) throw ApiError.badRequest('fileName and size are required')
    if (size > 5 * 1024 * 1024 * 1024) throw new StorageError('File exceeds the 5 GB limit', 413)
    const page = await getSettingsGroup(c.env.DB, 'page')
    const upload = await getSettingsGroup(c.env.DB, 'upload')
    const requested = (body?.channel ?? page.defaultUploadChannel) as ImgbedChannelType
    const channels = await availableChannelsForUpload(c.env, c.env.DB)
    const channel = pickChannel(channels, requested, body?.channelName, upload.loadBalance[requested] === true) ?? channels[0] ?? null
    if (!channel) throw new StorageError('No upload channel is configured', 400)
    const fileType = body?.fileType || 'application/octet-stream'
    const folder = sanitizeFolderPath(body?.folder ?? page.defaultFolder)
    const nameType = (body?.nameType ?? page.defaultNameType) as 'default' | 'index' | 'origin' | 'short'
    const fileId = await buildFileId({ fileName, fileType, folder, nameType, exists: (candidate) => fileExists(c.env.DB, candidate) })
    const id = newId()
    const expiresAt = Date.now() + 24 * 3600 * 1000
    if (channel.type === 'huggingface' || channel.type === 'webdav') {
      if (size > 100 * 1024 * 1024) throw new StorageError('This channel does not support files above 100 MB', 413)
      return c.json({ mode: 'single', uploadId: '', partSize: 0, totalParts: 0, channel: channel.type, channelName: channel.name })
    }
    const partSize = channel.type === 'discord' ? 9 * 1024 * 1024 : 16 * 1024 * 1024
    const totalParts = Math.ceil(size / partSize)
    if (totalParts > 10_000) throw new StorageError('Too many parts', 413)
    let multipart: MultipartSession | null = null
    if (channel.type === 'cfr2' || channel.type === 's3') {
      multipart = await createMultipart(c.env, channel, { id: fileId, fileName, fileType, bytes: new Uint8Array() })
    }
    await c.env.DB.prepare(
      `INSERT INTO imgbed_upload_sessions
         (id, actor_key, file_name, file_type, folder, name_type, channel, channel_name,
          total_parts, part_size, remote_upload_id, object_key, parts, status, file_id, created_at, expires_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'[]','uploading',?13,?14,?15)`,
    ).bind(id, actor.actorKey, fileName, fileType, folder, nameType, channel.type, channel.name,
      totalParts, partSize, multipart?.uploadId ?? '', multipart?.objectKey ?? '', fileId, Date.now(), expiresAt).run()
    return c.json({ mode: channel.type === 'telegram' || channel.type === 'discord' ? 'chunked' : 'multipart', uploadId: id, partSize, totalParts, channel: channel.type, channelName: channel.name })
  } catch (error) { return uploadFailure(c, error) }
})

imgbedUploadRoutes.put('/uploads/:id/parts/:index', async (c) => {
  try {
    const actor = await requireImgbedActor(c, 'upload')
    const row = await session(c, c.req.param('id'))
    if (row.actor_key !== actor?.actorKey) throw ApiError.forbidden('This upload belongs to another actor')
    const index = Number(c.req.param('index'))
    if (!Number.isInteger(index) || index < 0 || index >= row.total_parts) throw ApiError.badRequest('Invalid part index')
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength > row.part_size + 1024) throw new StorageError('Part is too large', 413)
    const channels = await listResolvedChannels(c.env, c.env.DB, true)
    const channel = channels.find((item) => item.type === row.channel && item.name === row.channel_name)
    if (!channel) throw new StorageError('The upload channel is no longer configured', 503)
    const existing = JSON.parse(row.parts || '[]') as Record<string, unknown>[]
    let part: Record<string, unknown>
    if (channel.type === 'telegram') {
      const result = await putTelegramPart(channel, { id: row.file_id ?? row.object_key, fileName: row.file_name, fileType: row.file_type, bytes }, index)
      part = { ...result }
    } else if (channel.type === 'discord') {
      const result = await putDiscordPart(channel, { id: row.file_id ?? row.object_key, fileName: row.file_name, fileType: row.file_type, bytes }, index)
      part = { ...result }
    } else {
      const result = await uploadMultipartPart(c.env, channel, { uploadId: row.remote_upload_id, objectKey: row.object_key }, index, bytes)
      part = { ...result, index, size: bytes.byteLength }
    }
    const next = existing.filter((item) => Number(item.index) !== index)
    next.push(part)
    await c.env.DB.prepare('UPDATE imgbed_upload_sessions SET parts = ?2 WHERE id = ?1').bind(row.id, JSON.stringify(next)).run()
    return c.json({ ok: true, part })
  } catch (error) { return uploadFailure(c, error) }
})

imgbedUploadRoutes.post('/uploads/:id/complete', async (c) => {
  try {
    const actor = await requireImgbedActor(c, 'upload')
    const row = await session(c, c.req.param('id'))
    if (row.actor_key !== actor?.actorKey) throw ApiError.forbidden('This upload belongs to another actor')
    if (row.status === 'completed' && row.file_id) {
      return c.json({ src: `/imgbed/file/${row.file_id}`, url: `/imgbed/file/${row.file_id}`, id: row.file_id })
    }
    const parts = JSON.parse(row.parts || '[]') as Record<string, unknown>[]
    if (parts.length !== row.total_parts) throw ApiError.badRequest(`Expected ${row.total_parts} parts, received ${parts.length}`)
    const channels = await listResolvedChannels(c.env, c.env.DB, true)
    const channel = channels.find((item) => item.type === row.channel && item.name === row.channel_name)
    if (!channel) throw new StorageError('The upload channel is no longer configured', 503)
    let objectKey = row.object_key
    let storedParts: ImgbedPart[] | null = null
    if (channel.type === 'cfr2' || channel.type === 's3') {
      const multipartParts = [...parts].sort((a, b) => Number(a.partNumber) - Number(b.partNumber)).map((part) => ({ partNumber: Number(part.partNumber), etag: String(part.etag) }))
      const metadata = await completeMultipart(c.env, channel, { uploadId: row.remote_upload_id, objectKey: row.object_key }, multipartParts)
      objectKey = row.object_key
      if (metadata.S3FileKey) objectKey = metadata.S3FileKey
    } else {
      storedParts = [...parts].sort((a, b) => Number(a.index) - Number(b.index)).map((part) => ({
        index: Number(part.index), size: Number(part.size),
        ...(part.fileId ? { fileId: String(part.fileId) } : {}),
        ...(part.messageId ? { messageId: String(part.messageId) } : {}),
      }))
    }
    const size = parts.reduce((sum, part) => sum + Number(part.size ?? 0), 0)
    await insertFile(c.env.DB, {
      id: row.file_id!, objectKey, fileName: row.file_name, fileType: row.file_type, sizeBytes: size,
      width: null, height: null, uploadIp: null, uploadAddress: null, source: channel.type,
      channel: canonical(channel.type), channelName: channel.name, isChunked: Boolean(storedParts),
      parts: storedParts, uploaderId: actor!.userId, createdAt: Date.now(),
    })
    await c.env.DB.prepare("UPDATE imgbed_upload_sessions SET status = 'completed', file_id = ?2, expires_at = ?3 WHERE id = ?1")
      .bind(row.id, row.file_id, Date.now() + 3600 * 1000).run()
    return c.json({ src: `/imgbed/file/${row.file_id}`, url: `/imgbed/file/${row.file_id}`, id: row.file_id, size, channel: canonical(channel.type), channelName: channel.name })
  } catch (error) { return uploadFailure(c, error) }
})

imgbedUploadRoutes.delete('/uploads/:id', async (c) => {
  try {
    const actor = await requireImgbedActor(c, 'upload')
    const row = await session(c, c.req.param('id'))
    if (row.actor_key !== actor?.actorKey) throw ApiError.forbidden('This upload belongs to another actor')
    if (row.remote_upload_id) {
      const channels = await listResolvedChannels(c.env, c.env.DB, true)
      const channel = channels.find((item) => item.type === row.channel && item.name === row.channel_name)
      if (channel) await abortMultipart(c.env, channel, { uploadId: row.remote_upload_id, objectKey: row.object_key })
    }
    await c.env.DB.prepare('DELETE FROM imgbed_upload_sessions WHERE id = ?1').bind(row.id).run()
    return c.json({ ok: true })
  } catch (error) { return uploadFailure(c, error) }
})

async function readCapped(response: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > cap) {
    await response.body?.cancel().catch(() => {})
    throw new ApiError(413, 'payload_too_large', 'The remote file exceeds 10 MB')
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => {})
      throw new ApiError(413, 'payload_too_large', 'The remote file exceeds 10 MB')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

imgbedUploadRoutes.post('/fetch-url', async (c) => {
  try {
    await requireImgbedActor(c, 'upload')
    const body = await c.req.json().catch(() => null) as { url?: unknown } | null
    const raw = typeof body?.url === 'string' ? body.url.trim() : ''
    if (!raw || raw.length > 2048) throw new ApiError(400, 'bad_request', 'A URL is required')
    let current: URL
    try { current = await assertPublicHttpUrl(raw) }
    catch (error) { if (error instanceof UrlGuardError) throw new ApiError(400, 'bad_request', error.message); throw error }
    let response: Response | null = null
    for (let hop = 0; hop < 5; hop++) {
      response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) break
        const next = new URL(location, current)
        try { current = await assertPublicHttpUrl(next) }
        catch (error) { if (error instanceof UrlGuardError) throw new ApiError(400, 'bad_request', 'Redirect to a disallowed target'); throw error }
        await response.body?.cancel().catch(() => {})
        continue
      }
      break
    }
    if (!response || !response.ok) throw new ApiError(502, 'internal', 'The URL could not be fetched')
    const bytes = await readCapped(response, 10 * 1024 * 1024)
    const headers = new Headers()
    headers.set('Content-Type', response.headers.get('content-type') ?? 'application/octet-stream')
    const disposition = response.headers.get('content-disposition')
    if (disposition) headers.set('Content-Disposition', disposition)
    headers.set('Cache-Control', 'no-store')
    return new Response(bytes, { status: 200, headers })
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof StorageError) return c.json({ error: { code: 'UPLOAD_FAILED', message: error.message } }, error.status as 400 | 413 | 502 | 503)
    console.warn('[inkstone] image-bed fetch-url failed:', error)
    return c.json({ error: { code: 'FETCH_FAILED', message: 'The URL could not be fetched' } }, 502)
  }
})
