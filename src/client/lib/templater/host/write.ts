/**
 * What a rendered template has to do to a note, worked out as data.
 *
 * Nothing here writes. A run's output, the note's current text and the cursor markers are handed in, and
 * a plan comes out: the whole new document, where the body text goes, what the properties become, where
 * the carets land. The page then applies that in one editor transaction or one store write, because a
 * module that owns the plan but not the screen can be tested without either — and because the half of
 * this that could destroy a reader's note has to be decided before any of it is attempted.
 *
 * The plan is always one document, never a set of steps. That is what makes undo one action: the editor
 * receives the whole result (or the two replacements that add up to it) and the store receives one
 * `content` string against one revision, so there is no state in which the properties were merged and
 * the body was not.
 *
 * Which mode does what is upstream's, from `src/core/Templater.ts` (AGPL-3.0-only, 2.26.0): inserting
 * into the active note splices the body at the selection and merges the properties
 * (`append_template_to_active_file`); overwriting a file replaces it whole and does *not* merge
 * (`overwrite_file_commands` → `vault.modify(file, output_content)`); a startup run's output is thrown
 * away; and a dynamic command's output replaces the command text in the rendered view, which has no
 * note-level counterpart to plan.
 */
import type { MessageKey } from '@shared/locales/en-US'
import type { CursorGroup, RunMode, RunNoteRef } from '../protocol'
import type { TemplaterErrorCode } from '../errors'
import { MAX_OUTPUT_CHARS } from '../limits'
import { normalizeVirtualPath } from '../context/note-index'
import { mergeFrontMatter, splitRendered, type FrontMatterChange, type RenderedSplit } from './frontmatter-merge'

/** An offset range counted in the note's current text, both halves 0-based, `end` excluded. */
export interface WriteRange {
  start: number
  end: number
}

/** How the page has to produce the new note. */
export type WritePlanKind = 'create' | 'replace' | 'insert' | 'discard'

/** The properties half of a write: a range of the note, and the text that replaces it. */
export interface FrontMatterEdit {
  /** The note's own `---` block, fence lines included. `{ start: 0, end: 0 }` when the note has none. */
  range: WriteRange
  /** The block to put there, fence lines included, with the newline that ends it. */
  text: string
  /** One entry per key the template carried, for a page that reports what changed. */
  changes: FrontMatterChange[]
}

/**
 * Something the reader has to be told about a plan that still went ahead.
 */
export type WriteNotice =
  | { kind: 'template-frontmatter-invalid'; errors: string[] }
  | { kind: 'note-frontmatter-invalid' }
  | { kind: 'insertion-clamped'; requested: number; used: number }
  | { kind: 'output-discarded' }

/**
 * The sentence each notice is told with.
 *
 * A plan is built before anything is on screen, so none of these names a control or a place in the
 * interface — it says what happened to the note, which is the only thing a plan can know. `errors` from
 * a template block stays out of here on purpose: the parser's own text is a log line, not copy.
 */
export const WRITE_NOTICE_MESSAGES: Record<WriteNotice['kind'], MessageKey> = {
  'template-frontmatter-invalid': 'templater.notice.template_frontmatter_invalid',
  'note-frontmatter-invalid': 'templater.notice.note_frontmatter_invalid',
  'insertion-clamped': 'templater.notice.insertion_clamped',
  'output-discarded': 'templater.notice.output_discarded',
}

export interface WritePlan {
  mode: RunMode
  kind: WritePlanKind
  /** The note's whole content after the write; `''` for a discarded output. */
  content: string
  /**
   * Where the run's text lands in the note as it stands, and what lands there.
   *
   * The whole new document for `create` and `replace`, whose ranges already cover the note; just the
   * body for `insert`, whose properties are a separate range.
   */
  body: { range: WriteRange; text: string }
  /** The properties, when the write touches them. */
  frontmatter: FrontMatterEdit | null
  /** Caret offsets into `content`, in the order a reader jumping through them meets them. */
  carets: number[]
  /** The revision this write must land against, or `null` when the caller is not tracking one. */
  expectedRev: number | null
  notes: WriteNotice[]
}

