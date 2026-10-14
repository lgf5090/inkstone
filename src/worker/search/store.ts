/**
 * Every read the search and graph HTTP routes make against D1.
 *
 * The shape follows `settings/store.ts`: a store built per request from the account it serves,
 * methods that hand back rows, counts or the one truncation flag a page needs, and no `Response` in
 * sight. What stays in the route is the query parsing, the FTS-over-LIKE fallback decision and its
 * warning, the re-ranking, snippets, node and
 * edge assembly, the throttles, the `ApiError` codes and the response shape.
 *
 * Scoping, statement by statement, because a search that drops the account predicate answers one
 * reader with another reader's notes and no test would notice:
 *  - both note searches bind the account first and reuse that one number for every owner predicate:
 *    `n.user_id = ?1` for LIKE, `notes_fts.user_id = ?2 AND n.user_id = ?2` for FTS, where ?2 is the
 *    account. The FTS filter expression in ?1 carries `user_id : "…"` with the id's quotes doubled,
 *    so the match half of the statement is scoped too — it is not only the WHERE clause that knows
 *    whose rows these are;
 *  - the graph reads bind the account into the recursive neighbourhood (`l.user_id = ?`), into the
 *    edge-degree CTE (`WHERE l.user_id = ?`) and first in the filter list (`n.user_id = ?`), and the
 *    count rides the same filters as the rows it counts;
 *  - `note_tags` has no `user_id` column at all (it is a two-column join table), so the tag halves
 *    are scoped through the tags they reach: `t.user_id = ?` in the edge/tag fetch,
 *    `t_filter.user_id = n.user_id` in the graph filters, and `t.user_id = n.user_id` inside
 *    `NOTE_COLUMNS`. The note ids handed to the edge/tag fetch come from a page that statement
 *    already scoped, and a tag id belongs to exactly one account, so neither read can name another
 *    reader's tags.
 *
 * Nothing here is account-free: unlike `auth/store.ts` and the public half of
 * `share/presence-store.ts`, search has no question to answer before a session exists.
 *
 * Bind numbers are counted by hand, since a filter clause has to know how many parameters came
 * before it — `applyFilters()` appends to the caller's bind list and numbers its own placeholders
 * against it, so the order of those pushes is part of the contract, and so is the batch grouping:
 * each graph page submits its rows and its count as one `db.batch` pair read by position, and the
 * edge/tag fetch submits one link statement plus one tag statement per `GRAPH_NOTE_ID_CHUNK` slice
 * into a single batch whose results are paired two at a time, with the link statement asked for one
 * row past `GRAPH_EDGE_CANDIDATE_LIMIT` so an over-cap page is visible as truncation rather than as
 * a complete answer.
 */

import { LIMITS } from '@shared/constants'
import { likePattern, segmentCJK } from '@shared/markdown-utils'
import type { ParsedQuery } from '@shared/search-query'
import { NOTE_COLUMNS, tagScopePredicate, type NoteRow } from '../db/rows'

/** Edge candidates one graph page may carry; one past this is the truncation signal. */
export const GRAPH_EDGE_CANDIDATE_LIMIT = 10_000

/**
 * The FTS match string the account's search asks for: every term segmented, quoted and prefix-OR'd.
 *
 * It lives here because both readers of the FTS index need the exact same text — the search route and
 * `notes/store.ts`, which titles a note whose index row must be found again. A store may not reach
 * into a route for it (`AGENTS.md` rule 3), and two copies would drift into different match strings.
 */
