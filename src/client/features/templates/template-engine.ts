/**
 * The gallery's handle on the template shell, and the badge that says which syntax a body is written in.
 *
 * Two separate jobs, and the second one is why `isTemplaterTemplate` is exported at all: a card's badge and
 * the library's filters have to agree with each other, so they read one judgement rather than each carrying
 * its own copy of the pattern.
 *
 * The first job is indirection, not routing. The engine is a QuickJS wasm binary behind a worker, and pressing
 * a card must not be the reason a reader downloads it, so everything past these two functions arrives through
 * a dynamic import — `tests/templater-offline-footprint.test.ts` is what notices if that goes away. Which of
 * the two renderers a body needs is decided one level down, in `run-shell.ts`, so that a card, a chord, a
 * command and the file-creation trigger cannot give the same template four different answers.
 */
import { detectEngine } from '../../lib/templater/detection'
import type { TemplateOrigin } from '../templater/run-shell'
import type { NoteTemplate } from '@shared/types'

/** Whether this body is written in Templater's syntax — the badge, the filter, and the QuickAdd warning. */
export function isTemplaterTemplate(template: NoteTemplate): boolean {
  return bodyRunsCode(template.content)
}

/**
 * The same judgement on a body that is not a library row yet.
 *
 * A community card's text is not a `NoteTemplate` until the reader imports it, and casting one shape onto
 * another to reuse a predicate is how a field that does not exist gets read as `undefined` later.
 */
export function bodyRunsCode(content: string): boolean {
  return detectEngine(content) === 'templater'
}

/**
 * Make one new note from a library template, whichever syntax it is written in.
 *
 * Returns whether a note was made, which is the shape every caller here wants: the note's own id means nothing
 * to a panel that closes itself, and a refusal is already on screen as a toast the shell raised.
 *
 * `origin` travels all the way to the shell, which is where a row's provenance becomes a capability profile:
 * a gallery row used without importing runs read-only, whatever syntax it is written in.
 */
export async function createNoteWithEngine(template: NoteTemplate, folderId: string | null, origin: TemplateOrigin = 'library'): Promise<boolean> {
  const shell = await import('../templater/run-shell')
  // An empty title means "whatever the template's own name says", which is upstream's behaviour for
  // `create_new` and this app's behaviour for the picker; a caller that knows the name passes it in.
  return shell.createNoteFromTemplate(template, { folderId, title: '' }, origin)
}

/** Splice one library template into the note the reader is looking at. */
export async function insertNoteWithEngine(template: NoteTemplate, origin: TemplateOrigin = 'library'): Promise<boolean> {
  const shell = await import('../templater/run-shell')
  return shell.insertTemplateIntoActiveNote(template, origin)
}
