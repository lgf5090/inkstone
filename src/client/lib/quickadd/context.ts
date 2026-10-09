/**
 * The seams a choice run needs from the rest of the app, as plain interfaces.
 *
 * The engines are written against these rather than against the note store, the router or the editor
 * directly: that is what lets a capture into a heading be tested with a two-line note and a fake
 * write, and what keeps a bad format from ever reaching a write. The app-backed implementation lives
 * in `runner.ts`.
 */
import type { QuickAddChoice, QuickAddLinkPlacement, QuickAddOpenLayout, QuickAddOpenPane, QuickAddSettings } from '@shared/quickadd'

export interface NoteRef {
  id: string
  title: string
  /** Slash path of the note's folder, or null for the library root. */
  folderPath: string | null
}

export interface NewNoteInput {
  title: string
  content: string
  folderPath: string | null
  tags?: string[]
  cursor?: number | null
}

/** One row of the "which template?" picker: what to run, and what to call it on screen. */
export interface TemplatePickOption {
  id: string
  name: string
  category: string | null
}

export interface NotePort {
  /** The note the reader is looking at, or null when the editor is on nothing. */
  activeNote(): NoteRef | null
  /** Find by title, case- and path-insensitively the way a wikilink resolves. */
  findByTitle(title: string): NoteRef | null
  /** Current text of a note, read from wherever the app keeps it fresh. */
  read(id: string): Promise<string>
  /**
   * Replace a note's text. `previous` is the text the caller computed its answer from: when the note
   * holds something else by the time the write lands, the write is refused rather than eat the
   * reader's typing. False means nothing was written.
   */
  write(id: string, content: string, previous?: string): Promise<boolean>
  /** Create a note. Null when the app refused it. */
  create(input: NewNoteInput): Promise<NoteRef | null>
  /** The folder for a slash path, created on the way if it does not exist. */
  ensureFolder(path: string | null): Promise<string | null>
  /**
   * Bring a note on screen. Which pane it lands in, how that pane renders it and whether the reader's
   * focus moves there are the run's choice, not the app's: a note captured by a startup macro should not
   * interrupt what the reader is doing.
   */
  open(id: string, options?: QuickAddOpenOptions): Promise<void>
  byId(id: string): NoteRef | null
  /** Every title the account has, for a name prompt that should not invent a duplicate. */
  knownNoteTitles(): string[]
  /** Every folder path the account has, for `folderMode: ask`. */
  knownFolderPaths(): string[]
  /**
   * Write the link back to `target` into `source`, where the choice said. False means it was not written,
   * which the run says out loud rather than letting the reader believe the two notes are connected.
   */
  appendLink(source: NoteRef, target: NoteRef, options?: QuickAddLinkOptions): Promise<boolean>
  /** Put text on the clipboard. */
  copyText(text: string): void
  /** Move the editor caret after a write that was not made through the editor. */
  placeCursor(offset: number): void
  /** Say that this choice ran, so the launcher can offer it first next time. */
  recordRun(id: string): void
  /** Text the reader can paste or click to reach a note, from an optional source note. */
  linkTo(target: NoteRef, from?: NoteRef | null): string
  /** The heading the caret sits under in the open editor, as a wikilink subpath, or null. */
  cursorHeadingPath(): string | null
  /** Selected editor text. */
  selection(): string
  /** Clipboard text, or '' when the browser will not hand it over. */
  clipboard(): Promise<string>
  /** Body text of a library template by id or name. */
  templateBody(name: string): Promise<string | null>
  /** Every template name in the library, for a choice that asks which one to use. */
  templateNames(): string[]
  /**
   * The templates a "ask which one" choice offers: everything, or only what sits in one library
   * category. The id is the answer, so two templates called the same thing stay distinguishable.
   */
  templatesForPick(categoryId: string | null): TemplatePickOption[]
  /**
   * Run one of the app's own commands by id, the way the palette entry does. False when the id is
   * unknown or not offered right now, so the step can say so instead of looking like it worked.
   */
  runAppCommand(id: string): boolean
  /** A property name to value list, collected from the account's other notes. */
  fieldValues(name: string, filter: FieldValueFilter): Promise<string[]>
  /** Note titles inside a folder, for `{{FILE:folder}}`. */
  pickFileTitles(token: { folder: string; types: string[]; mode: 'name' | 'path' | 'link' }): Promise<string[]>
  /** A short user-visible notice. */
  notify(title: string, description?: string, tone?: 'default' | 'danger' | 'warning'): void
  /**
   * The open editor's own text and selection, or null when the note is not on screen. A template that
   * carries its own properties needs this: the text it merges into is what the reader is looking at,
   * unsaved typing included, and the block must not land inside the note's own properties.
   */
  activeEditorState(): { text: string; from: number; to: number } | null
  /** Insert text into the open editor at the caret, replacing the selection. */
  insertAtCursor(text: string, cursorOffset?: number | null): boolean
  /**
   * Insert text on a new line above or below the caret's own line. False when the caret is not on
   * screen — the same promise `insertAtCursor` makes.
   */
  insertRelativeToLine(text: string, side: 'above' | 'below', cursorOffset?: number | null): boolean
  /** Prepend text to the open note's body, below its properties. */
  prependToActive(text: string): Promise<boolean>
  settings(): QuickAddSettings
  choices(): QuickAddChoice[]
}