export function buildFtsQuery(terms: string[]): string {
  const parts: string[] = []
  for (const term of terms) {
    const seg = segmentCJK(term).trim().replace(/"/g, '')
    if (!seg) continue
    if (seg.includes(' ')) parts.push(`"${seg}"`)
    else parts.push(`"${seg}"*`)
  }
  return parts.join(' AND ')
}
const GRAPH_NOTE_ID_CHUNK = 40
const DOCUMENT_PAGE_CHARS = 400_000

export type GraphLinkDirection = 'both' | 'incoming' | 'outgoing'

/** A note row as the LIKE statement projects it: the summary columns plus the windowed body a snippet is cut from. */
export type SearchNoteRow = NoteRow & { content: string }

/** The same row plus the bm25 rank the FTS statement sorts on. */
export type FtsNoteRow = NoteRow & { content: string; score: number }

/** One edge of a graph page, unresolved targets included (`target_note_id` is then null). */
export type GraphLinkRow = {
  source_note_id: string
  target_note_id: string | null
  target_key: string
  target_title: string
}

/** One tag name of a graph page's notes. */
export type GraphTagRow = { note_id: string; name: string; color: string | null }

/** One node of a graph page, in the columns both graph statements select. */
export interface GraphNodeRow {
  id: string
  title: string
  folder_id: string | null
  folder_name: string | null
  folder_color: string | null
  degree: number
  in_degree: number
  out_degree: number
}

/** The parts of a graph request that decide which rows come back; the rest is the route's assembly. */
export interface GraphNodeQuery {
  mode: 'global' | 'local'
  centerId: string | null
  depth: number
  limit: number
  query: string
  folderId: string
  tags: string[]
  tagsMatch: 'any' | 'all'
  includeOrphans: boolean
  excluded: string[]
  direction: GraphLinkDirection
}

/** The row the document page selects, with the per-note truncation window applied. */
export interface DocumentRow {
  id: string
  title: string
  updated_at: number
  is_archived: number
  is_starred: number
  folder_id: string | null
  content: string | null
  chars: number
}

export class SearchStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /**
   * The notes whose FTS rows have not been written yet.
   *
   * `notes_fts` lags the note table by one drain, so these ids are searched by LIKE and merged with
   * the FTS page instead of being invisible until the queue drains.
   */
  async pendingFtsNoteIds(): Promise<string[]> {
    const userId = this.userId
    const pendingRows = await this.db
      .prepare(`SELECT DISTINCT note_id FROM fts_index_queue WHERE user_id = ?1 LIMIT 20`)
      .bind(userId)
      .all<{ note_id: string }>()
    return pendingRows.results.map((r) => r.note_id).filter(Boolean)
  }

  /** The account's live notes matching `match`, ranked by bm25, body windowed around the first term. */
  async ftsNoteRows(match: string, q: ParsedQuery, limit: number): Promise<FtsNoteRow[]> {
    const userId = this.userId
    const binds: unknown[] = [`user_id : "${userId.replace(/"/g, '""')}" AND {title body} : (${match})`, userId]
    let where = `notes_fts MATCH ?1 AND notes_fts.user_id = ?2
      AND n.user_id = ?2 AND n.deleted_at IS NULL`
    applyFilters(q, binds, 2, (clause) => (where += clause))
    binds.push(q.terms[0]!)
    const contentWindow = contentWindowSql(binds.length)
    binds.push(limit)

    const { results } = await this.db
      .prepare(
        `SELECT ${NOTE_COLUMNS}, ${contentWindow} AS content,
                bm25(notes_fts, 0.0, 0.0, 10.0, 1.0) AS score
           FROM notes_fts JOIN notes n
             ON n.id = notes_fts.note_id AND n.user_id = notes_fts.user_id
          WHERE ${where}
          ORDER BY score ASC, n.updated_at DESC, n.id ASC
          LIMIT ?${binds.length}`,
      )
      .bind(...binds)
      .all<NoteRow & { content: string; score: number }>()
    return results
  }

  /**
   * The account's notes whose title or body contains every term, read as up to `min(limit * 3, 600)`
   * candidates so the route can re-rank the page in memory.
   *
   * `noteIds` narrows the read to the ids the caller named (the pending-queue half of a search), and an
   * empty list answers empty rather than emitting `IN ()`, which SQLite rejects.
   */
  async likeNoteRows(q: ParsedQuery, limit: number, noteIds?: string[]): Promise<SearchNoteRow[]> {
    if (noteIds && !noteIds.length) return []
    const userId = this.userId
    const binds: unknown[] = [userId]
    const termBindIndexes: number[] = []
    let where = 'n.user_id = ?1'
    where += q.trash ? ' AND n.deleted_at IS NOT NULL' : ' AND n.deleted_at IS NULL'
    if (noteIds && noteIds.length) {
      const placeholders = noteIds.map((id) => {
        binds.push(id)
        return `?${binds.length}`
      }).join(', ')
      where += ` AND n.id IN (${placeholders})`
    }

    for (const term of q.terms) {
      binds.push(`%${escapeLike(term)}%`)
      const i = binds.length
      termBindIndexes.push(i)
      where += ` AND (n.title LIKE ?${i} ESCAPE '\\' OR n.content LIKE ?${i} ESCAPE '\\')`
    }
    applyFilters(q, binds, 1, (clause) => (where += clause))

    const candidateLimit = q.terms.length ? Math.min(limit * 3, 600) : limit
    let contentSelect = 'n.excerpt'
    if (q.terms.length) {
      binds.push(q.terms[0]!)
      contentSelect = contentWindowSql(binds.length)
    }
    binds.push(candidateLimit)
    // A term-less query (folder:/tag:/is: only) must not emit `ORDER BY 0`: SQLite reads a bare
    // integer there as a result-column ordinal and rejects 0 outright.
    const titleRank = termBindIndexes.length
      ? `${termBindIndexes.map((index) => `(CASE WHEN n.title LIKE ?${index} ESCAPE '\\' THEN 10 ELSE 0 END)`).join(' + ')}, `
      : ''
    const { results } = await this.db
      .prepare(
        `SELECT ${NOTE_COLUMNS}, ${contentSelect} AS content FROM notes n
          WHERE ${where}
          ORDER BY ${titleRank}n.updated_at DESC, n.id ASC
          LIMIT ?${binds.length}`,
      )
      .bind(...binds)
      .all<NoteRow & { content: string }>()
    return results
  }

  /**
   * The edges and tags of one graph page, in `GRAPH_NOTE_ID_CHUNK` id slices.
   *
   * One batch, two statements per slice, results read by position: the chunking is what keeps every
   * statement under D1's bound-variable ceiling, and the link statement asks for one row past
   * `GRAPH_EDGE_CANDIDATE_LIMIT` so an over-cap slice shows up as truncation instead of as a complete
   * answer. Sorting merges the per-chunk orders back into one.
   */
  async graphLinkAndTagRows(
    ids: readonly string[],
  ): Promise<{ links: GraphLinkRow[]; tags: GraphTagRow[]; truncated: boolean }> {
    const userId = this.userId
    const statements: D1PreparedStatement[] = []
    for (let offset = 0; offset < ids.length; offset += GRAPH_NOTE_ID_CHUNK) {
      const chunk = ids.slice(offset, offset + GRAPH_NOTE_ID_CHUNK)
      const placeholders = chunk.map(() => '?').join(',')
      statements.push(
        this.db.prepare(
          `SELECT source_note_id, target_note_id, target_key, target_title FROM links
           WHERE user_id = ? AND source_note_id IN (${placeholders})
           ORDER BY source_note_id ASC, target_key ASC LIMIT ?`,
        ).bind(userId, ...chunk, GRAPH_EDGE_CANDIDATE_LIMIT + 1),
        this.db.prepare(
          `SELECT nt.note_id, t.name, t.color FROM note_tags nt
           JOIN tags t ON t.id = nt.tag_id AND t.user_id = ?
           WHERE nt.note_id IN (${placeholders}) ORDER BY t.name COLLATE NOCASE ASC`,
        ).bind(userId, ...chunk),
      )
    }
    const batch = await this.db.batch(statements)
    const links: GraphLinkRow[] = []
    const tags: GraphTagRow[] = []
    let truncated = false
    for (let index = 0; index < batch.length; index += 2) {
      const linkRows = ((batch[index] as D1Result<GraphLinkRow> | undefined)?.results ?? [])
      const tagRows = ((batch[index + 1] as D1Result<GraphTagRow> | undefined)?.results ?? [])
      if (linkRows.length > GRAPH_EDGE_CANDIDATE_LIMIT) truncated = true
      links.push(...linkRows)
      tags.push(...tagRows)
    }
    links.sort((left, right) => (left.source_note_id === right.source_note_id
      ? (left.target_key < right.target_key ? -1 : left.target_key > right.target_key ? 1 : 0)
      : (left.source_note_id < right.source_note_id ? -1 : 1)))
    return { links, tags, truncated }
  }

  /**
   * One graph page plus the total behind it.
   *
   * Rows are read to `limit + 1` so an over-cap page stays visible to the route, and the count is
   * asked with the same filters in the same batch — the pairing the route wrote by hand before this
   * file existed, kept as it was.
   */
  async graphNodeRows(input: GraphNodeQuery): Promise<{ rows: GraphNodeRow[]; totalNodes: number }> {
    const userId = this.userId
    const { mode, centerId, depth, limit, query, folderId, tags, tagsMatch } = input
    const { includeOrphans, excluded, direction } = input
    const filters: string[] = ['n.user_id = ?', 'n.deleted_at IS NULL', 'n.is_archived = 0']
    const filterBinds: unknown[] = [userId]
    if (query) {
      filters.push(`n.title LIKE ? ESCAPE '\\' COLLATE NOCASE`)
      filterBinds.push(`%${escapeLike(query)}%`)
    }
    if (folderId) {
      filters.push('n.folder_id = ?')
      filterBinds.push(folderId)
    }
    if (tags.length) {
      if (tagsMatch === 'all') {
        for (const item of tags) {
          filters.push(`EXISTS (
            SELECT 1 FROM note_tags nt_filter
            JOIN tags t_filter ON t_filter.id = nt_filter.tag_id AND t_filter.user_id = n.user_id
            WHERE nt_filter.note_id = n.id AND t_filter.name = ? COLLATE NOCASE
          )`)
          filterBinds.push(item)
        }
      } else {
        filters.push(`EXISTS (
          SELECT 1 FROM note_tags nt_filter
          JOIN tags t_filter ON t_filter.id = nt_filter.tag_id AND t_filter.user_id = n.user_id
          WHERE nt_filter.note_id = n.id AND t_filter.name COLLATE NOCASE IN (${tags.map(() => '?').join(', ')})
        )`)
        filterBinds.push(...tags)
      }
    }
    const dropped = excluded.filter((id) => id !== centerId)
    if (dropped.length) {
      filters.push('n.id NOT IN (SELECT value FROM json_each(?))')
      filterBinds.push(JSON.stringify(dropped))
    }
    if (!includeOrphans) {
      filters.push(`(EXISTS (
        SELECT 1 FROM links outgoing
        WHERE outgoing.user_id = n.user_id AND outgoing.source_note_id = n.id AND outgoing.target_note_id IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM links incoming
        WHERE incoming.user_id = n.user_id AND incoming.target_note_id = n.id
      ))`)
    }

    const linkDegreeCte = `
      link_edges AS (
        SELECT l.source_note_id, l.target_note_id
          FROM links l
          JOIN notes src ON src.id = l.source_note_id AND src.user_id = l.user_id
            AND src.deleted_at IS NULL AND src.is_archived = 0
          JOIN notes dst ON dst.id = l.target_note_id AND dst.user_id = l.user_id
            AND dst.deleted_at IS NULL AND dst.is_archived = 0
         WHERE l.user_id = ? AND l.target_note_id IS NOT NULL
      ),
      link_counts AS (
        SELECT note_id,
               SUM(is_out) AS out_degree,
               SUM(is_in) AS in_degree,
               SUM(is_deg) AS degree
        FROM (
          SELECT source_note_id AS note_id, 1 AS is_out, 0 AS is_in, 1 AS is_deg
            FROM link_edges
          UNION ALL
          SELECT target_note_id AS note_id, 0 AS is_out, 1 AS is_in,
                 CASE WHEN source_note_id = target_note_id THEN 0 ELSE 1 END AS is_deg
            FROM link_edges
        )
        GROUP BY note_id
      )`

    if (mode === 'local') {
      const neighborhood = localNeighborhoodSql(direction)
      const prefixBinds = [centerId, centerId, userId, depth]
      const [rowsResult, countResult] = await this.db.batch([
        this.db.prepare(
          `${neighborhood},
           ${linkDegreeCte}
           SELECT n.id, n.title, n.folder_id, f.name AS folder_name, f.color AS folder_color,
             COALESCE(lc.degree, 0) AS degree,
             COALESCE(lc.in_degree, 0) AS in_degree,
             COALESCE(lc.out_degree, 0) AS out_degree,
             nearby.depth
           FROM nearby JOIN notes n ON n.id = nearby.id
           LEFT JOIN folders f ON f.id = n.folder_id AND f.user_id = n.user_id
           LEFT JOIN link_counts lc ON lc.note_id = n.id
           WHERE ${filters.join(' AND ')}
           ORDER BY nearby.depth ASC, degree DESC, n.updated_at DESC, n.id ASC LIMIT ?`,
        ).bind(...prefixBinds, userId, ...filterBinds, limit + 1),
        this.db.prepare(
          `${neighborhood} SELECT COUNT(*) AS count FROM nearby JOIN notes n ON n.id = nearby.id
           WHERE ${filters.join(' AND ')}`,
        ).bind(...prefixBinds, ...filterBinds),
      ])
      const rows = (rowsResult as D1Result<GraphNodeRow>).results
      return {
        rows,
        totalNodes: Number((countResult as D1Result<{ count: number }>).results?.[0]?.count ?? rows.length),
      }
    }

    const [rowsResult, countResult] = await this.db.batch([
      this.db.prepare(
        `WITH ${linkDegreeCte}
         SELECT n.id, n.title, n.folder_id, f.name AS folder_name, f.color AS folder_color,
           COALESCE(lc.degree, 0) AS degree,
           COALESCE(lc.in_degree, 0) AS in_degree,
           COALESCE(lc.out_degree, 0) AS out_degree
         FROM notes n
         LEFT JOIN folders f ON f.id = n.folder_id AND f.user_id = n.user_id
         LEFT JOIN link_counts lc ON lc.note_id = n.id
         WHERE ${filters.join(' AND ')}
         ORDER BY degree DESC, n.updated_at DESC, n.id ASC LIMIT ?`,
      ).bind(userId, ...filterBinds, limit + 1),
      this.db.prepare(
        `SELECT COUNT(*) AS count FROM notes n WHERE ${filters.join(' AND ')}`,
      ).bind(...filterBinds),
    ])
    const rows = (rowsResult as D1Result<GraphNodeRow>).results
    return {
      rows,
      totalNodes: Number((countResult as D1Result<{ count: number }>).results?.[0]?.count ?? rows.length),
    }
  }

  /**
   * One page of note bodies for the client-side index. `running` is the truncated size accumulated in
   * id order: keeping the rows that *start* under the budget means at least one row is always returned,
   * so the client can never stall on a note bigger than a page, and no page is bigger than the budget
   * plus one note.
   */
  async documentRows(ids: readonly string[]): Promise<DocumentRow[]> {
    if (!ids.length) return []
    const userId = this.userId
    const binds: unknown[] = [userId, LIMITS.omnisearchDocumentChars, DOCUMENT_PAGE_CHARS]
    for (const id of ids) binds.push(id)
    const placeholders = ids.map((_, index) => `?${index + 4}`).join(', ')
    const { results } = await this.db
      .prepare(
        `SELECT id, title, updated_at, is_archived, is_starred, folder_id, content, chars FROM (
           SELECT n.id, n.title, n.updated_at, n.is_archived, n.is_starred, n.folder_id,
             substr(n.content, 1, ?2) AS content,
             length(n.content) AS chars,
             SUM(MIN(length(n.content), ?2)) OVER (ORDER BY n.id ROWS UNBOUNDED PRECEDING) AS running
             FROM notes n
            WHERE n.user_id = ?1 AND n.deleted_at IS NULL AND n.id IN (${placeholders})
         ) WHERE running - MIN(chars, ?2) < ?3`,
      )
      .bind(...binds)
      .all<DocumentRow>()
    return results
  }
}

