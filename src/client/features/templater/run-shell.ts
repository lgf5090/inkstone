/**
 * The three Templater runs the interface can ask for, wired to this app.
 *
 * `lib/templater/host/run-template.ts` already renders a template and writes it, and it takes everything it
 * needs as data and every effect as a port. This module is the half that knows where those rows and ports
 * actually live: the door's single composed host, the note store, the editor on screen, the reader's own
 * language, and the toast that says what happened. Nothing here decides a write shape, a path rule or a
 * capability — those are the engine's, and a second copy of one is how a note gets rewritten twice.
 *
 * Three contracts this file holds to:
 *
 * - **the door is installed once, and only when a run is asked for.** The import is a dynamic one so the
 *   parser, `yaml` and the three hosts stay out of the first-screen chunk (plan P11-5), and the same
 *   `TemplaterHosts` object is kept for every run after it. `installTemplaterHost` is the only thing that
 *   answers a host call, so building a second page host would mean two run registries and two capability
 *   checks that can disagree. `templaterConfigured` is re-read each time, because `terminateTemplater`
 *   clears the door and an app that stopped its worker has to be able to start one again.
 * - **a refusal is always said, in the reader's language.** Every failure goes through `templaterErrorText`,
 *   which is the only place a code becomes a sentence, and every `plan.notices` entry is shown through
 *   `WRITE_NOTICE_MESSAGES`. A run that wrote something with a caveat has to say so, and an error token on
 *   screen would be English inside a Chinese interface.
 * - **the note the reader is looking at is the note the run reads.** The body comes from the editor that is
 *   showing it, so an unsaved keystroke is in what the template sees and in what the write is guarded
 *   against. A run with no such editor is refused here rather than answered from a stale row.
 */
