import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  MAX_GIST_DATA_BYTES,
  MAX_GIST_FILES,
  MAX_GIST_FILENAME,
  MAX_GIST_FILE_BYTES,
  MAX_NOTES,
  MAX_REPO_DATA_BYTES,
  MAX_TAG_IDS,
  EXPORT_TTL_MS,
} from '@shared/development/github/limits'
import {
  GithubAccountTokenSchema,
  GithubBatchDeleteSchema,
  GithubBatchUpdateSchema,
  GithubExportSchema,
  GithubGistListQuerySchema,
  GithubMirrorListSchema,
  GithubSearchQuerySchema,
  GithubTagInputSchema,
  SavedGistInputSchema,
  SavedGithubRepoInputSchema,
} from '@shared/development/github/schemas'
import type { GistItem, GithubTag } from '@shared/development/github/types'
import { utf8ByteLength } from '@shared/text-utils'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { contentDisposition } from '../lib/http-range'
import { isValidId, newId } from '../lib/id'
import { readJson } from '../lib/request'
import { createMinuteBudget } from '../lib/rate-limit'
import { downloadReadmeImage } from '../cloudflare/catalog'
import { requireAuth } from '../middleware/auth'
import {
  addGithubAccount,
  decryptAccountToken,
  deleteGithubAccount,
  effectiveGithubToken,
  githubTokenForUsername,
  listAccountRecords,
  listAccountViews,
} from '../development/github/accounts'
import {
  createGithubGist,
  deleteGithubGist,
  fetchGistDetail,
  isGistId,
  isGithubUsername,
  listGithubGists,
  updateGithubGist,
} from '../development/github/github-gists'
import { fetchRepoDetail, parseRepoFullName, searchRepositories } from '../development/github/github-repos'
import { listMirrors, replaceMirrors } from '../development/github/mirrors'
import {
  assertExportStorage,
  buildGistExport,
  cleanupExpiredExports,
  deleteExportObjectBestEffort,
  EXPORT_CONTENT_TYPES,
  exportFileView,
  gistExportFilename,
  putGistExport,
  readExportObject,
} from '../development/github/r2'
import {
  batchUpdateGists,
  collectDescendantTagIds,
  deleteExport,
  deleteGist,
  deleteGists,
  deleteGistTags,
  deleteRepo,
  deleteTags,
  findExport,
  findGist,
  findMissingGistTagIds,
  findMissingTagIds,
  findRepo,
  insertExport,
  listExports,
  listGistSummaries,
  listGistTags,
  listRepos,
  listTags,
  patchGist,
  searchGistIds,
  toGistSummary,
  unbindGistTags,
  unbindRepoTags,
  upsertGist,
  upsertGistTag,
  upsertRepo,
  upsertTag,
} from '../development/github/store'

export const developmentGithubRoutes = new Hono<AppBindings>()

developmentGithubRoutes.use('*', requireAuth)

const searchBudget = createMinuteBudget(20, 'Too many GitHub searches. Try again in a minute.')
const detailBudget = createMinuteBudget(40, 'Too many GitHub detail requests. Try again in a minute.')
const listBudget = createMinuteBudget(60, 'Too many GitHub list requests. Try again in a minute.')
const writeBudget = createMinuteBudget(30, 'Too many GitHub write requests. Try again in a minute.')
const imageBudget = createMinuteBudget(120, 'Too many GitHub image requests. Try again in a minute.')

const SLUG_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/
const REPO_ID_PATTERN = /^[0-9]{1,20}$/
const SMALL_BODY_LIMIT = 64 * 1024
const REPO_BODY_LIMIT = MAX_REPO_DATA_BYTES * 2 + SMALL_BODY_LIMIT
const GIST_BODY_LIMIT = MAX_GIST_DATA_BYTES * 2
const BATCH_BODY_LIMIT = 256 * 1024

const GistFileUploadSchema = z.object({
  filename: z.string().trim().min(1).max(MAX_GIST_FILENAME),
  content: z.string().max(MAX_GIST_FILE_BYTES),
})

const GithubGistCreateSchema = z.object({
  description: z.string().max(8000).default(''),
  isPublic: z.boolean(),
  files: z.array(GistFileUploadSchema).min(1).max(MAX_GIST_FILES),
  account: z.string().min(1).max(100).optional(),
})

