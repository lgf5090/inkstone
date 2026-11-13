/**
 * Receipts for writes carrying an `Idempotency-Key`. An offline client replays a queued write with
 * the key it minted before the network failed; if the first attempt reached the database but its
 * answer did not reach the browser, the replay must get that same answer rather than a second card.
 */
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface ProjectWriteReceipt {
  status: number
  body: string
}

export async function readProjectWriteReceipt(
  db: D1Database, userId: string, key: string,
): Promise<ProjectWriteReceipt | null> {
  const row = await db.prepare(
    'SELECT status, body FROM project_write_receipts WHERE user_id = ?1 AND key = ?2',
  ).bind(userId, key).first<ProjectWriteReceipt>()
  return row ?? null
}

export async function storeProjectWriteReceipt(
  db: D1Database, userId: string, key: string, status: number, body: string, now: number,
): Promise<void> {
  await db.prepare(
    `INSERT INTO project_write_receipts (user_id, key, status, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(user_id, key) DO NOTHING`,
  ).bind(userId, key, status, body, now).run()
}

export async function pruneProjectWriteReceipts(db: D1Database, now: number): Promise<number> {
  const result = await db.prepare('DELETE FROM project_write_receipts WHERE created_at < ?1')
    .bind(now - RECEIPT_TTL_MS).run()
  return result.meta?.changes ?? 0
}
