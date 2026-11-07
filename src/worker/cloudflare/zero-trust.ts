/**
 * Zero Trust (Access) reads and the three create/delete pairs this screen exposes.
 *
 * Access applications, groups and service tokens are account-scoped. Identity providers, the
 * organization and device policies are read-only here: the account already has one IdP, one
 * organization and a default WARP policy, and the panel must not rewrite them.
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

export interface AccessApp {
  id: string
  name: string
  domain: string
  type: string
  sessionDuration: string
  createdAt: string
  updatedAt: string
}

export interface AccessPolicy {
  id: string
  name: string
  decision: string
}

export interface AccessGroup {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface IdentityProvider {
  id: string
  name: string
  type: string
}

export interface ServiceToken {
  id: string
  name: string
  clientId: string
  expiresAt: string
  createdAt: string
  clientSecret?: string
}

export interface AccessOrganization {
  name: string
  authDomain: string
  createdAt: string
  updatedAt: string
  denyUnmatchedRequests: boolean
  strictServiceTokenAuth: boolean
}

export interface AccessDevice {
  id: string
  name: string
  deviceType: string
  osVersion: string
  lastSeen: string
}

export interface DevicePolicy {
  id: string
  default: boolean
  enabled: boolean
  profileType: string
}

export function toAccessApp(value: unknown): AccessApp | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  return {
    id,
    name: textOf(row.name),
    domain: textOf(row.domain),
    type: textOf(row.type),
    sessionDuration: textOf(row.session_duration),
    createdAt: textOf(row.created_at),
    updatedAt: textOf(row.updated_at),
  }
}

export function toAccessPolicy(value: unknown): AccessPolicy | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  return { id, name: textOf(row.name), decision: textOf(row.decision) }
}

export function toAccessGroup(value: unknown): AccessGroup | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  return { id, name: textOf(row.name), createdAt: textOf(row.created_at), updatedAt: textOf(row.updated_at) }
}

export function toIdentityProvider(value: unknown): IdentityProvider | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  return { id, name: textOf(row.name) || textOf(row.type), type: textOf(row.type) }
}

export function toServiceToken(value: unknown): ServiceToken | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  const secret = textOf(row.client_secret)
  return {
    id,
    name: textOf(row.name),
    clientId: textOf(row.client_id),
    expiresAt: textOf(row.expires_at),
    createdAt: textOf(row.created_at),
    ...(secret ? { clientSecret: secret } : {}),
  }
}

export function toOrganization(value: unknown): AccessOrganization {
  const row = asRecord(value)
  return {
    name: textOf(row.name),
    authDomain: textOf(row.auth_domain),
    createdAt: textOf(row.created_at),
    updatedAt: textOf(row.updated_at),
    denyUnmatchedRequests: row.deny_unmatched_requests === true,
    strictServiceTokenAuth: row.strict_service_token_auth === true,
  }
}

export function toAccessDevice(value: unknown): AccessDevice | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  return {
    id,
    name: textOf(row.name),
    deviceType: textOf(row.device_type),
    osVersion: textOf(row.os_version),
    lastSeen: textOf(row.last_seen),
  }
}

export function toDevicePolicy(value: unknown): DevicePolicy | null {
  const row = asRecord(value)
  const id = textOf(row.policy_id) || textOf(row.id)
  if (!id) return null
  return {
    id,
    default: row.default === true,
    enabled: row.enabled === true,
    profileType: textOf(row.profile_type),
  }
}

export async function listAccessApps(auth: CloudflareAuth, accountId: string): Promise<AccessApp[]> {
  const body = await cfFetch<{ result?: unknown[] }>(auth, `/accounts/${encodeURIComponent(accountId)}/access/apps`)
  return asArray(body.result).map(toAccessApp).filter((row): row is AccessApp => row !== null)
}

export async function listAppPolicies(
  auth: CloudflareAuth,
  accountId: string,
  appId: string,
): Promise<AccessPolicy[]> {
  const body = await cfFetch<{ result?: unknown[] }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}/policies`,
  )
  return asArray(body.result).map(toAccessPolicy).filter((row): row is AccessPolicy => row !== null)
}

export async function createAccessApp(
  auth: CloudflareAuth,
  accountId: string,
  input: { name: string; domain: string },
): Promise<AccessApp> {
  const body = await cfFetch<{ result?: unknown }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/access/apps`,
    { method: 'POST', body: { name: input.name, domain: input.domain, type: 'self_hosted' } },
  )
  const app = toAccessApp(body.result)
  if (!app) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare created an application without answering with it')
  return app
}

export async function deleteAccessApp(auth: CloudflareAuth, accountId: string, appId: string): Promise<void> {
  await cfFetch(auth, `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}`, {
    method: 'DELETE',
  })
}

export async function listAccessGroups(auth: CloudflareAuth, accountId: string): Promise<AccessGroup[]> {
  const body = await cfFetch<{ result?: unknown[] }>(auth, `/accounts/${encodeURIComponent(accountId)}/access/groups`)
  return asArray(body.result).map(toAccessGroup).filter((row): row is AccessGroup => row !== null)
}

export async function createAccessGroup(
  auth: CloudflareAuth,
  accountId: string,
  input: { name: string; email: string },
): Promise<AccessGroup> {
  const body = await cfFetch<{ result?: unknown }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/access/groups`,
    { method: 'POST', body: { name: input.name, include: [{ email: { email: input.email } }] } },
  )
  const group = toAccessGroup(body.result)
  if (!group) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare created a group without answering with it')
  return group
}

export async function deleteAccessGroup(auth: CloudflareAuth, accountId: string, groupId: string): Promise<void> {
  await cfFetch(auth, `/accounts/${encodeURIComponent(accountId)}/access/groups/${encodeURIComponent(groupId)}`, {
    method: 'DELETE',
  })
}

export async function listIdentityProviders(
  auth: CloudflareAuth,
  accountId: string,
): Promise<IdentityProvider[]> {
  const body = await cfFetch<{ result?: unknown[] }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/access/identity_providers`,
  )
  return asArray(body.result).map(toIdentityProvider).filter((row): row is IdentityProvider => row !== null)
}

export async function listServiceTokens(auth: CloudflareAuth, accountId: string): Promise<ServiceToken[]> {
  const body = await cfFetch<{ result?: unknown[] }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/access/service_tokens`,
  )
  return asArray(body.result).map(toServiceToken).filter((row): row is ServiceToken => row !== null)
}

export async function createServiceToken(
  auth: CloudflareAuth,
  accountId: string,
  name: string,
): Promise<ServiceToken> {
  const body = await cfFetch<{ result?: unknown }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/access/service_tokens`,
    { method: 'POST', body: { name } },
  )
  const token = toServiceToken(body.result)
  if (!token) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare created a service token without answering with it')
  return token
}

export async function deleteServiceToken(auth: CloudflareAuth, accountId: string, tokenId: string): Promise<void> {
  await cfFetch(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/access/service_tokens/${encodeURIComponent(tokenId)}`,
    { method: 'DELETE' },
  )
}

export async function readOrganization(auth: CloudflareAuth, accountId: string): Promise<AccessOrganization> {
  const body = await cfFetch<{ result?: unknown }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/access/organizations`,
  )
  return toOrganization(body.result)
}

export async function listDevices(auth: CloudflareAuth, accountId: string): Promise<AccessDevice[]> {
  const body = await cfFetch<{ result?: unknown[] }>(auth, `/accounts/${encodeURIComponent(accountId)}/devices`)
  return asArray(body.result).map(toAccessDevice).filter((row): row is AccessDevice => row !== null)
}

export async function listDevicePolicies(auth: CloudflareAuth, accountId: string): Promise<DevicePolicy[]> {
  const body = await cfFetch<{ result?: unknown[] }>(
    auth,
    `/accounts/${encodeURIComponent(accountId)}/devices/policies`,
  )
  return asArray(body.result).map(toDevicePolicy).filter((row): row is DevicePolicy => row !== null)
}
