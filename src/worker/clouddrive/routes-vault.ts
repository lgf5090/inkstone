import { Hono, type Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readJson } from '../lib/request'
import { requireCurrentPassword } from '../lib/reauth'
import { requireOwner } from '../middleware/auth'
import { parsePath, resolveEntry, resolveMount } from './lib'
import { effectiveMeta, getMetaRow, hashMetaPassword, isMetaUnlocked, metaCookieName, unlockMeta, upsertMetaRow } from './meta'
import { assertPasscodeAttemptsLeft, notePasscodeFailure, notePasscodeSuccess, passcodeThrottleKey } from './lib'
import { issueVaultUnlock, isVaultUnlocked, revokeVaultUnlocks, VAULT_UNLOCK_HEADER } from './vault'

export const clouddriveVaultRoutes = new Hono<AppBindings>()
clouddriveVaultRoutes.use('/vault', requireOwner)
clouddriveVaultRoutes.use('/vault/*', requireOwner)

const BODY_LIMIT = 16 * 1024

async function vaultFolder(c: Context<AppBindings>, mountId: unknown, pathValue: unknown) {
  const userId = c.get('userId')
  const mount = await resolveMount(c.env.DB, userId, typeof mountId === 'string' && mountId ? mountId : 'primary')
  if (mount.storageId !== 'primary' || mount.readOnly) throw ApiError.badRequest('A vault requires a writable primary folder')
  const path = parsePath(pathValue ?? '/')
  const folder = await resolveEntry(c.env.DB, userId, mount.id, path)
  if (folder.kind !== 'folder' || !folder.id) throw ApiError.badRequest('A vault requires a non-root folder')
  return { userId, mountId: mount.id, path, folder }
}

clouddriveVaultRoutes.put('/vault', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const { userId, mountId, path } = await vaultFolder(c, body.mountId, body.path)
  await requireCurrentPassword(c.env.DB, userId, body.currentPassword)
  if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 200) {
    throw ApiError.badRequest('The vault password must contain 8 to 200 characters')
  }
  const parent = await effectiveMeta(c.env.DB, userId, mountId, path === '/' ? '/' : path.slice(0, path.lastIndexOf('/')) || '/')
  if (parent.vaultPath) throw ApiError.badRequest('A vault cannot be nested inside another vault')
  const row = await getMetaRow(c.env.DB, userId, mountId, path)
  await upsertMetaRow(c.env.DB, userId, mountId, path, {
    header: row?.header_md ?? '', footer: row?.footer_md ?? '',
    hidePatterns: row ? JSON.parse(row.hide_patterns) as string[] : [],
    inheritHeader: row?.inherit_header === 1, inheritFooter: row?.inherit_footer === 1,
    inheritHide: row?.inherit_hide === 1, inheritPassword: false, vault: true,
  }, { hash: await hashMetaPassword(body.password) })
  await revokeVaultUnlocks(c.env.DB, userId, mountId, path)
  return c.json({ ok: true, path })
})

clouddriveVaultRoutes.post('/vault/unlock', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const { userId, mountId, path } = await vaultFolder(c, body.mountId, body.path)
  const meta = await effectiveMeta(c.env.DB, userId, mountId, path)
  if (!meta.vaultPath) throw ApiError.notFound('Vault not found')
  const throttleKey = passcodeThrottleKey('vault', `${mountId}:${meta.vaultPath}`, c.req.raw)
  await assertPasscodeAttemptsLeft(c.env.DB, throttleKey)
  await requireCurrentPassword(c.env.DB, userId, body.currentPassword)
  const unlocked = await unlockMeta(c.env.DB, userId, mountId, path, typeof body.password === 'string' ? body.password : '')
  if (!unlocked.ok) {
    await notePasscodeFailure(c.env.DB, throttleKey)
    throw new ApiError(403, 'clouddrive_vault_locked', 'The vault password is incorrect')
  }
  await notePasscodeSuccess(c.env.DB, throttleKey)
  const token = await issueVaultUnlock(c.env.DB, userId, mountId, meta.vaultPath)
  setCookie(c, unlocked.cookieName, unlocked.token, {
    httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 3600, secure: new URL(c.req.url).protocol === 'https:',
  })
  return c.json({ ok: true, token: token.token, expiresAt: token.expiresAt, path: meta.vaultPath })
})

clouddriveVaultRoutes.post('/vault/lock', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const { userId, mountId, path } = await vaultFolder(c, body.mountId, body.path)
  await revokeVaultUnlocks(c.env.DB, userId, mountId, path)
  return c.json({ ok: true })
})

clouddriveVaultRoutes.delete('/vault', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const { userId, mountId, path } = await vaultFolder(c, body.mountId, body.path)
  await requireCurrentPassword(c.env.DB, userId, body.currentPassword)
  const row = await getMetaRow(c.env.DB, userId, mountId, path)
  if (!row?.vault) throw ApiError.notFound('Vault not found')
  await upsertMetaRow(c.env.DB, userId, mountId, path, {
    header: row.header_md, footer: row.footer_md, hidePatterns: JSON.parse(row.hide_patterns) as string[],
    inheritHeader: row.inherit_header === 1, inheritFooter: row.inherit_footer === 1,
    inheritHide: row.inherit_hide === 1, inheritPassword: row.inherit_password === 1, vault: false,
  }, { hash: '' })
  await revokeVaultUnlocks(c.env.DB, userId, mountId, path)
  return c.json({ ok: true })
})

export async function assertVaultHeader(
  c: Context<AppBindings>,
  userId: string,
  mountId: string,
  vaultPath: string | null,
): Promise<void> {
  if (!vaultPath) return
  if (!await isMetaUnlocked(c.env.DB, userId, mountId, vaultPath, getCookie(c, await metaCookieName(mountId, vaultPath)))) {
    throw new ApiError(403, 'clouddrive_vault_locked', 'The vault session expired')
  }
  if (!await isVaultUnlocked(c.env.DB, userId, mountId, vaultPath, c.req.header(VAULT_UNLOCK_HEADER))) {
    throw new ApiError(403, 'clouddrive_vault_locked', 'Unlock the vault again to continue')
  }
}
