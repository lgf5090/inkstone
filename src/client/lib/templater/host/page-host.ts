/**
 * The page's answer to a template's note, folder and library-template calls.
 *
 * This is the half of the host that touches real data: a `HostCall` arrives, one small function per method
 * resolves its path against the run's own index, asks the app's data layer for the work, and hands back
 * either a plain value or one code from `../errors.ts`. Three of the methods are not data at all and are
 * answered here through seams the page injects: `note.renderInclude` starts a nested run (the support for
 * that is `./nested-render.ts`), `note.open` shows a note in the editor, and `cursor.append` writes into the
 * CodeMirror view on screen — both editor ones go through the {@link PageHostDeps.editor} port so this file
 * never imports the editor and stays testable without one. What it deliberately is not: a dialog (the prompt
 * and suggester methods belong to the page's prompt host) or a proxy (the `web.*` methods belong to whoever
 * holds the reader's web setting, which is a setting and therefore a page-side fact). Those names are
 * answered by {@link deferred} — one labelled boundary, no fake.
 *
 * Three rules this file holds itself to, because each is the way a template host goes wrong:
 *
 * - **the capability is re-checked on every call.** `../worker/protocol.ts` gates the same table before a
 *   message is posted, and that gate is not a licence for this side: the run's profile is decided by the
 *   page, the reader's settings live on the page, and a host that skips its own check is a host whose
 *   safety depends on its caller. A call that arrives without a right is refused here, whatever reached it.
 * - **a path is validated before it is resolved, and never repaired.** `validateNotePath` owns the reasons
 *   a path cannot name a place in this tree; anything it refuses becomes `path-invalid` and no read, write
 *   or create is attempted with it. A traversal that was *normalised away* instead of refused would file
 *   the reader's note somewhere they never pointed at.
 * - **failures carry a code and a measurement, never a sentence.** The reader's interface may be Chinese,
 *   so `detail` is a path, a name, an argument position or a limit — and the one place an English message
 *   could leak in (an exception thrown by a store function) becomes the method's name plus a log line for
 *   the developer.
 *
 * How the run's context reaches this side is the one thing the frozen contract left open: `HostCall`
 * carries a `runId` and nothing else, and `renderTemplate` does not notify the host. So the page registers
 * the context it starts a run with (`beginRun`) and releases it when the outcome arrives (`endRun`), and a
 * call naming a run that was never registered is refused rather than answered under somebody else's
 * rights. The index the calls resolve against is rebuilt lazily from that context — `noteIndexFor` is
 * linear in rows, and a run that never touches a note should not pay for one.
 */
import type { Folder, Note, NoteTemplate } from '@shared/types'
import { LIMITS } from '@shared/constants'
import { folderIndexEntry, noteIndexEntry, templatesFolderEntry, virtualBasename, virtualNoteName, TEMPLATES_FOLDER_ID, TEMPLATES_FOLDER_NAME } from '../context/file-wrapper'
import { stripMarkdownExtension, type NoteIndex } from '../context/note-index'
import { folderPathsOf, noteIndexFor } from '../context/snapshot'
import { createTemplateRunId } from '../run-id'
import { compileTemplate } from '../engine/program'
import { HOST_METHOD_CAPABILITY, HOST_METHODS, capabilitiesFor, type HostCall, type HostMethod, type HostResult, type NoteIndexEntry, type ProgramSource, type TemplateRunContext } from '../protocol'
import { MAX_HOST_ARG_CHARS, MAX_OUTPUT_CHARS, MAX_TEMPLATE_DEPTH } from '../limits'
import { isTemplaterErrorCode, type TemplaterErrorCode } from '../errors'
import { buildChildContext, NestedRunRegistry, parseRenderIncludeRequest, sliceIncludeSubpath } from './nested-render'
import { validateNotePath } from './write'

/** What the page's answer carries when the call succeeded. */
type Success = { ok: true; value: unknown }
/** What it carries when the call did not: a code the interface translates, and a measurement. */
type Refusal = { ok: false; code: TemplaterErrorCode; detail: string }
type Outcome = Success | Refusal

/** Why a write did not happen, as the data layer reports it. `failed` is the app's own refusal, not the template's. */
export type PageHostFailure = 'not-found' | 'conflict' | 'failed'
export type PageHostWrite = { ok: true; note: Note } | { ok: false; reason: PageHostFailure }

/** What `notes.update` may change: a title, a folder, or the pair a move needs. */
export interface PageHostChanges {
  title?: string
  folderId?: string | null
}

/**
 * The outcome of one nested render, as the door in `../index.ts` reports it.
 *
 * Structurally `TemplaterRunOutcome`; spelled again because that name lives in the worker half and this
 * file may not import it — the wiring hands `renderTemplate` itself to the port below, and if the two
 * shapes ever drift, the assignment stops compiling rather than guessing.
 */
export type NestedRenderOutcome =
  | { ok: true; output: string; durationMs: number }
  | { ok: false; code: string; detail: string }

