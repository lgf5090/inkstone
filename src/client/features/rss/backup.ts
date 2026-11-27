import { parseRssLibrary, type RssLibrary } from '@shared/rss/model'

const BACKUP_TYPE = 'inkstone-rss-library'
const BACKUP_VERSION = 1

export function exportRssLibraryBackup(library: RssLibrary): string {
  return JSON.stringify({ type: BACKUP_TYPE, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), library })
}

export function parseRssLibraryBackup(text: string): RssLibrary | null {
  try {
    const value = JSON.parse(text) as { type?: unknown, version?: unknown, library?: unknown }
    if (value.type !== BACKUP_TYPE || value.version !== BACKUP_VERSION) return null
    const parsed = parseRssLibrary(value.library)
    return parsed.data && parsed.dropped === 0 && !parsed.truncated ? parsed.data : null
  }
  catch {
    return null
  }
}
