/**
 * Cross-board search. Results are filtered to the boards the caller can actually read BEFORE any
 * matching, so a private board's titles never leak through a search hit. This first version matches
 * with LIKE over board and card titles; the reserved project_fts table and pinyin initials are the
 * indexed follow-up (the queue/drain machinery mirrors notes once write-path indexing is wired).
 */
import { PROJECT_LIMITS } from '@shared/project/limits'
import { ProjectStore } from './store'

export interface ProjectSearchResult {
  boards: { id: string, title: string, icon: string }[]
  cards: { id: string, boardId: string, title: string }[]
}

const CHUNK = 90
const LIMIT = PROJECT_LIMITS.searchResults

export async function searchProject(db: D1Database, userId: string, query: string): Promise<ProjectSearchResult> {
  const needle = `%${query.replace(/[%_\\]/g, '\\$&')}%`
  const readable = await new ProjectStore(db, userId).boards()
  const ids = readable.map((board) => board.id)
  const boards = readable
    .filter((board) => board.title.toLowerCase().includes(query.toLowerCase()))
    .slice(0, LIMIT)
    .map((board) => ({ id: board.id, title: board.title, icon: board.icon }))
  const cards: ProjectSearchResult['cards'] = []
  for (let index = 0; index < ids.length && cards.length < LIMIT; index += CHUNK) {
    const chunk = ids.slice(index, index + CHUNK)
    const placeholders = chunk.map((_, i) => `?${i + 2}`).join(', ')
    const { results } = await db
      .prepare(`SELECT id, board_id, title FROM project_cards WHERE delete_at = 0 AND title LIKE ?1 ESCAPE '\\' AND board_id IN (${placeholders}) LIMIT ?${chunk.length + 2}`)
      .bind(needle, ...chunk, LIMIT - cards.length)
      .all<{ id: string, board_id: string, title: string }>()
    for (const row of results) cards.push({ id: row.id, boardId: row.board_id, title: row.title })
  }
  return { boards, cards: cards.slice(0, LIMIT) }
}