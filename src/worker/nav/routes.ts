import { Hono, type Context } from 'hono'
import type { ZodType } from 'zod'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { requestClientIp } from '../lib/request'
import {
  NavCategoryCreateSchema,
  NavCategoryDeleteSchema,
  NavCategoryPatchSchema,
  NavImportSchema,
  NavLinkCreateSchema,
  NavLinkPatchSchema,
  NavOrderSchema,
  NavUnlockSchema,
  NavVisitsSchema,
  NavBatchSchema,
  NavAiSettingsSchema,
  NavDisplaySettingsSchema,
  NavSearchSettingsSchema,
} from '@shared/nav/validation'
import { normalizeLinkUrl } from '@shared/nav/model'
import { NavStore, hiddenCategories } from './store'
import {
  assertUnlockAllowed,
  clearCategoryUnlocks,
  clearUnlockFailures,
  createCategoryUnlock,
  newCategoryPasswordHash,
  parseUnlockTokens,
  recordUnlockFailure,
  resolveUnlockedCategoryIds,
  verifyCategoryPassword,
} from './access'

export const navDataRoutes = new Hono<AppBindings>()

navDataRoutes.use('*', requireAuth)

function userId(c: Context<AppBindings>): string {
  const id = c.get('userId') ?? c.get('user')?.id
  if (!id) throw ApiError.unauthenticated()
  return id
}

function store(c: Context<AppBindings>): NavStore {
  return new NavStore(c.env.DB, userId(c))
}

async function body<T>(c: Context<AppBindings>, parse: (raw: unknown) => T): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
  return parse(raw)
}

function zod<T>(schema: ZodType<T>) {
  return (raw: unknown): T => {
    const result = schema.safeParse(raw)
    if (!result.success) {
      const issue = result.error.issues[0]
      const path = issue?.path.map(String).join('.') ?? ''
      throw ApiError.badRequest(issue ? `${path}: ${issue.message}` : 'Validation failed')
    }
    return result.data
  }
}

async function unlocked(c: Context<AppBindings>): Promise<Set<string>> {
  return resolveUnlockedCategoryIds(c.env.DB, userId(c), parseUnlockTokens(c.req.header('x-nav-unlocks')))
}

async function passwordFields(
  c: Context<AppBindings>,
  input: { passwordMode?: 'none' | 'custom' | 'default'; password?: string },
): Promise<{ passwordHash: string | null; useDefaultPassword: boolean }> {
  if (input.passwordMode === 'default') {
    if (!c.env.NAV_DEFAULT_CATEGORY_PASSWORD) {
      throw new ApiError(400, 'nav_default_password_not_configured', 'The server has no default category password configured')
    }
    return { passwordHash: null, useDefaultPassword: true }
  }
  if (input.passwordMode === 'custom') {
    if (!input.password) throw ApiError.badRequest('A category password is required')
    return { passwordHash: await newCategoryPasswordHash(input.password), useDefaultPassword: false }
  }
  return { passwordHash: null, useDefaultPassword: false }
}

async function fallbackCategory(nav: NavStore, name = 'Uncategorized'): Promise<string> {
  const categories = await nav.categories()
  const root = categories.find((category) => !category.parentId)
  if (root) return root.id
  const created = await nav.createCategory({
    name,
    icon: 'folder',
    parentId: null,
    passwordHash: null,
    useDefaultPassword: false,
  })
  return created.id
}

navDataRoutes.get('/', async (c) => {
  const nav = store(c)
  const data = await nav.bootstrap(await unlocked(c))
  const visible = new Set(data.links.map((link) => link.id))
  data.visits = Object.fromEntries(Object.entries(data.visits).filter(([id]) => visible.has(id)))
  return c.json(data)
})

navDataRoutes.post('/categories', async (c) => {
  const nav = store(c)
  const input = await body(c, zod(NavCategoryCreateSchema))
  const password = await passwordFields(c, input)
  const category = await nav.createCategory({
    id: input.id,
    name: input.name,
    icon: input.icon,
    parentId: input.parentId ?? null,
    passwordHash: password.passwordHash,
    useDefaultPassword: password.useDefaultPassword,
    sortOrder: input.sortOrder,
  })
  return c.json({ category })
})

