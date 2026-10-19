import { startOfDay } from '../../../lib/time'

export interface FilenameDateSettings {
  useFilenameAsScheduledDate: boolean
  /** A `YYYY`/`MM`/`DD` token pattern, or empty to try the two shapes every journaling vault uses. */
  filenameAsScheduledDateFormat: string
  /** Sub-trees the reader allows inference in. Empty means the whole vault. */
  filenameAsDateFolders: string[]
}

const BARE_ISO = /(\d{4})-(\d{2})-(\d{2})/
const BARE_COMPACT = /(\d{4})(\d{2})(\d{2})/

function civilDay(year: number, month: number, day: number): Date | null {
  const date = startOfDay(new Date(year, month - 1, day))
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date
}

/**
 * Turn a configured token pattern into a matcher, or null when it uses tokens we cannot read back.
 *
 * Only `YYYY`, `MM` and `DD` are supported: a filename date is a day, and anything finer would be
 * a different feature pretending to be this one.
 */
function patternToRegExp(pattern: string): RegExp | null {
  let source = ''
  let cursor = 0
  while (cursor < pattern.length) {
    const rest = pattern.slice(cursor)
    if (rest.startsWith('YYYY')) {
      source += '(\\d{4})'
      cursor += 4
    }
    else if (rest.startsWith('MM')) {
      source += '(\\d{2})'
      cursor += 2
    }
    else if (rest.startsWith('DD')) {
      source += '(\\d{2})'
      cursor += 2
    }
    else {
      source += rest[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      cursor += 1
    }
  }
  if (!source.includes('\\d')) return null
  return new RegExp(`^${source}$`)
}

/**
 * The day a note's own name announces, used as a scheduled date when the task line names none.
 *
 * A wrong guess here is worse than no guess: it would stamp a date the reader never wrote, so the
 * feature stays off unless it is switched on, the note sits inside a folder the reader opted in,
 * and the name actually resolves to a day that exists.
 */
export function fallbackDateFromPath(path: string, settings: FilenameDateSettings): Date | null {
  if (!settings.useFilenameAsScheduledDate) return null
  if (!matchesAnyFolder(settings.filenameAsDateFolders, path)) return null

  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  const basename = path.substring(Math.max(0, slash + 1), dot < 0 ? path.length : dot)

  if (settings.filenameAsScheduledDateFormat !== '') {
    const pattern = patternToRegExp(settings.filenameAsScheduledDateFormat)
    const matched = pattern?.exec(basename)
    if (pattern && matched) {
      const [year, month, day] = matched.slice(1).map(Number)
      return civilDay(year!, month!, day!)
    }
  }

  const iso = BARE_ISO.exec(basename) ?? BARE_COMPACT.exec(basename)
  if (!iso) return null
  return civilDay(Number(iso[1]), Number(iso[2]), Number(iso[3]))
}

function matchesAnyFolder(folders: string[], path: string): boolean {
  if (folders.length === 0) return true
  return folders.some((folder) => path.startsWith(`${folder.replace(/\/+$/, '')}/`))
}

/** A task may borrow the filename's day only when it states no date the reader would notice missing. */
export function canApplyFallback(dates: { start: Date | null; scheduled: Date | null; due: Date | null }): boolean {
  return dates.start === null && dates.scheduled === null && dates.due === null
}