/** Everything the page knows about the run and the note it is writing. */
export interface WriteRequest {
  mode: RunMode
  /** The rendered text exactly as the run reported it, cursor markers included. */
  rendered: string
  /** The note's content right now; `''` for a note that does not exist yet. */
  currentContent: string
  /** The markers found in `rendered`, as `groupCursorMarkers` reports them. */
  cursorGroups: CursorGroup[]
  /** The note the output belongs to; `null` when the run has none, which is only legal for `create-new`. */
  target?: RunNoteRef | null
  /** Where a created note would live, in the app's virtual `Folder/Note.md` form. */
  path?: string
  /** Where the body goes, counted in `currentContent`. The end of the note when the caller has no selection. */
  selection?: WriteRange
  /** The revision the run rendered against, when the caller tracks one. */
  startedAtRev?: number | null
  /** The revision `currentContent` was read at. A difference from `startedAtRev` is a concurrent write. */
  currentRev?: number | null
}

export type WritePlanResult =
  | { ok: true; plan: WritePlan }
  | { ok: false; code: TemplaterErrorCode; detail: string }

/**
 * Build the plan for one rendered template.
 *
 * A refusal is a result, never an exception and never a partial plan: the caller either gets something
 * to apply or gets one code from `../errors.ts` to translate. Nothing is applied here at all, so a
 * refusal cannot leave a half-written note behind — the only thing built before a late refusal is a
 * string that is thrown away with the refusal.
 */
export function planWrite(request: WriteRequest): WritePlanResult {
  const { mode, rendered } = request

  // The mode the run was started in decides the shape, so an unsupported one is said first: a dynamic
  // command's output belongs to the command's span in the preview, which is not something a note-level
  // plan can name.
  if (mode === 'dynamic-processor') return fail('not-supported', 'dynamic-processor')

  // Checked before anything is split or merged, and never resolved by cutting the text down: a template
  // that renders more than the product can store produced something the reader cannot be given.
  if (rendered.length > MAX_OUTPUT_CHARS) return fail('template-output-too-large', `chars:${rendered.length}`)

  const split = splitRendered(rendered)
  const notes: WriteNotice[] = []
  // Upstream's fallback, kept: a block that does not parse is body text, so the reader still sees what
  // the template asked for and nothing is discarded. Saying so is the difference between a surprise and
  // a silent omission.
  if (split.invalid) notes.push({ kind: 'template-frontmatter-invalid', errors: split.errors })

  const conflict = revisionConflict(request)
  if (conflict) return conflict

  // A path is checked whenever one was given, in every mode: a note is filed by path, and a name that
  // escapes the tree is a bug in the template rather than a place to put a note.
  if (request.path !== undefined) {
    const path = validateNotePath(request.path)
    if (!path.ok) return fail('path-invalid', path.reason)
  }

  if (mode === 'startup') {
    // Startup output is thrown away by design; the run still happened, and a reader who later turns on
    // a startup template has to be able to see that nothing was written and why.
    notes.push({ kind: 'output-discarded' })
    return succeed(request, 'discard', '', null, { start: 0, end: 0 }, '', [], notes)
  }
  if (mode === 'create-new') return planCreate(request, split, notes)
  if (mode === 'append-active') return planInsert(request, split, notes)
  return planReplace(request, split, notes)
}

/** The modes that replace a whole note. */
function planReplace(request: WriteRequest, split: RenderedSplit, notes: WriteNotice[]): WritePlanResult {
  const { currentContent } = request
  // A missing target is a failure, never an invitation to create: `overwrite-active` and `overwrite-file`
  // both promise to replace a note the reader picked.
  if (!request.target) return fail('note-not-found', request.path ?? request.mode)
  const stripped = takeFirstCursorGroup(split.body, request.cursorGroups, split.bodyStart)
  const content = split.block ? `${split.block}\n${stripped.text}` : stripped.text
  if (pastCeiling(0, content.length)) return fail('template-output-too-large', `chars:${content.length}`)
  // Replacing is what the mode means, so the note's own properties go with its body: no merge, matching
  // upstream. The reader's confirmation step is where that is made visible, not here.
  return succeed(request, 'replace', content, null, { start: 0, end: currentContent.length }, content,
    withBase(stripped.carets, 0), notes)
}

