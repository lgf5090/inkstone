import type { EditorState } from '@codemirror/state'
import { enclosingFence } from '../../../lib/markdown/fence-edit'
import { parseFenceInfo } from '../../../lib/markdown/fence-info'
import { colonFenceMark, deindent, findColonClose } from '../../../lib/markdown/colon-fence'
import { parseMarkdownTable } from '../../../lib/markdown/table-editor'
import { fenceContextKind, type EditorContext } from './types'

/**
 * What the cursor is on, read out of the note's own text.
 *
 * The order is the rule: a fenced block swallows everything inside it, so a `# heading` or a
 * `[link](url)` written into a code sample answers as code and not as a heading or a link. Selection
 * comes first, because a person who highlighted something asked about that selection whatever it
 * happens to sit on.
 */
export function detectEditorContext(state: EditorState, pos: number): EditorContext {
  const doc = state.doc
  const at = Math.max(0, Math.min(pos, doc.length))
  const line = doc.lineAt(at)
  const number = line.number
  const text = line.text
  const offset = at - line.from
  const lines = doc.toJSON()

  return selection(state, at, number)
    ?? fenced(state, at, number, lines)
    ?? mathBlock(lines, number, line.from, line.to, at)
    ?? frontMatter(doc, at, number)
    ?? table(lines, number, offset, at)
    ?? heading(text, line.from, line.to, at, number)
    ?? inline(text, offset, line.from, at, number)
    ?? container(lines, number, at)
    ?? { kind: 'empty', pos: at, line: number }
}

/** The rule that opens or closes a display formula, on a line of its own. */
const MATH_FENCE = /^ {0,3}\$\$[ \t]*$/

/**
 * A display formula, which is its own block rather than a fence: the renderer reads `$$` on a line of
 * its own, so a menu that did not would report the formula as the plain line it happens to sit on.
 * An unclosed block runs to the end of the note, the same way the renderer carries it.
 */
function mathBlock(lines: string[], lineNumber: number, lineFrom: number, lineTo: number, pos: number): EditorContext | null {
  const target = lineNumber - 1
  for (let start = 0; start < lines.length; start++) {
    if (!MATH_FENCE.test(lines[start] ?? '')) continue
    let end = -1
    for (let n = start + 1; n < lines.length; n++) {
      if (MATH_FENCE.test(lines[n] ?? '')) { end = n; break }
    }
    const last = end === -1 ? lines.length - 1 : end
    if (target >= start && target <= last) {
      let from = lineFrom
      for (let n = target - 1; n >= start; n--) from -= (lines[n] ?? '').length + 1
      let to = lineTo
      for (let n = target + 1; n <= last; n++) to += (lines[n] ?? '').length + 1
      return {
        kind: 'math',
        pos,
        line: lineNumber,
        math: { formula: lines.slice(start + 1, last).join('\n'), block: true, from, to },
      }
    }
    if (end === -1) break
    start = end
  }
  return null
}

function selection(state: EditorState, pos: number, line: number): EditorContext | null {
  const range = state.selection.main
  if (range.empty || pos < range.from || pos > range.to) return null
  const selectedText = state.sliceDoc(range.from, range.to)
  if (!selectedText) return null
  return { kind: 'selection', pos, line, selectedText }
}

/** Empty, so every fence counts: the block's own language decides which menu it answers to. */
const ANY_FENCE: readonly string[] = []

function fenced(state: EditorState, pos: number, lineNumber: number, lines: string[]): EditorContext | null {
  const at = enclosingFence(lines.join('\n'), lineNumber - 1, ANY_FENCE)
  if (!at) return null
  const doc = state.doc
  const info = parseFenceInfo(at.info)
  return {
    kind: fenceContextKind(info.language),
    pos,
    line: lineNumber,
    fence: {
      language: info.language,
      info: at.info,
      body: at.body,
      title: info.title,
      from: doc.line(at.line + 1).from,
      to: at.closing === -1 ? doc.length : doc.line(at.closing + 1).to,
      closed: at.closing !== -1,
      line: at.line,
    },
  }
}

/** The document's own front matter: a `---` run that opens on the very first line and closes later. */
function frontMatter(doc: EditorState['doc'], pos: number, line: number): EditorContext | null {
  if (!/^---[ \t]*$/.test(doc.line(1).text)) return null
  for (let n = 2; n <= doc.lines; n++) {
    if (/^(---|\.\.\.|===)[ \t]*$/.test(doc.line(n).text)) {
      if (line >= 1 && line <= n) return { kind: 'frontmatter', pos, line }
      return null
    }
  }
  return null
}

function table(lines: string[], lineNumber: number, offset: number, pos: number): EditorContext | null {
  if (!(lines[lineNumber - 1] ?? '').includes('|')) return null
  const parsed = parseMarkdownTable(lines, lineNumber - 1, offset)
  if (!parsed) return null
  return { kind: 'table', pos, line: lineNumber, table: parsed }
}

