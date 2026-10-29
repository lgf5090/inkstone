/** Read-only browsing and byte reads for S3-compatible and WebDAV mounts. */
import { AwsClient } from 'aws4fetch'
import { categoryFor, extensionOf, type CloudDriveEntry } from '@shared/clouddrive/model'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { decryptSecret } from '../lib/crypto'
import type { CloudDriveMountInfo } from './lib'

interface StorageRow {
  id: string
  type: string
  config: string
  credentials: string
}

interface DriverEntry {
  name: string
  kind: 'folder' | 'file'
  size: number
  modifiedAt: number
}

export interface ExternalListing {
  mountId: string
  path: string
  folders: CloudDriveEntry[]
  files: CloudDriveEntry[]
  cursor: null
  total: null
  foldersTruncated: false
}

const EXTERNAL_PREFIX = 'x'

export function externalEntryId(mountId: string, path: string): string {
  return `${EXTERNAL_PREFIX}${base64Url(new TextEncoder().encode(`${mountId}\0${path}`))}`
}

export function parseExternalEntryId(id: string): { mountId: string; path: string } | null {
  if (!id.startsWith(EXTERNAL_PREFIX)) return null
  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(id.slice(EXTERNAL_PREFIX.length)))
    const separator = decoded.indexOf('\0')
    if (separator <= 0) return null
    return { mountId: decoded.slice(0, separator), path: decoded.slice(separator + 1) || '/' }
  } catch {
    return null
  }
}

export async function listExternal(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  path: string,
): Promise<ExternalListing> {
  const storage = await storageFor(db, mount.storageId)
  if (!storage) throw new ApiError(502, 'clouddrive_mount_unavailable', 'The mount configuration is missing')
  const entries = storage.type === 's3'
    ? await listS3(env, storage, mount, path)
    : storage.type === 'webdav'
      ? await listWebdav(env, storage, mount, path)
      : null
  if (!entries) throw new ApiError(502, 'clouddrive_mount_unavailable', 'This storage type is not supported yet')
  const folders = entries.filter((entry) => entry.kind === 'folder').map((entry) => toEntry(mount, path, entry))
  const files = entries.filter((entry) => entry.kind === 'file').map((entry) => toEntry(mount, path, entry))
  return { mountId: mount.id, path, folders, files, cursor: null, total: null, foldersTruncated: false }
}

export async function readExternal(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  path: string,
  range: string | null,
): Promise<Response | null> {
  const storage = await storageFor(db, mount.storageId)
  if (!storage) throw new ApiError(502, 'clouddrive_mount_unavailable', 'The mount configuration is missing')
  if (storage.type === 's3') return await readS3(env, storage, mount, path, range)
  if (storage.type === 'webdav') return await readWebdav(env, storage, mount, path, range)
  throw new ApiError(502, 'clouddrive_mount_unavailable', 'This storage type is not supported yet')
}

function toEntry(mount: CloudDriveMountInfo, parent: string, entry: DriverEntry): CloudDriveEntry {
  const path = parent === '/' ? `/${entry.name}` : `${parent}/${entry.name}`
  return {
    id: externalEntryId(mount.id, path),
    kind: entry.kind,
    name: entry.name,
    path,
    mountId: mount.id,
    mountName: mount.name,
    category: entry.kind === 'folder' ? 'other' : categoryFor(entry.name),
    mime: entry.kind === 'folder' ? 'application/octet-stream' : mimeFor(entry.name),
    size: entry.size,
    uploadedAt: entry.modifiedAt,
    modifiedAt: entry.modifiedAt,
    starredAt: null,
    readOnly: true,
    hasThumbnail: false,
    storage: mount.storageType,
    storageKind: 'external',
    color: null,
    tags: [],
  }
}

function mimeFor(name: string): string {
  const extension = extensionOf(name)
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tiff', 'svg'].includes(extension)) return `image/${extension === 'jpg' ? 'jpeg' : extension}`
  if (['mp4', 'webm', 'mov'].includes(extension)) return `video/${extension}`
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(extension)) return `audio/${extension}`
  if (extension === 'pdf') return 'application/pdf'
  if (['txt', 'md', 'json', 'js', 'ts', 'css', 'html', 'xml', 'yaml', 'yml'].includes(extension)) return 'text/plain'
  return 'application/octet-stream'
}