/**
 * The seams this module reads and writes through.
 *
 * Every one of them has a real implementation in `./store-port.ts`; they are named here rather than
 * imported because the alternative is a host that can only be tested against a browser, a server and an
 * IndexedDB cache at once. The shapes are the app's own rows (`Note`, `Folder`, `NoteTemplate`) so a fake
 * cannot drift into a shape the product never returns.
 */
export interface PageHostDeps {
  notes: {
    /** The note with its body, or `null` when nothing readable carries that id. */
    read(id: string): Promise<Note | null>
    /** Replace a body, guarded by the row the host just read. */
    write(id: string, content: string, expected: Note): Promise<PageHostWrite>
    /** Rename, file away, or both, against the same guard. */
    update(id: string, changes: PageHostChanges, expected: Note): Promise<PageHostWrite>
    /** Put a new note in the folder the host resolved. */
    create(input: { title: string; content: string; folderId: string | null }): Promise<PageHostWrite>
    /** Take a note to the trash. */
    remove(id: string): Promise<PageHostWrite>
  }
  folders: {
    /** The folder rows as the page holds them, in any order. */
    list(): Folder[]
    /** One folder under `parentId`; the id it actually created, or `null` when the app refused. */
    create(input: { name: string; parentId: string | null }): Promise<string | null>
  }
  templates: {
    /** A library template by name, the way the gallery names it. */
    byName(name: string): Promise<NoteTemplate | null>
  }
  /**
   * The editor, as far as a template reaches it.
   *
   * Kept as a port so this module never imports CodeMirror: `note.open` and `cursor.append` are the only
   * two methods that touch the screen, and the rule that makes them testable is the same one that keeps
   * the interpreter out of the store — name the seam, inject the real one.
   */
  editor: {
    /**
     * Show the note with this id in the workspace.
     *
     * `true` only once a pane is actually on it, which is what lets `note.open` answer upstream's
     * "no active leaf" as a refusal instead of a claim nobody checked.
     */
    open(id: string): Promise<boolean>
    /**
     * Replace the active editor's selection with text in one undoable transaction.
     *
     * `false` when there is no live editor to write into — the state upstream's `cursor_append` logs and
     * does nothing about, which the caller reports rather than hiding.
     */
    appendAtCursor(text: string): boolean
  }
  /** The door that starts the nested run behind `note.renderInclude`; `renderTemplate`/`cancelTemplateRun`. */
  nested: {
    render(args: { program: ProgramSource; context: TemplateRunContext; deadlineMs: number }): Promise<NestedRenderOutcome>
    cancel(runId: string): void
  }
}

/**
 * The methods this module answers; every other name on the allowlist goes to {@link deferred}.
 *
 * `folder.list` and `template.read` are answered inside the worker today, from the snapshot the run arrived
 * with (`worker/protocol.ts`'s `methodIsSnapshotLocal`), so a run started through `renderTemplate` never
 * posts them here. They are implemented anyway: they are on the frozen list, the page holds the live folder
 * tree and the library where the snapshot holds a copy, and a host that left a named method unanswered
 * would answer it with `not-supported` to any caller that is not the worker.
 */
export const OWNED_METHODS: readonly HostMethod[] = [
  'note.read',
  'note.write',
  'note.create',
  'note.open',
  'note.move',
  'note.rename',
  'note.delete',
  'note.exists',
  'note.renderInclude',
  'folder.list',
  'folder.create',
  'template.read',
  'cursor.append',
]

/** One run the page is answering for: its context, and the writes this run has already made. */
interface LiveRun {
  context: TemplateRunContext
  /** Rebuilt from the context on first lookup, then kept. */
  index: NoteIndex | null
  /**
   * Paths this run changed, winning over the snapshot until the run ends.
   *
   * A template that creates a note and then asks for it (`tp.file.create_new` followed by
   * `tp.file.exists`, or an `include` of it) is asking about a row the run's snapshot predates. Answering
   * from the snapshot alone would report a note the reader can already see as missing, and answering from a
   * fresh full list would disagree with `tp.file.find_tfile`, which is frozen at the snapshot by design. So
   * the base stays the context's own index and only the paths this run touched are overlaid; `null` is a
   * tombstone.
   */
  written: Map<string, NoteIndexEntry | null>
  /** Folder paths this run created, keyed by path, so one run can file into two new levels at once. */
  createdFolders: Map<string, string>
}

/** Where a note that is about to be created is going to live, as the tree answers it. */
export type CreateTarget =
  | { ok: true; title: string; folderId: string | null }
  | { ok: false; code: TemplaterErrorCode; detail: string }

/** A callable host: `configureTemplater` takes it as its `onHostCall` directly. */
export interface PageHost {
  (call: HostCall): Promise<HostResult>
  /** Record the context one run started with, before posting its program. */
  beginRun: (context: TemplateRunContext) => void
  /** Forget a run, so a late call for it is refused instead of answered under stale rights. */
  endRun: (runId: string) => void
  /** How many runs the page is holding contexts for, for a batch that wants to know it is done. */
  liveRuns: () => number
  /**
   * Resolve the destination of a note that is about to be created, creating the folders it names.
   *
   * This is `note.create`'s own path logic handed out as a call rather than a second copy of it: the title
   * rules, the taken-path refusal and the folder chain all live in this module, and a duplicate of them in
   * the write pipeline is how a traversal or a double name gets through. The pipeline needs it *before* it
   * creates, because it creates the row with the finished document already in it — `note.create` takes path
   * and text together and cannot be asked in two halves.
   */
  createTarget: (runId: string, path: string) => Promise<CreateTarget>
}

