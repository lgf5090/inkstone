import type { CatalogTemplateType, TemplateItem } from '../../api/store'
import type { CloudflareMessageKey } from '../../i18n'

export type StoreSort = 'name' | 'newest' | 'version'
export type StoreCategory = CatalogTemplateType
export type DeployChoice = 'worker' | 'pages' | 'both'

const NAME_LIMIT = 63

export interface CategoryCounts {
  all: number
  worker: number
  pages: number
  hybrid: number
}

export interface TemplateFilter {
  search: string
  type: StoreCategory | null
  tags: readonly string[]
  favoriteIds: readonly string[]
  favoritesOnly: boolean
}

/** A template id is only unique inside its source, so the two halves are one key. */
export function templateKey(item: TemplateItem): string {
  return `${item.sourceId}::${item.template.id}`
}

export function categoryCounts(templates: readonly TemplateItem[]): CategoryCounts {
  const counts: CategoryCounts = { all: templates.length, worker: 0, pages: 0, hybrid: 0 }
  for (const item of templates) {
    const type = item.template.type
    if (type === 'worker' || type === 'pages' || type === 'hybrid') counts[type] += 1
  }
  return counts
}

export function collectTags(templates: readonly TemplateItem[]): string[] {
  const tags = new Set<string>()
  for (const item of templates) {
    for (const tag of item.template.tags ?? []) tags.add(tag)
  }
  return [...tags].sort((left, right) => left.localeCompare(right))
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.replace(/^v/i, '').split('.')
  const rightParts = right.replace(/^v/i, '').split('.')
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (Number.parseInt(leftParts[index] ?? '0', 10) || 0)
      - (Number.parseInt(rightParts[index] ?? '0', 10) || 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** A template matches when it carries any one of the selected tags. */
export function filterTemplates(
  templates: readonly TemplateItem[],
  filter: TemplateFilter,
): TemplateItem[] {
  const needle = filter.search.trim().toLowerCase()
  const selectedTags = filter.tags
  const favorites = new Set(filter.favoriteIds)
  return templates.filter((item) => {
    const template = item.template
    if (needle) {
      const matches = template.name.toLowerCase().includes(needle)
        || (template.description ?? '').toLowerCase().includes(needle)
        || (template.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
      if (!matches) return false
    }
    if (filter.type && template.type !== filter.type) return false
    if (selectedTags.length > 0 && !(template.tags ?? []).some((tag) => selectedTags.includes(tag))) {
      return false
    }
    if (filter.favoritesOnly && !favorites.has(templateKey(item))) return false
    return true
  })
}

/**
 * Favourites lead every order; the chosen order then applies inside each group.
 * `newest` keeps the catalogue order the server answered with.
 */
export function sortTemplates(
  templates: readonly TemplateItem[],
  sort: StoreSort,
  favoriteIds: readonly string[],
): TemplateItem[] {
  const favorites = new Set(favoriteIds)
  return [...templates].sort((left, right) => {
    const favoriteOrder = Number(favorites.has(templateKey(right)))
      - Number(favorites.has(templateKey(left)))
    if (favoriteOrder !== 0) return favoriteOrder
    if (sort === 'name') return left.template.name.localeCompare(right.template.name)
    if (sort === 'version') return compareVersions(right.template.version, left.template.version)
    return 0
  })
}

/**
 * A hybrid template deploys both halves unless one is chosen; the server already defaults to
 * `both`, so the parameter is omitted in that case. Fixed types have nothing to resolve.
 */
export function resolveDeployType(
  type: CatalogTemplateType,
  choice: DeployChoice,
): 'worker' | 'pages' | undefined {
  if (type !== 'hybrid' || choice === 'both') return undefined
  return choice
}

export function defaultDeployName(templateId: string): string {
  const slug = templateId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_LIMIT)
  return slug || 'template'
}

export function autoResourceName(templateId: string, bindingName: string): string {
  const slug = `${templateId}-${bindingName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_LIMIT)
  return slug || 'resource'
}

export function templateTypeLabelKey(type: CatalogTemplateType): CloudflareMessageKey {
  if (type === 'worker') return 'cloudflare.workers.worker'
  if (type === 'pages') return 'cloudflare.workers.pages'
  return 'cloudflare.store_deploy.both'
}
