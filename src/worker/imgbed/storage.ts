import { AwsClient } from 'aws4fetch'
import { sha256Hex } from '../lib/encoding'
import { categoryFor } from '@shared/imgbed/model'
import type { ImgbedFile, ImgbedPart } from '@shared/imgbed/model'
import type { Env } from '../env'
import type { ResolvedChannel } from './channels'

export interface StorageFile {
  id: string
  fileName: string
  fileType: string
  bytes: Uint8Array
}

export interface PutResult {
  objectKey: string
  metadata: Record<string, string | number | boolean | null>
}

export class StorageError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message)
    this.name = 'StorageError'
  }
}

export function channelConfig<T = string>(channel: ResolvedChannel, key: string, fallback?: T): T {
  const value = channel.config[key]
  return (value === undefined || value === null ? fallback : value) as T
}

export function channelSecret(channel: ResolvedChannel, key: string): string {
  const value = channel.credentials[key]
  return typeof value === 'string' ? value : ''
}

export function r2ObjectKey(id: string, fileType: string, fileName: string): string {
  return `imgbed/${categoryFor(fileType, fileName)}/${id}`
}

export function publicFileUrl(channel: ResolvedChannel, id: string): string {
  const prefix = String(channel.config.publicUrl ?? channel.config.cdnDomain ?? '').replace(/\/+$/, '')
  return prefix ? `${prefix}/${id}` : ''
}

export async function putWholeFile(env: Env, channel: ResolvedChannel, file: StorageFile): Promise<PutResult> {
  switch (channel.type) {
    case 'cfr2': return await putR2(env, file)
    case 's3': return await putS3(channel, file)
    case 'telegram': return await putTelegram(channel, file)
    case 'discord': return await putDiscord(channel, file)
    case 'huggingface': return await putHuggingFace(channel, file)
    case 'webdav': return await putWebDav(channel, file)
    default: throw new StorageError('Unsupported channel')
  }
}

async function putR2(env: Env, file: StorageFile): Promise<PutResult> {
  if (!env.FILES) throw new StorageError('R2 storage is not configured', 503)
  const objectKey = r2ObjectKey(file.id, file.fileType, file.fileName)
  await env.FILES.put(objectKey, file.bytes, { httpMetadata: { contentType: file.fileType } })
  return { objectKey, metadata: {} }
}

function s3Client(channel: ResolvedChannel): AwsClient {
  const accessKeyId = channelSecret(channel, 'accessKeyId')
  const secretAccessKey = channelSecret(channel, 'secretAccessKey')
  if (!accessKeyId || !secretAccessKey) throw new StorageError('S3 credentials are missing', 503)
  return new AwsClient({
    accessKeyId,
    secretAccessKey,
    region: channelConfig(channel, 'region', 'auto'),
    service: 's3',
    retries: 2,
  })
}

export function s3ObjectUrl(channel: ResolvedChannel, key: string): string {
  const endpointRaw = channelConfig(channel, 'endpoint', '').trim()
  const region = channelConfig(channel, 'region', 'auto')
  const endpoint = new URL(endpointRaw || `https://s3.${region === 'auto' ? 'us-east-1' : region}.amazonaws.com`)
  const bucket = channelConfig(channel, 'bucketName', '')
  const pathStyle = channelConfig<boolean>(channel, 'pathStyle', false)
  const encodedKey = key.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  const prefix = endpoint.pathname.replace(/\/+$/, '')
  if (pathStyle) return `${endpoint.origin}${prefix}/${encodeURIComponent(bucket)}/${encodedKey}`
  return `${endpoint.protocol}//${bucket}.${endpoint.host}${prefix}/${encodedKey}`
}

