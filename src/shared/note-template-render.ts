/**
 * Renders a new-note template into note content.
 *
 * Placeholders are filled in a single left-to-right pass, so a value that
 * itself looks like a placeholder (`{{tags}}` inside a note title) is written
 * out literally instead of being expanded a second time.
 */
import { appendFrontMatterTag, parseFrontMatter } from './markdown-utils'
import { parseDocument } from 'yaml'
import { ASSISTANT_TOOL_SPECS } from './assistant'

/** Placeholders the renderer knows. Anything else is copied through untouched. */
export const NEW_NOTE_PLACEHOLDERS = [
  'title',
  'createdAt',
  'date',
  'time',
  'today',
  'tomorrow',
  'yesterday',
  'folder',
  'tags',
  'cursor',
] as const

export type NewNotePlaceholder = (typeof NEW_NOTE_PLACEHOLDERS)[number]

/** Contextual values a caller supplies per note; both render verbatim, see `renderNewNoteTemplate`. */
export interface NewNoteContext {
  title: string
  now?: Date
  folder?: string
  tags?: string
}

export interface InterpolatedNewNoteTemplate {
  content: string
  /** Offset for the editor caret, or null when the template had no `{{cursor}}`. */
  cursor: number | null
}

/**
 * A place the assistant writes, and what it was asked to write there.
 *
 * `{{ai: …}}` is the one placeholder that cannot be filled from the clock: it is a request, and the
 * request is answered after the note exists. So the marker is taken out of the body and handed to the
 * caller as an offset, which is where the answer goes once it arrives.
 */
export interface NewNoteAiSlot {
  /** Offset in the rendered content where the answer belongs. */
  at: number
  instruction: string
}

export interface RenderedNewNoteTemplate extends InterpolatedNewNoteTemplate {
  aiSlots: NewNoteAiSlot[]
  /** What the template declared it may ask the assistant to do; disabled unless declared. */
  ai: NoteTemplateAiCapabilities
  /** How many `{{ai: …}}` markers were left untouched because no enabled declaration allowed them. */
  aiBlocked: number
  /** Why a declared protocol was refused, in English; the caller says the reader-facing sentence. */
  protocolErrors: string[]
}

/**
 * The capability declaration a template carries.
 *
 * A template is data until the reader (or a gallery) runs it, and `{{ai: …}}` is the one placeholder
 * that spends a model turn and can reach the assistant's tools. So a template has to say out loud that
 * it wants that, and which tools it may use; absent means disabled, which is the safe default for a
 * file that arrived from outside the reader's library.
 */
export interface NoteTemplateAiCapabilities {
  enabled: boolean
  /** Assistant tool names from `ASSISTANT_TOOL_SPECS`; an empty list means text without tools. */
  tools: string[]
}

export const DEFAULT_TEMPLATE_AI: NoteTemplateAiCapabilities = { enabled: false, tools: [] }