const GistFilePatchSchema = z.object({
  content: z.string().max(MAX_GIST_FILE_BYTES),
  filename: z.string().trim().min(1).max(MAX_GIST_FILENAME).optional(),
}).nullable()

const GithubGistUpdateSchema = z
  .object({
    description: z.string().max(8000).optional(),
    files: z.record(z.string(), GistFilePatchSchema).optional(),
  })
  .refine((value) => value.description !== undefined || value.files !== undefined, {
    message: 'Provide a description or files to update',
    path: ['files'],
  })

const SavedGistPatchSchema = z
  .object({
    description: z.string().max(8000).optional(),
    tagIds: z.array(z.string().min(1).max(100)).max(MAX_TAG_IDS).optional(),
    pinned: z.boolean().optional(),
    favorited: z.boolean().optional(),
    notes: z.string().max(MAX_NOTES).optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'Nothing to update',
  })

const GistSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
})

const RepoDetailQuerySchema = z.object({
  repo: z.string().min(3).max(300),
  defaultBranch: z.string().max(200).optional(),
})

const GistDetailQuerySchema = z.object({
  gist: z.string().min(8).max(64),
})

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

function githubNotFound(message: string): ApiError {
  return new ApiError(404, 'github_not_found', message)
}

function tokenRequired(message: string): ApiError {
  return new ApiError(400, 'github_token_required', message)
}

async function parseBody<T>(
  c: Context<AppBindings>,
  schema: z.ZodType<T>,
  limit: number,
): Promise<T> {
  const raw = await readJson<unknown>(c, limit)
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.join('.') || 'body'
    throw ApiError.badRequest(`${path}: ${issue?.message ?? 'Invalid value'}`)
  }
  return result.data
}

function parseQuery<T>(c: Context<AppBindings>, schema: z.ZodType<T>): T {
  const result = schema.safeParse(c.req.query())
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.join('.') || 'query'
    throw ApiError.badRequest(`${path}: ${issue?.message ?? 'Invalid value'}`)
  }
  return result.data
}

function slugId(c: Context<AppBindings>, name = 'id'): string {
  const value = c.req.param(name)
  if (!value || !SLUG_ID_PATTERN.test(value)) throw ApiError.badRequest(`Invalid ${name}`)
  return value
}

function repoPathId(c: Context<AppBindings>): string {
  const value = c.req.param('id')
  if (!value || !REPO_ID_PATTERN.test(value)) throw ApiError.badRequest('Invalid repository id')
  return value
}

function gistPathId(c: Context<AppBindings>, name = 'id'): string {
  const value = c.req.param(name)
  if (!value || !isGistId(value)) throw ApiError.badRequest('Invalid gist id')
  return value
}

function accountPathId(c: Context<AppBindings>): string {
  const value = c.req.param('id')
  if (!value || !isValidId(value)) throw ApiError.badRequest('Invalid account id')
  return value
}

function exportPathId(c: Context<AppBindings>): string {
  const value = c.req.param('id')
  if (!value || !isValidId(value)) throw ApiError.badRequest('Invalid export id')
  return value
}

async function assertTagParent(
  tags: readonly GithubTag[],
  id: string,
  parentId: string | null,
): Promise<void> {
  if (!parentId) return
  if (parentId === id) throw ApiError.badRequest('A tag cannot be its own parent')
  if (!tags.some((tag) => tag.id === parentId)) {
    throw ApiError.badRequest('The parent tag does not exist')
  }
  if (collectDescendantTagIds(tags, id).includes(parentId)) {
    throw ApiError.badRequest('A tag cannot be nested under its own descendant')
  }
}

function assertTagNameAvailable(
  tags: readonly GithubTag[],
  id: string,
  name: string,
  parentId: string | null,
): void {
  const normalized = name.trim().toLowerCase()
  const parent = parentId ?? null
  if (tags.some((tag) =>
    tag.id !== id
    && (tag.parentId ?? null) === parent
    && tag.name.trim().toLowerCase() === normalized)) {
    throw ApiError.badRequest('A tag with this name already exists at this level')
  }
}

async function assertRepoTags(
  c: Context<AppBindings>,
  userId: string,
  tagIds: readonly string[],
): Promise<void> {
  const missing = await findMissingTagIds(c.env.DB, userId, tagIds)
  if (missing.length > 0) throw ApiError.badRequest('Some tags do not exist', { missing })
}

