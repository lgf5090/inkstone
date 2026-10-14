/**
 * The search and graph answers the HTTP route, the MCP retriever and the note store all need.
 *
 * Lifted out of `routes/search.ts` because a route is an HTTP adapter: `mcp/retrieval.ts` and
 * `notes/store.ts` must not reach into one to get a function (`AGENTS.md` rule 3), and the ranking,
 * snippet and node-assembly rules here are exactly the product behaviour those callers depend on.
 * The route keeps query parsing, validation, throttles, `ApiError` codes and response shaping; the
 * SQL stays in `search/store.ts`; this layer is the arithmetic between them.
 */

import { toPlainText, wikiNoteTarget } from '@shared/markdown-utils'
import { sliceText, truncateText } from '@shared/text-utils'
import { applyTagNodes } from '@shared/graph-tag-nodes'
import { parseQuery, type ParsedQuery } from '@shared/search-query'
import type { GraphResponse, SearchDocumentItem, SearchDocumentsResponse, SearchHit } from '@shared/types'
import { toNoteSummary, type NoteRow } from '../db/rows'
import { GRAPH_EDGE_CANDIDATE_LIMIT, SearchStore, buildFtsQuery, type GraphLinkDirection } from './store'

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
  const store = new SearchStore(db, userId)
  const query = parseQuery(truncateText(raw.trim(), 512))
  if (!raw.trim()) return { results: [], mode: ftsEnabled ? 'fts' : 'like', query }

  // Trashing queues an fts_index_queue 'delete' row and purgeStaleFtsRows drops any row whose
  // note is not live, so an in:trash query has nothing left in notes_fts to match against;
  // it is served by likeSearch instead. Keeping trash indexed would trade a niche ranking
  // improvement for an index lifecycle that has to survive restore and purge races.
  if (ftsEnabled && query.terms.length && !query.trash) {
    try {
      const ftsHits = await ftsSearch(store, query, limit)
      const pendingNoteIds = await store.pendingFtsNoteIds()
      if (!pendingNoteIds.length) {
        return { results: ftsHits, mode: 'fts', query }
      }
      const pendingHits = await likeSearch(store, query, limit, pendingNoteIds)
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
  return { results: await likeSearch(store, query, limit), mode: 'like', query }
}

async function ftsSearch(store: SearchStore, q: ParsedQuery, limit: number): Promise<SearchHit[]> {
  const match = buildFtsQuery(q.terms)
  if (!match) return []
  const rows = await store.ftsNoteRows(match, q, limit)
  return rows.map((row) => ({
    note: toNoteSummary(row),
    snippet: makeSnippet(row.content ?? '', q.terms),
    score: -row.score,
  }))
}

async function likeSearch(
  store: SearchStore,
  q: ParsedQuery,
  limit: number,
  noteIds?: string[],
): Promise<SearchHit[]> {
  const rows = await store.likeNoteRows(q, limit, noteIds)
  const ranked = rows.map((row) => ({ row, score: scoreOf(row, q.terms) }))
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

export async function buildUserGraph(db: D1Database, params: GraphParams): Promise<GraphResponse> {
  const { userId, mode, centerId, depth, limit, includeUnresolved, showTagNodes } = params
  const store = new SearchStore(db, userId)
  const { rows: pageRows, totalNodes } = await store.graphNodeRows(params)

  const noteLimit = includeUnresolved ? Math.max(1, limit - 50) : limit
  let truncated = pageRows.length > noteLimit || totalNodes > noteLimit
  const rows = pageRows.slice(0, noteLimit)
  const known = new Set(rows.map((row) => row.id))
  const ids = [...known]
  const edges: GraphResponse['edges'] = []
  const unresolved = new Map<string, { title: string; sources: Set<string> }>()
  const tagsByNote = new Map<string, Array<{ name: string; color: string | null }>>()
  if (ids.length) {
    const pageIds = new Set(ids)
    const loaded = await store.graphLinkAndTagRows(ids)
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

export async function fetchSearchDocuments(
  db: D1Database,
  userId: string,
  ids: readonly string[],
): Promise<SearchDocumentsResponse> {
  if (!ids.length) return { items: [], missing: [] }
  const rows = await new SearchStore(db, userId).documentRows(ids)
  const items: SearchDocumentItem[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
    archived: row.is_archived === 1,
    starred: row.is_starred === 1,
    folderId: row.folder_id,
    content: row.content ?? '',
    chars: row.chars,
  }))
  const served = new Set(items.map((item) => item.id))
  return { items, missing: ids.filter((id) => !served.has(id)) }
}
