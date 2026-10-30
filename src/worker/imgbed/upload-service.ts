import {
  IMGBED_CHANNEL_TYPES,
  buildFileId,
  categoryFor,
  fileTypeCategory,
  mimeFromExtension,
  resolveFileType,
  sanitizeFileName,
  sanitizeFolderPath,
  type ImgbedChannelType,
  type ImgbedFile,
} from '@shared/imgbed/model'
import { parseSecuritySettings, type ImgbedSecuritySettings } from '@shared/imgbed/settings'
import type { Env } from '../env'
import { readImageSize } from '../lib/image'
import { requestClientIp } from '../lib/request'
import type { ImgbedActor } from './auth'
import { getSettingsGroup, insertFile, fileExists } from './store'
import { isIpBlocked } from './tokens'
import { UrlGuardError, assertExternalHttpUrl, assertPublicHttpUrl } from './url-guard'
import {
  StorageError,
  deleteWholeFile,
  publicFileUrl,
  putWholeFile,
  type StorageFile,
} from './storage'
import { availableChannelsForUpload, type ResolvedChannel } from './channels'
import { imgbedMetric } from './metrics'

export interface UploadQuery {
  uploadChannel?: string
  channelName?: string
  uploadFolder?: string
  uploadNameType?: string
  returnFormat?: string
  autoRetry?: string
}

export interface UploadResult {
  src: string
  url: string
  publicUrl?: string
  id: string
  fileName: string
  fileType: string
  size: number
  width: number | null
  height: number | null
  channel: string
  channelName: string
}

const CHANNEL_FALLBACK_ORDER: ImgbedChannelType[] = ['cfr2', 'telegram', 's3', 'huggingface', 'webdav', 'discord']

function isChannelType(value: string): value is ImgbedChannelType {
  return (IMGBED_CHANNEL_TYPES as readonly string[]).includes(value)
}

function channelTypeFromQuery(value: string | undefined): ImgbedChannelType | 'external' {
  if (value === 'external') return 'external'
  if (value && isChannelType(value)) return value
  return 'telegram'
}

export function pickChannel(
  channels: ResolvedChannel[],
  type: ImgbedChannelType,
  name: string | undefined,
  loadBalance: boolean,
  random = Math.random,
): ResolvedChannel | null {
  const candidates = channels.filter((channel) => channel.type === type && channel.enabled)
  if (!candidates.length) return null
  if (name) return candidates.find((channel) => channel.name === name) ?? null
  if (loadBalance && candidates.length > 1) return candidates[Math.floor(random() * candidates.length)] ?? candidates[0]!
  return candidates[0]!
}

export async function lookupAddress(security: ImgbedSecuritySettings, ip: string | null): Promise<string | null> {
  if (!ip || !security.ipQuery.enabled || !security.ipQuery.customApi.url) return null
  try {
    const replace = (value: string) => value.replace(/\{ip\}/g, ip)
    const url = new URL(replace(security.ipQuery.customApi.url))
    for (const param of security.ipQuery.customApi.params) {
      if (param.key) url.searchParams.append(replace(param.key), replace(param.value))
    }
    const safe = await assertPublicHttpUrl(url)
    const response = await fetch(safe, { signal: AbortSignal.timeout(2000) })
    if (!response.ok) return null
    const data = await response.json().catch(() => null) as Record<string, unknown> | null
    if (!data) return null
    const values: string[] = []
    for (const path of security.ipQuery.customApi.responseFields) {
      let current: unknown = data
      for (const segment of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
        if (current === null || typeof current !== 'object') { current = undefined; break }
        current = (current as Record<string, unknown>)[segment]
      }
      if (current !== undefined && current !== null && current !== '') values.push(String(current))
    }
    return values.length ? values.join(', ') : null
  } catch {
    return null
  }
}

