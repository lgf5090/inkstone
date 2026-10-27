/**
 * `/api/cloudflare/dns` — zones, records, zone settings, cache, status and rulesets.
 *
 * Every domain-addressed call starts at `findDnsZone`: it lists the reader's own accounts and matches
 * the name exactly, so a domain belonging to somebody else's account is a 404 rather than a request
 * with this reader's token. Rule phases are accepted as a fixed set of slugs and mapped to Cloudflare
 * phases here; a raw phase in the URL would let a caller name any ruleset path it liked.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import {
  accountHasFeature,
  assertNotDemo,
  loadAccount,
  type LoadedAccount,
} from '../../cloudflare/accounts'
import { createAuditLog } from '../../cloudflare/audit'
import { cfFetch, cfFetchAll } from '../../cloudflare/cf-api'
import {
  findDnsZone,
  listDnsZones,
  parseDomainList,
  parseRecordInput,
  parseRuleInput,
  parseRulePhase,
  parseSettingsPatch,
  RULE_PHASES,
  SETTING_PATHS,
  toDnsRecord,
  toDnsRule,
  type DnsRule,
  type RulePhase,
} from '../../cloudflare/dns'

export const dnsRouter = new Hono<AppBindings>()

type AppContext = Context<AppBindings>

interface BatchItem {
  name: string
  success: boolean
  zone_id?: string
  name_servers?: string[]
  error?: string
}

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Cloudflare refused the request'
}

async function batch<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<BatchItem>,
): Promise<BatchItem[]> {
  const results: BatchItem[] = []
  for (let start = 0; start < items.length; start += limit) {
    results.push(...await Promise.all(items.slice(start, start + limit).map(task)))
  }
  return results
}

dnsRouter.get('/domains', async (c) => {
  const userId = c.get('userId')
  const { zones, accounts } = await listDnsZones(c.env, userId)
  return c.json({
    domains: zones,
    accounts: accounts.map(({ row }) => ({
      id: row.id,
      name: row.name,
      canCreateZone: Boolean(row.cf_account_id),
    })),
  })
})

dnsRouter.post('/domains', async (c) => {
  const userId = c.get('userId')
  const body = await readBody(c)
  const names = parseDomainList(body.names, 'names')
  if (typeof body.account_id !== 'string' || !body.account_id) {
    throw ApiError.badRequest('account_id is required')
  }
  const account = await loadAccount(c.env, userId, body.account_id)
  if (!accountHasFeature(account.row, 'dns')) {
    throw ApiError.badRequest('That account does not have the DNS feature enabled')
  }
  const cfAccountId = account.row.cf_account_id
  if (!cfAccountId) throw ApiError.badRequest('That account has no Cloudflare account id yet')
  await assertNotDemo(c.env, userId, account.row.id)
  const type = body.type === 'partial' ? 'partial' : 'full'

  const results = await batch(names, 3, async (name) => {
    try {
      const response = await cfFetch<{ result?: { id?: string; name_servers?: string[] } }>(
        account.auth,
        '/zones',
        { method: 'POST', body: { name, account: { id: cfAccountId }, type } },
      )
      return {
        name,
        success: true,
        zone_id: response.result?.id ?? '',
        name_servers: response.result?.name_servers ?? [],
      }
    } catch (error) {
      return { name, success: false, error: errorText(error) }
    }
  })

  const succeeded = results.filter((item) => item.success).length
  await createAuditLog(
    c.env,
    userId,
    account.row.id,
    'create_zone',
    `account/${account.row.id}`,
    `created ${succeeded}/${names.length} zones (${type})`,
    succeeded > 0 ? 'success' : 'error',
  )
  return c.json(
    { total: names.length, succeeded, failed: names.length - succeeded, results },
    201,
  )
})

dnsRouter.delete('/domains', async (c) => {
  const userId = c.get('userId')
  const body = await readBody(c)
  const domains = parseDomainList(body.domains, 'domains')

  const results = await batch(domains, 3, async (name) => {
    try {
      const target = await findDnsZone(c.env, userId, name)
      await assertNotDemo(c.env, userId, target.account.row.id)
      await cfFetch(target.account.auth, `/zones/${target.zoneId}`, { method: 'DELETE' })
      await createAuditLog(
        c.env,
        userId,
        target.account.row.id,
        'delete_zone',
        target.zoneName,
        'zone deleted',
        'success',
      )
      return { name, success: true }
    } catch (error) {
      return { name, success: false, error: errorText(error) }
    }
  })

  const succeeded = results.filter((item) => item.success).length
  return c.json({ total: domains.length, succeeded, failed: domains.length - succeeded, results })
})

dnsRouter.get('/domains/:domain/records', async (c) => {
  const { account, zoneId } = await findDnsZone(c.env, c.get('userId'), c.req.param('domain'))
  const rows = await cfFetchAll<Record<string, unknown>>(account.auth, `/zones/${zoneId}/dns_records`, 100)
  return c.json(rows.map(toDnsRecord))
})

dnsRouter.post('/domains/:domain/records', async (c) => {
  const userId = c.get('userId')
  const input = parseRecordInput(await readBody(c))
  const { account, zoneId, zoneName } = await findDnsZone(c.env, userId, c.req.param('domain'))
  const response = await cfFetch<{ result?: Record<string, unknown> }>(
    account.auth,
    `/zones/${zoneId}/dns_records`,
    { method: 'POST', body: input },
  )
  if (!response.result) {
    throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare did not return the created record')
  }
  await createAuditLog(
    c.env,
    userId,
    account.row.id,
    'create_dns',
    zoneName,
    `${input.type} ${input.name} → ${input.content}`,
    'success',
  )
  return c.json(toDnsRecord(response.result), 201)
})

dnsRouter.put('/domains/:domain/records/:id', async (c) => {
  const userId = c.get('userId')
  const recordId = pathId(c.req.param('id'), 'record id')
  const input = parseRecordInput(await readBody(c))
  const { account, zoneId, zoneName } = await findDnsZone(c.env, userId, c.req.param('domain'))
  const response = await cfFetch<{ result?: Record<string, unknown> }>(
    account.auth,
    `/zones/${zoneId}/dns_records/${recordId}`,
    { method: 'PATCH', body: input },
  )
  if (!response.result) {
    throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare did not return the updated record')
  }
  await createAuditLog(
    c.env,
    userId,
    account.row.id,
    'update_dns',
    zoneName,
    `${input.type} ${input.name} → ${input.content}`,
    'success',
  )
  return c.json(toDnsRecord(response.result))
})

dnsRouter.delete('/domains/:domain/records/:id', async (c) => {
  const userId = c.get('userId')
  const recordId = pathId(c.req.param('id'), 'record id')
  const { account, zoneId, zoneName } = await findDnsZone(c.env, userId, c.req.param('domain'))
  await assertNotDemo(c.env, userId, account.row.id)
  await cfFetch(account.auth, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' })
  await createAuditLog(c.env, userId, account.row.id, 'delete_dns', zoneName, `record ${recordId}`, 'success')
  return c.json({ id: recordId })
})

dnsRouter.get('/domains/:domain/settings', async (c) => {
  const { account, zoneId } = await findDnsZone(c.env, c.get('userId'), c.req.param('domain'))
  const response = await cfFetch<{ result?: Array<{ id?: string; value?: unknown }> }>(
    account.auth,
    `/zones/${zoneId}/settings`,
  )
  const settings: Record<string, unknown> = {}
  for (const item of response.result ?? []) {
    if (typeof item.id === 'string' && item.id in SETTING_PATHS) settings[item.id] = item.value
  }
  return c.json(settings)
})

dnsRouter.patch('/domains/:domain/settings', async (c) => {
  const userId = c.get('userId')
  const entries = parseSettingsPatch(await readBody(c))
  const { account, zoneId, zoneName } = await findDnsZone(c.env, userId, c.req.param('domain'))
  const updated: string[] = []
  const failed: string[] = []
  for (const entry of entries) {
    try {
      await cfFetch(account.auth, `/zones/${zoneId}/settings/${entry.path}`, {
        method: 'PATCH',
        body: { value: entry.value },
      })
      updated.push(entry.key)
    } catch (error) {
      console.warn(`[inkstone] Cloudflare zone setting failed (${entry.key}):`, (error as Error)?.message)
      failed.push(entry.key)
    }
  }
  await createAuditLog(
    c.env,
    userId,
    account.row.id,
    'update_zone_settings',
    zoneName,
    `updated: ${updated.join(', ') || 'none'}; failed: ${failed.join(', ') || 'none'}`,
    'success',
  )
  return c.json({ updated, failed })
})

dnsRouter.patch('/domains/:domain/proxy', async (c) => {
  const userId = c.get('userId')
  const body = await readBody(c)
  if (typeof body.record_id !== 'string' || !body.record_id) {
    throw ApiError.badRequest('record_id is required')
  }
  if (typeof body.proxied !== 'boolean') throw ApiError.badRequest('proxied must be a boolean')
  const recordId = pathId(body.record_id, 'record id')
  const { account, zoneId, zoneName } = await findDnsZone(c.env, userId, c.req.param('domain'))
  await cfFetch(account.auth, `/zones/${zoneId}/dns_records/${recordId}`, {
    method: 'PATCH',
    body: { proxied: body.proxied },
  })
  await createAuditLog(
    c.env,
    userId,
    account.row.id,
    'update_dns_proxy',
    `${zoneName}/${recordId}`,
    `proxied=${body.proxied}`,
    'success',
  )
  return c.json({ success: true })
})

dnsRouter.post('/domains/:domain/purge-cache', async (c) => {
  const userId = c.get('userId')
  const body = await readBody(c)
  const everything = body.purge_everything === true
  const files = body.files
  if (everything && files !== undefined) {
    throw ApiError.badRequest('Choose either purge_everything or files, not both')
  }
  if (!everything && !Array.isArray(files)) {
    throw ApiError.badRequest('Provide purge_everything or a files array')
  }
  let purgeBody: { purge_everything: true } | { files: string[] }
  if (everything) {
    purgeBody = { purge_everything: true }
  } else {
    const urls = (files as unknown[])
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
    if (urls.length === 0) throw ApiError.badRequest('At least one URL is required')
    if (urls.length > 30) throw ApiError.badRequest('Cloudflare accepts at most 30 URLs per purge')
    for (const url of urls) {
      if (!/^https?:\/\//i.test(url)) throw ApiError.badRequest(`Not a URL: ${url}`)
      try {
        new URL(url)
      } catch {
        throw ApiError.badRequest(`Not a URL: ${url}`)
      }
    }
    purgeBody = { files: urls }
  }
  const { account, zoneId, zoneName } = await findDnsZone(c.env, userId, c.req.param('domain'))
  const response = await cfFetch<{ result?: { id?: string } }>(
    account.auth,
    `/zones/${zoneId}/purge_cache`,
    { method: 'POST', body: purgeBody },
  )
  await createAuditLog(
    c.env,
    userId,
    account.row.id,
    'purge_cache',
    zoneName,
    everything ? 'purge_everything' : `purge ${'files' in purgeBody ? purgeBody.files.length : 0} URLs`,
    'success',
  )
  return c.json({ id: response.result?.id ?? '' })
})

dnsRouter.patch('/domains/:domain/status', async (c) => {
  const userId = c.get('userId')
  const body = await readBody(c)
  if (typeof body.paused !== 'boolean') throw ApiError.badRequest('paused must be a boolean')
  const { account, zoneId, zoneName } = await findDnsZone(c.env, userId, c.req.param('domain'))
  await cfFetch(account.auth, `/zones/${zoneId}`, { method: 'PATCH', body: { paused: body.paused } })
  await createAuditLog(
    c.env,
    userId,
    account.row.id,
    'update_zone_status',
    zoneName,
    `paused=${body.paused}`,
    'success',
  )
  return c.json({ success: true })
})

interface RulesetTarget {
  scope: string
  kind: 'zone' | 'root'
  phase: string
}

function rulesetTarget(account: LoadedAccount, zoneId: string, phase: RulePhase): RulesetTarget {
  const definition = RULE_PHASES[phase]
  if (definition.scope === 'account') {
    const cfAccountId = account.row.cf_account_id
    if (!cfAccountId) {
      throw ApiError.badRequest('This rule type is account-level, but the account has no Cloudflare account id')
    }
    return { scope: `/accounts/${pathId(cfAccountId, 'Cloudflare account id')}/rulesets`, kind: 'root', phase: definition.phase }
  }
  return { scope: `/zones/${zoneId}/rulesets`, kind: 'zone', phase: definition.phase }
}

interface LoadedRuleset {
  rulesetId: string
  rules: DnsRule[]
}

/** The phase's ruleset, created on first use the way Cloudflare expects. */
async function loadRuleset(
  account: LoadedAccount,
  target: RulesetTarget,
): Promise<LoadedRuleset> {
  const listed = await cfFetch<{ result?: Array<{ id?: string; phase?: string }> }>(account.auth, target.scope)
  const existing = (listed.result ?? []).find((item) => item.phase === target.phase && item.id)
  if (existing?.id) {
    const detail = await cfFetch<{ result?: { rules?: unknown[] } }>(
      account.auth,
      `${target.scope}/${existing.id}`,
    )
    const rules = (detail.result?.rules ?? [])
      .map(toDnsRule)
      .filter((rule): rule is DnsRule => rule !== null)
    return { rulesetId: existing.id, rules }
  }
  const created = await cfFetch<{ result?: { id?: string } }>(account.auth, target.scope, {
    method: 'POST',
    body: { kind: target.kind, phase: target.phase, name: `${target.phase} rules`, rules: [] },
  })
  const rulesetId = created.result?.id
  if (!rulesetId) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare did not return a ruleset id')
  return { rulesetId, rules: [] }
}