/** The create-from-template path: a note that has no text yet gets the whole output. */
function planCreate(request: WriteRequest, split: RenderedSplit, notes: WriteNotice[]): WritePlanResult {
  if (!request.path) return fail('path-invalid', 'empty')
  if (request.currentContent !== '') return fail('note-conflict', 'not-empty')
  if (request.target && !request.target.isEmpty) return fail('note-conflict', request.target.id)
  const stripped = takeFirstCursorGroup(split.body, request.cursorGroups, split.bodyStart)
  // Written as the template spelled it, fences included: there is nothing to merge into, so re-emitting
  // the parsed values would only lose the author's own quoting.
  const content = split.block ? `${split.block}\n${stripped.text}` : stripped.text
  if (pastCeiling(0, content.length)) return fail('template-output-too-large', `chars:${content.length}`)
  return succeed(request, 'create', content, null, { start: 0, end: 0 }, content, withBase(stripped.carets, 0), notes)
}

/** Inserting into the note the reader is looking at: body at the selection, properties merged. */
function planInsert(request: WriteRequest, split: RenderedSplit, notes: WriteNotice[]): WritePlanResult {
  const { currentContent } = request
  if (!request.target) return fail('note-not-found', request.path ?? request.mode)
  const noteSplit = splitRendered(currentContent)
  const anchor = clampRange(request.selection, noteSplit.bodyStart, currentContent.length, notes)
  const frontmatter = frontMatterFor(split, noteSplit, notes)
  const stripped = takeFirstCursorGroup(split.body, request.cursorGroups, split.bodyStart)
  const { content, insertStart } = assemble(currentContent, frontmatter, anchor, stripped.text)
  if (pastCeiling(currentContent.length, content.length)) return fail('template-output-too-large', `chars:${content.length}`)
  return succeed(request, 'insert', content, frontmatter, anchor, stripped.text,
    withBase(stripped.carets, insertStart), notes)
}

/**
 * The properties half of an insert.
 *
 * Returning `null` is the note-unchanged answer, and it is the common one: no template block, an empty
 * template block, an already-idempotent merge, or a note block this module refuses to touch.
 */
function frontMatterFor(
  split: RenderedSplit,
  noteSplit: RenderedSplit,
  notes: WriteNotice[],
): FrontMatterEdit | null {
  if (split.invalid || Object.keys(split.frontmatter).length === 0) return null
  if (noteSplit.invalid) {
    // The reader's own block cannot be read, so it is not rewritten: the template's properties are
    // dropped rather than merged over text that might be a comment, a duplicate key or half an edit.
    // Upstream's file-level path (`merge_template_output`) would put a fresh block above it, which is a
    // rewrite of the note's head — refused here for the same reason the parse failure is not repaired.
    notes.push({ kind: 'note-frontmatter-invalid' })
    return null
  }
  if (!noteSplit.block) {
    const changes = Object.keys(split.frontmatter).map((key): FrontMatterChange => ({ key, action: 'added' }))
    return { range: { start: 0, end: 0 }, text: `${split.block}\n`, changes }
  }
  const merged = mergeFrontMatter(noteSplit.raw, split.frontmatter)
  if (merged.status === 'note-invalid') {
    notes.push({ kind: 'note-frontmatter-invalid' })
    return null
  }
  if (!merged.changed) return null
  return { range: { start: 0, end: noteSplit.bodyStart }, text: reblock(noteSplit.block, merged.yaml), changes: merged.changes }
}

/**
 * The note's fence lines around a merged block.
 *
 * The fences are taken from the note rather than written as `---`, because `@shared/markdown-utils` also
 * closes a block with `...`, and a merge is no reason to change which one the reader used.
 */
function reblock(block: string, yaml: string): string {
  const lines = block.split('\n')
  const open = lines[0] ?? '---'
  const close = lines[lines.length - 1] ?? '---'
  return `${open}\n${yaml}\n${close}\n`
}

