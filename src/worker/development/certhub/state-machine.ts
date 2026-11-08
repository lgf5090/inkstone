import type { Env } from '../../env'
import { decryptCerthubDnsCredential, encryptCerthubOrderKey } from '../../lib/crypto'
import { ApiError } from '../../lib/errors'
import { newId } from '../../lib/id'
import { sha256Hex } from '../../lib/encoding'
import { CERTHUB_LIMITS } from '@shared/development/certhub/limits'
import { certificateName, type ValidatedDomain } from '@shared/development/certhub/validation'
import type { CerthubAction, CerthubActor, CerthubSubject } from '@shared/development/certhub/types'
import {
  challengeKeyAuthorization,
  createAcmeOrder,
  downloadCertificate,
  fetchAcmeOrder,
  fetchAuthorizations,
  finalizeAcmeOrder,
  respondToChallenge,
  revokeAcmeCertificate,
  type AcmeBundle,
} from './acme/client'
import { AcmeFailure, parseAcmeFailure } from './acme/errors'
import { ensureAccount, accountBundle, keyFingerprint } from './accounts'
import { createCsr, generateKey, parseCertificate } from './crypto/keys'
import { splitCertificateChain } from './crypto/pem'
import { queryDns } from './dns/doh'
import { notifyFromOrder } from './notify'
import { createDelegatedTxt, deleteDelegatedTxt } from './dns/dcv'
import { createTxtRecord, deleteDnsRecord } from './dns/cloudflare'
import { http01Instruction } from './dns/http01'
import {
  appendEvent,
  cancelJobsForOrder,
  enqueueJob,
  findDomain,
  findOrder,
  findProvider,
  insertOrder,
  listDomains,
  readSettings,
  updateDomain,
  updateOrder,
  type DomainRow,
  type OrderRow,
} from './store'
import { certhubObjectKey, deleteCerthubObjects, putCerthubText, readCerthubText } from './storage'

export interface AdvanceResult {
  order: OrderRow
  retryAfterMs: number
}

const TERMINAL = new Set(['issued', 'revoked', 'expired', 'canceled', 'deleting'])

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status)
}

function now(): number {
  return Date.now()
}

async function record(
  db: D1Database,
  userId: string,
  orderId: string,
  actor: CerthubActor,
  kind: string,
  messageCode: string,
  level: 'info' | 'warn' | 'error' = 'info',
  domainId?: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await appendEvent(db, { userId, orderId, domainId, actor, kind, level, messageCode, detail })
}

function identifierFor(domain: ValidatedDomain): { type: 'dns' | 'ip'; value: string } {
  return { type: domain.isIp ? 'ip' : 'dns', value: certificateName(domain) }
}

async function ensureKeyAndCsr(
  env: Env,
  order: OrderRow,
  domains: ValidatedDomain[],
  subject: CerthubSubject,
): Promise<Partial<OrderRow>> {
  if (order.key_object_key && order.csr_object_key) return {}
  const algorithm = order.key_algorithm
  const privateKey = await generateKey(algorithm)
  const names = domains.map(certificateName)
  const csr = await createCsr(privateKey, names, subject)
  const keyId = newId()
  const keyKey = certhubObjectKey('keys', order.user_id, order.id, `key-${keyId}.pem.enc`)
  const ciphertext = await encryptCerthubOrderKey(env, order.id, privateKey)
  await putCerthubText(env, keyKey, ciphertext, 'application/octet-stream', {
    orderId: order.id,
    kind: 'private-key',
  })
  const csrKey = certhubObjectKey('csr', order.user_id, order.id, `csr-${keyId}.pem`)
  await putCerthubText(env, csrKey, csr, 'application/x-pem-file', {
    orderId: order.id,
    kind: 'csr',
  })
  return {
    key_object_key: keyKey,
    csr_object_key: csrKey,
    key_fingerprint: keyFingerprint(privateKey),
  }
}