async function assertGistTags(
  c: Context<AppBindings>,
  userId: string,
  tagIds: readonly string[],
): Promise<void> {
  const missing = await findMissingGistTagIds(c.env.DB, userId, tagIds)
  if (missing.length > 0) throw ApiError.badRequest('Some gist tags do not exist', { missing })
}

function requireToken(token: string | null, message: string): string {
  if (!token) throw tokenRequired(message)
  return token
}

function assertSavedGistData(gist: GistItem): void {
  const names = new Set<string>()
  for (const file of gist.files) {
    if (
      file.filename === '.' ||
      file.filename === '..' ||
      /[/\\\u0000-\u001f\u007f]/.test(file.filename)
    ) {
      throw ApiError.badRequest('A gist file name cannot contain slashes or control characters')
    }
    if (names.has(file.filename)) throw ApiError.badRequest('Gist file names must be unique')
    names.add(file.filename)
    if (utf8ByteLength(file.content) > MAX_GIST_FILE_BYTES) {
      throw ApiError.tooLarge(`A gist file is limited to ${MAX_GIST_FILE_BYTES} bytes`)
    }
  }
}

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    const current = copy[index]!
    copy[index] = copy[swapIndex]!
    copy[swapIndex] = current
  }
  return copy
}

async function resolveGistWriteToken(c: Context<AppBindings>, gistId: string): Promise<string> {
  const userId = userIdOf(c)
  const records = await listAccountRecords(c.env.DB, userId)
  if (records.length === 0) {
    throw tokenRequired('Add a GitHub account before changing gists')
  }
  let opened = 0
  let firstError: ApiError | null = null
  for (const record of shuffled(records)) {
    const token = await decryptAccountToken(c.env, record)
    if (!token) continue
    opened += 1
    let gist: GistItem
    try {
      gist = await fetchGistDetail(gistId, token)
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'github_not_found') continue
        if (!firstError) firstError = error
        continue
      }
      throw error
    }
    const owner = gist.owner?.login ?? ''
    const ownerAccount = records.find(
      (candidate) => candidate.username.toLowerCase() === owner.toLowerCase(),
    )
    if (!ownerAccount) throw githubNotFound('Gist not found for this account')
    if (ownerAccount.id === record.id) return token
    const ownerToken = await decryptAccountToken(c.env, ownerAccount)
    if (!ownerToken) {
      throw new ApiError(
        400,
        'github_token_invalid',
        'The saved GitHub token could not be read. Add the account again',
      )
    }
    return ownerToken
  }
  if (opened === 0) {
    throw new ApiError(
      400,
      'github_token_invalid',
      'The saved GitHub token could not be read. Add the account again',
    )
  }
  if (firstError) throw firstError
  throw githubNotFound('Gist not found')
}

developmentGithubRoutes.get('/health', (c) => c.json({ ok: true, data: { ready: true } }))

developmentGithubRoutes.get('/image', async (c) => {
  imageBudget(userIdOf(c))
  const raw = c.req.query('url')
  if (!raw || raw.length > 2048) throw ApiError.badRequest('An image URL is required')
  try {
    const { bytes, type } = await downloadReadmeImage(raw)
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox; img-src 'none'; form-action 'none'; base-uri 'none'",
      },
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 400) throw error
    throw new ApiError(502, 'github_upstream', 'The image could not be loaded')
  }
})

developmentGithubRoutes.get('/bootstrap', async (c) => {
  const userId = userIdOf(c)
  const [tags, repos, gistTags, gists, mirrors, accounts] = await Promise.all([
    listTags(c.env.DB, userId),
    listRepos(c.env.DB, userId),
    listGistTags(c.env.DB, userId),
    listGistSummaries(c.env.DB, userId),
    listMirrors(c.env.DB, userId),
    listAccountViews(c.env.DB, userId),
  ])
  return c.json({
    ok: true,
    data: { tags, repos, gistTags, gists, mirrors, accounts, capabilities: { exports: Boolean(c.env.FILES) } },
  })
})

developmentGithubRoutes.get('/tags', async (c) => {
  const tags = await listTags(c.env.DB, userIdOf(c))
  return c.json({ ok: true, data: { tags } })
})