async function putRules(
  account: LoadedAccount,
  target: RulesetTarget,
  rulesetId: string,
  rules: DnsRule[],
): Promise<DnsRule[]> {
  const response = await cfFetch<{ result?: { rules?: unknown[] } }>(
    account.auth,
    `${target.scope}/${rulesetId}`,
    { method: 'PUT', body: { rules } },
  )
  if (!response.result) {
    throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare did not return the ruleset')
  }
  return (response.result.rules ?? [])
    .map(toDnsRule)
    .filter((rule): rule is DnsRule => rule !== null)
}

function rulePayload(input: ReturnType<typeof parseRuleInput>): DnsRule {
  const rule: DnsRule = {
    expression: input.expression,
    action: input.action,
    enabled: input.enabled,
  }
  if (input.description !== undefined) rule.description = input.description
  if (input.action_parameters !== undefined) rule.action_parameters = input.action_parameters
  return rule
}

dnsRouter.get('/domains/:domain/rules/:phase', async (c) => {
  const phase = parseRulePhase(c.req.param('phase'))
  const { account, zoneId } = await findDnsZone(c.env, c.get('userId'), c.req.param('domain'))
  const ruleset = await loadRuleset(account, rulesetTarget(account, zoneId, phase))
  return c.json({ rules: ruleset.rules })
})