async function prepareChallenges(
  env: Env,
  db: D1Database,
  userId: string,
  order: OrderRow,
  domains: DomainRow[],
  bundle: AcmeBundle,
): Promise<'awaiting_dns' | 'awaiting_http' | 'validating'> {
  const authorizations = await fetchAuthorizations(bundle, order.acme_order_url)
  let hasDns = false
  for (const domain of domains) {
    if (domain.status === 'valid') continue
    const authz = authorizations.find((entry) => {
      const identifier = entry.identifier
      return identifier.value === domain.name && Boolean(entry.wildcard) === (domain.wildcard === 1)
    })
    if (!authz) throw new ApiError(422, 'acme_error', `The authority did not return an authorization for ${domain.name}`)
    const challenge = authz.challenges.find((entry) => entry.type === domain.challenge_mode)
    if (!challenge) throw new ApiError(422, 'acme_error', `The authority does not offer ${domain.challenge_mode} for ${domain.name}`)
    const keyAuthorization = await challengeKeyAuthorization(bundle, challenge)
    const patch: Record<string, unknown> = {
      status: 'prepared',
      authz_url: authz.url,
      challenge_url: challenge.url,
      challenge_token: challenge.token,
      key_authorization: keyAuthorization,
      updated_at: now(),
      error_code: null,
      error_message: null,
    }
    if (domain.challenge_mode === 'dns-01') {
      hasDns = true
      const fqdn = `_acme-challenge.${domain.name}`
      if (domain.dns_provider_id) {
        const provider = await findProvider(db, userId, domain.dns_provider_id)
        if (!provider) throw ApiError.notFound('The DNS provider was not found')
        if (provider.kind === 'dcv-delegate') {
          const delegated = await createDelegatedTxt(env, fqdn, keyAuthorization)
          patch.dns_record_name = fqdn
          patch.dns_record_type = 'CNAME'
          patch.dns_record_value = delegated.cnameTarget
          patch.dns_record_id = delegated.recordId
        } else {
          const recordId = await createTxtRecord(
            await providerToken(env, provider),
            provider.zone_id,
            fqdn,
            keyAuthorization,
            `certhub:${order.id}`,
          )
          patch.dns_record_name = fqdn
          patch.dns_record_type = 'TXT'
          patch.dns_record_value = keyAuthorization
          patch.dns_record_id = recordId
        }
      } else {
        patch.dns_record_name = fqdn
        patch.dns_record_type = 'TXT'
        patch.dns_record_value = keyAuthorization
      }
    } else {
      const instruction = http01Instruction(challenge.token, keyAuthorization)
      patch.dns_record_name = instruction.recordName
      patch.dns_record_type = 'HTTP'
      patch.dns_record_value = instruction.recordValue
    }
    await updateDomain(db, userId, order.id, domain.id, patch)
  }
  return hasDns ? 'awaiting_dns' : 'awaiting_http'
}

async function providerToken(env: Env, provider: { id: string; credential_ciphertext: string }): Promise<string> {
  const credential = await decryptCerthubDnsCredential(env, provider.id, provider.credential_ciphertext)
  if (!credential) throw new ApiError(503, 'vault_unavailable', 'The DNS provider credential could not be decrypted')
  return credential.token
}

async function dnsReady(env: Env, domain: DomainRow): Promise<boolean> {
  const override = env.CERTHUB_ALLOW_INSECURE_ACME === '1' ? env.CERTHUB_DOH_ENDPOINT : undefined
  if (domain.status === 'valid') return true
  if (domain.challenge_mode === 'http-01') return true
  if (domain.dns_record_type === 'CNAME') {
    const cname = await queryDns(domain.dns_record_name, 'CNAME', override)
    if (!cname.some((value) => value.replace(/\.$/, '') === domain.dns_record_value.replace(/\.$/, ''))) return false
    const txt = await queryDns(domain.dns_record_value, 'TXT', override)
    return txt.some((value) => value === domain.key_authorization)
  }
  const txt = await queryDns(domain.dns_record_name, 'TXT', override)
  return txt.some((value) => value === domain.key_authorization)
}

