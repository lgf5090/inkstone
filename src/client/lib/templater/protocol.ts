/**
 * The frozen wire contract between the page and the template worker.
 *
 * A Templater template is JavaScript, executed by an interpreter that has no bindings of its own, so
 * every capability it touches — the note it is writing into, the folder it is asking for, the modal it
 * is waiting on — arrives as a message. This file is the shape of those messages and nothing else: it
 * imports no store, no DOM, no editor, and must stay that way, because both sides of the boundary
 * compile it. The page side lives in `./host` and the worker side in `./worker`; neither may reach into
 * the other, which is why the numbers both sides enforce are in `./limits.ts` beside this file rather
 * than inside one half.
 *
 * Two choices are worth their reason. Runs are addressed by an id rather than one-worker-per-run
 * because a template waits on the reader (`tp.system.prompt`) while another template can be starting
 * beside it, and `dataview/js-api.ts`'s single-in-flight message cannot express that. And capabilities
 * are a per-run set the host re-checks on every call rather than a flag the template can read, because
 * the whole point is to decide what untrusted code may do *after* it has been written.
 */
import type { NoteTemplate } from '@shared/types'

/** Which of Templater's six situations a run is in; decides target, active file and output handling. */
export type RunMode =
  | 'create-new'
  | 'append-active'
  | 'overwrite-file'
  | 'overwrite-active'
  | 'dynamic-processor'
  | 'startup'

/**
 * What one run is allowed to do.
 *
 * The narrow profile is what a community template gets when opened straight from the gallery: it can
 * read the note it is being applied to and produce text, and nothing else. Widening is always an
 * explicit act — importing into the reader's own library, or the reader's own template.
 */
export interface Capabilities {
  /** Replace the active note's body, or another note's. */
  writeActiveNote: boolean
  /** Create notes, including nested `tp.file.create_new` runs. */
  createNotes: boolean
  /** Move or rename notes. */
  moveNotes: boolean
  /** Read notes other than the target and the template. */
  readOtherNotes: boolean
  /** Show a modal and wait for the reader. */
  prompt: boolean
  /** Reach the network through the same-origin proxy. */
  web: boolean
  /** Load and run the reader's user scripts. */
  userScripts: boolean
  /** Read the system clipboard. */
  clipboard: boolean
}

/** The shipped profiles, named so the policy is one list rather than eight booleans at each call site. */
export type CapabilityProfile = 'local' | 'community' | 'preview' | 'dynamic' | 'startup'

/**
 * Everything a run needs that is not the template text.
 *
 * Serialisable by construction: notes arrive as data, never as live objects, because a host object
 * handed to the interpreter would be a hole in it.
 */
export interface TemplateRunContext {
  /** Which run this is, carried into the interpreter so a host call can be answered to the right run. */
  runId: string
  mode: RunMode
  capabilities: CapabilityProfile
  /** The library template being applied, when the run started from one. */
  template: { id: string; name: string; content: string } | null
  /** Epoch milliseconds, taken once on the page so every template in a run sees the same "now". */
  startedAt: number
  /** The note the output belongs to. Absent when creating, where the target is the new note. */
  target: RunNoteRef | null
  /** The note open in the editor, which `tp.config.active_file` reports even in create mode. */
  active: RunNoteRef | null
  /** The title the note had when the run began; Templater freezes it across a mid-run rename. */
  frozenTitle: string
  /** Notes and folders `tp.file.find_tfile` / `include` can resolve, kept small on purpose. */
  index: NoteIndexEntry[]
  /** Folders, by id and path, for `tp.file.folder` and create-new destinations. */
  folders: FolderIndexEntry[]
  /** Library templates addressed by name, which is how a vault folder maps onto a database row. */
  libraryTemplates: NoteTemplate[]
  /** The reader's language, so date names and error text match the interface they are reading. */
  locale: string
  /**
   * The first selection range of the note in front of the reader, taken when the run started.
   *
   * `tp.file.selection()` reads this rather than asking the page: upstream's own signature is a *synchronous*
   * string (`InternalModuleFile.ts:299`), and a template writes `<% tp.file.selection() %>` without an
   * `await` — a host call would print `[object Promise]` into the reader's note. The page captures the
   * selection into the snapshot, which also matches upstream's behaviour of reporting the selection the run
   * began with, not whatever the reader has dragged over since. Empty when nothing is selected.
   */
  selection: string
}

/** A note as the interpreter sees it: identifiers and text, never a store handle. */
export interface RunNoteRef {
  id: string
  title: string
  content: string
  folderId: string | null
  tagNames: string[]
  frontmatter: Record<string, unknown>
  createdAt: number
  updatedAt: number
  /** Whether the note has content yet; the create-from-template path renders against an empty one. */
  isEmpty: boolean
}

