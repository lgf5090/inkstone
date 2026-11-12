/**
 * Personal statistics: how many boards this account can see and how many cards live on them. The
 * reference reported site-wide counts; a self-hosted instance only needs the caller's own. Visibility
 * is the same rule the board list uses, so the two never disagree about what counts.
 */
import { ProjectStore } from './store'

export interface ProjectStatistics {
  boardCount: number
  cardCount: number
}

// D1 caps bound parameters per query, so a wide board list is counted in chunks rather than one IN.
const COUNT_CHUNK_SIZE = 90

export async function projectStatistics(db: D1Database, userId: string): Promise<ProjectStatistics> {
  const boards = await new ProjectStore(db, userId).boards()
  const boardCount = boards.length
  let cardCount = 0
  const ids = boards.map((board) => board.id)
  for (let index = 0; index < ids.length; index += COUNT_CHUNK_SIZE) {
    const chunk = ids.slice(index, index + COUNT_CHUNK_SIZE)
    const placeholders = chunk.map((_, i) => `?${i + 1}`).join(', ')
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM project_cards WHERE delete_at = 0 AND board_id IN (${placeholders})`)
      .bind(...chunk)
      .first<{ n: number }>()
    cardCount += row?.n ?? 0
  }
  return { boardCount, cardCount }
}