async function verifyChallenges(
  env: Env,
  db: D1Database,
  userId: string,
  order: OrderRow,
  domains: DomainRow[],
  bundle: AcmeBundle,
): Promise<'awaiting_dns' | 'validating' | 'ready'> {
  let allValid = true
  let waitingForDns = false
  for (const domain of domains) {
    if (domain.status === 'valid') continue
    const ready = await dnsReady(env, domain)
    if (!ready) {
      waitingForDns = true
      allValid = false
      if (domain.status !== 'prepared') {
        await record(db, userId, order.id, 'system', 'challenge.pending_dns', 'challenge.pending_dns', 'warn', domain.id, {
          name: domain.dns_record_name,
          type: domain.dns_record_type,
        })
      } else {
        const seen = await db.prepare(`SELECT 1 AS seen FROM development_certhub_events
          WHERE user_id = ?1 AND order_id = ?2 AND domain_id = ?3 AND kind = 'challenge.pending_dns' LIMIT 1`)
          .bind(userId, order.id, domain.id).first<{ seen: number }>()
        if (!seen) {
          await record(db, userId, order.id, 'system', 'challenge.pending_dns', 'challenge.pending_dns', 'warn', domain.id, {
            name: domain.dns_record_name,
            type: domain.dns_record_type,
          })
        }
      }
      await updateDomain(db, userId, order.id, domain.id, {
        status: 'prepared',
        updated_at: now(),
      })
      continue
    }
    allValid = false
    const authorizations = await fetchAuthorizations(bundle, order.acme_order_url)
    const authz = authorizations.find((entry) => entry.url === domain.authz_url)
    if (!authz) throw new ApiError(422, 'acme_error', 'The authorization is no longer available')
    if (authz.status === 'valid') {
      await updateDomain(db, userId, order.id, domain.id, {
        status: 'valid',
        validated_at: now(),
        updated_at: now(),
      })
      allValid = true
      continue
    }
    if (authz.status === 'invalid') {
      await updateDomain(db, userId, order.id, domain.id, {
        status: 'invalid',
        error_code: 'challenge_invalid',
        error_message: 'The certificate authority marked this challenge invalid',
        updated_at: now(),
      })
      throw new AcmeFailure('invalid', false, 0, `The certificate authority rejected ${domain.name}`, 0)
    }
    const challenge = authz.challenges.find((entry) => entry.url === domain.challenge_url)
    if (!challenge) throw new ApiError(422, 'acme_error', 'The challenge is no longer available')
    await respondToChallenge(bundle, authz, challenge)
    const refreshed = await fetchAuthorizations(bundle, order.acme_order_url)
    const latest = refreshed.find((entry) => entry.url === domain.authz_url)
    if (latest?.status === 'valid') {
      await updateDomain(db, userId, order.id, domain.id, {
        status: 'valid',
        validated_at: now(),
        updated_at: now(),
      })
      allValid = true
    } else {
      await updateDomain(db, userId, order.id, domain.id, {
        status: 'validating',
        updated_at: now(),
      })
    }
  }
  if (waitingForDns) return 'awaiting_dns'
  if (allValid) return 'ready'
  const pending = domains.some((domain) => domain.status !== 'valid')
  return pending ? 'validating' : 'ready'
}

