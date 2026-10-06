import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import { likePattern, segmentCJK, toPlainText, wikiNoteTarget } from '@shared/markdown-utils'
import { sliceText, truncateText } from '@shared/text-utils'
import { applyTagNodes } from '@shared/graph-tag-nodes'
import { emptyParsedQuery, parseQuery, type ParsedQuery } from '@shared/search-query'
import type { GraphResponse, SearchHit, SearchResponse } from '@shared/types'
import type { AppBindings } from '../env'
import { FTS_DRAIN_ALL_BATCH, purgeStaleFtsRows, queueAllNotesForFtsIndex } from '../db/fts'
import { NOTE_COLUMNS, toNoteSummary, type NoteRow } from '../db/rows'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { acquireLease } from '../lib/lease'
import { scheduleFtsDrain } from '../lib/notify'
import { clampInt } from '../lib/request'
import { consumeAttemptBudget, ThrottleError } from '../lib/throttle'
import { requireAuth } from '../middleware/auth'

export const searchRoutes = new Hono<AppBindings>()

const GRAPH_EDGE_CANDIDATE_LIMIT = 10_000
const GRAPH_NOTE_ID_CHUNK = 40


export interface UserSearchResult {
  results: SearchHit[]
  mode: 'fts' | 'like'
  query: ParsedQuery
}

export async function searchUserNotes(
  db: D1Database,
  userId: string,
  raw: string,
  limit: number,
  ftsEnabled: boolean,
): Promise<UserSearchResult> {
  const query = parseQuery(truncateText(raw.trim(), 512))
  if (!raw.trim()) return { results: [], mode: ftsEnabled ? 'fts' : 'like', query }

  // Trashing queues an fts_index_queue 'delete' row and purgeStaleFtsRows drops any row whose
  // note is not live, so an in:trash query has nothing left in notes_fts to match against;
  // it is served by likeSearch instead. Keeping trash indexed would trade a niche ranking
  // improvement for an index lifecycle that has to survive restore and purge races.
  if (ftsEnabled && query.terms.length && !query.trash) {
    try {
      const ftsHits = await ftsSearch(db, userId, query, limit)
      const pendingRows = await db
        .prepare(`SELECT DISTINCT note_id FROM fts_index_queue WHERE user_id = ?1 LIMIT 20`)
        .bind(userId)
        .all<{ note_id: string }>()
      const pendingNoteIds = pendingRows.results.map((r) => r.note_id).filter(Boolean)
      if (!pendingNoteIds.length) {
        return { results: ftsHits, mode: 'fts', query }
      }
      const pendingHits = await likeSearch(db, userId, query, limit, pendingNoteIds)
      const pendingSet = new Set(pendingNoteIds)
      const merged: SearchHit[] = [...pendingHits]
      for (const hit of ftsHits) {
        if (!pendingSet.has(hit.note.id)) {
          merged.push(hit)
        }
      }
      merged.sort(
        (a, b) =>
          b.score - a.score ||
          b.note.updatedAt - a.note.updatedAt ||
          a.note.id.localeCompare(b.note.id),
      )
      return { results: merged.slice(0, limit), mode: 'fts', query }
    } catch (error) {
      console.warn(
        '[inkstone] FTS query failed; falling back to LIKE:',
        error instanceof Error ? error.message : error,
      )
    }
  }
  return { results: await likeSearch(db, userId, query, limit), mode: 'like', query }
}


