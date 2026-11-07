/**
 * `/api/cloudflare/platform` — Queues, Durable Object namespaces and Hyperdrive configs.
 *
 * All three are account-scoped. Reads fan out to Cloudflare and writes are audited. Durable Object
 * namespaces are created by deploying a Worker that declares the class, so this router exposes the
 * list and the namespace's objects but no namespace create/delete call that Cloudflare does not offer.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { readJson } from '../../lib/request'
import { assertNotDemo, loadAccount, type LoadedAccount } from '../../cloudflare/accounts'
import { createAuditLog } from '../../cloudflare/audit'
import {
  createDurableObjectNamespace,
  createHyperdriveConfig,
  createQueue,
  deleteDurableObjectNamespace,
  deleteHyperdriveConfig,
  deleteQueue,
  getHyperdriveConfig,
  getQueue,
  listDurableObjectInstances,
  listDurableObjectNamespaces,
  listHyperdriveConfigs,
  listQueues,
  type HyperdriveOriginInput,
} from '../../cloudflare/platform'

export const platformRouter = new Hono<AppBindings>()

type AppContext = import('hono').Context<AppBindings>

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/

function pathId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw ApiError.badRequest(`Invalid ${label}`)
  return value
}

function requiredText(value: unknown, label: string, max = 128): string {
  if (typeof value !== 'string') throw ApiError.badRequest(`${label} is required`)
  const text = value.trim()
  if (!text) throw ApiError.badRequest(`${label} is required`)
  if (text.length > max) throw ApiError.badRequest(`${label} is too long`)
  return text
}

function nameText(value: unknown, label: string): string {
  const text = requiredText(value, label)
  if (!SAFE_NAME.test(text)) throw ApiError.badRequest(`${label} contains characters Cloudflare does not allow`)
  return text
}

function portNumber(value: unknown): number {
  const port = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw ApiError.badRequest('Port must be between 1 and 65535')
  return port
}

async function loadPlatformAccount(c: AppContext): Promise<LoadedAccount> {
  const account = await loadAccount(c.env, c.get('userId'), c.req.param('accountId') ?? '')
  if (!account.row.cf_account_id) throw ApiError.badRequest('That account has no Cloudflare account id yet')
  return account
}

async function auditWrite(c: AppContext, accountId: string, action: string, target: string, detail: string): Promise<void> {
  await createAuditLog(c.env, c.get('userId'), accountId, action, target, detail, 'success')
}

// ---------------------------------------------------------------------------------------------
// Queues.
// ---------------------------------------------------------------------------------------------

platformRouter.get('/:accountId/queues', async (c) => {
  const account = await loadPlatformAccount(c)
  return c.json({ queues: await listQueues(account.auth, account.row.cf_account_id ?? '') })
})

platformRouter.get('/:accountId/queues/:queueId', async (c) => {
  const account = await loadPlatformAccount(c)
  const queueId = pathId(c.req.param('queueId'), 'queue id')
  const queue = await getQueue(account.auth, account.row.cf_account_id ?? '', queueId)
  if (!queue) throw new ApiError(404, 'not_found', 'That queue does not exist')
  return c.json({ queue })
})

platformRouter.post('/:accountId/queues', async (c) => {
  const account = await loadPlatformAccount(c)
  const body = await readJson<Record<string, unknown>>(c)
  const name = nameText(body.name, 'Queue name')
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const queue = await createQueue(account.auth, account.row.cf_account_id ?? '', name)
  await auditWrite(c, account.row.id, 'create_queue', queue.id, queue.name)
  return c.json(queue, 201)
})

platformRouter.delete('/:accountId/queues/:queueId', async (c) => {
  const account = await loadPlatformAccount(c)
  const queueId = pathId(c.req.param('queueId'), 'queue id')
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const queue = await getQueue(account.auth, account.row.cf_account_id ?? '', queueId).catch(() => null)
  await deleteQueue(account.auth, account.row.cf_account_id ?? '', queueId)
  await auditWrite(c, account.row.id, 'delete_queue', queueId, queue?.name ?? 'queue deleted')
  return c.json({ deleted: true })
})

// ---------------------------------------------------------------------------------------------
// Durable Object namespaces. Account-level creation only produces SQLite-backed namespaces; the
// namespace's class still arrives through a Worker deployment.
// ---------------------------------------------------------------------------------------------

platformRouter.get('/:accountId/durable-objects', async (c) => {
  const account = await loadPlatformAccount(c)
  return c.json({ namespaces: await listDurableObjectNamespaces(account.auth, account.row.cf_account_id ?? '') })
})

platformRouter.post('/:accountId/durable-objects', async (c) => {
  const account = await loadPlatformAccount(c)
  const body = await readJson<Record<string, unknown>>(c)
  const name = nameText(body.name, 'Namespace name')
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const namespace = await createDurableObjectNamespace(account.auth, account.row.cf_account_id ?? '', name)
  await auditWrite(c, account.row.id, 'create_do_namespace', namespace.id, namespace.name)
  return c.json(namespace, 201)
})

platformRouter.delete('/:accountId/durable-objects/:namespaceId', async (c) => {
  const account = await loadPlatformAccount(c)
  const namespaceId = pathId(c.req.param('namespaceId'), 'namespace id')
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await deleteDurableObjectNamespace(account.auth, account.row.cf_account_id ?? '', namespaceId)
  await auditWrite(c, account.row.id, 'delete_do_namespace', namespaceId, 'namespace deleted')
  return c.json({ deleted: true })
})

platformRouter.get('/:accountId/durable-objects/:namespaceId/objects', async (c) => {
  const account = await loadPlatformAccount(c)
  const namespaceId = pathId(c.req.param('namespaceId'), 'namespace id')
  return c.json({ objects: await listDurableObjectInstances(account.auth, account.row.cf_account_id ?? '', namespaceId) })
})

// ---------------------------------------------------------------------------------------------
// Hyperdrive. The origin password is write-only and is never echoed by Cloudflare or by this API.
// ---------------------------------------------------------------------------------------------

platformRouter.get('/:accountId/hyperdrive', async (c) => {
  const account = await loadPlatformAccount(c)
  return c.json({ configs: await listHyperdriveConfigs(account.auth, account.row.cf_account_id ?? '') })
})

platformRouter.get('/:accountId/hyperdrive/:configId', async (c) => {
  const account = await loadPlatformAccount(c)
  const configId = pathId(c.req.param('configId'), 'config id')
  const config = await getHyperdriveConfig(account.auth, account.row.cf_account_id ?? '', configId)
  if (!config) throw new ApiError(404, 'not_found', 'That Hyperdrive config does not exist')
  return c.json({ config })
})

platformRouter.post('/:accountId/hyperdrive', async (c) => {
  const account = await loadPlatformAccount(c)
  const body = await readJson<Record<string, unknown>>(c)
  const name = nameText(body.name, 'Config name')
  const original = body.origin && typeof body.origin === 'object' ? body.origin as Record<string, unknown> : {}
  const scheme = original.scheme === 'mysql' ? 'mysql' : original.scheme === 'postgresql' ? 'postgresql' : 'postgres'
  const origin: HyperdriveOriginInput = {
    scheme,
    host: requiredText(original.host, 'Host', 200),
    port: portNumber(original.port),
    database: requiredText(original.database, 'Database', 128),
    user: requiredText(original.user, 'User', 128),
    password: requiredText(original.password, 'Password', 512),
  }
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const config = await createHyperdriveConfig(account.auth, account.row.cf_account_id ?? '', name, origin)
  await auditWrite(c, account.row.id, 'create_hyperdrive', config.id, config.name)
  return c.json(config, 201)
})

platformRouter.delete('/:accountId/hyperdrive/:configId', async (c) => {
  const account = await loadPlatformAccount(c)
  const configId = pathId(c.req.param('configId'), 'config id')
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const config = await getHyperdriveConfig(account.auth, account.row.cf_account_id ?? '', configId).catch(() => null)
  await deleteHyperdriveConfig(account.auth, account.row.cf_account_id ?? '', configId)
  await auditWrite(c, account.row.id, 'delete_hyperdrive', configId, config?.name ?? 'config deleted')
  return c.json({ deleted: true })
})
