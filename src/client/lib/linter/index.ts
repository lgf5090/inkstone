/**
 * The door the app walks through to lint a note.
 *
 * The rule library, the markdown parser and the spelling table are all reached through a dynamic
 * import, so a reader who never turns the linter on pays nothing for them. Everything above this
 * module is plain text in, plain text out: the editor, the save path and the batch run all come
 * through here and get the same `LintOutcome`.
 */
import { DEFAULT_LINTER_SETTINGS, normalizeLinterSettings } from '@shared/linter'
import type { LinterSettings } from './settings-data'
import { lintFileInfo, noteIsIgnored } from './file-info'
import type { LintOutcome } from './runner'

export type LintRequest = {
  text: string
  /** The note's title, which is what the YAML title rules write into the front matter. */
  title: string
  /** The note's path as the reader sees it, used by the ignore list. */
  path: string
  folderTrail: string[]
  createdAt: number
  updatedAt: number
  settings?: LinterSettings
  locale: string
  now?: () => Date
}

export type { LintOutcome, LinterSettings }

let misspellings: Map<string, string> | null = null
let misspellingsLoad: Promise<Map<string, string>> | null = null

/** The default correction table, fetched once and only when a run wants it. */
async function loadMisspellings(): Promise<Map<string, string>> {
  if (misspellings) {
    return misspellings
  }

  misspellingsLoad ??= fetch('/linter/default-misspellings.md')
    .then((response) => (response.ok ? response.text() : ''))
    .then((table) => parseCorrectionTable(table))
    .catch(() => new Map<string, string>())
  misspellings = await misspellingsLoad

  return misspellings
}

/** The reference plugin's `| misspelled | corrected |` table, as a lookup. */
export function parseCorrectionTable(table: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of table.split('\n')) {
    const cells = /^\|(.*)\|$/.exec(line)
    if (!cells) continue
    const parts = cells[1].split('|').map((cell) => cell.trim())
    if (parts.length !== 2) continue
    const [misspelled, corrected] = parts
    if (!misspelled || !corrected || misspelled.toLowerCase() !== misspelled) continue
    if (/^:?-+$/.test(misspelled)) continue
    if (!map.has(misspelled)) map.set(misspelled, corrected)
  }

  return map
}

/**
 * Lint one note. Returns the text a rule set asked for, the aliases that changed it, and an error
 * message if a rule threw — a failed run never writes a half-linted document.
 */
export async function lintNote(request: LintRequest): Promise<LintOutcome> {
  const settings = normalizeLinterSettings(request.settings ?? DEFAULT_LINTER_SETTINGS)
  const stamp = {
    title: request.title,
    path: request.path,
    folderTrail: request.folderTrail,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  }
  if (!settings.enabled || noteIsIgnored(settings, stamp)) {
    return { text: request.text, changedRules: [], skipped: true, error: null }
  }

  // the registry is what makes all 67 rules exist; importing it registers and sorts them
  const [{ RulesRunner }] = await Promise.all([import('./runner'), import('./registry')])
  const fileInfo = lintFileInfo(stamp, request.locale)

  const runner = new RulesRunner()

  return runner.lintText({
    oldText: request.text,
    fileInfo,
    settings,
    locale: request.locale,
    getCurrentTime: request.now ?? (() => new Date()),
    defaultMisspellings: await loadMisspellings(),
  })
}

/** Lint a note that is not open: the batch run over a folder or the whole library. */
export async function lintSavedNote(args: {
  title: string
  path: string
  folderTrail: string[]
  content: string
  createdAt: number
  updatedAt: number
  settings: LinterSettings
  locale: string
  now?: () => Date
}): Promise<LintOutcome> {
  return lintNote({
    text: args.content,
    title: args.title,
    path: args.path,
    folderTrail: args.folderTrail,
    createdAt: args.createdAt,
    updatedAt: args.updatedAt,
    settings: args.settings,
    locale: args.locale,
    now: args.now,
  })
}

/** Run the paste-time rules over text that is about to land in a note. */
export async function lintPaste(args: {
  text: string
  currentLine: string
  selectedText: string
  settings: LinterSettings
}): Promise<string> {
  const settings = normalizeLinterSettings(args.settings)
  if (!settings.enabled || !settings.lintOnPaste) {
    return args.text
  }

  const { RulesRunner } = await import('./runner')

  return new RulesRunner().runPasteLint({ ...args, settings })
}
