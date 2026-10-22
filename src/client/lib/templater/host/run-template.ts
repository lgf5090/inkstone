/**
 * The orchestration half: a template, a run, a plan, and the note write that follows.
 *
 * Everything this file needs exists somewhere else already — the parser and compiler in `../engine`, the
 * snapshot in `../context`, the sandbox door in `../index.ts`, the plan in `./write.ts`, the store seams in
 * `./store-port.ts` — and none of those modules knows about any of the others. This is the one place that
 * says what happens in which order, because the order *is* the product: a note created before its text is
 * rendered is an empty note a reader can open, and a plan applied without the row it was measured against is
 * a rewrite of a note they had already edited.
 *
 * Three rules, each one because the alternative costs somebody their text:
 *
 * - **a template's failure is a result, not an exception.** A parse failure, a refused render and a refused
 *   plan each come back as one code from `../errors.ts` beside the measurement that explains it, so the
 *   command palette and the save path cannot forget a `try` and take the editor down with a template
 *   somebody else wrote. A *port* that throws is the caller's own data layer failing, with nothing here able
 *   to say whether the note changed; it travels up with its stack rather than being renamed.
 * - **no store, no editor, no dialog is reached directly.** Every effect is a port, and the ports are the
 *   ones `./store-port.ts` already implements, so the app keeps exactly one guarded write path and this
 *   module is testable against a handful of fakes instead of a browser.
 * - **the subject is decided once.** `WritePlan` carries text, ranges and offsets — not the note or the path
 *   they belong to — so the caller's rows are read here, and a plan whose subject was never supplied is
 *   refused rather than applied to whatever note happens to be nearest.
 */
import type { Folder, Note, NoteTemplate } from '@shared/types'
import { buildRunSnapshot } from '../context/snapshot'
import { groupCursorMarkers } from '../engine/cursor-markers'
import { compileTemplate } from '../engine/program'
import { isTemplaterErrorCode, type TemplaterErrorCode } from '../errors'
import { DEFAULT_RUN_DEADLINE_MS } from '../limits'
import type { CapabilityProfile, RunMode, TemplateRunContext, UserScriptSource } from '../protocol'
import { createTemplateRunId } from '../run-id'
import type { PageHostDeps, PageHostFailure } from './page-host'
import { planWrite, type WriteNotice, type WritePlan, type WriteRequest } from './write'

/** What the caller supplies: the data the run reads, as the page holds it at the moment it starts. */
export interface RunTemplateInput {
  mode: RunMode
  /** The template: text the reader typed, or the library row the gallery picked. */
  template: { kind: 'source'; content: string } | { kind: 'library'; row: NoteTemplate }
  /** The note the output belongs to, with the body the caller read; `null` while a create run has none. */
  target: Note | null
  /** The note in front of the reader, which is the only one whose caret group can be shown. */
  active: Note | null
  /** The rows the run may resolve paths against, as the page holds them. */
  notes: Note[]
  folders: Folder[]
  /** The reader's library, for `tp.file.include` and the gallery's own context. */
  templates: NoteTemplate[]
  /**
   * The reader's own scripts, already read and bounded by the page (`host/user-scripts.ts`).
   *
   * Optional because most runs never touch `tp.user`, and a run whose profile does not grant the right gets
   * nothing whatever is handed over — the gate is `context/snapshot.ts`, not the caller's memory.
   */
  userScripts?: UserScriptSource[]
  /** Why the script folder could not be read at all, as the token beside `user-scripts-unavailable`. */
  userScriptsUnavailable?: string
  /** Whose rights the run has; never inferred from the template's origin here. */
  capabilities: CapabilityProfile
  locale: string
  /** Epoch milliseconds, read once so every date in the run means the same "now". */
  startedAt: number
  /** Where the selection sat in `target`, and the text it held for `tp.file.selection()`. */
  selection: { from: number; to: number; text: string } | null
  /** The revision the run was started against; a difference from the target's own is a concurrent write. */
  startedAtRev: number | null
  /** Where a `create-new` note is filed, in the app's virtual `Folder/Note.md` form. */
  path?: string
  /** The title a create run freezes, which the row it names cannot carry yet. */
  frozenTitle?: string
  /** CPU budget for the run; the engine's own default applies when the caller has no opinion. */
  deadlineMs?: number
}

