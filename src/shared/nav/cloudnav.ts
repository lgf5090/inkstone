import { NAV_ICON_NAME_SET } from './icon-catalog'
import {
  NAV_LIMITS,
  isSafeIconValue,
  newNavId,
  normalizeCategoryName,
  normalizeLinkUrl,
  type NavImportCategory,
  type NavImportLink,
} from './model'

export interface CloudNavStats {
  sourceCategories: number
  sourceLinks: number
  categories: number
  links: number
  skippedCategories: number
  skippedLinks: number
  invalidUrls: number
  repairedUrls: number
  duplicateLinkIds: number
  duplicateUrls: number
  orphanCategories: number
  orphanLinks: number
  flattenedCategories: number
  passwordsSkipped: number
  iconFallbacks: number
  uncategorizedLinks: number
}

export interface CloudNavParseResult {
  categories: NavImportCategory[]
  links: NavImportLink[]
  stats: CloudNavStats
}

interface ParseOptions {
  newId?: () => string
  uncategorizedName?: string
  now?: number
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function timestampOf(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return Math.round(value < 1e12 ? value * 1000 : value)
}

function orderOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function kebabIcon(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

export function cloudNavIcon(value: unknown, stats?: Pick<CloudNavStats, 'iconFallbacks'>): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return 'folder'
  if (/[^\x00-\x7F]/.test(raw)) return raw
  const name = kebabIcon(raw)
  const mapped = name === 'github' ? 'git-branch' : name
  if (NAV_ICON_NAME_SET.has(mapped)) return mapped
  if (stats) stats.iconFallbacks += 1
  return 'folder'
}

export function parseCloudNavBackup(raw: unknown, options: ParseOptions = {}): CloudNavParseResult {
  const source = recordOf(raw)
  const sourceCategories = source?.categories
  const sourceLinks = source?.links
  if (!Array.isArray(sourceCategories) || !Array.isArray(sourceLinks)) {
    throw new Error('Not a CloudNav backup')
  }
  const nextId = options.newId ?? newNavId
  const uncategorizedName = options.uncategorizedName ?? 'Uncategorized'
  const now = options.now ?? Date.now()
  const stats: CloudNavStats = {
    sourceCategories: sourceCategories.length,
    sourceLinks: sourceLinks.length,
    categories: 0,
    links: 0,
    skippedCategories: 0,
    skippedLinks: 0,
    invalidUrls: 0,
    repairedUrls: 0,
    duplicateLinkIds: 0,
    duplicateUrls: 0,
    orphanCategories: 0,
    orphanLinks: 0,
    flattenedCategories: 0,
    passwordsSkipped: 0,
    iconFallbacks: 0,
    uncategorizedLinks: 0,
  }
  const categories: NavImportCategory[] = []
  const parentIds = new Map<string, string | null>()
  const categoryMap = new Map<string, string>()
  const categoryLimit = 1000
  for (const entry of sourceCategories) {
    if (categories.length >= categoryLimit) {
      stats.skippedCategories += 1
      continue
    }
    const record = recordOf(entry)
    const oldId = textOf(record?.id)
    const name = normalizeCategoryName(textOf(record?.name)).slice(0, NAV_LIMITS.categoryName)
    if (!record || !oldId || !name || categoryMap.has(oldId)) {
      stats.skippedCategories += 1
      continue
    }
    const id = nextId()
    categoryMap.set(oldId, id)
    const parentId = textOf(record.parentId)
    parentIds.set(id, parentId || null)
    if (typeof record.password === 'string' && record.password.trim()) stats.passwordsSkipped += 1
    categories.push({
      id,
      name,
      icon: cloudNavIcon(record.icon, stats),
      parentId: null,
      sortOrder: orderOf(record.sortOrder, categories.filter((item) => item.parentId === null).length),
      createdAt: timestampOf(record.createdAt, now),
    })
  }
  for (const category of categories) {
    const rawParent = parentIds.get(category.id)
    if (!rawParent) continue
    const mapped = categoryMap.get(rawParent)
    if (!mapped) {
      stats.orphanCategories += 1
      continue
    }
    const parent = categories.find((item) => item.id === mapped)
    if (!parent || parent.parentId !== null) {
      stats.flattenedCategories += 1
      continue
    }
    category.parentId = mapped
  }
  let uncategorizedId: string | null = null
  const ensureUncategorized = (): string => {
    if (uncategorizedId) return uncategorizedId
    uncategorizedId = nextId()
    categories.push({
      id: uncategorizedId,
      name: uncategorizedName.slice(0, NAV_LIMITS.categoryName),
      icon: 'folder',
      parentId: null,
      sortOrder: categories.filter((item) => item.parentId === null).length,
      createdAt: now,
    })
    return uncategorizedId
  }
  const links: NavImportLink[] = []
  const linkIds = new Set<string>()
  const urls = new Set<string>()
  for (const entry of sourceLinks) {
    if (links.length >= NAV_LIMITS.importMaxLinks) {
      stats.skippedLinks += 1
      continue
    }
    const record = recordOf(entry)
    const oldId = textOf(record?.id)
    if (!record || !oldId || linkIds.has(oldId)) {
      stats.skippedLinks += 1
      if (oldId && linkIds.has(oldId)) stats.duplicateLinkIds += 1
      continue
    }
    linkIds.add(oldId)
    const rawUrl = textOf(record.url)
    const repaired = /^https?:\/\/\s+(https?:\/\/\S+)$/i.exec(rawUrl)
    if (repaired) stats.repairedUrls += 1
    const url = normalizeLinkUrl(repaired ? repaired[1]! : rawUrl)
    if (!url) {
      stats.invalidUrls += 1
      stats.skippedLinks += 1
      continue
    }
    if (urls.has(url)) stats.duplicateUrls += 1
    urls.add(url)
    const title = (textOf(record.title) || url).slice(0, NAV_LIMITS.title)
    const rawCategory = textOf(record.categoryId)
    const mappedCategory = categoryMap.get(rawCategory)
    if (!mappedCategory) {
      stats.orphanLinks += 1
      stats.uncategorizedLinks += 1
    }
    const icon = typeof record.icon === 'string' && isSafeIconValue(record.icon.trim()) ? record.icon.trim() : null
    const rawDescription = textOf(record.description)
    links.push({
      id: nextId(),
      title,
      url,
      icon: icon || null,
      description: rawDescription ? rawDescription.slice(0, NAV_LIMITS.description) : null,
      categoryId: mappedCategory ?? ensureUncategorized(),
      pinned: record.pinned === true,
      pinnedOrder: orderOf(record.pinnedOrder, 0),
      sortOrder: orderOf(record.sortOrder, links.length),
      createdAt: timestampOf(record.createdAt, now),
    })
  }
  stats.categories = categories.length
  stats.links = links.length
  return { categories, links, stats }
}
