/**
 * The developer-platform read shapes and write calls: Queues, Durable Object namespaces and
 * Hyperdrive configs.
 *
 * These products live under the account, not a zone. Cloudflare answers each list with a paginated
 * envelope, so the converters drop the envelope and keep the fields the screens actually draw.
 * Hyperdrive's password is write-only: the create call sends it, and nothing here ever returns it.
 */
import type { CloudflareAuth } from './cf-api'
import { cfFetch } from './cf-api'
import { ApiError } from '../lib/errors'

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export interface QueueProducer {
  type: string
  label: string
}

export interface QueueConsumer {
  type: string
  script: string
}

export interface QueueSummary {
  id: string
  name: string
  createdOn: string
  modifiedOn: string
  producers: QueueProducer[]
  consumers: QueueConsumer[]
  producerCount: number
  consumerCount: number
  settings: {
    deliveryDelay: number | null
    messageRetention: number | null
    deliveryPaused: boolean
  } | null
}

function toProducer(value: unknown): QueueProducer | null {
  const row = asRecord(value)
  const type = textOf(row.type)
  const label = type === 'r2_bucket' ? textOf(row.bucket_name) : textOf(row.script)
  if (!type && !label) return null
  return { type, label }
}

function toConsumer(value: unknown): QueueConsumer | null {
  const row = asRecord(value)
  const type = textOf(row.type)
  const script = textOf(row.script)
  if (!type && !script) return null
  return { type, script }
}

export function toQueue(value: unknown): QueueSummary | null {
  const row = asRecord(value)
  const id = textOf(row.queue_id)
  if (!id) return null
  const settingsRow = row.settings ? asRecord(row.settings) : null
  return {
    id,
    name: textOf(row.queue_name),
    createdOn: textOf(row.created_on),
    modifiedOn: textOf(row.modified_on),
    producers: asArray(row.producers).map(toProducer).filter((row): row is QueueProducer => row !== null),
    consumers: asArray(row.consumers).map(toConsumer).filter((row): row is QueueConsumer => row !== null),
    producerCount: typeof row.producers_total_count === 'number' ? row.producers_total_count : asArray(row.producers).length,
    consumerCount: typeof row.consumers_total_count === 'number' ? row.consumers_total_count : asArray(row.consumers).length,
    settings: settingsRow ? {
      deliveryDelay: typeof settingsRow.delivery_delay === 'number' ? settingsRow.delivery_delay : null,
      messageRetention: typeof settingsRow.message_retention_period === 'number' ? settingsRow.message_retention_period : null,
      deliveryPaused: settingsRow.delivery_paused === true,
    } : null,
  }
}

export async function listQueues(auth: CloudflareAuth, accountId: string): Promise<QueueSummary[]> {
  const body = await cfFetch<{ result?: unknown[] }>(auth, `/accounts/${encodeURIComponent(accountId)}/queues`)
  return asArray(body.result).map(toQueue).filter((row): row is QueueSummary => row !== null)
}

export async function getQueue(auth: CloudflareAuth, accountId: string, queueId: string): Promise<QueueSummary | null> {
  const body = await cfFetch<{ result?: unknown }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/queues/${encodeURIComponent(queueId)}`,
  )
  return toQueue(body.result)
}

export async function createQueue(auth: CloudflareAuth, accountId: string, name: string): Promise<QueueSummary> {
  const body = await cfFetch<{ result?: unknown }>(auth, `/accounts/${encodeURIComponent(accountId)}/queues`, {
    method: 'POST',
    body: { queue_name: name },
  })
  const queue = toQueue(body.result)
  if (!queue) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare created a queue without answering with it')
  return queue
}

export async function deleteQueue(auth: CloudflareAuth, accountId: string, queueId: string): Promise<void> {
  await cfFetch(auth, `/accounts/${encodeURIComponent(accountId)}/queues/${encodeURIComponent(queueId)}`, {
    method: 'DELETE',
  })
}

export interface DurableObjectNamespace {
  id: string
  name: string
  className: string
  script: string
  useSqlite: boolean
}

export interface DurableObjectInstance {
  id: string
  hasStub: boolean
}

export function toDurableObjectNamespace(value: unknown): DurableObjectNamespace | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  return {
    id,
    name: textOf(row.name),
    className: textOf(row.class),
    script: textOf(row.script),
    useSqlite: row.use_sqlite === true,
  }
}

export async function listDurableObjectNamespaces(
  auth: CloudflareAuth,
  accountId: string,
): Promise<DurableObjectNamespace[]> {
  const body = await cfFetch<{ result?: unknown[] }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/workers/durable_objects/namespaces`,
  )
  return asArray(body.result).map(toDurableObjectNamespace).filter((row): row is DurableObjectNamespace => row !== null)
}

