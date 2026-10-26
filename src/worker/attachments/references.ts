import { extractAttachmentIds } from '@shared/markdown-utils'
import type { AttachmentScope } from './scopes'

const REFERENCE_SCAN_PAGE_SIZE = 200

/**
 * The ids a scope's content actually references, counted per id.
 *
 * Each scope answers "is this file still in use?" from a different place, and the difference is not
 * cosmetic: notes carry a URL inside free text, todos name their files from a link table, memos
 * point back from the attachment row itself, and chat stores an id array on the turn that consumed
 * the file. A single rule applied across all four deletes the other three, which is what the
 * notes-only scan does to task uploads today.
 */
export async function collectAttachmentReferences(
  db: D1Database,
  userId: string,
  wantedIds?: ReadonlySet<string>,
  scope: AttachmentScope = 'notes',
): Promise<Map<string, number>> {
  const references = new Map<string, number>()
  if (wantedIds?.size === 0) return references
  switch (scope) {
    case 'notes': {
      // Retained versions must remain restorable after unused attachments are pruned.
      await Promise.all(
        (['notes', 'note_versions'] as const).map((table) =>
          scanBodyReferences(db, userId, table, wantedIds, references),
        ),
      )
      return references
    }
    case 'memos':
      return scanIdColumn(
        db,
        userId,
        `SELECT id FROM memos_attachments WHERE user_id = ?1 AND memo_id IS NOT NULL`,
        wantedIds,
      )
    case 'todos':
      return scanIdColumn(
        db,
        userId,
        `SELECT attachment_id AS id FROM todos_attachments WHERE user_id = ?1`,
        wantedIds,
      )
    case 'calendar':
      return scanIdColumn(
        db,
        userId,
        `SELECT attachment_id AS id FROM calendar_event_attachments WHERE user_id = ?1`,
        wantedIds,
      )
    case 'chat':
      return scanChatReferences(db, userId, wantedIds)
    case 'email':
      return scanIdColumn(
        db,
        userId,
        `SELECT id FROM email_attachments WHERE user_id = ?1 AND email_id IS NOT NULL`,
        wantedIds,
      )
  }
}

/**
 * A reference held as a bare id column rather than as prose.
 *
 * Memos asks the attachment row itself because `memo_id` is that row's own back-pointer: a file
 * bound to a memo that no longer exists cannot be holding a reference, and asking that question is
 * the same test the delete predicate will run.
 */
async function scanIdColumn(
  db: D1Database,
  userId: string,
  select: string,
  wantedIds: ReadonlySet<string> | undefined,
): Promise<Map<string, number>> {
  const references = new Map<string, number>()
  const { results } = await db.prepare(select).bind(userId).all<{ id: string }>()
  for (const row of results) {
    if (wantedIds && !wantedIds.has(row.id)) continue
    references.set(row.id, (references.get(row.id) ?? 0) + 1)
  }
  return references
}

/**
 * Chat ids live inside a JSON array on each turn, so the array is decoded rather than matched.
 *
 * An id is a fixed alphabet with no delimiter of its own, and a `LIKE` against a bare id would also
 * hit a turn carrying an id that merely starts with it.
 */
async function scanChatReferences(
  db: D1Database,
  userId: string,
  wantedIds: ReadonlySet<string> | undefined,
): Promise<Map<string, number>> {
  const references = new Map<string, number>()
  let afterId = ''
  while (true) {
    const { results } = await db
      .prepare(
        `SELECT id, attachments FROM chat_messages
          WHERE user_id = ?1 AND id > ?2 AND attachments != '[]'
          ORDER BY id ASC LIMIT ?3`,
      )
      .bind(userId, afterId, REFERENCE_SCAN_PAGE_SIZE)
      .all<{ id: string; attachments: string }>()
    if (!results.length) break
    for (const message of results) {
      for (const id of decodeAttachmentIds(message.attachments)) {
        if (wantedIds && !wantedIds.has(id)) continue
        references.set(id, (references.get(id) ?? 0) + 1)
      }
    }
    afterId = results[results.length - 1]!.id
    if (results.length < REFERENCE_SCAN_PAGE_SIZE) break
  }
  return references
}

function decodeAttachmentIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    // A turn whose array will not parse is counted as referencing nothing, which is the direction
    // that keeps the file: a prune that refuses to delete is recoverable, one that guesses is not.
    return []
  }
}

async function scanBodyReferences(
  db: D1Database,
  userId: string,
  table: 'notes' | 'note_versions',
  wantedIds: ReadonlySet<string> | undefined,
  references: Map<string, number>,
): Promise<void> {
  // The instr() predicate discards rows that cannot contain an attachment URL
  // so full bodies only cross the wire for rows the regex will actually parse.
  let afterId = ''
  while (true) {
    const { results } = await db.prepare(
      `SELECT id, content FROM ${table}
        WHERE user_id = ?1 AND id > ?2 AND instr(content, '/api/files/') > 0
        ORDER BY id ASC LIMIT ?3`,
    ).bind(userId, afterId, REFERENCE_SCAN_PAGE_SIZE).all<{ id: string; content: string }>()
    if (!results.length) break

    for (const note of results) {
      for (const id of extractAttachmentIds(note.content)) {
        if (wantedIds && !wantedIds.has(id)) continue
        references.set(id, (references.get(id) ?? 0) + 1)
      }
    }
    afterId = results[results.length - 1]!.id
    if (results.length < REFERENCE_SCAN_PAGE_SIZE) break
  }
}
