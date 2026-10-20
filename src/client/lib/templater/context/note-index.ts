/**
 * The path and link half of a run's note context.
 *
 * Templater reaches the vault synchronously — `tp.file.find_tfile` is not a promise, and neither is
 * `metadataCache.getFirstLinkpathDest` — so everything the `tp.file.*` surface needs has to be in hand
 * before the run starts. This module builds that from a snapshot's plain entries: no lazy fetch, no
 * store, no network. What it cannot answer it reports as *not found*; it never guesses a note into
 * existence, because a template that silently gets someone else's note writes to the wrong file.
 *
 * The lookup rules, each pinned by a test in `note-index.test.ts`:
 *
 * - **exact path** (`resolvePath`, `existsPath`, `getFolderByPath`): the whole virtual path, extension
 *   included, compared case-sensitively after normalisation. This is what `tp.file.exists` and
 *   `vault.getAbstractFileByPath` use, and why upstream's `exists("exists")` is false: no extension,
 *   no match.
 * - **link text** (`findByLinkpath`, `resolveWikiLink`): Obsidian's `getFirstLinkpathDest` shape — link
 *   text with any `#…` anchor already taken off, matched against a tier list, the first tier that
 *   yields anything wins: full path, then path without extension and folder-suffix plus basename for a
 *   qualified link text, then basename, then the same folded. Among a tier's candidates the one whose
 *   folder is closest to the source note wins, which is what Obsidian's own resolution does and what
 *   makes `[[note]]` inside `notes/` pick `notes/note.md` over `archive/note.md`.
 * - **notes before templates**: at equal proximity a library row loses to a note, because upstream
 *   finds the vault file first and the template folder is only the fallback a reader reaches when the
 *   note does not exist.
 * - **duplicates**: two rows may project onto one path (a filesystem forbids it, a database does not).
 *   Every match is kept and reachable, the winner is the earliest created, then the lowest id — a fixed
 *   order that does not depend on the page's list order — and the collision is listed by
 *   {@link NoteIndex.ambiguities} so the host can answer `note-conflict` rather than pick silently.
 * - **sub-paths**: `#Heading` and `#^block` are *parsed*, never *applied*. Slicing a heading out of a
 *   note needs that note's body, and the index deliberately carries none: it holds no content for any
 *   note, which is the only reason building it over 20,000 notes is cheap.
 */
import { foldCase } from '@shared/markdown-utils'
import type { FolderIndexEntry, NoteIndexEntry } from '../protocol'
import { MARKDOWN_EXTENSION, TEMPLATES_FOLDER_ID } from './file-wrapper'

/** Which table a row came from; decides tie-breaks a vault never has to make. */
export type IndexKind = 'note' | 'template'

/** A `#Heading` or `#^block-id` part of a link, kept as written. */
export type SubpathTarget =
  | { kind: 'heading'; heading: string }
  | { kind: 'block'; blockId: string }

/** What a link text reads as: the note it names, the part of it, and the display alias. */
export interface LinkTextParts {
  /** Everything before the first `#`, alias stripped. `''` means "the note being read". */
  linkpath: string
  /** `null` when the link names a whole note. */
  subpath: SubpathTarget | null
  /** Text after `|`, which is what the reader sees, never what is matched. */
  alias: string | null
}

/** One path asked about, with every row that lives at it. */
export interface PathResolution {
  path: string
  /** The deterministic winner, or `null` when nothing is there. */
  entry: NoteIndexEntry | null
  /** Every match, in the same deterministic order; more than one means a collision. */
  matches: NoteIndexEntry[]
  ambiguous: boolean
}

/**
 * A link resolved to a row.
 *
 * `subpathResolved` is the type-level promise that the heading or block was *not* cut out of anything:
 * it is the literal `false`, so a caller that tries to read the result as finished content does not
 * compile. The host fetches the body (`note.read`) and slices it there, because the index carries no
 * body for any note by design.
 */
export interface ResolvedLink {
  entry: NoteIndexEntry | null
  linkpath: string
  subpath: SubpathTarget | null
  alias: string | null
  /** True for `[[#Heading]]`, which names the note being written rather than a row to look up. */
  selfReference: boolean
  subpathResolved: false
  matches: NoteIndexEntry[]
  ambiguous: boolean
}

/** A path two or more rows claim, which is the reader-visible half of the duplicate rule. */
export interface Ambiguity {
  kind: 'file' | 'folder'
  path: string
  ids: string[]
}

export interface NoteIndexInput {
  notes: NoteIndexEntry[]
  templates?: NoteIndexEntry[]
  folders: FolderIndexEntry[]
}

