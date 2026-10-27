import {
  EXPORT_TTL_MS,
  MAX_EXPORT_BYTES,
} from '@shared/development/database/types'
import type { DatabaseExportFile, ExportFormat } from '@shared/development/database/types'
import { utf8ByteLength } from '@shared/text-utils'
import type { Env } from '../../env'
import { ApiError } from '../../lib/errors'
import {
  deleteExpiredExports,
  listExpiredExports,
} from './store'

export const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  sql: 'application/sql; charset=utf-8',
}

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  txt: 'txt',
  csv: 'csv',
  json: 'json',
  sql: 'sql',
}

export interface ExportWrite {
  userId: string
  id: string
  format: ExportFormat
  content: string
}

export interface ExportWritten {
  key: string
  size: number
}

function fileBucket(env: Env): R2Bucket {
  if (!env.FILES) {
    throw new ApiError(503, 'storage_unavailable', 'File storage is not configured on this deployment')
  }
  return env.FILES
}

function assertOwner(userId: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) {
    throw ApiError.badRequest('The export owner is not a valid account id')
  }
}

export function exportKey(format: ExportFormat, userId: string, fileId: string): string {
  return `development/database/${format}/${userId}/${fileId}.${EXPORT_EXTENSIONS[format]}`
}

export function exportFileView(
  id: string,
  filename: string,
  format: ExportFormat,
  size: number,
  createdAt: number,
): DatabaseExportFile {
  return {
    id,
    filename,
    format,
    size,
    url: `/api/development/database/exports/${id}`,
    createdAt,
  }
}

export async function putExport(env: Env, write: ExportWrite): Promise<ExportWritten> {
  const bucket = fileBucket(env)
  assertOwner(write.userId)
  const size = utf8ByteLength(write.content)
  if (size > MAX_EXPORT_BYTES) {
    throw ApiError.tooLarge(`Exports are limited to ${MAX_EXPORT_BYTES / (1024 * 1024)} MB`)
  }
  const key = exportKey(write.format, write.userId, write.id)
  await bucket.put(key, write.content, {
    httpMetadata: { contentType: EXPORT_CONTENT_TYPES[write.format] },
  })
  return { key, size }
}

export async function readExportObject(env: Env, key: string): Promise<R2ObjectBody> {
  const bucket = fileBucket(env)
  const object = await bucket.get(key)
  if (!object) throw ApiError.notFound('Export file not found')
  return object
}

export async function deleteExportObject(env: Env, key: string): Promise<void> {
  await fileBucket(env).delete(key)
}

export async function deleteExportObjectBestEffort(env: Env, key: string): Promise<void> {
  if (!env.FILES) return
  try {
    await env.FILES.delete(key)
  } catch (error) {
    console.warn('[inkstone] Removing an orphaned development database export failed:', error)
  }
}

export async function cleanupExpiredExports(
  env: Env,
  db: D1Database,
  userId: string,
): Promise<void> {
  const bucket = fileBucket(env)
  const cutoff = Date.now() - EXPORT_TTL_MS
  const expired = await listExpiredExports(db, userId, cutoff)
  if (expired.length === 0) return
  try {
    await bucket.delete(expired.map((record) => record.r2Key))
  } catch (error) {
    console.warn('[inkstone] Cleaning up expired development database exports failed:', error)
  }
  await deleteExpiredExports(db, userId, cutoff)
}

function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["\\/]/g, '_')
    .trim()
  return cleaned || 'export'
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export function exportContentDisposition(filename: string): string {
  const safe = sanitizeFilename(filename)
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(safe)}`
}