/**
 * How many runs the page may hold contexts for at once.
 *
 * A registered run keeps its context, and a rebuilt index over a large vault is the expensive half of that.
 * The page is supposed to release each run when its outcome arrives; a batch that started more runs than
 * this without releasing any is a page that has lost an `endRun`, and the alternative to a bound is holding
 * every one of them until the tab is closed. The oldest registration goes, and its next call is refused
 * loudly rather than answered under a context nobody meant to keep.
 */
export const MAX_TRACKED_RUNS = 32

/**
 * Which names the frozen allowlist carries, taken from the contract rather than from the worker's copy.
 *
 * `protocol.ts` forbids the two halves importing each other's modules; `HOST_METHODS` is the list both
 * sides may read, so membership is tested against it here.
 */
function asHostMethod(value: unknown): HostMethod | null {
  return typeof value === 'string' && (HOST_METHODS as readonly string[]).includes(value)
    ? value as HostMethod
    : null
}

export function createPageHost(deps: PageHostDeps): PageHost {
  const runs = new Map<string, LiveRun>()
  // Which nested render sits at which depth under which run. Lives beside `runs` rather than in a
  // `LiveRun` because a child outlives its registration on a cancel and the cascade needs the edges.
  const nested = new NestedRunRegistry()

  function beginRun(context: TemplateRunContext): void {
    // A second registration for one id is the page re-using it, not two runs sharing it: keeping the newer
    // context is what keeps the newer run's calls answerable, and the older run is already over.
    runs.set(context.runId, { context, index: null, written: new Map(), createdFolders: new Map() })
    while (runs.size > MAX_TRACKED_RUNS) {
      const oldest = runs.keys().next()
      if (oldest.done === true || oldest.value === context.runId) break
      runs.delete(oldest.value)
      console.warn('[inkstone] templater host dropped a run the page never released', oldest.value)
    }
  }

  function endRun(runId: string): void {
    runs.delete(runId)
    // A parent that ends while a nested render is still open is a cancelled or failed run — the page has
    // stopped waiting on it, and a child left running would render text nobody will answer. Each edge goes
    // the same way a batch caller releases a run: release its context first, then stop its interpreter.
    for (const childRunId of nested.childrenOf(runId)) {
      nested.remove(childRunId)
      endRun(childRunId)
      deps.nested.cancel(childRunId)
    }
  }

  /** The run's index, built once per run rather than once per call. */
  function indexFor(run: LiveRun): NoteIndex {
    if (run.index === null) run.index = noteIndexFor(run.context)
    return run.index
  }

  async function onHostCall(call: HostCall): Promise<HostResult> {
    try {
      const outcome = await dispatch(call)
      return outcome.ok
        ? { runId: call.runId, callId: call.callId, ok: true, value: outcome.value }
        : { runId: call.runId, callId: call.callId, ok: false, code: outcome.code, detail: outcome.detail }
    }
    catch (error) {
      // A store function that threw is the one failure this table cannot read: the note may or may not have
      // changed, and guessing would be worse than the generic label beside a log line. The thrown value is
      // kept for the developer and never put in `detail`, because it is prose no locale translates and it
      // can quote a path the reader did not type.
      console.error('[inkstone] templater host call failed', call.method, error)
      return { runId: call.runId, callId: call.callId, ok: false, code: 'render-failed', detail: `throw:${call.method}` }
    }
  }

  async function dispatch(call: HostCall): Promise<Outcome> {
    const method = asHostMethod(call.method)
    if (method === null) {
      // A name that is not on the allowlist does not exist, so it is not "blocked": saying so is what keeps
      // a template from concluding that some setting would let it through.
      return fail('not-supported', typeof call.method === 'string' ? call.method : 'unnamed')
    }
    const run = runs.get(call.runId)
    if (run === undefined) return fail('render-failed', `run:${call.runId}`)
    const capabilities = capabilitiesFor(run.context.capabilities)
    if (capabilities[HOST_METHOD_CAPABILITY[method]] !== true) return fail('capability-blocked', method)
    const args = Array.isArray(call.args) ? call.args : []
    if (argChars(args) > MAX_HOST_ARG_CHARS) {
      // Refused, not cut: a body the page silently shortened would produce a note that is wrong in a way
      // nobody can see. The worker measures the same number before posting, so reaching here means the call
      // came from somewhere that did not.
      return fail('template-output-too-large', `host-args:${MAX_HOST_ARG_CHARS}`)
    }
    switch (method) {
      case 'note.read': return readNote(run, args)
      case 'note.exists': return noteExists(run, args)
      case 'note.write': return writeNote(run, args)
      case 'note.create': return createNote(run, args)
      case 'note.open': return openNote(run, args)
      case 'note.move': return moveNote(run, args)
      case 'note.rename': return renameNote(run, args)
      case 'note.delete': return deleteNote(run, args)
      case 'note.renderInclude': return renderInclude(run, args)
      case 'folder.list': return listFolders()
      case 'folder.create': return createFolder(run, args)
      case 'template.read': return readTemplate(run, args)
      case 'cursor.append': return appendCursor(args)
      default: return deferred(method)
    }
  }

  async function readNote(run: LiveRun, args: unknown[]): Promise<Outcome> {
    const path = pathAt(args, 0)
    if (!path.ok) return path.failure
    const resolved = resolve(run, path.value)
    if (resolved.entry === null) return fail('note-not-found', path.value)
    // A template row is a library record, not a note: its content comes from the library, which is also
    // what the run's prelude asks for when it meets a `Templates/<name>.md` path.
    if (resolved.entry.folderId === TEMPLATES_FOLDER_ID) return readTemplateByName(run, resolved.entry.title)
    const note = await deps.notes.read(resolved.entry.id)
    if (note === null) return fail('note-not-found', path.value)
    return succeed({ content: note.content })
  }

  async function noteExists(run: LiveRun, args: unknown[]): Promise<Outcome> {
    const path = pathAt(args, 0)
    if (!path.ok) return path.failure
    return succeed(resolve(run, path.value).entry !== null)
  }

  async function writeNote(run: LiveRun, args: unknown[]): Promise<Outcome> {
    const path = pathAt(args, 0)
    if (!path.ok) return path.failure
    const content = stringAt(args, 1, 'note.write')
    if (!content.ok) return content.failure
    const target = await writableTarget(run, 'note.write', path.value)
    if (!target.ok) return target
    return applied(await deps.notes.write(target.note.id, content.value, target.note), 'write', path.value)
  }

  /**
   * The folder and title a validated path files a new note under, refusing a path that is already taken.
   *
   * Derived from Templater 2.26.0 (AGPL-3.0-only) src/core/Templater.ts
   * (`create_new_note_from_template`), with Inkstone adaptations: upstream asks Obsidian for an unused
   * name and quietly creates `Note 2.md`, while two rows reading as one path is the state this app's index
   * has to report as ambiguous later — so a taken path is refused here instead. One copy of that rule,
   * shared by `note.create` and by {@link createTarget}, because two copies is how one of them gets fixed
   * and the other does not.
   */
  async function targetFor(run: LiveRun, path: string): Promise<CreateTarget> {
    const title = titleOf(path)
    if (title === null) return { ok: false, code: 'path-invalid', detail: `title-max:${LIMITS.titleMaxLength}` }
    if (resolve(run, path).entry !== null) return { ok: false, code: 'note-conflict', detail: path }
    const folder = await resolveFolderPath(run, parentOf(path))
    if (!folder.ok) return { ok: false, code: folder.code, detail: folder.detail }
    return { ok: true, title, folderId: folder.value }
  }

  async function createNote(run: LiveRun, args: unknown[]): Promise<Outcome> {
    const path = pathAt(args, 0)
    if (!path.ok) return path.failure
    const content = stringAt(args, 1, 'note.create')
    if (!content.ok) return content.failure
    const target = await targetFor(run, path.value)
    if (!target.ok) return fail(target.code, target.detail)
    const created = await deps.notes.create({ title: target.title, content: content.value, folderId: target.folderId })
    if (created.ok) run.written.set(path.value, noteIndexEntry(created.note, path.value))
    return applied(created, 'create', path.value)
  }

  async function moveNote(run: LiveRun, args: unknown[]): Promise<Outcome> {
    const from = pathAt(args, 0)
    if (!from.ok) return from.failure
    const to = pathAt(args, 1)
    if (!to.ok) return to.failure
    return relocate(run, 'note.move', from.value, to.value)
  }

  async function renameNote(run: LiveRun, args: unknown[]): Promise<Outcome> {
    const from = pathAt(args, 0)
    if (!from.ok) return from.failure
    const name = stringAt(args, 1, 'note.rename')
    if (!name.ok) return name.failure
    // A new name is one segment of the note's own folder. Derived from Templater 2.26.0 (AGPL-3.0-only)
    // src/core/functions/internal_functions/file/InternalModuleFile.ts, with Inkstone adaptations: upstream
    // rejects `\ / :` in the name and nothing else, while this validates the name as a path and then insists
    // it stayed one segment, so the reserved characters and the trailing dot the app cannot store are refused
    // before a row is written with them.
    const checked = validateNotePath(name.value)
    if (!checked.ok) return fail('path-invalid', checked.reason)
    if (checked.path.includes('/')) return fail('path-invalid', 'name-segment')
    if (virtualBasename(checked.path) === '') return fail('path-invalid', 'name-empty')
    return relocate(run, 'note.rename', from.value, joinParent(from.value, checked.path))
  }

  async function deleteNote(run: LiveRun, args: unknown[]): Promise<Outcome> {
    const path = pathAt(args, 0)
    if (!path.ok) return path.failure
    const resolved = resolve(run, path.value)
    if (resolved.entry === null) return fail('note-not-found', path.value)
    if (resolved.ambiguous) return fail('note-conflict', path.value)
    if (resolved.entry.folderId === TEMPLATES_FOLDER_ID) return deferred('note.delete', 'template-row')
    const removed = await deps.notes.remove(resolved.entry.id)
    if (removed.ok) run.written.set(path.value, null)
    return applied(removed, 'delete', path.value)
  }

  /**
   * The `open_new` half of `tp.file.create_new`: show a note in the reader's editor.
   *
   * Upstream resolves nothing here — `create_new` hands it the file it just made and only ever fails when
   * there is no leaf to open it in (`Templater.ts:229-234`), a case it logs and answers `undefined`. The
   * port takes a path, because `note.open` is a host method and the template's link text is untrusted, so
   * resolution goes through the same read path every other method uses; a note the page cannot show is
   * refused with `render-failed:note.open:no-leaf` rather than logged away, which is the editor's own
   * refusal and the one `../errors.ts` names `render-failed` for.
   */
  async function openNote(run: LiveRun, args: unknown[]): Promise<Outcome> {
    const path = pathAt(args, 0)
    if (!path.ok) return path.failure
    const resolved = resolve(run, path.value)
    if (resolved.entry === null) return fail('note-not-found', path.value)
    // A library template is a gallery row, not a note: there is no pane that could show it.
    if (resolved.entry.folderId === TEMPLATES_FOLDER_ID) return deferred('note.open', 'template-row')
    if (!(await deps.editor.open(resolved.entry.id))) {
      console.warn('[inkstone] templater note.open found no pane to show the note in', path.value)
      return fail('render-failed', 'note.open:no-leaf')
    }
    return succeed(undefined)
  }

  /**
   * `tp.file.cursor_append(content)`: put text at the active editor's selection.
   *
   * Derived from Templater 2.26.0 (AGPL-3.0-only) src/core/functions/internal_functions/file/
   * InternalModuleFile.ts (`generate_cursor_append`), with Inkstone adaptations: upstream's
   * `doc.replaceSelection` is CodeMirror's `insertText` command dispatched through the real view, so the
   * append is one undoable transaction and the caret lands where the command puts it; the selection is
   * replaced, matching upstream, not appended after it. No editor is upstream's "log and return nothing"
   * branch — here the warning is on the page's console and the answer still goes back, because
   * `cursor.append` is fire-and-forget in the worker (`worker/protocol.ts`'s `SYNC_METHODS`) and the run
   * reports done only once this call is answered: an answer, any answer, is what stops the VM waiting.
   */
  function appendCursor(args: unknown[]): Outcome {
    const given = asRecord(args[0])
    const text = given === null ? undefined : given.text
    if (typeof text !== 'string') return fail('render-failed', 'cursor.append:arg:0:type')
    if (!deps.editor.appendAtCursor(text)) {
      console.warn('[inkstone] templater cursor_append found no active editor to append to')
    }
    return succeed(undefined)
  }

  /**
   * `tp.file.include` / the render half of `tp.file.create_new`: start a nested run, answer its text.
   *
   * The whole job is in `./nested-render.ts`'s three pieces plus the run this side owns: the depth counter
   * (this run's registered level plus the level the request reports — the worker's counters only see one
   * interpreter, which is why `MAX_TEMPLATE_DEPTH` says the page enforces it), the child's context (never
   * wider than its parent's), and the registry entry that lets a cancelled parent take its children down.
   * The answer is the child's finished text with its cursor markers still in it, which is what lets a
   * marker inside an included note land in the note the parent is writing.
   */
  async function renderInclude(run: LiveRun, args: unknown[]): Promise<Outcome> {
    const parsed = parseRenderIncludeRequest(args[0])
    if (!parsed.ok) return fail('render-failed', `note.renderInclude:${parsed.issue}`)
    const request = parsed.request
    const depth = nested.offsetOf(run.context.runId) + request.depth
    if (depth > MAX_TEMPLATE_DEPTH) return fail('template-recursion', `depth:${depth}`)

    let templateText: string
    let sourceEntry: NoteIndexEntry | null = null
    let rawContent = ''
    if (request.source.kind === 'text') {
      templateText = request.source.text
    }
    else {
      const checked = validateNotePath(request.source.path)
      if (!checked.ok) return fail('path-invalid', checked.reason)
      const resolved = resolve(run, checked.path)
      if (resolved.entry === null) return fail('note-not-found', checked.path)
      sourceEntry = resolved.entry
      if (sourceEntry.folderId === TEMPLATES_FOLDER_ID) {
        const content = await templateRawContent(run, sourceEntry.title)
        if (content === null) return fail('note-not-found', `template:${sourceEntry.title}`)
        rawContent = content
      }
      else {
        const note = await deps.notes.read(sourceEntry.id)
        if (note === null) return fail('note-not-found', checked.path)
        rawContent = note.content
      }
      if (request.source.subpath === null || request.source.subpath === undefined) {
        templateText = rawContent
      }
      else {
        const sliced = sliceIncludeSubpath(rawContent, request.source.subpath)
        if (!sliced.ok) return fail('note-not-found', `subpath:${request.source.subpath.kind}:${request.source.subpath.text}`)
        templateText = sliced.text
      }
    }

    const compiled = compileTemplate(templateText)
    if (!compiled.ok) return fail(compiled.failure.code, `line:${compiled.failure.line}:${compiled.failure.column}`)

    const childRunId = createTemplateRunId('include')
    const child = buildChildContext({ parent: run.context, runId: childRunId, asCreate: request.asCreate, sourceEntry, sourceContent: rawContent })
    nested.add(childRunId, run.context.runId, depth)
    beginRun(child)
    try {
      // `deadlineMs: 0` is the engine's default, not an absence: `worker/protocol.ts` clamps a missing
      // number to `DEFAULT_RUN_DEADLINE_MS`, and the nested run has no page-chosen budget to inherit.
      const outcome = await deps.nested.render({ program: compiled.program, context: child, deadlineMs: 0 })
      if (!outcome.ok) {
        const code: TemplaterErrorCode = isTemplaterErrorCode(outcome.code) ? outcome.code : 'render-failed'
        return fail(code, outcome.detail === '' ? `include:${childRunId}` : `include:${childRunId}:${outcome.detail}`)
      }
      // The child's text splices into the parent's output, and the parent's output is what becomes a note;
      // refusing an oversized include here says so at the size that broke rather than at the write.
      if (outcome.output.length > MAX_OUTPUT_CHARS) {
        return fail('template-output-too-large', `include:${childRunId}:chars:${outcome.output.length}`)
      }
      return succeed({ content: outcome.output })
    }
    finally {
      nested.remove(childRunId)
      endRun(childRunId)
    }
  }

  async function listFolders(): Promise<Outcome> {
    const folders = deps.folders.list()
    const paths = folderPathsOf(folders)
    // The library folder is not a row, and a run that lists folders and then reads `Templates/<name>.md`
    // has to be told it exists: `folderPathsOf` cannot supply a path for a folder no table holds, so the
    // projection owns it — the same entry `noteIndexFor` rebuilt the index over.
    const entries = folders.map((folder) => folderIndexEntry(folder, paths.get(folder.id) ?? ''))
    if (!folders.some((folder) => folder.id === TEMPLATES_FOLDER_ID)) entries.push(templatesFolderEntry())
    return succeed(entries)
  }

  async function createFolder(run: LiveRun, args: unknown[]): Promise<Outcome> {
    const path = pathAt(args, 0)
    if (!path.ok) return path.failure
    const created = await resolveFolderPath(run, path.value)
    if (!created.ok) return created
    if (created.value === null) return fail('path-invalid', 'root')
    const row = deps.folders.list().find((folder) => folder.id === created.value)
    if (row === undefined) return fail('note-not-found', path.value)
    return succeed(folderIndexEntry(row, path.value))
  }

  async function readTemplate(run: LiveRun, args: unknown[]): Promise<Outcome> {
    const name = stringAt(args, 0, 'template.read')
    if (!name.ok) return name.failure
    return readTemplateByName(run, name.value)
  }

  /**
   * The library row a template name means, or the run's own applied template.
   *
   * A gallery template used without importing it is in the run's context but not in the reader's library,
   * and `tp.file.include` of it has to work: reading only the library would answer `note-not-found` for the
   * very template the run is executing.
   *
   * The answer is `{ content }`, which is what `bootstrap.ts`'s `readByPath` consumes. The worker's own
   * snapshot answer for the same name carries `id` and `name` beside it (`worker/host-bindings.ts`), and
   * nothing reads those two — so this side ships the smaller of the two shapes rather than inventing a
   * third.
   */
  async function readTemplateByName(run: LiveRun, name: string): Promise<Outcome> {
    const content = await templateRawContent(run, name)
    if (content !== null) return succeed({ content })
    return fail('note-not-found', `template:${name}`)
  }

  /** The raw text behind a template name, or `null` when the library and the run both lack it. */
  async function templateRawContent(run: LiveRun, name: string): Promise<string | null> {
    const stored = await deps.templates.byName(name)
    if (stored !== null) return stored.content
    const running = run.context.template
    if (running !== null && running.name.trim().toLowerCase() === name.trim().toLowerCase()) {
      return running.content
    }
    return null
  }

  /**
   * The shared half of `note.move` and `note.rename`: put a note at a new path, folders included.
   *
   * Derived from Templater 2.26.0 (AGPL-3.0-only) src/core/functions/internal_functions/file/
   * InternalModuleFile.ts (`move` and `rename`), with Inkstone adaptations: both are one
   * `fileManager.renameFile` call there, which changes folder and name at once, so a port that moved the
   * folder and left the title behind would retitle nothing the reader asked about when the path they gave
   * differs only in its last segment — and the mirror version would rename a note the reader only meant to
   * file away.
   */
  async function relocate(run: LiveRun, method: HostMethod, fromPath: string, toPath: string): Promise<Outcome> {
    const source = await writableTarget(run, method, fromPath)
    if (!source.ok) return source
    const checked = validateNotePath(toPath)
    if (!checked.ok) return fail('path-invalid', checked.reason)
    const title = titleOf(checked.path)
    if (title === null) return fail('path-invalid', `title-max:${LIMITS.titleMaxLength}`)
    if (checked.path !== fromPath && resolve(run, checked.path).entry !== null) return fail('note-conflict', checked.path)
    const folder = await resolveFolderPath(run, parentOf(checked.path))
    if (!folder.ok) return folder
    const changes: PageHostChanges = {}
    if (source.note.title !== title) changes.title = title
    if (source.note.folderId !== folder.value) changes.folderId = folder.value
    if (Object.keys(changes).length === 0) {
      // The note is already where the template asked. Saying so with the row it names is kinder than a write
      // that bumps a revision the reader did not change.
      return succeed(noteIndexEntry(source.note, checked.path))
    }
    const updated = await deps.notes.update(source.note.id, changes, source.note)
    if (updated.ok) {
      // The path the note leaves keeps answering as it did before only when this run put it there; a path
      // the snapshot knew has to be tombstoned, or the run would still read a note that has moved.
      if (baseHas(run, fromPath)) run.written.set(fromPath, null)
      else run.written.delete(fromPath)
      run.written.set(checked.path, noteIndexEntry(updated.note, checked.path))
    }
    return applied(updated, 'update', checked.path)
  }

  /**
   * A path a write may land on: it exists, it names one row, and that row is a note.
   *
   * The fresh row comes back because a guarded write needs the revision and the text the page actually
   * saw — reading it first is what makes `note-conflict` a real answer rather than a guess.
   */
  async function writableTarget(run: LiveRun, method: HostMethod, path: string): Promise<{ ok: true; note: Note } | Refusal> {
    const resolved = resolve(run, path)
    if (resolved.entry === null) return fail('note-not-found', path)
    // Two rows at one path is a state a database allows and a file system does not. Picking one silently
    // writes to a note the template never named, so `note-index.ts` keeps every match and this refuses.
    if (resolved.ambiguous) return fail('note-conflict', path)
    if (resolved.entry.folderId === TEMPLATES_FOLDER_ID) return deferred(method, 'template-row')
    const note = await deps.notes.read(resolved.entry.id)
    if (note === null) return fail('note-not-found', path)
    return { ok: true, note }
  }

  /** The snapshot's answer for a path, with this run's own writes laid over it. */
  function resolve(run: LiveRun, path: string): { entry: NoteIndexEntry | null; ambiguous: boolean } {
    const overlay = run.written.get(path)
    if (overlay !== undefined) return { entry: overlay, ambiguous: false }
    const found = indexFor(run).resolvePath(path)
    return { entry: found.entry, ambiguous: found.ambiguous }
  }

  function baseHas(run: LiveRun, path: string): boolean {
    return indexFor(run).getByPath(path) !== null
  }

  /**
   * The id of the folder a path names, creating the levels that do not exist yet.
   *
   * Derived from Templater 2.26.0 (AGPL-3.0-only) src/core/functions/internal_functions/file/
   * InternalModuleFile.ts (`move`) and src/core/Templater.ts (`create_new_note_from_template`), with
   * Inkstone adaptations: upstream creates the missing destination folder in one `vault.createFolder` call,
   * which this app has no entry point for, so the chain is walked one segment at a time against the live
   * folder list. `''` is the tree root and answers `null`, not a failure.
   */
  async function resolveFolderPath(run: LiveRun, path: string): Promise<{ ok: true; value: string | null } | Refusal> {
    if (path === '') return { ok: true, value: null }
    // `Templates` is the projection the library is read through, not a folder any note lives in: making a
    // real one with that name would give two tables the same path, which is the ambiguity this host already
    // refuses to write into.
    if (path.split('/').includes(TEMPLATES_FOLDER_NAME)) return fail('path-invalid', `reserved:${TEMPLATES_FOLDER_NAME}`)
    const byPath = folderPathIndex(deps.folders.list())
    let parentId: string | null = null
    let prefix = ''
    for (const segment of path.split('/')) {
      prefix = prefix ? `${prefix}/${segment}` : segment
      const known = run.createdFolders.get(prefix) ?? byPath.get(prefix) ?? null
      if (known !== null) {
        parentId = known
        continue
      }
      const created = await deps.folders.create({ name: segment, parentId })
      if (created === null) return fail('render-failed', `folder:${prefix}`)
      // The app gives a folder whose name is already taken a suffix, which would file the note beside the
      // folder the template named rather than inside it. The row that came back is checked, not trusted.
      const row = deps.folders.list().find((folder) => folder.id === created)
      if (row === undefined || row.name !== segment) return fail('note-conflict', `folder:${prefix}`)
      run.createdFolders.set(prefix, created)
      parentId = created
    }
    return { ok: true, value: parentId }
  }

  async function createTarget(runId: string, path: string): Promise<CreateTarget> {
    const run = runs.get(runId)
    if (run === undefined) return { ok: false, code: 'render-failed', detail: `run:${runId}` }
    const checked = validateNotePath(path)
    if (!checked.ok) return { ok: false, code: 'path-invalid', detail: checked.reason }
    return targetFor(run, checked.path)
  }

  return Object.assign(onHostCall, { beginRun, endRun, liveRuns: () => runs.size, createTarget })
}