/** The protocol block a template puts before its body, stripped before the note is written. */
const PROTOCOL_BLOCK_RE = /^\uFEFF?[ \t]*<!--[ \t]*inkstone-template[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*-->[ \t]*(?:\r?\n)?/

const ASSISTANT_TOOL_NAMES = new Set(ASSISTANT_TOOL_SPECS.map((spec) => spec.name))

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read the optional protocol block off the front of a template.
 *
 * The block has to be the first thing in the file so it cannot be confused with markdown the reader
 * meant to keep. Everything about it is strict: the capability list is a security boundary, and a file
 * that names a tool the assistant does not have is refused rather than quietly run with fewer rights.
 */
export function parseTemplateProtocol(template: string): {
  content: string
  ai: NoteTemplateAiCapabilities
  errors: string[]
} {
  const match = PROTOCOL_BLOCK_RE.exec(template)
  if (!match) return { content: template, ai: { ...DEFAULT_TEMPLATE_AI }, errors: [] }
  const content = template.slice(match[0].length)
  const document = parseDocument(match[1]!, { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length > 0) {
    return { content, ai: { ...DEFAULT_TEMPLATE_AI }, errors: document.errors.map((error) => error.message) }
  }
  const value = document.toJS({ maxAliasCount: 20 }) as unknown
  if (!isRecord(value)) {
    return { content, ai: { ...DEFAULT_TEMPLATE_AI }, errors: ['The template protocol must be a mapping.'] }
  }
  const unknownRoot = Object.keys(value).filter((key) => key !== 'ai')
  if (unknownRoot.length > 0) {
    return { content, ai: { ...DEFAULT_TEMPLATE_AI }, errors: [`Unknown template protocol key: ${unknownRoot.join(', ')}`] }
  }
  if (value.ai === undefined) return { content, ai: { ...DEFAULT_TEMPLATE_AI }, errors: [] }
  if (!isRecord(value.ai)) {
    return { content, ai: { ...DEFAULT_TEMPLATE_AI }, errors: ['The ai capability must be a mapping.'] }
  }
  const unknownAi = Object.keys(value.ai).filter((key) => key !== 'enabled' && key !== 'tools')
  if (unknownAi.length > 0) {
    return { content, ai: { ...DEFAULT_TEMPLATE_AI }, errors: [`Unknown ai capability key: ${unknownAi.join(', ')}`] }
  }
  if (value.ai.enabled !== undefined && typeof value.ai.enabled !== 'boolean') {
    return { content, ai: { ...DEFAULT_TEMPLATE_AI }, errors: ['ai.enabled must be true or false.'] }
  }
  const rawTools = value.ai.tools
  if (rawTools !== undefined && !Array.isArray(rawTools)) {
    return { content, ai: { ...DEFAULT_TEMPLATE_AI }, errors: ['ai.tools must be a list of assistant tool names.'] }
  }
  const tools: string[] = []
  for (const entry of (rawTools ?? []) as unknown[]) {
    if (typeof entry !== 'string' || !ASSISTANT_TOOL_NAMES.has(entry)) {
      return { content, ai: { ...DEFAULT_TEMPLATE_AI }, errors: [`ai.tools names an unknown assistant tool: ${String(entry)}`] }
    }
    if (!tools.includes(entry)) tools.push(entry)
  }
  return { content, ai: { enabled: value.ai.enabled === true, tools }, errors: [] }
}

/** `{{ai: …}}` is one line long: an instruction that wraps would be a prompt with a blank line in it. */
const AI_SLOT_RE = /\{\{ai:[ \t]*([^\n}]*?)[ \t]*\}\}/g

/** How many non-empty `{{ai: …}}` markers a body still holds, which is what a blocked run left visible. */
function countAiSlots(text: string): number {
  const slotRe = new RegExp(AI_SLOT_RE.source, 'g')
  let count = 0
  let match: RegExpExecArray | null
  while ((match = slotRe.exec(text))) {
    if (match[1]!.trim()) count += 1
  }
  return count
}

/**
 * Take the AI slots out of the body and remember where each one was.
 *
 * A slot alone on its line takes the line with it, because a paragraph the reader cannot see would
 * otherwise be left as a blank line in the finished note. The removal is what makes the offsets the
 * answer needs true of the content that is actually saved, so the caret is pulled back with them.
 */
function stripAiSlots(text: string, cursor: number | null): { content: string; cursor: number | null; aiSlots: NewNoteAiSlot[] } {
  const spans: Array<{ start: number; end: number; instruction: string }> = []
  const slotRe = new RegExp(AI_SLOT_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = slotRe.exec(text))) {
    const instruction = match[1]!.trim()
    // An empty instruction is a template mistake, and one that stays visible beats one that silently
    // eats the marker and leaves nothing behind.
    if (!instruction) continue
    const lineStart = text.lastIndexOf('\n', match.index - 1) + 1
    const lineEnd = text.indexOf('\n', match.index)
    const lineStop = lineEnd === -1 ? text.length : lineEnd
    const alone = text.slice(lineStart, match.index).trim() === '' && text.slice(match.index + match[0].length, lineStop).trim() === ''
    // A slot alone on its line takes the line with it, and one of the blank lines that separated it
    // from its neighbours — otherwise the note is left with the empty paragraph the marker stood for.
    const afterLine = lineStop + 1 < text.length && text[lineStop + 1] === '\n' ? lineStop + 2 : Math.min(lineStop + 1, text.length)
    spans.push({
      start: alone ? lineStart : match.index,
      end: alone ? afterLine : match.index + match[0].length,
      instruction,
    })
  }
  if (spans.length === 0) return { content: text, cursor, aiSlots: [] }
  let content = ''
  let at = 0
  const aiSlots: NewNoteAiSlot[] = []
  for (const span of spans) {
    content += text.slice(at, span.start)
    aiSlots.push({ at: content.length, instruction: span.instruction })
    at = span.end
  }
  content += text.slice(at)
  if (cursor !== null) {
    // The caret sits after every slot in practice, so it moves back by everything that was removed
    // ahead of it — and onto the slot's own offset when it happened to be inside one.
    let removed = 0
    for (const span of spans) {
      if (cursor >= span.end) removed += span.end - span.start
      else if (cursor > span.start) removed += cursor - span.start
    }
    cursor -= removed
  }
  return { content, cursor, aiSlots }
}

