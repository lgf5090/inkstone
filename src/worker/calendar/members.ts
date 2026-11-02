/** Calendar membership rows: the invitation, the permission and the guest's own answer. */
import type { CalendarMemberDto } from '@shared/calendar/model'

interface MemberRow {
  member_user_id: string
  role: string
  status: string
  created_at: number
  username: string
  name: string
}

export async function listMembers(db: D1Database, ownerId: string, calendarId: string): Promise<CalendarMemberDto[]> {
  const { results } = await db.prepare(
    `SELECT m.member_user_id, m.role, m.status, m.created_at, u.username, u.name
       FROM calendar_members m
       JOIN users u ON u.id = m.member_user_id
      WHERE m.owner_user_id = ? AND m.calendar_id = ?
      ORDER BY m.created_at ASC`,
  ).bind(ownerId, calendarId).all<MemberRow>()
  return (results ?? []).map(row => ({
    memberId: row.member_user_id,
    username: row.username,
    name: row.name,
    role: row.role === 'writer' ? 'writer' : 'reader',
    status: row.status === 'accepted' || row.status === 'declined' ? row.status : 'pending',
    createdAt: Number(row.created_at),
  }))
}

export async function findMemberAccount(
  db: D1Database,
  username: string,
): Promise<{ id: string; username: string; name: string } | null> {
  return db.prepare(
    'SELECT id, username, name FROM users WHERE lower(username) = lower(?) LIMIT 1',
  ).bind(username).first<{ id: string; username: string; name: string }>()
}

export async function upsertMember(
  db: D1Database,
  ownerId: string,
  calendarId: string,
  memberId: string,
  role: 'reader' | 'writer',
  now: number,
): Promise<void> {
  await db.prepare(
    `INSERT INTO calendar_members
       (owner_user_id, calendar_id, member_user_id, role, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5)
     ON CONFLICT(owner_user_id, calendar_id, member_user_id) DO UPDATE SET
       role = excluded.role, status = 'pending', updated_at = excluded.updated_at`,
  ).bind(ownerId, calendarId, memberId, role, now).run()
}

export async function deleteMember(
  db: D1Database,
  ownerId: string,
  calendarId: string,
  memberId: string,
): Promise<number> {
  const result = await db.prepare(
    `DELETE FROM calendar_members
      WHERE owner_user_id = ?1 AND calendar_id = ?2 AND member_user_id = ?3`,
  ).bind(ownerId, calendarId, memberId).run()
  return result.meta.changes ?? 0
}

export async function answerInvite(
  db: D1Database,
  ownerId: string,
  calendarId: string,
  memberId: string,
  status: 'accepted' | 'declined',
  now: number,
): Promise<number> {
  const result = await db.prepare(
    `UPDATE calendar_members SET status = ?1, updated_at = ?2
      WHERE owner_user_id = ?3 AND calendar_id = ?4 AND member_user_id = ?5 AND status = 'pending'`,
  ).bind(status, now, ownerId, calendarId, memberId).run()
  return result.meta.changes ?? 0
}
