import { LIMITS } from '@shared/constants'
import {
  countText,
  deriveExcerpt,
  foldCase,
  foldIndexOf,
  linkFirstMention,
  normalizeLinkKey,
  plainLinkText,
  replaceWikiLinkTarget,
  trimFrontMatterLead,
} from '@shared/markdown-utils'
import { truncateText, utf8ByteLength } from '@shared/text-utils'
import { NOTE_COLUMNS_FULL, type NoteRow } from '../db/rows'
import {
  INLINE_REWRITE_LIMIT,
  REWRITE_CONCURRENCY,
  REWRITE_LOAD_CHUNK,
  buildNoteDerivedStatements,
  rewriteQueueStatement,
  shiftSqlPlaceholders,
} from '../db/writes'
import { noteIndexQueueStatement } from '../mcp/ai-search'
import { buildFtsQuery } from '../search/store'
import { sha256Hex } from '../lib/encoding'
import { newId } from '../lib/id'
import { versionRetentionOffsetSql } from './version-policy'

export type LinkMentionOutcome =
  | { status: 'linked'; row: NoteRow; cursor: number | undefined }
  | { status: 'no-mention' }
  | { status: 'missing' }
  | { status: 'conflict' }

export async function linkMentionInNote(
  db: D1Database,
  userId: string,
  sourceNoteId: string,
  title: string,
  ftsEnabled: boolean,
): Promise<LinkMentionOutcome> {
  const load = () => db.prepare(
    `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
  ).bind(sourceNoteId, userId).first<NoteRow>()
  let current = await load()
  if (!current || current.deleted_at !== null) return { status: 'missing' }
  for (let attempt = 0; attempt < 3; attempt++) {
    const content = linkFirstMention(current.content, title)
    if (content === current.content) return { status: 'no-mention' }
    const hash = await sha256Hex(content)
    const { words, chars } = countText(content)
    const now = Math.max(Date.now(), current.updated_at + 1)
    const nextRev = current.rev + 1
    const guard = `EXISTS (SELECT 1 FROM notes
      WHERE id = ?1 AND user_id = ?2 AND rev = ?3
        AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
    const guardValues = [current.id, userId, nextRev, hash, current.title, now] as const
    const statements: D1PreparedStatement[] = [
      db.prepare(
        `UPDATE notes SET content = ?1, excerpt = ?2, word_count = ?3, char_count = ?4,
           content_hash = ?5, rev = ?6, updated_at = ?7
          WHERE id = ?8 AND user_id = ?9 AND rev = ?10 AND content_hash = ?11`,
      ).bind(content, deriveExcerpt(content), words, chars, hash, nextRev, now,
        current.id, userId, current.rev, current.content_hash),
      db.prepare(
        `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${shiftSqlPlaceholders(guard, 7)}`,
      ).bind(newId(), current.id, userId, current.title, current.content,
        utf8ByteLength(current.content), now, ...guardValues),
      db.prepare(
        `DELETE FROM note_versions WHERE note_id = ?1
           AND ${shiftSqlPlaceholders(guard, 1)}
           AND id IN (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ${versionRetentionOffsetSql('?3')})`,
      ).bind(current.id, ...guardValues),
    ]
    statements.push(...buildNoteDerivedStatements({
      db,
      userId,
      noteId: current.id,
      title: current.title,
      content,
      ftsEnabled,
      expectedRev: nextRev,
      expectedContentHash: hash,
      expectedTitle: current.title,
      expectedUpdatedAt: now,
    }).statements)
    statements.push(noteIndexQueueStatement(db, userId, current.id, 'embed', now))
    statements.push(
      db.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?1, 'note', ?2, 'upsert', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
         RETURNING seq`,
      ).bind(userId, current.id, now, ...guardValues),
    )
    const results = await db.batch(statements)
    if (results[0]?.meta.changes) {
      const row = await load()
      if (!row) return { status: 'missing' }
      const change = results.at(-1)?.results?.[0] as { seq?: number } | undefined
      return { status: 'linked', row, cursor: change?.seq }
    }
    current = await load()
    if (!current || current.deleted_at !== null) return { status: 'missing' }
  }
  return { status: 'conflict' }
}

/**
 * The notes whose `[[wikilinks]]` the link table already points at this one, each with
 * the text around the link.
 *
 * The window is cut from `hit`, so the column has to survive the outer projection: it
 * did not, and every context came back empty until a test read the row keys.
 */
/**
 * The sentence around a mention, or `null` when the row does not actually carry one.
 *
 * Two reasons not to trust the index pass: SQLite's `lower()` folds ASCII characters only,
 * so a mention written with an accented or Cyrillic capital gives `hit` 0 and leaves the
 * window parked at the top of the note; and the full-text index matches token neighbours,
 * not characters, so it can offer a note where the words only happen to sit next to each
 * other. `foldIndexOf` is exact and length-preserving, so one check answers both.
 */
function mentionExcerpt(window: string, hit: number, len: number, needle: string): string | null {
  const body = trimFrontMatterLead(window)
  const found = foldIndexOf(body, needle)
  if (found < 0) return null
  const from = Math.max(0, found - 60)
  const to = Math.min(body.length, found + needle.length + 90)
  // `trimFrontMatterLead` only ever removes a prefix, so the difference in length is how
  // much of the note the window already left behind.
  const dropped = (hit > 0 ? Math.max(hit - 61, 0) : 0) + (window.length - body.length)
  const headCut = dropped + from > 0
  const tailCut = dropped + to < len
  return (headCut ? '…' : '') + plainLinkText(body.slice(from, to)).replace(/\s+/g, ' ').trim() + (tailCut ? '…' : '')
}

/**
 * How far into a note the retry scan looks for a mention the cheap index pass could not
 * place. Sized to cover most notes whole, and applied only to the few rows per page that
 * need it, so the panel never pulls a body at the content limit.
 */
const MENTION_RETRY_SCAN_CHARS = 4000

function backlinkContext(window: string, hit: number, len: number, needle: string): string {
  const located = mentionExcerpt(window, hit, len, needle)
  // A backlink is known from the link table, so the row stays even when the excerpt could
  // not be placed on it; the head of the note is the honest fallback.
  return located ?? plainLinkText(truncateText(window, 120).replace(/\s+/g, ' ').trim())
}

/**
 * The letters SQLite's `lower()` cannot fold, spelled out as `replace()` arguments.
 *
 * `lower()` covers ASCII; `foldCase` covers every letter with a single-code-unit lowercase.
 * The gap between them is exactly this list, so folding the column with these pairs and the
 * needle with `foldCase` leaves both sides in the same alphabet. Capped at twelve pairs: a
 * title made of exotic letters would build a `replace()` chain longer than the scan is worth,
 * and the caller's retry pass picks up what the cap drops.
 */
function caseFoldPairs(title: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const char of title) {
    const folded = foldCase(char)
    if (folded.length !== 1) continue
    for (const variant of [char, char.toUpperCase()]) {
      if (variant.length !== 1 || variant === folded || variant.charCodeAt(0) < 0x80) continue
      if (!pairs.some(([from]) => from === variant)) pairs.push([variant, folded])
    }
  }
  return pairs.slice(0, 12)
}

/** `expression`, folded down to the alphabet `foldCase` reports for `title`. */
function foldSql(expression: string, pairs: Array<[string, string]>, firstSlot: number): string {
  return pairs.reduce(
    (sql, _pair, index) => `replace(${sql}, ?${firstSlot + index * 2}, ?${firstSlot + index * 2 + 1})`,
    expression,
  )
}

export async function findLinkedBacklinks(
  db: D1Database,
  userId: string,
  target: { id: string; title: string },
): Promise<Array<{ id: string; title: string; context: string }>> {
  const needle = `[[${target.title}`
  const pairs = caseFoldPairs(target.title)
  // One fold and one instr per row: SQLite does not share the repeated subexpression
  // across the references below.
  const { results } = await db.prepare(
    `SELECT id, title, hit, len,
       substr(content, MAX(hit - 60, 1), ?4) AS window
     FROM (
       SELECT n.id AS id, n.title AS title, n.content AS content,
              instr(${foldSql('lower(n.content)', pairs, 5)}, ?3) AS hit, length(n.content) AS len
         FROM links l
           JOIN notes n ON n.id = l.source_note_id
        WHERE l.user_id = ?1 AND l.target_note_id = ?2
          AND n.deleted_at IS NULL AND n.id != ?2
        ORDER BY n.updated_at DESC LIMIT 50
     )`,
  )
    .bind(userId, target.id, foldCase(needle), needle.length + 150, ...pairs.flat())
    .all<{ id: string; title: string; hit: number; len: number; window: string }>()

  return results.map((row) => ({
    id: row.id,
    title: row.title,
    context: backlinkContext(row.window, row.hit, row.len, needle),
  }))
}

/**
 * Notes that say the target's title in their text without linking to it.
 *
 * The full-text index finds the candidates and `mentionExcerpt` confirms the literal phrase:
 * the index is tokenised and case-folded, so it can offer a note where the words only
 * happen to sit next to each other, and a mention the reader cannot see is worse than a
 * shorter list. Notes that already carry a `[[title]]` are left to the linked half of the
 * panel, since a row would otherwise show up twice with two different meanings.
 *
 * The index pass over-fetches by three because the confirmation drops rows the index should
 * not have offered, and a candidate whose mention the first window missed gets one more look
 * at its first `MENTION_RETRY_SCAN_CHARS` characters, which is where an accented or Cyrillic
 * capital that SQLite could not fold usually lives. Without the index the same answer comes
 * from scanning every body, which is what the search endpoint already falls back to.
 */
export async function findUnlinkedMentions(
  db: D1Database,
  userId: string,
  target: { id: string; title: string },
  ftsEnabled: boolean,
  limit: number,
): Promise<Array<{ id: string; title: string; context: string }>> {
  const title = target.title.trim()
  if (Array.from(title).length < LIMITS.mentionMinChars)
    return []
  const match = ftsEnabled
    ? `user_id : "${userId.replace(/"/g, '""')}" AND {title body} : (${buildFtsQuery([title])})`
    : ''
  if (ftsEnabled && !match)
    return []
  const needle = title
  const pairs = caseFoldPairs(title)
  // ?1 is the match expression only when the index is in play, so every later slot shifts.
  const k = ftsEnabled ? 1 : 0
  const { results } = await db
    .prepare(
      `SELECT id, title, hit, len,
         substr(content, MAX(hit - 60, 1), ?${4 + k}) AS window
       FROM (
         SELECT n.id AS id, n.title AS title, n.content AS content,
                instr(${foldSql('lower(n.content)', pairs, 6 + k)}, ?${3 + k}) AS hit, length(n.content) AS len
           ${ftsEnabled ? 'FROM notes_fts JOIN notes n ON n.id = notes_fts.note_id AND n.user_id = notes_fts.user_id' : 'FROM notes n'}
          ${ftsEnabled ? 'WHERE notes_fts MATCH ?1 AND notes_fts.user_id = ?2 AND n.user_id = ?2' : 'WHERE n.user_id = ?1'}
            ${ftsEnabled ? '' : `AND instr(${foldSql('lower(n.content)', pairs, 6 + k)}, ?${3 + k}) > 0`}
            AND n.deleted_at IS NULL
            AND n.id != ?${2 + k}
            AND NOT EXISTS (
              SELECT 1 FROM links l
               WHERE l.user_id = ?${1 + k} AND l.source_note_id = n.id AND l.target_note_id = ?${2 + k}
            )
         ORDER BY n.updated_at DESC, n.id ASC
         LIMIT ?${5 + k}
       )`,
    )
    .bind(...(ftsEnabled
      ? [match, userId, target.id, foldCase(needle), needle.length + 150, limit * 3, ...pairs.flat()]
      : [userId, target.id, foldCase(needle), needle.length + 150, limit * 3, ...pairs.flat()]))
    .all<{ id: string; title: string; hit: number; len: number; window: string }>()

  const found = new Map<string, string>()
  const missed: Array<{ id: string; len: number }> = []
  for (const row of results) {
    const context = mentionExcerpt(row.window, row.hit, row.len, needle)
    if (context === null) missed.push({ id: row.id, len: row.len })
    else found.set(row.id, context)
  }

  if (missed.length) {
    const placeholders = missed.map((_, index) => `?${index + 3}`).join(', ')
    const { results: heads } = await db.prepare(
      `SELECT id, title, length(content) AS len, substr(content, 1, ?2) AS window
         FROM notes WHERE user_id = ?1 AND id IN (${placeholders})`,
    ).bind(userId, MENTION_RETRY_SCAN_CHARS, ...missed.map((row) => row.id))
      .all<{ id: string; title: string; len: number; window: string }>()
    for (const head of heads) {
      if (found.size >= limit) break
      const context = mentionExcerpt(head.window, 0, head.len, needle)
      if (context !== null) found.set(head.id, context)
    }
  }

  const order = new Map(results.map((row, index) => [row.id, index]))
  return [...found.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
    .slice(0, limit)
    .map(([id, context]) => ({ id, title: results.find((row) => row.id === id)?.title ?? '', context }))
}

export async function rewriteInboundWikiLinks(
  db: D1Database,
  userId: string,
  targetNoteId: string,
  fromTitle: string,
  toTitle: string,
  ftsEnabled: boolean,
  forceInline = false,
  budgetNotes = Number.POSITIVE_INFINITY,
): Promise<{ rewritten: number; skipped: number; deferred: number; remaining: number }> {
  const previousKey = normalizeLinkKey(fromTitle)
  const { results: candidates } = await db.prepare(
    `SELECT DISTINCT n.id FROM links l
      JOIN notes n ON n.id = l.source_note_id AND n.user_id = l.user_id
     WHERE l.user_id = ?1 AND l.target_note_id = ?2 AND l.target_key = ?3
       AND n.id <> ?2 AND n.deleted_at IS NULL`,
  ).bind(userId, targetNoteId, previousKey).all<{ id: string }>()
  if (!candidates.length) return { rewritten: 0, skipped: 0, deferred: 0, remaining: 0 }
  if (!forceInline && candidates.length > INLINE_REWRITE_LIMIT) {
    await db.batch([
      rewriteQueueStatement(db, userId, 'note-title', targetNoteId, fromTitle, toTitle),
    ])
    return { rewritten: 0, skipped: 0, deferred: candidates.length, remaining: 0 }
  }
  let rewritten = 0
  let skipped = 0

  const candidateIds = candidates.map((c) => c.id)
  const plan = Number.isFinite(budgetNotes) ? candidateIds.slice(0, budgetNotes) : candidateIds
  const remaining = candidateIds.length - plan.length
  type CandidateNoteRecord = {
    id: string
    title: string
    content: string
    content_hash: string
    rev: number
    updated_at: number
    deleted_at: number | null
  }
  // Load and rewrite in small windows: a hub note referenced by thousands of others must
  // not pin every candidate body in the isolate before the first write happens.
  for (let start = 0; start < plan.length; start += REWRITE_LOAD_CHUNK) {
    const windowIds = plan.slice(start, start + REWRITE_LOAD_CHUNK)
    const placeholders = windowIds.map((_, idx) => `?${idx + 2}`).join(', ')
    const { results: loaded } = await db.prepare(
      `SELECT id, title, content, content_hash, rev, updated_at, deleted_at
         FROM notes WHERE user_id = ?1 AND id IN (${placeholders})`,
    ).bind(userId, ...windowIds).all<CandidateNoteRecord>()
    const notesToRewrite = loaded.filter((note) => note.deleted_at === null
      && replaceWikiLinkTarget(note.content, fromTitle, toTitle) !== note.content)
    skipped += loaded.length - notesToRewrite.length
    for (let i = 0; i < notesToRewrite.length; i += REWRITE_CONCURRENCY) {
      const batch = notesToRewrite.slice(i, i + REWRITE_CONCURRENCY)
      const outcomes = await Promise.all(
        batch.map(async (initialNote) => {
          let currentNote: CandidateNoteRecord | null = initialNote
          for (let attempt = 0; attempt < 5; attempt++) {
            if (!currentNote || currentNote.deleted_at !== null) return false
            const content = replaceWikiLinkTarget(currentNote.content, fromTitle, toTitle)
            if (content === currentNote.content) return true
            const hash = await sha256Hex(content)
            const { words, chars } = countText(content)
            const now = Math.max(Date.now(), currentNote.updated_at + 1)
            const nextRev = currentNote.rev + 1
            const guard = `EXISTS (SELECT 1 FROM notes
              WHERE id = ?1 AND user_id = ?2 AND rev = ?3
                AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
            const guardValues = [currentNote.id, userId, nextRev, hash, currentNote.title, now] as const
            const statements: D1PreparedStatement[] = [
              db.prepare(
                `UPDATE notes SET content = ?1, excerpt = ?2, word_count = ?3, char_count = ?4,
                   content_hash = ?5, rev = ?6, updated_at = ?7
                  WHERE id = ?8 AND user_id = ?9 AND rev = ?10 AND content_hash = ?11`,
              ).bind(content, deriveExcerpt(content), words, chars, hash, nextRev, now,
                currentNote.id, userId, currentNote.rev, currentNote.content_hash),
              db.prepare(
                `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
                  WHERE ${shiftSqlPlaceholders(guard, 7)}
                    AND (?14 = 1 OR NOT EXISTS (SELECT 1 FROM note_versions WHERE note_id = ?2)
                      OR ?15 - COALESCE((SELECT MAX(created_at) FROM note_versions WHERE note_id = ?2), 0) > ?16)`,
              ).bind(newId(), currentNote.id, userId, currentNote.title, currentNote.content,
                utf8ByteLength(currentNote.content), now, ...guardValues, 1, now, LIMITS.versionSnapshotIntervalMs),
              db.prepare(
                `DELETE FROM note_versions WHERE note_id = ?1
                   AND ${shiftSqlPlaceholders(guard, 1)}
                   AND id IN (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ${versionRetentionOffsetSql('?3')})`,
              ).bind(currentNote.id, ...guardValues),
            ]
            statements.push(...buildNoteDerivedStatements({
              db,
              userId,
              noteId: currentNote.id,
              title: currentNote.title,
              content,
              ftsEnabled,
              expectedRev: nextRev,
              expectedContentHash: hash,
              expectedTitle: currentNote.title,
              expectedUpdatedAt: now,
            }).statements)
            statements.push(noteIndexQueueStatement(db, userId, currentNote.id, 'embed', now))
            statements.push(
              db.prepare(
                `INSERT INTO changes (user_id, entity, entity_id, op, at)
                 SELECT ?1, 'note', ?2, 'upsert', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}`,
              ).bind(userId, currentNote.id, now, ...guardValues),
            )
            const [updated] = await db.batch(statements)
            if (updated?.meta.changes) {
              return true
            }
            currentNote = await db.prepare(
              `SELECT id, title, content, content_hash, rev, updated_at, deleted_at
                 FROM notes WHERE id = ?1 AND user_id = ?2`,
            ).bind(currentNote.id, userId).first<CandidateNoteRecord>()
          }
          return false
        }),
      )
    for (const success of outcomes) {
      if (success) rewritten++
      else skipped++
    }
    }
  }
  return { rewritten, skipped, deferred: 0, remaining }
}
