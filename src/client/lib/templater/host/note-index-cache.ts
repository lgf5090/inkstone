/**
 * The page's cache of built note indexes, so a run does not pay for a library it already has.
 *
 * Every path a template reads, writes, moves or creates is resolved against a `NoteIndex`, and building one
 * is linear in the library's rows: 214.6 ms measured over 20,000 notes on this machine (plan §7.5, and the
 * `WP-C1` ledger row that turned it into this card), which `context/snapshot.ts` has already paid once to
 * freeze those rows into the run's context. A batch, a startup template and a dynamic-command pass each paid
 * it again for a library that had not moved in between, on the page's hot path. This module makes the second
 * and later runs over one library version cost a lookup plus one pass over the run's own rows.
 *
 * What makes a hit exact, which is the whole design rather than a detail of it:
 *
 * - **the cached artifact is a library, not a run.** Its rows are a run's snapshot rows with that run's own
 *   projections taken out — the target, the active note and the applied template are the three rows two runs
 *   of one library differ by while the library itself has not moved — and each run projects them back on. A
 *   run therefore answers from an index holding exactly the rows its snapshot carries, and never a row that
 *   belonged to somebody else's run.
 * - **only a version the cache has nothing stored for rebuilds.** Two kinds are accepted: one derived from the
 *   rows themselves ({@link libraryVersion}, or the same thing computed off a run's index rows when the page
 *   keeps no counter of its own), or one the page already maintains for some other reason. A version is a way
 *   of *finding* a stored index, never a reason to believe it: before one is handed to a run the cache proves
 *   every row it holds is a row this run carries, field by field, which is the one property a run's answers
 *   depend on and the one a counter that moved without the rows can break.
 * - **rebuild is the fallback for everything the cache cannot prove, so the cheap answer is never a wrong
 *   one.** The rows a run adds to a cached library are merged with what the library already answered, in the
 *   order `context/note-index.ts` documents, because a run that cannot see the note it was pointed at is a
 *   note somebody loses.
 */
import type { Folder, Note, NoteTemplate } from '@shared/types'
import { TEMPLATES_FOLDER_ID } from '../context/file-wrapper'
import { buildNoteIndex, type NoteIndex, type NoteIndexInput, type PathResolution } from '../context/note-index'
import type { NoteIndexEntry, TemplateRunContext } from '../protocol'

/**
 * How many library versions the cache holds an index for.
 *
 * Each one is the expensive object on the page — a 20,000-row index is a handful of maps and a few megabytes
 * of strings — and a run over a version nobody has used for a while is a run that moved on. Four is the
 * working set the page implies: the library a batch is walking, the one the reader just changed, and a slot
 * each way for a version arriving and a version leaving. `MAX_TRACKED_RUNS` in `./page-host.ts` is the same
 * kind of bound for the same reason: an unbounded cache is a leak report, not a design.
 */
export const MAX_TRACKED_INDEXES = 4

/** How an index over one library's rows is made; the seam the cost of a rebuild is measured through. */
export type NoteIndexBuilder = (rows: NoteIndexInput) => NoteIndex

export interface NoteIndexCacheOptions {
  /**
   * The page's own library version, read at the moment a run asks for one.
   *
   * Optional because the page has to be the one to say what a library version is: a store revision counter is
   * the cheap answer, and {@link libraryVersion} over the rows a run is about to read is the answer that needs
   * nothing new built. With neither, the cache keys itself off the run's own index rows.
   */
  version?: () => string | null
  /** How an index is built; `context/note-index.ts`'s own builder unless a caller is measuring. */
  build?: NoteIndexBuilder
  /** How many versions to keep; {@link MAX_TRACKED_INDEXES} unless a caller says otherwise, `0` for none. */
  maxTracked?: number
}

export interface NoteIndexCache {
  /**
   * The index one run resolves its paths against, for the library `rows` describes.
   *
   * `projections` are the ids the run is about — its target, its active note, the template it applies — the
   * only rows a run carries that its library may not have. Handing them in is what lets two runs of one
   * library share one built index; leaving them out costs that sharing and nothing else, because the rows a
   * run hands in always describe that run.
   */
  indexFor: (rows: NoteIndexInput, projections?: readonly string[]) => NoteIndex
  /** How many indexes have been built. The win is this number, never a stopwatch. */
  builds: () => number
  /** The row counts of the indexes being held, oldest first — the evidence behind the bound. */
  sizes: () => number[]
}

