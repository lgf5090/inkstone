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
import { createMinuteBudget } from '../lib/rate-limit'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { CalendarStore } from '../calendar/store'
import { answerInvite, deleteMember, findMemberAccount, listMembers, upsertMember } from '../calendar/members'
import type { CalendarMemberDto } from '@shared/calendar/model'

const readBudget = createMinuteBudget(240, 'Too many calendar reads at once. Try again in a minute.')
const writeBudget = createMinuteBudget(60, 'Too many calendar share changes. Try again in a minute.')
const BODY_LIMIT = 8 * 1024

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
  const id = c.req.param('id')
  await ownedCalendar(c, id)
  return c.json({ members: await listMembers(c.env.DB, c.get('userId'), id) })
})

calendarMemberRoutes.post('/calendars/:id/members', async (c) => {
  const ownerId = c.get('userId')
  writeBudget(ownerId)
  const id = c.req.param('id')
  await ownedCalendar(c, id)
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  if (!username) throw ApiError.badRequest('username is required')
  const member = await findMemberAccount(c.env.DB, username)
  if (!member) throw ApiError.notFound('No account uses that username')
  if (member.id === ownerId) throw ApiError.badRequest('You already own this calendar')
  const memberRole = role(body.role)
  const now = Date.now()
  await upsertMember(c.env.DB, ownerId, id, member.id, memberRole, now)
  return c.json({
    member: {
      memberId: member.id,
      username: member.username,
      name: member.name,
      role: memberRole,
      status: 'pending',
      createdAt: now,
    } satisfies CalendarMemberDto,
  })
})

calendarMemberRoutes.delete('/calendars/:id/members/:memberId', async (c) => {
  const ownerId = c.get('userId')
  writeBudget(ownerId)
  const id = c.req.param('id')
  await ownedCalendar(c, id)
  if (await deleteMember(c.env.DB, ownerId, id, c.req.param('memberId')) === 0) {
    throw ApiError.notFound('Member not found')
  }
  return c.body(null, 204)
})

/** The invited account can drop its own membership at any time. */
calendarMemberRoutes.delete('/invites/:ownerId/:calendarId', async (c) => {
  const memberId = c.get('userId')
  writeBudget(memberId)
  if (await deleteMember(c.env.DB, c.req.param('ownerId'), c.req.param('calendarId'), memberId) === 0) {
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
  const changes = await answerInvite(
    c.env.DB,
    c.req.param('ownerId'),
    c.req.param('calendarId'),
    memberId,
    status,
    Date.now(),
  )
  if (changes === 0) throw ApiError.notFound('Invitation not found')
  return c.body(null, 204)
})
