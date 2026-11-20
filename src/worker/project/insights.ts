/**
 * "Top boards" for the insights surface: the boards this account can read, most recently updated
 * first, with a live card count. The reference ranked by an activity stream; until that lands the
 * board's own update_at is the recency signal, which is what put it at the top of the sidebar anyway.
 */
import { ProjectStore } from './store'

export interface ProjectTopBoard {
  id: string
  title: string
  icon: string
  updateAt: number
  cardCount: number
}

export async function topProjectBoards(db: D1Database, userId: string, limit: number, offset: number): Promise<{ boards: ProjectTopBoard[], has_next: boolean }> {
  const all = await new ProjectStore(db, userId).boards()
  const page = all.slice(offset, offset + limit)
  if (page.length === 0) return { boards: [], has_next: offset + limit < all.length }
  const placeholders = page.map((_, index) => `?${index + 1}`).join(', ')
  const { results } = await db
    .prepare(`SELECT board_id, COUNT(*) AS n FROM project_cards WHERE delete_at = 0 AND board_id IN (${placeholders}) GROUP BY board_id`)
    .bind(...page.map((board) => board.id))
    .all<{ board_id: string, n: number }>()
  const counts = new Map(results.map((row) => [row.board_id, row.n]))
  const boards: ProjectTopBoard[] = page.map((board) => ({
    id: board.id, title: board.title, icon: board.icon, updateAt: board.updateAt, cardCount: counts.get(board.id) ?? 0,
  }))
  return { boards, has_next: offset + limit < all.length }
}