/** The minimum `tp.file.find_tfile` needs to answer, per note. */
export interface NoteIndexEntry {
  id: string
  title: string
  folderId: string | null
  /** The virtual `Folder/Note.md` path the Obsidian-shaped APIs expect. */
  path: string
  updatedAt: number
  createdAt: number
}

export interface FolderIndexEntry {
  id: string
  name: string
  parentId: string | null
  path: string
}

/** A host call the interpreter is blocked on. `method` names a function in `HOST_METHODS`. */
export interface HostCall {
  runId: string
  callId: string
  method: string
  args: unknown[]
}

/** The answer to one call. Failures carry a code, never a message, so the page can translate. */
export type HostResult =
  | { runId: string; callId: string; ok: true; value: unknown }
  | { runId: string; callId: string; ok: false; code: string; detail?: string }

/** What the page asks the worker to run. */
export interface RunRequest {
  kind: 'run'
  runId: string
  context: TemplateRunContext
  /** The compiled program, from `engine/program.ts`; the worker never parses. */
  source: string
  /** Milliseconds of CPU allowed before the run is interrupted. */
  deadlineMs: number
}

/** What the page answers a pending `tp.system.prompt` with. */
export interface HostReplyRequest {
  kind: 'host-reply'
  result: HostResult
}

/** Ask the worker to fire the callbacks `tp.hooks.on_all_templates_executed` registered. */
export interface HooksRequest {
  kind: 'run-hooks'
  runId: string
}

/** Stop a run and drop its runtime. */
export interface CancelRequest {
  kind: 'cancel'
  runId: string
}

export type WorkerRequest = RunRequest | HostReplyRequest | HooksRequest | CancelRequest

/** The worker's side: progress is a host call, completion carries the rendered text. */
export interface DoneMessage {
  kind: 'done'
  runId: string
  output: string
  durationMs: number
}

export interface HostCallMessage {
  kind: 'host-call'
  call: HostCall
}

export interface FailedMessage {
  kind: 'failed'
  runId: string
  code: string
  detail?: string
}

/** A run that registered hooks, reported at completion so the page knows to send `run-hooks`. */
export interface HooksArmedMessage {
  kind: 'hooks-armed'
  runId: string
  count: number
}

export type WorkerMessage = DoneMessage | HostCallMessage | FailedMessage | HooksArmedMessage

/**
 * The host methods a template may call, as one list.
 *
 * This is the whole attack surface. `../host/page-host.ts` implements each name here and refuses any
 * name not on it, and every implementation re-checks the run's `Capabilities` before doing work — the
 * template's own view of what it is allowed to do is never the authority on that.
 */
export const HOST_METHODS = [
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
  'system.clipboard',
  'system.prompt',
  'system.suggester',
  'system.multiSuggester',
  'web.request',
  'web.dailyQuote',
  'web.randomPicture',
  'user.script',
  'app.commands',
  'hooks.register',
  'cursor.append',
] as const

export type HostMethod = (typeof HOST_METHODS)[number]

/** Which capability gates which method, so the gate and the list cannot drift apart silently. */
export const HOST_METHOD_CAPABILITY: Record<HostMethod, keyof Capabilities> = {
  'note.read': 'readOtherNotes',
  'note.write': 'writeActiveNote',
  'note.create': 'createNotes',
  // Opening a note is what `create_new(…, true)` does after it made one, and nothing in the ported surface
  // opens a note the run did not just create — so it travels with `createNotes` rather than needing a ninth
  // capability for a name no template can reach on its own.
  'note.open': 'createNotes',
  'note.move': 'moveNotes',
  'note.rename': 'moveNotes',
  'note.delete': 'writeActiveNote',
  'note.exists': 'readOtherNotes',
  // Rendering another note's text is reading it and then running what was read, so it cannot be wider than
  // the read: a preview or a gallery template that could render-include would copy a private vault out one
  // included note at a time while `readOtherNotes` says it may not read one.
  'note.renderInclude': 'readOtherNotes',
  'folder.list': 'readOtherNotes',
  'folder.create': 'createNotes',
  'template.read': 'readOtherNotes',
  'system.clipboard': 'clipboard',
  'system.prompt': 'prompt',
  'system.suggester': 'prompt',
  'system.multiSuggester': 'prompt',
  'web.request': 'web',
  'web.dailyQuote': 'web',
  'web.randomPicture': 'web',
  'user.script': 'userScripts',
  'app.commands': 'writeActiveNote',
  'hooks.register': 'writeActiveNote',
  'cursor.append': 'writeActiveNote',
}

