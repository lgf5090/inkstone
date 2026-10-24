import { Hono, type Context } from 'hono'
import {
  EMAIL_SAVED_SEARCH_MAX,
  parseEmailSavedSearchInput,
  parseEmailSavedSearchPatch,
  type EmailSavedSearch,
} from '@shared/email/searches'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth, requireOwner } from '../middleware/auth'
import { getEmailAccount } from '../email/account-store'
import type { EmailSavedSearchRow } from '../email/mailbox-store'
import { emailMailbox } from '../email/mailbox-stub'

type Ctx = Context<AppBindings>

export const emailSearchesRoutes = new Hono<AppBindings>()

emailSearchesRoutes.use('*', requireAuth)
emailSearchesRoutes.use('*', requireOwner)

function mailboxNotFound(): ApiError {
  return new ApiError(404, 'email_account_not_found', 'Mailbox not found')
}

function searchNotFound(): ApiError {
  return new ApiError(404, 'not_found', 'Saved search not found')
}

async function requireAccount(c: Ctx, id: string) {
  if (!isValidId(id)) throw mailboxNotFound()
  const account = await getEmailAccount(c.env.DB, c.get('userId'), id)
  if (!account) throw mailboxNotFound()
  return account
}

function toSearch(row: EmailSavedSearchRow): EmailSavedSearch {
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

emailSearchesRoutes.get('/accounts/:id/searches', async (c) => {
  const account = await requireAccount(c, c.req.param('id') ?? '')
  const searches = await emailMailbox(c.env, account.id).listSavedSearches()
  return c.json(searches.map(toSearch))
})

emailSearchesRoutes.post('/accounts/:id/searches', async (c) => {
  const account = await requireAccount(c, c.req.param('id') ?? '')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const input = parseEmailSavedSearchInput(body)
  if (!input) throw ApiError.badRequest('The saved search is not valid')
  const mailbox = emailMailbox(c.env, account.id)
  if ((await mailbox.countSavedSearches()) >= EMAIL_SAVED_SEARCH_MAX) {
    throw new ApiError(409, 'conflict', `At most ${EMAIL_SAVED_SEARCH_MAX} saved searches are allowed`)
  }
  const created = await mailbox.createSavedSearch(input)
  if (!created) throw new ApiError(409, 'conflict', 'A saved search with this name already exists')
  return c.json(toSearch(created), 201)
})

emailSearchesRoutes.patch('/accounts/:id/searches/:searchId', async (c) => {
  const account = await requireAccount(c, c.req.param('id') ?? '')
  const searchId = c.req.param('searchId') ?? ''
  if (!isValidId(searchId)) throw searchNotFound()
  const mailbox = emailMailbox(c.env, account.id)
  if (!(await mailbox.getSavedSearch(searchId))) throw searchNotFound()
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const patch = parseEmailSavedSearchPatch(body)
  if (!patch) throw ApiError.badRequest('The saved search is not valid')
  const updated = await mailbox.updateSavedSearch(searchId, patch)
  if (!updated) throw new ApiError(409, 'conflict', 'A saved search with this name already exists')
  return c.json(toSearch(updated))
})

emailSearchesRoutes.delete('/accounts/:id/searches/:searchId', async (c) => {
  const account = await requireAccount(c, c.req.param('id') ?? '')
  const searchId = c.req.param('searchId') ?? ''
  if (!isValidId(searchId)) throw searchNotFound()
  if (!(await emailMailbox(c.env, account.id).deleteSavedSearch(searchId))) throw searchNotFound()
  return c.body(null, 204)
})
