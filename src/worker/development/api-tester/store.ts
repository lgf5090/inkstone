import { HISTORY_LIMIT, MAX_WORKSPACES } from '@shared/development/api-tester/limits'
import { newApiTesterId } from '@shared/development/api-tester/ids'
import { DEFAULT_WORKSPACE_COLOR } from '@shared/development/api-tester/keywords'
import type { Workspace } from '@shared/development/api-tester/types'
import { ApiError } from '../../lib/errors'

interface WorkspaceRow {
  id: string
  name: string
  color: string
  sort_order: number
  created_at: number
}

interface StateRow {
  data: string
  rev: number
  updated_at: number
}

interface HistoryRow {
  id: string
  data: string
  ts: number
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  }
}

export async function listWorkspaces(db: D1Database, userId: string): Promise<Workspace[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, color, sort_order, created_at
         FROM development_apitester_workspaces
        WHERE user_id = ?
        ORDER BY sort_order ASC, created_at ASC`,
    )
    .bind(userId)
    .all<WorkspaceRow>()
  return results.map(toWorkspace)
}

export async function ensureDefaultWorkspace(db: D1Database, userId: string): Promise<Workspace[]> {
  const existing = await listWorkspaces(db, userId)
  if (existing.length > 0) return existing
  const now = Date.now()
  const id = newApiTesterId()
  await db
    .prepare(
      `INSERT INTO development_apitester_workspaces (user_id, id, name, color, sort_order, created_at, updated_at)
       SELECT ?, ?, ?, ?, 0, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM development_apitester_workspaces WHERE user_id = ?)`,
    )
    .bind(userId, id, 'Default workspace', DEFAULT_WORKSPACE_COLOR, now, now, userId)
    .run()
  return listWorkspaces(db, userId)
}

export async function createWorkspace(
  db: D1Database,
  userId: string,
  input: { name: string; color?: string },
): Promise<{ workspace: Workspace; workspaces: Workspace[] }> {
  const existing = await listWorkspaces(db, userId)
  if (existing.length >= MAX_WORKSPACES) {
    throw new ApiError(409, 'apitester_workspace_limit', `A workspace limit of ${MAX_WORKSPACES} is in force`)
  }
  const now = Date.now()
  const id = newApiTesterId()
  const workspace: Workspace = {
    id,
    name: input.name,
    color: input.color || DEFAULT_WORKSPACE_COLOR,
    sortOrder: existing.length,
    createdAt: now,
  }
  await db
    .prepare(
      `INSERT INTO development_apitester_workspaces (user_id, id, name, color, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(userId, id, workspace.name, workspace.color, workspace.sortOrder, now, now)
    .run()
  return { workspace, workspaces: [...existing, workspace] }
}

export async function updateWorkspace(
  db: D1Database,
  userId: string,
  id: string,
  patch: { name?: string; color?: string },
): Promise<Workspace[]> {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.name !== undefined) {
    sets.push('name = ?')
    values.push(patch.name)
  }
  if (patch.color !== undefined) {
    sets.push('color = ?')
    values.push(patch.color)
  }
  if (sets.length > 0) {
    values.push(Date.now(), userId, id)
    const result = await db
      .prepare(
        `UPDATE development_apitester_workspaces SET ${sets.join(', ')}, updated_at = ?
          WHERE user_id = ? AND id = ?`,
      )
      .bind(...values)
      .run()
    if (!result.meta.changes) throw ApiError.notFound('Workspace not found')
  }
  return listWorkspaces(db, userId)
}

export async function deleteWorkspace(db: D1Database, userId: string, id: string): Promise<Workspace[]> {
  const existing = await listWorkspaces(db, userId)
  if (existing.length <= 1) {
    throw new ApiError(400, 'apitester_last_workspace', 'The last workspace cannot be removed')
  }
  if (!existing.some((workspace) => workspace.id === id)) throw ApiError.notFound('Workspace not found')
  await db.batch([
    db.prepare('DELETE FROM development_apitester_state WHERE user_id = ? AND workspace_id = ?').bind(userId, id),
    db.prepare('DELETE FROM development_apitester_history WHERE user_id = ? AND workspace_id = ?').bind(userId, id),
    db.prepare('DELETE FROM development_apitester_workspaces WHERE user_id = ? AND id = ?').bind(userId, id),
  ])
  return listWorkspaces(db, userId)
}

