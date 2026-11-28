/**
 * Cross-board search. Results are filtered to the boards and properties the caller can read before
 * matching, so private board titles and restricted field values never leak through a search hit.
 */
import { PROJECT_LIMITS } from '@shared/project/limits'
import { ProjectStore } from './store'
import { readBoardProperties } from './boards'
import { projectPropertiesForRole } from './visibility'
import { ApiError } from '../lib/errors'

export interface ProjectSearchResult {
  boards: { id: string, title: string, icon: string }[]
  cards: { id: string, boardId: string, title: string }[]
}

const BOARD_CHUNK = 80
const PROPERTY_CHUNK = 80
const LIMIT = PROJECT_LIMITS.searchResults

function validateSearchQuery(query: string): void {
  const needle = `%${query.replace(/[%_\\]/g, '\\$&')}%`
  if (new TextEncoder().encode(needle).byteLength > PROJECT_LIMITS.searchPatternBytes) {
    throw ApiError.badRequest('search query is too long')
  }
}

export async function searchProject(db: D1Database, userId: string, query: string): Promise<ProjectSearchResult> {
  if (!query) return { boards: [], cards: [] }
  validateSearchQuery(query)
  if (/[%_\\]/.test(query)) return searchProjectLike(db, userId, query)
  const tokens = query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  if (!tokens.length) return searchProjectLike(db, userId, query)
  const match = tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' AND ')
  const readable = await new ProjectStore(db, userId).boards()
  const boards = readable
    .filter((board) => board.title.toLowerCase().includes(query.toLowerCase()))
    .slice(0, LIMIT)
    .map((board) => ({ id: board.id, title: board.title, icon: board.icon }))
  const found = new Map<string, { id: string, boardId: string, title: string }>()
  const add = (row: { id: string, board_id: string, title: string }): void => {
    if (found.size < LIMIT) found.set(row.id, { id: row.id, boardId: row.board_id, title: row.title })
  }

  for (let index = 0; index < readable.length && found.size < LIMIT; index += BOARD_CHUNK) {
    const chunk = readable.slice(index, index + BOARD_CHUNK)
    const placeholders = chunk.map((_, at) => `?${at + 2}`).join(', ')
    const { results } = await db.prepare(
      `SELECT DISTINCT c.id, c.board_id, c.title
       FROM project_search_fts f
       JOIN project_cards c ON c.id = f.card_id AND c.delete_at = 0
       JOIN project_boards b ON b.id = c.board_id AND b.delete_at = 0 AND b.archived = 0
       WHERE f.board_id IN (${placeholders})
         AND f.kind IN ('title', 'content', 'comment')
         AND f.text MATCH ?1
       ORDER BY f.rank, c.id
       LIMIT ?${chunk.length + 2}`,
    ).bind(match, ...chunk.map((board) => board.id), LIMIT - found.size).all<{ id: string, board_id: string, title: string }>()
    for (const row of results) add(row)
  }

  for (const board of readable) {
    if (found.size >= LIMIT) break
    const properties = projectPropertiesForRole(await readBoardProperties(db, board.id), board.role)
    for (let at = 0; at < properties.length && found.size < LIMIT; at += PROPERTY_CHUNK) {
      const chunk = properties.slice(at, at + PROPERTY_CHUNK)
      const placeholders = chunk.map((_, index) => `?${index + 3}`).join(', ')
      const { results } = await db.prepare(
        `SELECT DISTINCT c.id, c.board_id, c.title
         FROM project_search_fts f
         JOIN project_cards c ON c.id = f.card_id AND c.delete_at = 0
         WHERE f.board_id = ?1 AND f.kind = 'value'
           AND f.property_id IN (${placeholders})
           AND f.text MATCH ?2
         ORDER BY f.rank, c.id
         LIMIT ?${chunk.length + 3}`,
      ).bind(board.id, match, ...chunk.map((property) => property.id), LIMIT - found.size)
        .all<{ id: string, board_id: string, title: string }>()
      for (const row of results) add(row)
    }
  }
  return { boards, cards: [...found.values()] }
}

async function searchProjectLike(db: D1Database, userId: string, query: string): Promise<ProjectSearchResult> {
  const needle = `%${query.replace(/[%_\\]/g, '\\$&')}%`
  const readable = await new ProjectStore(db, userId).boards()
  const boards = readable
    .filter((board) => board.title.toLowerCase().includes(query.toLowerCase()))
    .slice(0, LIMIT)
    .map((board) => ({ id: board.id, title: board.title, icon: board.icon }))
  const found = new Map<string, { id: string, boardId: string, title: string }>()
  const add = (row: { id: string, board_id: string, title: string }): void => {
    if (found.size < LIMIT) found.set(row.id, { id: row.id, boardId: row.board_id, title: row.title })
  }

  for (let index = 0; index < readable.length && found.size < LIMIT; index += BOARD_CHUNK) {
    const chunk = readable.slice(index, index + BOARD_CHUNK)
    const placeholders = chunk.map((_, at) => `?${at + 2}`).join(', ')
    const { results } = await db.prepare(
      `SELECT c.id, c.board_id, c.title FROM project_cards c
       WHERE c.delete_at = 0 AND c.board_id IN (${placeholders})
         AND (
           c.title LIKE ?1 ESCAPE '\\'
           OR EXISTS (SELECT 1 FROM project_card_contents x WHERE x.card_id = c.id AND x.delete_at = 0 AND x.title LIKE ?1 ESCAPE '\\')
           OR EXISTS (SELECT 1 FROM project_comments m WHERE m.card_id = c.id AND m.delete_at = 0 AND m.body LIKE ?1 ESCAPE '\\')
         )
       LIMIT ?${chunk.length + 2}`,
    ).bind(needle, ...chunk.map((board) => board.id), LIMIT - found.size).all<{ id: string, board_id: string, title: string }>()
    for (const row of results) add(row)
  }

  for (const board of readable) {
    if (found.size >= LIMIT) break
    const properties = projectPropertiesForRole(await readBoardProperties(db, board.id), board.role)
    for (let at = 0; at < properties.length && found.size < LIMIT; at += PROPERTY_CHUNK) {
      const chunk = properties.slice(at, at + PROPERTY_CHUNK)
      const placeholders = chunk.map((_, index) => `?${index + 3}`).join(', ')
      const { results } = await db.prepare(
        `SELECT DISTINCT c.id, c.board_id, c.title
         FROM project_cards c
         JOIN project_card_values v ON v.card_id = c.id
         WHERE c.delete_at = 0 AND c.board_id = ?1
           AND v.property_id IN (${placeholders})
           AND v.value LIKE ?2 ESCAPE '\\'
         LIMIT ?${chunk.length + 3}`,
      ).bind(board.id, needle, ...chunk.map((property) => property.id), LIMIT - found.size)
        .all<{ id: string, board_id: string, title: string }>()
      for (const row of results) add(row)
    }
  }
  return { boards, cards: [...found.values()] }
}
