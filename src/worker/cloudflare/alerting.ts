/**
 * Account notification policies.
 *
 * A policy pairs an alert type with delivery mechanisms. Email recipients are the only mechanism this
 * screen edits, because the account already has an eligible email destination; PagerDuty and webhooks
 * are left to Cloudflare's own dashboard rather than guessed at here.
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

export interface AlertPolicy {
  id: string
  name: string
  description: string
  enabled: boolean
  alertType: string
  emails: string[]
  created: string
  modified: string
}

export interface AlertTypeOption {
  type: string
  displayName: string
  description: string
}

export interface AlertPolicyInput {
  name: string
  description: string
  alertType: string
  enabled: boolean
  emails: string[]
}

export function toAlertPolicy(value: unknown): AlertPolicy | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  const mechanisms = asRecord(row.mechanisms)
  return {
    id,
    name: textOf(row.name),
    description: textOf(row.description),
    enabled: row.enabled === true,
    alertType: textOf(row.alert_type),
    emails: asArray(mechanisms.email)
      .map((item) => textOf(asRecord(item).id))
      .filter((email) => email.length > 0),
    created: textOf(row.created),
    modified: textOf(row.modified),
  }
}

export async function listAlertPolicies(auth: CloudflareAuth, accountId: string): Promise<AlertPolicy[]> {
  const body = await cfFetch<{ result?: unknown[] }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/alerting/v3/policies`,
  )
  return asArray(body.result).map(toAlertPolicy).filter((row): row is AlertPolicy => row !== null)
}

/** Cloudflare keys available alerts by product; the screen wants one flat list. */
export async function listAlertTypes(auth: CloudflareAuth, accountId: string): Promise<AlertTypeOption[]> {
  const body = await cfFetch<{ result?: Record<string, unknown> }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/alerting/v3/available_alerts`,
  )
  const groups = asRecord(body.result)
  const out: AlertTypeOption[] = []
  for (const group of Object.values(groups)) {
    for (const item of asArray(group)) {
      const row = asRecord(item)
      const type = textOf(row.type)
      if (!type) continue
      out.push({
        type,
        displayName: textOf(row.display_name) || type,
        description: textOf(row.description),
      })
    }
  }
  return out.sort((left, right) => left.displayName.localeCompare(right.displayName))
}

function policyBody(input: AlertPolicyInput): Record<string, unknown> {
  return {
    name: input.name,
    description: input.description,
    alert_type: input.alertType,
    enabled: input.enabled,
    mechanisms: { email: input.emails.map((email) => ({ id: email })) },
  }
}

export async function createAlertPolicy(
  auth: CloudflareAuth,
  accountId: string,
  input: AlertPolicyInput,
): Promise<AlertPolicy> {
  const body = await cfFetch<{ result?: unknown }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/alerting/v3/policies`,
    { method: 'POST', body: policyBody(input) },
  )
  const policy = toAlertPolicy(body.result)
  if (!policy) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare created a policy without answering with it')
  // The create answer carries the id but not the fields, so the screen's refresh uses the list; the
  // API answer is completed here so a caller does not have to guess whether the write landed.
  if (!policy.name || !policy.alertType) {
    const list = await listAlertPolicies(auth, accountId)
    return list.find((row) => row.id === policy.id) ?? policy
  }
  return policy
}

export async function updateAlertPolicy(
  auth: CloudflareAuth,
  accountId: string,
  policyId: string,
  input: AlertPolicyInput,
): Promise<void> {
  await cfFetch(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/alerting/v3/policies/${encodeURIComponent(policyId)}`,
    { method: 'PUT', body: policyBody(input) },
  )
}

export async function deleteAlertPolicy(
  auth: CloudflareAuth,
  accountId: string,
  policyId: string,
): Promise<void> {
  await cfFetch(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/alerting/v3/policies/${encodeURIComponent(policyId)}`,
    { method: 'DELETE' },
  )
}