async function storageFor(db: D1Database, id: string): Promise<StorageRow | null> {
  return await db.prepare(
    `SELECT s.id, s.type, s.config, s.credentials FROM CloudDrive_storages s
      JOIN CloudDrive_storages owner ON owner.id = s.id
      WHERE s.id = ? LIMIT 1`,
  ).bind(id).first<StorageRow>()
}

async function credentialsOf(env: Env, storage: StorageRow): Promise<Record<string, string>> {
  return await decryptSecret<Record<string, string>>(env, `clouddrive:${storage.id}`, storage.credentials).catch(() => null) ?? {}
}

function configOf(storage: StorageRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(storage.config) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function joinPath(root: string, path: string): string {
  const base = root.replace(/^\/+|\/+$/g, '')
  const tail = path.replace(/^\/+|\/+$/g, '')
  return [base, tail].filter(Boolean).join('/')
}

async function listS3(env: Env, storage: StorageRow, _mount: CloudDriveMountInfo, path: string): Promise<DriverEntry[]> {
  const config = configOf(storage)
  const credentials = await credentialsOf(env, storage)
  const endpoint = String(config.endpoint ?? '')
  if (!endpoint) throw new ApiError(502, 'clouddrive_mount_unavailable', 'S3 endpoint is missing')
  const aws = new AwsClient({ accessKeyId: credentials.accessKeyId ?? '', secretAccessKey: credentials.secretAccessKey ?? '', region: String(config.region ?? 'auto'), service: 's3', retries: 1 })
  const bucket = String(config.bucketName ?? '')
  const root = String(config.rootPath ?? '')
  const prefix = joinPath(root, path)
  const url = new URL(`${endpoint.replace(/\/$/, '')}/${bucket}`)
  url.searchParams.set('list-type', '2')
  url.searchParams.set('delimiter', '/')
  url.searchParams.set('max-keys', '1000')
  if (prefix) url.searchParams.set('prefix', `${prefix}/`)
  const response = await aws.fetch(url.toString(), { method: 'GET', redirect: 'manual' })
  const text = await response.text()
  if (!response.ok) throw new ApiError(502, 'clouddrive_mount_unavailable', `S3 list failed (${response.status})`)
  const entries: DriverEntry[] = []
  for (const match of text.matchAll(/<CommonPrefixes>[\s\S]*?<Prefix>([^<]+)<\/Prefix>/g)) {
    const name = match[1]!.split('/').filter(Boolean).pop() ?? ''
    if (name) entries.push({ name, kind: 'folder', size: 0, modifiedAt: 0 })
  }
  for (const match of text.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<LastModified>([^<]+)<\/LastModified>[\s\S]*?<Size>(\d+)<\/Size>/g)) {
    const key = match[1]!
    const name = key.split('/').filter(Boolean).pop() ?? ''
    const modified = Date.parse(match[2]!) || 0
    const size = Number(match[3] ?? 0)
    if (name && !key.endsWith('/')) entries.push({ name, kind: 'file', size, modifiedAt: modified })
  }
  return entries
}

async function readS3(env: Env, storage: StorageRow, _mount: CloudDriveMountInfo, path: string, range: string | null): Promise<Response | null> {
  const config = configOf(storage)
  const credentials = await credentialsOf(env, storage)
  const endpointRaw = String(config.endpoint ?? '')
  const endpoint = new URL(endpointRaw)
  const bucket = String(config.bucketName ?? '')
  const key = joinPath(String(config.rootPath ?? ''), path)
  const aws = new AwsClient({ accessKeyId: credentials.accessKeyId ?? '', secretAccessKey: credentials.secretAccessKey ?? '', region: String(config.region ?? 'auto'), service: 's3', retries: 1 })
  const pathStyle = config.pathStyle === true || endpoint.hostname.endsWith('amazonaws.com') === false
  const url = pathStyle ? `${endpoint.origin}/${bucket}/${encodeKey(key)}` : `${endpoint.protocol}//${bucket}.${endpoint.host}/${encodeKey(key)}`
  const headers: Record<string, string> = {}
  if (range) headers.Range = range
  const response = await aws.fetch(url, { method: 'GET', headers, redirect: 'manual' })
  if (response.status === 404) { await response.body?.cancel().catch(() => {}); return null }
  if (!response.ok && response.status !== 206) throw new ApiError(502, 'clouddrive_mount_unavailable', `S3 read failed (${response.status})`)
  return response
}

