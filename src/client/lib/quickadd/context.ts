/**
 * The seams a choice run needs from the rest of the app, as plain interfaces.
 *
 * The engines are written against these rather than against the note store, the router or the editor
 * directly: that is what lets a capture into a heading be tested with a two-line note and a fake
 * write, and what keeps a bad format from ever reaching a write. The app-backed implementation lives
 * in `runner.ts`.
 */
import type { QuickAddChoice, QuickAddSettings } from '@shared/quickadd'

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
  /** Bring a note on screen. */
  open(id: string): Promise<void>
  byId(id: string): NoteRef | null
  /** Every title the account has, for a name prompt that should not invent a duplicate. */
  knownNoteTitles(): string[]
  /** Every folder path the account has, for `folderMode: ask`. */
  knownFolderPaths(): string[]
  /** Add a link to `target` at the end of `source`'s body. */
  appendLink(source: NoteRef, target: NoteRef): Promise<boolean>
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
  /** Insert text into the open editor at the caret, replacing the selection. */
  insertAtCursor(text: string, cursorOffset?: number | null): boolean
  /** Prepend text to the open note's body, below its properties. */
  prependToActive(text: string): Promise<boolean>
  settings(): QuickAddSettings
  choices(): QuickAddChoice[]
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
