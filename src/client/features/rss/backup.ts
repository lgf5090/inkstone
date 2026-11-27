import type { RssEntry, RssLibrary } from '@shared/rss/model'
import { exportRssBackup, parseRssBackup, type RssBackup, type RssBackupOptions } from '@shared/rss/backup'

export { RSS_BACKUP_MAX_BYTES, RSS_BACKUP_VERSION, type RssBackup } from '@shared/rss/backup'

export function exportRssLibraryBackup(
  library: RssLibrary,
  articles: readonly RssEntry[] = [],
  options: RssBackupOptions = {},
): string {
  return exportRssBackup(library, articles, options)
}

export function parseRssLibraryBackup(text: string): RssBackup | null {
  return parseRssBackup(text)
}