developmentGithubRoutes.put('/tags/:id', async (c) => {
  const userId = userIdOf(c)
  const id = slugId(c)
  const body = await parseBody(c, GithubTagInputSchema, SMALL_BODY_LIMIT)
  const tags = await listTags(c.env.DB, userId)
  await assertTagParent(tags, id, body.parentId)
  assertTagNameAvailable(tags, id, body.name, body.parentId)
  const tag = await upsertTag(c.env.DB, userId, {
    id,
    name: body.name,
    color: body.color,
    parentId: body.parentId,
    sortOrder: body.sortOrder,
    createdAt: body.createdAt,
  })
  return c.json({ ok: true, data: { tag } })
})

developmentGithubRoutes.delete('/tags/:id', async (c) => {
  const userId = userIdOf(c)
  const id = slugId(c)
  const tags = await listTags(c.env.DB, userId)
  if (!tags.some((tag) => tag.id === id)) throw githubNotFound('Tag not found')
  const removedTagIds = collectDescendantTagIds(tags, id)
  const updatedRepoIds = await unbindRepoTags(c.env.DB, userId, removedTagIds)
  await deleteTags(c.env.DB, userId, removedTagIds)
  return c.json({ ok: true, data: { removedTagIds, updatedRepoIds } })
})

developmentGithubRoutes.get('/repos', async (c) => {
  const repos = await listRepos(c.env.DB, userIdOf(c))
  return c.json({ ok: true, data: { repos } })
})

developmentGithubRoutes.put('/repos/:id', async (c) => {
  const userId = userIdOf(c)
  const id = repoPathId(c)
  const body = await parseBody(c, SavedGithubRepoInputSchema, REPO_BODY_LIMIT)
  if (!parseRepoFullName(body.fullName)) {
    throw ApiError.badRequest('A repository must be named owner/name')
  }
  const tagIds = Array.from(new Set(body.tagIds))
  await assertRepoTags(c, userId, tagIds)
  const repo = await upsertRepo(c.env.DB, userId, {
    id,
    fullName: body.fullName,
    url: body.url,
    data: body.data,
    tagIds,
    pinned: body.pinned,
    favorited: body.favorited,
    createdAt: body.createdAt,
  })
  return c.json({ ok: true, data: { repo } })
})

developmentGithubRoutes.delete('/repos/:id', async (c) => {
  const userId = userIdOf(c)
  const id = repoPathId(c)
  if (!(await findRepo(c.env.DB, userId, id))) throw githubNotFound('Repository not found')
  await deleteRepo(c.env.DB, userId, id)
  return c.json({ ok: true, data: { ok: true } })
})

developmentGithubRoutes.get('/gist/tags', async (c) => {
  const tags = await listGistTags(c.env.DB, userIdOf(c))
  return c.json({ ok: true, data: { tags } })
})

developmentGithubRoutes.put('/gist/tags/:id', async (c) => {
  const userId = userIdOf(c)
  const id = slugId(c)
  const body = await parseBody(c, GithubTagInputSchema, SMALL_BODY_LIMIT)
  const tags = await listGistTags(c.env.DB, userId)
  await assertTagParent(tags, id, body.parentId)
  assertTagNameAvailable(tags, id, body.name, body.parentId)
  const tag = await upsertGistTag(c.env.DB, userId, {
    id,
    name: body.name,
    color: body.color,
    parentId: body.parentId,
    sortOrder: body.sortOrder,
    createdAt: body.createdAt,
  })
  return c.json({ ok: true, data: { tag } })
})

developmentGithubRoutes.delete('/gist/tags/:id', async (c) => {
  const userId = userIdOf(c)
  const id = slugId(c)
  const tags = await listGistTags(c.env.DB, userId)
  if (!tags.some((tag) => tag.id === id)) throw githubNotFound('Gist tag not found')
  const removedTagIds = collectDescendantTagIds(tags, id)
  const updatedGistIds = await unbindGistTags(c.env.DB, userId, removedTagIds)
  await deleteGistTags(c.env.DB, userId, removedTagIds)
  return c.json({ ok: true, data: { removedTagIds, updatedGistIds } })
})

