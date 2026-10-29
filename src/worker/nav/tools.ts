import {
  NAV_LIMITS,
  isEmojiIcon,
  isNavId,
  isSafeIconValue,
  normalizeCategoryName,
  normalizeIconName,
  normalizeLinkUrl,
  type NavCategory,
  type NavLink,
  type NavVisit,
} from '@shared/nav/model'
import type { ToolContext } from '../assistant/tools'
import { resolveUnlockedCategoryIds } from './access'
import { NavStore, hiddenCategories, visibleLinks } from './store'

export class NavToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NavToolError'
  }
}

export interface NavToolScope {
  nav: NavStore
  categories: NavCategory[]
  links: NavLink[]
  visits: Record<string, NavVisit>
  hidden: Set<string>
  visible: NavLink[]
  unlocked: Set<string>
}

export async function navToolScope(ctx: ToolContext): Promise<NavToolScope> {
  const nav = new NavStore(ctx.env.DB, ctx.store.userId)
  const [categories, links, visits] = await Promise.all([nav.categories(), nav.links(), nav.visits()])
  const unlocked = ctx.navUnlockTokens?.length
    ? await resolveUnlockedCategoryIds(ctx.env.DB, ctx.store.userId, ctx.navUnlockTokens)
    : new Set<string>()
  const hidden = hiddenCategories(categories, unlocked)
  return { nav, categories, links, visits, hidden, visible: visibleLinks(links, categories, unlocked), unlocked }
}

function categoryName(scope: NavToolScope, id: string): string | null {
  return scope.categories.find((category) => category.id === id)?.name ?? null
}

function isHidden(scope: NavToolScope, id: string): boolean {
  return scope.hidden.has(id)
}

export function navResolveCategory(ref: unknown, scope: NavToolScope): NavCategory {
  const value = typeof ref === 'string' ? ref.trim() : ''
  if (!value) throw new NavToolError('Name a category by id or exact name.')
  const byId = isNavId(value) ? scope.categories.find((category) => category.id === value) : undefined
  const name = normalizeCategoryName(value).toLowerCase()
  const byName = scope.categories.filter((category) => category.name.toLowerCase() === name)
  const category = byId ?? (byName.length === 1 ? byName[0] : undefined)
  if (!category) {
    if (byName.length > 1) throw new NavToolError(`Several categories are named "${value}". Use one of these ids: ${byName.map((item) => `${item.id} (${item.name})`).join(', ')}.`)
    throw new NavToolError(`No category matches "${value}".`)
  }
  if (isHidden(scope, category.id)) throw new NavToolError(`"${category.name}" is protected. Unlock it in the navigation app before reading or changing its links.`)
  return category
}

export function navVisibleLink(ref: unknown, scope: NavToolScope): NavLink {
  const id = typeof ref === 'string' ? ref.trim() : ''
  if (!isNavId(id)) throw new NavToolError('A link is named by its id.')
  const link = scope.visible.find((item) => item.id === id)
  if (link) return link
  const hidden = scope.links.find((item) => item.id === id)
  if (hidden) throw new NavToolError('That link is in a protected category. Unlock it in the navigation app first.')
  throw new NavToolError('Link not found.')
}

function scopeCategoryIds(category: NavCategory, scope: NavToolScope): string[] {
  const children = scope.categories
    .filter((item) => item.parentId === category.id && !isHidden(scope, item.id))
    .map((item) => item.id)
  return [category.id, ...children]
}

function linkView(link: NavLink, scope: NavToolScope): Record<string, unknown> {
  const visit = scope.visits[link.id]
  return {
    id: link.id,
    title: link.title,
    url: link.url,
    description: link.description,
    icon: link.icon,
    categoryId: link.categoryId,
    categoryName: categoryName(scope, link.categoryId),
    pinned: link.pinned,
    sortOrder: link.sortOrder,
    pinnedOrder: link.pinnedOrder,
    visitCount: visit?.visitCount ?? 0,
    lastVisitedAt: visit?.lastVisitedAt ?? null,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  }
}

