/**
 * The page host's seams, wired to the app's real data layer.
 *
 * `./page-host.ts` decides what a template is allowed to do and what a refusal means; this file is the part
 * that knows where a note actually lives — the zustand note store, its IndexedDB-backed write queue, and the
 * API the store itself talks to. It is kept apart for the reason the host takes ports at all: the policy is
 * testable with a two-note fake, and the product's storage is only reached from one place, so the choices
 * about drafts, revisions and panes can be read and audited in one file.
 *
 * Three rules decided here rather than in the host, because they are properties of this app's storage:
 *
 * - **a note on screen is written through the store.** `editContent` and `editTitle` are the same entry
 *   points the editor's own keystrokes use, so the pane, the autosave, the other split and the undo history
 *   all see the change. Patching the row through the API instead would leave the reader looking at a buffer
 *   that then overwrites what the template wrote.
 * - **a note nobody is looking at is rewritten through `editRemoteContent`.** That is the store's own entry
 *   point for this exact job (`store/notes.ts`), and it is the one that flushes a queued draft before it
 *   patches and reads the server copy inside the same queued write — which is what makes the guard below a
 *   comparison against text that is really current.
 * - **the revision a write is guarded by is the one the host read.** Nothing here patches against a revision
 *   it has not seen; a 409 from the route is `conflict`, a 404 is `not-found`, and any other failure is left
 *   to throw, because the host's answer for a throw is a code and a console line rather than a guess.
 */
import type { Folder, Note, PatchNoteBody } from '@shared/types'
import { api, ApiError } from '../../../lib/api'
import { findNoteByTitle, noteById, useNotes } from '../../../store/notes'
import { useUi } from '../../../store/ui'
import { useNoteTemplates } from '../../../store/note-templates'
import { syncTitleIntoFrontMatter } from '../../../store/new-note'
import { getActiveEditorView, insertText } from '../../../editor/commands'
import type { PageHostChanges, PageHostDeps, PageHostWrite } from './page-host'

/** Whether a pane is holding this note, which is the difference between a buffer and a row. */
function onScreen(id: string): boolean {
  const ui = useUi.getState()
  return ui.activeNoteId === id || ui.workspacePrimaryNoteId === id || ui.workspaceSecondaryNoteId === id
}

/**
 * The row a write produced.
 *
 * The store keeps the body and the summary apart, so a `Note` is assembled from both; `''` for a body the
 * cache has never held is the same reading the store gives a note whose text is not loaded yet.
 */
function rowOf(id: string, content: string): Note | null {
  const summary = noteById(id)
  return summary === undefined ? null : { ...summary, content }
}

function written(note: Note): PageHostWrite {
  return { ok: true, note }
}

/**
 * The answer for a note the page cannot show: the route's 404.
 *
 * A note in the trash and a note the account never had are the same thing to a template — the path leads
 * nowhere — and the app's own route answers both that way.
 */
function gone(): PageHostWrite {
  return { ok: false, reason: 'not-found' }
}

/** A race the reader won, or a refusal this layer cannot name; the host turns each into its own code. */
function refused(reason: 'conflict' | 'failed'): PageHostWrite {
  return { ok: false, reason }
}

/** Map the route's own refusal onto the three answers the host can name. */
function fromApiError(error: unknown): PageHostWrite | null {
  if (error instanceof ApiError && error.status === 404) return gone()
  if (error instanceof ApiError && error.isConflict) return refused('conflict')
  return null
}

/**
 * The body of a note, from wherever it is current.
 *
 * An open pane is the only place unsaved keystrokes live, so it is read first. For every other note the
 * cached copy can be the text a previous run wrote before it was saved, so the server is asked — which is
 * also what makes the guard a write takes a comparison against the text the note really holds. An offline
 * read answers from the cache, because that is what this app promises while the network is gone, and the
 * guarded write that follows refuses rather than clobbers when the two copies turn out to differ.
 */
async function readBody(id: string): Promise<Note | null> {
  const state = useNotes.getState()
  const summary = state.notes[id]
  if (summary && summary.deletedAt === null && onScreen(id)) {
    const buffer = state.contents[id]
    if (typeof buffer === 'string') return { ...summary, content: buffer }
  }
  try {
    return await api.notes.get(id)
  }
  catch (error) {
    // A note that is gone is an answer; anything else is this layer's failure to know, and it travels up as
    // a throw so the host reports it as one rather than as an empty note.
    if (error instanceof ApiError && error.status === 404) return null
    if (error instanceof ApiError && error.isOffline && summary) {
      return { ...summary, content: state.contents[id] ?? '' }
    }
    throw error
  }
}