/** What the caller supplies instead of importing: every effect this module is allowed to have. */
export interface RunTemplatePorts {
  /**
   * The door's render step — `renderTemplate` from `../index.ts`, handed in rather than imported.
   *
   * A module under `host/` may not import the door it is wired through (that is the cycle
   * `tests/templater-protocol-purity.test.ts` exists to catch), which is the same reason
   * `storePageHostPorts` takes the nested seam as an argument. The type is that seam's own, so the door
   * satisfies it without a second shape to keep in step.
   */
  render: PageHostDeps['nested']['render']
  /** The two entry points `./store-port.ts` implements: the guarded body write, and the create. */
  notes: Pick<PageHostDeps['notes'], 'write' | 'create'>
  /** Show a created note in the workspace: `store.openNote`, the same seam the page host opens through. */
  editor: Pick<PageHostDeps['editor'], 'open'>
  /**
   * Where the plan's path files a created note.
   *
   * The folder tree and the title rules are the data layer's, so the split is asked of it rather than
   * redone here — this module has no path logic, and a second copy of one is how a traversal gets through.
   * The run's *context* goes with the path because the page host is what owns that logic, and it resolves a
   * path against the run: the folders it already made and the rows it already wrote have to be visible. The
   * context rather than the id alone, because this is asked after the render returned and the page released
   * the run — the reader's own request to file a new note is not a call a released run may refuse.
   */
  createTarget(context: TemplateRunContext, path: string): Promise<
    | { ok: true; title: string; folderId: string | null }
    | { ok: false; code: TemplaterErrorCode; detail: string }
  >
  /**
   * Ask the workspace to put this caret group on the note once its editor is on screen.
   *
   * The existing mount-time insert signal, which is the only channel that survives a note whose editor has
   * not mounted yet. The offsets are the plan's: absolute positions in the document the write produced.
   */
  requestCarets(noteId: string, carets: number[]): void
}

/** What a run that reached its write reports back. */
export interface RunTemplateApplied {
  ok: true
  kind: WritePlan['kind']
  /**
   * The text the run produced, whatever was done with it.
   *
   * For a write it is the document that landed in the note; for the two modes that write nothing — `startup`,
   * which runs for its effects, and `dynamic-processor`, which is a preview asking for one command's answer —
   * it is the only thing the run has to give back.
   */
  output: string
  /** The note the plan wrote, or `null` for a discarded output. */
  noteId: string | null
  /** The caret offsets the plan reported, in the order a reader jumping through them meets them. */
  carets: number[]
  /** The note whose editor was asked to place them; `null` when no editor can show them. */
  caretNoteId: string | null
  /** What the plan said about itself, unchanged — see `./write.ts`'s `WRITE_NOTICE_MESSAGES`. */
  notices: WriteNotice[]
}

export type RunTemplateFailure = { ok: false; code: TemplaterErrorCode; detail: string }
export type RunTemplateResult = RunTemplateApplied | RunTemplateFailure

/** The note or destination a plan is applied to. */
type Subject =
  | { kind: 'note'; note: Note }
  | { kind: 'create'; path: string }
  | { kind: 'none' }

/** What a render left behind: the text, and the context the interpreter was started with. */
type Rendered = { ok: true; output: string; context: TemplateRunContext }

/**
 * Render one template and write what it produced.
 *
 * A template's failure is never an exception: the failure arm carries one code for every way the run can
 * stop — a parse error, an interpreter that could not be started, a plan the note refused, a store that
 * would not take the write.
 */
export async function runTemplateOnNote(input: RunTemplateInput, ports: RunTemplatePorts): Promise<RunTemplateResult> {
  const asked = subjectOf(input)
  if (!isSubject(asked)) return asked
  const rendered = await runProgram(input, templateOf(input), ports)
  if (!rendered.ok) return rendered
  // A dynamic command's answer belongs to the span of preview text it was found in, which is not a place a
  // note-level plan can name — so this mode stops here with its text and writes nothing. `planWrite` refuses
  // the mode as well, which is the backstop for any caller that reaches it a different way.
  if (input.mode === 'dynamic-processor') {
    return { ok: true, kind: 'discard', output: rendered.output, noteId: null, carets: [], caretNoteId: null, notices: [] }
  }
  const planned = planWrite(writeRequest(input, asked, rendered.context, rendered.output))
  if (!planned.ok) return { ok: false, code: planned.code, detail: planned.detail }
  return apply(planned.plan, asked, activeOnScreen(input), rendered.context, ports)
}