/**
 * The whole document, from the two replacements.
 *
 * `insertStart` is what the caret offsets need: they are measured in the body text, and this is the one
 * place that knows how far into the result that text lands. The pair of ranges and this function are the
 * plan's consistency property, pinned by a test: applying `frontmatter` and then `body` to
 * `currentContent` yields exactly `content`, so the page may do one whole-document write or one
 * transaction of two replacements and cannot get two different notes out of it.
 */
function assemble(
  current: string,
  frontmatter: FrontMatterEdit | null,
  body: WriteRange,
  bodyText: string,
): { content: string; insertStart: number } {
  const prefix = frontmatter
    ? current.slice(0, frontmatter.range.start) + frontmatter.text + current.slice(frontmatter.range.end, body.start)
    : current.slice(0, body.start)
  return { content: prefix + bodyText + current.slice(body.end), insertStart: prefix.length }
}

/** Keep the selection inside the note and out of its properties; report any move, since the caret is the reader's. */
function clampRange(
  selection: WriteRange | undefined,
  minimum: number,
  length: number,
  notes: WriteNotice[],
): WriteRange {
  const requested = selection?.start ?? length
  const start = Math.min(Math.max(requested, minimum), length)
  const requestedEnd = selection?.end ?? requested
  const end = Math.min(Math.max(requestedEnd, start), length)
  if (start !== requested || end !== requestedEnd) notes.push({ kind: 'insertion-clamped', requested, used: start })
  return { start, end }
}

/**
 * The first jump group taken out of the body, with the carets it leaves behind.
 *
 * The rules are upstream's `CursorJumper` and are stated in `engine/cursor-markers.ts`, which owns
 * finding markers in text; this half works from groups the caller already has, so the two cannot
 * disagree about what a marker is. Offsets arrive measured in the rendered text and are moved into the
 * body by `bodyStart`, which is why a marker inside the front matter block is not jumped: the block is
 * written as a unit, and a property that says `<% tp.file.cursor(1) %>` is the author's text, not a
 * caret request. `null` sorts with `0` but stays its own group, and the bare form takes only its first
 * marker — both are upstream's, and a test here checks this against the engine's own jump so drift is
 * caught rather than discovered in a note.
 */
function takeFirstCursorGroup(
  body: string,
  groups: CursorGroup[],
  bodyStart: number,
): { text: string; carets: number[] } {
  const ordered = groups
    .flatMap((group) => group.markers.map((marker) => ({ order: group.order, start: marker.start - bodyStart, length: marker.end - marker.start })))
    .filter((marker) => marker.start >= 0 && marker.start + marker.length <= body.length)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.start - right.start)
  if (ordered.length === 0) return { text: body, carets: [] }
  const first = ordered[0]!
  const taken = first.order === null ? [first] : ordered.filter((marker) => marker.order === first.order)
  // Removed from the end backwards, so the offsets of everything before each one stay valid while the
  // string shrinks.
  let text = body
  for (let index = taken.length - 1; index >= 0; index -= 1) {
    const marker = taken[index]!
    text = `${text.slice(0, marker.start)}${text.slice(marker.start + marker.length)}`
  }
  const removedAbove = (offset: number): number =>
    taken.filter((marker) => marker.start < offset).reduce((total, marker) => total + marker.length, 0)
  return { text, carets: taken.map((marker) => marker.start - removedAbove(marker.start)) }
}

function withBase(offsets: number[], base: number): number[] {
  return offsets.map((offset) => base + offset)
}

/**
 * One place to assemble a plan, so `content` and the two ranges cannot be built differently.
 *
 * `expectedRev` echoes the revision `currentContent` was read at: the page passes it to the store write,
 * which is the half that can actually lose a race, and the plan is honest about not being the authority.
 */
function succeed(
  request: WriteRequest,
  kind: WritePlanKind,
  content: string,
  frontmatter: FrontMatterEdit | null,
  body: WriteRange,
  bodyText: string,
  carets: number[],
  notes: WriteNotice[],
): WritePlanResult {
  const plan: WritePlan = {
    mode: request.mode,
    kind,
    content,
    body: { range: body, text: bodyText },
    frontmatter,
    carets,
    expectedRev: typeof request.currentRev === 'number' ? request.currentRev : null,
    notes,
  }
  return { ok: true, plan }
}

