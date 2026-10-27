/**
 * `/api/cloudflare/tunnels` — tunnels, their ingress, the origin wizard, and zone rulesets.
 *
 * Everything is addressed through an account the reader owns, and the account's Cloudflare id is the
 * only thing sent upstream. Tunnel ids are validated before they reach a path. The rules endpoints
 * live here under `/accounts/:id/zones/:zoneId/rules/:phase` because this file cannot mount a second
 * router at `/dns`; the aggregate router does not expose that DNS-shaped address yet.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { assertNotDemo, loadAccount } from '../../cloudflare/accounts'
import { createAuditLog } from '../../cloudflare/audit'
import {
  createTunnel,
  createZoneRule,
  deleteTunnel,
  deleteZoneRule,
  listTunnelAccounts,
  listTunnelConnections,
  listTunnelHostnames,
  listTunnels,
  listZoneRules,
  listZonesForAccount,
  parseIngress,
  parseRuleInput,
  parseRulePhase,
  parseTunnelId,
  parseTunnelName,
  parseWizardInput,
  runOriginWizard,
  saveTunnelConfig,
  tunnelConfig,
  tunnelToken,
  updateZoneRule,
} from '../../cloudflare/tunnels'

export const tunnelsRouter = new Hono<AppBindings>()

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

tunnelsRouter.get('/accounts', async (c) => {
  return c.json(await listTunnelAccounts(c.env, c.get('userId')))
})

tunnelsRouter.get('/accounts/:id/zones', async (c) => {
  const account = await loadAccount(c.env, c.get('userId'), pathId(c.req.param('id'), 'account id'))
  return c.json(await listZonesForAccount(account))
})

tunnelsRouter.get('/accounts/:id/tunnels', async (c) => {
  const account = await loadAccount(c.env, c.get('userId'), pathId(c.req.param('id'), 'account id'))
  return c.json(await listTunnels(account))
})

tunnelsRouter.post('/accounts/:id/tunnels', async (c) => {
  const userId = c.get('userId')
  const body = await readBody(c)
  const name = parseTunnelName(body.name)
  const account = await loadAccount(c.env, userId, pathId(c.req.param('id'), 'account id'))
  await assertNotDemo(c.env, userId, account.row.id)
  const tunnel = await createTunnel(account, name)
  await createAuditLog(c.env, userId, account.row.id, 'create_tunnel', tunnel.name, `tunnel_id=${tunnel.id}`, 'success')
  return c.json(tunnel, 201)
})

tunnelsRouter.delete('/accounts/:id/tunnels/:tunnelId', async (c) => {
  const userId = c.get('userId')
  const account = await loadAccount(c.env, userId, pathId(c.req.param('id'), 'account id'))
  const tunnelId = parseTunnelId(c.req.param('tunnelId'))
  await assertNotDemo(c.env, userId, account.row.id)
  await deleteTunnel(account, tunnelId)
  await createAuditLog(c.env, userId, account.row.id, 'delete_tunnel', tunnelId, null, 'success')
  return c.json({ id: tunnelId })
})

tunnelsRouter.get('/accounts/:id/tunnels/:tunnelId/token', async (c) => {
  const userId = c.get('userId')
  const account = await loadAccount(c.env, userId, pathId(c.req.param('id'), 'account id'))
  const tunnelId = parseTunnelId(c.req.param('tunnelId'))
  await assertNotDemo(c.env, userId, account.row.id)
  return c.json({ token: await tunnelToken(account, tunnelId) })
})

tunnelsRouter.get('/accounts/:id/tunnels/:tunnelId/connections', async (c) => {
  const account = await loadAccount(c.env, c.get('userId'), pathId(c.req.param('id'), 'account id'))
  const tunnelId = parseTunnelId(c.req.param('tunnelId'))
  return c.json(await listTunnelConnections(account, tunnelId))
})

tunnelsRouter.get('/accounts/:id/tunnels/:tunnelId/config', async (c) => {
  const account = await loadAccount(c.env, c.get('userId'), pathId(c.req.param('id'), 'account id'))
  const tunnelId = parseTunnelId(c.req.param('tunnelId'))
  return c.json({ ingress: await tunnelConfig(account, tunnelId) })
})

tunnelsRouter.put('/accounts/:id/tunnels/:tunnelId/config', async (c) => {
  const userId = c.get('userId')
  const body = await readBody(c)
  const ingress = parseIngress(body.ingress)
  const account = await loadAccount(c.env, userId, pathId(c.req.param('id'), 'account id'))
  const tunnelId = parseTunnelId(c.req.param('tunnelId'))
  await assertNotDemo(c.env, userId, account.row.id)
  const saved = await saveTunnelConfig(account, tunnelId, ingress)
  await createAuditLog(
    c.env,
    userId,
    account.row.id,
    'update_tunnel_config',
    tunnelId,
    `${saved.length} ingress rules`,
    'success',
  )
  return c.json({ ingress: saved })
})

tunnelsRouter.get('/accounts/:id/tunnels/:tunnelId/hostnames', async (c) => {
  const account = await loadAccount(c.env, c.get('userId'), pathId(c.req.param('id'), 'account id'))
  const tunnelId = parseTunnelId(c.req.param('tunnelId'))
  return c.json({ hostnames: await listTunnelHostnames(account, tunnelId) })
})

tunnelsRouter.post('/accounts/:id/wizard', async (c) => {
  const userId = c.get('userId')
  const input = parseWizardInput(await readBody(c))
  const account = await loadAccount(c.env, userId, pathId(c.req.param('id'), 'account id'))
  await assertNotDemo(c.env, userId, account.row.id)
  const result = await runOriginWizard(account, input)
  await createAuditLog(
    c.env,
    userId,
    account.row.id,
    'wizard_origin',
    result.hostname,
    `mode=${result.mode} tunnel=${result.tunnelId} port=${input.port}`,
    'success',
  )
  return c.json(result, 201)
})

/* -------------------------------------------------------------------------------------------------
 * Rulesets, addressable without the DNS screen
 * ---------------------------------------------------------------------------------------------- */

