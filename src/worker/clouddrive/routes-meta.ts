import { Hono, type Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readJson } from '../lib/request'
import { requireOwner } from '../middleware/auth'
import { parsePath, resolveMount } from './lib'
import {
  deleteMetaRow,
  effectiveMeta,
  getMetaRow,
  hashMetaPassword,
  isMetaUnlocked,
  listMetaRows,
  metaCookieName,
  normalizeMetaPatterns,
  normalizeMetaText,
  unlockMeta,
  upsertMetaRow,
  type CloudDriveMetaRow,
} from './meta'

export const clouddriveMetaRoutes = new Hono<AppBindings>()

clouddriveMetaRoutes.use('*', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

const META_BODY_LIMIT = 64 * 1024

function metaView(row: CloudDriveMetaRow) {
  return {
    mountId: row.mount_id,
    path: row.path,
    header: row.header_md,
    footer: row.footer_md,
    hidePatterns: (() => {
      try {
        const parsed = JSON.parse(row.hide_patterns) as unknown
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
      } catch {
        return []
      }
    })(),
    hasPassword: row.password_hash.length > 0,
    inheritHeader: row.inherit_header === 1,
    inheritFooter: row.inherit_footer === 1,
    inheritHide: row.inherit_hide === 1,
    inheritPassword: row.inherit_password === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function readBoolean(value: unknown): boolean {
  return value === true
}

async function mountFor(c: Context<AppBindings>, mountId: unknown): Promise<{ id: string }> {
  if (typeof mountId !== 'string' || !mountId) throw ApiError.badRequest('A mount is required')
  const mount = await resolveMount(c.env.DB, c.get('userId'), mountId)
  return { id: mount.id }
}

clouddriveMetaRoutes.get('/meta', requireOwner, async (c) => {
  const rows = await listMetaRows(c.env.DB, c.get('userId'))
  return c.json({
    meta: rows.map((row) => ({
      ...metaView(row),
      mountName: row.mount_name,
      mountPath: row.mount_path,
    })),
  })
})

clouddriveMetaRoutes.put('/meta', requireOwner, async (c) => {
  const body = await readJson<Record<string, unknown>>(c, META_BODY_LIMIT)
  const mount = await mountFor(c, body.mountId)
  const path = parsePath(body.path ?? '/')
  let hidePatterns: string[]
  try {
    hidePatterns = normalizeMetaPatterns(body.hidePatterns)
  } catch {
    throw ApiError.badRequest('hidePatterns contains an invalid regular expression')
  }
  let password: { hash: string | null } | null = null
  if (body.clearPassword === true) password = { hash: '' }
  else if (typeof body.password === 'string' && body.password.length > 0) password = { hash: await hashMetaPassword(body.password) }
  await upsertMetaRow(c.env.DB, c.get('userId'), mount.id, path, {
    header: normalizeMetaText(body.header),
    footer: normalizeMetaText(body.footer),
    hidePatterns,
    inheritHeader: readBoolean(body.inheritHeader),
    inheritFooter: readBoolean(body.inheritFooter),
    inheritHide: readBoolean(body.inheritHide),
    inheritPassword: readBoolean(body.inheritPassword),
  }, password)
  const row = await getMetaRow(c.env.DB, c.get('userId'), mount.id, path)
  return c.json({ meta: row ? metaView(row) : null })
})

clouddriveMetaRoutes.delete('/meta', requireOwner, async (c) => {
  const body = await readJson<Record<string, unknown>>(c, META_BODY_LIMIT)
  const mount = await mountFor(c, body.mountId)
  const path = parsePath(body.path ?? '/')
  const deleted = await deleteMetaRow(c.env.DB, c.get('userId'), mount.id, path)
  return c.json({ ok: deleted })
})

clouddriveMetaRoutes.post('/meta/unlock', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, META_BODY_LIMIT)
  const mount = await mountFor(c, body.mountId)
  const path = parsePath(body.path ?? '/')
  const password = typeof body.password === 'string' ? body.password : ''
  const result = await unlockMeta(c.env.DB, c.get('userId'), mount.id, path, password)
  if (!result.ok) throw new ApiError(403, 'clouddrive_meta_locked', 'The folder password is incorrect')
  if (result.token) {
    setCookie(c, result.cookieName, result.token, {
      httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 3600, secure: new URL(c.req.url).protocol === 'https:',
    })
  }
  return c.json({ ok: true, path: result.passwordPath })
})

export async function assertMetaAccess(
  c: Context<AppBindings>,
  userId: string,
  mountId: string,
  path: string,
): Promise<void> {
  const meta = await effectiveMeta(c.env.DB, userId, mountId, path)
  if (!meta.passwordHash || !meta.passwordPath) return
  const cookieName = await metaCookieName(mountId, meta.passwordPath)
  const token = getCookie(c, cookieName)
  if (!await isMetaUnlocked(c.env.DB, userId, mountId, meta.passwordPath, token)) {
    throw new ApiError(403, 'clouddrive_meta_locked', 'This folder is password protected')
  }
}