export interface NoteIndex {
  /** Notes then templates, each row listed once: the list `TemplateRunContext.index` carries. */
  readonly entries: NoteIndexEntry[]
  /** Real folders plus the virtual `Templates` folder, as given. */
  readonly folders: FolderIndexEntry[]
  allNotes(): NoteIndexEntry[]
  allTemplates(): NoteIndexEntry[]
  getById(id: string): NoteIndexEntry | null
  getFolderById(id: string): FolderIndexEntry | null
  getFolderByPath(path: string): FolderIndexEntry | null
  getTemplateByName(name: string): NoteIndexEntry | null
  resolvePath(path: string): PathResolution
  getByPath(path: string): NoteIndexEntry | null
  existsPath(path: string): boolean
  /** Link text with the anchor already removed; `sourcePath` only decides which candidate is closest. */
  findByLinkpath(linkpath: string, sourcePath?: string): NoteIndexEntry | null
  /** `null` when the text is not a `[[…]]` link at all, which is upstream's "invalid format" case. */
  resolveWikiLink(text: string, sourcePath?: string): ResolvedLink | null
  /** Paths with more than one row behind them. */
  ambiguities(): Ambiguity[]
  /** Folder ids referenced by an entry but absent from the folder list. */
  unresolvedFolderIds(): string[]
}

interface Indexed {
  entry: NoteIndexEntry
  kind: IndexKind
  /** Path minus the extension, which is the half a link text is compared against. */
  stem: string
  /** Last segment of `stem`, the form a bare `[[title]]` link takes. */
  basename: string
  /** Folder segments, for the closest-to-source ranking. */
  folderSegments: string[]
}

const PATH_SEPARATOR_RUN = /\/{2,}/g
const CONTROL_IN_PATH = /[\u0000-\u001f\u007f]/g
const TRAILING_MARKDOWN = new RegExp(`\\.${MARKDOWN_EXTENSION}$`, 'i')

/**
 * A path as the API sees it: backslashes folded, repeated and outer slashes dropped.
 *
 * Case is left alone, the way Obsidian's own `normalizePath` leaves it — the forgiving, case-folded
 * lookup is `findByLinkpath`, and `resolvePath` is the strict one a template can test against.
 */