/**
 * Whether the note this run writes into is the one the reader is looking at.
 *
 * `active` is the note in front of them, so a run whose target is that note has an editor to put a caret in.
 * Every other write — `overwrite-file`, or a note the reader closed — lands in a row, not on a screen.
 */
function activeOnScreen(input: RunTemplateInput): boolean {
  return input.active !== null && input.target !== null && input.active.id === input.target.id
}

/**
 * Which row or destination this run is about, decided before anything is rendered.
 *
 * `startup` throws its output away, so it needs neither; `create-new` needs the path it files to, which no
 * row carries yet; the rest need the note they replace. A run that cannot say what it writes is refused here
 * rather than after the worker has been paid for — and a run whose render reached the reader's dialogs may
 * already have written notes of its own by then.
 */
function subjectOf(input: RunTemplateInput): Subject | RunTemplateFailure {
  if (input.mode === 'startup' || input.mode === 'dynamic-processor') return { kind: 'none' }
  if (input.mode === 'create-new') {
    return input.path === undefined ? fail('path-invalid', 'empty') : { kind: 'create', path: input.path }
  }
  return input.target === null ? fail('note-not-found', input.mode) : { kind: 'note', note: input.target }
}

/** A subject rather than a refusal, so the steps that share it read a row or a destination instead of a code. */
function isSubject(subject: Subject | RunTemplateFailure): subject is Subject {
  return !('ok' in subject)
}

/** The template as both the compiler and the snapshot want it: its text, and its row when it has one. */
function templateOf(input: RunTemplateInput): { content: string; row: NoteTemplate | null } {
  if (input.template.kind === 'library') return { content: input.template.row.content, row: input.template.row }
  return { content: input.template.content, row: null }
}

/**
 * Compile, snapshot, render.
 *
 * The context the run started with is kept, because the plan is built from the target *the interpreter saw*
 * rather than from a second reading of the row — two readings is how a rename mid-run ends up with a plan
 * for the wrong note.
 */
async function runProgram(
  input: RunTemplateInput,
  template: { content: string; row: NoteTemplate | null },
  ports: RunTemplatePorts,
): Promise<Rendered | RunTemplateFailure> {
  const compiled = compileTemplate(template.content)
  if (!compiled.ok) {
    // The position the reader has to navigate to, in the shape `./page-host.ts` already reports a parse
    // failure in, so one broken template reads the same wherever it was started from.
    return fail(compiled.failure.code, `line:${compiled.failure.line}:${compiled.failure.column}`)
  }
  const context = buildRunSnapshot({
    runId: createTemplateRunId('run'),
    notes: input.notes,
    folders: input.folders,
    templates: input.templates,
    target: input.target,
    active: input.active,
    template: template.row,
    mode: input.mode,
    capabilities: input.capabilities,
    locale: input.locale,
    startedAt: input.startedAt,
    frozenTitle: input.frozenTitle,
    selection: input.selection?.text,
    userScripts: input.userScripts,
    userScriptsUnavailable: input.userScriptsUnavailable,
  })
  const outcome = await ports.render({
    program: compiled.program,
    context,
    deadlineMs: input.deadlineMs ?? DEFAULT_RUN_DEADLINE_MS,
  })
  if (!outcome.ok) return fail(renderCode(outcome.code), outcome.detail)
  return { ok: true, output: outcome.output, context }
}

/** The write request, from the caller's data and the run's text. */
function writeRequest(
  input: RunTemplateInput,
  subject: Subject,
  context: TemplateRunContext,
  output: string,
): WriteRequest {
  // A create run is measured against an empty document even when the caller handed over the phantom row the
  // note is about to become — `planWrite` still refuses a row that already holds text, through the target the
  // run itself was started with.
  const row = subject.kind === 'create' ? null : input.target
  return {
    mode: input.mode,
    rendered: output,
    currentContent: row?.content ?? '',
    cursorGroups: groupCursorMarkers(output),
    target: context.target,
    path: input.path,
    selection: input.selection ? { start: input.selection.from, end: input.selection.to } : undefined,
    startedAtRev: input.startedAtRev,
    currentRev: row?.rev ?? null,
  }
}

