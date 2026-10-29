import { z } from 'zod'
import {
  DEFAULT_NAV_AI,
  DEFAULT_NAV_BACKUP_STATE,
  DEFAULT_NAV_DISPLAY,
  DEFAULT_NAV_SEARCH,
  NAV_LIMITS,
  isHttpUrl,
  isNavId,
  isSafeIconValue,
  normalizeCategoryName,
  normalizeIconName,
  normalizeLinkUrl,
  normalizeSearchSource,
  type NavBackupState,
  type NavSearchSettings,
} from './model'

const navId = z.string().refine(isNavId, 'invalid id')

function iconValue(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  return normalizeIconName(raw) || 'folder'
}

const categoryName = z.string().trim().min(1).max(NAV_LIMITS.categoryName).transform(normalizeCategoryName)
const linkTitle = z.string().trim().min(1).max(NAV_LIMITS.title)
const linkUrl = z.string().trim().min(1).max(NAV_LIMITS.url).refine((value) => normalizeLinkUrl(value) !== null, 'unsupported url')
const iconUrl = z.union([z.string().trim().max(NAV_LIMITS.url).refine(isSafeIconValue, 'unsupported icon'), z.null()])
const description = z.union([z.string().max(NAV_LIMITS.description), z.null()])

export const NavLinkCreateSchema = z.object({
  id: navId.optional(),
  title: linkTitle,
  url: linkUrl,
  icon: iconUrl.optional(),
  description: description.optional(),
  categoryId: navId,
  pinned: z.boolean().optional(),
})
export type NavLinkCreateInput = z.infer<typeof NavLinkCreateSchema>

export const NavLinkPatchSchema = z.object({
  title: linkTitle.optional(),
  url: linkUrl.optional(),
  icon: iconUrl.optional(),
  description: description.optional(),
  categoryId: navId.optional(),
  pinned: z.boolean().optional(),
})
export type NavLinkPatchInput = z.infer<typeof NavLinkPatchSchema>

export const NavCategoryCreateSchema = z.object({
  id: navId.optional(),
  name: categoryName,
  icon: z.string().max(80).transform(iconValue),
  parentId: navId.nullable().optional(),
  passwordMode: z.enum(['none', 'custom', 'default']).default('none'),
  password: z.string().min(8).max(128).optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
})
export type NavCategoryCreateInput = z.infer<typeof NavCategoryCreateSchema>

export const NavCategoryPatchSchema = z.object({
  name: categoryName.optional(),
  icon: z.string().max(80).transform(iconValue).optional(),
  passwordMode: z.enum(['none', 'custom', 'default']).optional(),
  password: z.string().min(8).max(128).optional(),
})
export type NavCategoryPatchInput = z.infer<typeof NavCategoryPatchSchema>

export const NavCategoryDeleteSchema = z.object({ fallbackCategoryId: navId })
export const NavUnlockSchema = z.object({ password: z.string().min(1).max(128) })

export const NavOrderSchema = z.object({
  scope: z.enum(['pinned', 'category']).optional(),
  parentId: navId.nullable().optional(),
  categoryId: navId.optional(),
  orderedIds: z.array(navId).min(1).max(10_000),
})

export const NavVisitsSchema = z.object({
  visits: z.array(z.object({ linkId: navId, count: z.number().int().min(1).max(1000) })).max(NAV_LIMITS.visitsPerRequest),
})

export const NavBatchSchema = z.object({
  action: z.enum(['delete', 'move', 'rewrite']),
  ids: z.array(navId).min(1).max(500),
  fallbackCategoryId: navId.optional(),
  template: z.string().max(NAV_LIMITS.url).optional(),
})

export const NavAiSuggestSchema = z.object({
  title: z.string().trim().min(1).max(NAV_LIMITS.title),
  url: z.string().trim().min(1).max(NAV_LIMITS.url),
  categories: z.array(z.object({ id: navId, name: categoryName })).max(200),
})

export const NavCheckSchema = z.object({
  urls: z.array(z.string().max(NAV_LIMITS.url)).max(NAV_LIMITS.checkBatch),
})

const searchSourceSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(NAV_LIMITS.searchSourceName),
  url: z.string().trim().max(NAV_LIMITS.url).refine((value) => isHttpUrl(value) && value.includes('{query}'), 'url must be http(s) and contain {query}'),
  icon: z.string().max(NAV_LIMITS.url).nullable().optional(),
  enabled: z.boolean().optional(),
  createdAt: z.number().int().nonnegative().optional(),
})

export const NavDisplaySettingsSchema = z.object({
  navTitle: z.string().max(60).default(''),
  cardStyle: z.enum(['detailed', 'simple']).default('detailed'),
  recentLinksCount: z.number().int().min(0).max(NAV_LIMITS.recentLinks).default(10),
  frequentLinksCount: z.number().int().min(0).max(NAV_LIMITS.frequentLinks).default(10),
  autoFetchIcon: z.boolean().default(true),
})

export const NavSearchSettingsSchema = z.object({
  mode: z.enum(['internal', 'external']).default('internal'),
  sources: z.array(searchSourceSchema).max(NAV_LIMITS.searchSources).default([]),
  selectedSourceId: z.string().max(64).nullable().default(null),
})

export const NavAiSettingsSchema = z.object({ modelId: z.string().max(64).default('') })

export const NavWebdavSettingsSchema = z.object({
  url: z.string().trim().max(NAV_LIMITS.url).default(''),
  username: z.string().trim().max(200).default(''),
})

export const NavSettingsGroupSchema = z.object({
  display: NavDisplaySettingsSchema.optional(),
  search: NavSearchSettingsSchema.optional(),
  ai: NavAiSettingsSchema.optional(),
})
export type NavBackupSettings = z.infer<typeof NavSettingsGroupSchema>

export const NavImportSchema = z.object({
  categories: z.array(z.object({
    id: navId,
    name: categoryName,
    icon: z.string().max(80).transform(iconValue),
    parentId: navId.nullable(),
    sortOrder: z.number().int().min(0).max(1_000_000),
    createdAt: z.number().int().nonnegative(),
  })).max(1000),
  links: z.array(z.object({
    id: navId,
    title: linkTitle,
    url: linkUrl,
    icon: iconUrl,
    description,
    categoryId: navId,
    pinned: z.boolean(),
    pinnedOrder: z.number().int().min(0),
    sortOrder: z.number().int().min(0),
    createdAt: z.number().int().nonnegative(),
  })).max(NAV_LIMITS.importLinksPerRequest),
  skipExisting: z.boolean().optional(),
})

const backupCategory = z.object({
  id: navId,
  name: categoryName,
  icon: z.string().max(80).transform(iconValue),
  parentId: navId.nullable(),
  sortOrder: z.number().int().min(0).max(1_000_000),
  createdAt: z.number().int().nonnegative(),
  hasPassword: z.boolean().optional(),
  passwordMode: z.enum(['none', 'custom', 'default']).optional(),
})
const backupLink = z.object({
  id: navId,
  title: linkTitle,
  url: linkUrl,
  icon: iconUrl,
  description,
  categoryId: navId,
  pinned: z.boolean(),
  pinnedOrder: z.number().int().min(0),
  sortOrder: z.number().int().min(0),
  createdAt: z.number().int().nonnegative(),
})
const backupVisit = z.object({ lastVisitedAt: z.number().int().nonnegative(), visitCount: z.number().int().nonnegative() })

export const NavBackupScheduleSchema = z.enum(['off', 'hourly', 'sixHourly', 'daily', 'weekly'])

export const NavBackupConfigSchema = z.object({
  url: z.string().trim().max(NAV_LIMITS.url).optional(),
  username: z.string().trim().max(200).optional(),
  password: z.string().max(512).optional(),
  clearPassword: z.boolean().optional(),
  schedule: NavBackupScheduleSchema.optional(),
  retention: z.number().int().min(0).max(3650).optional(),
})

