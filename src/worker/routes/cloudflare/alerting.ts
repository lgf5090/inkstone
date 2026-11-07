/**
 * `/api/cloudflare/alerting` — notification policies for one of the reader's accounts.
 *
 * Reads are account-scoped; writes are audited and refused for demo accounts. The route never touches
 * the auto-created billing-budget policy unless the reader explicitly edits or deletes it.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { readJson } from '../../lib/request'
import { assertNotDemo, loadAccount, type LoadedAccount } from '../../cloudflare/accounts'
import { createAuditLog } from '../../cloudflare/audit'
import {
  createAlertPolicy,
  deleteAlertPolicy,
  listAlertPolicies,
  listAlertTypes,
  updateAlertPolicy,
  type AlertPolicyInput,
} from '../../cloudflare/alerting'

export const alertingRouter = new Hono<AppBindings>()

type AppContext = import('hono').Context<AppBindings>

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const EMAIL = /^[^@\s]{1,120}@[^@\s]{1,120}$/

function pathId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw ApiError.badRequest(`Invalid ${label}`)
  return value
}

function requiredText(value: unknown, label: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim()) throw ApiError.badRequest(`${label} is required`)
  const text = value.trim()
  if (text.length > max) throw ApiError.badRequest(`${label} is too long`)
  return text
}

function parseInput(body: Record<string, unknown>): AlertPolicyInput {
  const emails = Array.isArray(body.emails) ? body.emails : []
  if (emails.length === 0) throw ApiError.badRequest('At least one recipient email is required')
  if (emails.length > 20) throw ApiError.badRequest('At most 20 recipient emails are allowed')
  const clean = emails.map((value) => {
    if (typeof value !== 'string' || !EMAIL.test(value.trim())) throw ApiError.badRequest('Invalid recipient email')
    return value.trim()
  })
  return {
    name: requiredText(body.name, 'Policy name'),
    description: typeof body.description === 'string' ? body.description.trim().slice(0, 256) : '',
    alertType: requiredText(body.alertType, 'Alert type'),
    enabled: body.enabled === true,
    emails: clean,
  }
}

async function loadAlertingAccount(c: AppContext): Promise<LoadedAccount> {
  const account = await loadAccount(c.env, c.get('userId'), c.req.param('accountId') ?? '')
  if (!account.row.cf_account_id) throw ApiError.badRequest('That account has no Cloudflare account id yet')
  return account
}

async function auditWrite(c: AppContext, accountId: string, action: string, target: string, detail: string): Promise<void> {
  await createAuditLog(c.env, c.get('userId'), accountId, action, target, detail, 'success')
}

alertingRouter.get('/:accountId/policies', async (c) => {
  const account = await loadAlertingAccount(c)
  return c.json({ policies: await listAlertPolicies(account.auth, account.row.cf_account_id ?? '') })
})

alertingRouter.get('/:accountId/available-alerts', async (c) => {
  const account = await loadAlertingAccount(c)
  return c.json({ alerts: await listAlertTypes(account.auth, account.row.cf_account_id ?? '') })
})

alertingRouter.post('/:accountId/policies', async (c) => {
  const account = await loadAlertingAccount(c)
  const input = parseInput(await readJson<Record<string, unknown>>(c))
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const policy = await createAlertPolicy(account.auth, account.row.cf_account_id ?? '', input)
  await auditWrite(c, account.row.id, 'create_alert_policy', policy.id, policy.name)
  return c.json(policy, 201)
})

alertingRouter.put('/:accountId/policies/:policyId', async (c) => {
  const account = await loadAlertingAccount(c)
  const policyId = pathId(c.req.param('policyId'), 'policy id')
  const input = parseInput(await readJson<Record<string, unknown>>(c))
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await updateAlertPolicy(account.auth, account.row.cf_account_id ?? '', policyId, input)
  await auditWrite(c, account.row.id, 'update_alert_policy', policyId, input.name)
  return c.json({ saved: true })
})

alertingRouter.delete('/:accountId/policies/:policyId', async (c) => {
  const account = await loadAlertingAccount(c)
  const policyId = pathId(c.req.param('policyId'), 'policy id')
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await deleteAlertPolicy(account.auth, account.row.cf_account_id ?? '', policyId)
  await auditWrite(c, account.row.id, 'delete_alert_policy', policyId, 'policy deleted')
  return c.json({ deleted: true })
})