function buildFtsQuery(terms: string[]): string {
  const parts: string[] = []
  for (const term of terms) {
    const seg = segmentCJK(term).trim().replace(/"/g, '')
    if (!seg) continue
    if (seg.includes(' ')) parts.push(`"${seg}"`)
    else parts.push(`"${seg}"*`)
  }
  return parts.join(' AND ')
}


searchRoutes.get('/search', requireAuth, async (c) => {
  const started = Date.now()
  const userId = c.get('userId')
  const raw = truncateText((c.req.query('q') ?? '').trim(), 512)
  const limit = clampInt(c.req.query('limit'), 1, 200, LIMITS.searchLimit)

  if (!raw) {
    const empty: SearchResponse = {
      results: [],
      mode: 'fts',
      took: 0,
      query: emptyParsedQuery(),
    }
    return c.json(empty)
  }

  const { ftsEnabled } = c.get('database')
  scheduleFtsDrain(c, 50)
  const result = await searchUserNotes(c.env.DB, userId, raw, limit, ftsEnabled)
  const q = result.query

  const body: SearchResponse = {
    results: result.results,
    mode: result.mode,
    took: Date.now() - started,
    query: {
      text: q.text,
      tags: q.tags,
      excludedTags: q.excludedTags,
      folder: q.folder,
      starred: q.starred,
      archived: q.archived,
    },
  }
  return c.json(body)
})

async function ftsSearch(
  db: D1Database,
  userId: string,
  q: ParsedQuery,
  limit: number,
): Promise<SearchHit[]> {
  const match = buildFtsQuery(q.terms)
  if (!match) return []

  const binds: unknown[] = [`user_id : "${userId.replace(/"/g, '""')}" AND {title body} : (${match})`, userId]
  let where = `notes_fts MATCH ?1 AND notes_fts.user_id = ?2
    AND n.user_id = ?2 AND n.deleted_at IS NULL`
  applyFilters(q, binds, 2, (clause) => (where += clause))
  binds.push(q.terms[0]!)
  const contentWindow = contentWindowSql(binds.length)
  binds.push(limit)


  const { results } = await db
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

  if (!results.length) return []

  return results.map((row) => ({
    note: toNoteSummary(row),
    snippet: makeSnippet(row.content ?? '', q.terms),
    score: -row.score,
  }))
}

async function likeSearch(
  db: D1Database,
  userId: string,
  q: ParsedQuery,
  limit: number,
  noteIds?: string[],
): Promise<SearchHit[]> {
  if (noteIds && !noteIds.length) return []
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
  const { results } = await db
    .prepare(
      `SELECT ${NOTE_COLUMNS}, ${contentSelect} AS content FROM notes n
        WHERE ${where}
        ORDER BY ${titleRank}n.updated_at DESC, n.id ASC
        LIMIT ?${binds.length}`,
    )
    .bind(...binds)
    .all<NoteRow & { content: string }>()

  const ranked = results.map((row) => ({ row, score: scoreOf(row, q.terms) }))
  if (q.terms.length) {
    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        b.row.updated_at - a.row.updated_at ||
        a.row.id.localeCompare(b.row.id),
    )
  }
  return ranked.slice(0, limit).map(({ row, score }) => ({
    note: toNoteSummary(row),
    snippet: makeSnippet(row.content, q.terms),
    score,
  }))
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
            AND (t.name = ?${nameBind} COLLATE NOCASE OR t.name LIKE ?${prefixBind} COLLATE NOCASE ESCAPE '\\'))`,
    )
  }
  for (const tag of q.excludedTags) {
    binds.push(tag, likePattern(`${tag}/`))
    const nameBind = binds.length - 1
    const prefixBind = binds.length
    append(
      ` AND NOT EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
          WHERE nt.note_id = n.id AND t.user_id = n.user_id
            AND (t.name = ?${nameBind} COLLATE NOCASE OR t.name LIKE ?${prefixBind} COLLATE NOCASE ESCAPE '\\'))`,
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

function makeSnippet(content: string, terms: string[], radius = 70): string {
  const plain = toPlainText(content).replace(/\s+/g, ' ')
  if (!plain) return ''
  const lower = plain.toLowerCase()

  let at = -1
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase())
    if (idx >= 0 && (at < 0 || idx < at)) at = idx
  }
  if (at < 0) return truncateText(plain, radius * 2) + (plain.length > radius * 2 ? '…' : '')

  const start = Math.max(0, at - radius)
  const end = Math.min(plain.length, at + radius * 1.6)
  return (start > 0 ? '…' : '') + sliceText(plain, start, end).trim() + (end < plain.length ? '…' : '')
}

function scoreOf(row: NoteRow & { content: string }, terms: string[]): number {
  let score = 0
  const title = row.title.toLowerCase()
  const body = row.content.toLowerCase()
  for (const term of terms) {
    const t = term.toLowerCase()
    if (title.includes(t)) score += 10
    score += countOccurrences(body, t, 8)
  }
  return score
}

function countOccurrences(text: string, query: string, limit: number): number {
  if (!query) return 0
  let count = 0
  let offset = 0
  while (count < limit) {
    const found = text.indexOf(query, offset)
    if (found < 0) break
    count++
    offset = found + query.length
  }
  return count
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function contentWindowSql(termBindIndex: number): string {
  const found = `instr(lower(n.content), lower(?${termBindIndex}))`
  return `substr(n.content, CASE WHEN ${found} > 180 THEN ${found} - 180 ELSE 1 END, 520)`
}


export type GraphLinkDirection = 'both' | 'incoming' | 'outgoing'

export interface GraphParams {
  userId: string
  mode: 'global' | 'local'
  centerId: string | null
  depth: number
  limit: number
  query: string
  folderId: string
  tags: string[]
  tagsMatch: 'any' | 'all'
  includeOrphans: boolean
  includeUnresolved: boolean
  showTagNodes: boolean
  excluded: string[]
  direction: GraphLinkDirection
}

export function localNeighborhoodSql(direction: GraphLinkDirection): string {
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

type GraphLinkRow = {
  source_note_id: string
  target_note_id: string | null
  target_key: string
  target_title: string
}

type GraphTagRow = { note_id: string; name: string; color: string | null }

async function loadGraphLinkAndTagRows(
  db: D1Database,
  userId: string,
  ids: readonly string[],
): Promise<{ links: GraphLinkRow[]; tags: GraphTagRow[]; truncated: boolean }> {
  const statements: D1PreparedStatement[] = []
  for (let offset = 0; offset < ids.length; offset += GRAPH_NOTE_ID_CHUNK) {
    const chunk = ids.slice(offset, offset + GRAPH_NOTE_ID_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    statements.push(
      db.prepare(
        `SELECT source_note_id, target_note_id, target_key, target_title FROM links
         WHERE user_id = ? AND source_note_id IN (${placeholders})
         ORDER BY source_note_id ASC, target_key ASC LIMIT ?`,
      ).bind(userId, ...chunk, GRAPH_EDGE_CANDIDATE_LIMIT + 1),
      db.prepare(
        `SELECT nt.note_id, t.name, t.color FROM note_tags nt
         JOIN tags t ON t.id = nt.tag_id AND t.user_id = ?
         WHERE nt.note_id IN (${placeholders}) ORDER BY t.name COLLATE NOCASE ASC`,
      ).bind(userId, ...chunk),
    )
  }
  const batch = await db.batch(statements)
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

export async function buildUserGraph(db: D1Database, params: GraphParams): Promise<GraphResponse> {
  const { userId, mode, centerId, depth, limit, query, folderId, tags, tagsMatch } = params
  const { includeOrphans, includeUnresolved, showTagNodes, excluded, direction } = params
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

  type GraphRow = {
    id: string
    title: string
    folder_id: string | null
    folder_name: string | null
    folder_color: string | null
    degree: number
    in_degree: number
    out_degree: number
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

  let rows: GraphRow[]
  let totalNodes = 0
  if (mode === 'local') {
    const neighborhood = localNeighborhoodSql(direction)
    const prefixBinds = [centerId, centerId, userId, depth]
    const [rowsResult, countResult] = await db.batch([
      db.prepare(
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
      db.prepare(
        `${neighborhood} SELECT COUNT(*) AS count FROM nearby JOIN notes n ON n.id = nearby.id
         WHERE ${filters.join(' AND ')}`,
      ).bind(...prefixBinds, ...filterBinds),
    ])
    rows = (rowsResult as D1Result<GraphRow>).results
    totalNodes = Number((countResult as D1Result<{ count: number }>).results?.[0]?.count ?? rows.length)
  } else {
    const [rowsResult, countResult] = await db.batch([
      db.prepare(
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
      db.prepare(
        `SELECT COUNT(*) AS count FROM notes n WHERE ${filters.join(' AND ')}`,
      ).bind(...filterBinds),
    ])
    rows = (rowsResult as D1Result<GraphRow>).results
    totalNodes = Number((countResult as D1Result<{ count: number }>).results?.[0]?.count ?? rows.length)
  }

  const noteLimit = includeUnresolved ? Math.max(1, limit - 50) : limit
  let truncated = rows.length > noteLimit || totalNodes > noteLimit
  rows = rows.slice(0, noteLimit)
  const known = new Set(rows.map((row) => row.id))
  const ids = [...known]
  const edges: GraphResponse['edges'] = []
  const unresolved = new Map<string, { title: string; sources: Set<string> }>()
  const tagsByNote = new Map<string, Array<{ name: string; color: string | null }>>()
  if (ids.length) {
    const pageIds = new Set(ids)
    const loaded = await loadGraphLinkAndTagRows(db, userId, ids)
    if (loaded.truncated) truncated = true
    const candidates = loaded.links.filter((link) => (link.target_note_id === null
      ? includeUnresolved
      : pageIds.has(link.target_note_id)))
    if (candidates.length > GRAPH_EDGE_CANDIDATE_LIMIT) truncated = true
    const seen = new Set<string>()
    for (const link of candidates.slice(0, GRAPH_EDGE_CANDIDATE_LIMIT)) {
      if (link.target_note_id === null) {
        if (!includeUnresolved || unresolved.size >= 50 && !unresolved.has(link.target_key)) continue
        const current = unresolved.get(link.target_key) ?? {
          title: wikiNoteTarget(link.target_title),
          sources: new Set<string>(),
        }
        current.sources.add(link.source_note_id)
        unresolved.set(link.target_key, current)
        continue
      }
      if (link.source_note_id === link.target_note_id) continue
      const key = `${link.source_note_id}>${link.target_note_id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ source: link.source_note_id, target: link.target_note_id })
    }
    for (const item of loaded.tags) {
      const values = tagsByNote.get(item.note_id) ?? []
      values.push({ name: item.name, color: item.color })
      tagsByNote.set(item.note_id, values)
    }
  }

  const nodes: GraphResponse['nodes'] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    kind: 'note',
    degree: Number(row.degree),
    inDegree: Number(row.in_degree),
    outDegree: Number(row.out_degree),
    folderId: row.folder_id,
    folderName: row.folder_name,
    folderColor: row.folder_color,
    tags: tagsByNote.get(row.id) ?? [],
  }))
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  for (const [key, missing] of unresolved) {
    const id = `unresolved:${key}`
    nodes.push({
      id,
      title: missing.title,
      kind: 'unresolved',
      degree: missing.sources.size,
      inDegree: missing.sources.size,
      outDegree: 0,
      folderId: null,
      folderName: null,
      folderColor: null,
      tags: [],
    })
    for (const source of missing.sources) {
      edges.push({ source, target: id })
      const sourceNode = nodeById.get(source)
      if (sourceNode) {
        sourceNode.degree++
        sourceNode.outDegree++
      }
    }
  }
  if (unresolved.size >= 50) truncated = true
  const tagNodes = showTagNodes ? applyTagNodes(nodes, edges, tagsByNote) : { added: 0, dropped: 0 }
  if (tagNodes.dropped > 0) truncated = true

  return {
    nodes,
    edges,
    meta: {
      mode,
      centerId: mode === 'local' ? centerId : null,
      depth,
      totalNodes: totalNodes + unresolved.size + tagNodes.added + tagNodes.dropped,
      totalEdges: edges.length,
      truncated,
      limit,
    },
  }
}