function categoryView(category: NavCategory, scope: NavToolScope): Record<string, unknown> {
  const hidden = isHidden(scope, category.id)
  return {
    id: category.id,
    name: category.name,
    icon: category.icon,
    parentId: category.parentId,
    parentName: category.parentId ? categoryName(scope, category.parentId) : null,
    sortOrder: category.sortOrder,
    locked: category.hasPassword,
    hidden,
    linkCount: hidden ? null : scope.visible.filter((link) => link.categoryId === category.id).length,
    childCount: scope.categories.filter((item) => item.parentId === category.id).length,
  }
}

export async function navOverview(scope: NavToolScope): Promise<Record<string, unknown>> {
  const pinned = scope.visible.filter((link) => link.pinned)
  const topVisited = scope.visible
    .map((link) => ({ ...linkView(link, scope), visitCount: scope.visits[link.id]?.visitCount ?? 0 }))
    .filter((link) => Number(link.visitCount) > 0)
    .sort((left, right) => Number(right.visitCount) - Number(left.visitCount))
    .slice(0, 10)
  return {
    categories: scope.categories.map((category) => categoryView(category, scope)),
    linksVisible: scope.visible.length,
    linksHidden: scope.links.length - scope.visible.length,
    pinnedVisible: pinned.length,
    protectedCategories: scope.categories.filter((category) => category.hasPassword && !scope.unlocked.has(category.id)).length,
    topVisited,
    viewHint: 'Call nav_list_links before changing many links; ids are stable and categories may be nested one level deep.',
  }
}

export async function navListLinks(args: Record<string, unknown>, scope: NavToolScope): Promise<Record<string, unknown>> {
  const categoryRef = typeof args.categoryId === 'string' ? args.categoryId : typeof args.categoryName === 'string' ? args.categoryName : ''
  let categoryIds: Set<string> | null = null
  if (categoryRef) {
    const category = navResolveCategory(categoryRef, scope)
    categoryIds = new Set(scopeCategoryIds(category, scope))
  }
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
  const pinned = typeof args.pinned === 'boolean' ? args.pinned : null
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 50
  const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.min(100000, Math.trunc(args.offset))) : 0
  const matches = scope.visible.filter((link) => {
    if (categoryIds && !categoryIds.has(link.categoryId)) return false
    if (pinned !== null && link.pinned !== pinned) return false
    if (!query) return true
    return link.title.toLowerCase().includes(query)
      || (link.description ?? '').toLowerCase().includes(query)
      || link.url.toLowerCase().includes(query)
  })
  const sorted = pinned === true
    ? matches.sort((left, right) => left.pinnedOrder - right.pinnedOrder || left.title.localeCompare(right.title, 'zh-CN'))
    : matches.sort((left, right) => left.sortOrder - right.sortOrder || left.title.localeCompare(right.title, 'zh-CN'))
  return {
    total: sorted.length,
    offset,
    returned: Math.min(Math.max(0, sorted.length - offset), limit),
    nextOffset: offset + limit < sorted.length ? offset + limit : null,
    links: sorted.slice(offset, offset + limit).map((link) => linkView(link, scope)),
  }
}

export async function navGetLink(args: Record<string, unknown>, scope: NavToolScope): Promise<Record<string, unknown>> {
  return { link: linkView(navVisibleLink(args.id, scope), scope) }
}

export async function navFindDuplicates(scope: NavToolScope): Promise<Record<string, unknown>> {
  const groups = new Map<string, NavLink[]>()
  for (const link of scope.visible) {
    const group = groups.get(link.url) ?? []
    group.push(link)
    groups.set(link.url, group)
  }
  const duplicates = [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([url, group]) => ({
      url,
      links: group.map((link) => ({
        id: link.id,
        title: link.title,
        categoryId: link.categoryId,
        categoryName: categoryName(scope, link.categoryId),
        pinned: link.pinned,
      })),
    }))
  return { groups: duplicates, groupCount: duplicates.length, linkCount: duplicates.reduce((sum, group) => sum + group.links.length, 0) }
}