async function putS3(channel: ResolvedChannel, file: StorageFile): Promise<PutResult> {
  const aws = s3Client(channel)
  const key = file.id
  const headers: Record<string, string> = { 'Content-Type': file.fileType }
  const userAgent = channelConfig(channel, 'userAgent', '')
  if (userAgent) headers['User-Agent'] = userAgent
  const response = await aws.fetch(s3ObjectUrl(channel, key), {
    method: 'PUT', body: file.bytes as unknown as BodyInit, headers, redirect: 'manual',
  })
  if (!response.ok) throw new StorageError(`S3 upload failed (${response.status})`, 502)
  await response.body?.cancel().catch(() => {})
  return { objectKey: key, metadata: { S3FileKey: key } }
}

export async function getS3Object(channel: ResolvedChannel, key: string, range?: string | null): Promise<Response> {
  const aws = s3Client(channel)
  const headers: Record<string, string> = {}
  if (range) headers.Range = range
  const response = await aws.fetch(s3ObjectUrl(channel, key), { method: 'GET', headers, redirect: 'manual' })
  if (response.status === 404) { await response.body?.cancel().catch(() => {}); throw new StorageError('S3 object not found', 404) }
  if (!response.ok && response.status !== 206) throw new StorageError(`S3 read failed (${response.status})`, 502)
  return response
}

export async function deleteS3Object(channel: ResolvedChannel, key: string): Promise<void> {
  const aws = s3Client(channel)
  const response = await aws.fetch(s3ObjectUrl(channel, key), { method: 'DELETE', redirect: 'manual' })
  if (!response.ok && response.status !== 404) throw new StorageError(`S3 delete failed (${response.status})`, 502)
  await response.body?.cancel().catch(() => {})
}

export async function moveS3Object(channel: ResolvedChannel, oldKey: string, newKey: string, contentType?: string): Promise<void> {
  const aws = s3Client(channel)
  const headers: Record<string, string> = { 'x-amz-copy-source': `/${channelConfig(channel, 'bucketName', '')}/${oldKey}` }
  if (contentType) headers['x-amz-metadata-directive'] = 'REPLACE'
  const response = await aws.fetch(s3ObjectUrl(channel, newKey), { method: 'PUT', headers, redirect: 'manual' })
  if (!response.ok) throw new StorageError(`S3 copy failed (${response.status})`, 502)
  await response.body?.cancel().catch(() => {})
  await deleteS3Object(channel, oldKey)
}

function telegramBase(channel: ResolvedChannel): string {
  const proxy = channelConfig(channel, 'proxyUrl', '')
  const host = proxy ? `https://${proxy}` : 'https://api.telegram.org'
  return `${host}/bot${channelSecret(channel, 'botToken')}`
}

function telegramMethod(fileType: string, fileName: string): { method: string; name: string } {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.gif') || lower.endsWith('.webp')) return { method: 'sendAnimation', name: fileName.replace(/\.(gif|webp)$/i, '.jpeg') }
  if (fileType.startsWith('image/') && !/svg|icon/.test(fileType)) return { method: 'sendPhoto', name: fileName }
  if (fileType.startsWith('video/')) return { method: 'sendVideo', name: fileName }
  if (fileType.startsWith('audio/')) return { method: 'sendAudio', name: fileName }
  return { method: 'sendDocument', name: fileName }
}

async function telegramSend(channel: ResolvedChannel, file: StorageFile, method: string, name: string): Promise<{ fileId: string; size: number; messageId?: number }> {
  const chatId = channelConfig(channel, 'chatId', '')
  if (!chatId) throw new StorageError('Telegram chat id is missing', 503)
  const form = new FormData()
  form.append('chat_id', chatId)
  form.append(method === 'sendAudio' ? 'audio' : method === 'sendVideo' ? 'video' : method === 'sendAnimation' ? 'animation' : method === 'sendPhoto' ? 'photo' : 'document', new Blob([file.bytes], { type: file.fileType }), name)
  const response = await fetch(`${telegramBase(channel)}/${method}`, { method: 'POST', body: form })
  const body = await response.json().catch(() => null) as { ok?: boolean; result?: Record<string, unknown>; description?: string } | null
  if (!response.ok || !body?.ok || !body.result) throw new StorageError(`Telegram upload failed: ${body?.description ?? response.status}`, 502)
  const result = body.result
  const document = (result.document ?? result.video ?? result.audio ?? result.animation) as { file_id?: string; file_size?: number } | undefined
  const photo = Array.isArray(result.photo) ? result.photo[result.photo.length - 1] as { file_id?: string; file_size?: number } : undefined
  const info = document ?? photo
  if (!info?.file_id) throw new StorageError('Telegram did not return a file id', 502)
  return { fileId: info.file_id, size: info.file_size ?? file.bytes.byteLength, messageId: typeof result.message_id === 'number' ? result.message_id : undefined }
}

