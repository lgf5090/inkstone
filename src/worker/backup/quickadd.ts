import {
  buildQuickAddPayload,
  parseQuickAddRecord,
  QUICKADD_VERSION,
  quickAddLibraryFromStored,
} from '@shared/quickadd'

export interface BackupQuickAddSummary {
  choices: number
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return null
  }
}

/**
 * The account's automation library as the transport payload a backup can carry — the same shape the
 * settings page downloads, so a `automation.json` opened in an editor reads like a library and not
 * like a database row. Null when the account has none or its column cannot be understood.
 */
export async function readBackupQuickAdd(db: D1Database, userId: string): Promise<string | null> {
  const row = await db.prepare('SELECT quickadd FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ quickadd: string | null }>()
  const library = quickAddLibraryFromStored(row?.quickadd ?? null)
  if (!library) return null
  return JSON.stringify(buildQuickAddPayload(library.settings, library.choices))
}

/**
 * Restore the automation library an export carried into the account's own column, in the same
 * envelope the live `PUT /api/quickadd/library` writes. A library that cannot be read, or that the
 * store would quietly trim, fails the restore instead of leaving the account with half a library.
 */
export async function applyBackupQuickAdd(
  db: D1Database,
  userId: string,
  carried: unknown,
): Promise<BackupQuickAddSummary> {
  const library = typeof carried === 'string' ? parseJson(carried) : carried
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
