import { EXPORT_TTL_MS, MAX_EXPORT_BYTES } from '@shared/development/github/limits'
import type {
  GithubExportFile,
  GithubExportFormat,
  GithubTag,
  SavedGist,
} from '@shared/development/github/types'
import { utf8ByteLength } from '@shared/text-utils'
import type { Env } from '../../env'
import { idChunks } from '../../db/writes'
import { ApiError } from '../../lib/errors'
import { deleteExpiredExports, listExpiredExports } from './store'

export const EXPORT_CONTENT_TYPES: Record<GithubExportFormat, string> = {
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
}

export const EXPORT_EXTENSIONS: Record<GithubExportFormat, string> = {
  json: 'json',
  md: 'md',
  txt: 'txt',
}

export interface GistExportInput {
  gist: SavedGist
  tags: readonly GithubTag[]
}

export interface ExportWrite {
  userId: string
  exportId: string
  format: GithubExportFormat
  content: string
}

export interface ExportWritten {
  key: string
  size: number
}

function storageBucket(env: Env): R2Bucket {
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

export function assertExportStorage(env: Env): void {
  if (!env.FILES) {
    throw new ApiError(503, 'storage_unavailable', 'File storage is not configured on this deployment')
  }
}

export function exportKey(format: GithubExportFormat, userId: string, exportId: string): string {
  return `development/github/${format}/${userId}/${exportId}.${EXPORT_EXTENSIONS[format]}`
}

export function gistExportFilename(gistId: string, format: GithubExportFormat): string {
  return `gist-${gistId}.${EXPORT_EXTENSIONS[format]}`
}

function fenceFor(content: string): string {
  let longest = 0
  for (const match of content.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length)
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

function exportLanguage(value: string | null): string {
  return value && /^[A-Za-z0-9+#._-]{1,50}$/.test(value) ? value : ''
}

function exportJson(input: GistExportInput, exportedAt: number): string {
  const { gist, tags } = input
  return JSON.stringify(
    {
      version: 1,
      exportedAt: new Date(exportedAt).toISOString(),
      gist: {
        id: gist.id,
        description: gist.description,
        url: gist.url,
        isPublic: gist.data.isPublic,
        owner: gist.data.owner,
        files: gist.data.files,
        tagIds: gist.tagIds,
        tags: tags.map((tag) => ({
          id: tag.id,
          name: tag.name,
          color: tag.color,
          parentId: tag.parentId,
        })),
        notes: gist.notes,
        createdAt: gist.createdAt,
        updatedAt: gist.updatedAt,
      },
    },
    null,
    2,
  )
}

function exportMarkdown(input: GistExportInput): string {
  const { gist } = input
  const title = gist.description.trim() || `Gist ${gist.id}`
  const blocks: string[] = [`# ${title}`]
  for (const file of gist.data.files) {
    const fence = fenceFor(file.content)
    const language = exportLanguage(file.language)
    const body = file.content.endsWith('\n') ? file.content : `${file.content}\n`
    blocks.push(`## ${file.filename}`, `${fence}${language}\n${body}${fence}`)
  }
  return `${blocks.join('\n\n')}\n`
}

function exportText(input: GistExportInput): string {
  return input.gist.data.files
    .map((file) => {
      const language = exportLanguage(file.language) || 'text'
      return `===== ${file.filename} (${language}, ${file.size} bytes) =====\n${file.content}`
    })
    .join('\n\n')
}

export function buildGistExport(
  format: GithubExportFormat,
  input: GistExportInput,
  exportedAt = Date.now(),
): string {
  if (format === 'json') return exportJson(input, exportedAt)
  if (format === 'md') return exportMarkdown(input)
  return exportText(input)
}

export async function putGistExport(env: Env, write: ExportWrite): Promise<ExportWritten> {
  const bucket = storageBucket(env)
  assertOwner(write.userId)
  const size = utf8ByteLength(write.content)
  if (size > MAX_EXPORT_BYTES) {
    throw ApiError.tooLarge(`Exports are limited to ${MAX_EXPORT_BYTES / (1024 * 1024)} MB`)
  }
  const key = exportKey(write.format, write.userId, write.exportId)
  await bucket.put(key, write.content, {
    httpMetadata: { contentType: EXPORT_CONTENT_TYPES[write.format] },
  })
  return { key, size }
}

export async function readExportObject(env: Env, key: string): Promise<R2ObjectBody> {
  const object = await storageBucket(env).get(key)
  if (!object) throw new ApiError(404, 'github_not_found', 'Export file not found')
  return object
}

export async function deleteExportObject(env: Env, key: string): Promise<void> {
  await storageBucket(env).delete(key)
}

export async function deleteExportObjectBestEffort(env: Env, key: string): Promise<void> {
  if (!env.FILES) return
  try {
    await env.FILES.delete(key)
  } catch (error) {
    console.warn('[inkstone] Removing a development github export object failed:', error)
  }
}

export async function cleanupExpiredExports(
  env: Env,
  db: D1Database,
  userId: string,
): Promise<void> {
  const bucket = storageBucket(env)
  const cutoff = Date.now() - EXPORT_TTL_MS
  const expired = await listExpiredExports(db, userId, cutoff)
  if (expired.length === 0) return
  for (const chunk of idChunks(expired.map((record) => record.r2Key), 1000)) {
    try {
      await bucket.delete(chunk)
    } catch (error) {
      console.warn('[inkstone] Cleaning up expired development github exports failed:', error)
    }
  }
  await deleteExpiredExports(db, userId, cutoff)
}

export function exportFileView(
  id: string,
  filename: string,
  format: GithubExportFormat,
  size: number,
  createdAt: number,
): GithubExportFile {
  return {
    id,
    filename,
    format,
    size,
    url: `/api/development/github/exports/${id}`,
    createdAt,
  }
}
