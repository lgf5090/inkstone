/**
 * `GET`, `POST` and `DELETE /api/todos/mail-token` — the address an account posts mail to.
 *
 * One address per account, so `POST` both issues the first one and rotates an existing one: the old
 * token stops resolving in the same statement that writes the new one. `GET` reads the address back,
 * which is why the token is stored rather than hashed — the settings screen has to be able to show
 * it after the fact. `DELETE` removes it; mail addressed to a revoked token is dropped by the
 * inbound handler exactly like mail to a token that never existed.
 *
 * The domain comes from `MAIL_DOMAIN`, and an unset or malformed value is a 503 with the reason
 * spelled out rather than an address shaped around an empty domain. Reads answer 503 too: an empty
 * address list would be indistinguishable from "no address issued yet".
 *
 * Registered before the task router because that router owns `/:id`; this file only adapts HTTP and
 * leaves the queries to `todos/schema.ts`, where the table lives.
 */

import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import { requireAuth } from '../middleware/auth'
import { mailAddress, mailDomain, newMailToken } from '../email/inbound'
import { loadMailToken, revokeMailToken, saveMailToken } from '../todos/schema'

/** How many address changes one account may make in a minute; a rotation is rare and scriptable. */
export const MAIL_TOKEN_BUDGET_PER_MINUTE = 10

const takeBudget = createMinuteBudget(
  MAIL_TOKEN_BUDGET_PER_MINUTE,
  'Too many mail-address changes at once. Try again in a minute.',
)

/** The domain an address may be built on, or the 503 that says why there is none. */
function requiredMailDomain(env: AppBindings['Bindings']): string {
  const domain = mailDomain(env)
  if (domain) return domain
  throw new ApiError(
    503,
    'server_misconfigured',
    'Email-to-task is unavailable: MAIL_DOMAIN must be set to the bare domain Email Routing delivers to (for example mail.example.com).',
  )
}

export const todoMailRoutes = new Hono<AppBindings>()

todoMailRoutes.use('*', requireAuth)

todoMailRoutes.get('/', async (c) => {
  const domain = requiredMailDomain(c.env)
  const row = await loadMailToken(c.env.DB, c.get('userId'))
  return c.json({
    address: row ? mailAddress(domain, row.token) : null,
    createdAt: row?.created_at ?? null,
  })
})

todoMailRoutes.post('/', async (c) => {
  const domain = requiredMailDomain(c.env)
  takeBudget(c.get('userId'))
  const token = newMailToken()
  const now = Date.now()
  await saveMailToken(c.env.DB, c.get('userId'), token, now)
  return c.json({ address: mailAddress(domain, token), createdAt: now }, 201)
})

todoMailRoutes.delete('/', async (c) => {
  takeBudget(c.get('userId'))
  // Deliberately does not need MAIL_DOMAIN: revoking an address must keep working on a deployment
  // whose configuration has since changed, or the row would be stranded.
  if (!(await revokeMailToken(c.env.DB, c.get('userId')))) {
    throw ApiError.notFound('No email-to-task address is set up for this account.')
  }
  return c.json({ revoked: true })
})