function applyFilters(q: ParsedQuery, binds: unknown[], userIdParam: number, append: (clause: string) => void): void {
  if (q.starred === true) append(' AND n.is_starred = 1')
  if (q.archived === true) append(' AND n.is_archived = 1')
  else if (q.archived === false) append(' AND n.is_archived = 0')

  // Both halves stay in step with the note-list route's `tag` / `excludeTag` params and with
  // tagInScope(): a search for a parent also means its subtree, otherwise the sidebar count and
  // the search result set disagree about the same click.
  for (const tag of q.tags) {
    binds.push(tag, likePattern(`${tag}/`))
    const nameBind = binds.length - 1
    const prefixBind = binds.length
    append(
      ` AND EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
          WHERE nt.note_id = n.id AND t.user_id = n.user_id
            AND ${tagScopePredicate('t.name', `?${nameBind}`, `?${prefixBind}`)})`,
    )
  }
  for (const tag of q.excludedTags) {
    binds.push(tag, likePattern(`${tag}/`))
    const nameBind = binds.length - 1
    const prefixBind = binds.length
    append(
      ` AND NOT EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
          WHERE nt.note_id = n.id AND t.user_id = n.user_id
            AND ${tagScopePredicate('t.name', `?${nameBind}`, `?${prefixBind}`)})`,
    )
  }
  if (q.folder) {
    binds.push(q.folder)
    // The folder view is recursive, so folder: has to walk the subtree too. UNION rather than
    // UNION ALL keeps a parent_id cycle from looping forever.
    append(
      ` AND n.folder_id IN (
          WITH RECURSIVE folder_subtree(id) AS (
            SELECT id FROM folders WHERE user_id = ?${userIdParam} AND name = ?${binds.length} COLLATE NOCASE
            UNION
            SELECT f.id FROM folders f JOIN folder_subtree s ON f.parent_id = s.id
             WHERE f.user_id = ?${userIdParam}
          )
          SELECT id FROM folder_subtree
        )`,
    )
  }
}