export interface QuickAddLinkOptions {
  placement?: 'noteEnd' | 'lineEnd' | 'property'
  property?: string
  embed?: boolean
}

export interface QuickAddOpenOptions {
  pane?: 'active' | 'other'
  layout?: 'inherit' | 'live' | 'split' | 'preview'
  focus?: boolean
}

/**
 * The three opening fields as one request, with whatever the choice does not say left out so the app
 * keeps deciding it. `focus` is the one exception: a run that opens a note takes the caret with it, and
 * that is what the switch has always meant.
 */
/** Where the backlink goes, with this app's own defaults for a choice that predates the fields. */
export function linkOptions(choice: {
  linkPlacement?: QuickAddLinkPlacement
  linkProperty?: string
  linkEmbed?: boolean
}): Required<QuickAddLinkOptions> {
  return {
    placement: choice.linkPlacement ?? 'noteEnd',
    property: choice.linkProperty?.trim() || 'source',
    embed: choice.linkEmbed === true,
  }
}

export function openingOptions(choice: {
  openPane?: QuickAddOpenPane
  openLayout?: QuickAddOpenLayout
  openFocus?: boolean
}): QuickAddOpenOptions {
  const options: QuickAddOpenOptions = {}
  if (choice.openPane) options.pane = choice.openPane
  if (choice.openLayout) options.layout = choice.openLayout
  if (choice.openFocus !== undefined) options.focus = choice.openFocus
  return options
}

export interface FieldValueFilter {
  folder: string | null
  tag: string | null
  excludeTag: string | null
}

export type QuickAddRunStatus =
  /** The run wrote something. */
  | { kind: 'written'; noteId: string; created: boolean; summary: string }
  /** The run wrote nothing because there was nothing to write. */
  | { kind: 'empty'; noteId?: string }
  /** The reader cancelled a prompt, or a required answer was missing. */
  | { kind: 'cancelled'; reason?: string }
  /** The run could not go ahead, and said why. */
  | { kind: 'failed'; reason: string }

export function folderJoin(...parts: (string | null | undefined)[]): string {
  const kept: string[] = []
  for (const part of parts) {
    for (const segment of (part ?? '').split(/[\\/]/)) {
      const trimmed = segment.trim()
      if (trimmed && trimmed !== '.') kept.push(trimmed)
    }
  }
  return kept.join('/')
}

/** Strip what a title cannot carry, the way the app's own new-note flow does. */
export function sanitizeTitle(value: string, fallback: string): string {
  const cleaned = value.replace(/[\r\n]+/g, ' ').replace(/[\\/]/g, '·').trim()
  return (cleaned || fallback).slice(0, 200)
}

/**
 * The folder a run writes into when the name itself named one: `Journal/2026` under a choice already
 * pointed at `Journal` is one folder, not `Journal/Journal`, and a deeper route hangs off the choice’s
 * folder rather than replacing it.
 */
export function joinRouted(path: string | null, routedFolder: string | null): string | null {
  if (!routedFolder) return path
  if (!path) return routedFolder
  const below = routedFolder.toLowerCase()
  const above = path.toLowerCase()
  if (below === above) return path
  if (below.startsWith(`${above}/`)) return routedFolder
  if (above.endsWith(`/${below}`)) return path
  return folderJoin(path, routedFolder)
}

/** `Inbox`, `Journal/2026-10-08` or `Daily/2026/W12`: the last segment is the title. */
export function splitTargetPath(value: string): { title: string; folder: string | null } {
  const cleaned = value.replace(/[\\]/g, '/').replace(/\/+/g, '/').trim().replace(/\uFF0E/g, '.')
  const segments = cleaned.split('/').filter((segment) => segment !== '')
  const title = segments.length > 0 ? (segments[segments.length - 1] ?? '') : ''
  const folder = segments.length > 1 ? segments.slice(0, -1).join('/') : null
  return { title: title.trim(), folder: folder ? folderJoin(folder) : null }
}