async function issueCertificate(
  env: Env,
  db: D1Database,
  order: OrderRow,
  bundle: AcmeBundle,
): Promise<OrderRow> {
  const fullchain = await downloadCertificate(bundle, order.acme_order_url)
  if (fullchain.length > CERTHUB_LIMITS.maxCertBytes) throw new ApiError(502, 'acme_error', 'The certificate chain is too large')
  const sha = await sha256Hex(fullchain)
  const certKey = certhubObjectKey('certs', order.user_id, order.id, `fullchain-${sha}.pem`)
  await putCerthubText(env, certKey, fullchain, 'application/x-pem-file', { orderId: order.id, kind: 'fullchain' })
  const { chain } = splitCertificateChain(fullchain)
  const chainKey = chain
    ? certhubObjectKey('chains', order.user_id, order.id, `chain-${sha}.pem`)
    : ''
  if (chainKey) await putCerthubText(env, chainKey, chain, 'application/x-pem-file', { orderId: order.id, kind: 'chain' })
  const facts = await parseCertificate(fullchain)
  const settings = await readSettings(db, order.user_id)
  const lifetime = facts.notAfter - facts.notBefore
  const renewAt = Math.max(facts.notBefore + Math.floor(lifetime / 2), facts.notAfter - settings.renewDaysBefore * 86_400_000)
  const changed = await updateOrder(db, order.user_id, order.id, {
    status: 'issued',
    cert_object_key: certKey,
    chain_object_key: chainKey,
    cert_not_before: facts.notBefore,
    cert_not_after: facts.notAfter,
    serial_number: facts.serialNumber,
    issuer: facts.issuer,
    issued_at: now(),
    renew_at: renewAt,
    failure_code: null,
    failure_message: null,
    updated_at: now(),
    version: order.version + 1,
  }, order.version)
  if (!changed) throw ApiError.conflict('The order changed while the certificate was being saved')
  await record(db, order.user_id, order.id, 'system', 'cert.issued', 'cert.issued', 'info', undefined, {
    ca: order.ca,
    days: Math.round((facts.notAfter - facts.notBefore) / 86_400_000),
  })
  const latest = await findOrder(db, order.user_id, order.id)
  if (!latest) throw ApiError.notFound('The order disappeared after issuance')
  const domains = await listDomains(db, order.user_id, order.id)
  await notifyFromOrder(env, db, latest, domains.map((domain) => (domain.wildcard === 1 ? `*.${domain.name}` : domain.name)))
  return latest
}

async function finalize(
  env: Env,
  db: D1Database,
  order: OrderRow,
  bundle: AcmeBundle,
): Promise<OrderRow> {
  const csr = await readCerthubText(env, order.csr_object_key)
  if (!csr) throw ApiError.badRequest('The stored certificate request is missing')
  const result = await finalizeAcmeOrder(bundle, order.acme_order_url, csr)
  if (result.status === 'valid') return issueCertificate(env, db, order, bundle)
  await updateOrder(db, order.user_id, order.id, {
    status: 'finalizing',
    updated_at: now(),
    version: order.version + 1,
  }, order.version)
  await record(db, order.user_id, order.id, 'system', 'order.finalized', 'order.finalized')
  return { ...order, status: 'finalizing', version: order.version + 1, updated_at: now() }
}

