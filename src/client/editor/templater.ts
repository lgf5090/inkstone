/**
 * Templater syntax highlighting for the note editor.
 *
 * A reader looking at a template needs to see where the note stops being prose and starts being code,
 * because that part is what the renderer throws away and replaces. This module only paints: the document
 * keeps every character, the caret and the selection keep their own behaviour, and nothing here adds an
 * attribute to an editor span — the marks carry classes for the theme and nothing else.
 *
 * The grammar is not re-implemented. `engine/parser.ts` is the one thing in this app that knows what a
 * command is, so its `CommandToken` offsets are what the marks are placed from, which also means the
 * editor and a run agree about where a tag ends: a `%>` inside a string in a command body is stepped
 * over by the same quote-aware scan the interpreter reads with.
 *
 * Cost is the part worth describing, because the editor runs this on every keystroke. The decorations
 * cover the visible range only, and an edit maps them through the change instead of rebuilding them: the
 * commands re-scanned are the ones the change touched, so typing prose beside a template costs one short
 * scan. Two cases cannot be answered from a touched window alone — a command that opens before it, and a
 * command that closes after it — and a scan that notices either reports itself as incomplete, at which
 * point the visible range is scanned whole. That is the same bound the editor's other mark scanners work
 * to, paid only when a command actually opens or closes.
 */
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { ChangeDesc, EditorState, Extension, Range, RangeSet } from '@codemirror/state'
import { parseTemplate, type CommandKind, type CommandToken } from '../lib/templater/engine/parser'
import type { ParseFailure } from '../lib/templater/protocol'

/** `<%` and `%>`: the fixed part of a tag, which is what lets its edges be derived from the engine's data. */
const TAG_DELIMITER_LENGTH = 2

/** How long the Markdown parse may take to answer whether a window lies inside a fenced block. */
const FENCE_PARSE_BUDGET_MS = 5

export interface TemplaterHighlightOptions {
  /**
   * Whether highlighting is on, read on every update.
   *
   * A getter rather than a boolean because the switch is a setting its caller owns and this module must
   * not reach for a store, and because reading it per update is what lets a flip land on the next
   * transaction instead of waiting for the editor to be rebuilt.
   */
  enabled: () => boolean
}

/**
 * Which half of a command a mark covers.
 *
 * The body is separable from its delimiters on purpose: one is the reader's code, the other is the
 * syntax that announces it, and a theme has to be able to say those apart.
 */
type SpanRole = 'delimiter' | 'body'

/** One painted piece of a command, in absolute document coordinates. */
interface TagSpan {
  from: number
  to: number
  kind: CommandKind
  role: SpanRole
}

/** What one text window contributed, and whether it could be trusted on its own. */
interface WindowScan {
  spans: TagSpan[]
  /** False when a command crosses the window's edge, so only a wider scan can answer for it. */
  complete: boolean
}

const marks = new Map<string, Decoration>()

/** The mark for one kind and half, reused: a Decoration is immutable and holds no state. */
function markFor(kind: CommandKind, role: SpanRole): Decoration {
  const key = `${kind} ${role}`
  const known = marks.get(key)
  if (known) return known
  const created = Decoration.mark({ class: `cm-templater-tag cm-templater-${kind} cm-templater-${role}` })
  marks.set(key, created)
  return created
}

function rangesFor(spans: readonly TagSpan[]): Range<Decoration>[] {
  return spans.map((span) => markFor(span.kind, span.role).range(span.from, span.to))
}

/**
 * The pieces of one command: its two delimiters and, when it has one, its body.
 *
 * The engine gives the whole tag (`origin` through `end`), the body text and which whitespace-control
 * character closed it, from which the edges follow: whatever the tag holds besides the closing
 * characters, the body and that one character is the opening delimiter. Whitespace markers are counted
 * as delimiter, so `<%*` and `-%>` read as syntax rather than as code.
 */
