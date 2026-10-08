import { parseQuickAddRecord, QUICKADD_VERSION } from '@shared/quickadd'

export interface BackupQuickAddSummary {
  choices: number
}

/**
 * Restore the automation library an export carried into the account's own column, in the same
 * envelope the live `PUT /api/quickadd/library` writes. A library that cannot be read, or that the
 * store would quietly trim, fails the restore instead of leaving the account with half a library.
 */
export async function applyBackupQuickAdd(
  db: D1Database,
  userId: string,
  library: unknown,
): Promise<BackupQuickAddSummary> {
  const parsed = parseQuickAddRecord(library)
  if (!parsed.data) throw new Error('The export contains no readable QuickAdd library')
  if (parsed.dropped > 0 || parsed.truncated) {
    throw new Error(`The backup QuickAdd library would silently drop ${parsed.dropped} entries`)
  }
  const envelope = JSON.stringify({ savedAt: Date.now(), version: QUICKADD_VERSION, library: parsed.data })
  const result = await db.prepare('UPDATE users SET quickadd = ?1 WHERE id = ?2')
    .bind(envelope, userId)
    .run()
  if ((result.meta?.changes ?? 0) === 0) throw new Error('Account not found')
  return { choices: parsed.data.choices.length }
}
