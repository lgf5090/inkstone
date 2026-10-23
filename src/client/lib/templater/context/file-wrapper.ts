/**
 * The plain, serialisable shapes a template run hands the interpreter.
 *
 * Templater's whole `tp.file` surface is written against an Obsidian vault: a `TFile` has a `path`, a
 * `name`, a `basename` and a `stat`. Inkstone notes are database rows addressed by id and by a folder
 * tree, with no path and no filesystem behind them, so this module decides how a row is *projected*
 * onto the shape the template expects — and nothing else. It reads no store, calls no API, and returns
 * objects that survive `postStructuredClone` on their own merit: no class instance, no store handle, no
 * `Date` (the interpreter's `Date` is another realm's constructor, so a host `Date` handed across would
 * be an object the template cannot even compare with its own).
 *
 * The projection rules, each pinned by a test in `file-wrapper.test.ts`:
 *
 * - a note's basename is its title with the characters a file name cannot hold taken out (see
 *   {@link virtualBasename}); a blank title becomes `Untitled`, which is the name the app's own
 *   new-note flow and upstream's `create_new` default both use;
 * - the virtual path is the folder path, the basename and `.md` joined by `/`; the root folder's path
 *   is `''`, so a note at the root is `note.md`, never `/note.md`;
 * - a trailing `.md` in a title is not duplicated, because Obsidian reads `Guide.md` as the file
 *   `Guide.md` with basename `Guide`, and a template linking `[[Guide.md]]` must reach it;
 * - library templates are projected onto `Templates/<name>.md` so that `tp.file.include`,
 *   `tp.file.find_tfile` and `tp.config.template_file` can name a database row the way upstream names
 *   a vault file;
 * - two rows may project onto the same path here, which a filesystem forbids. Nothing is dropped and
 *   nothing is guessed away: every match is kept, one is chosen by a fixed order, and the collision is
 *   reported by `note-index.ts` so the host can answer `note-conflict` instead of pretending the
 *   choice was obvious.
 */
import { extractTags, parseFrontMatter } from '@shared/markdown-utils'
import type { Folder, Note, NoteTemplate } from '@shared/types'
import type { FolderIndexEntry, NoteIndexEntry, RunNoteRef } from '../protocol'

/** Every note here is Markdown; upstream's `extension` field has exactly one value in this product. */
export const MARKDOWN_EXTENSION = 'md'

/**
 * The folder library templates live in. It is not a row in `folders`, so it gets an id no real folder
 * can have: local ids are `<prefix>-<hex>` and server ids are 26-character lowercase ksuids, and
 * neither may contain a colon.
 */
export const TEMPLATES_FOLDER_ID = 'templater:templates'

/** The name that folder reads as, and the only segment of a template's path. */
export const TEMPLATES_FOLDER_NAME = 'Templates'

/** A note with a title that projects to nothing still needs one path segment. */
const UNTITLED_BASENAME = 'Untitled'

/** Control characters are invisible in a path and unreadable in a link, so they become spaces. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/g

/** A trailing `.md` in a title is the extension, not part of the name. */
const TRAILING_MARKDOWN = /\.md$/i

/**
 * The characters a file name cannot hold, each run of them becoming one `-`.
 *
 * Obsidian refuses `\ / :` in a name (`InternalModuleFile.ts:281` throws on them), so a title holding
 * one cannot become a path segment untouched: a `/` would fake a folder that is not in the tree and a
 * `:` would break the link the reader has to type back. Collapsing a run keeps `C:\Users` reading as
 * one separator rather than two.
 */
const ILLEGAL_IN_NAME = /[/\\:]+/g

/**
 * A name with the characters a path segment cannot hold taken out.
 *
 * Deliberately not a hash or a suffix on collision: the reader must be able to type the path they see
 * in the folder tree, so the projection stays as close to the title as a file name allows.
 */