export async function advanceOrder(
  env: Env,
  db: D1Database,
  userId: string,
  orderId: string,
  actor: CerthubActor = 'system',
): Promise<AdvanceResult> {
  let order = await findOrder(db, userId, orderId)
  if (!order) throw ApiError.notFound('The certificate order was not found')
  if (isTerminal(order.status)) return { order, retryAfterMs: 0 }
  const domains = await listDomains(db, userId, order.id)
  const validated: ValidatedDomain[] = domains.map((domain) => ({
    name: domain.name,
    wildcard: domain.wildcard === 1,
    primary: domain.is_primary === 1,
    challengeMode: domain.challenge_mode,
    dnsProviderId: domain.dns_provider_id,
    isIp: false,
  }))
  const subject: CerthubSubject = JSON.parse(order.subject_json) as CerthubSubject
  const { account } = await ensureAccount(
    env,
    db,
    userId,
    order.ca,
    order.environment,
    order.key_algorithm,
    '',
  )
  const bundle = await accountBundle(env, account, order.key_algorithm)
  try {
    if (order.status === 'queued' || order.status === 'creating_order') {
      const generated = await ensureKeyAndCsr(env, order, validated, subject)
      if (Object.keys(generated).length > 0) {
        const changed = await updateOrder(db, userId, order.id, {
          ...generated,
          status: 'creating_order',
          updated_at: now(),
          version: order.version + 1,
        }, order.version)
        if (!changed) throw ApiError.conflict('The order changed while its key was being generated')
        order = (await findOrder(db, userId, order.id))!
      }
      if (!order.acme_order_url) {
        const acmeOrder = await createAcmeOrder(bundle, validated.map(identifierFor))
        const changed = await updateOrder(db, userId, order.id, {
          acme_order_url: acmeOrder.url,
          order_expires_at: acmeOrder.expires ? new Date(acmeOrder.expires).getTime() : null,
          updated_at: now(),
          version: order.version + 1,
        }, order.version)
        if (!changed) throw ApiError.conflict('The order changed while the ACME order was created')
        order = (await findOrder(db, userId, order.id))!
        await record(db, userId, order.id, actor, 'order.created', 'order.created', 'info', undefined, {
          ca: order.ca,
          domains: validated.length,
        })
      }
      const freshDomains = await listDomains(db, userId, order.id)
      const next = await prepareChallenges(env, db, userId, order, freshDomains, bundle)
      const changed = await updateOrder(db, userId, order.id, {
        status: next,
        updated_at: now(),
        version: order.version + 1,
      }, order.version)
      if (!changed) throw ApiError.conflict('The order changed while its challenges were prepared')
      await record(db, userId, order.id, actor, 'challenge.prepared', 'challenge.prepared', 'info', undefined, {
        mode: next,
      })
      return { order: (await findOrder(db, userId, order.id))!, retryAfterMs: 0 }
    }

    if (order.status === 'awaiting_dns' || order.status === 'awaiting_http' || order.status === 'validating') {
      const freshDomains = await listDomains(db, userId, order.id)
      const next = await verifyChallenges(env, db, userId, order, freshDomains, bundle)
      if (next === 'awaiting_dns') {
        if (order.status === 'awaiting_dns') return { order, retryAfterMs: 5 * 60_000 }
        const changed = await updateOrder(db, userId, order.id, {
          status: 'awaiting_dns',
          updated_at: now(),
          version: order.version + 1,
        }, order.version)
        if (!changed) throw ApiError.conflict('The order changed while it was waiting for DNS')
        return { order: (await findOrder(db, userId, order.id))!, retryAfterMs: 5 * 60_000 }
      }
      if (next === 'ready') {
        const changed = await updateOrder(db, userId, order.id, {
          status: 'ready',
          updated_at: now(),
          version: order.version + 1,
        }, order.version)
        if (!changed) throw ApiError.conflict('The order changed while its challenges were being verified')
        order = (await findOrder(db, userId, order.id))!
      } else {
        const changed = await updateOrder(db, userId, order.id, {
          status: 'validating',
          updated_at: now(),
          version: order.version + 1,
        }, order.version)
        if (!changed) throw ApiError.conflict('The order changed while its challenges were being verified')
        return { order: (await findOrder(db, userId, order.id))!, retryAfterMs: 3 * 60_000 }
      }
    }

    if (order.status === 'ready') {
      return { order: await finalize(env, db, order, bundle), retryAfterMs: 2 * 60_000 }
    }

    if (order.status === 'finalizing') {
      const acmeOrder = await fetchAcmeOrder(bundle, order.acme_order_url)
      if (acmeOrder.status === 'valid') {
        return { order: await issueCertificate(env, db, order, bundle), retryAfterMs: 0 }
      }
      if (acmeOrder.status === 'invalid') {
        await failOrder(env, db, userId, order, 'order_invalid', 'The certificate authority marked the order invalid')
        return { order: (await findOrder(db, userId, order.id))!, retryAfterMs: 0 }
      }
      return { order, retryAfterMs: 3 * 60_000 }
    }

    return { order, retryAfterMs: 0 }
  } catch (error) {
    const failure = parseAcmeFailure(error)
    await record(db, userId, order.id, actor, 'order.failed', 'order.failed', failure.retryable ? 'warn' : 'error', undefined, {
      kind: failure.kind,
      detail: failure.detail,
    })
    if (!failure.retryable) {
      await failOrder(env, db, userId, order, failure.kind, failure.detail)
      return { order: (await findOrder(db, userId, order.id))!, retryAfterMs: 0 }
    }
    return { order, retryAfterMs: failure.retryAfterMs || 60_000 }
  }
}

