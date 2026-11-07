/**
 * `/api/cloudflare/zero-trust` — Access applications, groups, service tokens, IdPs, the organization
 * and the device inventory.
 *
 * Writes are limited to applications, groups and service tokens; IdPs, the organization and device
 * policies are read-only because the account already has them configured and this panel has no
 * business rewriting them.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { readJson } from '../../lib/request'
import { assertNotDemo, loadAccount, type LoadedAccount } from '../../cloudflare/accounts'
import { createAuditLog } from '../../cloudflare/audit'
import {
  createAccessApp,
  createAccessGroup,
  createServiceToken,
  deleteAccessApp,
  deleteAccessGroup,
  deleteServiceToken,
  listAccessApps,
  listAccessGroups,
  listAppPolicies,
  listDevicePolicies,
  listDevices,
  listIdentityProviders,
  listServiceTokens,
  readOrganization,
} from '../../cloudflare/zero-trust'

export const zeroTrustRouter = new Hono<AppBindings>()

type AppContext = import('hono').Context<AppBindings>

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const EMAIL = /^[^@\s]{1,120}@[^@\s]{1,120}$/
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i

function pathId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw ApiError.badRequest(`Invalid ${label}`)
  return value
}

function requiredText(value: unknown, label: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim()) throw ApiError.badRequest(`${label} is required`)
  const text = value.trim()
  if (text.length > max) throw ApiError.badRequest(`${label} is too long`)
  return text
}

function hostnameText(value: unknown): string {
  const host = requiredText(value, 'Domain', 253).toLowerCase()
  if (!HOSTNAME.test(host)) throw ApiError.badRequest('Domain must be a hostname without a scheme or path')
  return host
}

async function loadZeroTrustAccount(c: AppContext): Promise<LoadedAccount> {
  const account = await loadAccount(c.env, c.get('userId'), c.req.param('accountId') ?? '')
  if (!account.row.cf_account_id) throw ApiError.badRequest('That account has no Cloudflare account id yet')
  return account
}

async function auditWrite(c: AppContext, accountId: string, action: string, target: string, detail: string): Promise<void> {
  await createAuditLog(c.env, c.get('userId'), accountId, action, target, detail, 'success')
}

zeroTrustRouter.get('/:accountId/apps', async (c) => {
  const account = await loadZeroTrustAccount(c)
  return c.json({ apps: await listAccessApps(account.auth, account.row.cf_account_id ?? '') })
})

zeroTrustRouter.get('/:accountId/apps/:appId/policies', async (c) => {
  const account = await loadZeroTrustAccount(c)
  const appId = pathId(c.req.param('appId'), 'application id')
  return c.json({ policies: await listAppPolicies(account.auth, account.row.cf_account_id ?? '', appId) })
})

zeroTrustRouter.post('/:accountId/apps', async (c) => {
  const account = await loadZeroTrustAccount(c)
  const body = await readJson<Record<string, unknown>>(c)
  const input = {
    name: requiredText(body.name, 'Application name'),
    domain: hostnameText(body.domain),
  }
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const app = await createAccessApp(account.auth, account.row.cf_account_id ?? '', input)
  await auditWrite(c, account.row.id, 'create_access_app', app.id, `${app.name} (${app.domain})`)
  return c.json(app, 201)
})

zeroTrustRouter.delete('/:accountId/apps/:appId', async (c) => {
  const account = await loadZeroTrustAccount(c)
  const appId = pathId(c.req.param('appId'), 'application id')
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await deleteAccessApp(account.auth, account.row.cf_account_id ?? '', appId)
  await auditWrite(c, account.row.id, 'delete_access_app', appId, 'application deleted')
  return c.json({ deleted: true })
})

zeroTrustRouter.get('/:accountId/groups', async (c) => {
  const account = await loadZeroTrustAccount(c)
  return c.json({ groups: await listAccessGroups(account.auth, account.row.cf_account_id ?? '') })
})

zeroTrustRouter.post('/:accountId/groups', async (c) => {
  const account = await loadZeroTrustAccount(c)
  const body = await readJson<Record<string, unknown>>(c)
  const email = requiredText(body.email, 'Member email')
  if (!EMAIL.test(email)) throw ApiError.badRequest('Member email is not valid')
  const input = { name: requiredText(body.name, 'Group name'), email }
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const group = await createAccessGroup(account.auth, account.row.cf_account_id ?? '', input)
  await auditWrite(c, account.row.id, 'create_access_group', group.id, group.name)
  return c.json(group, 201)
})

zeroTrustRouter.delete('/:accountId/groups/:groupId', async (c) => {
  const account = await loadZeroTrustAccount(c)
  const groupId = pathId(c.req.param('groupId'), 'group id')
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await deleteAccessGroup(account.auth, account.row.cf_account_id ?? '', groupId)
  await auditWrite(c, account.row.id, 'delete_access_group', groupId, 'group deleted')
  return c.json({ deleted: true })
})

zeroTrustRouter.get('/:accountId/identity-providers', async (c) => {
  const account = await loadZeroTrustAccount(c)
  return c.json({ providers: await listIdentityProviders(account.auth, account.row.cf_account_id ?? '') })
})

zeroTrustRouter.get('/:accountId/service-tokens', async (c) => {
  const account = await loadZeroTrustAccount(c)
  return c.json({ tokens: await listServiceTokens(account.auth, account.row.cf_account_id ?? '') })
})

zeroTrustRouter.post('/:accountId/service-tokens', async (c) => {
  const account = await loadZeroTrustAccount(c)
  const body = await readJson<Record<string, unknown>>(c)
  const name = requiredText(body.name, 'Service token name')
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const token = await createServiceToken(account.auth, account.row.cf_account_id ?? '', name)
  await auditWrite(c, account.row.id, 'create_service_token', token.id, token.name)
  return c.json(token, 201)
})

zeroTrustRouter.delete('/:accountId/service-tokens/:tokenId', async (c) => {
  const account = await loadZeroTrustAccount(c)
  const tokenId = pathId(c.req.param('tokenId'), 'service token id')
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await deleteServiceToken(account.auth, account.row.cf_account_id ?? '', tokenId)
  await auditWrite(c, account.row.id, 'delete_service_token', tokenId, 'service token deleted')
  return c.json({ deleted: true })
})

zeroTrustRouter.get('/:accountId/organization', async (c) => {
  const account = await loadZeroTrustAccount(c)
  return c.json({ organization: await readOrganization(account.auth, account.row.cf_account_id ?? '') })
})

zeroTrustRouter.get('/:accountId/devices', async (c) => {
  const account = await loadZeroTrustAccount(c)
  return c.json({ devices: await listDevices(account.auth, account.row.cf_account_id ?? '') })
})

zeroTrustRouter.get('/:accountId/device-policies', async (c) => {
  const account = await loadZeroTrustAccount(c)
  return c.json({ policies: await listDevicePolicies(account.auth, account.row.cf_account_id ?? '') })
})