/**
 * The one door for the host methods this card does not cover.
 *
 * Answered rather than thrown, with the method's own name as the measurement: `not-supported` is the
 * honest state of a capability the page has not been wired to yet, and a template holding the token can be
 * told which one. `extra` is only ever a machine-readable tag naming the shape of the refusal, never prose.
 */
function deferred(method: HostMethod, extra?: string): Refusal {
  return fail('not-supported', extra === undefined ? method : `${method}:${extra}`)
}

/** A path argument, normalised and validated, or the refusal that names its position. */
function pathAt(args: unknown[], index: number): { ok: true; value: string } | { ok: false; failure: Refusal } {
  const value = args[index]
  if (typeof value !== 'string') return { ok: false, failure: fail('path-invalid', `arg:${index}:type`) }
  if (value.trim() === '') return { ok: false, failure: fail('path-invalid', `arg:${index}:empty`) }
  const checked = validateNotePath(value)
  if (!checked.ok) return { ok: false, failure: fail('path-invalid', checked.reason) }
  return { ok: true, value: checked.path }
}

/** A string argument that is not a path — a body, a new name, or a template name. */
function stringAt(args: unknown[], index: number, method: HostMethod): { ok: true; value: string } | { ok: false; failure: Refusal } {
  const value = args[index]
  if (typeof value !== 'string') return { ok: false, failure: fail('render-failed', `${method}:arg:${index}:type`) }
  return { ok: true, value }
}