async function putTelegram(channel: ResolvedChannel, file: StorageFile): Promise<PutResult> {
  const choice = telegramMethod(file.fileType, file.fileName)
  const sent = await telegramSend(channel, file, choice.method, choice.name)
  return { objectKey: sent.fileId, metadata: { TgFileId: sent.fileId, FileSizeBytes: sent.size } }
}

export async function putTelegramPart(channel: ResolvedChannel, file: StorageFile, index: number): Promise<ImgbedPart> {
  const sent = await telegramSend(channel, file, 'sendDocument', `${file.fileName}.part${String(index).padStart(3, '0')}`)
  return { index, fileId: sent.fileId, size: sent.size }
}

export async function getTelegramContent(channel: ResolvedChannel, fileId: string): Promise<Response> {
  const infoResponse = await fetch(`${telegramBase(channel)}/getFile?file_id=${encodeURIComponent(fileId)}`)
  const info = await infoResponse.json().catch(() => null) as { ok?: boolean; result?: { file_path?: string } } | null
  if (!infoResponse.ok || !info?.ok || !info.result?.file_path) throw new StorageError('Telegram file path unavailable', 502)
  const proxy = channelConfig(channel, 'proxyUrl', '')
  const host = proxy ? `https://${proxy}` : 'https://api.telegram.org'
  const response = await fetch(`${host}/file/bot${channelSecret(channel, 'botToken')}/${info.result.file_path}`)
  if (!response.ok) throw new StorageError(`Telegram read failed (${response.status})`, 502)
  return response
}

function discordHeaders(channel: ResolvedChannel): HeadersInit {
  return { Authorization: `Bot ${channelSecret(channel, 'botToken')}` }
}

async function discordSend(channel: ResolvedChannel, file: StorageFile, name: string): Promise<{ messageId: string; attachmentId: string; size: number }> {
  const channelId = channelConfig(channel, 'channelId', '')
  if (!channelId) throw new StorageError('Discord channel id is missing', 503)
  const form = new FormData()
  form.append('files[0]', new Blob([file.bytes], { type: file.fileType }), name)
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST', headers: discordHeaders(channel), body: form,
  })
  const body = await response.json().catch(() => null) as { id?: string; attachments?: { id: string; size: number }[] } | null
  if (!response.ok || !body?.id || !body.attachments?.[0]) throw new StorageError(`Discord upload failed (${response.status})`, 502)
  return { messageId: body.id, attachmentId: body.attachments[0].id, size: body.attachments[0].size }
}

async function putDiscord(channel: ResolvedChannel, file: StorageFile): Promise<PutResult> {
  const sent = await discordSend(channel, file, file.fileName)
  return { objectKey: sent.messageId, metadata: { DiscordMessageId: sent.messageId, FileSizeBytes: sent.size } }
}

export async function putDiscordPart(channel: ResolvedChannel, file: StorageFile, index: number): Promise<ImgbedPart> {
  const sent = await discordSend(channel, file, `${file.fileName}.part${String(index).padStart(3, '0')}`)
  return { index, messageId: sent.messageId, size: sent.size }
}