function sanitizeSegment(name: string): string {
  const clean = name
    .replace(CONTROL_CHARACTER, ' ')
    .replace(ILLEGAL_IN_NAME, '-')
    .trim()
  // `.` and `..` are the two names that mean "somewhere else" to every path reader that will ever see
  // this string, including the host's own folder-name split. Nothing longer is touched: `.hidden` is a
  // real file name.
  if (clean === '.' || clean === '..') return ''
  return clean
}

/**
 * A title as one path segment, extension dropped: the `.md` is added back by {@link virtualNoteName},
 * so a title that already ends in it is not doubled.
 */
export function virtualBasename(title: string): string {
  return stripMarkdownSuffix(sanitizeSegment(title))
}

function stripMarkdownSuffix(name: string): string {
  return name.replace(TRAILING_MARKDOWN, '')
}

/**
 * A folder name as a path segment.
 *
 * `FolderIndexEntry.name` stays the row's own name, because the tree shows it; only the path is
 * sanitised, for the same reason a title is — a folder named `a/b` would otherwise read as two levels
 * to `tp.file.folder(true)`, and one named `..` would read as its parent. A folder keeps a `.md` in its
 * name, because for a folder that is a name and not an extension.
 */
export function virtualFolderSegment(name: string): string {
  return sanitizeSegment(name) || UNTITLED_BASENAME
}

/** The file name a note projects to, extension included. */
export function virtualNoteName(title: string): string {
  return `${virtualBasename(title) || UNTITLED_BASENAME}.${MARKDOWN_EXTENSION}`
}

/** Joining a folder path and a name; the root path is `''`, so this never yields a leading slash. */
export function joinVirtualPath(folderPath: string, name: string): string {
  return folderPath ? `${folderPath}/${name}` : name
}

/** A note's full virtual path, given its folder's path. */
export function virtualNotePath(folderPath: string, title: string): string {
  return joinVirtualPath(folderPath, virtualNoteName(title))
}

/** A library template's file name: `Daily note` and `daily-note.md` both read as `<name>.md`, once. */
export function virtualTemplateName(name: string): string {
  const base = virtualBasename(name) || UNTITLED_BASENAME
  return `${base}.${MARKDOWN_EXTENSION}`
}

/** A library template's virtual path, under the folder no other file is in. */
export function virtualTemplatePath(name: string): string {
  return joinVirtualPath(TEMPLATES_FOLDER_NAME, virtualTemplateName(name))
}

/**
 * A timestamp as epoch milliseconds.
 *
 * The rows carry numbers, so this only guards the two shapes that do reach a runtime from JSON — an
 * absent field and a `null` — by reading them as "no timestamp" (epoch 0) rather than inventing today's
 * date. A template that formats such a note prints 1970, which is visibly wrong to the reader instead
 * of quietly plausible.
 */
export function epochMillis(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The minimum the index needs to answer for one note. */
export function noteIndexEntry(note: Note, path: string): NoteIndexEntry {
  return {
    id: note.id,
    title: note.title,
    folderId: note.folderId,
    path,
    createdAt: epochMillis(note.createdAt),
    updatedAt: epochMillis(note.updatedAt),
  }
}

/** The same shape for a library template, which is why `find_tfile` can answer with it. */
export function templateIndexEntry(template: NoteTemplate, path: string): NoteIndexEntry {
  return {
    id: template.id,
    title: template.name,
    folderId: TEMPLATES_FOLDER_ID,
    path,
    createdAt: epochMillis(template.createdAt),
    updatedAt: epochMillis(template.updatedAt),
  }
}

export function folderIndexEntry(folder: Folder, path: string): FolderIndexEntry {
  return {
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    path,
  }
}

/** The folder every `Templates/<name>.md` entry claims as its parent, so `tp.file.folder()` reads well. */
export function templatesFolderEntry(): FolderIndexEntry {
  return {
    id: TEMPLATES_FOLDER_ID,
    name: TEMPLATES_FOLDER_NAME,
    parentId: null,
    path: TEMPLATES_FOLDER_NAME,
  }
}

/**
 * A note as the interpreter sees it: identifiers, text and parsed values, never a live row.
 *
 * `content` must be the text the run is about — the page passes the editor's unsaved buffer when the
 * template reads the live document, because upstream's `tp.file.content` is `vault.read` of the open
 * file, not of the last saved copy.
 */
export function runNoteRef(note: Note): RunNoteRef {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    folderId: note.folderId,
    tagNames: tagNamesOf(note.content),
    frontmatter: frontmatterValues(note.content),
    createdAt: epochMillis(note.createdAt),
    updatedAt: epochMillis(note.updatedAt),
    isEmpty: note.content.trim().length === 0,
  }
}

