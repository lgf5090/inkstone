/**
 * Reading the three snippet formats a reader is likely to arrive with.
 *
 * The parsers are pure and deliberately lenient about the wrapper — masscode has shipped more than
 * one top-level shape, and a VS Code snippet is an object keyed by title rather than a list — but
 * strict about what a snippet must have: a title and at least one non-empty file. A file that cannot
 * be named is given one from its language, and a file that cannot be read is skipped rather
 * than invented.
 */

import { defaultFileNames, isScriptLanguage, languageFromFileName, type ScriptLanguageId } from './languages'
import type { ScriptImportEntry, ScriptImportFile, ScriptImportSource } from './types'

const MAX_ENTRIES = 500
const MAX_FILES_PER_ENTRY = 20
const MAX_CONTENT_CHARS = 512_000

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function clipped(value: string): string {
  return value.length > MAX_CONTENT_CHARS ? value.slice(0, MAX_CONTENT_CHARS) : value
}

function tagsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const tag = typeof item === 'string'
      ? item
      : typeof record(item)?.name === 'string'
        ? String(record(item)!.name)
        : ''
    const clean = tag.trim().replace(/^#+/, '').slice(0, 64)
    if (clean && !out.includes(clean) && out.length < 12) out.push(clean)
  }
  return out
}

function languageOf(value: unknown, fileName: string): ScriptLanguageId {
  if (isScriptLanguage(value)) return value
  const fromName = languageFromFileName(fileName)
  return fromName.id
}

function fileOf(name: string | null, language: unknown, content: unknown): ScriptImportFile | null {
  const body = text(content)
  if (!body.trim()) return null
  const languageId = languageOf(language, name ?? '')
  const fileName = (name?.trim() || defaultFileNames(languageId)[0]!).slice(0, 128)
  return { name: fileName, language: languageId, content: clipped(body) }
}

function entryOf(title: string, description: string, files: Array<ScriptImportFile | null>, tags: string[]): ScriptImportEntry | null {
  const cleanTitle = title.trim().slice(0, 160)
  const usable = files.filter((file): file is ScriptImportFile => file !== null).slice(0, MAX_FILES_PER_ENTRY)
  if (!cleanTitle || !usable.length) return null
  return {
    title: cleanTitle,
    description: description.trim().slice(0, 400),
    tags,
    files: usable,
  }
}

/** masscode: `snippets: [{ name, content: [{ language, value }] }]`, or the older `content` string. */
function parseMasscode(value: unknown): ScriptImportEntry[] {
  const root = Array.isArray(value) ? value : record(value)?.snippets
  if (!Array.isArray(root)) return []
  const entries: ScriptImportEntry[] = []
  for (const item of root.slice(0, MAX_ENTRIES)) {
    const snippet = record(item)
    if (!snippet) continue
    const title = text(snippet.name) || text(snippet.title)
    const description = text(snippet.description)
    const tags = tagsOf(snippet.tags)
    const files: Array<ScriptImportFile | null> = []
    if (Array.isArray(snippet.content)) {
      for (const piece of snippet.content.slice(0, MAX_FILES_PER_ENTRY)) {
        const part = record(piece)
        if (!part) continue
        const language = part.language
        const fileName = text(part.name) || defaultFileNames(languageOf(language, ''))[0]!
        files.push(fileOf(fileName, language, part.value ?? part.content))
      }
    } else if (typeof snippet.content === 'string') {
      const language = snippet.language
      files.push(fileOf(defaultFileNames(languageOf(language, ''))[0]!, language, snippet.content))
    }
    const entry = entryOf(title, description, files, tags)
    if (entry) entries.push(entry)
  }
  return entries
}