export async function getDiscordAttachmentUrl(channel: ResolvedChannel, messageId: string): Promise<string> {
  const channelId = channelConfig(channel, 'channelId', '')
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, { headers: discordHeaders(channel) })
  const body = await response.json().catch(() => null) as { attachments?: { url?: string }[] } | null
  const url = body?.attachments?.[0]?.url
  if (!response.ok || !url) throw new StorageError('Discord attachment unavailable', 502)
  const proxy = channelConfig(channel, 'proxyUrl', '')
  return proxy ? url.replace('https://cdn.discordapp.com', `https://${proxy}`) : url
}

export async function deleteDiscordMessage(channel: ResolvedChannel, messageId: string): Promise<void> {
  const channelId = channelConfig(channel, 'channelId', '')
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
    method: 'DELETE', headers: discordHeaders(channel),
  })
  await response.body?.cancel().catch(() => {})
  if (!response.ok && response.status !== 404) throw new StorageError(`Discord delete failed (${response.status})`, 502)
}

function huggingFaceHeaders(channel: ResolvedChannel): Record<string, string> {
  const token = channelSecret(channel, 'token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function putHuggingFace(channel: ResolvedChannel, file: StorageFile): Promise<PutResult> {
  const repo = channelConfig(channel, 'repo', '')
  if (!repo) throw new StorageError('HuggingFace repo is missing', 503)
  const oid = await sha256Hex(file.bytes)
  const sample = btoa(String.fromCharCode(...file.bytes.slice(0, 512)))
  const preupload = await fetch(`https://huggingface.co/api/datasets/${repo}/preupload/main`, {
    method: 'POST',
    headers: { ...huggingFaceHeaders(channel), 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [{ path: file.id, size: file.bytes.byteLength, sample }] }),
  })
  if (!preupload.ok) throw new StorageError(`HuggingFace preupload failed (${preupload.status})`, 502)
  const preuploadBody = await preupload.json().catch(() => null) as { files?: { uploadMode?: string }[] } | null
  const needsLfs = preuploadBody?.files?.[0]?.uploadMode === 'lfs'
  if (needsLfs) {
    const batch = await fetch(`https://huggingface.co/datasets/${repo}.git/info/lfs/objects/batch`, {
      method: 'POST',
      headers: { ...huggingFaceHeaders(channel), Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' },
      body: JSON.stringify({ operation: 'upload', transfers: ['basic', 'multipart'], hash_algo: 'sha_256', ref: { name: 'main' }, objects: [{ oid, size: file.bytes.byteLength }] }),
    })
    if (!batch.ok) throw new StorageError(`HuggingFace LFS batch failed (${batch.status})`, 502)
    const batchBody = await batch.json().catch(() => null) as { objects?: { actions?: { upload?: { href: string; header?: Record<string, string> } } }[] } | null
    const upload = batchBody?.objects?.[0]?.actions?.upload
    if (upload) {
      const header = upload.header ?? {}
      const chunkSize = Number(header.chunk_size ?? 0)
      if (chunkSize > 0) {
        const parts: { partNumber: number; etag: string }[] = []
        for (let index = 0; index * chunkSize < file.bytes.byteLength; index++) {
          const partNumber = index + 1
          const chunk = file.bytes.slice(index * chunkSize, Math.min((index + 1) * chunkSize, file.bytes.byteLength))
          const response = await fetch(header[String(partNumber)] ?? upload.href, { method: 'PUT', body: chunk })
          if (!response.ok) throw new StorageError(`HuggingFace part ${partNumber} failed (${response.status})`, 502)
          const etag = response.headers.get('etag')
          if (!etag) throw new StorageError('HuggingFace did not return an ETag')
          parts.push({ partNumber, etag })
        }
        const complete = await fetch(upload.href, { method: 'POST', headers: { Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' }, body: JSON.stringify({ oid, parts }) })
        if (!complete.ok) throw new StorageError(`HuggingFace multipart complete failed (${complete.status})`, 502)
      } else {
        const response = await fetch(upload.href, { method: 'PUT', headers: header, body: file.bytes })
        if (!response.ok) throw new StorageError(`HuggingFace LFS upload failed (${response.status})`, 502)
      }
    }
    const commit = await fetch(`https://huggingface.co/api/datasets/${repo}/commit/main`, {
      method: 'POST',
      headers: { ...huggingFaceHeaders(channel), 'Content-Type': 'application/x-ndjson' },
      body: [
        JSON.stringify({ key: 'header', value: { summary: `upload ${file.fileName}` } }),
        JSON.stringify({ key: 'lfsFile', value: { path: file.id, algo: 'sha256', size: file.bytes.byteLength, oid } }),
      ].join('\n'),
    })
    if (!commit.ok) throw new StorageError(`HuggingFace commit failed (${commit.status})`, 502)
  } else {
    let binary = ''
    for (let offset = 0; offset < file.bytes.byteLength; offset += 0x8000) {
      binary += String.fromCharCode(...file.bytes.subarray(offset, offset + 0x8000))
    }
    const commit = await fetch(`https://huggingface.co/api/datasets/${repo}/commit/main`, {
      method: 'POST',
      headers: { ...huggingFaceHeaders(channel), 'Content-Type': 'application/x-ndjson' },
      body: [
        JSON.stringify({ key: 'header', value: { summary: `upload ${file.fileName}` } }),
        JSON.stringify({ key: 'file', value: { path: file.id, content: btoa(binary), encoding: 'base64' } }),
      ].join('\n'),
    })
    if (!commit.ok) throw new StorageError(`HuggingFace commit failed (${commit.status})`, 502)
  }
  return { objectKey: file.id, metadata: { HfFilePath: file.id } }
}

function huggingFaceUrl(channel: ResolvedChannel, path: string): string {
  return `https://huggingface.co/datasets/${channelConfig(channel, 'repo', '')}/resolve/main/${path.split('/').map(encodeURIComponent).join('/')}`
}

function webdavUrl(channel: ResolvedChannel, path: string): string {
  const base = channelConfig(channel, 'baseUrl', '').replace(/\/+$/, '')
  return `${base}/${path.split('/').map(encodeURIComponent).join('/')}`
}

function webdavHeaders(channel: ResolvedChannel): Record<string, string> {
  const headers = { ...(channel.config.headers as Record<string, string> | undefined ?? {}) }
  const username = channelSecret(channel, 'username')
  const password = channelSecret(channel, 'password')
  if (username || password) headers.Authorization = `Basic ${btoa(`${username}:${password}`)}`
  return headers
}

async function putWebDav(channel: ResolvedChannel, file: StorageFile): Promise<PutResult> {
  const baseUrl = channelConfig(channel, 'baseUrl', '')
  if (!baseUrl) throw new StorageError('WebDAV base URL is missing', 503)
  if (channelConfig(channel, 'createDirectory', true) === true) {
    const parts = file.id.split('/').slice(0, -1)
    let path = ''
    for (const part of parts) {
      path = path ? `${path}/${part}` : part
      await fetch(webdavUrl(channel, path), { method: 'MKCOL', headers: webdavHeaders(channel) }).then((res) => res.body?.cancel()).catch(() => {})
    }
  }
  const response = await fetch(webdavUrl(channel, file.id), {
    method: 'PUT',
    headers: { ...webdavHeaders(channel), 'Content-Type': file.fileType },
    body: file.bytes,
  })
  if (!response.ok) throw new StorageError(`WebDAV upload failed (${response.status})`, 502)
  await response.body?.cancel().catch(() => {})
  return { objectKey: file.id, metadata: { WebDAVFilePath: file.id } }
}

export async function getWholeFile(
  env: Env,
  channel: ResolvedChannel,
  file: ImgbedFile,
  range?: string | null,
): Promise<Response | null> {
  if ((channel.type as string) === 'external') return null
  const key = file.objectKey || file.id
  switch (channel.type) {
    case 'cfr2': {
      if (!env.FILES) throw new StorageError('R2 storage is not configured', 503)
      const object = range
        ? await env.FILES.get(key, { range: parseRange(range) })
        : await env.FILES.get(key)
      if (!object) return null
      const headers = new Headers()
      object.writeHttpMetadata(headers)
      headers.set('ETag', object.httpEtag)
      const ranged = Boolean(range) && 'range' in object && object.range && 'offset' in object.range
      headers.set('Content-Length', String(ranged ? object.range.length ?? object.size : object.size))
      if (ranged && object.range) {
        const offset = object.range.offset ?? 0
        const length = object.range.length ?? object.size - offset
        headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
      }
      return new Response(object.body, { status: ranged ? 206 : 200, headers })
    }
    case 's3': return await getS3Object(channel, key, range)
    case 'telegram': return await getTelegramContent(channel, key)
    case 'discord': {
      const url = await getDiscordAttachmentUrl(channel, key)
      const response = await fetch(url, range ? { headers: { Range: range } } : undefined)
      if (!response.ok && response.status !== 206) throw new StorageError(`Discord read failed (${response.status})`, 502)
      return response
    }
    case 'huggingface': {
      const response = await fetch(huggingFaceUrl(channel, key), {
        headers: range ? { ...huggingFaceHeaders(channel), Range: range } : huggingFaceHeaders(channel),
      })
      if (!response.ok && response.status !== 206) throw new StorageError(`HuggingFace read failed (${response.status})`, 502)
      return response
    }
    case 'webdav': {
      const response = await fetch(webdavUrl(channel, key), {
        headers: range ? { ...webdavHeaders(channel), Range: range } : webdavHeaders(channel),
      })
      if (!response.ok && response.status !== 206) throw new StorageError(`WebDAV read failed (${response.status})`, 502)
      return response
    }
    default: throw new StorageError('Unsupported channel')
  }
}

function parseRange(value: string): R2Range {
  const match = /^bytes=(\d+)-(\d*)$/.exec(value)
  if (!match) throw new StorageError('Unsupported range', 416)
  const offset = Number(match[1])
  if (!match[2]) return { offset }
  const end = Number(match[2])
  if (end < offset) throw new StorageError('Invalid range', 416)
  return { offset, length: end - offset + 1 }
}

export async function deleteWholeFile(env: Env, channel: ResolvedChannel, file: ImgbedFile): Promise<void> {
  if ((channel.type as string) === 'external') return
  const key = file.objectKey || file.id
  switch (channel.type) {
    case 'cfr2':
      if (env.FILES && key) await env.FILES.delete(key)
      return
    case 's3': await deleteS3Object(channel, key); return
    case 'telegram': return
    case 'discord':
      for (const part of file.parts ?? []) {
        if (part.messageId) await deleteDiscordMessage(channel, part.messageId).catch(() => {})
      }
      if (!file.isChunked && key) await deleteDiscordMessage(channel, key)
      return
    case 'huggingface': {
      const repo = channelConfig(channel, 'repo', '')
      const response = await fetch(`https://huggingface.co/api/datasets/${repo}/commit/main`, {
        method: 'POST',
        headers: { ...huggingFaceHeaders(channel), 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: `delete ${file.id}`, files: [{ path: key, deleted: true }] }),
      })
      await response.body?.cancel().catch(() => {})
      if (!response.ok) throw new StorageError(`HuggingFace delete failed (${response.status})`, 502)
      return
    }
    case 'webdav': {
      const response = await fetch(webdavUrl(channel, key), { method: 'DELETE', headers: webdavHeaders(channel) })
      await response.body?.cancel().catch(() => {})
      if (!response.ok && response.status !== 404) throw new StorageError(`WebDAV delete failed (${response.status})`, 502)
      return
    }
    default: throw new StorageError('Unsupported channel')
  }
}

export async function moveWholeFile(
  env: Env,
  channel: ResolvedChannel,
  file: ImgbedFile,
  newId: string,
  newFileType: string,
): Promise<{ objectKey: string; metadata: Record<string, string> }> {
  if ((channel.type as string) === 'external') return { objectKey: '', metadata: {} }
  const oldKey = file.objectKey || file.id
  switch (channel.type) {
    case 'cfr2': {
      if (!env.FILES) throw new StorageError('R2 storage is not configured', 503)
      const object = await env.FILES.get(oldKey)
      if (!object) throw new StorageError('R2 object not found', 404)
      const newKey = r2ObjectKey(newId, newFileType, newId)
      await env.FILES.put(newKey, object.body, { httpMetadata: { contentType: newFileType } })
      await env.FILES.delete(oldKey)
      return { objectKey: newKey, metadata: {} }
    }
    case 's3': {
      const newKey = newId
      await moveS3Object(channel, oldKey, newKey, newFileType)
      return { objectKey: newKey, metadata: { S3FileKey: newKey } }
    }
    case 'webdav': {
      const response = await fetch(webdavUrl(channel, oldKey), {
        method: 'MOVE',
        headers: { ...webdavHeaders(channel), Destination: webdavUrl(channel, newId), Overwrite: 'T' },
      })
      await response.body?.cancel().catch(() => {})
      if (!response.ok) throw new StorageError(`WebDAV move failed (${response.status})`, 502)
      return { objectKey: newId, metadata: { WebDAVFilePath: newId } }
    }
    case 'telegram':
    case 'discord':
      return { objectKey: oldKey, metadata: {} }
    case 'huggingface':
      throw new StorageError('HuggingFace rename is not supported', 400)
    default:
      throw new StorageError('Unsupported channel')
  }
}

export async function testChannel(env: Env, channel: ResolvedChannel): Promise<{ ok: boolean; message: string }> {
  try {
    switch (channel.type) {
      case 'cfr2':
        if (!env.FILES) return { ok: false, message: 'R2 binding is missing' }
        await env.FILES.list({ limit: 1 })
        return { ok: true, message: 'R2 binding is reachable' }
      case 's3': {
        const aws = s3Client(channel)
        const response = await aws.fetch(s3ObjectUrl(channel, ''), { method: 'HEAD', redirect: 'manual' })
        await response.body?.cancel().catch(() => {})
        return { ok: response.ok || response.status === 403, message: `S3 answered HTTP ${response.status}` }
      }
      case 'telegram': {
        const response = await fetch(`${telegramBase(channel)}/getMe`)
        return { ok: response.ok, message: `Telegram answered HTTP ${response.status}` }
      }
      case 'discord': {
        const channelId = channelConfig(channel, 'channelId', '')
        const response = await fetch(`https://discord.com/api/v10/channels/${channelId}`, { headers: discordHeaders(channel) })
        await response.body?.cancel().catch(() => {})
        return { ok: response.ok, message: `Discord answered HTTP ${response.status}` }
      }
      case 'huggingface': {
        const response = await fetch(`https://huggingface.co/api/datasets/${channelConfig(channel, 'repo', '')}`, { headers: huggingFaceHeaders(channel) })
        await response.body?.cancel().catch(() => {})
        return { ok: response.ok, message: `HuggingFace answered HTTP ${response.status}` }
      }
      case 'webdav': {
        const response = await fetch(webdavUrl(channel, ''), { method: 'PROPFIND', headers: { ...webdavHeaders(channel), Depth: '0' } })
        await response.body?.cancel().catch(() => {})
        return { ok: response.status < 500, message: `WebDAV answered HTTP ${response.status}` }
      }
      default:
        return { ok: false, message: 'External links need no connection' }
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Channel test failed' }
  }
}

export interface MultipartSession {
  uploadId: string
  objectKey: string
}

export async function createMultipart(
  env: Env,
  channel: ResolvedChannel,
  file: StorageFile,
): Promise<MultipartSession> {
  if (channel.type === 'cfr2') {
    if (!env.FILES) throw new StorageError('R2 storage is not configured', 503)
    const key = r2ObjectKey(file.id, file.fileType, file.fileName)
    const upload = await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: file.fileType } })
    return { uploadId: upload.uploadId, objectKey: key }
  }
  if (channel.type === 's3') {
    const aws = s3Client(channel)
    const url = new URL(s3ObjectUrl(channel, file.id))
    url.searchParams.set('uploads', '')
    const response = await aws.fetch(url.toString(), { method: 'POST', headers: { 'Content-Type': file.fileType }, redirect: 'manual' })
    const xml = await response.text()
    if (!response.ok) throw new StorageError(`S3 multipart init failed (${response.status})`, 502)
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1]
    if (!uploadId) throw new StorageError('S3 did not return an upload id')
    return { uploadId, objectKey: file.id }
  }
  throw new StorageError('This channel does not support multipart uploads', 400)
}