/**
 * The eight rights, resolved from the five names a run can be started under.
 *
 * This sits beside {@link HOST_METHOD_CAPABILITY} rather than in either side's own file because the two
 * tables are one policy: a row here and a row there drift, and they had (a startup row that grants
 * writing notes on one side and refuses creating them on the other). One file, one table, and both sides
 * read the same object.
 *
 * The rows are the port plan's D15 matrix, which is the reviewed policy: a community template pulled from
 * the gallery may ask the reader questions and read the note it is being applied to, and nothing else;
 * only the reader's own templates get the write, network and user-script paths.
 *
 * Four cells look surprising and are deliberate, so they are stated here rather than left to the table:
 *
 * - A community template may open a prompt. Upstream's interactive templates are built on
 *   `tp.system.suggester`, and refusing it would silently drop half of what people share. A modal is also
 *   the one part of a run the reader *sees*: it cannot take a note or a file out, it can only ask. What it
 *   may not do is reach the clipboard, another note, the network or the disk.
 * - Preview and dynamic-command runs read only the note in front of them. Reading other notes is what
 *   would turn a gallery template into a way to copy a private vault out one note at a time, and a preview
 *   is no licence for that.
 * - `startup` writes and creates, because the classic unattended template is the one that files today's
 *   daily note when the app opens, and the reader scheduled it themselves. It may not ask a question,
 *   reach the network or read the clipboard, because nobody is in the room to answer for those.
 * - `web` is on for `local` as the *ceiling* only: the reader's `webRequestsEnabled` setting is applied by
 *   the page host on the call, which is the side that can see settings.
 */
export const CAPABILITY_PROFILES: Record<CapabilityProfile, Capabilities> = {
  local: {
    writeActiveNote: true,
    createNotes: true,
    moveNotes: true,
    readOtherNotes: true,
    prompt: true,
    web: true,
    userScripts: true,
    clipboard: true,
  },
  community: {
    writeActiveNote: false,
    createNotes: false,
    moveNotes: false,
    readOtherNotes: false,
    prompt: true,
    web: false,
    userScripts: false,
    clipboard: false,
  },
  preview: {
    writeActiveNote: false,
    createNotes: false,
    moveNotes: false,
    readOtherNotes: false,
    prompt: true,
    web: false,
    userScripts: false,
    clipboard: false,
  },
  dynamic: {
    writeActiveNote: false,
    createNotes: false,
    moveNotes: false,
    readOtherNotes: false,
    prompt: true,
    web: false,
    userScripts: false,
    clipboard: false,
  },
  startup: {
    writeActiveNote: true,
    createNotes: true,
    moveNotes: true,
    readOtherNotes: true,
    prompt: false,
    web: false,
    userScripts: true,
    clipboard: false,
  },
}

/**
 * A copy, so a host that mutates what it got cannot change the policy for the next run.
 *
 * The worker resolves the run's profile *name* through this on the way in — the alternative would be
 * trusting the page that compiled an untrusted template to have decided its rights first.
 */
export function capabilitiesFor(profile: CapabilityProfile): Capabilities {
  return { ...CAPABILITY_PROFILES[profile] }
}

/**
 * What `note.renderInclude` asks the page to do: render one thing into text.
 *
 * `tp.file.include` and `<% tp.file.create_new(template, …) %>` are not reads. Upstream parses what it
 * read, so the commands *inside* an included note run — `InternalModuleFile.ts:212-222` re-parses with the
 * *parent's* own function object, which is why an included note sees the parent's `tp.file.title` and not
 * its own — while `Templater.ts:204-214` gives a `create_new` child run a config of its own, with the note
 * being made as the target and `RunMode.CreateNewFromTemplate`. Both are one call shape here, because both
 * are "compile this and run it"; what differs is only `asCreate`.
 *
 * The worker cannot do either job itself: it holds no parser, and one interpreter holds one run. So the page
 * compiles and runs a nested template and answers its finished text — which is also the only place a
 * `#Heading` or `#^block` subpath can be sliced, since slicing needs parse positions the snapshot
 * deliberately does not carry. `depth` travels because the counter that limits nesting has to live where the
 * nested runs are started; without it `MAX_TEMPLATE_DEPTH` has no owner.
 */
export interface RenderIncludeRequest {
  /** What to render: another note (optionally one heading or block of it), or raw template text. */
  source: { kind: 'note'; path: string; subpath?: { kind: 'heading' | 'block'; text: string } | null } | { kind: 'text'; text: string }
  /** How deep this render sits under the run the reader started, counting from 1. */
  depth: number
  /**
   * Set when the render is filling a note that is being created: the child run reads `tp.file.*` as that
   * note and `tp.config.run_mode` as create-new. Absent for `include`, which keeps the parent's context.
   */
  asCreate?: { path: string; title: string; templatePath?: string } | null
}