/**
 * Whether the note moved while the template was running.
 *
 * The caller supplies both revisions; when it supplies only one there is nothing to compare, and the
 * store's own `rev` check is still the one that refuses the write — which is why the plan echoes
 * `expectedRev` instead of deciding the reader's note is safe.
 */
function revisionConflict(request: WriteRequest): WritePlanResult | null {
  const { startedAtRev, currentRev } = request
  if (typeof startedAtRev !== 'number' || typeof currentRev !== 'number') return null
  if (startedAtRev === currentRev) return null
  return fail('note-conflict', `rev:${startedAtRev}->${currentRev}`)
}

/**
 * Whether this write is the thing that takes the note past what the product promises to read back.
 *
 * `MAX_OUTPUT_CHARS` is the ceiling on the run's own text, checked before anything is assembled. The
 * finished document is checked too, because that is what gets stored — but only against a note that was
 * inside the ceiling first. A reader whose note is already longer than it is a note they wrote, and a
 * template that adds one line must not be refused on their account; the store keeps accepting it, and
 * the search index keeps truncating it, exactly as it does for every other edit.
 */
function pastCeiling(before: number, after: number): boolean {
  return before <= MAX_OUTPUT_CHARS && after > MAX_OUTPUT_CHARS
}

function fail(code: TemplaterErrorCode, detail: string): WritePlanResult {
  return { ok: false, code, detail }
}

/**
 * Why a path is not a place a note may live, or the path the caller has to use.
 *
 * The normalisation is `normalizeVirtualPath`, the one the note index already resolves paths with:
 * control characters removed, outer and repeated separators folded, backslashes read as slashes, case
 * left alone. Validation runs on its *result*, and the caller is handed the result rather than its own
 * input, which is what makes the check hard to bypass:
 * - `..` cannot hide behind a separator. `Notes/../../etc` and `..\..\etc` both fold to `../../etc`,
 *   and a segment equal to `..` is refused whatever came before it. There is no decode step to jump
 *   through, because these are database paths, not URLs — `%2e%2e` stays a literal segment name.
 * - A Windows drive cannot arrive wearing a Unix path. `C:\Notes` folds to `C:/Notes`, whose first
 *   segment matches a drive, and a `\\server\share` UNC path is caught before folding, since folding
 *   would strip the two leading slashes that mark it.
 * - A leading slash is not a refusal, because the note tree has no root to escape: `/Notes/a.md`
 *   normalises to `Notes/a.md`, the same way Obsidian's `normalizePath` and this app's index both read
 *   it. Refusing it would only make templates spell paths two ways.
 * - Segments are refused for the characters Windows reserves, and for a trailing dot or space, which
 *   Windows strips — the stripped form would be a second name for the same note, and two notes with one
 *   path is exactly the corruption this guard exists to stop.
 */
export type NotePathIssue = 'empty' | 'escape' | 'drive' | 'absolute' | 'reserved' | 'trailing'

export type NotePathResult = { ok: true; path: string } | { ok: false; reason: NotePathIssue }

/** `<>:"|?*` are the characters a Windows file name cannot hold; `:` also marks a drive. */
const RESERVED_IN_SEGMENT = /[<>:"|?*]/
const DRIVE_IN_SEGMENT = /^[A-Za-z]:$/
const WINDOWS_TRIMMED_END = /[. ]$/

export function validateNotePath(path: string): NotePathResult {
  // Checked on the raw text: folding an UNC path turns `\\server\share` into `server/share`, which reads
  // as an ordinary folder pair and would be filed somewhere the reader never pointed at.
  if (/^\\\\[^\\]/.test(path.trim())) return { ok: false, reason: 'absolute' }
  const normalized = normalizeVirtualPath(path)
  if (!normalized) return { ok: false, reason: 'empty' }
  const segments = normalized.split('/')
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return { ok: false, reason: 'escape' }
    if (DRIVE_IN_SEGMENT.test(segment)) return { ok: false, reason: 'drive' }
    if (RESERVED_IN_SEGMENT.test(segment)) return { ok: false, reason: 'reserved' }
    if (WINDOWS_TRIMMED_END.test(segment)) return { ok: false, reason: 'trailing' }
  }
  return { ok: true, path: normalized }
}
