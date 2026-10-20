/**
 * The read-only note context one template run sees, built from the rows the page already holds.
 *
 * This is a pure function of data: it takes notes, folders and library templates and returns the
 * `TemplateRunContext` the worker is started with. It imports no store, no `lib/api`, no zustand, and it
 * does not fetch anything — a run that reached the network mid-render would make `tp.file.find_tfile`
 * (synchronous, upstream) either lie or hang. The page-side glue that reads the real stores and calls
 * this is a different module's job; if this file ever needs one, that is the boundary being crossed.
 *
 * Two properties the interpreter depends on:
 *
 * - **everything is a copy.** The rows handed in are never aliased into the result, because a rename or
 *   an autosave while a template runs must not change what that run sees. The frozen title in
 *   `run-context.ts` is the one rule upstream states outright; not sharing mutable rows is the same rule
 *   applied to the rest of the context.
 * - **the three rows a run is about are always addressable.** The target, the active note and the
 *   applied template are put into the index even when the page's lists have not caught up with them — a
 *   note created one frame before the run starts, or a gallery template that is not in the reader's
 *   library. Without that, `tp.file.exists(tp.file.path(true))` would be false for the very note the
 *   template is writing.
 *
 * Path projection itself lives in `file-wrapper.ts`, and lookup in `note-index.ts`; this module only
 * walks the folder tree and assembles.
 */
import type { Folder, Note, NoteTemplate } from '@shared/types'
import type { CapabilityProfile, NoteIndexEntry, RunMode, TemplateRunContext } from '../protocol'
import {
  TEMPLATES_FOLDER_ID,
  folderIndexEntry,
  joinVirtualPath,
  noteIndexEntry,
  templateIndexEntry,
  templatesFolderEntry,
  virtualFolderSegment,
  virtualNoteName,
  virtualTemplatePath,
} from './file-wrapper'
import { buildNoteIndex, type NoteIndex } from './note-index'
import { resolveRunRules } from './run-context'

export interface RunSnapshotInput {
  runId: string
  /** Notes the reader currently has loaded, in any order; nothing here depends on that order. */
  notes: Note[]
  /** The whole folder tree those notes sit in. */
  folders: Folder[]
  /** The reader's library: the template gallery's rows, projected onto `Templates/<name>.md`. */
  templates: NoteTemplate[]
  /** The note the output belongs to; `null` when the run only produces text. */
  target: Note | null
  /** The note open in the editor, which `tp.config.active_file` reports even in create mode. */
  active: Note | null
  /** The library template being applied, or `null` for one typed into the editor. */
  template: NoteTemplate | null
  mode: RunMode
  capabilities: CapabilityProfile
  locale: string
  /** Epoch milliseconds, read once by the page so every template in the run sees the same "now". */
  startedAt: number
  /** The name a note is about to get, which is the title a create run freezes. */
  frozenTitle?: string
}

/**
 * Every folder's virtual path, keyed by id.
 *
 * Linear overall: each folder is resolved once and memoised, and a parent that is not in the list ends
 * the chain rather than looping. A cycle in `parentId` is corrupt data the server should never write;
 * the visited set is what keeps it from hanging a template run instead.
 */
export function folderPathsOf(folders: Folder[]): Map<string, string> {
  const parentOf = new Map<string, string | null>()
  const nameOf = new Map<string, string>()
  for (const folder of folders) {
    parentOf.set(folder.id, folder.parentId)
    nameOf.set(folder.id, virtualFolderSegment(folder.name))
  }

  const paths = new Map<string, string>()
  for (const folder of folders) {
    if (paths.has(folder.id)) continue
    const chain: string[] = []
    const visiting = new Set<string>()
    let cursor: string | null = folder.id
    while (cursor !== null && !paths.has(cursor) && !visiting.has(cursor)) {
      if (!nameOf.has(cursor)) break
      visiting.add(cursor)
      chain.unshift(cursor)
      cursor = parentOf.get(cursor) ?? null
    }
    let prefix = cursor !== null && paths.has(cursor) ? paths.get(cursor)! : ''
    for (const id of chain) {
      prefix = joinVirtualPath(prefix, nameOf.get(id)!)
      paths.set(id, prefix)
    }
  }
  return paths
}

