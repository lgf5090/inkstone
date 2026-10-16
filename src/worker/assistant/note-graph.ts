/**
 * The notes one link away from the notes a search found.
 *
 * A vault's knowledge is mostly in the links rather than in any one note: the page that says "see
 * [[the plan]]" is answering a question about the plan, and a search that returns only the pages whose
 * text matched will miss it. One hop, in both directions — what a hit points at, and what points back at
 * it — is the whole of the addition: two hops is a different feature (a graph walk) and would put the
 * reader's entire vault in front of the model for every question.
 *
 * Titles only. A neighbour is an invitation to read, not a copy of the note: the model already has the
 * search results in full, and shipping every linked note's text would spend the reader's budget on pages
 * the question was never about.
 *
 * The scope is enforced by the caller, on the way in and on the way out: a neighbour is looked up among
 * the notes the turn may read, and a linked note outside that set is not named. A title is enough to
 * leak what a page is about, so "only the id is a permission" is not true here.
 */
import { readableNoteIds, type NoteScope } from './note-scope'

/** How many seeds one search expands, and how many neighbours come back at most. */
export const NEIGHBOUR_SEEDS = 3
export const NEIGHBOUR_LIMIT = 6

export interface Neighbour {
  id: string
  title: string
  /** The note the link was found on, so the model can say why this one is here. */
  via: string
  /** Which way the link runs: the hit points at it, or it points at the hit. */
  direction: 'outbound' | 'inbound'
}

interface NeighbourRow {
  id: string
  title: string
  via: string
  direction: string
}

/**
 * The rows as one list: the seeds themselves are dropped (a note does not relate to itself), a note
 * reached from two different seeds appears once — the first reason found wins, which is why outbound
 * runs before inbound — and the list is capped.
 */
export function rankNeighbours(rows: readonly NeighbourRow[], seeds: ReadonlySet<string>, limit = NEIGHBOUR_LIMIT): Neighbour[] {
  const seen = new Set<string>()
  const out: Neighbour[] = []
  for (const row of rows) {
    if (!row.id || seeds.has(row.id) || seen.has(row.id)) continue
    seen.add(row.id)
    out.push({
      id: row.id,
      title: row.title.slice(0, 120) || 'Untitled',
      via: row.via.slice(0, 120),
      direction: row.direction === 'inbound' ? 'inbound' : 'outbound',
    })
    if (out.length >= limit) break
  }
  return out
}

/**
 * One hop from these notes, inside the turn's scope.
 *
 * Outbound first: a note's own "see also" is a stronger signal than something that happened to mention
 * it, and the cap means the order decides what survives.
 */
export async function oneHopNeighbours(
  db: D1Database,
  userId: string,
  seeds: readonly string[],
  scope: NoteScope,
  limit = NEIGHBOUR_LIMIT,
): Promise<Neighbour[]> {
  const wanted = seeds.filter((id) => /^[0-9a-hjkmnp-tv-z]{26}$/.test(id)).slice(0, NEIGHBOUR_SEEDS)
  if (!wanted.length) return []
  const placeholders = wanted.map((_, index) => `?${index + 2}`).join(', ')
  const [outbound, inbound] = await Promise.all([
    db.prepare(
      `SELECT l.target_note_id AS id, n.title AS title, s.title AS via, 'outbound' AS direction
         FROM links l
         JOIN notes n ON n.id = l.target_note_id AND n.user_id = l.user_id AND n.deleted_at IS NULL
         JOIN notes s ON s.id = l.source_note_id AND s.user_id = l.user_id
        WHERE l.user_id = ?1 AND l.source_note_id IN (${placeholders}) AND l.target_note_id IS NOT NULL
        ORDER BY n.updated_at DESC LIMIT 40`,
    ).bind(userId, ...wanted).all<NeighbourRow>(),
    db.prepare(
      `SELECT l.source_note_id AS id, n.title AS title, t.title AS via, 'inbound' AS direction
         FROM links l
         JOIN notes n ON n.id = l.source_note_id AND n.user_id = l.user_id AND n.deleted_at IS NULL
         JOIN notes t ON t.id = l.target_note_id AND t.user_id = l.user_id
        WHERE l.user_id = ?1 AND l.target_note_id IN (${placeholders})
        ORDER BY n.updated_at DESC LIMIT 40`,
    ).bind(userId, ...wanted).all<NeighbourRow>(),
  ])
  const rows = [...(outbound.results ?? []), ...(inbound.results ?? [])]
  if (!rows.length) return []
  // The same gate the note tools use: a neighbour outside the scope is not named, however it was found.
  const allowed = await readableNoteIds(db, userId, rows.map((row) => row.id), scope)
  return rankNeighbours(rows.filter((row) => allowed.has(row.id)), new Set(wanted), limit)
}