export async function uploadMultipartPart(
  env: Env,
  channel: ResolvedChannel,
  session: MultipartSession,
  index: number,
  bytes: Uint8Array,
): Promise<{ partNumber: number; etag: string }> {
  const partNumber = index + 1
  if (channel.type === 'cfr2') {
    if (!env.FILES) throw new StorageError('R2 storage is not configured', 503)
    const part = await env.FILES.resumeMultipartUpload(session.objectKey, session.uploadId).uploadPart(partNumber, bytes)
    return { partNumber, etag: part.etag }
  }
  if (channel.type === 's3') {
    const aws = s3Client(channel)
    const url = new URL(s3ObjectUrl(channel, session.objectKey))
    url.searchParams.set('partNumber', String(partNumber))
    url.searchParams.set('uploadId', session.uploadId)
    const response = await aws.fetch(url.toString(), { method: 'PUT', body: bytes as unknown as BodyInit, redirect: 'manual' })
    await response.body?.cancel().catch(() => {})
    if (!response.ok) throw new StorageError(`S3 part ${partNumber} failed (${response.status})`, 502)
    const etag = response.headers.get('etag')
    if (!etag) throw new StorageError(`S3 did not return an ETag for part ${partNumber}`)
    return { partNumber, etag }
  }
  throw new StorageError('This channel does not support multipart uploads', 400)
}