export async function navCreateLink(args: Record<string, unknown>, scope: NavToolScope): Promise<Record<string, unknown>> {
  const title = typeof args.title === 'string' ? args.title.trim().slice(0, NAV_LIMITS.title) : ''
  if (!title) throw new NavToolError('A link needs a title.')
  const url = normalizeLinkUrl(typeof args.url === 'string' ? args.url : '')
  if (!url) throw new NavToolError('A link needs a valid http(s), mailto: or tel: URL.')
  const category = navResolveCategory(args.categoryId ?? args.categoryName, scope)
  const icon = typeof args.icon === 'string' && args.icon.trim() && isSafeIconValue(args.icon.trim()) ? args.icon.trim() : null
  const description = typeof args.description === 'string' ? args.description.trim().slice(0, NAV_LIMITS.description) || null : null
  const link = await scope.nav.createLink({
    title,
    url,
    icon,
    description,
    categoryId: category.id,
    pinned: args.pinned === true,
  })
  return { link: linkView(link, scope) }
}

export async function navUpdateLink(args: Record<string, unknown>, scope: NavToolScope): Promise<Record<string, unknown>> {
  const link = navVisibleLink(args.id, scope)
  const patch: {
    title?: string
    url?: string
    icon?: string | null
    description?: string | null
    categoryId?: string
    pinned?: boolean
  } = {}
  if (typeof args.title === 'string') {
    const title = args.title.trim().slice(0, NAV_LIMITS.title)
    if (!title) throw new NavToolError('A link title cannot be empty.')
    patch.title = title
  }
  if (typeof args.url === 'string') {
    const url = normalizeLinkUrl(args.url)
    if (!url) throw new NavToolError('The new URL is not supported.')
    patch.url = url
  }
  if (args.categoryId !== undefined || args.categoryName !== undefined) {
    patch.categoryId = navResolveCategory(args.categoryId ?? args.categoryName, scope).id
  }
  if (args.icon !== undefined) {
    patch.icon = typeof args.icon === 'string' && args.icon.trim() && isSafeIconValue(args.icon.trim()) ? args.icon.trim() : null
  }
  if (args.description !== undefined) {
    patch.description = typeof args.description === 'string' ? args.description.trim().slice(0, NAV_LIMITS.description) || null : null
  }
  if (typeof args.pinned === 'boolean') patch.pinned = args.pinned
  if (!Object.keys(patch).length) throw new NavToolError('Nothing to change.')
  const updated = await scope.nav.updateLink(link.id, patch)
  return { link: linkView(updated, scope) }
}

export async function navMoveLinks(args: Record<string, unknown>, scope: NavToolScope): Promise<Record<string, unknown>> {
  const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === 'string') : []
  if (!ids.length || ids.length > 100) throw new NavToolError('Name between 1 and 100 link ids.')
  ids.forEach((id) => navVisibleLink(id, scope))
  const category = navResolveCategory(args.categoryId ?? args.categoryName, scope)
  const result = await scope.nav.moveLinks(ids, category.id)
  return { moved: result.moved, failed: result.failed, categoryId: category.id, categoryName: category.name }
}

export function navLinkTargets(args: Record<string, unknown>, scope: NavToolScope): NavLink[] {
  const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === 'string') : []
  if (!ids.length || ids.length > 100) throw new NavToolError('Name between 1 and 100 link ids.')
  return ids.map((id) => navVisibleLink(id, scope))
}

export function navCategoryTarget(args: Record<string, unknown>, scope: NavToolScope): { category: NavCategory; fallback: NavCategory } {
  const category = navResolveCategory(args.id ?? args.categoryId ?? args.categoryName, scope)
  const fallback = navResolveCategory(args.fallbackId ?? args.fallbackName, scope)
  if (fallback.id === category.id || fallback.parentId === category.id) {
    throw new NavToolError('The fallback category must be outside the category being deleted.')
  }
  const childIds = scope.categories.filter((item) => item.parentId === category.id).map((item) => item.id)
  if (childIds.some((id) => isHidden(scope, id))) {
    throw new NavToolError('That category contains a protected child category. Unlock it first.')
  }
  return { category, fallback }
}

export async function navDeleteLinks(args: Record<string, unknown>, scope: NavToolScope): Promise<Record<string, unknown>> {
  const links = navLinkTargets(args, scope)
  const result = await scope.nav.deleteLinks(links.map((link) => link.id))
  return { deleted: result.deleted, failed: result.failed }
}