export async function listDurableObjectInstances(
  auth: CloudflareAuth,
  accountId: string,
  namespaceId: string,
): Promise<DurableObjectInstance[]> {
  const body = await cfFetch<{ result?: unknown[] }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/workers/durable_objects/namespaces/${encodeURIComponent(namespaceId)}/objects`,
  )
  return asArray(body.result)
    .map((value): DurableObjectInstance | null => {
      const row = asRecord(value)
      const id = textOf(row.id)
      return id ? { id, hasStub: row.hasStub === true || row.has_stub === true } : null
    })
    .filter((row): row is DurableObjectInstance => row !== null)
}

/**
 * Account-level creation only supports SQLite-backed namespaces: Cloudflare refuses KV-backed ones
 * (`10099`) and asks for a `new_sqlite_classes` migration instead. Sending `use_sqlite` is therefore a
 * requirement, not a preference.
 */
export async function createDurableObjectNamespace(
  auth: CloudflareAuth,
  accountId: string,
  name: string,
): Promise<DurableObjectNamespace> {
  const body = await cfFetch<{ result?: unknown }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/workers/durable_objects/namespaces`,
    { method: 'POST', body: { name, use_sqlite: true } },
  )
  const namespace = toDurableObjectNamespace(body.result)
  if (!namespace) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare created a namespace without answering with it')
  return namespace
}

export async function deleteDurableObjectNamespace(
  auth: CloudflareAuth,
  accountId: string,
  namespaceId: string,
): Promise<void> {
  await cfFetch(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/workers/durable_objects/namespaces/${encodeURIComponent(namespaceId)}`,
    { method: 'DELETE' },
  )
}

export interface HyperdriveConfig {
  id: string
  name: string
  scheme: string
  host: string
  port: number | null
  database: string
  user: string
  cachingDisabled: boolean
  maxAge: number | null
  createdOn: string
  modifiedOn: string
}

export function toHyperdriveConfig(value: unknown): HyperdriveConfig | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  const origin = asRecord(row.origin)
  const caching = asRecord(row.caching)
  return {
    id,
    name: textOf(row.name),
    scheme: textOf(origin.scheme),
    host: textOf(origin.host),
    port: typeof origin.port === 'number' ? origin.port : null,
    database: textOf(origin.database),
    user: textOf(origin.user),
    cachingDisabled: caching.disabled === true,
    maxAge: typeof caching.max_age === 'number' ? caching.max_age : null,
    createdOn: textOf(row.created_on),
    modifiedOn: textOf(row.modified_on),
  }
}

export async function listHyperdriveConfigs(auth: CloudflareAuth, accountId: string): Promise<HyperdriveConfig[]> {
  const body = await cfFetch<{ result?: unknown[] }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs`,
  )
  return asArray(body.result).map(toHyperdriveConfig).filter((row): row is HyperdriveConfig => row !== null)
}

export async function getHyperdriveConfig(
  auth: CloudflareAuth,
  accountId: string,
  configId: string,
): Promise<HyperdriveConfig | null> {
  const body = await cfFetch<{ result?: unknown }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs/${encodeURIComponent(configId)}`,
  )
  return toHyperdriveConfig(body.result)
}

export interface HyperdriveOriginInput {
  scheme: 'postgres' | 'postgresql' | 'mysql'
  host: string
  port: number
  database: string
  user: string
  password: string
}

export async function createHyperdriveConfig(
  auth: CloudflareAuth,
  accountId: string,
  name: string,
  origin: HyperdriveOriginInput,
): Promise<HyperdriveConfig> {
  const body = await cfFetch<{ result?: unknown }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs`,
    { method: 'POST', body: { name, origin } },
  )
  const config = toHyperdriveConfig(body.result)
  if (!config) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare created a Hyperdrive config without answering with it')
  return config
}

export async function deleteHyperdriveConfig(
  auth: CloudflareAuth,
  accountId: string,
  configId: string,
): Promise<void> {
  await cfFetch(auth, `/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs/${encodeURIComponent(configId)}`, {
    method: 'DELETE',
  })
}