export async function completeMultipart(
  env: Env,
  channel: ResolvedChannel,
  session: MultipartSession,
  parts: { partNumber: number; etag: string }[],
): Promise<Record<string, string>> {
  if (channel.type === 'cfr2') {
    if (!env.FILES) throw new StorageError('R2 storage is not configured', 503)
    await env.FILES.resumeMultipartUpload(session.objectKey, session.uploadId).complete(parts)
    return {}
  }
  if (channel.type === 's3') {
    const aws = s3Client(channel)
    const url = new URL(s3ObjectUrl(channel, session.objectKey))
    url.searchParams.set('uploadId', session.uploadId)
    const body = `<CompleteMultipartUpload>${parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag.replace(/[<>&]/g, '')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`
    const response = await aws.fetch(url.toString(), { method: 'POST', body, headers: { 'Content-Type': 'application/xml' }, redirect: 'manual' })
    await response.body?.cancel().catch(() => {})
    if (!response.ok) throw new StorageError(`S3 multipart complete failed (${response.status})`, 502)
    return { S3FileKey: session.objectKey }
  }
  throw new StorageError('This channel does not support multipart uploads', 400)
}

export async function abortMultipart(env: Env, channel: ResolvedChannel, session: MultipartSession): Promise<void> {
  try {
    if (channel.type === 'cfr2' && env.FILES) {
      await env.FILES.resumeMultipartUpload(session.objectKey, session.uploadId).abort()
    } else if (channel.type === 's3') {
      const aws = s3Client(channel)
      const url = new URL(s3ObjectUrl(channel, session.objectKey))
      url.searchParams.set('uploadId', session.uploadId)
      const response = await aws.fetch(url.toString(), { method: 'DELETE', redirect: 'manual' })
      await response.body?.cancel().catch(() => {})
    }
  } catch (error) {
    console.warn('[inkstone] image-bed multipart abort failed:', (error as Error).message)
  }
}