developmentGithubRoutes.get('/gist/gists', async (c) => {
  const gists = await listGistSummaries(c.env.DB, userIdOf(c))
  return c.json({ ok: true, data: { gists } })
})

developmentGithubRoutes.get('/gist/gists/search', async (c) => {
  const userId = userIdOf(c)
  listBudget(userId)
  const query = parseQuery(c, GistSearchQuerySchema)
  return c.json({ ok: true, data: { ids: await searchGistIds(c.env.DB, userId, query.q) } })
})

developmentGithubRoutes.get('/gist/gists/:id', async (c) => {
  const userId = userIdOf(c)
  const id = gistPathId(c)
  const gist = await findGist(c.env.DB, userId, id)
  if (!gist) throw githubNotFound('Gist not found')
  return c.json({ ok: true, data: { gist } })
})

developmentGithubRoutes.patch('/gist/gists/:id', async (c) => {
  const userId = userIdOf(c)
  writeBudget(userId)
  const id = gistPathId(c)
  const body = await parseBody(c, SavedGistPatchSchema, SMALL_BODY_LIMIT)
  if (body.tagIds) await assertGistTags(c, userId, body.tagIds)
  const gist = await patchGist(c.env.DB, userId, id, body)
  if (!gist) throw githubNotFound('Gist not found')
  return c.json({ ok: true, data: { gist: toGistSummary(gist) } })
})

developmentGithubRoutes.put('/gist/gists/:id', async (c) => {
  const userId = userIdOf(c)
  const id = gistPathId(c)
  const body = await parseBody(c, SavedGistInputSchema, GIST_BODY_LIMIT)
  assertSavedGistData(body.data)
  const tagIds = Array.from(new Set(body.tagIds))
  await assertGistTags(c, userId, tagIds)
  const gist = await upsertGist(c.env.DB, userId, {
    id,
    description: body.description,
    url: body.url,
    data: body.data,
    tagIds,
    pinned: body.pinned,
    favorited: body.favorited,
    notes: body.notes,
    createdAt: body.createdAt,
  })
  return c.json({ ok: true, data: { gist } })
})

developmentGithubRoutes.delete('/gist/gists/:id', async (c) => {
  const userId = userIdOf(c)
  const id = gistPathId(c)
  if (!(await findGist(c.env.DB, userId, id))) throw githubNotFound('Gist not found')
  await deleteGist(c.env.DB, userId, id)
  return c.json({ ok: true, data: { ok: true } })
})

developmentGithubRoutes.post('/gist/gists/batch-delete', async (c) => {
  const userId = userIdOf(c)
  const body = await parseBody(c, GithubBatchDeleteSchema, BATCH_BODY_LIMIT)
  const ids = body.ids.filter((id) => isGistId(id))
  if (ids.length !== body.ids.length) throw ApiError.badRequest('Invalid gist id')
  const count = await deleteGists(c.env.DB, userId, ids)
  return c.json({ ok: true, data: { count } })
})

developmentGithubRoutes.post('/gist/gists/batch-update', async (c) => {
  const userId = userIdOf(c)
  const body = await parseBody(c, GithubBatchUpdateSchema, BATCH_BODY_LIMIT)
  const ids = body.ids.filter((id) => isGistId(id))
  if (ids.length !== body.ids.length) throw ApiError.badRequest('Invalid gist id')
  const tagIds = [...(body.patch.addTagIds ?? []), ...(body.patch.removeTagIds ?? [])]
  await assertGistTags(c, userId, tagIds)
  const count = await batchUpdateGists(c.env.DB, userId, ids, {
    pinned: body.patch.pinned,
    favorited: body.patch.favorited,
    addTagIds: body.patch.addTagIds,
    removeTagIds: body.patch.removeTagIds,
  })
  return c.json({ ok: true, data: { count } })
})

developmentGithubRoutes.get('/mirrors', async (c) => {
  const mirrors = await listMirrors(c.env.DB, userIdOf(c))
  return c.json({ ok: true, data: { mirrors } })
})

developmentGithubRoutes.put('/mirrors', async (c) => {
  const userId = userIdOf(c)
  const body = await parseBody(c, GithubMirrorListSchema, SMALL_BODY_LIMIT)
  const saved = await replaceMirrors(c.env.DB, userId, body.mirrors)
  const mirrors = saved.length > 0 ? saved : await listMirrors(c.env.DB, userId)
  return c.json({ ok: true, data: { mirrors } })
})