async function writeBody(id: string, content: string, expected: Note): Promise<PageHostWrite> {
  const buffer = useNotes.getState().contents[id]
  if (onScreen(id) && typeof buffer === 'string') {
    // The reader may have typed since the host read the note; that is the race, and the buffer wins.
    if (buffer !== expected.content) return refused('conflict')
    useNotes.getState().editContent(id, content)
    await useNotes.getState().flush({ immediate: true })
    if (useNotes.getState().contents[id] !== content) return refused('failed')
    const row = rowOf(id, content)
    return row ? written(row) : refused('failed')
  }
  // `null` from the transform is the store's own refusal, and it is reached only when the text the server
  // holds is not the text the host read: the same race, seen from the side that can actually compare it.
  const outcome = await useNotes.getState().editRemoteContent(id, (current) => current === expected.content ? content : null)
  if (outcome === 'written') {
    const row = rowOf(id, content)
    return row ? written(row) : refused('failed')
  }
  if (outcome === 'conflict') return refused('conflict')
  // `missing` covers both a read that failed and a patch that did, and the store keeps them together. A note
  // that vanished between the host's read and this call is rare; a refusal that could not be sure would be
  // worse, so the answer stays honest about not knowing.
  return refused('failed')
}

async function updateRow(id: string, changes: PageHostChanges, expected: Note): Promise<PageHostWrite> {
  const buffer = useNotes.getState().contents[id]
  if (onScreen(id) && typeof buffer === 'string') {
    // A rename on screen goes through `editTitle`, which keeps the front matter's `title:` property in step
    // with the row — the same rule the editor applies, and the one an API patch would leave behind.
    if (changes.title !== undefined) useNotes.getState().editTitle(id, changes.title)
    if (changes.folderId !== undefined) await useNotes.getState().patchNote(id, { folderId: changes.folderId })
    await useNotes.getState().flush({ immediate: true })
    const after = noteById(id)
    if (after === undefined) return gone()
    if (changes.title !== undefined && after.title !== changes.title) return refused('failed')
    if (changes.folderId !== undefined && after.folderId !== changes.folderId) return refused('failed')
    // `editTitle` rewrote the body's `title:` property into the buffer, so the row the host gets back carries
    // the text the note is now, not the text it was before the rename.
    return written({ ...after, content: useNotes.getState().contents[id] ?? buffer })
  }
  const body: PatchNoteBody = {
    rev: expected.rev,
    ...(changes.title !== undefined ? { title: changes.title } : {}),
    ...(changes.folderId !== undefined ? { folderId: changes.folderId } : {}),
  }
  if (changes.title !== undefined) {
    // The note's own properties carry its title when the reader put one there; a row renamed without them
    // reads as the old name the next time the note is opened.
    const synced = syncTitleIntoFrontMatter(expected.content, changes.title)
    if (synced !== null && synced !== expected.content) body.content = synced
  }
  try {
    const saved = await api.notes.patch(id, body)
    // The row is the store's cache too: without a pull the sidebar keeps showing the name the note no longer
    // has, and the next template run would resolve the old path to a note that is not there.
    await useNotes.getState().pull({ force: true })
    return written(saved)
  }
  catch (error) {
    const mapped = fromApiError(error)
    if (mapped) return mapped
    throw error
  }
}

async function createRow(input: { title: string; content: string; folderId: string | null }): Promise<PageHostWrite> {
  // `open: false`: a template that creates five notes must not leave the reader in the last one. The page's
  // create-from-template path opens what the reader asked for, through the editor host.
  const id = await useNotes.getState().createNote({ ...input, open: false })
  if (id === null) {
    // The store has already told the reader why it refused. The one reason this layer can still name is the
    // one the host's own path check could not see: a row that appeared at that title while the call ran.
    const claimant = findNoteByTitle(input.title)
    return refused(claimant !== undefined && claimant.folderId === input.folderId ? 'conflict' : 'failed')
  }
  const row = rowOf(id, input.content)
  if (row === null) return refused('failed')
  if (input.folderId === null && row.folderId !== null) {
    // `createNote` reads `folderId` with `??`, so an explicit root is answered with whichever folder the
    // reader happens to be browsing. A template that named a root path means the root, so the row is
    // corrected — one extra patch on a note nobody is looking at yet.
    await useNotes.getState().patchNote(id, { folderId: null })
    const moved = noteById(id)
    if (moved === undefined || moved.folderId !== null) return refused('failed')
    return written({ ...moved, content: input.content })
  }
  if (row.folderId !== input.folderId) return refused('failed')
  return written(row)
}

