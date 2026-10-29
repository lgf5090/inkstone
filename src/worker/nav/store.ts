import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import {
  normalizeLinkUrl,
  type NavAiSettings,
  type NavBackup,
  type NavBootstrap,
  type NavCategory,
  type NavCounts,
  type NavDisplaySettings,
  type NavImportCategory,
  type NavImportLink,
  type NavLink,
  type NavSearchSettings,
  type NavVisit,
} from '@shared/nav/model'
import { rowToCategory, type NavCategoryRow } from './access'
import { parseAiSettings, parseDisplaySettings, parseSearchSettings } from '@shared/nav/validation'

export interface NavLinkRow {
  id: string
  user_id: string
  title: string
  url: string
  icon: string | null
  description: string | null
  category_id: string
  pinned: number
  pinned_order: number
  sort_order: number
  created_at: number
  updated_at: number
}

export function rowToLink(row: NavLinkRow): NavLink {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    icon: row.icon,
    description: row.description,
    categoryId: row.category_id,
    pinned: Boolean(row.pinned),
    pinnedOrder: row.pinned_order,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface NavCategoryInput {
  id?: string
  name: string
  icon: string
  parentId: string | null
  passwordHash: string | null
  useDefaultPassword: boolean
  sortOrder?: number
}

export interface NavLinkInput {
  id?: string
  title: string
  url: string
  icon: string | null
  description: string | null
  categoryId: string
  pinned: boolean
}

export interface NavLinkPatch {
  title?: string
  url?: string
  icon?: string | null
  description?: string | null
  categoryId?: string
  pinned?: boolean
}

export function hiddenCategories(categories: readonly NavCategory[], unlocked: ReadonlySet<string>): Set<string> {
  const lockedRoots = new Set(categories
    .filter((category) => category.hasPassword && !unlocked.has(category.id))
    .map((category) => category.id))
  const hidden = new Set(lockedRoots)
  for (const category of categories) {
    if (category.parentId && lockedRoots.has(category.parentId)) hidden.add(category.id)
  }
  return hidden
}

export function visibleLinks(links: readonly NavLink[], categories: readonly NavCategory[], unlocked: ReadonlySet<string>): NavLink[] {
  const locked = hiddenCategories(categories, unlocked)
  if (!locked.size) return [...links]
  return links.filter((link) => !locked.has(link.categoryId))
}

export class NavStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  async categoryRows(): Promise<NavCategoryRow[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM nav_categories WHERE user_id = ?1 ORDER BY parent_id IS NOT NULL, sort_order ASC, created_at ASC')
      .bind(this.userId)
      .all<NavCategoryRow>()
    return results
  }

  async categories(): Promise<NavCategory[]> {
    return (await this.categoryRows()).map(rowToCategory)
  }

  async category(id: string): Promise<NavCategoryRow | null> {
    return await this.db
      .prepare('SELECT * FROM nav_categories WHERE user_id = ?1 AND id = ?2')
      .bind(this.userId, id)
      .first<NavCategoryRow>()
  }

  async linkRows(): Promise<NavLinkRow[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM nav_links WHERE user_id = ?1 ORDER BY created_at ASC, id ASC')
      .bind(this.userId)
      .all<NavLinkRow>()
    return results
  }

  async links(): Promise<NavLink[]> {
    return (await this.linkRows()).map(rowToLink)
  }

  async visits(): Promise<Record<string, NavVisit>> {
    const { results } = await this.db
      .prepare('SELECT link_id, last_visited_at, visit_count FROM nav_link_visits WHERE user_id = ?1')
      .bind(this.userId)
      .all<{ link_id: string; last_visited_at: number; visit_count: number }>()
    return Object.fromEntries(results.map((row) => [row.link_id, { lastVisitedAt: row.last_visited_at, visitCount: row.visit_count }]))
  }

  async counts(): Promise<NavCounts> {
    const { results } = await this.db
      .prepare('SELECT category_id, COUNT(*) AS n FROM nav_links WHERE user_id = ?1 GROUP BY category_id')
      .bind(this.userId)
      .all<{ category_id: string; n: number }>()
    const byCategory: Record<string, number> = {}
    let total = 0
    for (const row of results) {
      byCategory[row.category_id] = row.n
      total += row.n
    }
    return { total, byCategory }
  }

  async bootstrap(unlocked: ReadonlySet<string>): Promise<NavBootstrap> {
    const [categoryRows, linkRows, visits, counts, display, search, ai, webdav] = await Promise.all([
      this.categoryRows(),
      this.linkRows(),
      this.visits(),
      this.counts(),
      this.settingsGroup('display'),
      this.settingsGroup('search'),
      this.settingsGroup('ai'),
      this.webdavSettings(),
    ])
    const categories = categoryRows.map(rowToCategory)
    const links = visibleLinks(linkRows.map(rowToLink), categories, unlocked)
    return {
      categories,
      links,
      visits,
      settings: { display, search, ai },
      webdav,
      counts,
      serverTime: Date.now(),
    }
  }

  async settingsGroup(key: 'display'): Promise<NavDisplaySettings>
  async settingsGroup(key: 'search'): Promise<NavSearchSettings>
  async settingsGroup(key: 'ai'): Promise<NavAiSettings>
  async settingsGroup(key: 'display' | 'search' | 'ai'): Promise<NavDisplaySettings | NavSearchSettings | NavAiSettings> {
    const row = await this.db
      .prepare('SELECT value FROM nav_settings WHERE user_id = ?1 AND key = ?2')
      .bind(this.userId, key)
      .first<{ value: string }>()
    const raw = row ? safeJson(row.value) : null
    if (key === 'display') return parseDisplaySettings(raw)
    if (key === 'search') return parseSearchSettings(raw)
    return parseAiSettings(raw)
  }

  async saveSettingsGroup(key: 'display' | 'search' | 'ai', value: unknown): Promise<void> {
    await this.db
      .prepare(`INSERT INTO nav_settings (user_id, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(this.userId, key, JSON.stringify(value), Date.now())
      .run()
  }

  async settings(): Promise<{ display: NavDisplaySettings; search: NavSearchSettings; ai: NavAiSettings }> {
    const [display, search, ai] = await Promise.all([
      this.settingsGroup('display'),
      this.settingsGroup('search'),
      this.settingsGroup('ai'),
    ])
    return { display, search, ai }
  }

  async webdavConfig(): Promise<{ url: string; username: string }> {
    const row = await this.db
      .prepare("SELECT value FROM nav_settings WHERE user_id = ?1 AND key = 'webdav'")
      .bind(this.userId)
      .first<{ value: string }>()
    const raw = row ? safeJson(row.value) : null
    const value = raw && typeof raw === 'object' ? raw as { url?: unknown; username?: unknown } : {}
    return {
      url: typeof value.url === 'string' ? value.url.slice(0, 2048) : '',
      username: typeof value.username === 'string' ? value.username.slice(0, 200) : '',
    }
  }

  async saveWebdavConfig(url: string, username: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO nav_settings (user_id, key, value, updated_at) VALUES (?1, 'webdav', ?2, ?3)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(this.userId, JSON.stringify({ url, username }), Date.now())
      .run()
  }

  async webdavSecret(): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT ciphertext FROM nav_secrets WHERE user_id = ?1 AND key = 'webdav'")
      .bind(this.userId)
      .first<{ ciphertext: string }>()
    return row?.ciphertext ?? null
  }

  async saveWebdavSecret(ciphertext: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO nav_secrets (user_id, key, ciphertext, hint, updated_at) VALUES (?1, 'webdav', ?2, '{}', ?3)
        ON CONFLICT(user_id, key) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`)
      .bind(this.userId, ciphertext, Date.now())
      .run()
  }

  async clearWebdavSecret(): Promise<void> {
    await this.db.prepare("DELETE FROM nav_secrets WHERE user_id = ?1 AND key = 'webdav'").bind(this.userId).run()
  }

  async webdavSettings(): Promise<{ url: string; username: string; hasPassword: boolean }> {
    const [config, secret] = await Promise.all([this.webdavConfig(), this.webdavSecret()])
    return { ...config, hasPassword: Boolean(secret) }
  }

  async createCategory(input: NavCategoryInput): Promise<NavCategory> {
    if (input.parentId) {
      const parent = await this.category(input.parentId)
      if (!parent || parent.parent_id) throw ApiError.badRequest('Parent category not found')
    }
    const id = input.id ?? newId()
    const existing = await this.category(id)
    if (existing) throw ApiError.conflict('Category already exists')
    const sortOrder = input.sortOrder ?? await this.nextCategorySort(input.parentId)
    await this.db
      .prepare(`INSERT INTO nav_categories (id, user_id, name, icon, parent_id, password_hash, use_default_password, sort_order, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
      .bind(id, this.userId, input.name, input.icon, input.parentId, input.passwordHash, input.useDefaultPassword ? 1 : 0, sortOrder, Date.now(), Date.now())
      .run()
    return rowToCategory((await this.category(id))!)
  }

  async nextCategorySort(parentId: string | null): Promise<number> {
    const row = parentId
      ? await this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM nav_categories WHERE user_id = ?1 AND parent_id = ?2').bind(this.userId, parentId).first<{ n: number }>()
      : await this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM nav_categories WHERE user_id = ?1 AND parent_id IS NULL').bind(this.userId).first<{ n: number }>()
    return row?.n ?? 0
  }

  async updateCategory(id: string, patch: { name?: string; icon?: string; passwordHash?: string | null; useDefaultPassword?: boolean; sortOrder?: number }): Promise<NavCategory> {
    const existing = await this.category(id)
    if (!existing) throw ApiError.notFound('Category not found')
    const fields: string[] = []
    const args: unknown[] = []
    const push = (column: string, value: unknown): void => {
      fields.push(`${column} = ?${args.length + 1}`)
      args.push(value)
    }
    if (patch.name !== undefined) push('name', patch.name)
    if (patch.icon !== undefined) push('icon', patch.icon)
    if (patch.passwordHash !== undefined) push('password_hash', patch.passwordHash)
    if (patch.useDefaultPassword !== undefined) push('use_default_password', patch.useDefaultPassword ? 1 : 0)
    if (patch.sortOrder !== undefined) push('sort_order', patch.sortOrder)
    if (fields.length) {
      push('updated_at', Date.now())
      await this.db.prepare(`UPDATE nav_categories SET ${fields.join(', ')} WHERE user_id = ?${args.length + 1} AND id = ?${args.length + 2}`)
        .bind(...args, this.userId, id)
        .run()
    }
    return rowToCategory((await this.category(id))!)
  }

  async deleteCategory(id: string, fallbackCategoryId: string): Promise<void> {
    const existing = await this.category(id)
    if (!existing) throw ApiError.notFound('Category not found')
    const fallback = await this.category(fallbackCategoryId)
    if (!fallback || fallbackCategoryId === id) throw ApiError.badRequest('Fallback category not found')
    const children = (await this.categoryRows()).filter((row) => row.parent_id === id)
    if (children.some((row) => row.id === fallbackCategoryId)) throw ApiError.badRequest('Fallback cannot be a child of the deleted category')
    const ids = new Set([id, ...children.map((row) => row.id)])
    const now = Date.now()
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`UPDATE nav_links SET category_id = ?1, updated_at = ?2 WHERE user_id = ?3 AND category_id IN (${[...ids].map((_, i) => `?${i + 4}`).join(', ')})`)
        .bind(fallbackCategoryId, now, this.userId, ...ids),
      this.db.prepare(`DELETE FROM nav_category_unlocks WHERE user_id = ?1 AND category_id IN (${[...ids].map((_, i) => `?${i + 2}`).join(', ')})`)
        .bind(this.userId, ...ids),
      this.db.prepare('DELETE FROM nav_categories WHERE user_id = ?1 AND id = ?2').bind(this.userId, id),
    ]
    for (const child of children) statements.push(this.db.prepare('DELETE FROM nav_categories WHERE user_id = ?1 AND id = ?2').bind(this.userId, child.id))
    await this.db.batch(statements)
  }

  async reorderCategories(parentId: string | null, orderedIds: readonly string[]): Promise<void> {
    const rows = await this.categoryRows()
    const group = rows.filter((row) => (row.parent_id ?? null) === parentId).map((row) => row.id)
    if (!sameSet(group, orderedIds)) throw ApiError.badRequest('Order must cover every category in this group')
    const statements = orderedIds.map((id, index) =>
      this.db.prepare('UPDATE nav_categories SET sort_order = ?1, updated_at = ?2 WHERE user_id = ?3 AND id = ?4').bind(index, Date.now(), this.userId, id),
    )
    await this.db.batch(statements)
  }

  async createLink(input: NavLinkInput): Promise<NavLink> {
    const category = await this.category(input.categoryId)
    if (!category) throw ApiError.badRequest('Category not found')
    const id = input.id ?? newId()
    if (await this.db.prepare('SELECT 1 FROM nav_links WHERE user_id = ?1 AND id = ?2').bind(this.userId, id).first()) throw ApiError.conflict('Link already exists')
    const sortOrder = await this.nextLinkSort(input.categoryId)
    const pinnedOrder = input.pinned ? await this.nextPinnedOrder() : 0
    const now = Date.now()
    await this.db
      .prepare(`INSERT INTO nav_links (id, user_id, title, url, icon, description, category_id, pinned, pinned_order, sort_order, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`)
      .bind(id, this.userId, input.title, input.url, input.icon, input.description, input.categoryId, input.pinned ? 1 : 0, pinnedOrder, sortOrder, now, now)
      .run()
    return rowToLink((await this.linkRow(id))!)
  }

  async linkRow(id: string): Promise<NavLinkRow | null> {
    return await this.db.prepare('SELECT * FROM nav_links WHERE user_id = ?1 AND id = ?2').bind(this.userId, id).first<NavLinkRow>()
  }

  async nextLinkSort(categoryId: string): Promise<number> {
    const row = await this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM nav_links WHERE user_id = ?1 AND category_id = ?2').bind(this.userId, categoryId).first<{ n: number }>()
    return row?.n ?? 0
  }

  async nextPinnedOrder(): Promise<number> {
    const row = await this.db.prepare('SELECT COALESCE(MAX(pinned_order), -1) + 1 AS n FROM nav_links WHERE user_id = ?1 AND pinned = 1').bind(this.userId).first<{ n: number }>()
    return row?.n ?? 0
  }

  async updateLink(id: string, patch: NavLinkPatch): Promise<NavLink> {
    const existing = await this.linkRow(id)
    if (!existing) throw ApiError.notFound('Link not found')
    const fields: string[] = []
    const args: unknown[] = []
    const push = (column: string, value: unknown): void => {
      fields.push(`${column} = ?${args.length + 1}`)
      args.push(value)
    }
    if (patch.title !== undefined) push('title', patch.title)
    if (patch.url !== undefined) push('url', patch.url)
    if (patch.icon !== undefined) push('icon', patch.icon)
    if (patch.description !== undefined) push('description', patch.description)
    if (patch.categoryId !== undefined && patch.categoryId !== existing.category_id) {
      if (!(await this.category(patch.categoryId))) throw ApiError.badRequest('Category not found')
      push('category_id', patch.categoryId)
      push('sort_order', await this.nextLinkSort(patch.categoryId))
    }
    if (patch.pinned !== undefined) {
      push('pinned', patch.pinned ? 1 : 0)
      if (patch.pinned && existing.pinned === 0) push('pinned_order', await this.nextPinnedOrder())
      else if (!patch.pinned) push('pinned_order', 0)
    }
    if (!fields.length) return rowToLink(existing)
    push('updated_at', Date.now())
    await this.db.prepare(`UPDATE nav_links SET ${fields.join(', ')} WHERE user_id = ?${args.length + 1} AND id = ?${args.length + 2}`)
      .bind(...args, this.userId, id)
      .run()
    return rowToLink((await this.linkRow(id))!)
  }

  async deleteLink(id: string): Promise<void> {
    const existing = await this.linkRow(id)
    if (!existing) throw ApiError.notFound('Link not found')
    await this.db.batch([
      this.db.prepare('DELETE FROM nav_link_visits WHERE user_id = ?1 AND link_id = ?2').bind(this.userId, id),
      this.db.prepare('DELETE FROM nav_links WHERE user_id = ?1 AND id = ?2').bind(this.userId, id),
    ])
  }

  async reorderLinks(scope: 'pinned' | 'category', orderedIds: readonly string[], categoryId?: string, hiddenCategoryIds?: ReadonlySet<string>): Promise<void> {
    const rows = await this.linkRows()
    const group = scope === 'pinned'
      ? rows.filter((row) => row.pinned === 1 && !hiddenCategoryIds?.has(row.category_id)).map((row) => row.id)
      : rows.filter((row) => row.category_id === categoryId && row.pinned === 0).map((row) => row.id)
    if (!sameSet(group, orderedIds)) throw ApiError.badRequest('Order must cover every link in this scope')
    const column = scope === 'pinned' ? 'pinned_order' : 'sort_order'
    const statements = orderedIds.map((id, index) =>
      this.db.prepare(`UPDATE nav_links SET ${column} = ?1, updated_at = ?2 WHERE user_id = ?3 AND id = ?4`).bind(index, Date.now(), this.userId, id),
    )
    await this.db.batch(statements)
  }

  async recordVisits(entries: readonly { linkId: string; count: number }[]): Promise<void> {
    if (!entries.length) return
    const owned = new Set((await this.linkRows()).map((row) => row.id))
    const now = Date.now()
    const statements = entries
      .filter((entry) => owned.has(entry.linkId))
      .map((entry) => this.db
        .prepare(`INSERT INTO nav_link_visits (user_id, link_id, last_visited_at, visit_count) VALUES (?1, ?2, ?3, ?4)
          ON CONFLICT(user_id, link_id) DO UPDATE SET visit_count = visit_count + excluded.visit_count, last_visited_at = MAX(last_visited_at, excluded.last_visited_at)`)
        .bind(this.userId, entry.linkId, now, entry.count))
    if (statements.length) await this.db.batch(statements)
  }

  async deleteLinks(ids: readonly string[]): Promise<{ deleted: number; failed: string[] }> {
    const owned = new Set((await this.linkRows()).map((row) => row.id))
    const valid = ids.filter((id) => owned.has(id))
    for (let index = 0; index < valid.length; index += 100) {
      const chunk = valid.slice(index, index + 100)
      await this.db.batch(chunk.flatMap((id) => [
        this.db.prepare('DELETE FROM nav_link_visits WHERE user_id = ?1 AND link_id = ?2').bind(this.userId, id),
        this.db.prepare('DELETE FROM nav_links WHERE user_id = ?1 AND id = ?2').bind(this.userId, id),
      ]))
    }
    return { deleted: valid.length, failed: ids.filter((id) => !owned.has(id)) }
  }

  async moveLinks(ids: readonly string[], categoryId: string): Promise<{ moved: number; failed: string[] }> {
    if (!(await this.category(categoryId))) throw ApiError.badRequest('Category not found')
    const owned = new Set((await this.linkRows()).map((row) => row.id))
    const valid = ids.filter((id) => owned.has(id))
    if (valid.length) {
      const base = await this.nextLinkSort(categoryId)
      const now = Date.now()
      await this.db.batch(valid.map((id, index) => this.db
        .prepare('UPDATE nav_links SET category_id = ?1, sort_order = ?2, updated_at = ?3 WHERE user_id = ?4 AND id = ?5')
        .bind(categoryId, base + index, now, this.userId, id)))
    }
    return { moved: valid.length, failed: ids.filter((id) => !owned.has(id)) }
  }

  async rewriteLinks(ids: readonly string[], template: string): Promise<{ updated: { id: string; url: string }[]; failed: { id: string; error: string }[] }> {
    const rows = new Map((await this.linkRows()).map((row) => [row.id, row]))
    const updated: { id: string; url: string }[] = []
    const failed: { id: string; error: string }[] = []
    for (const id of ids) {
      const row = rows.get(id)
      if (!row) {
        failed.push({ id, error: 'not_found' })
        continue
      }
      let next = template.trim()
      if (next.includes('{old}')) {
        next = next.split('{old}').join(row.url)
      } else {
        if (next.includes('{old_host}')) {
          try { next = next.split('{old_host}').join(new URL(row.url).host) } catch { failed.push({ id, error: 'invalid_url' }); continue }
        }
        if (next.includes('{path}')) {
          try {
            const url = new URL(row.url)
            next = next.split('{path}').join(url.pathname + url.search + url.hash)
          } catch { failed.push({ id, error: 'invalid_url' }); continue }
        }
      }
      const normalized = normalizeLinkUrl(next)
      if (!normalized) {
        failed.push({ id, error: 'invalid_url' })
        continue
      }
      await this.db.prepare('UPDATE nav_links SET url = ?1, updated_at = ?2 WHERE user_id = ?3 AND id = ?4').bind(normalized, Date.now(), this.userId, id).run()
      updated.push({ id, url: normalized })
    }
    return { updated, failed }
  }

  async importData(categories: readonly NavImportCategory[], links: readonly NavImportLink[], skipExisting: boolean): Promise<{ imported: number; skipped: number }> {
    const existingUrls = skipExisting ? new Set((await this.linkRows()).map((row) => row.url)) : new Set<string>()
    const foreignCategories = await this.idsOwnedByAnotherUser('nav_categories', categories.map((category) => category.id))
    const foreignLinks = await this.idsOwnedByAnotherUser('nav_links', links.map((link) => link.id))
    let skipped = foreignCategories.size + foreignLinks.size
    const now = Date.now()
    const insertableCategories = categories.filter((category) => !foreignCategories.has(category.id))
    for (let index = 0; index < insertableCategories.length; index += 100) {
      const chunk = insertableCategories.slice(index, index + 100)
      await this.db.batch(chunk.map((category) => this.db
        .prepare(`INSERT INTO nav_categories (id, user_id, name, icon, parent_id, password_hash, use_default_password, sort_order, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0, ?6, ?7, ?7)
          ON CONFLICT(user_id, id) DO UPDATE SET name = excluded.name, icon = excluded.icon, parent_id = excluded.parent_id, sort_order = excluded.sort_order, updated_at = excluded.updated_at
          WHERE nav_categories.user_id = excluded.user_id`)
        .bind(category.id, this.userId, category.name, category.icon, category.parentId, category.sortOrder, category.createdAt)))
    }
    const keep = links.filter((link) => {
      if (foreignLinks.has(link.id) || foreignCategories.has(link.categoryId)) {
        skipped += 1
        return false
      }
      if (existingUrls.has(link.url)) {
        skipped += 1
        return false
      }
      existingUrls.add(link.url)
      return true
    })
    for (let index = 0; index < keep.length; index += 100) {
      const chunk = keep.slice(index, index + 100)
      await this.db.batch(chunk.map((link) => this.db
        .prepare(`INSERT INTO nav_links (id, user_id, title, url, icon, description, category_id, pinned, pinned_order, sort_order, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
          ON CONFLICT(user_id, id) DO UPDATE SET title = excluded.title, url = excluded.url, icon = excluded.icon, description = excluded.description, category_id = excluded.category_id, pinned = excluded.pinned, pinned_order = excluded.pinned_order, sort_order = excluded.sort_order, updated_at = excluded.updated_at
          WHERE nav_links.user_id = excluded.user_id`)
        .bind(link.id, this.userId, link.title, link.url, link.icon, link.description, link.categoryId, link.pinned ? 1 : 0, link.pinnedOrder, link.sortOrder, link.createdAt, now)))
    }
    return { imported: keep.length, skipped }
  }

  async idsOwnedByAnotherUser(table: 'nav_categories' | 'nav_links', ids: readonly string[]): Promise<Set<string>> {
    const out = new Set<string>()
    for (let index = 0; index < ids.length; index += 200) {
      const chunk = ids.slice(index, index + 200)
      if (!chunk.length) continue
      const placeholders = chunk.map((_, i) => `?${i + 2}`).join(', ')
      const { results } = await this.db
        .prepare(`SELECT id FROM ${table} WHERE user_id <> ?1 AND id IN (${placeholders})`)
        .bind(this.userId, ...chunk)
        .all<{ id: string }>()
      for (const row of results) out.add(row.id)
    }
    return out
  }

  async restore(backup: NavBackup): Promise<{ restoredLinks: number; restoredCategories: number; restoredVisits: number; unlockedCategories: string[] }> {
    await this.importData(backup.categories, backup.links, false)
    const categoryIds = new Set(backup.categories.map((category) => category.id))
    const linkIds = new Set(backup.links.map((link) => link.id))
    const existingCategories = await this.categoryRows()
    const existingLinks = await this.linkRows()
    const removeCategories = existingCategories.map((row) => row.id).filter((id) => !categoryIds.has(id))
    const removeLinks = existingLinks.map((row) => row.id).filter((id) => !linkIds.has(id))
    for (let index = 0; index < removeLinks.length; index += 100) {
      const chunk = removeLinks.slice(index, index + 100)
      await this.db.batch(chunk.flatMap((id) => [
        this.db.prepare('DELETE FROM nav_link_visits WHERE user_id = ?1 AND link_id = ?2').bind(this.userId, id),
        this.db.prepare('DELETE FROM nav_links WHERE user_id = ?1 AND id = ?2').bind(this.userId, id),
      ]))
    }
    for (let index = 0; index < removeCategories.length; index += 100) {
      const chunk = removeCategories.slice(index, index + 100)
      await this.db.batch(chunk.map((id) => this.db.prepare('DELETE FROM nav_categories WHERE user_id = ?1 AND id = ?2').bind(this.userId, id)))
    }
    const visits = Object.entries(backup.visits ?? {}).filter(([id]) => linkIds.has(id))
    if (visits.length) {
      for (let index = 0; index < visits.length; index += 100) {
        const chunk = visits.slice(index, index + 100)
        await this.db.batch(chunk.map(([linkId, visit]) => this.db
          .prepare(`INSERT INTO nav_link_visits (user_id, link_id, last_visited_at, visit_count) VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(user_id, link_id) DO UPDATE SET visit_count = MAX(visit_count, excluded.visit_count), last_visited_at = MAX(last_visited_at, excluded.last_visited_at)`)
          .bind(this.userId, linkId, visit.lastVisitedAt, visit.visitCount)))
      }
    }
    const unlocked = backup.categories.filter((category) => category.hasPassword).map((category) => category.id)
    return { restoredLinks: backup.links.length, restoredCategories: backup.categories.length, restoredVisits: visits.length, unlockedCategories: unlocked }
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id)) && new Set(b).size === b.length
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value) } catch { return null }
}