/**
 * The context a run starts with.
 *
 * The result is exactly `TemplateRunContext`: serialisable, self-contained, and small enough to post to
 * a worker — the index carries no note bodies, which is what makes 20,000 notes affordable (measured in
 * `snapshot.test.ts`).
 *
 * `libraryTemplates` is the reader's own library and nothing more. A template applied straight from the
 * gallery is indexed, so `tp.file.include` can reach it, but it is not added to the reader's library
 * list, because the run context would then be writing to a store it has no part in; its content travels
 * in `template` instead.
 */
export function buildRunSnapshot(input: RunSnapshotInput): TemplateRunContext {
  const folderPaths = folderPathsOf(input.folders)
  const folderEntries = input.folders.map((folder) => folderIndexEntry(folder, folderPaths.get(folder.id) ?? ''))
  folderEntries.push(templatesFolderEntry())

  const noteEntries: NoteIndexEntry[] = []
  const indexedNoteIds = new Set<string>()
  const addNote = (note: Note): void => {
    if (indexedNoteIds.has(note.id)) return
    indexedNoteIds.add(note.id)
    // A note in a folder this page has not loaded projects to the root, and `note-index.ts` reports the
    // id as unresolved rather than pretending it is not in a folder at all.
    const folderPath = note.folderId === null ? '' : folderPaths.get(note.folderId) ?? ''
    noteEntries.push(noteIndexEntry(note, joinVirtualPath(folderPath, virtualNoteName(note.title))))
  }
  for (const note of input.notes) addNote(note)
  if (input.target) addNote(input.target)
  if (input.active) addNote(input.active)

  const templateEntries: NoteIndexEntry[] = []
  const indexedTemplateIds = new Set<string>()
  const addTemplate = (template: NoteTemplate): void => {
    if (indexedTemplateIds.has(template.id)) return
    indexedTemplateIds.add(template.id)
    templateEntries.push(templateIndexEntry(template, virtualTemplatePath(template.name)))
  }
  for (const template of input.templates) addTemplate(template)
  if (input.template) addTemplate(input.template)

  const index = buildNoteIndex({ notes: noteEntries, templates: templateEntries, folders: folderEntries })
  const rules = resolveRunRules({
    mode: input.mode,
    capabilities: input.capabilities,
    locale: input.locale,
    startedAt: input.startedAt,
    target: input.target,
    active: input.active,
    template: input.template,
    frozenTitle: input.frozenTitle,
    index,
  })

  return {
    runId: input.runId,
    mode: rules.mode,
    capabilities: rules.profile,
    template: input.template
      ? { id: input.template.id, name: input.template.name, content: input.template.content }
      : null,
    startedAt: rules.startedAt,
    target: rules.target,
    active: rules.active,
    frozenTitle: rules.frozenTitle,
    index: index.entries,
    folders: index.folders,
    libraryTemplates: copyTemplates(input.templates),
    locale: rules.locale,
  }
}

/**
 * The same index the snapshot was built over, recovered from a context.
 *
 * The host needs lookups, the context carries the entry list, and `buildNoteIndex` is pure — so the page
 * side and the host side get identical answers without shipping a second copy of the data. Which rows
 * are templates is readable off the entries, because a template's folder is the id no real folder can
 * have.
 */
export function noteIndexFor(context: TemplateRunContext): NoteIndex {
  const notes: TemplateRunContext['index'] = []
  const templates: TemplateRunContext['index'] = []
  for (const entry of context.index) {
    if (entry.folderId === TEMPLATES_FOLDER_ID) templates.push(entry)
    else notes.push(entry)
  }
  return buildNoteIndex({ notes, templates, folders: context.folders })
}

function copyTemplates(templates: NoteTemplate[]): NoteTemplate[] {
  return templates.map((template) => ({ ...template, tags: [...template.tags] }))
}