async function failOrder(env: Env, db: D1Database, userId: string, order: OrderRow, code: string, message: string): Promise<void> {
  await updateOrder(db, userId, order.id, {
    status: 'failed',
    failure_code: code,
    failure_message: message.slice(0, 160),
    updated_at: now(),
    version: order.version + 1,
  }, order.version)
  const domains = await listDomains(db, userId, order.id)
  await notifyFromOrder(
    env,
    db,
    order,
    domains.map((domain) => (domain.wildcard === 1 ? `*.${domain.name}` : domain.name)),
    order.renew_from_order_id ? 'renew_failed' : 'failed',
  )
}

export async function renewOrder(
  env: Env,
  db: D1Database,
  userId: string,
  orderId: string,
): Promise<OrderRow> {
  const source = await findOrder(db, userId, orderId)
  if (!source) throw ApiError.notFound('The certificate order was not found')
  if (source.status !== 'issued' && source.status !== 'expired') {
    throw new ApiError(409, 'order_state_conflict', 'Only an issued or expired certificate can be renewed')
  }
  const domains = await listDomains(db, userId, orderId)
  void env
  const nextId = newId()
  const nowMs = now()
  const newOrder: OrderRow = {
    ...source,
    id: nextId,
    status: 'queued',
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
    renew_from_order_id: source.id,
    idempotency_key: '',
    deleted_at: null,
    version: 1,
    created_at: nowMs,
    updated_at: nowMs,
  }
  const domainRows = domains.map((domain) => ({
    ...domain,
    id: newId(),
    order_id: nextId,
    status: 'pending' as const,
    authz_url: '',
    challenge_url: '',
    challenge_token: '',
    key_authorization: '',
    dns_record_name: '',
    dns_record_type: '',
    dns_record_value: '',
    dns_record_id: '',
    validated_at: null,
    error_code: null,
    error_message: null,
    created_at: nowMs,
    updated_at: nowMs,
  }))
  await insertOrder(db, { order: newOrder, domains: domainRows })
  await enqueueJob(db, { userId, orderId: nextId, kind: 'advance' })
  await record(db, userId, orderId, 'user', 'order.renewed', 'order.renewed', 'info', undefined, { nextId })
  await record(db, userId, nextId, 'user', 'order.queued', 'order.queued')
  return newOrder
}

export async function revokeOrder(
  env: Env,
  db: D1Database,
  userId: string,
  orderId: string,
  reason: number,
  actor: CerthubActor,
): Promise<OrderRow> {
  const order = await findOrder(db, userId, orderId)
  if (!order) throw ApiError.notFound('The certificate order was not found')
  if (order.status !== 'issued' && order.status !== 'expired') {
    throw new ApiError(409, 'order_state_conflict', 'Only an issued or expired certificate can be revoked')
  }
  const pem = await readCerthubText(env, order.cert_object_key)
  if (!pem) throw ApiError.notFound('The certificate content is missing')
  const { account } = await ensureAccount(env, db, userId, order.ca, order.environment, order.key_algorithm, '')
  const bundle = await accountBundle(env, account, order.key_algorithm)
  await revokeAcmeCertificate(bundle, pem, reason)
  if (order.key_object_key) await deleteCerthubObjects(env, [order.key_object_key])
  const changed = await updateOrder(db, userId, order.id, {
    status: 'revoked',
    revoked_at: now(),
    revoke_reason: reason,
    key_object_key: '',
    key_purged_at: now(),
    updated_at: now(),
    version: order.version + 1,
  }, order.version)
  if (!changed) throw ApiError.conflict('The order changed while it was being revoked')
  await record(db, userId, order.id, actor, 'cert.revoked', 'cert.revoked', 'warn', undefined, { reason })
  const domains = await listDomains(db, userId, order.id)
  await notifyFromOrder(
    env,
    db,
    order,
    domains.map((domain) => (domain.wildcard === 1 ? `*.${domain.name}` : domain.name)),
    'revoked',
  )
  return (await findOrder(db, userId, order.id))!
}

