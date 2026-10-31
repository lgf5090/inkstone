import { ApiError } from '../lib/errors'
import { NavStore } from '../nav/store'
import type { NavCategoryRow } from '../nav/access'
import { guardedFetch, readGuardedBytes } from '../nav/safe-fetch'
import { normalizeLinkUrl, type NavCardStyle, type NavCategoryKind, type NavSearchMode } from '@shared/nav/model'

/**
 * Friend links are nav links, not a second table: the blog projects the `friends` category subtree
 * and public applications land in the `friend_applications` subtree, where the nav app can review
 * them with the same editor and categories as any other bookmark.
 */
const MIGRATED_KEY = 'blog.friends.migrated'
const FRIEND_NAME = 'Friends'
const APPLICATION_NAME = 'Friend requests'
const FRIEND_ICON = 'link'
const APPLICATION_ICON = 'inbox'
const MAX_APPLICATIONS = 500

export interface FriendConfig {
  friends: { id: string; name: string }
  applications: { id: string; name: string; pending: number }
}

export interface PublicFriendCategory {
  id: string
  name: string
  icon: string
  parentId: string | null
  depth: number
  count: number
}

export interface PublicFriendLink {
  id: string
  title: string
  url: string
  icon: string | null
  description: string
  categoryId: string
  pinned: boolean
}

export interface PublicFriendSearchSource {
  id: string
  name: string
  url: string
}

export interface PublicFriends {
  rootId: string
  categories: PublicFriendCategory[]
  links: PublicFriendLink[]
  cardStyle: NavCardStyle
  search: {
    mode: NavSearchMode
    sources: PublicFriendSearchSource[]
  }
}

async function setting(db: D1Database, userId: string, key: string): Promise<string> {
  const row = await db
    .prepare('SELECT value FROM nav_settings WHERE user_id = ?1 AND key = ?2')
    .bind(userId, key)
    .first<{ value: string }>()
  return row?.value ?? ''
}

async function saveSetting(db: D1Database, userId: string, key: string, value: string): Promise<void> {
  await db
    .prepare(`INSERT INTO nav_settings (user_id, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(userId, key, value, Date.now())
    .run()
}

async function createReservedCategory(
  store: NavStore,
  kind: Extract<NavCategoryKind, 'friends' | 'friend_applications'>,
  name: string,
  icon: string,
): Promise<NavCategoryRow> {
  const created = await store.createCategory({
    name,
    icon,
    parentId: null,
    passwordHash: null,
    useDefaultPassword: false,
    kind,
  })
  const row = await store.category(created.id)
  if (!row) throw new Error('friend_category_missing')
  return row
}

function categoryKind(row: NavCategoryRow): NavCategoryKind {
  return row.kind === 'friends' || row.kind === 'friend_applications' ? row.kind : 'normal'
}

function subtree(root: NavCategoryRow, rows: readonly NavCategoryRow[]): NavCategoryRow[] {
  // nav categories are one level deep (root + children); keep the walk explicit so a future
  // deeper category cannot silently fall out of the public projection.
  const out = [root]
  for (const row of rows) {
    if (row.parent_id === root.id) out.push(row)
  }
  return out
}

async function ensureCategories(db: D1Database, userId: string): Promise<{ store: NavStore; friends: NavCategoryRow; applications: NavCategoryRow }> {
  const store = new NavStore(db, userId)
  let rows = await store.categoryRows()
  let friends = rows.find((row) => categoryKind(row) === 'friends') ?? null
  if (!friends) friends = await createReservedCategory(store, 'friends', FRIEND_NAME, FRIEND_ICON)
  rows = await store.categoryRows()
  let applications = rows.find((row) => categoryKind(row) === 'friend_applications') ?? null
  if (!applications) applications = await createReservedCategory(store, 'friend_applications', APPLICATION_NAME, APPLICATION_ICON)
  return { store, friends, applications }
}

async function migrateLegacyFriends(db: D1Database, userId: string, store: NavStore, friends: NavCategoryRow): Promise<void> {
  if (await setting(db, userId, MIGRATED_KEY)) return
  const table = await db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'blog_friends'`)
    .first<{ present: number }>()
  if (table) {
    const { results } = await db
      .prepare('SELECT name, url, avatar_asset_id, description FROM blog_friends WHERE user_id = ?1 AND enabled = 1 ORDER BY position, name')
      .bind(userId)
      .all<{ name: string; url: string; avatar_asset_id: string | null; description: string | null }>()
    const existing = new Set((await store.links()).map((link) => link.url))
    for (const row of results) {
      const url = normalizeLinkUrl(row.url ?? '')
      if (!url || existing.has(url)) continue
      const title = String(row.name ?? '').trim().slice(0, 200)
      if (!title) continue
      const icon = row.avatar_asset_id ? `/api/blog/assets/${row.avatar_asset_id}` : null
      await store.createLink({
        title,
        url,
        icon,
        description: String(row.description ?? '').slice(0, 500) || null,
        categoryId: friends.id,
        pinned: false,
      })
      existing.add(url)
    }
  }
  await saveSetting(db, userId, MIGRATED_KEY, '1')
}

export async function ensureFriendConfig(db: D1Database, userId: string): Promise<{ store: NavStore; friends: NavCategoryRow; applications: NavCategoryRow }> {
  const config = await ensureCategories(db, userId)
  await migrateLegacyFriends(db, userId, config.store, config.friends)
  return config
}

