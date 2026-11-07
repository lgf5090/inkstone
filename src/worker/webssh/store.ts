import type { D1Database } from '@cloudflare/workers-types'

export const WEBSSH_D1_MAX_BOUND_PARAMETERS = 99

export const WEBSSH_PAGE_SIZE_DEFAULT = 20

export const WEBSSH_PAGE_SIZE_MAX = 100

export interface WebsshReferenceCounts {
  counts: Map<string, number>
  truncatedIds: string[]
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

export function splitForBinding(ids: readonly string[], reserved = 0): string[][] {
  const size = Math.max(1, WEBSSH_D1_MAX_BOUND_PARAMETERS - reserved)
  const chunks: string[][] = []
  for (let index = 0; index < ids.length; index += size) chunks.push([...ids.slice(index, index + size)])
  return chunks
}

export async function countReferences(
  db: D1Database,
  userId: string,
  column: 'key_id' | 'credential_id',
  ids: readonly string[],
): Promise<WebsshReferenceCounts> {
  const counts = new Map<string, number>()
  for (const id of ids) counts.set(id, 0)
  if (!ids.length) return { counts, truncatedIds: [] }
  const chunks = splitForBinding(ids, 1)
  const truncatedIds: string[] = []
  for (const chunk of chunks) {
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
    const rows = await db.prepare(
      `SELECT ${column} AS ref_id, COUNT(*) AS ref_count
         FROM webssh_hosts
        WHERE user_id = ?1 AND deleted_at IS NULL AND ${column} IN (${placeholders})
        GROUP BY ${column}`,
    )
      .bind(userId, ...chunk)
      .all<{ ref_id: string; ref_count: number }>()
    for (const row of rows.results) {
      if (!counts.has(row.ref_id)) {
        truncatedIds.push(row.ref_id)
        continue
      }
      counts.set(row.ref_id, Number(row.ref_count))
    }
  }
  return { counts, truncatedIds }
}

export class WebsshStore {
  constructor(
    protected readonly db: D1Database,
    protected readonly userId: string,
    protected readonly now: number = Date.now(),
  ) {}
}
