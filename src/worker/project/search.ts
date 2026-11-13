/**
 * Cross-board search. Results are filtered to the boards the caller can actually read BEFORE any
 * matching, so a private board's titles never leak through a search hit. Cards match on their title,
 * their content blocks and their comments; the reserved project_fts table remains the indexed
 * follow-up once the write-path queue is wired.
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
      .prepare(
        `SELECT c.id, c.board_id, c.title FROM project_cards c
         WHERE c.delete_at = 0 AND c.board_id IN (${placeholders})
           AND (
             c.title LIKE ?1 ESCAPE '\\'
             OR EXISTS (SELECT 1 FROM project_card_contents x WHERE x.card_id = c.id AND x.delete_at = 0 AND x.title LIKE ?1 ESCAPE '\\')
             OR EXISTS (SELECT 1 FROM project_comments m WHERE m.card_id = c.id AND m.delete_at = 0 AND m.body LIKE ?1 ESCAPE '\\')
             OR EXISTS (SELECT 1 FROM project_card_values v WHERE v.card_id = c.id AND v.value LIKE ?1 ESCAPE '\\')
           )
         LIMIT ?${chunk.length + 2}`,
      )
      .bind(needle, ...chunk, LIMIT - cards.length)
      .all<{ id: string, board_id: string, title: string }>()
    for (const row of results) cards.push({ id: row.id, boardId: row.board_id, title: row.title })
  }
  return { boards, cards: cards.slice(0, LIMIT) }
}