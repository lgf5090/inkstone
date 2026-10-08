/**
 * Turns a note or an attachment into the pair of things the index needs: the fields to tokenize and
 * the small record to keep for display and post-filtering.
 */
import { deriveExcerpt, extractTags, normalizeLinkKey, parseFrontMatter } from '@shared/markdown-utils'
import { truncateText } from '@shared/text-utils'
import type { OmnisearchDocument, OmnisearchStoredFields } from './types'
import { OMNISEARCH_DOC_ID_PREFIX } from './types'

export const OMNISEARCH_EXCERPT_CHARS = 240
export const OMNISEARCH_CUSTOM_VALUE_MAX = 8
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/
const PROPERTY_NAME_MAX = 40
const PROPERTY_VALUE_MAX = 120

export interface NoteSource {
  id: string
  title: string
  content: string
  updatedAt: number
  folderPath: string
  archived: boolean
  starred: boolean
}

export interface FileSource {
  id: string
  filename: string
  noteId: string | null
  updatedAt: number
  size: number
  mime: string
}

export interface DocumentSettings {
  /** A front matter key, `#heading` for the first level-one heading, or empty for the title. */
  displayTitle: string
  customPropertyNames: string[]
  contentCap: number
}

interface Headings {
  level1: string
  level2: string
  level3: string
  first: string
}

function headingTexts(body: string): Headings {
  const levels: string[][] = [[], [], []]
  let fence = ''
  for (const line of body.split('\n')) {
    const open = FENCE.exec(line)
    if (open) {
      const marker = open[1]![0]!
      fence = fence && fence === marker ? '' : marker
      continue
    }
    if (fence) continue
    const heading = HEADING.exec(line)
    if (!heading) continue
    const level = heading[1]!.length
    const text = heading[2]!.replace(/\s+#+\s*$/, '').trim()
    if (!text) continue
    if (level <= 3) levels[level - 1]!.push(text)
  }
  return {
    level1: levels[0]!.join(' '),
    level2: levels[1]!.join(' '),
    level3: levels[2]!.join(' '),
    first: levels[0]![0] ?? '',
  }
}

function aliasTexts(data: Record<string, unknown>): string {
  const value = data.aliases ?? data.alias
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').join(' ')
  return typeof value === 'string' ? value : ''
}

function scalarValues(value: unknown): string[] {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)]
  }
  if (Array.isArray(value)) return value.flatMap(scalarValues).slice(0, OMNISEARCH_CUSTOM_VALUE_MAX)
  return []
}

/**
 * The reference plugin reads front matter out of Obsidian's metadata cache at query time and calls
 * `.includes()` on whatever it finds, which throws for a numeric property. Values are flattened to
 * strings here instead, so the boost loop has nothing that can throw.
 */
export function customPropertyValues(data: Record<string, unknown>, names: string[]): string[] {
  const out: string[] = []
  for (const name of names) {
    if (!name) continue
    for (const value of scalarValues(data[name.slice(0, PROPERTY_NAME_MAX)])) {
      const text = truncateText(value, PROPERTY_VALUE_MAX).trim()
      if (text && !out.includes(text)) out.push(text)
    }
  }
  return out.slice(0, 32)
}

function displayTitleOf(
  data: Record<string, unknown>,
  headings: Pick<Headings, 'first'>,
  setting: string,
): string {
  if (!setting) return ''
  if (setting === '#heading') return truncateText(headings.first, 200)
  const value = scalarValues(data[setting.slice(0, PROPERTY_NAME_MAX)])[0]
  return value ? truncateText(value, 200) : ''
}

export function extensionOf(pathOrName: string): string {
  const name = pathOrName.split('/').pop() ?? pathOrName
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export interface BuiltDocument {
  doc: OmnisearchDocument
  stored: OmnisearchStoredFields
  body: string
  customValues: string[]
  linkKeys: string[]
}

export function notePathOf(source: NoteSource, ext = 'md'): string {
  return `${source.folderPath ? `${source.folderPath}/` : ''}${source.title || 'untitled'}.${ext}`
}

export function buildNoteDocument(source: NoteSource, settings: DocumentSettings): BuiltDocument {
  const parsed = parseFrontMatter(source.content)
  const headings = headingTexts(parsed.body)
  const path = notePathOf(source)
  const excerpt = deriveExcerpt(source.content, OMNISEARCH_EXCERPT_CHARS)
  const body = source.content.slice(0, settings.contentCap)
  const customValues = customPropertyValues(parsed.data, settings.customPropertyNames)
  const doc: OmnisearchDocument = {
    id: `${OMNISEARCH_DOC_ID_PREFIX.note}${source.id}`,
    kind: 'note',
    title: source.title,
    displayTitle: displayTitleOf(parsed.data, headings, settings.displayTitle),
    path,
    folder: source.folderPath,
    ext: 'md',
    basename: source.title || 'untitled',
    aliases: aliasTexts(parsed.data),
    headings1: headings.level1,
    headings2: headings.level2,
    headings3: headings.level3,
    updatedAt: source.updatedAt,
    archived: source.archived,
    starred: source.starred,
    noteId: source.id,
  }
  const stored: OmnisearchStoredFields = {
    kind: 'note',
    title: source.title,
    displayTitle: doc.displayTitle,
    path,
    folder: source.folderPath,
    ext: 'md',
    updatedAt: source.updatedAt,
    archived: source.archived,
    starred: source.starred,
    noteId: source.id,
    tags: extractTags(source.content).map((name) => normalizeLinkKey(name)),
    customValues,
    excerpt,
    truncated: source.content.length > body.length,
    size: source.content.length,
  }
  return {
    doc,
    stored,
    body,
    customValues,
    linkKeys: [],
  }
}

export function buildFileDocument(source: FileSource): BuiltDocument {
  const ext = extensionOf(source.filename) || 'file'
  const doc: OmnisearchDocument = {
    id: `${OMNISEARCH_DOC_ID_PREFIX.file}${source.id}`,
    kind: 'file',
    title: source.filename,
    displayTitle: '',
    path: source.filename,
    folder: '',
    ext,
    basename: source.filename,
    aliases: '',
    headings1: '',
    headings2: '',
    headings3: '',
    updatedAt: source.updatedAt,
    archived: false,
    starred: false,
    noteId: source.noteId ?? '',
  }
  const stored: OmnisearchStoredFields = {
    kind: 'file',
    title: source.filename,
    displayTitle: '',
    path: source.filename,
    folder: '',
    ext,
    updatedAt: source.updatedAt,
    archived: false,
    starred: false,
    noteId: source.noteId ?? '',
    tags: [],
    customValues: [],
    excerpt: source.mime,
    truncated: false,
    size: source.size,
  }
  return { doc, stored, body: '', customValues: [], linkKeys: [] }
}
