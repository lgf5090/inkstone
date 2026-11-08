import type { Env } from '../../env'
import { ApiError } from '../../lib/errors'
import { newId } from '../../lib/id'
import { CERTHUB_LIMITS } from '@shared/development/certhub/limits'
import { subjectFromInput, validateDomainRows } from '@shared/development/certhub/validation'
import type { CerthubActor, CerthubOrderView } from '@shared/development/certhub/types'
import { ensureAccount } from './accounts'
import { assertCanCreateOrder, recordOrderCreated } from './quota'
import {
  appendEvent,
  enqueueJob,
  findOrderByIdempotency,
  findProvider,
  insertOrder,
  listDomains,
  orderWithDomains,
  readSettings,
} from './store'

export interface CreateOrderInput {
  domains: Array<{ name: string; wildcard?: boolean; primary?: boolean; challengeMode?: 'dns-01' | 'http-01'; dnsProviderId?: string }>
  ca?: import('@shared/development/certhub/types').CerthubCa
  keyAlgorithm?: import('@shared/development/certhub/types').CerthubKeyAlgorithm
  autoRenew?: boolean
  subject?: import('@shared/development/certhub/types').CerthubSubject
}

export interface CreatedOrder {
  order: CerthubOrderView
  jobId: string
  reused: boolean
}

export async function createOrderForUser(
  env: Env,
  db: D1Database,
  userId: string,
  login: string,
  body: CreateOrderInput,
  actor: CerthubActor,
  idempotencyKey: string,
  environment: 'production' | 'staging',
): Promise<CreatedOrder> {
  const domains = validateDomainRows(body.domains)
  const settings = await readSettings(db, userId)
  const ca = body.ca ?? settings.defaultCa
  const keyAlgorithm = body.keyAlgorithm ?? settings.defaultKeyAlgorithm
  await assertCanCreateOrder(db, userId, ca, domains.length)
  if (idempotencyKey) {
    const existing = await findOrderByIdempotency(db, userId, idempotencyKey)
    if (existing) {
      return { order: orderWithDomains(existing, await listDomains(db, userId, existing.id)), jobId: '', reused: true }
    }
  }
  for (const domain of domains) {
    if (domain.dnsProviderId && !(await findProvider(db, userId, domain.dnsProviderId))) {
      throw ApiError.badRequest('The selected DNS provider was not found')
    }
  }
  const { account } = await ensureAccount(env, db, userId, ca, environment, keyAlgorithm, login)
  const now = Date.now()
  const orderId = newId()
  const order = {
    user_id: userId,
    id: orderId,
    account_id: account.id,
    ca,
    environment,
    key_algorithm: keyAlgorithm,
    status: 'queued' as const,
    subject_json: JSON.stringify(subjectFromInput(body.subject)),
    auto_renew: body.autoRenew === false ? 0 : 1,
    renew_at: null,
    order_expires_at: null,
    acme_order_url: '',
    finalize_url: '',
    csr_object_key: '',
    cert_object_key: '',
    chain_object_key: '',
    key_object_key: '',
    key_fingerprint: '',
    serial_number: '',
    issuer: '',
    cert_not_before: null,
    cert_not_after: null,
    issued_at: null,
    revoked_at: null,
    revoke_reason: null,
    key_purged_at: null,
    failure_code: null,
    failure_message: null,
    attempts: 0,
    last_attempt_at: null,
    lock_owner: null,
    locked_until: null,
    renew_from_order_id: null,
    idempotency_key: idempotencyKey,
    deleted_at: null,
    version: 1,
    created_at: now,
    updated_at: now,
  }
  const domainRows = domains.map((domain) => ({
    user_id: userId,
    id: newId(),
    order_id: orderId,
    name: domain.name,
    wildcard: domain.wildcard ? 1 : 0,
    is_primary: domain.primary ? 1 : 0,
    challenge_mode: domain.challengeMode,
    status: 'pending' as const,
    authz_url: '',
    challenge_url: '',
    challenge_token: '',
    key_authorization: '',
    dns_record_name: '',
    dns_record_type: '',
    dns_record_value: '',
    dns_provider_id: domain.dnsProviderId,
    dns_record_id: '',
    validated_at: null,
    error_code: null,
    error_message: null,
    created_at: now,
    updated_at: now,
  }))
  const job = await enqueueJob(db, { userId, orderId, kind: 'advance' })
  await insertOrder(db, { order, domains: domainRows, job })
  await recordOrderCreated(db, userId)
  await appendEvent(db, {
    userId,
    orderId,
    actor,
    kind: 'order.queued',
    messageCode: 'order.queued',
    detail: { ca, domains: domains.length },
  })
  return { order: orderWithDomains(order, domainRows), jobId: job.id, reused: false }
}

export function orderLimit(): number {
  return CERTHUB_LIMITS.maxDomainsPerOrder
}
