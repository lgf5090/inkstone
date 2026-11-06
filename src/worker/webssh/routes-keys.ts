import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import {
  credentialStore,
  normalizeCredentialLabel,
  normalizeCredentialPassword,
} from './credentials'
import {
  keyStore,
  normalizeKeyLabel,
  normalizePassphrase,
  normalizePrivateKeyText,
  WEBSSH_PRIVATE_KEY_MAX,
} from './keys'

export const websshKeyRoutes = new Hono<AppBindings>()

websshKeyRoutes.use('*', requireAuth)

const KEY_BODY_BYTES = WEBSSH_PRIVATE_KEY_MAX + 8 * 1024

websshKeyRoutes.get('/credentials', async (c) => {
  return c.json({ credentials: await credentialStore(c.env.DB, c.get('userId')).list() })
})

websshKeyRoutes.post('/credentials', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, 8 * 1024)
  const credential = await credentialStore(c.env.DB, c.get('userId')).create(c.env, {
    label: normalizeCredentialLabel(body.label, true),
    password: normalizeCredentialPassword(body.password),
  })
  return c.json({ credential }, 201)
})

websshKeyRoutes.patch('/credentials/:id', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, 8 * 1024)
  const patch: { label?: string; password?: string } = {}
  if (body.label !== undefined) patch.label = normalizeCredentialLabel(body.label, true)
  if (body.password !== undefined) patch.password = normalizeCredentialPassword(body.password)
  if (!Object.keys(patch).length) throw ApiError.badRequest('Nothing to update')
  return c.json({ credential: await credentialStore(c.env.DB, c.get('userId')).update(c.env, requireParam(c, 'id'), patch) })
})

websshKeyRoutes.delete('/credentials/:id', async (c) => {
  await credentialStore(c.env.DB, c.get('userId')).remove(requireParam(c, 'id'))
  return c.json({ ok: true })
})

websshKeyRoutes.get('/keys', async (c) => {
  return c.json({ keys: await keyStore(c.env.DB, c.get('userId')).list() })
})

websshKeyRoutes.post('/keys', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, KEY_BODY_BYTES)
  const result = await keyStore(c.env.DB, c.get('userId')).create(c.env, {
    label: normalizeKeyLabel(body.label, true),
    privateKey: normalizePrivateKeyText(body.privateKey),
    passphrase: normalizePassphrase(body.passphrase),
  })
  return c.json(result, 201)
})

websshKeyRoutes.patch('/keys/:id', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, 8 * 1024)
  if (body.label === undefined) throw ApiError.badRequest('Nothing to update')
  return c.json({ key: await keyStore(c.env.DB, c.get('userId')).rename(requireParam(c, 'id'), normalizeKeyLabel(body.label, true)) })
})

websshKeyRoutes.delete('/keys/:id', async (c) => {
  await keyStore(c.env.DB, c.get('userId')).remove(requireParam(c, 'id'))
  return c.json({ ok: true })
})

websshKeyRoutes.get('/keys/:id/public', async (c) => {
  const key = await keyStore(c.env.DB, c.get('userId')).get(requireParam(c, 'id'))
  if (!key) throw ApiError.notFound('Key not found')
  return new Response(`${key.publicKey}\n`, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${key.id}.pub"`,
      'Cache-Control': 'no-store',
    },
  })
})

function requireParam(c: Context<AppBindings>, name: string): string {
  const value = c.req.param(name) ?? ''
  if (!value) throw ApiError.notFound('Not found')
  return value
}