function localNeighborhoodSql(direction: GraphLinkDirection): string {
  const reached = direction === 'incoming'
    ? 'l.target_note_id = neighborhood.id'
    : direction === 'outgoing'
      ? 'l.source_note_id = neighborhood.id'
      : '(l.source_note_id = neighborhood.id OR l.target_note_id = neighborhood.id)'
  const neighbour = direction === 'incoming'
    ? 'l.source_note_id'
    : direction === 'outgoing'
      ? 'l.target_note_id'
      : 'CASE WHEN l.source_note_id = neighborhood.id THEN l.target_note_id ELSE l.source_note_id END'
  return `WITH RECURSIVE neighborhood(id, depth, path) AS (
      SELECT ? AS id, 0 AS depth, ',' || ? || ',' AS path
      UNION
      SELECT adjacent.id, neighborhood.depth + 1, neighborhood.path || adjacent.id || ','
      FROM neighborhood
      JOIN links l ON l.user_id = ? AND l.target_note_id IS NOT NULL AND ${reached}
      JOIN notes adjacent ON adjacent.id = ${neighbour}
        AND adjacent.user_id = l.user_id AND adjacent.deleted_at IS NULL AND adjacent.is_archived = 0
      WHERE neighborhood.depth < ? AND INSTR(neighborhood.path, ',' || adjacent.id || ',') = 0
    ), nearby AS (SELECT id, MIN(depth) AS depth FROM neighborhood GROUP BY id)`
}

function contentWindowSql(termBindIndex: number): string {
  const found = `instr(lower(n.content), lower(?${termBindIndex}))`
  return `substr(n.content, CASE WHEN ${found} > 180 THEN ${found} - 180 ELSE 1 END, 520)`
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