/**
 * Apply one plan, as one write.
 *
 * `expectedRev` needs no check of its own: `writeRequest` reads the plan's revision and `applyWrite` hands
 * the store the guard row from the same `Note`, so the revision the plan says it must land against *is* the
 * copy the write compares, and a newer one comes back as `note-conflict` instead of as a rewrite. The
 * subject is matched against the plan's kind here because a plan carries no note and no path of its own:
 * `subjectOf` already refused a run that could not say what it writes, and matching it again at the write is
 * what keeps every branch reading a row or a destination it was actually given.
 */
async function apply(plan: WritePlan, subject: Subject, onScreen: boolean, context: TemplateRunContext, ports: RunTemplatePorts): Promise<RunTemplateResult> {
  if (plan.kind === 'discard') return reported(plan, null, false, ports)
  if (plan.kind === 'create') {
    if (subject.kind !== 'create') return fail('path-invalid', 'empty')
    return applyCreate(plan, subject.path, context, ports)
  }
  if (subject.kind !== 'note') return fail('note-not-found', plan.mode)
  return applyWrite(plan, subject.note, onScreen, ports)
}

/** The write into the note the reader is looking at, or the one into a note nobody has open. */
async function applyWrite(plan: WritePlan, note: Note, onScreen: boolean, ports: RunTemplatePorts): Promise<RunTemplateResult> {
  const written = await ports.notes.write(note.id, plan.content, note)
  if (!written.ok) return fail(writeCode(written.reason), note.id)
  return reported(plan, written.note.id, onScreen, ports)
}

/**
 * Put a new note in the tree, with its text already in it.
 *
 * The order is the whole decision: render, then create the row carrying the finished document. Creating an
 * empty row and writing it afterwards would leave a note the reader can open and that holds nothing for as
 * long as the second call takes, and would need a delete to roll back — which is the halfway state this
 * module refuses to make. A refusal here therefore leaves no row at all, and `./store-port.ts`'s create is
 * already the one call that both makes the row and reports a title taken in the meantime.
 */
async function applyCreate(plan: WritePlan, path: string, context: TemplateRunContext, ports: RunTemplatePorts): Promise<RunTemplateResult> {
  const destination = await ports.createTarget(context, path)
  if (!destination.ok) return destination
  const created = await ports.notes.create({ title: destination.title, content: plan.content, folderId: destination.folderId })
  if (!created.ok) return fail(writeCode(created.reason), path)
  const opened = await ports.editor.open(created.note.id)
  return reported(plan, created.note.id, opened, ports)
}

/**
 * The answer for a plan that ran to its end, and the caret request that follows it.
 *
 * The offsets always travel back to the caller, because they are what the plan reported. They are only
 * *asked of* an editor when one can show them: the workspace's insert signal has no owner until the note is
 * on screen, and a request left standing in the store would fire the next time that id is opened — putting
 * a caret somewhere the reader never asked for.
 */
function reported(
  plan: WritePlan,
  noteId: string | null,
  showCarets: boolean,
  ports: RunTemplatePorts,
): RunTemplateApplied {
  const caretNoteId = showCarets && noteId !== null && plan.carets.length > 0 ? noteId : null
  if (caretNoteId !== null) ports.requestCarets(caretNoteId, plan.carets)
  return { ok: true, kind: plan.kind, output: plan.content, noteId, carets: plan.carets, caretNoteId, notices: plan.notes }
}

/** The data layer's three refusals, each named with the code a reader can be told about. */
export function writeCode(reason: PageHostFailure): TemplaterErrorCode {
  if (reason === 'conflict') return 'note-conflict'
  if (reason === 'not-found') return 'note-not-found'
  return 'render-failed'
}

/**
 * The run's own code, or the fallback.
 *
 * A failure crosses the worker boundary as plain text, so a name this module does not know is not a code —
 * `../errors.ts`'s own fallback answers it, beside the measurement the run reported.
 */
function renderCode(value: string): TemplaterErrorCode {
  return isTemplaterErrorCode(value) ? value : 'render-failed'
}

function fail(code: TemplaterErrorCode, detail: string): RunTemplateFailure {
  return { ok: false, code, detail }
}
