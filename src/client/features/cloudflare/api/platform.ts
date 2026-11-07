/**
 * The developer-platform screen's door to `/api/cloudflare/platform`.
 *
 * Each product has its own list/detail pair and the create/delete the backend exposes. Durable Object
 * namespaces are read-only here because Cloudflare creates them from a Worker deployment.
 */
import { cfRequest } from './client'

export interface QueueProducer {
  type: string
  label: string
}

export interface QueueConsumer {
  type: string
  script: string
}

export interface PlatformQueue {
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

export interface HyperdriveOriginInput {
  scheme: 'postgres' | 'postgresql' | 'mysql'
  host: string
  port: number
  database: string
  user: string
  password: string
}

const BASE = '/platform'

export const platformApi = {
  queues: (accountId: string) =>
    cfRequest<{ queues: PlatformQueue[] }>(`${BASE}/${accountId}/queues`),

  queue: (accountId: string, queueId: string) =>
    cfRequest<{ queue: PlatformQueue }>(`${BASE}/${accountId}/queues/${encodeURIComponent(queueId)}`),

  createQueue: (accountId: string, name: string) =>
    cfRequest<PlatformQueue>(`${BASE}/${accountId}/queues`, { method: 'POST', body: { name } }),

  deleteQueue: (accountId: string, queueId: string) =>
    cfRequest<{ deleted: true }>(`${BASE}/${accountId}/queues/${encodeURIComponent(queueId)}`, { method: 'DELETE' }),

  durableObjectNamespaces: (accountId: string) =>
    cfRequest<{ namespaces: DurableObjectNamespace[] }>(`${BASE}/${accountId}/durable-objects`),

  durableObjectInstances: (accountId: string, namespaceId: string) =>
    cfRequest<{ objects: DurableObjectInstance[] }>(
      `${BASE}/${accountId}/durable-objects/${encodeURIComponent(namespaceId)}/objects`,
    ),

  createDurableObjectNamespace: (accountId: string, name: string) =>
    cfRequest<DurableObjectNamespace>(`${BASE}/${accountId}/durable-objects`, { method: 'POST', body: { name } }),

  deleteDurableObjectNamespace: (accountId: string, namespaceId: string) =>
    cfRequest<{ deleted: true }>(`${BASE}/${accountId}/durable-objects/${encodeURIComponent(namespaceId)}`, { method: 'DELETE' }),

  hyperdriveConfigs: (accountId: string) =>
    cfRequest<{ configs: HyperdriveConfig[] }>(`${BASE}/${accountId}/hyperdrive`),

  hyperdriveConfig: (accountId: string, configId: string) =>
    cfRequest<{ config: HyperdriveConfig }>(`${BASE}/${accountId}/hyperdrive/${encodeURIComponent(configId)}`),

  createHyperdriveConfig: (accountId: string, name: string, origin: HyperdriveOriginInput) =>
    cfRequest<HyperdriveConfig>(`${BASE}/${accountId}/hyperdrive`, { method: 'POST', body: { name, origin } }),

  deleteHyperdriveConfig: (accountId: string, configId: string) =>
    cfRequest<{ deleted: true }>(`${BASE}/${accountId}/hyperdrive/${encodeURIComponent(configId)}`, { method: 'DELETE' }),
}