export async function moderateContent(security: ImgbedSecuritySettings, url: string): Promise<string> {
  if (!security.moderate.enabled) return 'None'
  const unavailable = (reason: string): never => {
    imgbedMetric('error', 'moderation.failure', { provider: security.moderate.channel, reason })
    throw new StorageError('Content moderation is unavailable', 503)
  }
  if (security.moderate.channel === 'moderatecontent.com') {
    const key = security.moderate.moderateContentApiKey
    if (!key) unavailable('missing-key')
    let response: Response
    try {
      response = await fetch('https://api.moderatecontent.com/moderate/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ key, url }).toString(),
        signal: AbortSignal.timeout(10_000),
      })
    } catch { unavailable('request-failed') }
    if (!response!.ok) unavailable(`http-${response!.status}`)
    const data = await response!.json().catch(() => null) as { rating_label?: string } | null
    if (!data?.rating_label) unavailable('invalid-response')
    return data!.rating_label!
  }
  if (!security.moderate.nsfwApiPath) unavailable('missing-path')
  const target = new URL(security.moderate.nsfwApiPath)
  target.searchParams.set('url', url)
  let response: Response
  try { response = await fetch(target, { signal: AbortSignal.timeout(10_000) }) } catch { unavailable('request-failed') }
  if (!response!.ok) unavailable(`http-${response!.status}`)
  const data = await response!.json().catch(() => null) as { score?: number } | null
  const score = Number(data?.score)
  if (!Number.isFinite(score)) unavailable('invalid-response')
  return score >= 0.9 ? 'adult' : score >= 0.7 ? 'teen' : 'everyone'
}

function dimensionsOf(bytes: Uint8Array, fileType: string): { width: number; height: number } | null {
  try {
    return readImageSize(bytes, fileType)
  } catch {
    return null
  }
}

