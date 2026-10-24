import { Hono, type Context } from 'hono'
import { EMAIL_SCHEDULE_MAX_MS, EMAIL_SCHEDULE_OPERATION_MAX_CHARS } from '@shared/email/model'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth, requireOwner } from '../middleware/auth'
import type { AppBindings } from '../env'
import { getEmailAccount, type EmailAccountRow } from '../email/account-store'
import {
  cancelScheduledSend,
  listScheduledSends,
  scheduleDraftSend,
} from '../email/scheduled-send'

type Ctx = Context<AppBindings>

async function requireAccount(c: Ctx): Promise<EmailAccountRow> {
  const id = c.req.param('id') ?? ''
  if (!isValidId(id)) throw new ApiError(404, 'email_account_not_found', 'Mailbox not found')
  const account = await getEmailAccount(c.env.DB, c.get('userId'), id)
  if (!account) throw new ApiError(404, 'email_account_not_found', 'Mailbox not found')
  return account
}

function sendAtValue(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw ApiError.badRequest('A send time is required')
  }
  const parsed = typeof value === 'number'
    ? value
    : /^\d+$/.test(value)
      ? Number(value)
      : Date.parse(value)
  if (!Number.isSafeInteger(parsed)) throw ApiError.badRequest('The send time is not a valid date')
  const now = Date.now()
  if (parsed <= now) throw ApiError.badRequest('The send time must be in the future')
  if (parsed > now + EMAIL_SCHEDULE_MAX_MS) {
    throw ApiError.badRequest('The send time must be within one year')
  }
  return parsed
}

function operationIdValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw ApiError.badRequest('The operation id must be a string')
  const operation = value.trim()
  if (!operation) return undefined
  if (operation.length > EMAIL_SCHEDULE_OPERATION_MAX_CHARS) {
    throw ApiError.badRequest('The operation id is too long')
  }
  return operation
}

export const emailScheduleRoutes = new Hono<AppBindings>()

emailScheduleRoutes.use('*', requireAuth)
emailScheduleRoutes.use('*', requireOwner)

emailScheduleRoutes.get('/accounts/:id/scheduled', async (c) => {
  const account = await requireAccount(c)
  const jobs = await listScheduledSends(c.env, c.get('userId'), account.id)
  return c.json(jobs)
})

emailScheduleRoutes.post('/accounts/:id/drafts/:draftId/schedule', async (c) => {
  const account = await requireAccount(c)
  const draftId = c.req.param('draftId') ?? ''
  if (!isValidId(draftId)) throw ApiError.notFound('Draft not found')
  const body = await readJson<{ sendAt?: unknown; operationId?: unknown }>(c, JSON_BODY_LIMITS.small)
  const sendAt = sendAtValue(body.sendAt)
  const operationId = operationIdValue(body.operationId)
  const job = await scheduleDraftSend(c.env, c.get('userId'), account.id, draftId, sendAt, operationId)
  return c.json(job, 201)
})

emailScheduleRoutes.delete('/accounts/:id/scheduled/:jobId', async (c) => {
  const account = await requireAccount(c)
  const jobId = c.req.param('jobId') ?? ''
  if (!isValidId(jobId)) throw ApiError.notFound('Scheduled send not found')
  const cancelled = await cancelScheduledSend(c.env, c.get('userId'), jobId, account.id)
  if (!cancelled) throw ApiError.notFound('Scheduled send not found')
  return c.body(null, 204)
})