tunnelsRouter.get('/accounts/:id/zones/:zoneId/rules/:phase', async (c) => {
  const phase = parseRulePhase(c.req.param('phase'))
  const account = await loadAccount(c.env, c.get('userId'), pathId(c.req.param('id'), 'account id'))
  const { rules } = await listZoneRules(account, c.req.param('zoneId'), phase)
  return c.json({ rules })
})

tunnelsRouter.post('/accounts/:id/zones/:zoneId/rules/:phase', async (c) => {
  const userId = c.get('userId')
  const phase = parseRulePhase(c.req.param('phase'))
  const input = parseRuleInput(await readBody(c))
  const account = await loadAccount(c.env, userId, pathId(c.req.param('id'), 'account id'))
  await assertNotDemo(c.env, userId, account.row.id)
  const { zone, rules } = await createZoneRule(account, c.req.param('zoneId'), phase, input)
  await createAuditLog(
    c.env,
    userId,
    account.row.id,
    'create_rule',
    zone.name,
    `phase=${phase} action=${input.action}`,
    'success',
  )
  return c.json({ rules }, 201)
})

tunnelsRouter.put('/accounts/:id/zones/:zoneId/rules/:phase/:ruleId', async (c) => {
  const userId = c.get('userId')
  const phase = parseRulePhase(c.req.param('phase'))
  const ruleId = pathId(c.req.param('ruleId'), 'rule id')
  const input = parseRuleInput(await readBody(c))
  const account = await loadAccount(c.env, userId, pathId(c.req.param('id'), 'account id'))
  await assertNotDemo(c.env, userId, account.row.id)
  const { zone, rules } = await updateZoneRule(account, c.req.param('zoneId'), phase, ruleId, input)
  await createAuditLog(
    c.env,
    userId,
    account.row.id,
    'update_rule',
    zone.name,
    `phase=${phase} rule=${ruleId}`,
    'success',
  )
  return c.json({ rules })
})

tunnelsRouter.delete('/accounts/:id/zones/:zoneId/rules/:phase/:ruleId', async (c) => {
  const userId = c.get('userId')
  const phase = parseRulePhase(c.req.param('phase'))
  const ruleId = pathId(c.req.param('ruleId'), 'rule id')
  const account = await loadAccount(c.env, userId, pathId(c.req.param('id'), 'account id'))
  await assertNotDemo(c.env, userId, account.row.id)
  const { zone } = await deleteZoneRule(account, c.req.param('zoneId'), phase, ruleId)
  await createAuditLog(
    c.env,
    userId,
    account.row.id,
    'delete_rule',
    zone.name,
    `phase=${phase} rule=${ruleId}`,
    'success',
  )
  return c.json({ deleted: ruleId })
})