function spansFor(token: CommandToken, offset: number): TagSpan[] {
  const trailing = token.whitespaceAfter === 'none' ? 0 : 1
  const opened = token.end - token.origin - TAG_DELIMITER_LENGTH - trailing - token.body.length
  const from = token.origin + offset
  const to = token.end + offset
  const bodyFrom = from + opened
  const bodyTo = bodyFrom + token.body.length
  const spans: TagSpan[] = [{ from, to: bodyFrom, kind: token.kind, role: 'delimiter' }]
  if (bodyTo > bodyFrom) spans.push({ from: bodyFrom, to: bodyTo, kind: token.kind, role: 'body' })
  spans.push({ from: to - TAG_DELIMITER_LENGTH - trailing, to, kind: token.kind, role: 'delimiter' })
  return spans
}

/** The fenced regions of a window, under the same two names `decorations.ts` uses for them. */
function fencedRanges(state: EditorState, from: number, to: number): { from: number, to: number }[] {
  // The Markdown tree arrives asynchronously, so asking for it by name is the only way a freshly opened
  // note knows its own fences; `syntaxTree` alone would highlight a fence's contents until the next
  // edit, which is the order dependence `decorations.test.ts` has to work around by hand.
  ensureSyntaxTree(state, to, FENCE_PARSE_BUDGET_MS)
  const found: { from: number, to: number }[] = []
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') found.push({ from: node.from, to: node.to })
    },
  })
  return found
}

/**
 * Where a parse failure sits, as an offset into the scanned text.
 *
 * The engine reports line and column because that is what a reader navigating to it wants; the editor
 * needs the offset. Everything before it parsed, since the lexer walks left to right and stops at the
 * first command it cannot read, so the prefix is worth painting.
 */
function failureOffset(text: string, failure: ParseFailure): number {
  let offset = 0
  for (let line = 1; line < failure.line; line++) {
    const next = text.indexOf('\n', offset)
    if (next === -1) return text.length
    offset = next + 1
  }
  return Math.min(text.length, offset + failure.column - 1)
}

/**
 * Every command in one window, at document offsets, minus the ones a fenced block holds.
 *
 * An unclosed command is a state a reader types their way through rather than an error to report here:
 * the commands before it are painted, and the window says it cannot answer on its own.
 */
function scanWindow(state: EditorState, from: number, to: number): WindowScan {
  const text = state.doc.sliceString(from, to)
  const opened = text.indexOf('<%')
  const closed = text.indexOf('%>')
  // A closing tag with no opening one ahead of it belongs to a command that started before this window,
  // so nothing this window says about the rest of it can be trusted.
  let complete = closed === -1 || (opened !== -1 && opened < closed)
  if (opened === -1) return { spans: [], complete }
  let commands: readonly CommandToken[] = []
  const parse = parseTemplate(text)
  if (parse.ok) commands = parse.output.commands
  else {
    complete = false
    const cut = failureOffset(text, parse.failure)
    const prefix = cut > 0 ? parseTemplate(text.slice(0, cut)) : null
    commands = prefix?.ok ? prefix.output.commands : []
  }
  const fences = fencedRanges(state, from, to)
  const spans: TagSpan[] = []
  for (const token of commands) {
    const start = token.origin + from
    if (fences.some((fence) => start >= fence.from && start < fence.to)) continue
    spans.push(...spansFor(token, from))
  }
  return { spans, complete }
}

/** The visible text as one window: separate ranges of one viewport are scanned together. */
function visibleExtent(view: EditorView): { from: number, to: number } | null {
  const ranges = view.visibleRanges
  if (ranges.length === 0) return null
  return { from: ranges[0]!.from, to: ranges[ranges.length - 1]!.to }
}

/** The editor a reader can type in. Read-only surfaces get nothing: they show output, not source. */
function isEditable(state: EditorState): boolean {
  return !state.readOnly && state.facet(EditorView.editable)
}

/** Ranges in ascending order with the overlaps merged, so one window is scanned once. */
function mergeWindows(windows: readonly { from: number, to: number }[]): { from: number, to: number }[] {
  const sorted = [...windows].sort((left, right) => left.from - right.from || left.to - right.to)
  const merged: { from: number, to: number }[] = []
  for (const window of sorted) {
    const last = merged[merged.length - 1]
    if (last && window.from <= last.to) last.to = Math.max(last.to, window.to)
    else merged.push({ ...window })
  }
  return merged
}