async function removeRow(id: string): Promise<PageHostWrite> {
  const before = noteById(id)
  if (before === undefined) {
    // A note the page has never loaded cannot be trashed through the store, whose entry points all begin
    // from its own list. The route is the only honest door, and its 404 is the same answer either way.
    try {
      return written(await api.notes.remove(id))
    }
    catch (error) {
      const mapped = fromApiError(error)
      if (mapped) return mapped
      throw error
    }
  }
  const content = useNotes.getState().contents[id] ?? ''
  // `deleteNote` is the app's own path: it flushes a queued draft first, drops the note from the panes that
  // hold it, and offers the undo the reader expects from a deletion they did not press Delete on.
  await useNotes.getState().deleteNote(id)
  const after = noteById(id)
  if (after === undefined) return gone()
  if (after.deletedAt === null) return refused('failed')
  return written({ ...after, content })
}

/**
 * The note in front of the reader, or `false` when the app cannot show it.
 *
 * `openNote` is the store's own entry point — the one the list, the backlinks panel and the recovery toast
 * use — so an opened note arrives with its pane, its revalidation and its mobile reveal intact. The answer
 * is measured after the call rather than assumed: upstream's `create_new(…, true)` only ever fails for
 * want of a leaf (`Templater.ts:229-234`) and logs it; this reports whether a pane is really on the note,
 * which is the difference between "opened" and "asked".
 */
async function openInEditor(id: string): Promise<boolean> {
  const summary = noteById(id)
  if (summary === undefined || summary.deletedAt !== null) return false
  await useNotes.getState().openNote(id)
  const ui = useUi.getState()
  return ui.activeNoteId === id || ui.workspacePrimaryNoteId === id || ui.workspaceSecondaryNoteId === id
}

/**
 * Text at the active editor's selection, in one undoable transaction.
 *
 * The same door the emoji picker uses (`features/emoji/insert-emoji.ts`): the view the editor names when
 * it mounts, and `insertText`, which dispatches a real CodeMirror transaction that replaces the selection
 * and leaves the caret after the text — upstream's `doc.replaceSelection(content)` and the same undo
 * contract the template insert already keeps. A preview pane, an inert board or no editor at all answers
 * `false`; nothing is dropped into a buffer nobody is looking at.
 */
function appendAtEditorCursor(text: string): boolean {
  const view = getActiveEditorView()
  if (view === null || !view.dom.isConnected || view.dom.closest('[inert]') !== null) return false
  insertText(text)(view)
  view.focus()
  return true
}

/**
 * The store and the editor, as the host's ports.
 *
 * One object, handed to `createPageHost` beside the prompt host and the web host. Folder creation is the
 * store's synchronous optimistic call, whose id is returned before the route answers — which is what lets a
 * template create a folder and file into it in the same run while the row is still in flight.
 *
 * The nested half is **passed in rather than imported**: starting a child run means calling the module's own
 * door (`renderTemplate`/`cancelTemplateRun`), and a module under `host/` that imports the door would make
 * the door import this file right back — the cycle that only shows up as an `undefined` function at the
 * first nested `include`. `tests/templater-protocol-purity.test.ts` forbids it, and the wiring hands both
 * functions over here instead.
 */
export function storePageHostPorts(nested: PageHostDeps['nested']): PageHostDeps {
  return {
    notes: {
      read: readBody,
      write: writeBody,
      update: updateRow,
      create: createRow,
      remove: removeRow,
    },
    folders: {
      list: (): Folder[] => useNotes.getState().folders,
      create: async ({ name, parentId }) => useNotes.getState().createFolder({ name, parentId }),
    },
    templates: {
      // The gallery's own rule: a name matched after trimming and case-folding, and an id accepted as well, so
      // a template that carries a row id from `tp.config.template_file` reads the same row back.
      byName: async (name) => {
        const wanted = name.trim().toLowerCase()
        const templates = useNoteTemplates.getState().templates
        return templates.find((template) => template.id === name || template.name.trim().toLowerCase() === wanted) ?? null
      },
    },
    editor: {
      open: openInEditor,
      appendAtCursor: appendAtEditorCursor,
    },
    nested,
  }
}