/**
 * A library template as a note-shaped ref, for `tp.file.include` and `tp.config.template_file`.
 *
 * Its gallery labels are metadata about the row — the filter chips in the template gallery — and not
 * tags inside the file, so `tagNames` reads the content the way a vault file's would. The row's
 * frontmatter is the same object a note's would be, because a template body is a Markdown body.
 */
export function templateRunRef(template: NoteTemplate): RunNoteRef {
  return {
    id: template.id,
    title: template.name,
    content: template.content,
    folderId: TEMPLATES_FOLDER_ID,
    tagNames: tagNamesOf(template.content),
    frontmatter: frontmatterValues(template.content),
    createdAt: epochMillis(template.createdAt),
    updatedAt: epochMillis(template.updatedAt),
    isEmpty: template.content.trim().length === 0,
  }
}

/** Tag names without the leading `#`, which is what upstream re-adds when it joins them. */
export function tagNamesOf(content: string): string[] {
  return extractTags(content)
}

/** The parsed frontmatter values, never the raw `---` block: `tp.frontmatter.<key>` reads values. */
export function frontmatterValues(content: string): Record<string, unknown> {
  return plainRecord(parseFrontMatter(content).data)
}

/**
 * Why {@link frontmatterValues} came back empty when the note clearly has a block.
 *
 * The run context has no field for a parse complaint, so dropping `parseFrontMatter`'s errors here
 * would be a silent failure the caller cannot see. `note.read` reports them.
 */
export function frontmatterErrors(content: string): string[] {
  return parseFrontMatter(content).errors
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/**
 * A YAML-parsed value reduced to what structured clone and the VM's hydrator can carry.
 *
 * Two tags reach a class instance, both checked against this repository's own `yaml`: `!!timestamp`
 * becomes a host `Date`, and `!!binary` a `Buffer`. A `Date` inside the interpreter is an object from
 * another realm — `tp.frontmatter.day instanceof moment` would be false and printing it gives English
 * weekday names in a Chinese interface — so a date at UTC midnight comes back as the day the reader
 * wrote and anything with a time as its full ISO form, both text and both reversible by `tp.date`. An
 * untagged `day: 2024-05-01` is already text in this schema and is left alone.
 *
 * Anything else the parser can hand back but a note should never hold is kept as its `String()` rather
 * than dropped, so a reader sees an odd value instead of a missing one.
 */
function plainValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Date) return isoDate(value)
  if (Array.isArray(value)) {
    if (seen.has(value)) return null
    seen.add(value)
    const mapped = value.map((item) => plainValue(item, seen))
    seen.delete(value)
    return mapped
  }
  if (isPlainRecord(value)) {
    if (seen.has(value)) return null
    seen.add(value)
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) copy[key] = plainValue(item, seen)
    seen.delete(value)
    return copy
  }
  if (value === null || typeof value !== 'object') return value
  return String(value)
}

function plainRecord(data: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>()
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) out[key] = plainValue(value, seen)
  return out
}

function isoDate(value: Date): string | null {
  const time = value.getTime()
  // An unparsable date is `null` to a template, which is what YAML's missing value already means;
  // `toISOString` would throw and take the whole run with it.
  if (Number.isNaN(time)) return null
  const iso = value.toISOString()
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso
}