const PLACEHOLDER_RE = /\{\{([A-Za-z0-9_]+)\}\}/g

/**
 * Half-open span of the front matter *values*, i.e. the lines between the two
 * `---` fences. Placeholders inside it are quoted for YAML; the same
 * placeholder in the body is written as plain text, because a heading such as
 * `# {{title}}` must not gain JSON quotes.
 */
function frontMatterValueSpan(template: string): [number, number] | null {
  const opening = /^---[ \t]*\r?\n/.exec(template)
  if (!opening) return null
  const start = opening[0].length
  const lines = template.slice(start).split(/\r?\n/)
  let offset = start
  for (const line of lines) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) return [start, offset]
    offset += line.length + 1
  }
  return null
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function isoDate(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

/**
 * Quote a scalar only when YAML would read it as something else.
 *
 * The test is what a *block* parser sees, not which characters appear: `a, b` and
 * `a]b` come back unchanged, while a leading indicator, a `: ` sequence or a
 * spelling that resolves to a number, date or boolean does not.
 */
export function yamlSafeScalar(value: string): string {
  const ambiguous = value === '' ||
    value !== value.trim() ||
    /[\n\r]/.test(value) ||
    /^[-?:,[\]{}#&*!|>'"%@`~]/.test(value) ||
    /:\s|\s#/.test(value) ||
    /:$/.test(value) ||
    /^(?:---|\.\.\.)/.test(value) ||
    /^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value) ||
    /^(?:true|false|null|~|yes|no|on|off|none|nan|inf)$/i.test(value)
  return ambiguous ? JSON.stringify(value) : value
}

/** A value that lands inside front matter must not carry a line break. */
function singleLine(value: string): string {
  return value.replace(/\r?\n/g, ' ')
}

/**
 * Quote what a *flow* parser (`[a, b]`) would not read back as the same string.
 *
 * Narrower than `yamlSafeScalar` on purpose: `5%` and `a-b` are ordinary flow
 * items, while `x]y` and `a: b` would silently end the list or turn the item
 * into a mapping.
 */
export function yamlFlowItem(value: string): string {
  const ambiguous = value === '' ||
    value !== value.trim() ||
    /[[\]{}#,]/.test(value) ||
    /:\s|\s:/.test(value) ||
    /^[-?:#&*!|>'"%@`~]/.test(value) ||
    /^(?:true|false|null|~|yes|no|on|off|none|nan|inf)$/i.test(value) ||
    /^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)
  return ambiguous ? JSON.stringify(value) : value
}

/** Where a placeholder sits inside a front matter line, which decides how its value must be written. */
type ValuePosition = 'block' | 'flow' | 'mixed'

const KEY_PREFIX_RE = /^[ \t]*[^:#][^:]*:[ \t]+$/

/**
 * `key: {{x}}` is a whole scalar and gets quoted; `key: [{{x}}, y]` is a list
 * item and must stay unquoted unless YAML itself would misread it; anything else
 * (`key: /{{x}}/`) is left alone and handled by the repair pass, because the
 * quoting that would fix it has to wrap the whole value, not the placeholder.
 */
function valuePosition(line: string, at: number, length: number): ValuePosition {
  const before = line.slice(0, at)
  const after = line.slice(at + length)
  if (after.trim() === '' && KEY_PREFIX_RE.test(before)) return 'block'
  let depth = 0
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const char = before[index]
    if (char === ']' || char === '}') depth += 1
    else if (char === '[' || char === '{') {
      if (depth === 0) return after.includes(']') || after.includes('}') ? 'flow' : 'mixed'
      depth -= 1
    } else if (char === ',' && depth === 0) return after.includes(']') || after.includes('}') ? 'flow' : 'mixed'
  }
  return 'mixed'
}

/** Turn a contextual value into the text YAML will read back unchanged. */
function frontMatterValue(raw: string, position: ValuePosition): string {
  if (position === 'flow') {
    const pieces = raw.split(/[,\uFF0C]+/)
    const items = pieces.length > 1
      ? pieces.map((piece) => piece.trim()).filter((piece) => piece !== '')
      : pieces.filter((piece) => piece !== '')
    return items.map((item) => yamlFlowItem(item)).join(', ')
  }
  if (position === 'block') return yamlSafeScalar(raw)
  return raw
}

const FRONT_MATTER_LINE_RE = /^([ \t]*[^:#][^:]*?:[ \t]+)(.*)$/

/**
 * Quote the value of one front matter line, in place, as far as `at` reaches it.
 *
 * This is the repair for a placeholder that shared its line with other text: the
 * line is a whole scalar now, so the block rule applies to all of it. Returns the
 * new text and how much the line grew, which is what the caret has to be shifted by.
 */
function quoteLine(out: string, at: number): { text: string; start: number; end: number } | null {
  const start = out.lastIndexOf('\n', Math.max(0, at - 1)) + 1
  const next = out.indexOf('\n', start)
  const end = next === -1 ? out.length : next
  const line = out.slice(start, end)
  const carriage = line.endsWith('\r') ? '\r' : ''
  const parsed = FRONT_MATTER_LINE_RE.exec(carriage ? line.slice(0, -1) : line)
  if (!parsed) return null
  const quoted = yamlSafeScalar(parsed[2]!)
  if (quoted === parsed[2]) return null
  return { text: `${parsed[1]}${quoted}${carriage}`, start, end }
}

/**
 * Fill the template's placeholders for one note.
 *
 * Values inside front matter are written so YAML reads them back unchanged: a
 * whole-value placeholder is quoted when it would otherwise be misread, and a
 * flow list item is quoted only when the flow parser itself would misread it, so
 * `tags: [{{tags}}]` still expands into several tags. `folder` and `tags` arrive
 * comma separated from the caller, which is why both are flattened to one line.
 */
export function interpolateNewNoteTemplate(
  rawTemplate: string,
  context: NewNoteContext,
): InterpolatedNewNoteTemplate {
  // The capability protocol is a preamble for the runner, not text for the note; removing it here also
  // keeps every caret offset honest, because interpolation counts characters of what it was handed.
  const template = parseTemplateProtocol(rawTemplate).content
  const now = context.now ?? new Date()
  const date = isoDate(now)
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  const tomorrow = new Date(now.getTime())
  tomorrow.setDate(tomorrow.getDate() + 1)
  const yesterday = new Date(now.getTime())
  yesterday.setDate(yesterday.getDate() - 1)
  const values: Record<string, string> = {
    title: context.title,
    createdAt: `${date} ${time}`,
    date,
    time,
    today: date,
    tomorrow: isoDate(tomorrow),
    yesterday: isoDate(yesterday),
    folder: singleLine(context.folder ?? ''),
    tags: singleLine(context.tags ?? ''),
  }
  const span = frontMatterValueSpan(template)
  let out = ''
  let at = 0
  let cursor: number | null = null
  const mixed: number[] = []
  let touchedFrontMatter = false
  const placeholderRe = new RegExp(PLACEHOLDER_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = placeholderRe.exec(template))) {
    const name = match[1]!
    if (!(name in values) && name !== 'cursor') continue
    out += template.slice(at, match.index)
    at = match.index + match[0].length
    if (name === 'cursor') {
      if (cursor === null) cursor = out.length
      continue
    }
    const raw = values[name]!
    const insideFrontMatter = span !== null && match.index >= span[0] && match.index < span[1]
    if (!insideFrontMatter) {
      out += raw
      continue
    }
    touchedFrontMatter = true
    const lineStart = template.lastIndexOf('\n', Math.max(0, match.index - 1)) + 1
    const lineEnd = template.indexOf('\n', lineStart)
    const line = template.slice(lineStart, lineEnd === -1 ? template.length : lineEnd)
    const position = valuePosition(line, match.index - lineStart, match[0].length)
    if (position === 'mixed') mixed.push(out.length)
    out += frontMatterValue(raw, position)
  }
  let content = `${out}${template.slice(at)}`
  if (touchedFrontMatter && mixed.length > 0 && parseFrontMatter(content).errors.length > 0) {
    for (const marker of [...new Set(mixed)].sort((a, b) => b - a)) {
      const repaired = quoteLine(content, marker)
      if (!repaired) continue
      content = `${content.slice(0, repaired.start)}${repaired.text}${content.slice(repaired.end)}`
      if (cursor !== null && repaired.start < cursor) cursor += repaired.text.length - (repaired.end - repaired.start)
    }
  }
  return { content, cursor }
}

/**
 * Render a new-note template into final content and merge the tags a note was
 * created under into its front matter.
 *
 * Interpolation runs before the merge on purpose: the YAML round trip the merge
 * performs would parse a raw `{{tags}}` as a flow mapping and leave it behind in
 * the note. The caret offset is then shifted by however many characters the
 * merge added ahead of it.
 */
export function renderNewNoteTemplate(
  template: string,
  context: NewNoteContext,
  mergeTags: readonly string[] = [],
): RenderedNewNoteTemplate {
  const parsed = parseTemplateProtocol(template)
  const rendered = interpolateNewNoteTemplate(parsed.content, context)
  let content = rendered.content
  let cursor = rendered.cursor
  for (const tag of mergeTags) {
    const merged = appendFrontMatterTag(content, tag)
    if (merged === content) continue
    if (cursor !== null) cursor += merged.length - content.length
    content = merged
  }
  // The slots are taken out last, on the final body: a merge that grew the front matter would
  // otherwise leave every offset the answers are inserted at pointing at the wrong character.
  if (parsed.errors.length > 0 || !parsed.ai.enabled) {
    // No declaration, or one the parser refused: leave the marker visible rather than write a hole the
    // reader cannot account for, and let the caller say why the assistant did not answer it.
    const aiBlocked = countAiSlots(content)
    return { content, cursor, aiSlots: [], ai: parsed.ai, aiBlocked, protocolErrors: parsed.errors }
  }
  return {
    ...stripAiSlots(content, cursor),
    ai: parsed.ai,
    aiBlocked: 0,
    protocolErrors: parsed.errors,
  }
}
