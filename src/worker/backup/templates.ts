import { parseTemplateLibraryExport } from '@shared/note-templates'

export interface BackupTemplateSummary {
  templates: number
  categories: number
}

function libraryText(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if ((value as { app?: unknown }).app !== 'inkstone') return null
  return JSON.stringify(value)
}

export async function readBackupTemplates(
  db: D1Database,
  userId: string,
): Promise<string | null> {
  const row = await db.prepare('SELECT template_library FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ template_library: string | null }>()
  if (!row?.template_library) return null
  let envelope: unknown
  try {
    envelope = JSON.parse(row.template_library)
  } catch {
    return null
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null
  return libraryText((envelope as { library?: unknown }).library)
}

export async function applyBackupTemplates(
  db: D1Database,
  userId: string,
  text: string,
): Promise<BackupTemplateSummary> {
  const parsed = parseTemplateLibraryExport(text, { keepFlags: true })
  if (!parsed.data) throw new Error('The backup contains no readable template library')
  if (parsed.dropped > 0 || parsed.truncated) {
    throw new Error(`The backup template library would silently drop ${parsed.dropped} entries`)
  }
  const savedAt = Date.now()
  const envelope = JSON.stringify({ savedAt, library: parsed.data })
  const result = await db.prepare('UPDATE users SET template_library = ?1 WHERE id = ?2')
    .bind(envelope, userId)
    .run()
  if ((result.meta?.changes ?? 0) === 0) throw new Error('Account not found')
  return { templates: parsed.data.templates.length, categories: parsed.data.categories.length }
}
