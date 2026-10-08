/**
 * The note metadata a lint run reads.
 *
 * The reference plugin asks Obsidian for a file's creation and modification times already formatted
 * by Moment; Inkstone has a note row with epoch milliseconds, so the same shape is built here from
 * the reader's locale. The ignore list is applied in the same place, because both the editor's
 * save-time lint and a batch run over the library have to answer it the same way.
 */
import { isLinterIgnoredPath } from '@shared/linter'
import { formatDatePattern } from '../quickadd/date-pattern'
import type { LintFileInfo } from './runner'
import type { LinterSettings } from './settings-data'

export type NoteStamp = {
  title: string
  path: string
  folderTrail: string[]
  createdAt: number
  updatedAt: number
}

export function lintFileInfo(note: NoteStamp, locale: string): LintFileInfo {
  return {
    name: note.title,
    createdAtFormatted: stampToIso(note.createdAt, locale),
    modifiedAtFormatted: stampToIso(note.updatedAt, locale),
    path: note.path,
  }
}

/**
 * A timestamp the timestamp rule can read back. `YYYY-MM-DDTHH:mm:ssZ` is what Moment's default
 * `format()` produced in the reference, and it round-trips through `Date` without a pattern.
 */
function stampToIso(value: number, locale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString()
  }

  return formatDatePattern(date, 'YYYY-MM-DDTHH:mm:ssZ', { locale })
}

export function noteIsIgnored(settings: LinterSettings, note: NoteStamp): boolean {
  return isLinterIgnoredPath(settings, note.path, note.folderTrail)
}
