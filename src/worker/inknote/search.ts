/**
 * Inknote search: literal substring matching over note titles and the text extracted from pages.
 *
 * The corpus is personal-scale, so there is no FTS index and no tokeniser — a `LIKE` with escaped
 * wildcards is enough, and it is the only way a one-character Chinese term matches. Each note
 * appears once: a title hit wins (page index 0), otherwise the first matching page is reported.
 */

import { INKNOTE_LIMITS } from '@shared/inknote/constants'
import type { InknoteSearchResponse } from '@shared/inknote/api'
import type { InknoteSearchResult } from '@shared/inknote/types'

export interface InknoteSearchInput {
  q: string
  notebookId?: string
  limit?: number
}

interface SearchRow {
  note_id: string
  title: string
  notebook_id: string
  notebook_name: string
  subject_name: string
  updated_at: number
  page_position: number
  hit_text: string
}

const SNIPPET_RADIUS = 80
const SNIPPET_MAX = 160
const DEFAULT_LIMIT = 50

/** `%`, `_` and the escape character itself are literal, as the reader typed them. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** A 160-character window around the first hit, whitespace collapsed, never HTML. */
function snippet(text: string, needle: string): string {
  const folded = text.toLowerCase()
  const at = folded.indexOf(needle.toLowerCase())
  const start = at < 0 ? 0 : Math.max(0, at - SNIPPET_RADIUS)
  const window = Array.from(text.slice(start, start + SNIPPET_MAX * 2)).slice(0, SNIPPET_MAX).join('')
  return window.replace(/\s+/g, ' ').trim()
}

function resultKey(row: SearchRow, q: string, titleMatch: boolean, pageIndex: number): InknoteSearchResult {
  return {
    noteId: row.note_id,
    title: row.title,
    notebookId: row.notebook_id,
    notebookName: row.notebook_name,
    subjectName: row.subject_name,
    pageIndex,
    snippet: titleMatch ? snippet(row.title, q) : snippet(row.hit_text, q),
    titleMatch,
  }
}

export async function searchInknote(
  db: D1Database,
  userId: string,
  input: InknoteSearchInput,
): Promise<InknoteSearchResponse> {
  const q = input.q.trim()
  if (!q) return { results: [], total: 0 }
  const needle = q.slice(0, INKNOTE_LIMITS.searchQueryMaxLength)
  // `title_key` is stored lower-cased; SQLite's LIKE folds ASCII case for page text as well.
  const pattern = `%${escapeLike(needle.toLowerCase())}%`
  const limit = Math.min(
    Math.max(1, Math.trunc(input.limit ?? DEFAULT_LIMIT)),
    INKNOTE_LIMITS.searchResultsMax,
  )
  const notebookId = input.notebookId?.trim() || undefined
  const notebookFilter = notebookId ? ' AND n.notebook_id = ?3' : ''
  const notebookFilterPages = notebookId ? ' AND n.notebook_id = ?3' : ''

  const titleStatement = db.prepare(
    `SELECT n.id AS note_id, n.title, n.notebook_id,
            COALESCE(b.name, '') AS notebook_name,
            COALESCE(s.name, '') AS subject_name,
            n.updated_at, 0 AS page_position, '' AS hit_text
       FROM inknote_notes n
       LEFT JOIN inknote_notebooks b ON b.user_id = n.user_id AND b.id = n.notebook_id
       LEFT JOIN inknote_subjects s ON s.user_id = b.user_id AND s.id = b.subject_id
      WHERE n.user_id = ?1 AND n.deleted_at IS NULL
        AND n.title_key LIKE ?2 ESCAPE '\\'${notebookFilter}
      ORDER BY n.updated_at DESC, n.id ASC`,
  )
  const pageStatement = db.prepare(
    `WITH hits AS (
       SELECT n.id AS note_id, n.title, n.notebook_id,
              COALESCE(b.name, '') AS notebook_name,
              COALESCE(s.name, '') AS subject_name,
              n.updated_at, p.position AS page_position, p.search_text AS hit_text,
              ROW_NUMBER() OVER (PARTITION BY n.id ORDER BY p.position ASC) AS rank_no
         FROM inknote_pages p
         JOIN inknote_notes n ON n.user_id = p.user_id AND n.id = p.note_id
         LEFT JOIN inknote_notebooks b ON b.user_id = n.user_id AND b.id = n.notebook_id
         LEFT JOIN inknote_subjects s ON s.user_id = b.user_id AND s.id = b.subject_id
        WHERE p.user_id = ?1 AND n.deleted_at IS NULL
          AND p.search_text LIKE ?2 ESCAPE '\\'${notebookFilterPages}
     )
     SELECT note_id, title, notebook_id, notebook_name, subject_name, updated_at, page_position, hit_text
       FROM hits WHERE rank_no = 1
      ORDER BY updated_at DESC, note_id ASC`,
  )
  const bind = (statement: D1PreparedStatement) => (
    notebookId ? statement.bind(userId, pattern, notebookId) : statement.bind(userId, pattern)
  )
  const [titleResult, pageResult] = await Promise.all([
    bind(titleStatement).all<SearchRow>(),
    bind(pageStatement).all<SearchRow>(),
  ])

  const merged = new Map<string, { result: InknoteSearchResult; updatedAt: number }>()
  for (const row of titleResult.results ?? []) {
    merged.set(row.note_id, {
      result: resultKey(row, needle, true, 0),
      updatedAt: row.updated_at,
    })
  }
  for (const row of pageResult.results ?? []) {
    if (merged.has(row.note_id)) continue
    merged.set(row.note_id, {
      result: resultKey(row, needle, false, row.page_position),
      updatedAt: row.updated_at,
    })
  }

  const ordered = [...merged.values()].sort((left, right) => (
    right.updatedAt - left.updatedAt || (left.result.noteId < right.result.noteId ? -1 : 1)
  ))

  return {
    results: ordered.slice(0, limit).map((entry) => entry.result),
    total: ordered.length,
  }
}
