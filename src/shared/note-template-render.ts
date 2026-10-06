/**
 * Renders a new-note template into note content.
 *
 * Placeholders are filled in a single left-to-right pass, so a value that
 * itself looks like a placeholder (`{{tags}}` inside a note title) is written
 * out literally instead of being expanded a second time.
 */
import { appendFrontMatterTag } from './markdown-utils'

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

export interface RenderedNewNoteTemplate {
  content: string
  /** Offset for the editor caret, or null when the template had no `{{cursor}}`. */
  cursor: number | null
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
 * Quote a scalar only when YAML would read it as something else: a leading
 * indicator, a structural character, surrounding whitespace, a line break, or a
 * spelling YAML resolves to a number, date or boolean.
 */
export function yamlSafeScalar(value: string): string {
  const ambiguous = value === '' ||
    value !== value.trim() ||
    /[\n\r]/.test(value) ||
    /[:#\[\]{},&*!|>'"%@`]/.test(value) ||
    /^[-?:]/.test(value) ||
    /^(?:---|\.\.\.)/.test(value) ||
    /^-?\d+(?:\.\d+)?$/.test(value) ||
    /^(?:true|false|null|~|yes|no|on|off|none|nan|inf)$/i.test(value)
  return ambiguous ? JSON.stringify(value) : value
}

/** A value that lands inside front matter must not carry a line break. */
function singleLine(value: string): string {
  return value.replace(/\r?\n/g, ' ')
}

/**
 * Fill the template's placeholders for one note.
 *
 * `folder` and `tags` are inserted verbatim rather than quoted, because
 * `{{tags}}` conventionally expands into a flow list (`tags: [a, b]`) that
 * quoting would destroy. Both are flattened to a single line first.
 */
export function interpolateNewNoteTemplate(
  template: string,
  context: NewNoteContext,
): RenderedNewNoteTemplate {
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
  PLACEHOLDER_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PLACEHOLDER_RE.exec(template))) {
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
    out += name === 'title' && insideFrontMatter ? yamlSafeScalar(raw) : raw
  }
  return { content: `${out}${template.slice(at)}`, cursor }
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
  const rendered = interpolateNewNoteTemplate(template, context)
  let content = rendered.content
  let cursor = rendered.cursor
  for (const tag of mergeTags) {
    const merged = appendFrontMatterTag(content, tag)
    if (merged === content) continue
    if (cursor !== null) cursor += merged.length - content.length
    content = merged
  }
  return { content, cursor }
}