export async function findWorkspace(db: D1Database, userId: string, id: string): Promise<Workspace | null> {
  const row = await db
    .prepare(
      `SELECT id, name, color, sort_order, created_at
         FROM development_apitester_workspaces
        WHERE user_id = ? AND id = ?`,
    )
    .bind(userId, id)
    .first<WorkspaceRow>()
  return row ? toWorkspace(row) : null
}

export async function assertWorkspace(db: D1Database, userId: string, id: string): Promise<void> {
  const workspace = await findWorkspace(db, userId, id)
  if (!workspace) throw ApiError.notFound('Workspace not found')
}

export async function getStateRow(db: D1Database, userId: string, workspaceId: string): Promise<StateRow | null> {
  return db
    .prepare(
      `SELECT data, rev, updated_at
         FROM development_apitester_state
        WHERE user_id = ? AND workspace_id = ?`,
    )
    .bind(userId, workspaceId)
    .first<StateRow>()
}

export interface SaveStateResult {
  rev: number
}

export async function saveState(
  db: D1Database,
  userId: string,
  workspaceId: string,
  ciphertext: string,
  baseRev: number,
): Promise<SaveStateResult> {
  const now = Date.now()
  if (baseRev === 0) {
    const result = await db
      .prepare(
        `INSERT INTO development_apitester_state (user_id, workspace_id, data, rev, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(user_id, workspace_id) DO NOTHING`,
      )
      .bind(userId, workspaceId, ciphertext, now)
      .run()
    if (result.meta.changes) return { rev: 1 }
    const current = await getStateRow(db, userId, workspaceId)
    throw new ApiError(409, 'apitester_state_conflict', 'The workspace was saved elsewhere', { rev: current?.rev ?? 0 })
  }
  const result = await db
    .prepare(
      `UPDATE development_apitester_state
          SET data = ?, rev = rev + 1, updated_at = ?
        WHERE user_id = ? AND workspace_id = ? AND rev = ?`,
    )
    .bind(ciphertext, now, userId, workspaceId, baseRev)
    .run()
  if (result.meta.changes) return { rev: baseRev + 1 }
  const current = await getStateRow(db, userId, workspaceId)
  if (!current) throw ApiError.notFound('Saved workspace not found')
  throw new ApiError(409, 'apitester_state_conflict', 'The workspace was saved elsewhere', { rev: current.rev })
}

export async function listHistoryRows(
  db: D1Database,
  userId: string,
  workspaceId: string,
  limit = HISTORY_LIMIT,
): Promise<HistoryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, data, ts
         FROM development_apitester_history
        WHERE user_id = ? AND workspace_id = ?
        ORDER BY ts DESC
        LIMIT ?`,
    )
    .bind(userId, workspaceId, limit)
    .all<HistoryRow>()
  return results
}

export async function insertHistory(
  db: D1Database,
  userId: string,
  workspaceId: string,
  entry: { id: string; ts: number; ciphertext: string },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO development_apitester_history (id, user_id, workspace_id, data, ts)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET data = excluded.data, ts = excluded.ts`,
      )
      .bind(entry.id, userId, workspaceId, entry.ciphertext, entry.ts),
    db
      .prepare(
        `DELETE FROM development_apitester_history
          WHERE user_id = ? AND workspace_id = ?
            AND id NOT IN (
              SELECT id FROM development_apitester_history
               WHERE user_id = ? AND workspace_id = ?
               ORDER BY ts DESC
               LIMIT ${HISTORY_LIMIT}
            )`,
      )
      .bind(userId, workspaceId, userId, workspaceId),
  ])
}

export async function clearHistory(db: D1Database, userId: string, workspaceId: string): Promise<void> {
  await db
    .prepare('DELETE FROM development_apitester_history WHERE user_id = ? AND workspace_id = ?')
    .bind(userId, workspaceId)
    .run()
}