async function listWebdav(env: Env, storage: StorageRow, _mount: CloudDriveMountInfo, path: string): Promise<DriverEntry[]> {
  const config = configOf(storage)
  const credentials = await credentialsOf(env, storage)
  const base = String(config.baseUrl ?? '').replace(/\/$/, '')
  if (!base) throw new ApiError(502, 'clouddrive_mount_unavailable', 'WebDAV base URL is missing')
  const root = String(config.rootPath ?? '').replace(/^\/+|\/+$/g, '')
  const relative = path === '/' ? '' : path.replace(/^\/+/, '')
  const url = `${base}/${[root, relative].filter(Boolean).join('/')}`
  const headers: Record<string, string> = { Depth: '1' }
  if (credentials.username || credentials.password) headers.Authorization = `Basic ${btoa(`${credentials.username ?? ''}:${credentials.password ?? ''}`)}`
  const response = await fetch(url, { method: 'PROPFIND', headers, redirect: 'manual' })
  const xml = await response.text()
  if (!response.ok && response.status !== 207) throw new ApiError(502, 'clouddrive_mount_unavailable', `WebDAV list failed (${response.status})`)
  const entries: DriverEntry[] = []
  for (const block of xml.matchAll(/<(?:D:|[a-z]+:)?response>([\s\S]*?)<\/(?:D:|[a-z]+:)?response>/gi)) {
    const body = block[1]!
    const href = /<(?:D:|[a-z]+:)?href>([^<]+)<\/(?:D:|[a-z]+:)?href>/i.exec(body)?.[1] ?? ''
    const name = decodeURIComponent(href.split('/').filter(Boolean).pop() ?? '')
    if (!name) continue
    const folder = /<(?:D:|[a-z]+:)?collection\s*\/?>/i.test(body)
    const size = Number(/<(?:D:|[a-z]+:)?getcontentlength>(\d+)</i.exec(body)?.[1] ?? 0)
    const modifiedText = /<(?:D:|[a-z]+:)?getlastmodified>([^<]+)</i.exec(body)?.[1]
    const modified = modifiedText ? (Date.parse(modifiedText) || 0) : 0
    entries.push({ name, kind: folder ? 'folder' : 'file', size, modifiedAt: modified })
  }
  return entries
}

async function readWebdav(env: Env, storage: StorageRow, _mount: CloudDriveMountInfo, path: string, range: string | null): Promise<Response | null> {
  const config = configOf(storage)
  const credentials = await credentialsOf(env, storage)
  const base = String(config.baseUrl ?? '').replace(/\/$/, '')
  const root = String(config.rootPath ?? '').replace(/^\/+|\/+$/g, '')
  const relative = path.replace(/^\/+/, '')
  const url = `${base}/${[root, relative].filter(Boolean).join('/')}`
  const headers: Record<string, string> = {}
  if (credentials.username || credentials.password) headers.Authorization = `Basic ${btoa(`${credentials.username ?? ''}:${credentials.password ?? ''}`)}`
  if (range) headers.Range = range
  const response = await fetch(url, { method: 'GET', headers, redirect: 'manual' })
  if (response.status === 404) { await response.body?.cancel().catch(() => {}); return null }
  if (!response.ok && response.status !== 206) throw new ApiError(502, 'clouddrive_mount_unavailable', `WebDAV read failed (${response.status})`)
  return response
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
