/**
 * The frozen wire contract between the page and the template worker.
 *
 * A Templater template is JavaScript, executed by an interpreter that has no bindings of its own, so
 * every capability it touches — the note it is writing into, the folder it is asking for, the modal it
 * is waiting on — arrives as a message. This file is the shape of those messages and nothing else: it
 * imports no store, no DOM, no editor, and must stay that way, because both sides of the boundary
 * compile it. The page side lives in `../host` and the worker side in `../worker`; neither may reach
 * into the other.
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
  'note.move',
  'note.rename',
  'note.delete',
  'note.exists',
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
  'note.move': 'moveNotes',
  'note.rename': 'moveNotes',
  'note.delete': 'writeActiveNote',
  'note.exists': 'readOtherNotes',
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