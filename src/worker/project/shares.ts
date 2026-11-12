/**
 * Public read-only sharing, modelled on the assistant's share links: a slug is the capability, an
 * optional password hash gates it, and an expiry lapses it. The hash never leaves the server; the
 * management answer carries only `hasPassword`. Reading increments the view counter and returns the
 * board bundle at viewer role, so a shared board exposes exactly what a viewer sees.
 */
import type { ProjectBoard, ProjectBoardBundle, ProjectShare } from '@shared/project/model'
import { newSlug } from '../lib/id'
import { hashPassword, verifyPassword } from '../lib/password'
import { ApiError } from '../lib/errors'
import { assertAttemptBudget, assertNotLocked, clearLoginFailures, consumeAttemptBudget, recordLoginFailure, type AttemptBudgetTarget } from '../lib/throttle'
import { readProjectBoardBundle } from './bundle'

interface ShareRow {
  slug: string
  board_id: string
  user_id: string
  password_hash: string | null
  expires_at: number | null
  views: number
  show_comments: number
  created_at: number
}

function rowToShare(row: ShareRow): ProjectShare {
  return {
    slug: row.slug,
    boardId: row.board_id,
    hasPassword: row.password_hash !== null,
    expiresAt: row.expires_at,
    views: row.views,
    showComments: row.show_comments !== 0,
    createdAt: row.created_at,
  }
}

export async function getProjectShare(db: D1Database, boardId: string, userId: string): Promise<ProjectShare | null> {
  const row = await db.prepare('SELECT * FROM project_shares WHERE board_id = ?1 AND user_id = ?2').bind(boardId, userId).first<ShareRow>()
  return row ? rowToShare(row) : null
}

export async function putProjectShare(
  db: D1Database,
  board: ProjectBoard,
  userId: string,
  input: { password?: string | null, expiresAt?: number | null, showComments?: boolean },
  now: number,
): Promise<ProjectShare> {
  const existing = await db.prepare('SELECT * FROM project_shares WHERE board_id = ?1 AND user_id = ?2').bind(board.id, userId).first<ShareRow>()
  let passwordHash = existing?.password_hash ?? null
  if (input.password === null) passwordHash = null
  else if (input.password !== undefined) passwordHash = await hashPassword(input.password)
  const expiresAt = input.expiresAt === undefined ? (existing?.expires_at ?? null) : input.expiresAt
  const showComments = input.showComments === undefined ? (existing?.show_comments ?? 0) : (input.showComments ? 1 : 0)
  if (existing) {
    await db.prepare('UPDATE project_shares SET password_hash = ?1, expires_at = ?2, show_comments = ?3 WHERE slug = ?4')
      .bind(passwordHash, expiresAt, showComments, existing.slug).run()
    return rowToShare({ ...existing, password_hash: passwordHash, expires_at: expiresAt, show_comments: showComments })
  }
  const slug = newSlug()
  await db.prepare(
    'INSERT INTO project_shares (slug, board_id, user_id, password_hash, expires_at, views, show_comments, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)',
  ).bind(slug, board.id, userId, passwordHash, expiresAt, showComments, now).run()
  return { slug, boardId: board.id, hasPassword: passwordHash !== null, expiresAt, views: 0, showComments: showComments !== 0, createdAt: now }
}

export async function deleteProjectShare(db: D1Database, boardId: string, userId: string): Promise<void> {
  await db.prepare('DELETE FROM project_shares WHERE board_id = ?1 AND user_id = ?2').bind(boardId, userId).run()
}

/**
 * The passcode ledger, keyed per surface.
 *
 * The note share and the collection directory budget the same gate with the same numbers; a project's
 * public answer is wider than either — the whole board bundle — so an unbudgeted slug would be the
 * cheapest of the three to walk. The namespace is its own so probing a board can never lock a note's
 * reader out, and the budgets match so no surface is the soft one.
 */
function projectShareThrottle(slug: string, ip: string): { lockTargets: string[], workTargets: AttemptBudgetTarget[] } {
  return {
    lockTargets: [`project-share:${slug}:ip:${ip}`],
    workTargets: [
      { key: `project-share-work:${slug}:ip:${ip}`, maxAttempts: 8, windowMs: 10 * 60 * 1000 },
      { key: `project-share-work:${slug}`, maxAttempts: 60, windowMs: 10 * 60 * 1000, lockMs: 60_000 },
    ],
  }
}

export async function readPublicProjectShare(db: D1Database, slug: string, password: string | undefined, now: number, ip: string): Promise<ProjectBoardBundle> {
  await assertAttemptBudget(async () => {
    await consumeAttemptBudget(db, [
      { key: `project-share-read:${slug}:ip:${ip}`, maxAttempts: 20, windowMs: 10 * 60 * 1000 },
      { key: `project-share-read:ip:${ip}`, maxAttempts: 60, windowMs: 10 * 60 * 1000 },
    ])
  })
  const row = await db.prepare('SELECT * FROM project_shares WHERE slug = ?1').bind(slug).first<ShareRow>()
  if (!row) throw ApiError.notFound('Share not found')
  if (row.expires_at !== null && row.expires_at <= now) throw ApiError.notFound('Share not found')
  const boardRow = await db.prepare('SELECT * FROM project_boards WHERE id = ?1 AND delete_at = 0').bind(row.board_id).first<{ id: string, owner_id: string, type: string, minimum_role: string, title: string, description: string, icon: string, show_description: number, is_template: number, template_version: number, created_by: string, modified_by: string, create_at: number, update_at: number, delete_at: number, archived: number }>()
  if (!boardRow) throw ApiError.notFound('Share not found')
  if (row.password_hash !== null) {
    if (!password) throw ApiError.unauthenticated('An access password is required')
    const targets = projectShareThrottle(slug, ip)
    await assertAttemptBudget(async () => {
      await assertNotLocked(db, targets.lockTargets)
      await consumeAttemptBudget(db, targets.workTargets)
    })
    if (!(await verifyPassword(password, row.password_hash))) {
      await recordLoginFailure(db, targets.lockTargets)
      throw new ApiError(401, 'invalid_credentials', 'Incorrect passcode')
    }
    await clearLoginFailures(db, [...targets.lockTargets, ...targets.workTargets.map((target) => target.key)])
  }
  await db.prepare('UPDATE project_shares SET views = views + 1 WHERE slug = ?1').bind(slug).run()
  const board: ProjectBoard = {
    id: boardRow.id, ownerId: boardRow.owner_id, type: boardRow.type as ProjectBoard['type'], minimumRole: boardRow.minimum_role as ProjectBoard['minimumRole'],
    title: boardRow.title, description: boardRow.description, icon: boardRow.icon, showDescription: boardRow.show_description === 1,
    isTemplate: boardRow.is_template === 1, templateVersion: boardRow.template_version, createdBy: boardRow.created_by, modifiedBy: boardRow.modified_by,
    createAt: boardRow.create_at, updateAt: boardRow.update_at, deleteAt: boardRow.delete_at, archived: boardRow.archived !== 0,
  }
  const bundle = await readProjectBoardBundle(db, board, 'viewer')
  return { ...bundle, members: [], comments: row.show_comments === 0 ? [] : bundle.comments }
}