navDataRoutes.patch('/categories/:id', async (c) => {
  const nav = store(c)
  const id = c.req.param('id')
  const input = await body(c, zod(NavCategoryPatchSchema))
  const existing = await nav.category(id)
  if (!existing) throw ApiError.notFound('Category not found')
  const patch: Parameters<NavStore['updateCategory']>[1] = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.icon !== undefined) patch.icon = input.icon
  if (input.passwordMode !== undefined) {
    const password = await passwordFields(c, input)
    patch.passwordHash = password.passwordHash
    patch.useDefaultPassword = password.useDefaultPassword
    await clearCategoryUnlocks(c.env.DB, userId(c), id)
  }
  const category = await nav.updateCategory(id, patch)
  return c.json({ category })
})

navDataRoutes.delete('/categories/:id', async (c) => {
  const nav = store(c)
  const input = await body(c, zod(NavCategoryDeleteSchema))
  await nav.deleteCategory(c.req.param('id'), input.fallbackCategoryId)
  return c.json({ ok: true })
})

navDataRoutes.post('/categories/order', async (c) => {
  const nav = store(c)
  const input = await body(c, zod(NavOrderSchema))
  await nav.reorderCategories(input.parentId ?? null, input.orderedIds)
  return c.json({ ok: true })
})

navDataRoutes.post('/categories/:id/unlock', async (c) => {
  const nav = store(c)
  const id = c.req.param('id')
  const user = userId(c)
  const category = await nav.category(id)
  if (!category) throw ApiError.notFound('Category not found')
  const clientIp = requestClientIp(c)
  await assertUnlockAllowed(c.env.DB, user, id, clientIp)
  const input = await body(c, zod(NavUnlockSchema))
  const ok = await verifyCategoryPassword(category, input.password, c.env.NAV_DEFAULT_CATEGORY_PASSWORD)
  if (!ok) {
    await recordUnlockFailure(c.env.DB, user, id, clientIp)
    throw new ApiError(401, 'wrong_password', 'Wrong category password')
  }
  await clearUnlockFailures(c.env.DB, user, id, clientIp)
  const unlock = await createCategoryUnlock(c.env.DB, user, id)
  return c.json(unlock)
})

async function hiddenFor(c: Context<AppBindings>, nav: NavStore): Promise<Set<string>> {
  return hiddenCategories(await nav.categories(), await unlocked(c))
}

async function assertLinkWritable(c: Context<AppBindings>, nav: NavStore, id: string, targetCategoryId?: string): Promise<void> {
  const row = await nav.linkRow(id)
  if (!row) throw ApiError.notFound('Link not found')
  const hidden = await hiddenFor(c, nav)
  if (hidden.has(row.category_id)) throw ApiError.notFound('Link not found')
  if (targetCategoryId && hidden.has(targetCategoryId)) throw ApiError.notFound('Category not found')
}

navDataRoutes.post('/links', async (c) => {
  const nav = store(c)
  const input = await body(c, zod(NavLinkCreateSchema))
  if ((await hiddenFor(c, nav)).has(input.categoryId)) throw ApiError.notFound('Category not found')
  const url = normalizeLinkUrl(input.url)
  if (!url) throw ApiError.badRequest('Unsupported url')
  const link = await nav.createLink({
    id: input.id,
    title: input.title,
    url,
    icon: input.icon?.trim() || null,
    description: input.description?.trim() || null,
    categoryId: input.categoryId,
    pinned: Boolean(input.pinned),
  })
  return c.json({ link })
})

navDataRoutes.patch('/links/:id', async (c) => {
  const nav = store(c)
  const input = await body(c, zod(NavLinkPatchSchema))
  await assertLinkWritable(c, nav, c.req.param('id'), input.categoryId)
  const patch: Parameters<NavStore['updateLink']>[1] = {}
  if (input.title !== undefined) patch.title = input.title
  if (input.url !== undefined) {
    const url = normalizeLinkUrl(input.url)
    if (!url) throw ApiError.badRequest('Unsupported url')
    patch.url = url
  }
  if (input.icon !== undefined) patch.icon = input.icon?.trim() || null
  if (input.description !== undefined) patch.description = input.description?.trim() || null
  if (input.categoryId !== undefined) patch.categoryId = input.categoryId
  if (input.pinned !== undefined) patch.pinned = input.pinned
  const link = await nav.updateLink(c.req.param('id'), patch)
  return c.json({ link })
})