export async function uploadSingle(
  env: Env,
  db: D1Database,
  actor: ImgbedActor,
  request: Request,
  form: FormData,
  query: UploadQuery,
): Promise<UploadResult> {
  const page = await getSettingsGroup(db, 'page')
  const upload = await getSettingsGroup(db, 'upload')
  const security = parseSecuritySettings(await getSettingsGroup(db, 'security'))
  const ip = requestClientIp(request)
  if (await isIpBlocked(db, ip)) throw new StorageError('Your IP is blocked', 403)

  const requestedType = channelTypeFromQuery(query.uploadChannel ?? page.defaultUploadChannel)
  const external = requestedType === 'external'
  const file = form.get('file')
  const externalUrl = form.get('url')
  let externalName = 'external'
  if (external && typeof externalUrl === 'string') {
    try { externalName = new URL(externalUrl).pathname.split('/').pop() || 'external' } catch {  }
  }
  const fileName = sanitizeFileName(external ? externalName : file instanceof File ? file.name : '')
  if (!fileName) throw new StorageError('fileType or fileName is wrong', 400)
  const fileType = external ? mimeFromExtension(fileName) : resolveFileType(fileName, file instanceof File ? file.type : 'text/plain')
  if (fileType === null) throw new StorageError('fileType is wrong', 400)
  const bytes = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array()
  const size = external ? 0 : bytes.byteLength
  if (size > upload.maxFileSizeMB * 1024 * 1024) throw new StorageError(`File exceeds ${upload.maxFileSizeMB} MB`, 413)
  if (size > 50 * 1024 * 1024) throw new StorageError('This request is too large for a single upload; use the chunked endpoint', 413)

  const folder = sanitizeFolderPath(query.uploadFolder ?? page.defaultFolder)
  const nameType = (query.uploadNameType ?? page.defaultNameType) as 'default' | 'index' | 'origin' | 'short'
  const id = await buildFileId({
    fileName, fileType, folder, nameType,
    exists: (candidate) => fileExists(db, candidate),
  })
  const dimensions = fileTypeCategory(fileType) === 'image' ? dimensionsOf(bytes, fileType) : null
  const address = await lookupAddress(security, ip)
  const now = Date.now()

  if (external) {
    if (typeof externalUrl !== 'string') throw new StorageError('A valid external URL is required', 400)
    let safe: URL
    try { safe = await assertExternalHttpUrl(externalUrl.trim()) }
    catch (error) {
      if (error instanceof UrlGuardError) throw new StorageError('A public http(s) external URL is required', 400)
      throw error
    }
    await insertFile(db, {
      id, objectKey: '', fileName, fileType, sizeBytes: 0, width: null, height: null,
      uploadIp: ip, uploadAddress: address, source: 'external', externalLink: safe.href,
      channel: 'External', channelName: 'External', uploaderId: actor.userId, createdAt: now,
    })
    return {
      src: `/imgbed/file/${id}`, url: `/imgbed/file/${id}`,
      publicUrl: safe.href, id, fileName, fileType, size: 0, width: null, height: null,
      channel: 'External', channelName: 'External',
    }
  }

  const channels = await availableChannelsForUpload(env, db)
  const available = channels.filter((channel) => channel.enabled)
  const chosen = pickChannel(available, requestedType, query.channelName, upload.loadBalance[requestedType] === true)
    ?? available[0]
    ?? null
  if (!chosen) throw new StorageError(`No enabled ${requestedType} channel is configured`, 400)

  const storageFile: StorageFile = { id, fileName, fileType, bytes }
  const attempts: ResolvedChannel[] = [chosen]
  if (query.autoRetry !== 'false') {
    for (const type of CHANNEL_FALLBACK_ORDER) {
      if (type === requestedType) continue
      const channel = pickChannel(available, type, undefined, false)
      if (channel) attempts.push(channel)
    }
  }
  let lastError: unknown = null
  let channel: ResolvedChannel | null = null
  let put: Awaited<ReturnType<typeof putWholeFile>> | null = null
  for (const attempt of attempts) {
    try {
      put = await putWholeFile(env, attempt, storageFile)
      channel = attempt
      break
    } catch (error) {
      lastError = error
      if (error instanceof StorageError && (error.status === 400 || error.status === 413)) continue
    }
  }
  if (!put || !channel) {
    throw lastError instanceof StorageError ? lastError : new StorageError('All upload channels failed', 502)
  }

  const fileRecord = {
    id, objectKey: put.objectKey, fileName, fileType, sizeBytes: size,
    width: null, height: null, uploadIp: ip, uploadAddress: address,
    listType: 'None' as const, label: 'None' as const, directory: '', source: channel.type,
    externalLink: null, channel: canonicalChannel(channel),
    channelName: channel.name, isChunked: false, parts: null, uploaderId: actor.userId,
    favorite: false, pinned: false,
    createdAt: now, updatedAt: now, tags: [],
  } satisfies ImgbedFile
  try {
    const label = fileTypeCategory(fileType) === 'image'
      ? await moderateContent(security, publicFileUrl(channel, id) || `${new URL(request.url).origin}/imgbed/file/${id}`)
      : 'None'
    await insertFile(db, {
      id, objectKey: put.objectKey, fileName, fileType, sizeBytes: size,
      width: dimensions?.width ?? null, height: dimensions?.height ?? null,
      uploadIp: ip, uploadAddress: address, label,
      source: channel.type, channel: canonicalChannel(channel), channelName: channel.name,
      uploaderId: actor.userId, createdAt: now,
    })
  } catch (error) {
    await deleteWholeFile(env, channel, fileRecord).catch((cleanupError) => {
      console.warn('[inkstone] image-bed rollback after a failed insert failed:', (cleanupError as Error).message)
    })
    throw error
  }

  const src = query.returnFormat === 'full'
    ? `${new URL(request.url).origin}/imgbed/file/${id}`
    : `/imgbed/file/${id}`
  const publicUrl = publicFileUrl(channel, id) || undefined
  return {
    src, url: src, ...(publicUrl ? { publicUrl } : {}), id, fileName, fileType, size,
    width: dimensions?.width ?? null, height: dimensions?.height ?? null,
    channel: canonicalChannel(channel),
    channelName: channel.name,
  }
}

function canonicalChannel(channel: ResolvedChannel): string {
  switch (channel.type) {
    case 'cfr2': return 'CloudflareR2'
    case 'telegram': return 'TelegramNew'
    case 's3': return 'S3'
    case 'discord': return 'Discord'
    case 'huggingface': return 'HuggingFace'
    case 'webdav': return 'WebDAV'
    default: return channel.type
  }
}

export function categoryOf(fileType: string, fileName: string): string {
  return categoryFor(fileType, fileName)
}