export function normalizeVirtualPath(path: string): string {
  return path
    .replace(CONTROL_IN_PATH, '')
    .trim()
    .replace(/\\/g, '/')
    .replace(PATH_SEPARATOR_RUN, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

/** `Notes/Meeting.md` reads as `Notes/Meeting`, which is the form a link text or a title takes. */
export function stripMarkdownExtension(path: string): string {
  return path.replace(TRAILING_MARKDOWN, '')
}

function lastSegment(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

function folderSegmentsOf(path: string): string[] {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? [] : normalizeVirtualPath(path.slice(0, slash)).split('/').filter(Boolean)
}

/**
 * A link text split into note, anchor and alias.
 *
 * The anchor starts at the *first* `#` and the alias at the first `|`, with no escape handling: that is
 * exactly how `wikiNoteTarget` in `@shared/markdown-utils` reads a link, so a title holding a `#` is
 * ambiguous in the backlinks panel and in a template alike rather than in one place only. Such a note
 * stays addressable by its full path.
 */
export function parseLinkText(text: string): LinkTextParts {
  const pipe = text.indexOf('|')
  const head = pipe === -1 ? text : text.slice(0, pipe)
  const alias = pipe === -1 ? null : text.slice(pipe + 1)
  const hash = head.indexOf('#')
  const linkpath = (hash === -1 ? head : head.slice(0, hash)).trim()
  // Outer spaces are padding around the anchor, the same as around the note part; the inside of a
  // heading is its text and is kept, including the `/` of Obsidian's nested `#Parent/Child` form.
  const anchor = hash === -1 ? '' : head.slice(hash + 1).trim()
  if (!anchor) return { linkpath, subpath: null, alias }
  if (anchor.startsWith('^')) {
    const blockId = anchor.slice(1).trim()
    return { linkpath, subpath: blockId ? { kind: 'block', blockId } : null, alias }
  }
  return { linkpath, subpath: { kind: 'heading', heading: anchor }, alias }
}

/**
 * The `[[…]]` form, exactly as upstream's `linkpath_regex` reads it (`InternalModuleFile.ts:23`).
 *
 * An embed prefix is not accepted, because upstream's own regex is not satisfied by it either: an
 * `include('![[x]]')` answers "provide an Obsidian link" there, and quietly accepting it here would make
 * the port disagree with the plugin's documented error.
 */
export function parseWikiLinkText(text: string): LinkTextParts | null {
  if (typeof text !== 'string') return null
  if (text.startsWith('[[') && text.endsWith(']]') && text.length > 4) return parseLinkText(text.slice(2, -2))
  // A bare path is `find_tfile`'s business, and quietly accepting it here would turn upstream's
  // "provide an Obsidian link" error into an include of the wrong note.
  return null
}

function kindRank(indexed: Indexed): number {
  return indexed.kind === 'note' ? 0 : 1
}

/**
 * The one order every lookup and every collision resolves to.
 *
 * Proximity first (a reader linking `[[note]]` from inside `notes/` means the note next to them), then
 * notes over templates, then creation time, then id. The last two are what make it total: two rows
 * imported in the same second share everything else, and an id is the only thing that never moves.
 */
function compareIndexed(a: Indexed, b: Indexed, sourceFolder: string[]): number {
  const proximity = sharedFolderPrefix(b.folderSegments, sourceFolder) - sharedFolderPrefix(a.folderSegments, sourceFolder)
  if (proximity !== 0) return proximity
  const kind = kindRank(a) - kindRank(b)
  if (kind !== 0) return kind
  const created = a.entry.createdAt - b.entry.createdAt
  if (created !== 0) return created
  return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0
}

function sharedFolderPrefix(folder: string[], source: string[]): number {
  let shared = 0
  while (shared < folder.length && shared < source.length && foldCase(folder[shared]!) === foldCase(source[shared]!)) {
    shared++
  }
  return shared
}

function endsWithSegments(folder: string[], want: string[], fold: boolean): boolean {
  if (want.length > folder.length) return false
  const offset = folder.length - want.length
  for (let index = 0; index < want.length; index++) {
    const left = folder[offset + index]!
    const right = want[index]!
    if (fold ? foldCase(left) !== right : left !== right) return false
  }
  return true
}

/**
 * Builds the index over the rows the page already has.
 *
 * Linear in rows and folders: one pass to key the folders, one pass to key each row. Measured on this
 * machine with the generated fixture in `note-index.test.ts`: 20,000 entries in 226 ms and 40,000 in
 * 472 ms — 2.1 times the work for 2 times the rows, which is the shape a per-row cost has and not the
 * shape a rebuild-per-row would have. The same 20,000 measured 146 ms when nothing else was running, so
 * read these as a shared-machine numbers, not as a budget.
 */
export function buildNoteIndex(input: NoteIndexInput): NoteIndex {
  const folders: FolderIndexEntry[] = []
  const foldersById = new Map<string, FolderIndexEntry>()
  const foldersByPath = new Map<string, FolderIndexEntry[]>()
  for (const folder of input.folders) {
    if (foldersById.has(folder.id)) continue
    foldersById.set(folder.id, folder)
    folders.push(folder)
    push(foldersByPath, folder.path, folder)
  }

  const listed: Indexed[] = []
  const notes: NoteIndexEntry[] = []
  const templates: NoteIndexEntry[] = []
  const byId = new Map<string, Indexed>()
  const byPath = new Map<string, Indexed[]>()
  const byStem = new Map<string, Indexed[]>()
  const byBasename = new Map<string, Indexed[]>()
  const byBasenameFolded = new Map<string, Indexed[]>()
  const templatesByName = new Map<string, Indexed[]>()

  const add = (entry: NoteIndexEntry, kind: IndexKind): void => {
    const folder = entry.folderId === null ? undefined : foldersById.get(entry.folderId)
    const folderPath = folder === undefined ? '' : folder.path
    const stem = stripMarkdownExtension(entry.path)
    const item: Indexed = {
      entry,
      kind,
      stem,
      basename: lastSegment(stem),
      folderSegments: folderPath ? folderPath.split('/') : [],
    }
    // A row listed twice is indexed once: the page's note list and the run's target can be the same
    // note, and a duplicate in `index` would reach the interpreter as two files.
    if (!byId.has(entry.id)) {
      byId.set(entry.id, item)
      listed.push(item)
      push(byPath, entry.path, item)
      push(byStem, stem, item)
      push(byBasename, item.basename, item)
      push(byBasenameFolded, foldCase(item.basename), item)
      if (kind === 'template') {
        templates.push(entry)
        push(templatesByName, entry.title, item)
      } else {
        notes.push(entry)
      }
    }
  }

  for (const entry of input.notes) add(entry, 'note')
  for (const entry of input.templates ?? []) add(entry, 'template')

  /**
   * The candidate list for a link text: the first tier with anything in it wins, so an exact path is
   * never beaten by an unrelated note of the same name.
   *
   * A link text with no folder part (`note`) skips the "whole path, no extension" tier: it names a root
   * file just as readily as the note next to the reader, and Obsidian resolves it by closeness rather
   * than by treating the root as the default. Everything else keeps the order the reader would expect
   * from a file system.
   */
  function candidatesFor(linkpath: string): Indexed[] {
    const normalized = normalizeVirtualPath(linkpath)
    const stem = stripMarkdownExtension(normalized)
    const segments = stem.split('/').filter(Boolean)
    const basename = segments.pop() ?? ''
    if (!basename) return []
    const parents = segments
    const exact = byPath.get(normalized)
    if (exact?.length) return exact
    if (parents.length) {
      const noExtension = byStem.get(stem)
      if (noExtension?.length) return noExtension
    }
    const named = byBasename.get(basename) ?? []
    if (parents.length) {
      const suffixed = named.filter((item) => endsWithSegments(item.folderSegments, parents, false))
      if (suffixed.length) return suffixed
    } else if (named.length) {
      return named
    }
    // Folded fallback: re-keying the whole path list would cost a second copy of every path, so only
    // the basename bucket is folded — a case-mismatched link is rare, and one bucket scan is cheap.
    const folded = byBasenameFolded.get(foldCase(basename)) ?? []
    const foldedStem = foldCase(stem)
    const whole = folded.filter((item) => foldCase(item.stem) === foldedStem)
    if (whole.length) return whole
    if (parents.length) return folded.filter((item) => endsWithSegments(item.folderSegments, parents.map(foldCase), true))
    return folded
  }

  function ordered(candidates: Indexed[], sourcePath: string): Indexed[] {
    const source = folderSegmentsOf(normalizeVirtualPath(sourcePath))
    return [...candidates].sort((a, b) => compareIndexed(a, b, source))
  }

  function resolution(path: string): PathResolution {
    const normalized = normalizeVirtualPath(path)
    const matches = ordered(byPath.get(normalized) ?? [], normalized)
    return {
      path: normalized,
      entry: matches.length ? matches[0]!.entry : null,
      matches: matches.map((item) => item.entry),
      ambiguous: matches.length > 1,
    }
  }

  function linkResolution(parts: LinkTextParts, sourcePath: string): ResolvedLink {
    const matches = ordered(parts.linkpath ? candidatesFor(parts.linkpath) : [], sourcePath)
    return {
      entry: matches.length ? matches[0]!.entry : null,
      linkpath: normalizeVirtualPath(parts.linkpath),
      subpath: parts.subpath,
      alias: parts.alias,
      // `[[#Heading]]` names the note being written. The index has no notion of "current", so it hands
      // the anchor back unresolved rather than inventing a row for it.
      selfReference: parts.linkpath === '' && parts.subpath !== null,
      subpathResolved: false,
      matches: matches.map((item) => item.entry),
      ambiguous: matches.length > 1,
    }
  }

  return {
    entries: [...notes, ...templates],
    folders,
    allNotes: () => [...notes],
    allTemplates: () => [...templates],
    getById: (id) => byId.get(id)?.entry ?? null,
    getFolderById: (id) => foldersById.get(id) ?? null,
    getFolderByPath: (path) => foldersByPath.get(normalizeVirtualPath(path))?.[0] ?? null,
    getTemplateByName: (name) => {
      const trimmed = name.trim()
      const withExtension = TRAILING_MARKDOWN.test(trimmed) ? trimmed : `${trimmed}.${MARKDOWN_EXTENSION}`
      const withoutExtension = trimmed.replace(TRAILING_MARKDOWN, '')
      for (const key of [trimmed, withExtension, withoutExtension]) {
        const bucket = templatesByName.get(key)
        if (bucket?.length) return ordered(bucket, '')[0]!.entry
      }
      const folded = foldCase(trimmed)
      for (const [key, bucket] of templatesByName) {
        if (foldCase(key) === folded && bucket.length) return ordered(bucket, '')[0]!.entry
      }
      return null
    },
    resolvePath: resolution,
    getByPath: (path) => resolution(path).entry,
    existsPath: (path) => resolution(path).entry !== null,
    findByLinkpath: (linkpath, sourcePath = '') => {
      const best = ordered(candidatesFor(linkpath), sourcePath)[0]
      return best?.entry ?? null
    },
    resolveWikiLink: (text, sourcePath = '') => {
      const parts = parseWikiLinkText(text)
      return parts === null ? null : linkResolution(parts, sourcePath)
    },
    ambiguities: () => {
      const out: Ambiguity[] = []
      for (const [path, bucket] of byPath) {
        if (bucket.length > 1) out.push({ kind: 'file', path, ids: ordered(bucket, path).map((item) => item.entry.id) })
      }
      for (const [path, bucket] of foldersByPath) {
        if (bucket.length > 1) out.push({ kind: 'folder', path, ids: bucket.map((folder) => folder.id) })
      }
      return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    },
    unresolvedFolderIds: () => {
      const missing: string[] = []
      for (const item of listed) {
        const id = item.entry.folderId
        // The templates folder is a projection, not a row, so it is never "missing" from the list.
        if (id === null || id === TEMPLATES_FOLDER_ID || foldersById.has(id)) continue
        if (!missing.includes(id)) missing.push(id)
      }
      return missing
    },
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key)
  if (bucket) bucket.push(value)
  else map.set(key, [value])
}