searchRoutes.get('/graph', requireAuth, async (c) => {
  const userId = c.get('userId')
  const mode = c.req.query('mode') === 'local' ? 'local' : 'global'
  const rawCenter = (c.req.query('center') ?? '').trim()
  const centerId = rawCenter && isValidId(rawCenter) ? rawCenter : null
  const depth = clampInt(c.req.query('depth'), LIMITS.graphDepthMin, LIMITS.graphDepthMax, LIMITS.graphDepthDefault)
  const limit = clampInt(c.req.query('limit'), LIMITS.graphNodeLimitMin, LIMITS.graphNodeLimitMax, LIMITS.graphNodeLimitDefault)
  const query = (c.req.query('q') ?? '').trim()
  const rawFolderId = (c.req.query('folderId') ?? '').trim()
  const folderId = rawFolderId && isValidId(rawFolderId) ? rawFolderId : ''
  const tag = (c.req.query('tag') ?? '').trim()
  const tags = [...new Set((c.req.query('tags') ?? '').split(',').map((item) => item.trim()).filter(Boolean))]
    .slice(0, LIMITS.graphTagsMax)
  if (tags.length === 0 && tag) tags.push(tag)
  const tagsMatch = c.req.query('tagsMatch') === 'all' ? 'all' : 'any'
  const includeOrphans = c.req.query('includeOrphans') !== '0'
  const includeUnresolved = c.req.query('includeUnresolved') === '1'
  const showTagNodes = c.req.query('tagNodes') === '1'
  const excluded = [...new Set((c.req.query('excluded') ?? '').split(',').map((item) => item.trim()).filter(isValidId))]
    .slice(0, LIMITS.graphExcludedMax)
  const rawDirection = c.req.query('direction')
  const direction: GraphLinkDirection = rawDirection === 'incoming' || rawDirection === 'outgoing' ? rawDirection : 'both'

  if (rawCenter && !centerId) {
    throw new ApiError(400, 'bad_request', 'The center note id is not a valid note id')
  }
  if (rawFolderId && !folderId) {
    throw new ApiError(400, 'bad_request', 'The folder id is not a valid folder id')
  }
  if (query.length > 200) {
    throw new ApiError(400, 'bad_request', 'The graph search query cannot exceed 200 characters')
  }
  if (tag.length > LIMITS.tagNameMaxLength) {
    throw new ApiError(400, 'bad_request', `The graph tag cannot exceed ${LIMITS.tagNameMaxLength} characters`)
  }
  if (tags.some((item) => item.length > LIMITS.tagNameMaxLength)) {
    throw new ApiError(400, 'bad_request', `The graph tag cannot exceed ${LIMITS.tagNameMaxLength} characters`)
  }
  if (mode === 'local' && !centerId) {
    throw new ApiError(400, 'bad_request', 'A center note is required for the local graph')
  }

  try {
    await consumeAttemptBudget(c.env.DB, [{
      key: `graph:${userId}`,
      maxAttempts: 1200,
      windowMs: 10 * 60 * 1000,
      lockMs: 60 * 1000,
    }])
  } catch (error) {
    if (error instanceof ThrottleError) {
      throw new ApiError(
        429,
        'too_many_attempts',
        `Too many graph requests. Try again in ${error.retryAfterSec} seconds`,
        { retryAfter: error.retryAfterSec },
      )
    }
    throw error
  }

  const body = await buildUserGraph(c.env.DB, {
    userId,
    mode,
    centerId,
    depth,
    limit,
    query,
    folderId,
    tags,
    tagsMatch,
    includeOrphans,
    includeUnresolved,
    showTagNodes,
    excluded,
    direction,
  })
  return c.json(body)
})