/** The rows a library is, as the page holds them before a run projects anything onto them. */
export interface LibraryRows {
  notes: Note[]
  folders: Folder[]
  templates: NoteTemplate[]
}

interface StoredIndex {
  index: NoteIndex
  /** Every row the stored index was built over, keyed by id — the only proof a run may resolve through it. */
  rows: Map<string, NoteIndexEntry>
  /** The folder rows it was built inside of, so a tree that moved is not mistaken for one that did not. */
  folderKey: string
}

/** A cached library this run resolves through, beside the key it is held under and the rows it adds. */
interface FittingLibrary {
  entry: StoredIndex
  /** Recency is what keeps a library in the cache, and the entry does not know its own key. */
  key: string
  overlay: NoteIndexEntry[]
}

/** The fields an index entry is made of, joined for a key; no body is in an entry, so no body is read. */
function entryFields(entry: NoteIndexEntry): string {
  return `${entry.id}\u0000${entry.title}\u0000${entry.folderId ?? ''}\u0000${entry.path}\u0000${entry.createdAt}\u0000${entry.updatedAt}`
}

/**
 * A version for one set of index rows, order aside.
 *
 * Every field an entry is made of is named here, with the folder rows a path is built from beside them, so
 * two row sets that read as one version really do index to one library: a row that moved, changed, arrived or
 * went takes the version with it. A note's *body* is the one thing deliberately absent — an index holds no
 * body for any note, which is the only reason building one over 20,000 notes is affordable at all — so a body
 * edit that leaves the title, the folder and the timestamps alone does not invalidate an index that never
 * read it. Sorting makes a reorder of the same rows cost nothing.
 */
function fingerprint(rows: NoteIndexInput): string {
  const parts: string[] = []
  for (const folder of rows.folders) {
    parts.push(`f\u0000${folder.id}\u0000${folder.name}\u0000${folder.parentId ?? ''}\u0000${folder.path}`)
  }
  for (const entry of rows.notes) parts.push(`n\u0000${entryFields(entry)}`)
  for (const entry of rows.templates ?? []) parts.push(`t\u0000${entryFields(entry)}`)
  parts.sort()
  return parts.join('\u0001')
}

/**
 * A version for the rows a run is about to be built from: cheaper than the index it stands in for, and exact
 * about everything that index reads.
 *
 * This is the fingerprint for a page that keeps no revision counter: it names the fields that decide what an
 * index contains — which rows exist, where each sits, what it is called, when it last moved — plus `rev`, so a
 * body write counts as the change it is even before the summary's timestamp catches up. It is the joined field
 * list rather than a hash, so a version that repeats is a library that has not moved. What it costs is one pass
 * over small values and a sort — the 20,000-row case in `./note-index-cache.test.ts` prints it at about 20 ms
 * against about 150 ms for the rebuild it prevents, on this machine — and what it saves is that rebuild on every
 * run after the first. A page that already keeps a counter for its own reasons can hand that instead and pay
 * nothing per run, because the cache proves the rows before it leans on the key.
 *
 * `position`, the tags and the pins are absent on purpose: nothing in `context/note-index.ts` reads them, so a
 * reorder of the sidebar would rebuild 20,000 rows for an index that cannot tell the difference.
 */
export function libraryVersion(rows: LibraryRows): string {
  const parts: string[] = []
  for (const note of rows.notes) {
    parts.push(`n\u0000${note.id}\u0000${note.title}\u0000${note.folderId ?? ''}\u0000${note.rev}\u0000${note.createdAt}\u0000${note.updatedAt}\u0000${note.deletedAt ?? ''}`)
  }
  for (const folder of rows.folders) {
    parts.push(`f\u0000${folder.id}\u0000${folder.name}\u0000${folder.parentId ?? ''}\u0000${folder.updatedAt}`)
  }
  for (const template of rows.templates) {
    parts.push(`t\u0000${template.id}\u0000${template.name}\u0000${template.createdAt}\u0000${template.updatedAt}`)
  }
  parts.sort()
  return parts.join('\u0001')
}

/** Every row a set of index rows carries, counted: the cheapest bound a stored library can violate. */
function entryCount(rows: NoteIndexInput): number {
  return rows.notes.length + (rows.templates?.length ?? 0)
}

/** Every row the run carries, keyed by id: the row set a cached library has to be inside of. */
function rowMapOf(rows: NoteIndexInput): Map<string, NoteIndexEntry> {
  const byId = new Map<string, NoteIndexEntry>()
  for (const entry of rows.notes) byId.set(entry.id, entry)
  for (const entry of rows.templates ?? []) byId.set(entry.id, entry)
  return byId
}

