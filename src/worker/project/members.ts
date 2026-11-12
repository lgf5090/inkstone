import type { ProjectBoard, ProjectBoardMember, ProjectPeople, ProjectRole } from '@shared/project/model'
import { effectiveProjectRole } from '@shared/project/model'
import { PROJECT_LIMITS } from '@shared/project/limits'
import { ApiError } from '../lib/errors'
import { publicUser } from '../lib/session-info'
import { rowToUser, USER_COLUMNS } from '../middleware/auth'

interface MemberRow {
  board_id: string
  user_id: string
  role: string
  created_at: number
  updated_at: number
}

function toMember(row: MemberRow): ProjectBoardMember {
  return {
    boardId: row.board_id,
    userId: row.user_id,
    role: row.role as ProjectRole,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function memberRow(db: D1Database, boardId: string, userId: string): Promise<MemberRow | null> {
  return db
    .prepare('SELECT * FROM project_board_members WHERE board_id = ?1 AND user_id = ?2')
    .bind(boardId, userId)
    .first<MemberRow>()
}

async function adminCount(db: D1Database, boardId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM project_board_members WHERE board_id = ?1 AND role = 'admin'")
    .bind(boardId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

async function memberCount(db: D1Database, boardId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM project_board_members WHERE board_id = ?1')
    .bind(boardId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * The reference guards the last admin only in the client; here the server refuses the write that would
 * leave a board with no admin member, because a client check is not a trust boundary.
 */
async function assertNotLastAdmin(db: D1Database, boardId: string, userId: string): Promise<void> {
  const target = await memberRow(db, boardId, userId)
  if (target?.role === 'admin' && (await adminCount(db, boardId)) <= 1) {
    throw ApiError.conflict('last_admin')
  }
}

export async function listProjectMembers(db: D1Database, boardId: string): Promise<ProjectBoardMember[]> {
  const { results } = await db
    .prepare('SELECT * FROM project_board_members WHERE board_id = ?1 ORDER BY created_at, user_id')
    .bind(boardId)
    .all<MemberRow>()
  return results.map(toMember)
}

/** D1 caps a statement's bound variables, so a board's people are read in the same chunks as its cards. */
const PEOPLE_CHUNK = 90

/**
 * The readable face of every user id a board refers to. Only the display name and avatar leave the
 * server: a login handle is a credential half, and a public share link has no business handing it out.
 */
export async function listProjectPeople(db: D1Database, userIds: readonly string[]): Promise<ProjectPeople> {
  const ids = [...new Set(userIds.filter(Boolean))]
  const people: Record<string, ProjectPeople[string]> = {}
  for (let index = 0; index < ids.length; index += PEOPLE_CHUNK) {
    const chunk = ids.slice(index, index + PEOPLE_CHUNK)
    const placeholders = chunk.map((_, at) => `?${at + 1}`).join(', ')
    const { results } = await db
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<Parameters<typeof rowToUser>[0]>()
    for (const row of results) {
      const user = publicUser(rowToUser(row))
      people[user.id] = { id: user.id, name: user.name, avatarUrl: user.avatarUrl }
    }
  }
  return people
}

export async function addProjectMember(
  db: D1Database,
  board: ProjectBoard,
  username: string,
  role: ProjectRole,
  now: number,
): Promise<ProjectBoardMember> {
  const account = await db
    .prepare('SELECT id FROM users WHERE lower(username) = lower(?1) LIMIT 1')
    .bind(username)
    .first<{ id: string }>()
  if (!account) throw ApiError.notFound('User not found')
  const targetUserId = account.id
  if (targetUserId === board.ownerId) throw ApiError.conflict('owner_immutable')
  if (await memberRow(db, board.id, targetUserId)) throw ApiError.conflict('already_member')
  if ((await memberCount(db, board.id)) >= PROJECT_LIMITS.boardMembers) {
    throw ApiError.conflict('PROJECT_MAX_BOARD_MEMBERS')
  }
  await db
    .prepare(
      'INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
    )
    .bind(board.id, targetUserId, role, now)
    .run()
  return { boardId: board.id, userId: targetUserId, role, createdAt: now, updatedAt: now }
}

export async function setProjectMemberRole(
  db: D1Database,
  board: ProjectBoard,
  targetUserId: string,
  role: ProjectRole,
  now: number,
): Promise<ProjectBoardMember> {
  if (targetUserId === board.ownerId) throw ApiError.conflict('owner_immutable')
  const target = await memberRow(db, board.id, targetUserId)
  if (!target) throw ApiError.notFound('Member not found')
  if (role !== 'admin') await assertNotLastAdmin(db, board.id, targetUserId)
  await db
    .prepare('UPDATE project_board_members SET role = ?1, updated_at = ?2 WHERE board_id = ?3 AND user_id = ?4')
    .bind(role, now, board.id, targetUserId)
    .run()
  return { ...toMember(target), role, updatedAt: now }
}

/** A reader who loses access must stop receiving that board's comment bodies and due reminders. */
async function clearBoardSubscriptions(db: D1Database, boardId: string, userId: string): Promise<void> {
  await db
    .prepare(
      `DELETE FROM project_subscriptions
       WHERE subscriber_id = ?1
         AND (block_id = ?2 OR block_id IN (SELECT id FROM project_cards WHERE board_id = ?2))`,
    )
    .bind(userId, boardId)
    .run()
}

export async function removeProjectMember(
  db: D1Database,
  board: ProjectBoard,
  targetUserId: string,
): Promise<void> {
  if (targetUserId === board.ownerId) throw ApiError.conflict('owner_immutable')
  const target = await memberRow(db, board.id, targetUserId)
  if (!target) throw ApiError.notFound('Member not found')
  await assertNotLastAdmin(db, board.id, targetUserId)
  await db
    .prepare('DELETE FROM project_board_members WHERE board_id = ?1 AND user_id = ?2')
    .bind(board.id, targetUserId)
    .run()
  await clearBoardSubscriptions(db, board.id, targetUserId)
}

export interface ProjectJoinResult {
  member: ProjectBoardMember | null
  role: ProjectRole
}

/** Joining an open board writes the board's minimum role; re-joining never downgrades an existing grant. */
export async function joinProjectBoard(
  db: D1Database,
  board: ProjectBoard,
  userId: string,
  now: number,
): Promise<ProjectJoinResult> {
  if (userId === board.ownerId) return { member: null, role: 'admin' }
  const existing = await memberRow(db, board.id, userId)
  const role = effectiveProjectRole({
    ownerId: board.ownerId,
    userId,
    boardType: board.type,
    minimumRole: board.minimumRole,
    memberRole: (existing?.role as ProjectRole | undefined) ?? null,
  })
  if (!role) throw ApiError.forbidden()
  if (existing) return { member: toMember(existing), role }
  if ((await memberCount(db, board.id)) >= PROJECT_LIMITS.boardMembers) {
    throw ApiError.conflict('PROJECT_MAX_BOARD_MEMBERS')
  }
  const granted = board.minimumRole as ProjectRole
  await db
    .prepare(
      'INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
    )
    .bind(board.id, userId, granted, now)
    .run()
  return { member: { boardId: board.id, userId, role: granted, createdAt: now, updatedAt: now }, role: granted }
}

export async function leaveProjectBoard(db: D1Database, board: ProjectBoard, userId: string): Promise<void> {
  if (userId === board.ownerId) throw ApiError.conflict('owner_immutable')
  const target = await memberRow(db, board.id, userId)
  if (!target) throw ApiError.notFound('Not a member')
  await assertNotLastAdmin(db, board.id, userId)
  await db
    .prepare('DELETE FROM project_board_members WHERE board_id = ?1 AND user_id = ?2')
    .bind(board.id, userId)
    .run()
  await clearBoardSubscriptions(db, board.id, userId)
}