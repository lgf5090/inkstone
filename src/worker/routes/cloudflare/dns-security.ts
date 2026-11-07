/**
 * `/api/cloudflare/dns` extras: Page Rules, URL normalization, SSL certificate packs and legacy IP
 * Access Rules.
 *
 * These are registered on a second router under the same `/dns` prefix rather than folded into
 * `dns.ts`: the existing file owns zones/records/settings/rulesets, and each of these four uses a
 * different Cloudflare API family. Hono matches by path, and none of these paths overlap the first
 * router's.
 *
 * Every domain-addressed call starts at `findDnsZone`, exactly like `dns.ts`, so a domain belonging
 * to another reader's account is a 404 rather than an upstream call with this reader's credential.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { assertNotDemo, type LoadedAccount } from '../../cloudflare/accounts'
import { createAuditLog } from '../../cloudflare/audit'
import { cfFetch, cfFetchAllDetailed } from '../../cloudflare/cf-api'
import { findDnsZone, type ZoneTarget } from '../../cloudflare/dns'
import {
  ipAccessRulePayload,
  parseIpAccessRuleInput,
  toCertificatePack,
  toIpAccessRule,
  toPageRule,
  toUniversalSsl,
  toUrlNormalization,
  URL_NORMALIZATION_SCOPES,
  URL_NORMALIZATION_TYPES,
  type PageRule,
  type SslCertificatePack,
} from '../../cloudflare/dns-security'

export const dnsSecurityRouter = new Hono<AppBindings>()

type AppContext = Context<AppBindings>

async function readBody(c: AppContext): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw ApiError.badRequest('A JSON object body is required')
  }
  return body as Record<string, unknown>
}

function pathId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw ApiError.badRequest(`Invalid ${label}`)
  return value
}

async function zone(c: AppContext): Promise<ZoneTarget & { account: LoadedAccount }> {
  return findDnsZone(c.env, c.get('userId'), c.req.param('domain') ?? '')
}

async function listPageRules(target: ZoneTarget): Promise<PageRule[]> {
  const body = await cfFetch<{ result?: unknown[] }>(
    target.account.auth,
    `/zones/${target.zoneId}/pagerules?per_page=100`,
  )
  return (body.result ?? [])
    .map(toPageRule)
    .filter((rule): rule is PageRule => rule !== null)
}

// ---------------------------------------------------------------------------------------------
// Page Rules (legacy)
// ---------------------------------------------------------------------------------------------

dnsSecurityRouter.get('/domains/:domain/page-rules', async (c) => {
  const target = await zone(c)
  return c.json({ pageRules: await listPageRules(target) })
})

dnsSecurityRouter.patch('/domains/:domain/page-rules/:id', async (c) => {
  const userId = c.get('userId')
  const ruleId = pathId(c.req.param('id'), 'page rule id')
  const body = await readBody(c)
  if (body.status !== 'active' && body.status !== 'disabled') {
    throw ApiError.badRequest('status must be "active" or "disabled"')
  }
  const target = await zone(c)
  const result = await cfFetch<{ result?: Record<string, unknown> }>(
    target.account.auth,
    `/zones/${target.zoneId}/pagerules/${encodeURIComponent(ruleId)}`,
    { method: 'PATCH', body: { status: body.status } },
  )
  await createAuditLog(
    c.env,
    userId,
    target.account.row.id,
    'update_page_rule',
    target.zoneName,
    `${ruleId} status=${body.status}`,
    'success',
  )
  return c.json(toPageRule(result.result ?? {}) ?? { id: ruleId })
})

dnsSecurityRouter.delete('/domains/:domain/page-rules/:id', async (c) => {
  const userId = c.get('userId')
  const ruleId = pathId(c.req.param('id'), 'page rule id')
  const target = await zone(c)
  await assertNotDemo(c.env, userId, target.account.row.id)
  await cfFetch(
    target.account.auth,
    `/zones/${target.zoneId}/pagerules/${encodeURIComponent(ruleId)}`,
    { method: 'DELETE' },
  )
  await createAuditLog(c.env, userId, target.account.row.id, 'delete_page_rule', target.zoneName, ruleId, 'success')
  return c.json({ deleted: ruleId })
})

// ---------------------------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------------------------

dnsSecurityRouter.get('/domains/:domain/url-normalization', async (c) => {
  const target = await zone(c)
  const body = await cfFetch<{ result?: unknown }>(
    target.account.auth,
    `/zones/${target.zoneId}/url_normalization`,
  )
  return c.json(toUrlNormalization(body.result))
})

dnsSecurityRouter.put('/domains/:domain/url-normalization', async (c) => {
  const userId = c.get('userId')
  const body = await readBody(c)
  if (!URL_NORMALIZATION_TYPES.includes(body.type as (typeof URL_NORMALIZATION_TYPES)[number])) {
    throw ApiError.badRequest(`type must be one of ${URL_NORMALIZATION_TYPES.join(', ')}`)
  }
  if (!URL_NORMALIZATION_SCOPES.includes(body.scope as (typeof URL_NORMALIZATION_SCOPES)[number])) {
    throw ApiError.badRequest(`scope must be one of ${URL_NORMALIZATION_SCOPES.join(', ')}`)
  }
  const target = await zone(c)
  const result = await cfFetch<{ result?: unknown }>(
    target.account.auth,
    `/zones/${target.zoneId}/url_normalization`,
    { method: 'PUT', body: { type: body.type, scope: body.scope } },
  )
  await createAuditLog(
    c.env,
    userId,
    target.account.row.id,
    'update_url_normalization',
    target.zoneName,
    `type=${String(body.type)} scope=${String(body.scope)}`,
    'success',
  )
  return c.json(toUrlNormalization(result.result))
})

// ---------------------------------------------------------------------------------------------
// SSL certificates and Universal SSL
// ---------------------------------------------------------------------------------------------

dnsSecurityRouter.get('/domains/:domain/ssl/certificates', async (c) => {
  const target = await zone(c)
  const body = await cfFetch<{ result?: unknown[] }>(
    target.account.auth,
    `/zones/${target.zoneId}/ssl/certificate_packs?status=all`,
  )
  const packs = (body.result ?? [])
    .map(toCertificatePack)
    .filter((pack): pack is SslCertificatePack => pack !== null)
  return c.json({ certificates: packs })
})

dnsSecurityRouter.delete('/domains/:domain/ssl/certificates/:id', async (c) => {
  const userId = c.get('userId')
  const packId = pathId(c.req.param('id'), 'certificate pack id')
  const target = await zone(c)
  await assertNotDemo(c.env, userId, target.account.row.id)
  await cfFetch(
    target.account.auth,
    `/zones/${target.zoneId}/ssl/certificate_packs/${encodeURIComponent(packId)}`,
    { method: 'DELETE' },
  )
  await createAuditLog(
    c.env,
    userId,
    target.account.row.id,
    'delete_certificate_pack',
    target.zoneName,
    packId,
    'success',
  )
  return c.json({ deleted: packId })
})

dnsSecurityRouter.get('/domains/:domain/ssl/universal', async (c) => {
  const target = await zone(c)
  const body = await cfFetch<{ result?: unknown }>(
    target.account.auth,
    `/zones/${target.zoneId}/ssl/universal/settings`,
  )
  return c.json(toUniversalSsl(body.result))
})

dnsSecurityRouter.patch('/domains/:domain/ssl/universal', async (c) => {
  const userId = c.get('userId')
  const body = await readBody(c)
  if (typeof body.enabled !== 'boolean') throw ApiError.badRequest('enabled must be a boolean')
  const target = await zone(c)
  const result = await cfFetch<{ result?: unknown }>(
    target.account.auth,
    `/zones/${target.zoneId}/ssl/universal/settings`,
    { method: 'PATCH', body: { enabled: body.enabled } },
  )
  await createAuditLog(
    c.env,
    userId,
    target.account.row.id,
    'update_universal_ssl',
    target.zoneName,
    `enabled=${body.enabled}`,
    'success',
  )
  return c.json(toUniversalSsl(result.result))
})

// ---------------------------------------------------------------------------------------------
// IP Access Rules (legacy firewall)
// ---------------------------------------------------------------------------------------------

dnsSecurityRouter.get('/domains/:domain/ip-access-rules', async (c) => {
  const target = await zone(c)
  const listing = await cfFetchAllDetailed<Record<string, unknown>>(
    target.account.auth,
    `/zones/${target.zoneId}/firewall/access_rules/rules`,
    100,
  )
  return c.json({
    rules: listing.items.map(toIpAccessRule).filter((rule) => rule !== null),
    truncated: listing.truncated,
  })
})

dnsSecurityRouter.post('/domains/:domain/ip-access-rules', async (c) => {
  const userId = c.get('userId')
  const input = parseIpAccessRuleInput(await readBody(c), false)
  const target = await zone(c)
  await assertNotDemo(c.env, userId, target.account.row.id)
  const result = await cfFetch<{ result?: unknown }>(
    target.account.auth,
    `/zones/${target.zoneId}/firewall/access_rules/rules`,
    { method: 'POST', body: ipAccessRulePayload(input) },
  )
  await createAuditLog(
    c.env,
    userId,
    target.account.row.id,
    'create_ip_access_rule',
    target.zoneName,
    `${input.mode} ${input.target} ${input.value}`,
    'success',
  )
  return c.json(toIpAccessRule(result.result))
})

dnsSecurityRouter.patch('/domains/:domain/ip-access-rules/:id', async (c) => {
  const userId = c.get('userId')
  const ruleId = pathId(c.req.param('id'), 'access rule id')
  const input = parseIpAccessRuleInput(await readBody(c), true)
  if (Object.keys(input).length === 0) throw ApiError.badRequest('No fields were supplied')
  const target = await zone(c)
  const result = await cfFetch<{ result?: unknown }>(
    target.account.auth,
    `/zones/${target.zoneId}/firewall/access_rules/rules/${encodeURIComponent(ruleId)}`,
    { method: 'PATCH', body: ipAccessRulePayload(input) },
  )
  await createAuditLog(
    c.env,
    userId,
    target.account.row.id,
    'update_ip_access_rule',
    target.zoneName,
    `${ruleId} mode=${input.mode ?? 'unchanged'}`,
    'success',
  )
  return c.json(toIpAccessRule(result.result))
})

dnsSecurityRouter.delete('/domains/:domain/ip-access-rules/:id', async (c) => {
  const userId = c.get('userId')
  const ruleId = pathId(c.req.param('id'), 'access rule id')
  const target = await zone(c)
  await assertNotDemo(c.env, userId, target.account.row.id)
  await cfFetch(
    target.account.auth,
    `/zones/${target.zoneId}/firewall/access_rules/rules/${encodeURIComponent(ruleId)}`,
    { method: 'DELETE' },
  )
  await createAuditLog(
    c.env,
    userId,
    target.account.row.id,
    'delete_ip_access_rule',
    target.zoneName,
    ruleId,
    'success',
  )
  return c.json({ deleted: ruleId })
})