/**
 * The tree an index was built inside of, as one small string.
 *
 * Folder rows are the few hundred entries a note's path is assembled from, so naming them costs almost
 * nothing per run and catches the change the note rows alone cannot: a renamed folder whose notes the page
 * has not re-projected yet still describes a different tree.
 */
function folderKeyOf(rows: NoteIndexInput): string {
  const parts: string[] = []
  for (const folder of rows.folders) parts.push(`${folder.id}\u0000${folder.name}\u0000${folder.parentId ?? ''}\u0000${folder.path}`)
  return parts.join('\u0001')
}

/** One row as the index that holds it saw it. */
function sameRow(a: NoteIndexEntry, b: NoteIndexEntry): boolean {
  return a.title === b.title && a.folderId === b.folderId && a.path === b.path && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt
}

/**
 * Whether a stored library may answer for this run, and the rows it has to carry beside it.
 *
 * One pass over the run's rows does both halves, because a hit is supposed to cost that walk and nothing
 * else. A row the library does not hold is a projection to add: the note created one frame before the run
 * started, the template lifted straight out of the gallery — and it has to be reachable, or
 * `tp.file.exists(tp.file.path(true))` answers false for the very note the template is writing. A row the run
 * names as its own *and* the library carries is the projection the library holds too, which the base dropped
 * when it was stored and this run puts back, at the value this run carries it — a note renamed between two
 * runs of one version still resolves to the title the run was started with.
 *
 * Everything else is the proof, and it is the reason a version is a way of *finding* a library rather than a
 * reason to believe one: a row the library holds differently than the run does, or holds at all when the run
 * was never told about it, means the library is not this run's library and the answer is a rebuild. The second
 * is counted rather than searched for, since every row id is unique on both sides and a run's own projections
 * are allowed to be missing from the library.
 *
 * `prove` is what a cached library has to pass. A library built from this run's own rows cannot fail it, and
 * skipping the comparisons there keeps the first run of a library as cheap as the last one.
 */
function overlayOf(known: StoredIndex, rows: NoteIndexInput, wanted: ReadonlySet<string> | null, folders: string, prove: true): NoteIndexEntry[] | null
function overlayOf(known: StoredIndex, rows: NoteIndexInput, wanted: ReadonlySet<string> | null, folders: string, prove: false): NoteIndexEntry[]
function overlayOf(
  known: StoredIndex,
  rows: NoteIndexInput,
  wanted: ReadonlySet<string> | null,
  folders: string,
  prove: boolean,
): NoteIndexEntry[] | null {
  if (prove && (known.folderKey !== folders || known.rows.size > entryCount(rows))) return null
  const overlay: NoteIndexEntry[] = []
  let matched = 0
  const consider = (entry: NoteIndexEntry): boolean => {
    const projected = wanted !== null && wanted.has(entry.id)
    const held = known.rows.get(entry.id)
    if (held === undefined) {
      overlay.push(entry)
      return true
    }
    matched += 1
    if (projected) {
      overlay.push(entry)
      return true
    }
    return !prove || sameRow(held, entry)
  }
  for (const entry of rows.notes) {
    if (!consider(entry)) return null
  }
  for (const entry of rows.templates ?? []) {
    if (!consider(entry)) return null
  }
  return prove && matched !== known.rows.size ? null : overlay
}

/** The library as this run sees it: its own rows, with the rows it is about taken out. */
function baseRowsOf(rows: NoteIndexInput, projections: readonly string[]): NoteIndexInput {
  if (projections.length === 0) return rows
  const wanted = new Set(projections)
  return {
    notes: rows.notes.filter((entry) => !wanted.has(entry.id)),
    templates: (rows.templates ?? []).filter((entry) => !wanted.has(entry.id)),
    folders: rows.folders,
  }
}

/** Which table a row came from: the templates folder is the id no real folder can have. */
function kindRank(entry: NoteIndexEntry): number {
  return entry.folderId === TEMPLATES_FOLDER_ID ? 1 : 0
}

/**
 * Both halves' rows for one path, in the order `context/note-index.ts` would give them.
 *
 * A path resolution compares candidates by folder proximity first, and every row behind one path is in one
 * folder by definition, so the tie that a merged build would reach is always broken further down the list:
 * notes before templates, then earliest created, then lowest id.
 */
