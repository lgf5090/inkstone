import type { XgetAuditAction } from './schema'

export async function recordXgetAudit(
  db: D1Database,
  entry: { at: number; actor: string; action: XgetAuditAction; detail?: string },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO development_xget_audit (at, actor, action, detail)
         VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(entry.at, entry.actor, entry.action, entry.detail ?? '')
      .run()
  } catch (error) {
    console.warn('[inkstone] xget audit write failed', error)
  }
}

export async function pruneXgetAudit(db: D1Database, before: number): Promise<void> {
  try {
    await db.prepare('DELETE FROM development_xget_audit WHERE at < ?1').bind(before).run()
  } catch (error) {
    console.warn('[inkstone] xget audit prune failed', error)
  }
}
