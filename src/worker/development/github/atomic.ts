import { chunkMarks, idChunks } from '../../db/writes'
import { unbindIdsStatement } from './store'

type UnbindTable = Parameters<typeof unbindIdsStatement>[1]
type UnbindColumn = Parameters<typeof unbindIdsStatement>[2]

export interface AtomicDeleteResult {
  count: number
  updatedIds: string[]
}

function deleteStatements(
  db: D1Database,
  table: string,
  userId: string,
  ids: readonly string[],
): D1PreparedStatement[] {
  return idChunks(ids).map((chunk) =>
    db
      .prepare(`DELETE FROM ${table} WHERE user_id = ?1 AND id IN (${chunkMarks(chunk)})`)
      .bind(userId, ...chunk),
  )
}

async function runAtomicDelete(
  db: D1Database,
  userId: string,
  ids: readonly string[],
  deleteTable: string,
  unbindTable: UnbindTable,
  unbindColumn: UnbindColumn,
): Promise<AtomicDeleteResult> {
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return { count: 0, updatedIds: [] }
  const deletions = deleteStatements(db, deleteTable, userId, unique)
  const statements = [
    unbindIdsStatement(db, unbindTable, unbindColumn, userId, unique, Date.now()),
    ...deletions,
  ]
  const results = await db.batch(statements)
  const updatedIds = (results[0]?.results ?? []).map((row) => (row as { id: string }).id)
  let count = 0
  for (let index = 1; index < results.length; index += 1) {
    count += Number(results[index]?.meta?.changes ?? 0)
  }
  return { count, updatedIds }
}

export function deleteReposAtomically(
  db: D1Database,
  userId: string,
  ids: readonly string[],
): Promise<AtomicDeleteResult> {
  return runAtomicDelete(
    db, userId, ids,
    'development_github_repos',
    'development_github_collections',
    'repo_ids',
  )
}

export function deleteTagsAtomically(
  db: D1Database,
  userId: string,
  ids: readonly string[],
): Promise<AtomicDeleteResult> {
  return runAtomicDelete(
    db, userId, ids,
    'development_github_tags',
    'development_github_repos',
    'tag_ids',
  )
}

export function deleteGistTagsAtomically(
  db: D1Database,
  userId: string,
  ids: readonly string[],
): Promise<AtomicDeleteResult> {
  return runAtomicDelete(
    db, userId, ids,
    'development_github_gist_tags',
    'development_github_gists',
    'tag_ids',
  )
}

export async function deleteCollectionsAtomically(
  db: D1Database,
  userId: string,
  ids: readonly string[],
): Promise<number> {
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return 0
  const statements = unique.map((id) =>
    db
      .prepare('DELETE FROM development_github_collections WHERE user_id = ?1 AND id = ?2')
      .bind(userId, id),
  )
  const results = await db.batch(statements)
  return results.reduce((total, result) => total + Number(result.meta?.changes ?? 0), 0)
}