function heading(text: string, from: number, to: number, pos: number, line: number): EditorContext | null {
  const match = /^ {0,3}(#{1,6})\s+(.*)$/.exec(text)
  if (!match) return null
  return {
    kind: 'heading',
    pos,
    line,
    heading: {
      level: match[1]!.length,
      text: (match[2] ?? '').replace(/\s+#+\s*$/, '').trim(),
      from,
      to,
    },
  }
}

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/y
const EMBED_RE = /!\[\[([^[\]\n]+)\]\]/y
const WIKI_RE = /\[\[([^[\]\n]+)\]\]/y
const LINK_RE = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/y
/**
 * Inline math may not open or close on whitespace, which is what keeps `$5 and $x^2$` from pairing the
 * first dollar with the second and reporting `5 and ` as a formula.
 */
const INLINE_MATH_RE = /(?<!\$)\$(?![\s$])([^$\n]+?)(?<![\s$])\$(?!\$)/y
const TASK_RE = /^(?:[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\][ \t]+)(.*)$/

/**
 * The inline span of `text` whose character range covers `offset`. Sticky regexes stepped across the
 * line, so a match is asked for at each start position rather than collected first — that is what lets
 * `![alt](url)` win the same characters `![` and `[` would otherwise fight over.
 *
 * Hashtags are deliberately absent: the source editor already marks them with `data-tag`, and the
 * menu that owns a tag is read off that mark rather than matched a second time here.
 */
function inline(text: string, offset: number, lineFrom: number, pos: number, line: number): EditorContext | null {
  const built = (over: Partial<EditorContext>): EditorContext => ({ ...over, pos, line }) as EditorContext

  for (let start = 0; start <= offset && start < text.length; start++) {
    const hit = (regex: RegExp, make: (match: RegExpExecArray, from: number, to: number) => EditorContext): EditorContext | null => {
      regex.lastIndex = start
      const match = regex.exec(text)
      if (!match) return null
      if (offset > start + match[0].length) return null
      return make(match, lineFrom + start, lineFrom + start + match[0].length)
    }

    const found = hit(IMAGE_RE, (m, from, to) => built({
      kind: 'image',
      image: { alt: m[1] ?? '', url: m[2] ?? '', raw: m[0], from, to },
    }))
      ?? hit(EMBED_RE, (m, from, to) => built({
        kind: 'embed',
        embed: { target: (m[1] ?? '').split('|')[0]!.trim(), from, to },
      }))
      ?? hit(WIKI_RE, (m, from, to) => {
        const [target = '', alias = ''] = (m[1] ?? '').split('|')
        return built({ kind: 'wikilink', wikiLink: { target: target.trim(), alias: alias.trim(), from, to } })
      })
      ?? hit(LINK_RE, (m, from, to) => built({
        kind: 'link',
        link: { text: m[1] ?? '', url: m[2] ?? '', from, to },
      }))
      ?? hit(INLINE_MATH_RE, (m, from, to) => built({
        kind: 'math',
        math: { formula: m[1] ?? '', block: false, from, to },
      }))
    if (found) return found
  }
  return task(text, lineFrom, pos, line)
}

function task(text: string, lineFrom: number, pos: number, line: number): EditorContext | null {
  const match = TASK_RE.exec(text)
  if (!match) return null
  return {
    kind: 'task',
    pos,
    line,
    task: {
      checked: (match[1] ?? '').toLowerCase() === 'x',
      text: match[2] ?? '',
      from: lineFrom,
      to: lineFrom + text.length,
    },
  }
}

/** The line spans a fenced block covers, so a `:::` written as a sample is never a container. */
function fencedRanges(lines: string[]): [number, number][] {
  const out: [number, number][] = []
  let open = -1
  let char = ''
  let length = 0
  for (let i = 0; i < lines.length; i++) {
    const run = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i] ?? '')
    if (!run) continue
    const marker = run[1]!
    if (open === -1) {
      open = i
      char = marker[0]!
      length = marker.length
      continue
    }
    if (marker[0] === char && marker.length >= length && !(run[2] ?? '').trim()) {
      out.push([open, i])
      open = -1
    }
  }
  if (open !== -1) out.push([open, lines.length - 1])
  return out
}

interface ContainerSpan {
  start: number
  end: number
  directive: string
}

/**
 * The innermost `:::` container holding the line. The closing line is found by the block rules' own
 * `findColonClose`, so a container can never be delimited one way for the menu and another way for
 * the renderer that draws it.
 */
function container(lines: string[], lineNumber: number, pos: number): EditorContext | null {
  const target = lineNumber - 1
  if (!lines.some((line) => /^ {0,3}:{3,}/.test(line))) return null
  const fences = fencedRanges(lines)
  let best: ContainerSpan | null = null
  for (let start = 0; start <= target; start++) {
    if (fences.some(([from, to]) => start >= from && start <= to)) continue
    const text = deindent(lines[start] ?? '')
    const mark = colonFenceMark(text)
    if (!mark || !mark.opens) continue
    const found = findColonClose(lines, start + 1, lines.length, mark.length)
    const end = found === -1 ? lines.length - 1 : found
    if (target < start || target > end) continue
    if (best && start >= best.start && end >= best.end) continue
    best = { start, end, directive: text.slice(mark.length).trim() }
  }
  if (!best) return null
  return {
    kind: 'container',
    pos,
    line: lineNumber,
    container: { directive: best.directive, from: best.start, to: best.end },
  }
}