dnsRouter.post('/domains/:domain/rules/:phase', async (c) => {
  const userId = c.get('userId')
  const phase = parseRulePhase(c.req.param('phase'))
  const input = parseRuleInput(await readBody(c))
  const { account, zoneId, zoneName } = await findDnsZone(c.env, userId, c.req.param('domain'))
  const target = rulesetTarget(account, zoneId, phase)
  const ruleset = await loadRuleset(account, target)
  const rules = await putRules(account, target, ruleset.rulesetId, [...ruleset.rules, rulePayload(input)])
  await createAuditLog(
    c.env,
    userId,
    account.row.id,
    'create_rule',
    zoneName,
    `phase=${target.phase} action=${input.action}`,
    'success',
  )
  return c.json({ rules }, 201)
})

dnsRouter.put('/domains/:domain/rules/:phase/:ruleId', async (c) => {
  const userId = c.get('userId')
  const phase = parseRulePhase(c.req.param('phase'))
  const ruleId = pathId(c.req.param('ruleId'), 'rule id')
  const input = parseRuleInput(await readBody(c))
  const { account, zoneId, zoneName } = await findDnsZone(c.env, userId, c.req.param('domain'))
  const target = rulesetTarget(account, zoneId, phase)
  const ruleset = await loadRuleset(account, target)
  if (!ruleset.rules.some((rule) => rule.id === ruleId)) {
    throw ApiError.notFound('That rule does not exist in this phase')
  }
  const rules = ruleset.rules.map((rule) => (
    rule.id === ruleId ? { ...rule, ...rulePayload(input) } : rule
  ))
  const saved = await putRules(account, target, ruleset.rulesetId, rules)
  await createAuditLog(
    c.env,
    userId,
    account.row.id,
    'update_rule',
    zoneName,
    `phase=${target.phase} rule=${ruleId}`,
    'success',
  )
  return c.json({ rules: saved })
})

dnsRouter.delete('/domains/:domain/rules/:phase/:ruleId', async (c) => {
  const userId = c.get('userId')
  const phase = parseRulePhase(c.req.param('phase'))
  const ruleId = pathId(c.req.param('ruleId'), 'rule id')
  const { account, zoneId, zoneName } = await findDnsZone(c.env, userId, c.req.param('domain'))
  await assertNotDemo(c.env, userId, account.row.id)
  const target = rulesetTarget(account, zoneId, phase)
  const ruleset = await loadRuleset(account, target)
  if (!ruleset.rules.some((rule) => rule.id === ruleId)) {
    throw ApiError.notFound('That rule does not exist in this phase')
  }
  await putRules(
    account,
    target,
    ruleset.rulesetId,
    ruleset.rules.filter((rule) => rule.id !== ruleId),
  )
  await createAuditLog(
    c.env,
    userId,
    account.row.id,
    'delete_rule',
    zoneName,
    `phase=${target.phase} rule=${ruleId}`,
    'success',
  )
  return c.json({ deleted: ruleId })
})