navDataRoutes.delete('/links/:id', async (c) => {
  const nav = store(c)
  await assertLinkWritable(c, nav, c.req.param('id'))
  await nav.deleteLink(c.req.param('id'))
  return c.json({ ok: true })
})

navDataRoutes.post('/links/order', async (c) => {
  const nav = store(c)
  const input = await body(c, zod(NavOrderSchema))
  if (input.scope === 'category' && !input.categoryId) throw ApiError.badRequest('categoryId is required')
  const unlockIds = await unlocked(c)
  const hiddenCategoryIds = hiddenCategories(await nav.categories(), unlockIds)
  await nav.reorderLinks(input.scope === 'category' ? 'category' : 'pinned', input.orderedIds, input.categoryId, hiddenCategoryIds)
  return c.json({ ok: true })
})

navDataRoutes.post('/visits', async (c) => {
  const input = await body(c, zod(NavVisitsSchema))
  await store(c).recordVisits(input.visits)
  return c.json({ ok: true })
})

navDataRoutes.post('/import', async (c) => {
  const nav = store(c)
  const input = await body(c, zod(NavImportSchema))
  const existing = new Set((await nav.categories()).map((category) => category.id))
  const imported = new Set(input.categories.map((category) => category.id))
  const fallback = existing.size || imported.size ? null : await fallbackCategory(nav, input.fallbackCategoryName)
  const known = new Set([...existing, ...imported])
  const links = input.links.map((link) => ({
    ...link,
    categoryId: known.has(link.categoryId) ? link.categoryId : fallback ?? [...known][0] ?? link.categoryId,
  }))
  const result = await nav.importData(input.categories, links, input.skipExisting !== false)
  return c.json(result)
})

navDataRoutes.post('/links/batch', async (c) => {
  const nav = store(c)
  const input = await body(c, zod(NavBatchSchema))
  const hidden = await hiddenFor(c, nav)
  const rows = await nav.linkRows()
  for (const id of input.ids) {
    const row = rows.find((entry) => entry.id === id)
    if (row && hidden.has(row.category_id)) throw ApiError.notFound('Link not found')
  }
  if (input.action === 'delete') return c.json(await nav.deleteLinks(input.ids))
  if (input.action === 'move') {
    if (!input.fallbackCategoryId) throw ApiError.badRequest('fallbackCategoryId is required')
    if (hidden.has(input.fallbackCategoryId)) throw ApiError.notFound('Category not found')
    return c.json(await nav.moveLinks(input.ids, input.fallbackCategoryId))
  }
  if (!input.template) throw ApiError.badRequest('template is required')
  return c.json(await nav.rewriteLinks(input.ids, input.template))
})

export const navSettingsRoutes = new Hono<AppBindings>()
navSettingsRoutes.use('*', requireAuth)

navSettingsRoutes.get('/', async (c) => {
  const nav = store(c)
  const [settings, webdav] = await Promise.all([nav.settings(), nav.webdavSettings()])
  return c.json({ ...settings, webdav })
})

navSettingsRoutes.put('/:group', async (c) => {
  const group = c.req.param('group')
  const nav = store(c)
  if (group === 'webdav') {
    const raw = await c.req.json().catch(() => null) as { url?: unknown; username?: unknown } | null
    if (!raw || typeof raw.url !== 'string' || typeof raw.username !== 'string') throw ApiError.badRequest('url and username are required')
    await nav.saveWebdavConfig(raw.url.trim().slice(0, 2048), raw.username.trim().slice(0, 200))
    return c.json(await nav.webdavSettings())
  }
  if (group !== 'display' && group !== 'search' && group !== 'ai') throw ApiError.notFound('Unknown settings group')
  const raw = await c.req.json().catch(() => null)
  if (group === 'display') {
    const value = zod(NavDisplaySettingsSchema)(raw)
    await nav.saveSettingsGroup('display', value)
    return c.json({ value })
  }
  if (group === 'search') {
    const value = zod(NavSearchSettingsSchema)(raw)
    await nav.saveSettingsGroup('search', value)
    return c.json({ value })
  }
  const value = zod(NavAiSettingsSchema)(raw)
  await nav.saveSettingsGroup('ai', value)
  return c.json({ value })
})