developmentGithubRoutes.get('/accounts', async (c) => {
  const accounts = await listAccountViews(c.env.DB, userIdOf(c))
  return c.json({ ok: true, data: { accounts } })
})

developmentGithubRoutes.post('/accounts', async (c) => {
  const body = await parseBody(c, GithubAccountTokenSchema, SMALL_BODY_LIMIT)
  const account = await addGithubAccount(c.env, c.env.DB, userIdOf(c), body.token)
  return c.json({ ok: true, data: { account } })
})

developmentGithubRoutes.delete('/accounts/:id', async (c) => {
  const userId = userIdOf(c)
  const id = accountPathId(c)
  if (!(await deleteGithubAccount(c.env.DB, userId, id))) throw githubNotFound('GitHub account not found')
  return c.json({ ok: true, data: { ok: true } })
})

developmentGithubRoutes.get('/search', async (c) => {
  const userId = userIdOf(c)
  searchBudget(userId)
  const query = parseQuery(c, GithubSearchQuerySchema)
  const token = await effectiveGithubToken(c.env, c.env.DB, userId)
  const result = await searchRepositories(
    {
      q: query.q,
      range: query.range,
      sort: query.sort,
      order: query.order,
      language: query.language,
      perPage: query.per_page,
      page: query.page,
    },
    token,
  )
  return c.json({ ok: true, data: result })
})

developmentGithubRoutes.get('/repo-detail', async (c) => {
  const userId = userIdOf(c)
  detailBudget(userId)
  const query = parseQuery(c, RepoDetailQuerySchema)
  if (!parseRepoFullName(query.repo)) throw ApiError.badRequest('A repository must be named owner/name')
  const defaultBranch = query.defaultBranch?.trim() || undefined
  const token = await effectiveGithubToken(c.env, c.env.DB, userId)
  const detail = await fetchRepoDetail(query.repo, defaultBranch, token)
  return c.json({ ok: true, data: detail })
})

developmentGithubRoutes.get('/gist/detail', async (c) => {
  const userId = userIdOf(c)
  detailBudget(userId)
  const query = parseQuery(c, GistDetailQuerySchema)
  if (!isGistId(query.gist)) throw ApiError.badRequest('Invalid gist id')
  const token = await effectiveGithubToken(c.env, c.env.DB, userId)
  const gist = await fetchGistDetail(query.gist, token)
  return c.json({ ok: true, data: gist })
})

developmentGithubRoutes.get('/gist/public', async (c) => {
  const userId = userIdOf(c)
  listBudget(userId)
  const query = parseQuery(c, GithubGistListQuerySchema)
  const token = await effectiveGithubToken(c.env, c.env.DB, userId)
  const result = await listGithubGists('public', {
    page: query.page,
    perPage: query.per_page,
    token,
  })
  return c.json({ ok: true, data: result })
})

developmentGithubRoutes.get('/gist/mine', async (c) => {
  const userId = userIdOf(c)
  listBudget(userId)
  const query = parseQuery(c, GithubGistListQuerySchema)
  const token = requireToken(
    await effectiveGithubToken(c.env, c.env.DB, userId, query.account),
    'Add a GitHub account before viewing your gists',
  )
  const result = await listGithubGists('mine', {
    page: query.page,
    perPage: query.per_page,
    token,
  })
  return c.json({ ok: true, data: result })
})

developmentGithubRoutes.get('/gist/users/:username/gists', async (c) => {
  const userId = userIdOf(c)
  listBudget(userId)
  const username = c.req.param('username')
  if (!username || !isGithubUsername(username)) throw ApiError.badRequest('Invalid GitHub username')
  const query = parseQuery(c, GithubGistListQuerySchema)
  const accountToken = await githubTokenForUsername(c.env, c.env.DB, userId, username)
  const rateToken = accountToken ?? (await effectiveGithubToken(c.env, c.env.DB, userId))
  const result = await listGithubGists('user', {
    page: query.page,
    perPage: query.per_page,
    username,
    token: accountToken,
    fallbackToken: rateToken,
  })
  return c.json({ ok: true, data: result })
})

