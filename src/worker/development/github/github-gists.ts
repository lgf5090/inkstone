import {
  GITHUB_TIMEOUT_MS,
  GITHUB_WRITE_TIMEOUT_MS,
  MAX_GIST_DETAIL_BYTES,
  MAX_GIST_FILES,
  MAX_GIST_FILENAME,
  MAX_GIST_FILE_BYTES,
} from '@shared/development/github/limits'
import type { GistFile, GistItem, GistListResult } from '@shared/development/github/types'
import { utf8ByteLength } from '@shared/text-utils'
import { ApiError } from '../../lib/errors'
import { githubJson } from './github-http'

const GIST_ID_PATTERN = /^[a-f0-9]{8,64}$/
const GITHUB_USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

export type GistListType = 'public' | 'mine' | 'user'

export interface GistUploadFile {
  filename: string
  content: string
}

export interface GistListOptions {
  page: number
  perPage: number
  username?: string | null
  token?: string | null
  fallbackToken?: string | null
}

export function isGistId(value: string): boolean {
  return GIST_ID_PATTERN.test(value)
}

export function isGithubUsername(value: string): boolean {
  return GITHUB_USERNAME_PATTERN.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : ''
}

function readNullableString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' ? value.slice(0, maxLength) : null
}

function readNumber(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0
}

function normalizeFile(value: unknown): GistFile {
  const raw = isRecord(value) ? value : {}
  return {
    filename: readString(raw.filename, MAX_GIST_FILENAME),
    language: readNullableString(raw.language, 100),
    content: readString(raw.content, MAX_GIST_FILE_BYTES),
    size: readNumber(raw.size),
  }
}

export function normalizeGist(value: unknown): GistItem {
  const raw = isRecord(value) ? value : {}
  const filesRaw = isRecord(raw.files) ? raw.files : {}
  const files = Object.values(filesRaw)
    .map((file) => normalizeFile(file))
    .filter((file) => file.filename.length > 0)
    .slice(0, MAX_GIST_FILES)
  const ownerRaw = isRecord(raw.owner) ? raw.owner : null
  return {
    id: readString(raw.id, 100),
    description: readString(raw.description, 8000),
    url: readString(raw.html_url, 2048),
    isPublic: raw.public !== false,
    owner: ownerRaw
      ? {
          login: readString(ownerRaw.login, 100),
          avatarUrl: readString(ownerRaw.avatar_url, 2048),
        }
      : null,
    files,
    fileCount: files.length,
    createdAt: readString(raw.created_at, 64),
    updatedAt: readString(raw.updated_at, 64),
  }
}

function hasNextPage(link: string | null): boolean {
  return link !== null && link.includes('rel="next"')
}

export async function listGithubGists(
  type: GistListType,
  options: GistListOptions,
): Promise<GistListResult> {
  const page = options.page
  const perPage = options.perPage
  const query = `per_page=${perPage}&page=${page}`
  let path: string
  let token: string | null = options.token ?? null
  if (type === 'public') {
    path = `/gists/public?${query}`
    token = options.token ?? options.fallbackToken ?? null
  } else if (type === 'mine') {
    if (!token) {
      throw new ApiError(400, 'github_token_required', 'Add a GitHub account before viewing your gists')
    }
    path = `/gists?${query}`
  } else {
    const username = options.username?.trim() ?? ''
    if (!isGithubUsername(username)) {
      throw ApiError.badRequest('A valid GitHub username is required')
    }
    if (token) {
      path = `/gists?${query}`
    } else {
      token = options.fallbackToken ?? null
      path = `/users/${encodeURIComponent(username)}/gists?${query}`
    }
  }
  const { data, link } = await githubJson<unknown[]>(path, {
    token,
    timeoutMs: GITHUB_TIMEOUT_MS,
  })
  const items = Array.isArray(data) ? data.map((item) => normalizeGist(item)) : []
  return { items, page, perPage, hasNext: hasNextPage(link) }
}

export async function fetchGistDetail(
  gistId: string,
  token?: string | null,
): Promise<GistItem> {
  if (!isGistId(gistId)) throw ApiError.badRequest('A GitHub gist id must be hexadecimal')
  const { data } = await githubJson<unknown>(`/gists/${encodeURIComponent(gistId)}`, {
    token,
    timeoutMs: GITHUB_TIMEOUT_MS,
    maxBytes: MAX_GIST_DETAIL_BYTES,
  })
  return normalizeGist(data)
}

export function gistFilesPayload(
  files: readonly GistUploadFile[],
): Record<string, { content: string }> {
  if (files.length === 0) throw ApiError.badRequest('At least one file is required')
  if (files.length > MAX_GIST_FILES) {
    throw ApiError.badRequest(`A gist is limited to ${MAX_GIST_FILES} files`)
  }
  const payload: Record<string, { content: string }> = Object.create(null) as Record<
    string,
    { content: string }
  >
  for (const file of files) {
    const filename = file.filename.trim()
    if (!filename) throw ApiError.badRequest('A gist file name cannot be blank')
    if (filename.length > MAX_GIST_FILENAME) {
      throw ApiError.badRequest(`A gist file name is limited to ${MAX_GIST_FILENAME} characters`)
    }
    if (filename === '.' || filename === '..' || /[/\\\u0000-\u001f\u007f]/.test(filename)) {
      throw ApiError.badRequest('A gist file name cannot contain slashes or control characters')
    }
    if (Object.prototype.hasOwnProperty.call(payload, filename)) {
      throw ApiError.badRequest('Gist file names must be unique')
    }
    if (utf8ByteLength(file.content) > MAX_GIST_FILE_BYTES) {
      throw ApiError.tooLarge(`A gist file is limited to ${MAX_GIST_FILE_BYTES} bytes`)
    }
    payload[filename] = { content: file.content }
  }
  return payload
}

export async function createGithubGist(
  input: { description: string; isPublic: boolean; files: readonly GistUploadFile[] },
  token: string,
): Promise<GistItem> {
  const files = gistFilesPayload(input.files)
  const { data } = await githubJson<unknown>('/gists', {
    token,
    method: 'POST',
    body: {
      description: input.description,
      public: input.isPublic,
      files,
    },
    timeoutMs: GITHUB_WRITE_TIMEOUT_MS,
  })
  return normalizeGist(data)
}

export async function updateGithubGist(
  gistId: string,
  input: { description?: string; files?: readonly GistUploadFile[] },
  token: string,
): Promise<GistItem> {
  if (!isGistId(gistId)) throw ApiError.badRequest('A GitHub gist id must be hexadecimal')
  if (input.description === undefined && input.files === undefined) {
    throw ApiError.badRequest('Nothing to update')
  }
  const body: Record<string, unknown> = {}
  if (input.description !== undefined) body.description = input.description
  if (input.files !== undefined) body.files = gistFilesPayload(input.files)
  const { data } = await githubJson<unknown>(`/gists/${encodeURIComponent(gistId)}`, {
    token,
    method: 'PATCH',
    body,
    timeoutMs: GITHUB_WRITE_TIMEOUT_MS,
  })
  return normalizeGist(data)
}

export async function deleteGithubGist(gistId: string, token: string): Promise<void> {
  if (!isGistId(gistId)) throw ApiError.badRequest('A GitHub gist id must be hexadecimal')
  await githubJson<unknown>(`/gists/${encodeURIComponent(gistId)}`, {
    token,
    method: 'DELETE',
    timeoutMs: GITHUB_WRITE_TIMEOUT_MS,
  })
}
