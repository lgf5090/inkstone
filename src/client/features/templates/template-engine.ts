/**
 * Which engine a library template is handed to.
 *
 * The gallery grew up rendering `{{title}}` itself, and that path is still what an old template needs — a
 * Templater body sent through it comes back with its `<% … %>` commands left as literal text in the reader's
 * note, which is the defect this file exists to prevent. The two renderers are not interchangeable and there
 * is no migration: `detectEngine` reads the body, and the answer decides the route.
 *
 * The Templater half is imported dynamically rather than statically. The engine is a QuickJS wasm binary
 * behind a worker, and a gallery card must not be the reason a reader downloads it — `tests/templater-offline-footprint.test.ts`
 * is what notices if this indirection goes away.
 */
import { detectEngine } from '../../lib/templater/detection'
import type { NoteTemplate } from '@shared/types'

/** Whether the Templater engine, and only it, can render this body. */
export function isTemplaterTemplate(template: NoteTemplate): boolean {
  return detectEngine(template.content) === 'templater'
}

/**
 * Make one new note with the engine.
 *
 * Returns whether a note was made, which is the shape every caller here wants: the legacy path answers with
 * a note id and the engine with a boolean, and none of them can use the id — they close a dialog or say
 * nothing.
 */
export async function createNoteWithEngine(template: NoteTemplate, folderId: string | null): Promise<boolean> {
  const shell = await import('../templater/run-shell')
  // An empty title means "whatever the template's own commands produce", which is upstream's behaviour for
  // `create_new` and this app's behaviour for the picker; a caller that knows the name passes it in.
  return shell.createNoteFromTemplate(template, { folderId, title: '' })
}

/** Splice one template into the note the reader is looking at, with the engine. */
export async function insertNoteWithEngine(template: NoteTemplate): Promise<boolean> {
  const shell = await import('../templater/run-shell')
  return shell.insertTemplateIntoActiveNote(template)
}
