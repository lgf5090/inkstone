import { Hono } from 'hono'
import {
  EMAIL_CONTACTS_MAX_PAGE_SIZE,
  EMAIL_CONTACTS_PAGE_SIZE,
  EMAIL_CONTACT_QUERY_MAX_CHARS,
  normalizeContactEmail,
  parseEmailContactInput,
  parseEmailContactPatch,
  parseEmailGroupInput,
  parseEmailGroupPatch,
} from '@shared/email/contacts'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { clampInt, JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth, requireOwner } from '../middleware/auth'
import {
  addEmailGroupMember,
  createEmailContact,
  createEmailGroup,
  deleteEmailContact,
  deleteEmailGroup,
  findEmailContactByEmail,
  findEmailGroupByName,
  getEmailContact,
  getEmailGroup,
  getEmailGroupWithMembers,
  listEmailContacts,
  listEmailGroups,
  removeEmailGroupMember,
  toEmailContact,
  toEmailGroup,
  updateEmailContact,
  updateEmailGroup,
} from '../email/contacts'

export const emailContactsRoutes = new Hono<AppBindings>()

emailContactsRoutes.use('*', requireAuth)
emailContactsRoutes.use('*', requireOwner)

function contactNotFound(): ApiError {
  return new ApiError(404, 'not_found', 'Contact not found')
}

function groupNotFound(): ApiError {
  return new ApiError(404, 'not_found', 'Group not found')
}

function contactIdParam(value: string): string {
  if (!isValidId(value)) throw contactNotFound()
  return value
}

function groupIdParam(value: string): string {
  if (!isValidId(value)) throw groupNotFound()
  return value
}

emailContactsRoutes.get('/contacts', async (c) => {
  const query = (c.req.query('q') ?? '').trim()
  if (query.length > EMAIL_CONTACT_QUERY_MAX_CHARS) {
    throw ApiError.badRequest('The contact search query is too long')
  }
  const limit = clampInt(c.req.query('limit'), 1, EMAIL_CONTACTS_MAX_PAGE_SIZE, EMAIL_CONTACTS_PAGE_SIZE)
  const rows = await listEmailContacts(c.env.DB, c.get('userId'), { query, limit })
  return c.json(rows.map(toEmailContact))
})

emailContactsRoutes.post('/contacts', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.settings)
  const input = parseEmailContactInput(body)
  if (!input) throw ApiError.badRequest('The contact is not valid')
  const userId = c.get('userId')
  if (await findEmailContactByEmail(c.env.DB, userId, normalizeContactEmail(input.email))) {
    throw new ApiError(409, 'email_contact_exists', 'That email address is already saved')
  }
  const row = await createEmailContact(c.env.DB, userId, input)
  return c.json(toEmailContact(row), 201)
})

emailContactsRoutes.patch('/contacts/:id', async (c) => {
  const id = contactIdParam(c.req.param('id') ?? '')
  const userId = c.get('userId')
  if (!(await getEmailContact(c.env.DB, userId, id))) throw contactNotFound()
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.settings)
  const patch = parseEmailContactPatch(body)
  if (!patch) throw ApiError.badRequest('The contact is not valid')
  if (patch.email !== undefined) {
    const existing = await findEmailContactByEmail(c.env.DB, userId, normalizeContactEmail(patch.email))
    if (existing && existing.id !== id) {
      throw new ApiError(409, 'email_contact_exists', 'That email address is already saved')
    }
  }
  const updated = await updateEmailContact(c.env.DB, userId, id, patch)
  if (!updated) throw contactNotFound()
  return c.json(toEmailContact(updated))
})

emailContactsRoutes.delete('/contacts/:id', async (c) => {
  const id = contactIdParam(c.req.param('id') ?? '')
  if (!(await deleteEmailContact(c.env.DB, c.get('userId'), id))) throw contactNotFound()
  return c.body(null, 204)
})

emailContactsRoutes.get('/groups', async (c) => {
  return c.json(await listEmailGroups(c.env.DB, c.get('userId')))
})

emailContactsRoutes.post('/groups', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const input = parseEmailGroupInput(body)
  if (!input) throw ApiError.badRequest('The group is not valid')
  const userId = c.get('userId')
  if (await findEmailGroupByName(c.env.DB, userId, input.name)) {
    throw new ApiError(409, 'email_group_exists', 'A group with that name already exists')
  }
  const row = await createEmailGroup(c.env.DB, userId, input)
  return c.json({ ...toEmailGroup(row), members: [] }, 201)
})

emailContactsRoutes.patch('/groups/:id', async (c) => {
  const id = groupIdParam(c.req.param('id') ?? '')
  const userId = c.get('userId')
  if (!(await getEmailGroup(c.env.DB, userId, id))) throw groupNotFound()
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const patch = parseEmailGroupPatch(body)
  if (!patch) throw ApiError.badRequest('The group is not valid')
  if (patch.name !== undefined) {
    const existing = await findEmailGroupByName(c.env.DB, userId, patch.name)
    if (existing && existing.id !== id) {
      throw new ApiError(409, 'email_group_exists', 'A group with that name already exists')
    }
  }
  const updated = await updateEmailGroup(c.env.DB, userId, id, patch)
  if (!updated) throw groupNotFound()
  const group = await getEmailGroupWithMembers(c.env.DB, userId, id)
  if (!group) throw groupNotFound()
  return c.json(group)
})

emailContactsRoutes.delete('/groups/:id', async (c) => {
  const id = groupIdParam(c.req.param('id') ?? '')
  if (!(await deleteEmailGroup(c.env.DB, c.get('userId'), id))) throw groupNotFound()
  return c.body(null, 204)
})

emailContactsRoutes.post('/groups/:id/members', async (c) => {
  const groupId = groupIdParam(c.req.param('id') ?? '')
  const userId = c.get('userId')
  const body = await readJson<{ contactId?: unknown }>(c, JSON_BODY_LIMITS.small)
  if (typeof body.contactId !== 'string' || !isValidId(body.contactId)) {
    throw ApiError.badRequest('A contact id is required')
  }
  if (!(await getEmailGroup(c.env.DB, userId, groupId))) throw groupNotFound()
  if (!(await getEmailContact(c.env.DB, userId, body.contactId))) throw contactNotFound()
  await addEmailGroupMember(c.env.DB, userId, groupId, body.contactId)
  return c.body(null, 204)
})

emailContactsRoutes.delete('/groups/:id/members/:contactId', async (c) => {
  const groupId = groupIdParam(c.req.param('id') ?? '')
  const contactId = contactIdParam(c.req.param('contactId') ?? '')
  if (!(await removeEmailGroupMember(c.env.DB, c.get('userId'), groupId, contactId))) {
    throw new ApiError(404, 'not_found', 'Group member not found')
  }
  return c.body(null, 204)
})