/** A plain object argument, read without trusting it: an array is not a record here either. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * How deep one argument's object nesting is walked while measuring it.
 *
 * The arguments cross a structured clone, which carries a cycle rather than flattening it, so measuring is
 * bounded by depth and not by hope: anything past this is reported as too large for the budget, which is
 * the same answer the worker gives for a value it cannot put on the wire. No template needs an argument
 * nested like this, and one that has it is not asking to write a note.
 */
const MAX_ARG_NESTING = 8

/** How much the string halves of one call's arguments weigh, measured the way the worker measures them. */
function argChars(args: unknown[], depth = 0): number {
  let total = 0
  for (const arg of args) {
    if (typeof arg === 'string') total += arg.length
    else if (arg !== null && typeof arg === 'object') {
      if (depth >= MAX_ARG_NESTING) return Number.POSITIVE_INFINITY
      total += argChars(Object.values(arg), depth + 1)
    }
  }
  return total
}

/** The folder half of a virtual path, or `''` for a note at the root. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/** The title a note at that path carries: the last segment, extension dropped. */
function titleOf(path: string): string | null {
  const title = stripMarkdownExtension(lastSegment(path))
  if (title.length === 0) return null
  // The app cuts a longer title to its own ceiling, and the note would not be where the path said.
  // Refusing is the honest answer, and `LIMITS` is the number the store applies, read rather than repeated.
  return title.length > LIMITS.titleMaxLength ? null : title
}

