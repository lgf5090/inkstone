import { extractAttachmentIds } from '@shared/markdown-utils'

const REFERENCE_SCAN_PAGE_SIZE = 200

export async function collectAttachmentReferences(
  db: D1Database,
  userId: string,
  wantedIds?: ReadonlySet<string>,
): Promise<Map<string, number>> {
  const references = new Map<string, number>()
  if (wantedIds?.size === 0) return references

  // Retained versions must remain restorable after unused attachments are pruned.
  await Promise.all(
    (['notes', 'note_versions'] as const).map((table) =>
      scanTableReferences(db, userId, table, wantedIds, references),
    ),
  )
  return references
}

async function scanTableReferences(
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