/** What the page answers a {@link RenderIncludeRequest} with: the rendered text, markers included. */
export interface RenderIncludeResult {
  content: string
}

/**
 * What a template asks the reader for, on the wire.
 *
 * Deliberately its own type rather than QuickAdd's `PromptRequest`: the worker protocol should not
 * change because a different feature renamed a field. `host/page-host.ts` maps this onto the shared
 * prompt queue, which already draws the accessible dialog and the mobile sheet.
 */
export interface TemplaterPromptRequest {
  kind: 'text' | 'suggest' | 'multi-suggest'
  /** Text shown for each option; when absent, `values` is shown as-is. */
  labels?: string[]
  values: string[]
  title: string
  defaultValue?: string
  placeholder?: string
  multiLine?: boolean
  selectDefaultValue?: boolean
  /** Cap the number of visible choices, as upstream's `limit` does. */
  limit?: number
  /** Pre-ticked values for `multi-suggest`. */
  defaultPicks?: string[]
  /** Whether cancelling throws instead of resolving to a null answer. */
  throwOnCancel?: boolean
}

/** A row of the in-app function reference, built from the ported `documentation.toml`. */
export interface ReferenceEntry {
  module: string
  name: string
  /** The signature exactly as the reference panel and the completion item should show it. */
  signature: string
  descriptionKey: string
  args: { name: string; descriptionKey: string }[]
  returnsKey?: string
  /** Code, not prose: examples are never run through the translation layer. */
  examples: string[]
  /** Which capabilities the reader has to be able to use for this to be more than documentation. */
  requires?: (keyof Capabilities)[]
}

/**
 * The shape the parser hands the compiler, and the compiler hands the interpreter.
 *
 * Splitting it here is what lets the parser, the VM host and the note-context builder be written by
 * three people at once: `engine/parser.ts` needs no interpreter, `worker/vm.ts` needs no grammar, and
 * neither has to agree with the other about anything but these four names.
 *
 * `source` is the whole template compiled into one async function body rather than a list of
 * independent commands, because Templater's scope rule — a `function` declared in one execution
 * command is visible to the next — cannot be honoured by evaluating commands separately.
 */
export interface ProgramSource {
  /** The compiled body, ready for `evalCode`; the worker never parses. */
  source: string
  /** The template text the body was built from, kept so a reported line maps back to what the reader wrote. */
  template: string
  /** What line of `template` each command came from, so an error can name one instead of "somewhere". */
  lineMap: ProgramLine[]
  /** How many commands were compiled, which is what the per-run command cap is checked against. */
  commandCount: number
}

export interface ProgramLine {
  command: number
  /** 1-based, matching how every editor and error list in this app counts lines. */
  line: number
  column: number
}

/** A cursor placeholder the parser found, before the note is written. */
export interface CursorMarker {
  /**
   * The order the template asked for, or `null` when the command took no argument.
   *
   * `null` is not `0`. Upstream keeps the bare form in a group of its own — `CursorJumper.ts` says so in
   * a comment: "An omitted order is its own group, so that tp.file.cursor() never groups with
   * tp.file.cursor(0)" — so a plain `number` cannot represent the marker set faithfully, and a caller
   * that folded the two together would jump a reader past markers they wrote on purpose.
   */
  order: number | null
  /** Where the marker text sits in the rendered output. */
  start: number
  end: number
}

/** Every marker sharing an order, which is what one jump moves to. `order: null` is its own group. */
export interface CursorGroup {
  order: number | null
  markers: CursorMarker[]
}

/** What the parser produces for one template. */
export interface ParserOutput {
  /** Text and commands in source order; whitespace control has already been applied. */
  segments: ParserSegment[]
  /**
   * Where the first command began in the original text, or `0` when the template has none.
   *
   * Each segment carries its own position; this pair is the template-level anchor a caller shows when it
   * wants to point at "the first thing the reader wrote that looks like a command" without walking segments.
   */
  origin: number
  /** The 1-based line of that same first command, or `1` for a command-free template. */
  line: number
}

export type ParserSegment =
  | { kind: 'text'; text: string }
  | { kind: 'interpolate'; expression: string; origin: number; line: number }
  | { kind: 'execute'; body: string; origin: number; line: number }

/** A parse failure, carrying the position the reader has to navigate to. */
export interface ParseFailure {
  code: 'parse-unclosed' | 'parse-invalid'
  /** 1-based. */
  line: number
  column: number
  detail?: string
}