function lastSegment(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? path : path.slice(cut + 1)
}

/** The path a renamed note takes, inside the folder it is already in. */
function joinParent(fromPath: string, name: string): string {
  const parent = parentOf(fromPath)
  const next = virtualNoteName(name)
  return parent ? `${parent}/${next}` : next
}

/** Every folder's first path wins: two rows at one path is the ambiguity `note-index.ts` reports. */
function folderPathIndex(folders: Folder[]): Map<string, string> {
  const paths = folderPathsOf(folders)
  const byPath = new Map<string, string>()
  for (const folder of folders) {
    const path = paths.get(folder.id)
    if (path !== undefined && !byPath.has(path)) byPath.set(path, folder.id)
  }
  return byPath
}

/**
 * The data layer's outcome, turned into the answer a template sees.
 *
 * `action` names the operation in the one case that has no code of its own — the app refused, for a reason
 * the store reported to the reader rather than to this host — so the detail says which write stopped
 * instead of leaving a path on its own.
 */
function applied(result: PageHostWrite, action: 'write' | 'create' | 'update' | 'delete', path: string): Outcome {
  if (result.ok) return succeed(noteIndexEntry(result.note, path))
  if (result.reason === 'not-found') return fail('note-not-found', path)
  if (result.reason === 'conflict') return fail('note-conflict', path)
  return fail('render-failed', `${action}:${path}`)
}

function succeed(value: unknown): Success {
  return { ok: true, value }
}

function fail(code: TemplaterErrorCode, detail: string): Refusal {
  return { ok: false, code, detail }
}