export async function navCreateCategory(args: Record<string, unknown>, scope: NavToolScope): Promise<Record<string, unknown>> {
  const name = typeof args.name === 'string' ? normalizeCategoryName(args.name).slice(0, NAV_LIMITS.categoryName) : ''
  if (!name) throw new NavToolError('A category needs a name.')
  const parentRef = args.parentId ?? args.parentName
  const parent = parentRef === undefined || parentRef === null || parentRef === '' ? null : navResolveCategory(parentRef, scope)
  const rawIcon = typeof args.icon === 'string' ? args.icon.trim() : ''
  const icon = rawIcon && isEmojiIcon(rawIcon) ? rawIcon : normalizeIconName(rawIcon)
  const category = await scope.nav.createCategory({
    name,
    icon,
    parentId: parent?.id ?? null,
    passwordHash: null,
    useDefaultPassword: false,
  })
  return { category: categoryView(category, scope) }
}

export async function navUpdateCategory(args: Record<string, unknown>, scope: NavToolScope): Promise<Record<string, unknown>> {
  const category = navResolveCategory(args.id ?? args.categoryId ?? args.categoryName, scope)
  const patch: { name?: string; icon?: string } = {}
  if (typeof args.name === 'string') {
    const name = normalizeCategoryName(args.name).slice(0, NAV_LIMITS.categoryName)
    if (!name) throw new NavToolError('A category name cannot be empty.')
    patch.name = name
  }
  if (typeof args.icon === 'string') {
    const raw = args.icon.trim()
    patch.icon = raw && isEmojiIcon(raw) ? raw : normalizeIconName(raw)
  }
  if (!Object.keys(patch).length) throw new NavToolError('Only a category name or icon can be changed by the assistant.')
  const updated = await scope.nav.updateCategory(category.id, patch)
  return { category: categoryView(updated, scope) }
}

export async function navDeleteCategory(args: Record<string, unknown>, scope: NavToolScope): Promise<Record<string, unknown>> {
  const { category, fallback } = navCategoryTarget(args, scope)
  await scope.nav.deleteCategory(category.id, fallback.id)
  return { deleted: category.name, fallbackId: fallback.id, fallbackName: fallback.name }
}

export async function navSortLinks(args: Record<string, unknown>, scope: NavToolScope): Promise<Record<string, unknown>> {
  const pinned = args.scope === 'pinned'
  const categoryRef = pinned ? null : args.categoryId ?? args.categoryName
  if (!pinned && (categoryRef === undefined || categoryRef === null || categoryRef === '')) {
    throw new NavToolError('Name the category to sort, or use scope "pinned".')
  }
  const category = categoryRef ? navResolveCategory(categoryRef, scope) : null
  const by = args.by === 'recent' || args.by === 'created' ? args.by : 'title'
  const candidates = scope.visible
    .filter((link) => pinned ? link.pinned : !link.pinned && link.categoryId === category!.id)
    .sort((left, right) => {
      if (by === 'created') return left.createdAt - right.createdAt || left.title.localeCompare(right.title, 'zh-CN')
      if (by === 'recent') {
        const leftVisit = scope.visits[left.id]?.lastVisitedAt ?? 0
        const rightVisit = scope.visits[right.id]?.lastVisitedAt ?? 0
        return rightVisit - leftVisit || left.title.localeCompare(right.title, 'zh-CN')
      }
      return left.title.localeCompare(right.title, 'zh-CN')
    })
  if (!candidates.length) return { ordered: 0 }
  const ids = candidates.map((link) => link.id)
  await scope.nav.reorderLinks(pinned ? 'pinned' : 'category', ids, category?.id, scope.hidden)
  return { ordered: ids.length, scope: pinned ? 'pinned' : 'category', categoryId: category?.id ?? null, by }
}

export async function navRewriteLinks(args: Record<string, unknown>, scope: NavToolScope): Promise<Record<string, unknown>> {
  const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === 'string') : []
  if (!ids.length || ids.length > 100) throw new NavToolError('Name between 1 and 100 link ids.')
  ids.forEach((id) => navVisibleLink(id, scope))
  const template = typeof args.template === 'string' ? args.template.trim() : ''
  if (!template) throw new NavToolError('A rewrite template is required, such as https://new.example.com{path}.')
  const result = await scope.nav.rewriteLinks(ids, template)
  return result
}