export async function purgeOrderKey(
  env: Env,
  db: D1Database,
  userId: string,
  orderId: string,
  actor: CerthubActor,
): Promise<OrderRow> {
  const order = await findOrder(db, userId, orderId)
  if (!order) throw ApiError.notFound('The certificate order was not found')
  if (order.key_object_key) await deleteCerthubObjects(env, [order.key_object_key])
  const changed = await updateOrder(db, userId, order.id, {
    key_object_key: '',
    key_purged_at: now(),
    updated_at: now(),
    version: order.version + 1,
  }, order.version)
  if (!changed) throw ApiError.conflict('The order changed while its key was being purged')
  await record(db, userId, order.id, actor, 'key.purged', 'key.purged', 'warn')
  return (await findOrder(db, userId, order.id))!
}

export async function cancelOrder(
  db: D1Database,
  userId: string,
  orderId: string,
  actor: CerthubActor,
): Promise<OrderRow> {
  const order = await findOrder(db, userId, orderId)
  if (!order) throw ApiError.notFound('The certificate order was not found')
  if (order.status === 'issued') throw new ApiError(409, 'order_state_conflict', 'An issued order cannot be canceled')
  await cancelJobsForOrder(db, userId, orderId)
  const changed = await updateOrder(db, userId, orderId, {
    status: 'canceled',
    updated_at: now(),
    version: order.version + 1,
  }, order.version)
  if (!changed) throw ApiError.conflict('The order changed while it was being canceled')
  await record(db, userId, order.id, actor, 'order.canceled', 'order.canceled', 'warn')
  return (await findOrder(db, userId, orderId))!
}

export async function handleOrderAction(
  env: Env,
  db: D1Database,
  userId: string,
  orderId: string,
  action: CerthubAction,
  actor: CerthubActor,
  options: { domainId?: string; revokeReason?: number } = {},
): Promise<AdvanceResult> {
  if (action === 'advance' || action === 'verify' || action === 'verify_domain') {
    if (action === 'verify_domain') {
      if (!options.domainId) throw ApiError.badRequest('A domain id is required')
      const domain = await findDomain(db, userId, orderId, options.domainId)
      if (!domain) throw ApiError.notFound('The domain was not found')
    }
    return advanceOrder(env, db, userId, orderId, actor)
  }
  if (action === 'renew') {
    const order = await renewOrder(env, db, userId, orderId)
    return { order, retryAfterMs: 0 }
  }
  if (action === 'revoke') {
    const order = await revokeOrder(env, db, userId, orderId, options.revokeReason ?? 0, actor)
    return { order, retryAfterMs: 0 }
  }
  if (action === 'purge_key') {
    const order = await purgeOrderKey(env, db, userId, orderId, actor)
    return { order, retryAfterMs: 0 }
  }
  if (action === 'cancel') {
    const order = await cancelOrder(db, userId, orderId, actor)
    return { order, retryAfterMs: 0 }
  }
  if (action === 'delete') {
    throw ApiError.badRequest('Deletion is handled by the delete endpoint')
  }
  if (action === 'regenerate') {
    const order = await findOrder(db, userId, orderId)
    if (!order) throw ApiError.notFound('The certificate order was not found')
    const domains = await listDomains(db, userId, orderId)
    for (const domain of domains) {
      if (domain.dns_record_id && domain.dns_provider_id) {
        const provider = await findProvider(db, userId, domain.dns_provider_id)
        if (provider?.kind === 'cloudflare') {
          await deleteDnsRecord(await providerToken(env, provider), provider.zone_id, domain.dns_record_id)
        } else if (provider?.kind === 'dcv-delegate') {
          await deleteDelegatedTxt(env, domain.dns_record_id)
        }
      }
      await updateDomain(db, userId, orderId, domain.id, {
        status: 'pending',
        authz_url: '',
        challenge_url: '',
        challenge_token: '',
        key_authorization: '',
        dns_record_name: '',
        dns_record_type: '',
        dns_record_value: '',
        dns_record_id: '',
        error_code: null,
        error_message: null,
        updated_at: now(),
      })
    }
    await record(db, userId, orderId, actor, 'challenge.regenerated', 'challenge.regenerated', 'info')
    return advanceOrder(env, db, userId, orderId, actor)
  }
  throw ApiError.badRequest('Unknown certificate action')
}

export function orderRetryAfter(result: AdvanceResult): number {
  return result.retryAfterMs
}