import type { Note, NoteTemplate } from '@shared/types'
import type { MessageKey } from '@shared/locales/en-US'
import type { TemplaterHosts } from '../../lib/templater'
import type { CapabilityProfile, RunMode } from '../../lib/templater/protocol'
import { templaterErrorText, type TemplaterErrorCode } from '../../lib/templater/errors'
import { virtualBasename, virtualFolderSegment, virtualNoteName } from '../../lib/templater/context/file-wrapper'
import {
  runTemplateOnNote,
  type RunTemplateInput,
  type RunTemplatePorts,
  type RunTemplateResult,
} from '../../lib/templater/host/run-template'
import { WRITE_NOTICE_MESSAGES } from '../../lib/templater/host/write'
import { libraryRows } from '../../lib/templater/host/store-port'
import { confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { folderPath } from '../../lib/folders'
import { localeTag, t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { requireOpenNote, selectionOf, writableNoteEditor, type EditorSelectionSnapshot } from './editor-surface'

/** The door, reached only when a run is asked for; its module type is its own, not a second shape. */
type TemplaterDoor = typeof import('../../lib/templater')

let installed: { door: TemplaterDoor; hosts: TemplaterHosts } | null = null

/**
 * The host's ports, as the write pipeline wants them.
 *
 * They are the door's own: `installTemplaterHost` returns the same `storePageHostPorts` object it handed to
 * the page host, so a run writes through the guarded path the rest of the app uses, and `createTarget` is
 * that host's path logic rather than a re-derivation of it beside it.
 */
async function templaterPorts(): Promise<RunTemplatePorts> {
  const door = await import('../../lib/templater')
  if (installed === null || !door.templaterConfigured()) {
    installed = {
      door,
      // Read per call rather than copied at install: the host is installed once and the reader can flip the
      // web switch between two runs, and a template's `tp.web.request` must answer to the switch as it is
      // then, not as it was when the first template of the session ran.
      hosts: door.installTemplaterHost({
        webRequestsEnabled: () => useSession.getState().settings.templater.webRequestsEnabled,
      }),
    }
  }
  const hosts = installed.hosts
  return {
    render: (args) => door.renderTemplate(args),
    notes: { write: hosts.ports.notes.write, create: hosts.ports.notes.create },
    editor: { open: hosts.ports.editor.open },
    createTarget: (context, path) => hosts.page.createTarget(context, path),
    // The caret group travels on the existing insert signal: it is the only channel that still works when
    // the note's editor has not mounted yet, which is every note this run has just created.
    requestCarets: (noteId, carets) => {
      useUi.getState().requestTemplateInsert({ noteId, content: '', cursor: carets })
    },
  }
}

/** The note in front of the reader, for `tp.config.active_file`; `null` when the app is showing none. */
async function activeRow(): Promise<Note | null> {
  const id = useUi.getState().activeNoteId
  if (!id) return null
  const state = useNotes.getState()
  const summary = state.notes[id]
  if (!summary || summary.deletedAt !== null) return null
  const buffered = state.contents[id]
  if (typeof buffered === 'string') return { ...summary, content: buffered }
  try {
    return await api.notes.get(id)
  }
  catch (error) {
    // Best effort, and it stays a warning: `active` only tells a template which note the reader was looking
    // at, and a create run they asked for must not fail because that context cannot be read.
    console.warn('[templater] the active note could not be read for this run', error)
    return null
  }
}

/** What a run that writes into the open note needs before it can say what it writes. */
type ReadyTarget = { row: Note; selection: EditorSelectionSnapshot }
type TargetRefusal = 'no-note' | 'no-editor'

function readyTarget(): ReadyTarget | TargetRefusal {
  const id = requireOpenNote()
  if (id === null) return 'no-note'
  const view = writableNoteEditor(id)
  if (view === null) return 'no-editor'
  const summary = useNotes.getState().notes[id]!
  return { row: { ...summary, content: view.state.doc.toString() }, selection: selectionOf(view) }
}

/**
 * The two ways the reader can be somewhere a note run cannot go, each in the app's own words.
 *
 * Nothing is written and nothing is queued, so the note they can see is the note they left.
 */
function refuseTarget(reason: TargetRefusal): false {
  // The missing note already explained itself inside `requireOpenNote`; this is the other half.
  if (reason === 'no-note') return false
  useUi.getState().toast({ title: t('command.no_editor_to_edit'), tone: 'warning' })
  return false
}

/**
 * One run, from the rows the page holds to the toast the reader gets.
 *
 * The success line is chosen by the caller rather than read off the plan's kind, because `discard` is a
 * kind this feature never starts and a table keyed by it would be a branch no reader can reach.
 */
async function run(input: RunTemplateInput, success: MessageKey): Promise<boolean> {
  try {
    return report(await runTemplateOnNote(input, await templaterPorts()), success)
  }
  catch (error) {
    // A port that throws is this app's own data layer failing, and the pipeline lets it travel on purpose.
    // It is reported the same way as a refusal, with the original text beside the label rather than dropped.
    useUi.getState().toast({ title: templaterErrorText(error, t), tone: 'danger' })
    return false
  }
}

/** The shared tail of every run: the caveats first, because they are the half the reader cannot recover. */
function report(result: RunTemplateResult, success: MessageKey): boolean {
  const ui = useUi.getState()
  if (!result.ok) {
    // `note-conflict` arrives here too, and it is the refusal the reader's own typing survives: the plan is
    // thrown away before any write, and the caret signal is never set, so the note on screen is exactly
    // what they left. Running the command again is the whole recovery.
    ui.toast({ title: templaterErrorText(result, t), tone: 'danger' })
    return false
  }
  for (const notice of result.notices) {
    ui.toast({ title: t(WRITE_NOTICE_MESSAGES[notice.kind]), tone: 'warning' })
  }
  ui.toast({ title: t(success), tone: 'success' })
  return true
}

/** The rows every mode shares: the library, the reader's language, and the moment this run means by "now". */
function contextFor(
  mode: RunMode,
  target: Note | null,
  active: Note | null,
  selection: EditorSelectionSnapshot | null,
  profile: CapabilityProfile = 'local',
): Omit<RunTemplateInput, 'template'> {
  return {
    mode,
    target,
    active,
    ...libraryRows(),
    // Every row this chooser offers is the reader's own library entry, so the run carries the rights they
    // gave their own templates. Narrowing them by where a row came from is the engine's call, not a guess
    // made at a call site.
    capabilities: profile,
    locale: localeTag(),
    startedAt: Date.now(),
    selection,
    startedAtRev: target?.rev ?? null,
  }
}

/** Splice a rendered template into the note the reader is looking at, at their selection. */
export async function insertTemplateIntoActiveNote(template: NoteTemplate): Promise<boolean> {
  const ready = readyTarget()
  if (typeof ready === 'string') return refuseTarget(ready)
  return run(
    { ...contextFor('append-active', ready.row, ready.row, ready.selection), template: { kind: 'library', row: template } },
    'templates.inserted_into_note',
  )
}

/**
 * Replace the whole note the reader is looking at.
 *
 * The confirmation belongs to the caller ({@link confirmReplace}), because this is the one run that takes
 * the note's own properties with its body: `host/write.ts` follows upstream and does not merge, and a
 * reader who meant to add a section would otherwise lose the properties they had.
 */
export async function replaceActiveNoteWithTemplate(template: NoteTemplate): Promise<boolean> {
  const ready = readyTarget()
  if (typeof ready === 'string') return refuseTarget(ready)
  return run(
    { ...contextFor('overwrite-active', ready.row, ready.row, null), template: { kind: 'library', row: template } },
    'templater.replaced_note',
  )
}

/** Where a create run files its note, as the reader chose it. */
export interface CreateDestination {
  folderId: string | null
  /** The title the new note gets; empty means the template's own name, which is upstream's default. */
  title: string
}

/**
 * Make one new note from a template, in the folder the reader chose.
 *
 * A path is the only destination the pipeline takes, and the folder tree is the only thing that can name
 * one, so the chain is walked with the engine's own segment rules: `virtualFolderSegment` and
 * `virtualNoteName` are what `host/page-host.ts` indexes the tree with, and a path built any other way is
 * looked up against them. A hand-rolled sanitiser here is how a folder named `a/b` ends up filing the note
 * into two folders nobody asked for.
 */
export async function createNoteFromTemplate(template: NoteTemplate, destination: CreateDestination): Promise<boolean> {
  const base = virtualBasename(destination.title.trim() || template.name)
  if (base === '') return refuseName()
  const folders = useNotes.getState().folders
  const path = [...folderPath(folders, destination.folderId).map((folder) => virtualFolderSegment(folder.name)), virtualNoteName(base)].join('/')
  return run(
    {
      ...contextFor('create-new', null, await activeRow(), null),
      template: { kind: 'library', row: template },
      path,
      // The row this note is about to become cannot carry its title yet, and a run freezes the one it
      // started with — which is this name, not the template's.
      frozenTitle: base,
    },
    'templates.created_note_from_template',
  )
}

/**
 * One startup template, run for its effects and never for its text.
 *
 * The `startup` mode discards what the template produced (`host/write.ts` has no subject to write into), so
 * this answers with the run's own code instead of a toast: a batch is reported by `host/startup.ts`'s caller,
 * once per template that failed, with the name the reader gave it beside the reason. Silence on success is
 * deliberate — a note the reader did not ask to open, with a notice about it, is a worse morning than a
 * template that quietly did its work.
 */
export async function runStartupTemplate(template: NoteTemplate): Promise<{ ok: boolean; code?: TemplaterErrorCode; detail?: string }> {
  const result = await runTemplateOnNote(
    {
      ...contextFor('startup', null, await activeRow(), null, 'startup'),
      template: { kind: 'library', row: template },
    },
    await templaterPorts(),
  )
  return result.ok ? { ok: true } : { ok: false, code: result.code, detail: result.detail }
}

/** A title that is nothing a path segment can hold: the engine's own sentence, not a made-up one. */
function refuseName(): false {
  useUi.getState().toast({ title: templaterErrorText({ code: 'path-invalid', detail: '' }, t), tone: 'danger' })
  return false
}

/**
 * Ask before a template takes a whole note.
 *
 * `components/overlay.tsx`'s queue is the only dialog this app may open: it moves focus in, gives it back,
 * answers Escape and the mask, and resolves `false` when no host is mounted to show it — which is the
 * refusing answer rather than a silent one.
 */
export function confirmReplace(template: NoteTemplate): Promise<boolean> {
  return confirm({
    title: t('templater.replace.confirm_title'),
    description: t('templater.replace.confirm_body', { name: template.name }),
    confirmLabel: t('templater.cmd.replace'),
  })
}
