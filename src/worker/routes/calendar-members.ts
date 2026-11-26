/**
 * Account-to-account calendar sharing.
 *
 * A share row is both the invitation and the permission: pending rows appear in the member's sidebar,
 * accepted rows appear as synthetic read-only calendars, and declining keeps the history without
 * granting access. The owner is the only account allowed to change the guest list.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { checkRateLimit, createMinuteBudget } from '../lib/rate-limit'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { parseEntityId } from '../calendar/validation'
import { CalendarStore } from '../calendar/store'
import { answerInvite, deleteMember, findMemberAccount, listMembers, upsertMember } from '../calendar/members'

const readBudget = createMinuteBudget(240, 'Too many calendar reads at once. Try again in a minute.')
const writeBudget = createMinuteBudget(60, 'Too many calendar share changes. Try again in a minute.')
const BODY_LIMIT = 8 * 1024
const INVITE_TARGET_LIMIT = 3
const INVITE_TARGET_WINDOW_MS = 10 * 60 * 1000
const USERNAME_PATTERN = /^[a-z0-9_-]{3,32}$/i

export const calendarMemberRoutes = new Hono<AppBindings>()
calendarMemberRoutes.use('*', requireAuth)

function role(value: unknown): 'reader' | 'writer' {
  if (value === 'reader' || value === 'writer') return value
  throw ApiError.badRequest('role must be reader or writer')
}

async function ownedCalendar(c: Context<AppBindings>, id: string): Promise<void> {
  const calendars = await new CalendarStore(c.env.DB, c.get('userId')).listCalendars()
  if (!calendars.some(entry => entry.id === id)) throw ApiError.notFound('Calendar not found')
}

calendarMemberRoutes.get('/calendars/:id/members', async (c) => {
  readBudget(c.get('userId'))
  const id = parseEntityId(c.req.param('id'), 'id')
  await ownedCalendar(c, id)
  return c.json({ members: await listMembers(c.env.DB, c.get('userId'), id) })
})

calendarMemberRoutes.post('/calendars/:id/members', async (c) => {
  const ownerId = c.get('userId')
  writeBudget(ownerId)
  const id = parseEntityId(c.req.param('id'), 'id')
  await ownedCalendar(c, id)
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  if (!USERNAME_PATTERN.test(username)) throw ApiError.badRequest('username must contain 3-32 letters, numbers, underscores, or hyphens')
  const memberRole = role(body.role)
  const targetKey = `calendar-invite:${ownerId}:${username.toLowerCase()}`
  const targetBudget = checkRateLimit(targetKey, INVITE_TARGET_LIMIT, INVITE_TARGET_WINDOW_MS)
  if (!targetBudget.ok) throw new ApiError(429, 'too_many_attempts', 'Too many invitations for this account. Try again later.')
  const member = await findMemberAccount(c.env.DB, username)
  if (member && member.id !== ownerId) {
    await upsertMember(c.env.DB, ownerId, id, member.id, memberRole, Date.now())
  }
  return c.json({ invited: true }, 202)
})

calendarMemberRoutes.delete('/calendars/:id/members/:memberId', async (c) => {
  const ownerId = c.get('userId')
  writeBudget(ownerId)
  const id = parseEntityId(c.req.param('id'), 'id')
  const memberId = parseEntityId(c.req.param('memberId'), 'memberId')
  await ownedCalendar(c, id)
  if (await deleteMember(c.env.DB, ownerId, id, memberId) === 0) {
    throw ApiError.notFound('Member not found')
  }
  return c.body(null, 204)
})

/** The invited account can drop its own membership at any time. */
calendarMemberRoutes.delete('/invites/:ownerId/:calendarId', async (c) => {
  const memberId = c.get('userId')
  writeBudget(memberId)
  const ownerId = parseEntityId(c.req.param('ownerId'), 'ownerId')
  const calendarId = parseEntityId(c.req.param('calendarId'), 'calendarId')
  if (await deleteMember(c.env.DB, ownerId, calendarId, memberId) === 0) {
    throw ApiError.notFound('Membership not found')
  }
  return c.body(null, 204)
})

/** The invited account answers; only the member row it owns can move. */
calendarMemberRoutes.post('/invites/:ownerId/:calendarId/response', async (c) => {
  const memberId = c.get('userId')
  writeBudget(memberId)
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  if (body.status !== 'accepted' && body.status !== 'declined') {
    throw ApiError.badRequest('status must be accepted or declined')
  }
  const status = body.status
  const ownerId = parseEntityId(c.req.param('ownerId'), 'ownerId')
  const calendarId = parseEntityId(c.req.param('calendarId'), 'calendarId')
  const changes = await answerInvite(
    c.env.DB,
    ownerId,
    calendarId,
    memberId,
    status,
    Date.now(),
  )
  if (changes === 0) throw ApiError.notFound('Invitation not found')
  return c.body(null, 204)
})