function publicIcon(icon: string | null): string | null {
  if (!icon) return null
  if (/^https?:\/\//i.test(icon)) return icon
  if (/^\/api\/blog\/assets\/[A-Za-z0-9_-]+$/.test(icon)) return icon
  return null
}

export async function listPublicFriends(db: D1Database, userId: string): Promise<PublicFriends> {
  const { store, friends } = await ensureFriendConfig(db, userId)
  const [rows, display, search] = await Promise.all([
    store.categoryRows(),
    store.settingsGroup('display'),
    store.settingsGroup('search'),
  ])
  const included = subtree(friends, rows).filter((row) => !row.password_hash && !row.use_default_password)
  const includedIds = new Set(included.map((row) => row.id))
  const links = (await store.links())
    .filter((link) => includedIds.has(link.categoryId))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if (a.pinned && b.pinned) return a.pinnedOrder - b.pinnedOrder
      return a.sortOrder - b.sortOrder || a.createdAt - b.createdAt
    })
  const counts = new Map<string, number>()
  for (const link of links) counts.set(link.categoryId, (counts.get(link.categoryId) ?? 0) + 1)
  const categories = included.map((row) => ({
    id: row.id,
    name: row.name,
    icon: row.icon,
    parentId: row.parent_id,
    depth: row.id === friends.id ? 0 : 1,
    count: counts.get(row.id) ?? 0,
  }))
  return {
    rootId: friends.id,
    categories,
    links: links.map((link) => ({
      id: link.id,
      title: link.title,
      url: link.url,
      icon: publicIcon(link.icon),
      description: link.description ?? '',
      categoryId: link.categoryId,
      pinned: link.pinned,
    })),
    cardStyle: display.cardStyle,
    search: {
      mode: search.mode,
      sources: search.sources
        .filter((source) => source.enabled && /^https?:\/\//i.test(source.url) && source.url.includes('{query}'))
        .map((source) => ({ id: source.id, name: source.name, url: source.url })),
    },
  }
}

export async function friendAdminConfig(db: D1Database, userId: string): Promise<FriendConfig> {
  const { store, friends, applications } = await ensureFriendConfig(db, userId)
  const rows = await store.categoryRows()
  const applicationIds = new Set(subtree(applications, rows).map((row) => row.id))
  const pending = (await store.links()).filter((link) => applicationIds.has(link.categoryId)).length
  return {
    friends: { id: friends.id, name: friends.name },
    applications: { id: applications.id, name: applications.name, pending },
  }
}

export interface FriendApplicationInput {
  title?: unknown
  url?: unknown
  description?: unknown
  icon?: unknown
}

const ICON_TAG = /<link\b[^>]*>/gi
const ICON_REL = /\brel\s*=\s*["']?([^"'>]+)/i
const ICON_HREF = /\bhref\s*=\s*["']([^"']+)["']/i

export function parseFriendIconHtml(html: string, baseUrl: string): string {
  const base = new URL(baseUrl)
  for (const tag of html.match(ICON_TAG) ?? []) {
    const rel = ICON_REL.exec(tag)?.[1] ?? ''
    const href = ICON_HREF.exec(tag)?.[1] ?? ''
    if (!href || !/icon/i.test(rel)) continue
    try {
      const icon = new URL(href, base)
      if (icon.protocol === 'http:' || icon.protocol === 'https:') return icon.toString()
    } catch {
      // A malformed link must not hide the next candidate.
    }
  }
  return new URL('/favicon.ico', base).toString()
}

/** Reads the public site's icon link without storing it; only the returned URL is kept. */
export async function resolveFriendIcon(raw: string): Promise<string> {
  const url = normalizeLinkUrl(raw)
  if (!url || !/^https?:\/\//i.test(url)) throw ApiError.badRequest('Enter a valid http(s) address')
  const result = await guardedFetch(url, { timeoutMs: 6000, maxRedirects: 3, headers: { Accept: 'text/html,application/xhtml+xml' } })
  if (result.error || !result.response.ok) throw ApiError.badRequest('The site did not return a readable page')
  const type = result.response.headers.get('content-type') ?? ''
  if (/^image\//i.test(type)) return result.finalUrl
  const bytes = await readGuardedBytes(result.response, 256 * 1024, 6000)
  if (!bytes) throw ApiError.badRequest('The site did not return a readable page')
  return parseFriendIconHtml(new TextDecoder().decode(bytes), result.finalUrl)
}

export async function applyFriend(db: D1Database, userId: string, input: FriendApplicationInput): Promise<{ duplicate: boolean }> {
  const { store, friends, applications } = await ensureFriendConfig(db, userId)
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 200) : ''
  const rawUrl = typeof input.url === 'string' ? input.url.trim().slice(0, 2048) : ''
  const url = normalizeLinkUrl(rawUrl)
  if (!title) throw ApiError.badRequest('Enter the site name')
  if (!url || !/^https?:\/\//i.test(url)) throw ApiError.badRequest('Enter a valid http(s) address')
  const description = typeof input.description === 'string' ? input.description.trim().slice(0, 500) : ''
  const rawIcon = typeof input.icon === 'string' ? input.icon.trim().slice(0, 2048) : ''
  const icon = rawIcon && (/^https?:\/\//i.test(rawIcon) || /^\/api\/blog\/assets\/[A-Za-z0-9_-]+$/.test(rawIcon)) ? rawIcon : null
  const rows = await store.categoryRows()
  const targets = new Set([...subtree(friends, rows), ...subtree(applications, rows)].map((row) => row.id))
  const links = (await store.links()).filter((link) => targets.has(link.categoryId))
  if (links.some((link) => link.url === url)) return { duplicate: true }
  const pending = links.filter((link) => !subtree(friends, rows).some((row) => row.id === link.categoryId)).length
  if (pending >= MAX_APPLICATIONS) throw new ApiError(429, 'too_many_attempts', 'Too many pending friend applications')
  await store.createLink({
    title,
    url,
    icon,
    description: description || null,
    categoryId: applications.id,
    pinned: false,
  })
  return { duplicate: false }
}