function mergeResolution(library: NoteIndexEntry[], run: PathResolution): PathResolution {
  const matches = [...run.matches, ...library].sort((a, b) => {
    const kind = kindRank(a) - kindRank(b)
    if (kind !== 0) return kind
    const created = a.createdAt - b.createdAt
    if (created !== 0) return created
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return {
    path: run.path,
    entry: matches.length > 0 ? matches[0]! : null,
    matches,
    ambiguous: matches.length > 1,
  }
}

/**
 * One run's index: the cached library, with the rows that run carries beside it and nothing else.
 *
 * The two halves stay apart because joining them is the rebuild this card exists to remove, so every lookup
 * answers from both the way one index over all the rows would: paths merge their candidates and keep a
 * collision ambiguous, which is the difference between answering `note-conflict` and quietly picking a note
 * the template never named. `note.read` and `note.write` take the store by row id either way, so no body
 * comes from an index that holds none.
 */
function composeRunIndex(base: NoteIndex, extra: NoteIndex, extraIds: ReadonlySet<string>): NoteIndex {
  /** A row the run carries beside the library is answered from the run's copy, never from both. */
  const visible = (list: NoteIndexEntry[]): NoteIndexEntry[] => list.filter((item) => !extraIds.has(item.id))

  function resolveEverywhere(path: string): PathResolution {
    const run = extra.resolvePath(path)
    if (run.matches.length === 0) return base.resolvePath(path)
    return mergeResolution(visible(base.resolvePath(path).matches), run)
  }
  return {
    // Read on demand, not joined at the seam: nothing in the page host asks a run's index for its row list,
    // and copying 20,000 entries per run to answer a question nobody asks is the cost this card removes.
    get entries() {
      return [...visible(base.entries), ...extra.entries]
    },
    folders: extra.folders,
    allNotes: () => [...visible(base.allNotes()), ...extra.allNotes()],
    allTemplates: () => [...visible(base.allTemplates()), ...extra.allTemplates()],
    getById: (id) => extra.getById(id) ?? base.getById(id),
    // A folder is a library row: a run projects notes and templates onto the library, never a folder, so the
    // base and the run's rows cannot disagree about a place in the tree.
    getFolderById: (id) => base.getFolderById(id),
    getFolderByPath: (path) => base.getFolderByPath(path),
    getTemplateByName: (name) => extra.getTemplateByName(name) ?? base.getTemplateByName(name),
    resolvePath: resolveEverywhere,
    getByPath: (path) => resolveEverywhere(path).entry,
    existsPath: (path) => resolveEverywhere(path).entry !== null,
    // A link text is matched against the whole library, so the library's answer wins. That a run's own note
    // can also be found by title rather than only by path is the one thing the split gives up, and the page
    // host resolves paths — `note.read`, `note.exists`, `note.renderInclude`, `createTarget` and every write.
    findByLinkpath: (linkpath, sourcePath) => base.findByLinkpath(linkpath, sourcePath) ?? extra.findByLinkpath(linkpath, sourcePath),
    resolveWikiLink: (text, sourcePath) => base.resolveWikiLink(text, sourcePath) ?? extra.resolveWikiLink(text, sourcePath),
    ambiguities: () => [...base.ambiguities(), ...extra.ambiguities()],
    unresolvedFolderIds: () => [...base.unresolvedFolderIds(), ...extra.unresolvedFolderIds()],
  }
}

/**
 * The rows one run resolves against, off the context it was started with.
 *
 * Which rows are the library's templates and which are notes reads off the entry itself — a template's
 * folder is the id no real folder can have — the same rule `context/snapshot.ts`'s `noteIndexFor` splits by,
 * so a host and a snapshot describe one library the same way.
 */
export function runIndexRows(context: TemplateRunContext): NoteIndexInput {
  const notes: NoteIndexEntry[] = []
  const templates: NoteIndexEntry[] = []
  for (const entry of context.index) {
    if (entry.folderId === TEMPLATES_FOLDER_ID) templates.push(entry)
    else notes.push(entry)
  }
  return { notes, templates, folders: context.folders }
}

/**
 * The ids the run is about: its target, its active note, the template it applies.
 *
 * These are the rows `buildRunSnapshot` projects onto the library it was handed, so they are the whole
 * difference between two runs of a library that has not moved — which is why naming them lets the cache keep
 * one index for the library and give every run back its own.
 */
export function runProjectionIds(context: TemplateRunContext): string[] {
  const ids: string[] = []
  if (context.target !== null) ids.push(context.target.id)
  if (context.active !== null) ids.push(context.active.id)
  if (context.template !== null) ids.push(context.template.id)
  return ids
}

export function createNoteIndexCache(options: NoteIndexCacheOptions = {}): NoteIndexCache {
  const build = options.build ?? buildNoteIndex
  const maxTracked = options.maxTracked ?? MAX_TRACKED_INDEXES
  const supplied = options.version
  const stored = new Map<string, StoredIndex>()
  let built = 0

  function remember(key: string, rows: NoteIndexInput): StoredIndex {
    const entry: StoredIndex = { index: build(rows), rows: rowMapOf(rows), folderKey: folderKeyOf(rows) }
    built += 1
    if (maxTracked <= 0) return entry
    // A version whose stored library the run's rows no longer agree with is replaced, not kept beside it: one
    // version is one library, and the answer that no longer fits is the one nobody will ask for again.
    stored.set(key, entry)
    while (stored.size > maxTracked) {
      const oldest = stored.keys().next()
      if (oldest.done === true) break
      stored.delete(oldest.value)
    }
    return entry
  }

  /** Recency, not freshness: the map's order is the eviction order, so a library in use moves to the back. */
  function touch(key: string, entry: StoredIndex): void {
    if (maxTracked <= 0) return
    stored.delete(key)
    stored.set(key, entry)
  }

  /**
   * The first stored library this run is inside of, with the rows it carries beside it.
   *
   * The entry the run's version names is tried first, since that is the case that costs one proof instead of
   * four. When it is absent — or holds a row the run was never told about, which is a version that moved
   * without the library arriving — the few other indexes still held are tried before paying for a library
   * again: an older library inside this run's rows is a smaller base and a longer overlay, and both are
   * cheaper than indexing 20,000 rows a second time.
   */
  function fitToRun(rows: NoteIndexInput, wanted: ReadonlySet<string> | null, folders: string, key: string): FittingLibrary | null {
    const exact = stored.get(key)
    if (exact !== undefined) {
      const overlay = overlayOf(exact, rows, wanted, folders, true)
      if (overlay !== null) return { entry: exact, key, overlay }
    }
    if (maxTracked <= 0) return null
    for (const [candidate, entry] of stored) {
      if (candidate === key) continue
      const overlay = overlayOf(entry, rows, wanted, folders, true)
      if (overlay !== null) return { entry, key: candidate, overlay }
    }
    return null
  }

  /** The run's index: the library it was answered from, plus the rows it carries beside it in one small index. */
  function derive(known: StoredIndex, rows: NoteIndexInput, overlay: NoteIndexEntry[]): NoteIndex {
    if (overlay.length === 0) return known.index
    // The rows a run adds go through the real builder, with the run's own folder rows, so a candidate's table
    // and proximity are what a single index over every row would have reported.
    const addedNotes: NoteIndexEntry[] = []
    const addedTemplates: NoteIndexEntry[] = []
    for (const item of overlay) {
      if (item.folderId === TEMPLATES_FOLDER_ID) addedTemplates.push(item)
      else addedNotes.push(item)
    }
    const extra = buildNoteIndex({ notes: addedNotes, templates: addedTemplates, folders: rows.folders })
    return composeRunIndex(known.index, extra, new Set(overlay.map((item) => item.id)))
  }

  function indexFor(rows: NoteIndexInput, projections: readonly string[] = []): NoteIndex {
    const wanted = projections.length === 0 ? null : new Set(projections)
    // A version the page names is the fast path: it says which library the rows came from, so a run's rows are
    // walked once. With none, the rows are the only thing that can name a library, and the key comes off the
    // fields an index entry is built from, read without the run's projections — those are the rows two runs of
    // one library are allowed to differ by, and leaving them out is what lets the runs share one index.
    const named = supplied?.() ?? null
    const key = named ?? fingerprint(baseRowsOf(rows, projections))
    const fitted = fitToRun(rows, wanted, folderKeyOf(rows), key)
    if (fitted !== null) {
      touch(fitted.key, fitted.entry)
      return derive(fitted.entry, rows, fitted.overlay)
    }
    const base = baseRowsOf(rows, projections)
    const built = remember(key, base)
    // A library built from this run's own rows fits them by construction, so the walk does not compare twice.
    return derive(built, rows, overlayOf(built, rows, wanted, folderKeyOf(rows), false))
  }

  return {
    indexFor,
    builds: () => built,
    sizes: () => [...stored.values()].map((entry) => entry.rows.size),
  }
}