developmentGithubRoutes.post('/gist/github-gists', async (c) => {
  const userId = userIdOf(c)
  writeBudget(userId)
  const body = await parseBody(c, GithubGistCreateSchema, GIST_BODY_LIMIT)
  const token = requireToken(
    await effectiveGithubToken(c.env, c.env.DB, userId, body.account),
    'Add a GitHub account before creating gists',
  )
  const gist = await createGithubGist(
    { description: body.description, isPublic: body.isPublic, files: body.files },
    token,
  )
  return c.json({ ok: true, data: { gist } })
})

developmentGithubRoutes.patch('/gist/github-gists/:id', async (c) => {
  writeBudget(userIdOf(c))
  const id = gistPathId(c)
  const body = await parseBody(c, GithubGistUpdateSchema, GIST_BODY_LIMIT)
  const token = await resolveGistWriteToken(c, id)
  const gist = await updateGithubGist(id, { description: body.description, files: body.files }, token)
  return c.json({ ok: true, data: { gist } })
})

developmentGithubRoutes.delete('/gist/github-gists/:id', async (c) => {
  writeBudget(userIdOf(c))
  const id = gistPathId(c)
  const token = await resolveGistWriteToken(c, id)
  await deleteGithubGist(id, token)
  return c.json({ ok: true, data: { ok: true } })
})

developmentGithubRoutes.post('/gists/:id/exports', async (c) => {
  const userId = userIdOf(c)
  const id = gistPathId(c)
  const body = await parseBody(c, GithubExportSchema, SMALL_BODY_LIMIT)
  assertExportStorage(c.env)
  await cleanupExpiredExports(c.env, c.env.DB, userId)
  const gist = await findGist(c.env.DB, userId, id)
  if (!gist) throw githubNotFound('Gist not found')
  const tags = await listGistTags(c.env.DB, userId)
  const exportId = newId()
  const createdAt = Date.now()
  const filename = gistExportFilename(gist.id, body.format)
  const content = buildGistExport(body.format, {
    gist,
    tags: tags.filter((tag) => gist.tagIds.includes(tag.id)),
  })
  const written = await putGistExport(c.env, {
    userId,
    exportId,
    format: body.format,
    content,
  })
  try {
    await insertExport(c.env.DB, userId, {
      id: exportId,
      filename,
      format: body.format,
      r2Key: written.key,
      size: written.size,
      createdAt,
    })
  } catch (error) {
    await deleteExportObjectBestEffort(c.env, written.key)
    throw error
  }
  return c.json({
    ok: true,
    data: { export: exportFileView(exportId, filename, body.format, written.size, createdAt) },
  })
})

developmentGithubRoutes.get('/exports', async (c) => {
  const userId = userIdOf(c)
  assertExportStorage(c.env)
  await cleanupExpiredExports(c.env, c.env.DB, userId)
  const exports = await listExports(c.env.DB, userId)
  return c.json({
    ok: true,
    data: {
      exports: exports.map((record) =>
        exportFileView(record.id, record.filename, record.format, record.size, record.createdAt),
      ),
    },
  })
})

developmentGithubRoutes.get('/exports/:id', async (c) => {
  const userId = userIdOf(c)
  const id = exportPathId(c)
  assertExportStorage(c.env)
  const record = await findExport(c.env.DB, userId, id)
  if (!record) throw githubNotFound('Export not found')
  if (record.createdAt + EXPORT_TTL_MS < Date.now()) {
    await deleteExportObjectBestEffort(c.env, record.r2Key)
    await deleteExport(c.env.DB, userId, id)
    throw githubNotFound('Export not found')
  }
  const object = await readExportObject(c.env, record.r2Key)
  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': EXPORT_CONTENT_TYPES[record.format],
      'Content-Length': String(object.size),
      'Content-Disposition': contentDisposition('application/octet-stream', record.filename),
      'Cache-Control': 'private, no-store',
    },
  })
})

developmentGithubRoutes.delete('/exports/:id', async (c) => {
  const userId = userIdOf(c)
  const id = exportPathId(c)
  assertExportStorage(c.env)
  const record = await findExport(c.env.DB, userId, id)
  if (!record) throw githubNotFound('Export not found')
  await deleteExportObjectBestEffort(c.env, record.r2Key)
  await deleteExport(c.env.DB, userId, id)
  return c.json({ ok: true, data: { ok: true } })
})
