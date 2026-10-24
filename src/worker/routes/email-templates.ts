import { Hono, type Context } from 'hono'
import {
  EMAIL_TEMPLATE_MAX,
  parseEmailTemplateInput,
  parseEmailTemplatePatch,
  type EmailTemplate,
} from '@shared/email/templates'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth, requireOwner } from '../middleware/auth'
import { getEmailAccount } from '../email/account-store'
import type { EmailTemplateRow } from '../email/mailbox-store'
import { emailMailbox } from '../email/mailbox-stub'

type Ctx = Context<AppBindings>

export const emailTemplatesRoutes = new Hono<AppBindings>()

emailTemplatesRoutes.use('*', requireAuth)
emailTemplatesRoutes.use('*', requireOwner)

function mailboxNotFound(): ApiError {
  return new ApiError(404, 'email_account_not_found', 'Mailbox not found')
}

function templateNotFound(): ApiError {
  return new ApiError(404, 'not_found', 'Template not found')
}

async function requireAccount(c: Ctx, id: string) {
  if (!isValidId(id)) throw mailboxNotFound()
  const account = await getEmailAccount(c.env.DB, c.get('userId'), id)
  if (!account) throw mailboxNotFound()
  return account
}

function toTemplate(row: EmailTemplateRow): EmailTemplate {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

emailTemplatesRoutes.get('/accounts/:id/templates', async (c) => {
  const account = await requireAccount(c, c.req.param('id') ?? '')
  const templates = await emailMailbox(c.env, account.id).listTemplates()
  return c.json(templates.map(toTemplate))
})

emailTemplatesRoutes.post('/accounts/:id/templates', async (c) => {
  const account = await requireAccount(c, c.req.param('id') ?? '')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.profile)
  const input = parseEmailTemplateInput(body)
  if (!input) throw ApiError.badRequest('The template is not valid')
  const mailbox = emailMailbox(c.env, account.id)
  if ((await mailbox.countTemplates()) >= EMAIL_TEMPLATE_MAX) {
    throw new ApiError(409, 'conflict', `At most ${EMAIL_TEMPLATE_MAX} templates are allowed`)
  }
  const created = await mailbox.createTemplate(input)
  if (!created) throw new ApiError(409, 'conflict', 'A template with this name already exists')
  return c.json(toTemplate(created), 201)
})

emailTemplatesRoutes.patch('/accounts/:id/templates/:templateId', async (c) => {
  const account = await requireAccount(c, c.req.param('id') ?? '')
  const templateId = c.req.param('templateId') ?? ''
  if (!isValidId(templateId)) throw templateNotFound()
  const mailbox = emailMailbox(c.env, account.id)
  if (!(await mailbox.getTemplate(templateId))) throw templateNotFound()
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.profile)
  const patch = parseEmailTemplatePatch(body)
  if (!patch) throw ApiError.badRequest('The template is not valid')
  const updated = await mailbox.updateTemplate(templateId, patch)
  if (!updated) throw new ApiError(409, 'conflict', 'A template with this name already exists')
  return c.json(toTemplate(updated))
})

emailTemplatesRoutes.delete('/accounts/:id/templates/:templateId', async (c) => {
  const account = await requireAccount(c, c.req.param('id') ?? '')
  const templateId = c.req.param('templateId') ?? ''
  if (!isValidId(templateId)) throw templateNotFound()
  if (!(await emailMailbox(c.env, account.id).deleteTemplate(templateId))) throw templateNotFound()
  return c.body(null, 204)
})