export const NavBackupStateSchema = z.object({
  schedule: NavBackupScheduleSchema.default('off'),
  retention: z.number().int().min(0).max(3650).default(0),
  lastRunAt: z.number().int().nonnegative().nullable().default(null),
  lastStatus: z.enum(['success', 'failed']).nullable().default(null),
  lastError: z.string().max(500).nullable().default(null),
  lastFilename: z.string().max(200).nullable().default(null),
  history: z.array(z.string().max(200)).max(400).default([]),
})

export function parseNavBackupState(raw: unknown): NavBackupState {
  const parsed = NavBackupStateSchema.safeParse(raw ?? {})
  return parsed.success ? parsed.data : { ...DEFAULT_NAV_BACKUP_STATE }
}

export const NavBackupSchema = z.object({
  format: z.literal('inkstone-nav-backup'),
  version: z.literal(1),
  createdAt: z.number().int().nonnegative().optional(),
  categories: z.array(backupCategory).max(5000),
  links: z.array(backupLink).max(NAV_LIMITS.importMaxLinks),
  visits: z.record(z.string(), backupVisit).optional(),
  settings: NavSettingsGroupSchema.partial().optional(),
}).superRefine((backup, ctx) => {
  const categoryIds = new Set(backup.categories.map((category) => category.id))
  if (categoryIds.size !== backup.categories.length) {
    ctx.addIssue({ code: 'custom', path: ['categories'], message: 'Duplicate category id' })
  }
  const parentOf = new Map(backup.categories.map((category) => [category.id, category.parentId]))
  backup.categories.forEach((category, index) => {
    if (category.parentId === null) return
    if (!parentOf.has(category.parentId)) {
      ctx.addIssue({ code: 'custom', path: ['categories', index, 'parentId'], message: 'Unknown parent category' })
      return
    }
    if (parentOf.get(category.parentId) !== null) {
      ctx.addIssue({ code: 'custom', path: ['categories', index, 'parentId'], message: 'Categories nest only one level' })
    }
  })
  const linkIds = new Set(backup.links.map((link) => link.id))
  if (linkIds.size !== backup.links.length) {
    ctx.addIssue({ code: 'custom', path: ['links'], message: 'Duplicate link id' })
  }
  backup.links.forEach((link, index) => {
    if (!categoryIds.has(link.categoryId)) {
      ctx.addIssue({ code: 'custom', path: ['links', index, 'categoryId'], message: 'Unknown category for link' })
    }
  })
})

export const NavIconCaptureSchema = z.object({ url: z.string().trim().min(1).max(NAV_LIMITS.url) })
export const NavFaviconSchema = z.object({
  domain: z.string().trim().min(1).max(253).regex(/^[a-z0-9.-]+$/i),
  icon: z.string().trim().min(1).max(NAV_LIMITS.url).refine(isSafeIconValue, 'unsupported icon'),
})

export function parseDisplaySettings(raw: unknown): typeof DEFAULT_NAV_DISPLAY {
  const parsed = NavDisplaySettingsSchema.safeParse(raw ?? {})
  return parsed.success ? parsed.data : { ...DEFAULT_NAV_DISPLAY }
}

export function parseSearchSettings(raw: unknown): NavSearchSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_NAV_SEARCH, sources: [...DEFAULT_NAV_SEARCH.sources] }
  const source = raw as { mode?: unknown; sources?: unknown; selectedSourceId?: unknown }
  const mode = source.mode === 'external' ? 'external' : 'internal'
  const list = Array.isArray(source.sources) ? source.sources : DEFAULT_NAV_SEARCH.sources
  const sources = list.map((item) => normalizeSearchSource(item as Record<string, unknown>)).filter((item): item is NonNullable<typeof item> => Boolean(item))
  const selectedSourceId = typeof source.selectedSourceId === 'string' && sources.some((item) => item.id === source.selectedSourceId) ? source.selectedSourceId : null
  return { mode, sources: sources.length ? sources : [...DEFAULT_NAV_SEARCH.sources], selectedSourceId }
}

export function parseAiSettings(raw: unknown): typeof DEFAULT_NAV_AI {
  const parsed = NavAiSettingsSchema.safeParse(raw ?? {})
  return parsed.success ? parsed.data : { ...DEFAULT_NAV_AI }
}
