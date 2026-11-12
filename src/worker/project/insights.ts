/**
 * "Top boards" for the insights surface: the boards this account can read, most recently updated
 * first, with a live card count. The reference ranked by an activity stream; until that lands the
 * board's own update_at is the recency signal, which is what put it at the top of the sidebar anyway.
 */
import { ProjectStore } from './store'
import { projectBoardMetadata } from './boards'

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
  const boards: ProjectTopBoard[] = []
  for (const board of page) {
    const meta = await projectBoardMetadata(db, board.id)
    boards.push({ id: board.id, title: board.title, icon: board.icon, updateAt: board.updateAt, cardCount: meta.cardCount })
  }
  return { boards, has_next: offset + limit < all.length }
}