searchRoutes.post('/search/reindex', requireAuth, async (c) => {
  const { ftsEnabled } = c.get('database')
  if (!ftsEnabled) throw new ApiError(503, 'internal', 'Full-text indexing is unavailable in this environment; search is using its fallback')
  const userId = c.get('userId')
  const release = await acquireLease(
    c.env.DB,
    `fts-reindex-run:${userId}`,
    15 * 60 * 1000,
    'Search indexing is already running',
  )
  try {
    try {
      await consumeAttemptBudget(c.env.DB, [{
        key: `fts-reindex:${userId}`,
        maxAttempts: 6,
        windowMs: 60 * 60 * 1000,
        lockMs: 60 * 60 * 1000,
      }])
    } catch (error) {
      if (error instanceof ThrottleError) {
        throw new ApiError(
          429,
          'too_many_attempts',
          `Too many search reindex requests. Try again in ${error.retryAfterSec} seconds`,
          { retryAfter: error.retryAfterSec },
        )
      }
      throw error
    }
    const queued = await queueAllNotesForFtsIndex(c.env.DB, userId)
    await purgeStaleFtsRows(c.env.DB, userId)
    scheduleFtsDrain(c, FTS_DRAIN_ALL_BATCH)
    return c.json({ ok: true, queued })
  } finally {
    await release()
  }
})