/**
 * The windows an edit reached, widened over the marks it touched.
 *
 * A command is painted as contiguous marks, so growing a window to every mark touching it swallows the
 * whole command the edit sits inside of — which is the unit whose answer can change.
 */
function touchedWindows(decorations: RangeSet<Decoration>, changes: ChangeDesc, extent: { from: number, to: number }): { from: number, to: number }[] {
  const windows: { from: number, to: number }[] = []
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    let from = fromB
    let to = toB
    let grown = true
    while (grown) {
      grown = false
      decorations.between(from, to, (markFrom, markTo) => {
        if (markFrom < from) { from = markFrom; grown = true }
        if (markTo > to) { to = markTo; grown = true }
      })
    }
    const clipped = { from: Math.max(from, extent.from), to: Math.min(to, extent.to) }
    if (clipped.to > clipped.from) windows.push(clipped)
  })
  return mergeWindows(windows)
}

export class TemplaterHighlight {
  decorations: DecorationSet = Decoration.none
  /** The extent `decorations` describes, or null when nothing has been scanned since the last reset. */
  private scanned: { from: number, to: number } | null = null

  constructor(view: EditorView, private readonly options: TemplaterHighlightOptions) {
    if (this.options.enabled() && isEditable(view.state)) this.refresh(view)
  }

  update(update: ViewUpdate) {
    if (!this.options.enabled() || !isEditable(update.view.state)) {
      this.clear()
      return
    }
    if (update.viewportChanged || !this.scanned) this.refresh(update.view)
    else if (update.docChanged) this.patch(update)
  }

  private clear(): void {
    this.decorations = Decoration.none
    this.scanned = null
  }

  /** Paint the visible range from scratch: the first build, a scrolled viewport, or a switch turned on. */
  private refresh(view: EditorView): void {
    const extent = visibleExtent(view)
    if (!extent) { this.clear(); return }
    this.decorations = Decoration.set(rangesFor(scanWindow(view.state, extent.from, extent.to).spans), true)
    this.scanned = extent
  }

  /**
   * Keep what the edit did not touch, and re-scan only what it did.
   *
   * Mapping the marks through the change is what leaves the rest of the viewport alone. A window that
   * comes back incomplete is a command whose two halves the edit separated, and only then is the whole
   * visible range scanned again.
   */
  private patch(update: ViewUpdate): void {
    const extent = visibleExtent(update.view)
    if (!extent || !this.scanned) { this.refresh(update.view); return }
    const mapped = this.decorations.map(update.changes)
    const windows = touchedWindows(mapped, update.changes, extent)
    this.scanned = extent
    if (windows.length === 0) {
      this.decorations = mapped
      return
    }
    const spans: TagSpan[] = []
    for (const window of windows) {
      const scan = scanWindow(update.view.state, window.from, window.to)
      if (!scan.complete) { this.refresh(update.view); return }
      spans.push(...scan.spans)
    }
    // Whatever the re-scan did not return has to go with them: a tag the edit broke is painted no longer.
    const touched = (from: number, to: number) => windows.some((window) => from >= window.from && to <= window.to)
    this.decorations = mapped.update({
      filter: (from, to) => !touched(from, to),
      filterFrom: extent.from,
      filterTo: extent.to,
      add: rangesFor(spans),
      sort: true,
    })
  }
}

/**
 * The plugin id, exported because a caller that wants the marks themselves — a test, or later the
 * status line that says how many commands a note holds — reads them off the view with it.
 */
export const templaterHighlightPlugin = ViewPlugin.fromClass(TemplaterHighlight, {
  decorations: (value) => value.decorations,
})

/**
 * The extension, with the reader's switch threaded in.
 *
 * A function rather than a module constant because the switch belongs to the caller: the note editor
 * passes the setting it is configured with, the template editor will pass its own, and this module
 * stays free of the settings store.
 */
export function templaterHighlight(options: TemplaterHighlightOptions): Extension {
  return templaterHighlightPlugin.of(options)
}
