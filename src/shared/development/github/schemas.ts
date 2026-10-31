import { z } from 'zod'
import { isHttpUrl } from './url'
import {
  MAX_BATCH_IDS,
  MAX_GIST_DATA_BYTES,
  MAX_GIST_FILES,
  MAX_GIST_FILENAME,
  MAX_GIST_FILE_BYTES,
  MAX_MIRRORS,
  MAX_NOTES,
  MAX_REPO_DATA_BYTES,
  MAX_SEARCH_PAGE,
  MAX_TAG_IDS,
  MAX_TAG_NAME,
} from './limits'

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const HttpUrl = z.string().max(2048).refine((value) => value === '' || isHttpUrl(value), 'URL must use http or https')
const NullableHttpUrl = z.string().max(2048).refine(isHttpUrl, 'URL must use http or https').nullable()

export const GithubTagInputSchema = z.object({
  name: z.string().trim().min(1).max(MAX_TAG_NAME),
  color: HexColor.default('#64748b'),
  parentId: z.string().min(1).max(100).nullable().default(null),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  createdAt: z.number().int().positive().optional(),
})

const RepoOwnerSchema = z.object({
  login: z.string().max(100),
  avatarUrl: HttpUrl,
})

export const GithubRepoSnapshotSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string().max(200),
  fullName: z.string().max(300),
  url: HttpUrl,
  description: z.string().max(8000).nullable(),
  homepage: NullableHttpUrl,
  owner: RepoOwnerSchema,
  language: z.string().max(100).nullable(),
  stargazersCount: z.number().int().nonnegative(),
  forksCount: z.number().int().nonnegative(),
  openIssuesCount: z.number().int().nonnegative(),
  topics: z.array(z.string().max(100)).max(100),
  license: z.string().max(200).nullable(),
  isArchived: z.boolean(),
  createdAt: z.string().max(64),
  updatedAt: z.string().max(64),
  defaultBranch: z.string().max(200),
  size: z.number().int().nonnegative(),
})

export const GistFileSchema = z.object({
  filename: z.string().trim().min(1).max(MAX_GIST_FILENAME),
  language: z.string().max(100).nullable(),
  content: z.string().max(MAX_GIST_FILE_BYTES),
  size: z.number().int().nonnegative(),
})

export const GistItemSchema = z.object({
  id: z.string().min(1).max(100),
  description: z.string().max(8000),
  url: HttpUrl,
  isPublic: z.boolean(),
  owner: RepoOwnerSchema.nullable(),
  files: z.array(GistFileSchema).max(MAX_GIST_FILES),
  fileCount: z.number().int().nonnegative(),
  createdAt: z.string().max(64),
  updatedAt: z.string().max(64),
})

export const SavedGithubRepoInputSchema = z.object({
  fullName: z.string().trim().min(3).max(300),
  url: HttpUrl,
  data: GithubRepoSnapshotSchema,
  tagIds: z.array(z.string().min(1).max(100)).max(MAX_TAG_IDS).default([]),
  pinned: z.boolean().default(false),
  favorited: z.boolean().default(false),
  notes: z.string().max(MAX_NOTES).default(''),
  createdAt: z.number().int().positive().optional(),
}).superRefine((value, ctx) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value.data)).byteLength
  if (bytes > MAX_REPO_DATA_BYTES) {
    ctx.addIssue({ code: 'custom', path: ['data'], message: `Repository snapshot exceeds ${MAX_REPO_DATA_BYTES} bytes` })
  }
})

export const SavedGistInputSchema = z.object({
  description: z.string().max(8000).default(''),
  url: HttpUrl.default(''),
  data: GistItemSchema,
  tagIds: z.array(z.string().min(1).max(100)).max(MAX_TAG_IDS).default([]),
  pinned: z.boolean().default(false),
  favorited: z.boolean().default(false),
  notes: z.string().max(MAX_NOTES).default(''),
  createdAt: z.number().int().positive().optional(),
}).superRefine((value, ctx) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value.data)).byteLength
  if (bytes > MAX_GIST_DATA_BYTES) {
    ctx.addIssue({ code: 'custom', path: ['data'], message: `Gist snapshot exceeds ${MAX_GIST_DATA_BYTES} bytes` })
  }
})

export const GithubMirrorSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  url: z.string().url().max(2048),
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative().optional(),
})

export const GithubMirrorListSchema = z.object({
  mirrors: z.array(GithubMirrorSchema).max(MAX_MIRRORS),
}).superRefine((value, ctx) => {
  for (const mirror of value.mirrors) {
    let parsed: URL
    try {
      parsed = new URL(mirror.url)
    } catch {
      ctx.addIssue({ code: 'custom', path: ['mirrors'], message: 'Mirror URL is not valid' })
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', path: ['mirrors'], message: 'Mirror URL must use http or https' })
    }
    if (parsed.username || parsed.password) {
      ctx.addIssue({ code: 'custom', path: ['mirrors'], message: 'Mirror URL cannot contain credentials' })
    }
  }
})

export const GithubMirrorProbeSchema = z.object({
  mirrors: z.array(z.object({
    id: z.string().min(1).max(100),
    url: z.string().trim().min(1).max(2048),
  })).min(1).max(MAX_MIRRORS),
})

export const GithubAccountTokenSchema = z.object({
  token: z.string().trim().min(1).max(4096),
})

export const GithubBatchDeleteSchema = z.object({
  ids: z.array(z.string().min(1).max(100)).min(1).max(MAX_BATCH_IDS),
})

export const GithubBatchUpdateSchema = z.object({
  ids: z.array(z.string().min(1).max(100)).min(1).max(MAX_BATCH_IDS),
  patch: z.object({
    pinned: z.boolean().optional(),
    favorited: z.boolean().optional(),
    addTagIds: z.array(z.string().min(1).max(100)).max(MAX_TAG_IDS).optional(),
    removeTagIds: z.array(z.string().min(1).max(100)).max(MAX_TAG_IDS).optional(),
  }),
})

export const GithubSearchQuerySchema = z.object({
  q: z.string().max(256).default(''),
  range: z.enum(['today', 'week', 'month', 'quarter', 'year', 'all']).default('today'),
  sort: z.enum(['stars', 'forks', 'updated', 'best-match']).default('stars'),
  order: z.enum(['asc', 'desc']).default('desc'),
  language: z.string().max(64).default(''),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
  page: z.coerce.number().int().min(1).max(MAX_SEARCH_PAGE).default(1),
})

export const GithubExportSchema = z.object({
  format: z.enum(['json', 'md', 'txt']),
})

export const GithubGistListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(30),
  account: z.string().min(1).max(100).optional(),
})

export type GithubTagInput = z.infer<typeof GithubTagInputSchema>
export type SavedGithubRepoInput = z.infer<typeof SavedGithubRepoInputSchema>
export type SavedGistInput = z.infer<typeof SavedGistInputSchema>
export type GithubMirrorInput = z.infer<typeof GithubMirrorSchema>
export type GithubSearchQuery = z.infer<typeof GithubSearchQuerySchema>
export type GithubBatchPatchInput = z.infer<typeof GithubBatchUpdateSchema>['patch']