/** VS Code: an object keyed by title, each holding `body` as a string or a list of lines. */
function parseVsCode(value: unknown): ScriptImportEntry[] {
  const root = record(value)
  if (!root) return []
  const entries: ScriptImportEntry[] = []
  for (const [title, item] of Object.entries(root).slice(0, MAX_ENTRIES)) {
    const snippet = record(item)
    if (!snippet) continue
    const body = Array.isArray(snippet.body)
      ? snippet.body.filter((line): line is string => typeof line === 'string').join('\n')
      : text(snippet.body)
    const scope = text(snippet.scope)
    const language = scope.split(',')[0]?.trim() || undefined
    const files = [fileOf(title.includes('.') ? title : null, language, body)]
    const entry = entryOf(title, text(snippet.description), files, [])
    if (entry) entries.push(entry)
  }
  return entries
}

/** The generic shape this app's own export uses, and the reader-legible one a hand-written file uses. */
function parseGeneric(value: unknown): ScriptImportEntry[] {
  const root = Array.isArray(value) ? value : record(value)?.snippets
  if (!Array.isArray(root)) return []
  const entries: ScriptImportEntry[] = []
  for (const item of root.slice(0, MAX_ENTRIES)) {
    const snippet = record(item)
    if (!snippet) continue
    const title = text(snippet.title) || text(snippet.name)
    const description = text(snippet.description)
    const tags = tagsOf(snippet.tags)
    const files: Array<ScriptImportFile | null> = []
    if (Array.isArray(snippet.files)) {
      for (const piece of snippet.files.slice(0, MAX_FILES_PER_ENTRY)) {
        const part = record(piece)
        if (!part) continue
        files.push(fileOf(text(part.name) || null, part.language, part.content))
      }
    } else {
      const language = snippet.language
      files.push(fileOf(null, language, snippet.content))
      const extra = record(snippet)
      if (Array.isArray(extra?.extraFiles)) {
        for (const piece of extra.extraFiles.slice(0, MAX_FILES_PER_ENTRY - 1)) {
          const part = record(piece)
          if (!part) continue
          files.push(fileOf(text(part.name) || null, part.language, part.content))
        }
      }
    }
    const entry = entryOf(title, description, files, tags)
    if (entry) entries.push(entry)
  }
  return entries
}

export function parseScriptImport(source: ScriptImportSource, value: unknown): ScriptImportEntry[] {
  if (source === 'masscode') return parseMasscode(value)
  if (source === 'vscode') return parseVsCode(value)
  return parseGeneric(value)
}

/** Best guess at the format, for a reader who would rather not choose. */
export function detectScriptImportSource(value: unknown): ScriptImportSource {
  if (Array.isArray(value)) {
    const first = record(value[0])
    return first?.files !== undefined ? 'generic' : 'masscode'
  }
  const root = record(value)
  if (!root) return 'generic'
  if (Array.isArray(root.snippets)) {
    const first = record(root.snippets[0])
    return first?.files !== undefined ? 'generic' : 'masscode'
  }
  const values = Object.values(root)
  if (values.length && values.every((item) => record(item)?.body !== undefined)) return 'vscode'
  return 'generic'
}

/** The entries as this app's own export shape, so an export can be imported by the same parser. */
export function serializeScriptExport(entries: Array<{ title: string; description: string; tags: string[]; files: Array<{ name: string; language: string; content: string }> }>): string {
  return JSON.stringify({ format: 'inkstone-scriptshub', version: 1, snippets: entries }, null, 2)
}

export type ImportTitleDecision =
  | { action: 'keep'; title: string }
  | { action: 'skip' }
  | { action: 'rename'; title: string }
  | { action: 'overwrite'; title: string }

/**
 * What to do with a title that is already in the library.
 *
 * Kept pure and shared so the import dialog can explain the policy and the store can apply it with
 * one rule; the store still asks the database for the numbered name, because only it knows which
 * suffixes are already taken.
 */
export function importTitleDecision(title: string, conflict: 'skip' | 'rename' | 'overwrite', exists: boolean): ImportTitleDecision {
  if (!exists) return { action: 'keep', title }
  if (conflict === 'skip') return { action: 'skip' }
  if (conflict === 'overwrite') return { action: 'overwrite', title }
  return { action: 'rename', title }
}
